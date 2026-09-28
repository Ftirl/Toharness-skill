#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile, rename } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { parse } from "yaml";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

//#region src/existing-service.ts
function validateExistingUrl(input) {
	const url = new URL(input);
	if (url.protocol !== "http:" || ![
		"127.0.0.1",
		"localhost",
		"[::1]"
	].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Existing Harness URL must be a clean local loopback HTTP origin.");
	return url.origin;
}
/** Reuse the existing local login grant; never store or return its signing secret. */
async function existingCookie(url, env = process.env) {
	if (env.DSH_MCP_EXISTING_COOKIE) return env.DSH_MCP_EXISTING_COOKIE;
	const file = env.DSH_MCP_EXISTING_CREDENTIAL_FILE;
	if (!file) return void 0;
	const record = parse(await readFile(file, "utf8"))?.records?.["client-connection/browser-session"];
	if (record?.kind !== "grant" || record.payload?.version !== 1 || typeof record.payload?.secret !== "string") throw new Error("Existing browser-session credential format is unsupported.");
	const secret = Buffer.from(record.payload.secret, "base64url");
	if (secret.length !== 32) throw new Error("Existing browser-session credential is invalid.");
	const authority = new URL(url).host;
	const now = Date.now();
	const body = Buffer.from(JSON.stringify({
		version: 1,
		authority,
		issuedAt: now,
		expiresAt: now + 6e5
	})).toString("base64url");
	const signature = createHmac("sha256", secret).update(body).digest("base64url");
	return `dsh-auth-${createHash("sha256").update(authority).digest("base64url")}=v1.${body}.${signature}`;
}

//#endregion
//#region src/runtime.ts
const DEFAULT_HARNESS_PACKAGE = "@deepseek-ai/dsh@0.1.5-rc.1";
/** Resolves the persistent data directory used for local Web service state. */
function resolveDataDirectory(env = process.env) {
	return env.DSH_MCP_DATA_DIR?.trim() || env.PLUGIN_DATA?.trim() || join(homedir(), ".deep-seek-harness-mcp");
}
/** Resolves optional workspace roots that the MCP server may modify. */
function resolveAllowedRoots(env = process.env) {
	return (env.DSH_MCP_WORKSPACE_ROOTS ?? "").split(delimiter).map((value) => value.trim()).filter(Boolean);
}
/** Builds the argv and environment for the published Harness Web UI. */
function buildHarnessWebCommand(input, env = process.env) {
	const command = env.DSH_MCP_NPX_COMMAND?.trim() || (process.platform === "win32" ? "npx.cmd" : "npx");
	const harnessPackage = env.DSH_MCP_HARNESS_PACKAGE?.trim() || "@deepseek-ai/dsh@0.1.5-rc.1";
	if (harnessPackage.startsWith("-")) throw new Error("DSH_MCP_HARNESS_PACKAGE must be an npm package specifier, not an option.");
	return {
		command,
		args: [
			"--yes",
			`--package=${harnessPackage}`,
			"--",
			"dsh",
			"web",
			"--port",
			"0"
		],
		cwd: input.workspace,
		env: {
			...env,
			DSH_CWD: input.workspace,
			DSH_HOME: input.serviceHome,
			DSH_PERMISSION_MODE: env.DSH_PERMISSION_MODE?.trim() || "workspace-write",
			DSH_TELEMETRY_DISABLED: env.DSH_TELEMETRY_DISABLED?.trim() || "1",
			NO_COLOR: "1",
			npm_config_yes: "true"
		}
	};
}
/** Returns local prerequisites without making a network request. */
function inspectRuntime(env = process.env) {
	if (env.DSH_MCP_EXISTING_URL) return {
		ready: Number(process.versions.node.split(".")[0]) >= 22,
		connectionMode: "existing",
		existingUrl: validateExistingUrl(env.DSH_MCP_EXISTING_URL),
		authenticationConfigured: Boolean(env.DSH_MCP_EXISTING_COOKIE || env.DSH_MCP_EXISTING_CREDENTIAL_FILE),
		nodeVersion: process.versions.node,
		allowedWorkspaceRoots: resolveAllowedRoots(env),
		notes: "start_service performs the authenticated live probe; no npx or new Harness process is required."
	};
	const command = env.DSH_MCP_NPX_COMMAND?.trim() || (process.platform === "win32" ? "npx.cmd" : "npx");
	const probe = spawnSync(command, ["--version"], {
		encoding: "utf8",
		shell: false,
		timeout: 5e3
	});
	const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
	return {
		ready: nodeMajor >= 22 && probe.status === 0,
		nodeVersion: process.versions.node,
		nodeSupported: nodeMajor >= 22,
		platform: process.platform,
		architecture: process.arch,
		npxCommand: command,
		npxAvailable: probe.status === 0,
		npxVersion: probe.status === 0 ? probe.stdout.trim() : null,
		harnessPackage: env.DSH_MCP_HARNESS_PACKAGE?.trim() || "@deepseek-ai/dsh@0.1.5-rc.1",
		apiKeyInEnvironment: Boolean(env.DEEPSEEK_API_KEY?.trim()),
		dataDirectory: resolveDataDirectory(env),
		allowedWorkspaceRoots: resolveAllowedRoots(env),
		surface: "web"
	};
}

//#endregion
//#region src/run-manager.ts
const READY_PATTERN = /dsh web: (http:\/\/[^\s]+)/;
const STARTUP_TIMEOUT_MS = 12e4;
const CANCEL_GRACE_MS = 5e3;
function defaultSpawnProcess(command) {
	return spawn(command.command, command.args, {
		cwd: command.cwd,
		env: command.env,
		detached: process.platform !== "win32",
		shell: false,
		stdio: [
			"ignore",
			"pipe",
			"pipe"
		]
	});
}
async function defaultOpenBrowser(url) {
	const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
	const args = process.platform === "win32" ? [
		"/c",
		"start",
		"",
		url
	] : [url];
	await new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, {
			shell: false,
			stdio: "ignore",
			windowsHide: true
		});
		child.once("error", reject);
		child.once("close", (code) => code === 0 ? resolvePromise() : reject(/* @__PURE__ */ new Error(`${command} exited with code ${String(code)}`)));
	});
}
function isWithin(root, candidate) {
	const child = relative(root, candidate);
	return child === "" || !child.startsWith("..") && !isAbsolute(child);
}
function errorText(error) {
	return error instanceof Error ? error.message : String(error);
}

function normalizeResponseLocale(value) {
	const locale = String(value ?? "").trim();
	if (!locale) return null;
	if (locale.length > 64 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(locale)) throw new Error("responseLocale must be a simple BCP-47-like locale tag such as zh-CN or en.");
	return locale;
}
function languageDirective(mode, locale) {
	if (mode === "AUTO") return "";
	if (!locale) throw new Error("responseLocale is required when languageSyncMode is MIRROR_USER or FIXED.");
	const lower = locale.toLowerCase();
	if (lower.startsWith("zh")) return [
		"【语言同步 / Language Affinity】",
		`LANGUAGE_SYNC_MODE: ${mode}`,
		`RESPONSE_LOCALE: ${locale}`,
		"从本轮开始，所有用户可见的自然语言进度、发现、提问、说明、测试摘要、风险与最终结果都使用中文。",
		"不要翻译或改写代码、标识符、文件路径、命令、API/Tool/MCP 名称、原始错误信息或结构化协议字段名。",
		"保持 STATUS、SUMMARY、EVIDENCE、RISKS、UNRESOLVED 等协议 key 为英文；只让人类可读 value 跟随本语言。",
		"不要输出私有 chain-of-thought；只输出完成任务所需的用户可见说明。"
	].join("\n");
	if (lower.startsWith("en")) return [
		"[Language Affinity]",
		`LANGUAGE_SYNC_MODE: ${mode}`,
		`RESPONSE_LOCALE: ${locale}`,
		"From this turn onward, use English for all user-visible progress, findings, questions, explanations, test summaries, risks, and final results.",
		"Do not translate or rename code, identifiers, file paths, commands, API/Tool/MCP names, raw error messages, or structured protocol field names.",
		"Keep protocol keys such as STATUS, SUMMARY, EVIDENCE, RISKS, and UNRESOLVED in English; only human-readable values follow this locale.",
		"Do not expose private chain-of-thought; provide only user-visible information needed to complete the task."
	].join("\n");
	return [
		"[Language Affinity]",
		`LANGUAGE_SYNC_MODE: ${mode}`,
		`RESPONSE_LOCALE: ${locale}`,
		`Use ${locale} for all user-visible natural-language progress, findings, questions, explanations, test summaries, risks, and final results.`,
		"Do not translate or rename code, identifiers, file paths, commands, API/Tool/MCP names, raw error messages, or structured protocol field names.",
		"Keep protocol keys in English; only human-readable values follow the requested locale.",
		"Do not expose private chain-of-thought."
	].join("\n");
}
const SKILL_MAX_COUNT = 16;
const SKILL_MAX_FILE_BYTES = 512 * 1024;
const SKILL_MAX_INJECTED_BYTES = 1024 * 1024;
const HARNESS_ROLES = new Set(["EXPLORER", "RESEARCHER", "WORKER", "INTEGRATOR", "TESTER", "REVIEWER", "CAPABILITY_BOOTSTRAP"]);
function normalizeHarnessRole(value) {
	const role = String(value ?? "WORKER").trim().toUpperCase();
	if (!HARNESS_ROLES.has(role)) throw new Error(`Unsupported harnessRole: ${role}`);
	return role;
}
function normalizeSkillId(value) {
	const id = String(value ?? "").trim();
	if (!id || id.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) throw new Error("skill id must be 1-128 characters using letters, digits, dot, underscore, colon, or hyphen.");
	return id;
}
function normalizeSkillRoles(value) {
	if (!Array.isArray(value) || value.length === 0) return ["ALL"];
	const roles = [...new Set(value.map((item) => String(item).trim().toUpperCase()).filter(Boolean))];
	for (const role of roles) if (role !== "ALL" && !HARNESS_ROLES.has(role)) throw new Error(`Unsupported Skill applyToRoles value: ${role}`);
	return roles.length ? roles : ["ALL"];
}
function publicSkillBinding(binding) {
	return {
		id: binding.id,
		target: binding.target,
		sourceType: binding.sourceType,
		transferMode: binding.transferMode,
		applyToRoles: binding.applyToRoles,
		required: binding.required,
		sha256: binding.sha256,
		byteLength: binding.byteLength,
		canonicalPath: binding.transferMode === "REFERENCE" ? binding.canonicalPath : null,
		snapshotRef: binding.snapshotRef ?? null
	};
}
function skillRoutingDirective(bindings, harnessRole) {
	if (!bindings.length) return "";
	const lines = [
		"[Skill Routing / Skill Affinity]",
		`HARNESS_ROLE: ${harnessRole}`,
		"The following Skills were explicitly assigned to Harness for this run.",
		"Apply [SHARED], [HARNESS], and the matching [ROLE:*] sections. Treat [CODEX] sections as supervisor-only guidance, not execution instructions.",
		"A Skill may refine execution technique but MUST NOT expand the Task Contract, file/resource scope, permissions, risk boundary, ownership, or acceptance criteria.",
		"If a required Skill conflicts with the Task Contract or cannot be applied, return ESCALATE/BLOCKED instead of silently substituting another Skill."
	];
	for (const binding of bindings) {
		lines.push("", `SKILL_ID: ${binding.id}`, `SKILL_TARGET: ${binding.target}`, `SKILL_SHA256: ${binding.sha256}`, `SKILL_TRANSFER_MODE: ${binding.transferMode}`, `SKILL_APPLY_TO_ROLES: ${binding.applyToRoles.join(",")}`);
		if (binding.transferMode === "REFERENCE") {
			lines.push(`SKILL_PATH: ${binding.canonicalPath}`, "Read this verified file before performing the assigned role. Do not ask Codex to restate its body.");
		} else {
			lines.push(`--- BEGIN FORWARDED SKILL ${binding.id} ---`, binding.content, `--- END FORWARDED SKILL ${binding.id} ---`);
		}
	}
	return lines.join("\n");
}
function taskWithExecutionPolicies(task, mode, locale, harnessRole, skillBindings) {
	const parts = [];
	const language = languageDirective(mode, locale);
	if (language) parts.push(language);
	const skills = skillRoutingDirective(skillBindings, harnessRole);
	if (skills) parts.push(skills);
	parts.push([
		"[Cross-Runtime Context Sync]",
		"This Harness session may later receive direct human instructions outside Codex.",
		"Direct user instructions are authoritative for the work they explicitly request, including temporary direction/architecture overrides.",
		"Do not treat a user-issued override as an agent policy violation. Record the change clearly so Codex can later synchronize it.",
		"At the end of each substantial user-visible turn, when practical append a compact CONTEXT_CHECKPOINT with REQUEST, DECISIONS, CHANGES, TESTS, UNRESOLVED, and whether direction/acceptance/invariants changed.",
		"Keep the checkpoint concise; do not expose private chain-of-thought."
	].join("\n"));
	parts.push(`--- TASK ---\n${task}`);
	return parts.join("\n\n");
}
function taskWithLanguagePolicy(task, mode, locale) {
	return taskWithExecutionPolicies(task, mode, locale, "WORKER", []);
}

function recordText(value) {
	if (typeof value === "string") return value;
	if (typeof value !== "object" || value === null) return null;
	const record = value;
	return typeof record.message === "string" ? record.message : typeof record.error === "string" ? record.error : null;
}
function assistantText(events) {
	const blocks = [];
	for (const { event } of events) {
		if (event.type !== "assistant/message" || typeof event.data !== "object" || event.data === null) continue;
		const message = event.data.message;
		if (typeof message !== "object" || message === null) continue;
		const content = message.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) if (typeof block === "object" && block !== null && block.type === "text") {
			const text = block.text;
			if (typeof text === "string") blocks.push(text);
		}
	}
	return blocks.join("\n");
}
function messageContentText(message) {
	if (typeof message !== "object" || message === null || !Array.isArray(message.content)) return "";
	const blocks = [];
	for (const block of message.content) if (typeof block === "object" && block !== null && block.type === "text" && typeof block.text === "string") blocks.push(block.text);
	return blocks.join("\n");
}
function sessionEventText(event) {
	if (!event || typeof event !== "object") return "";
	if (event.type === "user/message") {
		const data = event.data;
		return messageContentText(data?.message ?? data);
	}
	if (event.type === "assistant/message" || event.type === "tool/result" || event.type === "system/message") return messageContentText(event.data?.message);
	return recordText(event.data) ?? "";
}
function boundedText(value, limit = 4000) {
	const text = String(value ?? "");
	if (text.length <= limit) return text;
	return `${text.slice(0, Math.max(0, limit - 32))}\n...[truncated by Bridge]`;
}
function toolCallName(event) {
	if (event?.type !== "tool/call" || typeof event.data !== "object" || event.data === null) return null;
	return event.data.name ?? event.data.toolName ?? event.data.tool?.name ?? null;
}
function directUserSource(event) {
	if (event?.type !== "user/message" || typeof event.data !== "object" || event.data === null) return null;
	return event.data.source ?? event.data.message?.source ?? null;
}
/** Owns visible local Harness Web services and tasks submitted into their sessions. */
var RunManager = class {
	existingUrl;
	existingApi;
	services = /* @__PURE__ */ new Map();
	serviceByWorkspace = /* @__PURE__ */ new Map();
	starts = /* @__PURE__ */ new Map();
	runs = /* @__PURE__ */ new Map();
	activeSessions = /* @__PURE__ */ new Set();
	durableRuns = /* @__PURE__ */ new Map();
	durableLedgerLoaded = false;
	durableWriteChain = Promise.resolve();
	sessionSync = /* @__PURE__ */ new Map();
	sessionSyncLoaded = false;
	sessionSyncWriteChain = Promise.resolve();
	dataDirectory;
	durableLedgerPath;
	sessionSyncPath;
	skillCacheDirectory;
	allowedRoots;
	startupTimeoutMs;
	pollIntervalMs;
	commandFactory;
	spawnProcess;
	openBrowserImpl;
	constructor(options = {}) {
		const configuredUrl = options.existingUrl ?? process.env.DSH_MCP_EXISTING_URL;
		this.existingUrl = configuredUrl ? validateExistingUrl(configuredUrl) : void 0;
		this.existingApi = options.existingApi ?? (process.env.DSH_MCP_EXISTING_API === "legacy" ? "legacy" : "remote");
		this.dataDirectory = resolve(options.dataDirectory ?? resolveDataDirectory());
		this.durableLedgerPath = join(this.dataDirectory, "durable-runs.json");
		this.sessionSyncPath = join(this.dataDirectory, "session-sync.json");
		this.skillCacheDirectory = join(this.dataDirectory, "skill-cache");
		this.allowedRoots = (options.allowedRoots ?? resolveAllowedRoots()).map((root) => resolve(root));
		this.startupTimeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
		this.pollIntervalMs = options.pollIntervalMs ?? 400;
		this.commandFactory = options.commandFactory ?? ((input) => buildHarnessWebCommand(input));
		this.spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
		this.openBrowserImpl = options.openBrowser ?? defaultOpenBrowser;
	}
	/** Resolves Harness-target Skill files without requiring Codex to consume their execution body. */
	async prepareSkillInputs(inputs, workspace, harnessRole) {
		if (inputs === void 0 || inputs === null) return { bindings: [], warnings: [] };
		if (!Array.isArray(inputs)) throw new Error("skillInputs must be an array.");
		if (inputs.length > SKILL_MAX_COUNT) throw new Error(`skillInputs exceeds the ${SKILL_MAX_COUNT} item limit.`);
		const bindings = [];
		const warnings = [];
		let injectedBytes = 0;
		for (const raw of inputs) {
			const required = raw?.required ?? true;
			try {
				const id = normalizeSkillId(raw?.id);
				const target = String(raw?.target ?? "HARNESS").trim().toUpperCase();
				if (!new Set(["HARNESS", "SHARED"]).has(target)) throw new Error(`Bridge only accepts HARNESS/SHARED Skill targets, got ${target}.`);
				const sourceType = String(raw?.sourceType ?? (raw?.path ? "PATH" : "INLINE")).trim().toUpperCase();
				if (!new Set(["PATH", "INLINE"]).has(sourceType)) throw new Error(`Unsupported Skill sourceType: ${sourceType}`);
				const transferMode = String(raw?.transferMode ?? (sourceType === "PATH" ? "SNAPSHOT" : "INLINE")).trim().toUpperCase();
				if (!new Set(["SNAPSHOT", "REFERENCE", "INLINE"]).has(transferMode)) throw new Error(`Unsupported Skill transferMode: ${transferMode}`);
				if (transferMode === "REFERENCE" && sourceType !== "PATH") throw new Error("Skill REFERENCE transferMode requires sourceType=PATH.");
				const applyToRoles = normalizeSkillRoles(raw?.applyToRoles);
				if (!applyToRoles.includes("ALL") && !applyToRoles.includes(harnessRole)) continue;
				let content;
				let canonicalPath = null;
				if (sourceType === "PATH") {
					const inputPath = String(raw?.path ?? "").trim();
					if (!inputPath) throw new Error(`Skill ${id} sourceType=PATH requires path.`);
					const candidate = isAbsolute(inputPath) ? resolve(inputPath) : resolve(workspace, inputPath);
					canonicalPath = await realpath(candidate);
					const info = await stat(canonicalPath);
					if (!info.isFile()) throw new Error(`Skill ${id} path is not a regular file.`);
					if (info.size > SKILL_MAX_FILE_BYTES) throw new Error(`Skill ${id} exceeds the ${SKILL_MAX_FILE_BYTES} byte limit.`);
					const insideAllowedRoot = isWithin(workspace, canonicalPath) || this.allowedRoots.some((root) => isWithin(root, canonicalPath));
					if (!insideAllowedRoot && !(raw?.externalPathApproved ?? false)) throw new Error(`Skill ${id} is outside the workspace/allowed roots; explicit user-approved externalPathApproved=true is required.`);
					content = await readFile(canonicalPath, "utf8");
				} else {
					if (typeof raw?.content !== "string" || raw.content.length === 0) throw new Error(`Skill ${id} sourceType=INLINE requires content.`);
					content = raw.content;
				}
				const byteLength = Buffer.byteLength(content, "utf8");
				if (byteLength > SKILL_MAX_FILE_BYTES) throw new Error(`Skill ${id} exceeds the ${SKILL_MAX_FILE_BYTES} byte limit.`);
				const sha256 = createHash("sha256").update(content).digest("hex");
				const expected = typeof raw?.expectedSha256 === "string" ? raw.expectedSha256.trim().toLowerCase() : "";
				if (expected && (!/^[a-f0-9]{64}$/.test(expected) || expected !== sha256)) throw new Error(`Skill ${id} SHA256 mismatch.`);
				let snapshotRef = null;
				if (transferMode === "SNAPSHOT") {
					await mkdir(this.skillCacheDirectory, { recursive: true, mode: 448 });
					const snapshotPath = join(this.skillCacheDirectory, `${sha256}.skill.md`);
					try { await stat(snapshotPath); } catch { await writeFile(snapshotPath, content, { encoding: "utf8", mode: 384 }); }
					snapshotRef = `sha256:${sha256}`;
				}
				if (transferMode !== "REFERENCE") {
					injectedBytes += byteLength;
					if (injectedBytes > SKILL_MAX_INJECTED_BYTES) throw new Error(`Injected Skill content exceeds the ${SKILL_MAX_INJECTED_BYTES} byte per-run limit.`);
				}
				bindings.push({ id, target, sourceType, transferMode, applyToRoles, required, sha256, byteLength, canonicalPath, snapshotRef, content: transferMode === "REFERENCE" ? null : content });
			} catch (error) {
				if (required) throw error;
				warnings.push(errorText(error));
			}
		}
		return { bindings, warnings };
	}


	/** Loads the process-independent Harness↔Codex session sync cursors. */
	async loadSessionSyncLedger() {
		if (this.sessionSyncLoaded) return;
		this.sessionSyncLoaded = true;
		try {
			const body = JSON.parse(await readFile(this.sessionSyncPath, "utf8"));
			if (body?.schemaVersion !== 1 || !Array.isArray(body.sessions)) return;
			for (const record of body.sessions) if (record && typeof record.key === "string") this.sessionSync.set(record.key, record);
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
	}
	async flushSessionSyncLedger() {
		await this.loadSessionSyncLedger();
		const write = async () => {
			await mkdir(dirname(this.sessionSyncPath), { recursive: true, mode: 448 });
			const temp = `${this.sessionSyncPath}.${process.pid}.${randomUUID()}.tmp`;
			const payload = JSON.stringify({ schemaVersion: 1, updatedAt: new Date().toISOString(), sessions: [...this.sessionSync.values()] }, null, 2);
			await writeFile(temp, payload, { encoding: "utf8", mode: 384 });
			await rename(temp, this.sessionSyncPath);
		};
		this.sessionSyncWriteChain = this.sessionSyncWriteChain.then(write, write);
		return this.sessionSyncWriteChain;
	}
	sessionSyncKey(workspace, sessionId) {
		return `${resolve(workspace)}::${sessionId}`;
	}
	async knownSessionRecord(sessionId, workspace) {
		await this.loadDurableLedger();
		const normalized = workspace ? await this.resolveWorkspace(workspace) : null;
		const records = [...this.durableRuns.values()].filter((record) => record.sessionId === sessionId && (!normalized || resolve(record.workspace) === normalized));
		if (!records.length) throw new Error("Session is not bound to any durable Toharness run; provide a session previously created or adopted by this Bridge.");
		records.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
		return records[0];
	}
	async sessionService(sessionId, workspace) {
		try {
			const record = await this.knownSessionRecord(sessionId, workspace);
			const service = await this.recoveryService(record);
			return { record, service };
		} catch (durableError) {
			await this.loadSessionSyncLedger();
			let bindings = [...this.sessionSync.values()].filter((item) => item.sessionId === sessionId);
			if (workspace) {
				const normalized = await this.resolveWorkspace(workspace);
				bindings = bindings.filter((item) => resolve(item.workspace) === normalized);
			}
			if (bindings.length !== 1) throw durableError;
			const binding = bindings[0];
			const snapshot = await this.startService({ workspace: binding.workspace, openBrowser: false });
			const service = this.requireService(snapshot.serviceId);
			const list = await this.rpc(service, "session.list", {});
			if (!list.items.some((item) => item.sessionId === sessionId)) throw new Error(`Adopted Harness session is no longer visible: ${sessionId}`);
			return { record: { workspace: binding.workspace, sessionId, taskId: binding.taskId ?? null, executionLineageId: binding.executionLineageId ?? "main" }, service };
		}
	}
	async listPersistedSessions(input) {
		const workspace = await this.resolveWorkspace(input.workspace);
		const snapshot = await this.startService({ workspace, openBrowser: false });
		const service = this.requireService(snapshot.serviceId);
		const list = await this.rpc(service, "session.list", {});
		const limit = Math.min(Math.max(input.maxSessions ?? 50, 1), 200);
		const visible = list.items.filter((item) => !item.cwd || resolve(item.cwd) === workspace).slice(0, limit);
		return { workspace, sessions: visible.map((item) => ({
			sessionId: item.sessionId, cwd: item.cwd ?? null, running: Boolean(item.running), projections: item.projections ?? null, title: item.title ?? null, updatedAt: item.updatedAt ?? null
		})) };
	}
	async adoptSession(input) {
		const workspace = await this.resolveWorkspace(input.workspace);
		const snapshot = await this.startService({ workspace, openBrowser: false });
		const service = this.requireService(snapshot.serviceId);
		const list = await this.rpc(service, "session.list", {});
		const summary = list.items.find((item) => item.sessionId === input.sessionId);
		if (!summary) throw new Error(`Harness session is not visible for adoption: ${input.sessionId}`);
		if (service.external && summary.cwd && resolve(summary.cwd) !== workspace) throw new Error("Harness session belongs to a different workspace.");
		const cursor = await this.currentSessionCursor(service, input.sessionId);
		await this.loadSessionSyncLedger();
		const key = this.sessionSyncKey(workspace, input.sessionId);
		const existing = this.sessionSync.get(key);
		const requestedBaseline = Number.isInteger(input.afterEventSeq) ? input.afterEventSeq : existing?.lastSyncedEventSeq ?? -1;
		const record = {
			...existing, key, workspace, sessionId: input.sessionId, taskId: input.taskId?.trim() || existing?.taskId || null,
			executionLineageId: input.executionLineageId?.trim() || existing?.executionLineageId || "main", adopted: true,
			lastSyncedEventSeq: requestedBaseline, lastSeenEventSeq: cursor.latestSeq, controlOwner: input.controlOwner ?? existing?.controlOwner ?? "HARNESS",
			overrideReviewState: existing?.overrideReviewState ?? "NONE", updatedAt: new Date().toISOString(), adoptedAt: existing?.adoptedAt ?? new Date().toISOString()
		};
		this.sessionSync.set(key, record);
		await this.flushSessionSyncLedger();
		return { ...record, latestEventSeq: cursor.latestSeq, running: cursor.running, unsynced: cursor.latestSeq > Number(record.lastSyncedEventSeq ?? -1) };
	}
	async currentSessionCursor(service, sessionId) {
		const list = await this.rpc(service, "session.list", {});
		const summary = list.items.find((item) => item.sessionId === sessionId);
		if (!summary) throw new Error(`Persisted Harness session is not visible: ${sessionId}`);
		const projected = summary.projections?.asOfSeq;
		if (Number.isInteger(projected)) return { latestSeq: projected, running: Boolean(summary.running), summary };
		const history = await this.rpc(service, "session.history", { sessionId, maxMessages: 1 });
		const latestSeq = history.events.reduce((highest, entry) => Math.max(highest, Number(entry.event?.seq ?? -1)), -1);
		return { latestSeq, running: Boolean(summary.running), summary };
	}
	async syncRecord(sessionId, workspace, create = true) {
		await this.loadSessionSyncLedger();
		const normalized = await this.resolveWorkspace(workspace);
		const key = this.sessionSyncKey(normalized, sessionId);
		let record = this.sessionSync.get(key);
		if (!record && create) {
			await this.loadDurableLedger();
			const acknowledged = [...this.durableRuns.values()].filter((run) => resolve(run.workspace) === normalized && run.sessionId === sessionId && run.deliveryState === "ACKNOWLEDGED");
			const baseline = acknowledged.reduce((highest, run) => Math.max(highest, Number(run.lastEventSeq ?? run.startEventSeq ?? -1)), -1);
			record = {
				key, workspace: normalized, sessionId, lastSyncedEventSeq: baseline, lastSeenEventSeq: baseline,
				controlOwner: "CODEX", overrideReviewState: "NONE", updatedAt: new Date().toISOString(), acknowledgedAt: null
			};
			this.sessionSync.set(key, record);
			await this.flushSessionSyncLedger();
		}
		return record ?? null;
	}
	async acknowledgeSessionSyncInternal(workspace, sessionId, throughEventSeq, metadata = {}) {
		const record = await this.syncRecord(sessionId, workspace, true);
		const next = {
			...record,
			lastSyncedEventSeq: Math.max(Number(record.lastSyncedEventSeq ?? -1), Number(throughEventSeq ?? -1)),
			lastSeenEventSeq: Math.max(Number(record.lastSeenEventSeq ?? -1), Number(throughEventSeq ?? -1)),
			controlOwner: metadata.controlOwner ?? record.controlOwner ?? "CODEX",
			overrideReviewState: metadata.overrideReviewState ?? record.overrideReviewState ?? "NONE",
			decisionClasses: metadata.decisionClasses ?? record.decisionClasses ?? [],
			acknowledgedAt: new Date().toISOString(), updatedAt: new Date().toISOString()
		};
		this.sessionSync.set(next.key, next);
		await this.flushSessionSyncLedger();
		return next;
	}
	async getSessionCursor(input) {
		const { record: durable, service } = await this.sessionService(input.sessionId, input.workspace);
		const cursor = await this.currentSessionCursor(service, input.sessionId);
		const sync = await this.syncRecord(input.sessionId, durable.workspace, true);
		const unsynced = cursor.latestSeq > Number(sync.lastSyncedEventSeq ?? -1);
		const next = { ...sync, lastSeenEventSeq: Math.max(Number(sync.lastSeenEventSeq ?? -1), cursor.latestSeq), updatedAt: new Date().toISOString() };
		this.sessionSync.set(next.key, next);
		await this.flushSessionSyncLedger();
		return {
			sessionId: input.sessionId, workspace: durable.workspace, latestEventSeq: cursor.latestSeq,
			lastSyncedEventSeq: Number(sync.lastSyncedEventSeq ?? -1), unsynced, running: cursor.running,
			controlOwner: sync.controlOwner ?? "CODEX", overrideReviewState: sync.overrideReviewState ?? "NONE"
		};
	}
	async fetchSessionDelta(service, sessionId, afterEventSeq, maxEvents) {
		const cursor = await this.currentSessionCursor(service, sessionId);
		if (cursor.latestSeq <= afterEventSeq) return { events: [], latestSeq: cursor.latestSeq, running: cursor.running, truncated: false };
		const requested = Math.min(Math.max(maxEvents, 1), 5000);
		const history = await this.rpc(service, "session.history", { sessionId, maxMessages: requested });
		const events = history.events.filter((entry) => Number(entry.event?.seq ?? -1) > afterEventSeq).sort((a, b) => Number(a.event.seq) - Number(b.event.seq));
		const earliest = events.length ? Number(events[0].event.seq) : cursor.latestSeq + 1;
		return { events, latestSeq: cursor.latestSeq, running: cursor.running, truncated: earliest > afterEventSeq + 1 };
	}
	async sessionDelta(input) {
		const { record: durable, service } = await this.sessionService(input.sessionId, input.workspace);
		const sync = await this.syncRecord(input.sessionId, durable.workspace, true);
		const after = Number.isInteger(input.afterEventSeq) ? input.afterEventSeq : Number(sync.lastSyncedEventSeq ?? -1);
		const maxEvents = input.maxEvents ?? 500;
		const maxChars = Math.min(Math.max(input.maxChars ?? 8000, 1000), 24000);
		const delta = await this.fetchSessionDelta(service, input.sessionId, after, maxEvents);
		const runRanges = (await this.listDurable({ workspace: durable.workspace })).filter((run) => run.sessionId === input.sessionId).map((run) => ({
			durableRunId: run.durableRunId, runId: run.runId, start: Number(run.startEventSeq ?? -1), end: Number(run.lastEventSeq ?? run.startEventSeq ?? -1), deliveryState: run.deliveryState
		}));
		let budget = maxChars;
		const take = (text, perItem = 3000) => {
			if (!text || budget <= 0) return "";
			const bounded = boundedText(text, Math.min(perItem, budget));
			budget -= bounded.length;
			return bounded;
		};
		const userRequests = [];
		const assistantOutputs = [];
		const checkpoints = [];
		const toolCalls = [];
		const errors = [];
		const eventTypeCounts = {};
		const eventRefs = [];
		let directUserEventCount = 0;
		let delegatedUserEventCount = 0;
		for (const entry of delta.events) {
			const event = entry.event;
			const seq = Number(event.seq ?? -1);
			eventTypeCounts[event.type] = (eventTypeCounts[event.type] ?? 0) + 1;
			if (eventRefs.length < 64 && ["user/message", "assistant/message", "agent/error", "turn/start", "turn/end"].includes(event.type)) eventRefs.push({ seq, type: event.type, time: event.time ?? null });
			if (event.type === "user/message") {
				const linked = runRanges.some((run) => seq > run.start && seq <= run.end);
				if (linked) delegatedUserEventCount += 1; else directUserEventCount += 1;
				const text = take(sessionEventText(event));
				if (text) userRequests.push({ seq, source: directUserSource(event), origin: linked ? "CODEX_DELEGATED" : "HARNESS_USER", text });
			}
			if (event.type === "assistant/message") {
				const text = take(sessionEventText(event));
				if (text) {
					assistantOutputs.push({ seq, text });
					if (/CONTEXT[_ -]?CHECKPOINT/i.test(text)) checkpoints.push({ seq, text });
				}
			}
			if (event.type === "tool/call") {
				const name = toolCallName(event);
				if (name && toolCalls.length < 64) toolCalls.push({ seq, name: String(name) });
			}
			if (event.type === "agent/error") {
				const text = take(recordText(event.data) ?? sessionEventText(event), 2000);
				if (text) errors.push({ seq, text });
			}
		}
		const origin = directUserEventCount > 0 && delegatedUserEventCount > 0 ? "MIXED" : directUserEventCount > 0 ? "HARNESS_DIRECT_ACTIVITY" : delegatedUserEventCount > 0 ? "CODEX_DELEGATED_ACTIVITY" : "UNKNOWN";
		const next = { ...sync, lastSeenEventSeq: Math.max(Number(sync.lastSeenEventSeq ?? -1), delta.latestSeq), updatedAt: new Date().toISOString() };
		this.sessionSync.set(next.key, next);
		await this.flushSessionSyncLedger();
		return {
			sessionId: input.sessionId, workspace: durable.workspace, fromEventSeq: after + 1, throughEventSeq: delta.latestSeq,
			lastSyncedEventSeq: Number(sync.lastSyncedEventSeq ?? -1), running: delta.running, unsynced: delta.latestSeq > Number(sync.lastSyncedEventSeq ?? -1),
			origin, directUserEventCount, delegatedUserEventCount, truncated: delta.truncated, compacted: true, maxChars,
			userRequests, assistantOutputs, checkpoints, toolCalls, errors, eventTypeCounts, eventRefs,
			eventRefsTruncated: delta.events.length > eventRefs.length,
			linkedDurableRuns: runRanges.filter((run) => run.end > after),
			controlOwner: sync.controlOwner ?? "CODEX", overrideReviewState: sync.overrideReviewState ?? "NONE",
			drilldown: delta.truncated || budget <= 0 ? "Use read_session_events with a narrower event range only if Codex needs evidence beyond this compact delta." : null
		};
	}
	async listUnsyncedSessions(input) {
		await this.loadDurableLedger();
		await this.loadSessionSyncLedger();
		const workspace = await this.resolveWorkspace(input.workspace);
		let durable = [...this.durableRuns.values()].filter((record) => resolve(record.workspace) === workspace);
		if (input.taskId) durable = durable.filter((record) => record.taskId === input.taskId);
		const candidates = new Map();
		for (const record of durable.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))) if (!candidates.has(record.sessionId)) candidates.set(record.sessionId, { sessionId: record.sessionId, taskId: record.taskId ?? null, executionLineageId: record.executionLineageId ?? "main" });
		for (const binding of this.sessionSync.values()) {
			if (resolve(binding.workspace) !== workspace) continue;
			if (input.taskId && binding.taskId !== input.taskId) continue;
			if (!candidates.has(binding.sessionId)) candidates.set(binding.sessionId, { sessionId: binding.sessionId, taskId: binding.taskId ?? null, executionLineageId: binding.executionLineageId ?? "main", adopted: Boolean(binding.adopted) });
		}
		const sessions = [];
		for (const candidate of [...candidates.values()].slice(0, input.maxSessions ?? 32)) {
			try {
				const cursor = await this.getSessionCursor({ sessionId: candidate.sessionId, workspace });
				if (cursor.unsynced) sessions.push({ ...cursor, ...candidate });
			} catch (error) {
				sessions.push({ ...candidate, workspace, error: errorText(error) });
			}
		}
		return { sessions, unsyncedCount: sessions.filter((item) => item.unsynced).length };
	}
	async acknowledgeSessionSync(input) {
		const { record: durable } = await this.sessionService(input.sessionId, input.workspace);
		const cursor = await this.getSessionCursor({ sessionId: input.sessionId, workspace: durable.workspace });
		const through = Number.isInteger(input.throughEventSeq) ? input.throughEventSeq : cursor.latestEventSeq;
		if (through > cursor.latestEventSeq) throw new Error("throughEventSeq cannot exceed the current Harness session cursor.");
		const controlOwner = input.controlOwner ?? cursor.controlOwner ?? "CODEX";
		const overrideReviewState = input.overrideReviewState ?? cursor.overrideReviewState ?? "NONE";
		return this.acknowledgeSessionSyncInternal(durable.workspace, input.sessionId, through, { controlOwner, overrideReviewState, decisionClasses: input.decisionClasses ?? [] });
	}
	async readSessionEvents(input) {
		const { record: durable, service } = await this.sessionService(input.sessionId, input.workspace);
		const after = Number.isInteger(input.afterEventSeq) ? input.afterEventSeq : -1;
		const delta = await this.fetchSessionDelta(service, input.sessionId, after, input.maxEvents ?? 100);
		const maxChars = Math.min(Math.max(input.maxChars ?? 12000, 1000), 40000);
		let budget = maxChars;
		const records = [];
		for (const entry of delta.events) {
			const event = entry.event;
			if (!(input.includeToolEvents ?? false) && ["tool/call", "tool/result"].includes(event.type)) continue;
			let text = sessionEventText(event);
			if (text && budget > 0) {
				text = boundedText(text, Math.min(4000, budget));
				budget -= text.length;
			} else text = "";
			records.push({ seq: Number(event.seq ?? -1), time: event.time ?? null, type: event.type, source: directUserSource(event), toolName: toolCallName(event), text });
			if (budget <= 0) break;
		}
		return { sessionId: input.sessionId, workspace: durable.workspace, afterEventSeq: after, throughEventSeq: delta.latestSeq, running: delta.running, truncated: delta.truncated || budget <= 0, records };
	}

	/** Loads the process-independent Task/Run/Session ledger. */
	async loadDurableLedger() {
		if (this.durableLedgerLoaded) return;
		this.durableLedgerLoaded = true;
		try {
			const body = JSON.parse(await readFile(this.durableLedgerPath, "utf8"));
			if (body?.schemaVersion !== 1 || !Array.isArray(body.runs)) return;
			for (const record of body.runs) if (record && typeof record.durableRunId === "string" && typeof record.runId === "string") this.durableRuns.set(record.durableRunId, record);
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
	}
	async flushDurableLedger() {
		await this.loadDurableLedger();
		const write = async () => {
			await mkdir(dirname(this.durableLedgerPath), { recursive: true, mode: 448 });
			const temp = `${this.durableLedgerPath}.${process.pid}.${randomUUID()}.tmp`;
			const payload = JSON.stringify({
				schemaVersion: 1,
				updatedAt: new Date().toISOString(),
				runs: [...this.durableRuns.values()]
			}, null, 2);
			await writeFile(temp, payload, { encoding: "utf8", mode: 384 });
			await rename(temp, this.durableLedgerPath);
		};
		this.durableWriteChain = this.durableWriteChain.then(write, write);
		return this.durableWriteChain;
	}
	async persistRun(run, durableState) {
		await this.loadDurableLedger();
		const existing = this.durableRuns.get(run.durableRunId) ?? {};
		const record = {
			...existing,
			schemaVersion: 1,
			durableRunId: run.durableRunId,
			runId: run.runId,
			taskId: run.taskId ?? null,
			executionLineageId: run.executionLineageId ?? "main",
			languageSyncMode: run.languageSyncMode ?? existing.languageSyncMode ?? "AUTO",
			responseLocale: run.responseLocale ?? existing.responseLocale ?? null,
			harnessRole: run.harnessRole ?? existing.harnessRole ?? "WORKER",
			skillBindings: run.skillBindings ?? existing.skillBindings ?? [],
			skillWarnings: run.skillWarnings ?? existing.skillWarnings ?? [],
			workspace: run.workspace,
			sessionId: run.sessionId,
			startEventSeq: run.startEventSeq,
			turnNumber: run.turnNumber ?? existing.turnNumber ?? null,
			turnStartSeq: run.turnStartSeq ?? existing.turnStartSeq ?? null,
			turnEndSeq: run.turnEndSeq ?? existing.turnEndSeq ?? null,
			lastEventSeq: run.lastEventSeq,
			webUrl: run.webUrl,
			serviceExternal: Boolean(run.serviceExternal),
			durableState,
			deliveryState: existing.deliveryState ?? "UNACKNOWLEDGED",
			startedAt: run.startedAt.toISOString(),
			finishedAt: run.finishedAt?.toISOString() ?? null,
			updatedAt: new Date().toISOString(),
			recoveredAt: run.recoveredAt?.toISOString() ?? existing.recoveredAt ?? null
		};
		this.durableRuns.set(run.durableRunId, record);
		await this.flushDurableLedger();
		return record;
	}
	async listDurable(input = {}) {
		await this.loadDurableLedger();
		let records = [...this.durableRuns.values()];
		if (input.workspace) {
			const workspace = await this.resolveWorkspace(input.workspace);
			records = records.filter((record) => resolve(record.workspace) === workspace);
		}
		if (input.taskId) records = records.filter((record) => record.taskId === input.taskId);
		if (input.executionLineageId) records = records.filter((record) => record.executionLineageId === input.executionLineageId);
		if (!(input.includeTerminal ?? true)) records = records.filter((record) => ["SUBMITTED", "ACTIVE", "DETACHED_RUNNING", "RECOVERY_REQUIRED"].includes(record.durableState));
		return records.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
	}
	async findDurableRecord(input) {
		await this.loadDurableLedger();
		let records = [...this.durableRuns.values()];
		if (input.durableRunId) records = records.filter((record) => record.durableRunId === input.durableRunId);
		if (input.runId) records = records.filter((record) => record.runId === input.runId);
		if (input.taskId) records = records.filter((record) => record.taskId === input.taskId);
		if (input.executionLineageId) records = records.filter((record) => record.executionLineageId === input.executionLineageId);
		if (input.workspace) {
			const workspace = await this.resolveWorkspace(input.workspace);
			records = records.filter((record) => resolve(record.workspace) === workspace);
		}
		if (records.length === 0) throw new Error("No durable Harness run matches the requested identity.");
		if (records.length > 1) throw new Error("Durable run identity is ambiguous; provide durableRunId or runId.");
		return records[0];
	}
	async recoveryService(record) {
		const current = this.serviceForWorkspace(resolve(record.workspace));
		if (current) return current;
		if (this.existingUrl) {
			const snapshot = await this.startService({ workspace: record.workspace, openBrowser: false });
			return this.requireService(snapshot.serviceId);
		}
		if (record.webUrl) {
			const service = {
				serviceId: randomUUID(), workspace: resolve(record.workspace), status: "running", webUrl: record.webUrl,
				browserOpened: false, browserError: null, startedAt: new Date(record.startedAt ?? Date.now()), stoppedAt: null,
				external: Boolean(record.serviceExternal), recoveredManaged: !record.serviceExternal,
				cookie: record.serviceExternal ? await existingCookie(record.webUrl) : void 0, log: ""
			};
			try {
				await this.rpc(service, "session.list", {});
				this.services.set(service.serviceId, service);
				this.serviceByWorkspace.set(service.workspace, service.serviceId);
				return service;
			} catch {}
		}
		const snapshot = await this.startService({ workspace: record.workspace, openBrowser: false });
		return this.requireService(snapshot.serviceId);
	}
	/** Rehydrates a durable run from Harness persisted session state without sending another prompt. */
	async recover(input) {
		const record = await this.findDurableRecord(input);
		const inMemory = this.runs.get(record.runId);
		if (inMemory) return { ...(await this.refresh(inMemory)), recovered: false, recoveryState: "ALREADY_ATTACHED" };
		const service = await this.recoveryService(record);
		const list = await this.rpc(service, "session.list", {});
		const summary = list.items.find((item) => item.sessionId === record.sessionId);
		if (!summary) {
			this.durableRuns.set(record.durableRunId, { ...record, durableState: "RECOVERY_REQUIRED", updatedAt: new Date().toISOString() });
			await this.flushDurableLedger();
			throw new Error(`Persisted Harness session is not visible for durable run ${record.durableRunId}.`);
		}
		if (service.external && summary.cwd && resolve(summary.cwd) !== resolve(record.workspace)) throw new Error("Recovered Harness session belongs to a different workspace.");
		const run = {
			runId: record.runId, durableRunId: record.durableRunId, taskId: record.taskId ?? null,
			executionLineageId: record.executionLineageId ?? "main", languageSyncMode: record.languageSyncMode ?? "AUTO",
			responseLocale: record.responseLocale ?? null, harnessRole: record.harnessRole ?? "WORKER",
			skillBindings: record.skillBindings ?? [], skillWarnings: record.skillWarnings ?? [], serviceId: service.serviceId,
			sessionId: record.sessionId, sessionReused: true, startEventSeq: Number.isInteger(record.startEventSeq) ? record.startEventSeq : -1,
			turnNumber: Number.isInteger(record.turnNumber) ? record.turnNumber : null, turnStartSeq: Number.isInteger(record.turnStartSeq) ? record.turnStartSeq : null, turnEndSeq: Number.isInteger(record.turnEndSeq) ? record.turnEndSeq : null,
			task: "[recovered durable run; original task text is not duplicated in the ledger]", workspace: resolve(record.workspace),
			webUrl: service.webUrl, serviceExternal: Boolean(service.external), status: "running", cancelRequested: false,
			startedAt: new Date(record.startedAt), finishedAt: null, assistantText: "",
			lastEventSeq: Number.isInteger(record.lastEventSeq) ? record.lastEventSeq : Number(record.startEventSeq ?? -1),
			error: null, recoveredAt: new Date()
		};
		this.runs.set(run.runId, run);
		if (summary.running) this.activeSessions.add(`${service.serviceId}:${run.sessionId}`);
		const snapshot = await this.refresh(run);
		const recoveryState = snapshot.status === "running" ? "DETACHED_RUNNING" : snapshot.status === "succeeded" ? "DETACHED_COMPLETED" : snapshot.status === "failed" ? "DETACHED_FAILED" : "DETACHED_TERMINAL";
		await this.persistRun(run, snapshot.status === "running" ? "DETACHED_RUNNING" : snapshot.status === "succeeded" ? "COMPLETED" : snapshot.status === "cancelled" ? "CANCELLED" : "FAILED");
		return { ...snapshot, recovered: true, recoveryState };
	}
	async recoverPending(input) {
		const allRecords = await this.listDurable({ workspace: input.workspace, taskId: input.taskId, executionLineageId: input.executionLineageId, includeTerminal: true });
		const records = allRecords.filter((record) => record.deliveryState !== "ACKNOWLEDGED" || ["SUBMITTED", "ACTIVE", "DETACHED_RUNNING", "RECOVERY_REQUIRED"].includes(record.durableState));
		const selected = records.slice(0, input.maxRuns ?? 16);
		const recovered = [];
		for (const record of selected) try { recovered.push(await this.recover({ durableRunId: record.durableRunId })); }
		catch (error) { recovered.push({ durableRunId: record.durableRunId, runId: record.runId, recovered: false, error: errorText(error) }); }
		return { recovered, candidateCount: records.length };
	}
	async acknowledgeRun(input) {
		const record = await this.findDurableRecord(input);
		this.durableRuns.set(record.durableRunId, { ...record, deliveryState: "ACKNOWLEDGED", acknowledgedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
		await this.flushDurableLedger();
		await this.acknowledgeSessionSyncInternal(record.workspace, record.sessionId, Number(record.lastEventSeq ?? record.startEventSeq ?? -1), { controlOwner: "CODEX" });
		return this.durableRuns.get(record.durableRunId);
	}
	async ensureRun(runId) {
		const current = this.runs.get(runId);
		if (current) return current;
		await this.recover({ runId });
		const recovered = this.runs.get(runId);
		if (!recovered) throw new Error(`Unknown runId: ${runId}`);
		return recovered;
	}

	/** Starts or reuses the Harness Web service for an absolute workspace. */
	async startService(input) {
		const workspace = await this.resolveWorkspace(input.workspace);
		let service = this.serviceForWorkspace(workspace);
		if (service === void 0) {
			const pending = this.starts.get(workspace) ?? this.launchService(workspace);
			this.starts.set(workspace, pending);
			try {
				service = await pending;
			} finally {
				this.starts.delete(workspace);
			}
		}
		if ((input.openBrowser ?? false) && service.webUrl !== null) try {
			await this.openBrowserImpl(service.webUrl);
			service.browserOpened = true;
			service.browserError = null;
		} catch (error) {
			service.browserError = errorText(error);
		}
		return this.serviceSnapshot(service);
	}
	/** Opens an already running service in the user's default browser. */
	async openService(serviceId) {
		const service = this.requireService(serviceId);
		if (service.status !== "running" || service.webUrl === null) throw new Error("Harness Web service is not running.");
		await this.openBrowserImpl(service.webUrl);
		service.browserOpened = true;
		service.browserError = null;
		return this.serviceSnapshot(service);
	}
	/** Lists services owned by the current MCP server. */
	listServices() {
		return [...this.services.values()].map((service) => this.serviceSnapshot(service));
	}
	/** Stops one Web service and its active sessions. */
	async stopService(serviceId) {
		const service = this.requireService(serviceId);
		if (service.status === "running" || service.status === "starting") {
			for (const run of this.runs.values()) if (run.serviceId === serviceId && run.status === "running") await this.cancel(run.runId);
			await this.terminate(service);
		}
		return this.serviceSnapshot(service);
	}
	/** Starts or continues a Web session and submits the task through Harness RPC. */
	async start(input) {
		const task = input.task.trim();
		if (!task) throw new Error("task must not be empty.");
		if (task.length > 1e5) throw new Error("task exceeds the 100,000 character limit.");
		const languageSyncMode = input.languageSyncMode ?? "MIRROR_USER";
		const responseLocale = normalizeResponseLocale(input.responseLocale);
		if (languageSyncMode !== "AUTO" && responseLocale === null) throw new Error("responseLocale is required when languageSyncMode is MIRROR_USER or FIXED.");
		const harnessRole = normalizeHarnessRole(input.harnessRole);
		const serviceSnapshot = await this.startService({
			workspace: input.workspace,
			openBrowser: false
		});
		if (serviceSnapshot.webUrl === null) throw new Error("Harness Web service did not provide a URL.");
		const service = this.requireService(serviceSnapshot.serviceId);
		const preparedSkills = await this.prepareSkillInputs(input.skillInputs ?? [], service.workspace, harnessRole);
		const harnessTask = taskWithExecutionPolicies(task, languageSyncMode, responseLocale, harnessRole, preparedSkills.bindings);
		const workspaceResult = await this.rpc(service, "workspace.create", { path: service.workspace });
		const requestedSessionId = input.sessionId?.trim();
		let sessionId;
		let startEventSeq = -1;
		if (requestedSessionId === void 0 || requestedSessionId === "") sessionId = (await this.rpc(service, "session.create", { workspaceId: workspaceResult.workspace.workspaceId })).sessionId;
		else {
			const [list, history] = await Promise.all([this.rpc(service, "session.list", {}), this.rpc(service, "session.history", {
				sessionId: requestedSessionId,
				maxMessages: 50
			})]);
			const summary = list.items.find((item) => item.sessionId === requestedSessionId);
			if (summary === void 0) throw new Error(`Unknown sessionId for this workspace: ${requestedSessionId}`);
			if (service.external && (!summary.cwd || resolve(summary.cwd) !== service.workspace)) throw new Error("Existing session belongs to a different workspace; create a new session.");
			if (summary.running) throw new Error(`Harness session is still running: ${requestedSessionId}`);
			sessionId = requestedSessionId;
			startEventSeq = history.events.reduce((highest, entry) => Math.max(highest, entry.event.seq), -1);
			const sync = await this.syncRecord(sessionId, service.workspace, true);
			if (!(input.allowUnsyncedSession ?? false) && startEventSeq > Number(sync.lastSyncedEventSeq ?? -1)) throw new Error(`SESSION_SYNC_REQUIRED: Harness session ${sessionId} has unsynchronized activity through event ${startEventSeq}; call sync_session_delta and ack_session_sync before continuing, or explicitly set allowUnsyncedSession=true.`);
		}
		const activeSessionKey = `${service.serviceId}:${sessionId}`;
		if (this.activeSessions.has(activeSessionKey)) throw new Error(`Harness session already has an active MCP run: ${sessionId}`);
		this.activeSessions.add(activeSessionKey);
		try {
			await this.rpc(service, "session.prompt", {
				sessionId,
				mode: "queue",
				content: [{
					type: "text",
					text: harnessTask
				}]
			});
		} catch (error) {
			this.activeSessions.delete(activeSessionKey);
			throw error;
		}
		if (input.openBrowser ?? false) try {
			await this.openService(service.serviceId);
		} catch (error) {
			service.browserError = errorText(error);
		}
		const run = {
			runId: randomUUID(),
			durableRunId: randomUUID(),
			taskId: input.taskId?.trim() || null,
			executionLineageId: input.executionLineageId?.trim() || "main",
			languageSyncMode,
			responseLocale,
			harnessRole,
			skillBindings: preparedSkills.bindings.map(publicSkillBinding),
			skillWarnings: preparedSkills.warnings,
			serviceId: service.serviceId,
			sessionId,
			sessionReused: requestedSessionId !== void 0 && requestedSessionId !== "",
			startEventSeq,
			turnNumber: null,
			turnStartSeq: null,
			turnEndSeq: null,
			task,
			workspace: service.workspace,
			webUrl: serviceSnapshot.webUrl,
			serviceExternal: Boolean(service.external),
			status: "running",
			cancelRequested: false,
			startedAt: /* @__PURE__ */ new Date(),
			finishedAt: null,
			assistantText: "",
			lastEventSeq: startEventSeq,
			error: null
		};
		this.runs.set(run.runId, run);
		await this.persistRun(run, "ACTIVE");
		return this.refresh(run);
	}
	/** Lists runs and refreshes their observable Web session state. */
	async list() {
		return Promise.all([...this.runs.values()].map(async (run) => this.refresh(run)));
	}
	/** Reads a run from the same Web session shown to the user. */
	async get(runId) {
		return this.refresh(await this.ensureRun(runId));
	}
	/** Polls the Web session for up to 30 seconds. Retained for backward compatibility and short diagnostics. */
	async wait(runId, timeoutMs) {
		const run = await this.ensureRun(runId);
		const deadline = Date.now() + Math.min(Math.max(timeoutMs, 0), 3e4);
		let snapshot = await this.refresh(run);
		while (snapshot.status === "running" && Date.now() < deadline) {
			await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(this.pollIntervalMs, Math.max(1, deadline - Date.now()))));
			snapshot = await this.refresh(run);
		}
		return snapshot;
	}
	/** Long-polls entirely inside the Bridge until the run reaches a terminal state or the caller-selected deadline expires. */
	async waitUntilTerminal(runId, maxWaitMs, pollIntervalMs) {
		const run = await this.ensureRun(runId);
		const started = Date.now();
		const waitLimit = Math.min(Math.max(maxWaitMs, 1e3), 36e5);
		const interval = Math.min(Math.max(pollIntervalMs, 250), 1e4);
		const deadline = started + waitLimit;
		let snapshot = await this.refresh(run);
		while (snapshot.status === "running" && Date.now() < deadline) {
			await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(interval, Math.max(1, deadline - Date.now()))));
			snapshot = await this.refresh(run);
		}
		return {
			...snapshot,
			waitMode: "until-terminal",
			waitTimedOut: snapshot.status === "running",
			waitedMs: Date.now() - started,
			maxWaitMs: waitLimit,
			pollIntervalMs: interval
		};
	}
	/** Long-polls a bounded set of runs inside the Bridge and returns once all are terminal or the deadline expires. */
	async waitManyUntilTerminal(runIds, maxWaitMs, pollIntervalMs) {
		const uniqueRunIds = [...new Set(runIds)];
		if (uniqueRunIds.length === 0) throw new Error("runIds must contain at least one runId.");
		if (uniqueRunIds.length > 32) throw new Error("runIds exceeds the 32-run limit.");
		for (const runId of uniqueRunIds) await this.ensureRun(runId);
		const started = Date.now();
		const waitLimit = Math.min(Math.max(maxWaitMs, 1e3), 36e5);
		const interval = Math.min(Math.max(pollIntervalMs, 250), 1e4);
		const deadline = started + waitLimit;
		let snapshots = await Promise.all(uniqueRunIds.map((runId) => this.get(runId)));
		while (snapshots.some((snapshot) => snapshot.status === "running") && Date.now() < deadline) {
			await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(interval, Math.max(1, deadline - Date.now()))));
			snapshots = await Promise.all(uniqueRunIds.map((runId) => this.get(runId)));
		}
		const pendingRunIds = snapshots.filter((snapshot) => snapshot.status === "running").map((snapshot) => snapshot.runId);
		return {
			runs: snapshots,
			waitMode: "all-until-terminal",
			waitTimedOut: pendingRunIds.length > 0,
			pendingRunIds,
			waitedMs: Date.now() - started,
			maxWaitMs: waitLimit,
			pollIntervalMs: interval
		};
	}
	/** Cancels the Harness agent turn without stopping the visible Web service. */
	async cancel(runId) {
		const run = await this.ensureRun(runId);
		if (run.status === "running") {
			run.cancelRequested = true;
			const service = this.requireService(run.serviceId);
			await this.rpc(service, "session.cancel", { sessionId: run.sessionId });
		}
		return this.refresh(run);
	}
	/** Detaches from active runs when the Codex/MCP client disappears. Explicit stop_service/cancel_run are the only cancellation paths. */
	async close() {
		for (const run of this.runs.values()) if (run.status === "running") {
			try { await this.persistRun(run, "DETACHED_RUNNING"); } catch {}
		}
	}
	async launchService(workspace) {
		if (this.existingUrl) {
			const service = {
				serviceId: randomUUID(),
				workspace,
				status: "running",
				webUrl: this.existingUrl,
				browserOpened: false,
				browserError: null,
				startedAt: /* @__PURE__ */ new Date(),
				stoppedAt: null,
				external: true,
				cookie: await existingCookie(this.existingUrl),
				log: ""
			};
			await this.rpc(service, "session.list", {});
			this.services.set(service.serviceId, service);
			this.serviceByWorkspace.set(workspace, service.serviceId);
			return service;
		}
		const serviceId = randomUUID();
		const workspaceKey = createHash("sha256").update(workspace).digest("hex").slice(0, 24);
		const serviceHome = join(this.dataDirectory, "services", workspaceKey);
		await mkdir(serviceHome, {
			recursive: true,
			mode: 448
		});
		const command = this.commandFactory({
			workspace,
			serviceHome
		});
		const child = this.spawnProcess(command);
		const service = {
			serviceId,
			workspace,
			status: "starting",
			webUrl: null,
			browserOpened: false,
			browserError: null,
			startedAt: /* @__PURE__ */ new Date(),
			stoppedAt: null,
			child,
			log: ""
		};
		this.services.set(serviceId, service);
		this.serviceByWorkspace.set(workspace, serviceId);
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		const ready = new Promise((resolveReady, reject) => {
			const timer = setTimeout(() => reject(/* @__PURE__ */ new Error(`Harness Web service did not become ready within ${String(this.startupTimeoutMs)}ms.`)), this.startupTimeoutMs);
			const onChunk = (chunk) => {
				service.log = `${service.log}${chunk}`.slice(-1e5);
				const url = READY_PATTERN.exec(service.log)?.[1];
				if (url !== void 0 && service.status === "starting") {
					clearTimeout(timer);
					service.webUrl = url;
					service.status = "running";
					resolveReady();
				}
			};
			child.stdout?.on("data", onChunk);
			child.stderr?.on("data", onChunk);
			child.once("error", (error) => {
				clearTimeout(timer);
				service.status = "failed";
				reject(error);
			});
			child.once("close", (code, signal) => {
				clearTimeout(timer);
				service.stoppedAt = /* @__PURE__ */ new Date();
				if (service.status === "starting") {
					service.status = "failed";
					reject(/* @__PURE__ */ new Error(`Harness Web service exited before readiness (code ${String(code)}, signal ${String(signal)}). ${service.log}`));
				} else if (service.status === "running") service.status = code === 0 ? "stopped" : "failed";
			});
		});
		try {
			await ready;
			return service;
		} catch (error) {
			this.serviceByWorkspace.delete(workspace);
			if (child.exitCode === null) await this.terminate(service);
			service.status = "failed";
			throw error;
		}
	}
	async refresh(run) {
		if (run.status !== "running") return this.runSnapshot(run);
		const service = this.requireService(run.serviceId);
		if (service.status !== "running") {
			run.status = "failed";
			run.error = "Harness Web service stopped before the task completed.";
			run.finishedAt = /* @__PURE__ */ new Date();
			this.releaseSession(run);
			return this.runSnapshot(run);
		}
		try {
			const [list, history] = await Promise.all([this.rpc(service, "session.list", {}), this.rpc(service, "session.history", {
				sessionId: run.sessionId,
				maxMessages: 50
			})]);
			const summary = list.items.find((item) => item.sessionId === run.sessionId);
			const events = history.events.filter((entry) => entry.event.seq > run.startEventSeq).sort((a, b) => Number(a.event.seq) - Number(b.event.seq));
			if (!Number.isInteger(run.turnNumber)) {
				const turnStart = events.find((entry) => entry.event.type === "turn/start" && Number.isInteger(entry.event.data?.turn));
				if (turnStart) { run.turnNumber = turnStart.event.data.turn; run.turnStartSeq = Number(turnStart.event.seq); }
			}
			let turnEnd = null;
			if (Number.isInteger(run.turnNumber)) turnEnd = events.find((entry) => entry.event.type === "turn/end" && entry.event.data?.turn === run.turnNumber) ?? null;
			if (turnEnd) run.turnEndSeq = Number(turnEnd.event.seq);
			const lower = Number.isInteger(run.turnStartSeq) ? run.turnStartSeq : run.startEventSeq + 1;
			const upper = Number.isInteger(run.turnEndSeq) ? run.turnEndSeq : Number.POSITIVE_INFINITY;
			const runEvents = events.filter((entry) => Number(entry.event.seq) >= lower && Number(entry.event.seq) <= upper);
			run.lastEventSeq = runEvents.reduce((highest, entry) => Math.max(highest, Number(entry.event.seq)), run.lastEventSeq);
			run.assistantText = assistantText(runEvents);
			const agentError = [...runEvents].reverse().find((entry) => entry.event.type === "agent/error");
			const turnEnded = Boolean(turnEnd);
			if (agentError !== void 0) {
				run.status = "failed";
				run.error = recordText(agentError.event.data) ?? "DeepSeek Harness reported an agent error.";
				run.finishedAt = /* @__PURE__ */ new Date();
			} else if (run.cancelRequested && turnEnded) {
				run.status = "cancelled";
				run.finishedAt = /* @__PURE__ */ new Date();
			} else if (turnEnded) {
				run.status = "succeeded";
				run.finishedAt = /* @__PURE__ */ new Date();
			}
			if (run.status !== "running") {
				this.releaseSession(run);
				await this.persistRun(run, run.status === "succeeded" ? "COMPLETED" : run.status === "cancelled" ? "CANCELLED" : "FAILED");
			}
		} catch (error) {
			run.error = errorText(error);
		}
		return this.runSnapshot(run);
	}
	async rpc(service, method, payload) {
		if (service.webUrl === null) throw new Error("Harness Web service has no URL.");
		const remote = service.external && this.existingApi === "remote";
		if (remote && method === "session.history") {
			const request = payload;
			const summary = (await this.rpc(service, "session.list", {})).items.find((item) => item.sessionId === request.sessionId);
			if (!summary) throw new Error("Session is not visible in existing Harness.");
			const cursor = summary.projections?.asOfSeq;
			if (cursor === void 0) throw new Error("Existing Harness session projection does not expose a supported cursor.");
			return { events: (await this.rpc(service, "session.page", {
				address: {
					kind: "session",
					sessionId: request.sessionId
				},
				throughSeq: cursor,
				maxMessages: request.maxMessages ?? 50
			})).records.map((record) => record.event ? record : { event: record }) };
		}
		let endpoint = remote ? method.replace(".", "/") : method;
		let args = payload;
		if (remote && method === "session.prompt") {
			endpoint = "session/prompt";
			args = {
				...payload,
				requestId: randomUUID()
			};
		}
		if (service.external) service.cookie = await existingCookie(service.webUrl);
		const response = await fetch(`${service.webUrl}/api/${endpoint}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...service.cookie ? { cookie: service.cookie } : {}
			},
			body: JSON.stringify({
				type: "client-request",
				rpcId: `mcp-${randomUUID()}`,
				method: endpoint,
				payload: remote ? { args: method === "session.list" ? { _request: args } : { request: args } } : args
			}),
			signal: AbortSignal.timeout(15e3)
		});
		if (!response.ok) throw new Error(`${method} failed over HTTP ${String(response.status)}${response.status === 401 ? ": existing Harness authentication is required." : "."}`);
		const body = await response.json();
		if (!body.result.ok) throw new Error(`${method} failed: ${body.result.error.code}: ${body.result.error.message}`);
		return body.result.value;
	}
	async resolveWorkspace(input) {
		if (!isAbsolute(input)) throw new Error("workspace must be an absolute path.");
		const workspace = await realpath(input);
		if (!(await stat(workspace)).isDirectory()) throw new Error("workspace must point to a directory.");
		if (this.allowedRoots.length > 0) {
			if (!(await Promise.all(this.allowedRoots.map(async (root) => realpath(root)))).some((root) => isWithin(root, workspace))) throw new Error("workspace is outside DSH_MCP_WORKSPACE_ROOTS.");
		}
		return workspace;
	}
	serviceForWorkspace(workspace) {
		const id = this.serviceByWorkspace.get(workspace);
		const service = id === void 0 ? void 0 : this.services.get(id);
		return service?.status === "running" ? service : void 0;
	}
	requireService(serviceId) {
		const service = this.services.get(serviceId);
		if (service === void 0) throw new Error(`Unknown serviceId: ${serviceId}`);
		return service;
	}
	requireRun(runId) {
		const run = this.runs.get(runId);
		if (run === void 0) throw new Error(`Unknown runId: ${runId}`);
		return run;
	}
	releaseSession(run) {
		this.activeSessions.delete(`${run.serviceId}:${run.sessionId}`);
	}
	async terminate(service) {
		if (!service.child) {
			service.status = "stopped";
			service.stoppedAt = /* @__PURE__ */ new Date();
			this.serviceByWorkspace.delete(service.workspace);
			return;
		}
		if (service.child.exitCode !== null) return;
		const child = service.child;
		const closed = new Promise((resolveClose) => child.once("close", () => resolveClose()));
		if (process.platform !== "win32" && service.child.pid !== void 0) try {
			process.kill(-service.child.pid, "SIGTERM");
		} catch {
			service.child.kill("SIGTERM");
		}
		else service.child.kill("SIGTERM");
		await Promise.race([closed, new Promise((resolveWait) => setTimeout(resolveWait, CANCEL_GRACE_MS))]);
		if (service.child.exitCode === null) service.child.kill("SIGKILL");
		service.status = "stopped";
		service.stoppedAt = /* @__PURE__ */ new Date();
		this.serviceByWorkspace.delete(service.workspace);
	}
	serviceSnapshot(service) {
		return {
			serviceId: service.serviceId,
			workspace: service.workspace,
			status: service.status,
			webUrl: service.webUrl,
			browserOpened: service.browserOpened,
			browserError: service.browserError,
			startedAt: service.startedAt.toISOString(),
			stoppedAt: service.stoppedAt?.toISOString() ?? null,
			processId: service.child?.pid ?? null,
			logTail: service.log.slice(-4e3)
		};
	}
	runSnapshot(run) {
		return {
			runId: run.runId,
			durableRunId: run.durableRunId ?? null,
			taskId: run.taskId ?? null,
			executionLineageId: run.executionLineageId ?? "main",
			languageSyncMode: run.languageSyncMode ?? "AUTO",
			responseLocale: run.responseLocale ?? null,
			harnessRole: run.harnessRole ?? "WORKER",
			skillBindings: run.skillBindings ?? [],
			skillWarnings: run.skillWarnings ?? [],
			serviceId: run.serviceId,
			sessionId: run.sessionId,
			sessionReused: run.sessionReused,
			task: run.task,
			workspace: run.workspace,
			webUrl: run.webUrl,
			status: run.status,
			cancelRequested: run.cancelRequested,
			startedAt: run.startedAt.toISOString(),
			finishedAt: run.finishedAt?.toISOString() ?? null,
			assistantText: run.assistantText,
			turnNumber: run.turnNumber ?? null,
			turnStartSeq: run.turnStartSeq ?? null,
			turnEndSeq: run.turnEndSeq ?? null,
			lastEventSeq: run.lastEventSeq,
			contextSyncCapable: true,
			error: run.error,
			recoveredAt: run.recoveredAt?.toISOString() ?? null
		};
	}
};

//#endregion
//#region src/server.ts
const LOCAL_ADAPTER_VERSION = "0.3.1-toharness.10.1";
const RECOMMENDED_CODEX_TOOL_TIMEOUT_SEC = 3700;
const runIdSchema = z.string().uuid().describe("Run identifier returned by start_run.");
const serviceIdSchema = z.string().uuid().describe("Service identifier returned by start_service or start_run.");
function result(value) {
	const structuredContent = { ...value };
	return {
		content: [{
			type: "text",
			text: JSON.stringify(structuredContent)
		}],
		structuredContent
	};
}
function failure(error) {
	return {
		content: [{
			type: "text",
			text: error instanceof Error ? error.message : String(error)
		}],
		isError: true
	};
}
/** Creates the MCP tool surface over a local run manager. */
function createMcpServer(manager = new RunManager()) {
	const server = new McpServer({
		name: "deepseek-harness-for-codex",
		version: LOCAL_ADAPTER_VERSION
	}, { instructions: "Start the local DeepSeek Harness Web service, return a clickable session URL, submit coding tasks into visible Web sessions, then inspect workspace changes independently. Do not open the browser unless the user explicitly requests it." });
	server.registerTool("start_service", {
		title: "Start the local DeepSeek Harness Web UI",
		description: "Start or reuse a managed Harness service, or authenticate to DSH_MCP_EXISTING_URL when configured. Return its URL for an absolute workspace; never open a browser by default.",
		inputSchema: {
			workspace: z.string().min(1).describe("Absolute repository path served by DeepSeek Harness."),
			openBrowser: z.boolean().default(false).describe("Open the Harness page after readiness. Keep false unless the user explicitly requested it.")
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true
		}
	}, async (input) => {
		try {
			return result(await manager.startService(input));
		} catch (error) {
			return failure(error);
		}
	});
	server.registerTool("open_service", {
		title: "Open the DeepSeek Harness page",
		description: "Open an already running Harness Web service in the user's default browser.",
		inputSchema: { serviceId: serviceIdSchema },
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true
		}
	}, async (input) => {
		try {
			return result(await manager.openService(input.serviceId));
		} catch (error) {
			return failure(error);
		}
	});
	server.registerTool("list_services", {
		title: "List local DeepSeek Harness Web services",
		description: "List Web services started by the current MCP server and their visible URLs.",
		inputSchema: {},
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false
		}
	}, async () => result({ services: manager.listServices() }));
	server.registerTool("stop_service", {
		title: "Stop a DeepSeek Harness Web service",
		description: "Cancel active sessions and stop the local Harness Web service process.",
		inputSchema: { serviceId: serviceIdSchema },
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false
		}
	}, async (input) => {
		try {
			return result(await manager.stopService(input.serviceId));
		} catch (error) {
			return failure(error);
		}
	});
	server.registerTool("doctor", {
		title: "Check local DeepSeek Harness prerequisites",
		description: "Check Node, npx, runtime package, credentials visibility, data location, and workspace restrictions without downloading anything.",
		inputSchema: {},
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false
		}
	}, async () => result({
		...inspectRuntime(),
		adapterVersion: LOCAL_ADAPTER_VERSION,
		waitStrategy: "bridge-side-until-terminal",
		legacyWaitBehavior: "not-exposed",
		contextSyncStrategy: "cursor-delta-checkpoint",
		directHarnessUserOverride: "allowed-and-audited",
		recommendedCodexToolTimeoutSec: RECOMMENDED_CODEX_TOOL_TIMEOUT_SEC
	}));
	server.registerTool("start_run", {
		title: "Start a local DeepSeek Harness run",
		description: "Connect to Harness and submit a task. Supports runtime/role-scoped Skill forwarding by path or inline content; the Bridge durably records run/session identity, locale, and Skill binding metadata for recovery and audit.",
		inputSchema: {
			task: z.string().min(1).max(1e5).describe("Complete implementation task, constraints, and acceptance checks for DeepSeek Harness."),
			workspace: z.string().min(1).describe("Absolute path of the repository DeepSeek Harness may inspect and modify."),
			sessionId: z.string().min(1).optional().describe("Completed Harness session to continue. Pass a sessionId returned by an earlier run in this workspace, or omit it to create a new session."),
			taskId: z.string().min(1).max(256).optional().describe("Stable orchestrator TASK_ID used for durable recovery across Codex/Bridge restarts."),
			executionLineageId: z.string().min(1).max(256).optional().describe("Stable execution lineage within TASK_ID; defaults to main."),
			languageSyncMode: z.enum(["MIRROR_USER", "FIXED", "AUTO"]).default("MIRROR_USER").describe("Natural-language output policy. Router default is MIRROR_USER; AUTO is compatibility fallback only."),
			responseLocale: z.string().min(1).max(64).optional().describe("Resolved user-facing locale such as zh-CN or en. Required for MIRROR_USER/FIXED."),
			harnessRole: z.enum(["EXPLORER", "RESEARCHER", "WORKER", "INTEGRATOR", "TESTER", "REVIEWER", "CAPABILITY_BOOTSTRAP"]).default("WORKER").describe("Logical Harness role for role-scoped Skill forwarding."),
			skillInputs: z.array(z.object({
				id: z.string().min(1).max(128).describe("Stable Skill identifier."),
				target: z.enum(["HARNESS", "SHARED"]).default("HARNESS").describe("Runtime ownership. CODEX-only Skills must not be sent through this Bridge field."),
				sourceType: z.enum(["PATH", "INLINE"]).describe("PATH forwards a user-provided/materialized file; INLINE forwards pasted Skill text."),
				path: z.string().min(1).optional().describe("Absolute or workspace-relative Skill file path when sourceType=PATH."),
				content: z.string().min(1).max(SKILL_MAX_FILE_BYTES).optional().describe("Skill text when sourceType=INLINE."),
				transferMode: z.enum(["SNAPSHOT", "REFERENCE", "INLINE"]).optional().describe("SNAPSHOT hashes/caches and injects content; REFERENCE gives Harness a verified path; INLINE injects without cache. Omit for PATH→SNAPSHOT or INLINE→INLINE."),
				applyToRoles: z.array(z.string().min(1).max(64)).max(8).optional().describe("Role filter; omit or include ALL for every Harness role."),
				required: z.boolean().default(true).describe("Required Skill failure blocks the run; optional Skill failure is returned in skillWarnings."),
				expectedSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional().describe("Optional integrity pin."),
				externalPathApproved: z.boolean().default(false).describe("Set true only when the user explicitly supplied/approved a PATH outside workspace/allowed roots.")
			})).max(SKILL_MAX_COUNT).optional().describe("Harness/Shared Skill inputs. Codex should not send CODEX-only Skills here."),
			allowUnsyncedSession: z.boolean().default(false).describe("Emergency override only. Normal continuation MUST first import direct Harness activity with sync_session_delta + ack_session_sync."),
			openBrowser: z.boolean().default(false).describe("Open the live Harness Web page. Keep false unless the user explicitly requested it.")
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true
		}
	}, async (input) => {
		try {
			return result(await manager.start(input));
		} catch (error) {
			return failure(error);
		}
	});

	server.registerTool("list_persisted_sessions", {
		title: "List persisted DeepSeek Harness sessions",
		description: "List Harness sessions visible for a workspace so an existing Harness-first conversation can be explicitly adopted into Toharness without creating a new session.",
		inputSchema: { workspace: z.string().min(1), maxSessions: z.number().int().min(1).max(200).default(50) },
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
	}, async (input) => { try { return result(await manager.listPersistedSessions(input)); } catch (error) { return failure(error); } });
	server.registerTool("adopt_session", {
		title: "Adopt an existing Harness session",
		description: "Bind a Harness-first user session to a stable Task/lineage and create a durable sync cursor without resubmitting any prompt. After adoption, use sync_session_delta before Codex continues the task.",
		inputSchema: {
			workspace: z.string().min(1), sessionId: z.string().min(1), taskId: z.string().min(1).max(256).optional(), executionLineageId: z.string().min(1).max(256).default("main"),
			afterEventSeq: z.number().int().min(-1).optional().describe("Optional initial acknowledged cursor. Omit to import the existing session delta from the beginning or any previous adoption cursor."),
			controlOwner: z.enum(["CODEX", "HARNESS", "HARNESS_USER_OVERRIDE"]).default("HARNESS")
		},
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
	}, async (input) => { try { return result(await manager.adoptSession(input)); } catch (error) { return failure(error); } });

	server.registerTool("get_session_cursor", {
		title: "Read Harness session sync cursor",
		description: "Compare the durable Codex sync cursor with the current Harness session event cursor without importing conversation history.",
		inputSchema: { sessionId: z.string().min(1), workspace: z.string().min(1).optional() },
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
	}, async (input) => { try { return result(await manager.getSessionCursor(input)); } catch (error) { return failure(error); } });
	server.registerTool("list_unsynced_sessions", {
		title: "List Harness sessions with unsynchronized activity",
		description: "Find Toharness-bound Harness sessions whose durable event cursor advanced beyond Codex's acknowledged sync cursor. Use metadata-first before importing any delta.",
		inputSchema: { workspace: z.string().min(1), taskId: z.string().min(1).max(256).optional(), maxSessions: z.number().int().min(1).max(64).default(32) },
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
	}, async (input) => { try { return result(await manager.listUnsyncedSessions(input)); } catch (error) { return failure(error); } });
	server.registerTool("sync_session_delta", {
		title: "Import compact Harness session delta",
		description: "Return only Harness events after the last acknowledged sync cursor, deterministically compacted for Codex. This is the normal Harness→Codex context-return path after direct Web interaction.",
		inputSchema: {
			sessionId: z.string().min(1), workspace: z.string().min(1).optional(), afterEventSeq: z.number().int().min(-1).optional(),
			maxEvents: z.number().int().min(1).max(5000).default(500), maxChars: z.number().int().min(1000).max(24000).default(8000)
		},
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
	}, async (input) => { try { return result(await manager.sessionDelta(input)); } catch (error) { return failure(error); } });
	server.registerTool("read_session_events", {
		title: "Read bounded Harness session evidence",
		description: "On-demand evidence drilldown for a synchronized Harness session. Use only when the compact delta is insufficient; never reload the whole session by default.",
		inputSchema: {
			sessionId: z.string().min(1), workspace: z.string().min(1).optional(), afterEventSeq: z.number().int().min(-1).optional(),
			maxEvents: z.number().int().min(1).max(1000).default(100), maxChars: z.number().int().min(1000).max(40000).default(12000), includeToolEvents: z.boolean().default(false)
		},
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
	}, async (input) => { try { return result(await manager.readSessionEvents(input)); } catch (error) { return failure(error); } });
	server.registerTool("ack_session_sync", {
		title: "Acknowledge imported Harness context delta",
		description: "Advance the durable Harness→Codex sync cursor after Codex has incorporated the delta. May also record control ownership and user-authorized override review state; acknowledgement is not task PASS.",
		inputSchema: {
			sessionId: z.string().min(1), workspace: z.string().min(1).optional(), throughEventSeq: z.number().int().min(-1).optional(),
			controlOwner: z.enum(["CODEX", "HARNESS", "HARNESS_USER_OVERRIDE"]).optional(),
			overrideReviewState: z.enum(["NONE", "PENDING", "ACCEPTED", "ACCEPTED_WITH_NORMALIZATION", "REVISED"]).optional(),
			decisionClasses: z.array(z.enum(["LOCAL_EXECUTION", "DIRECTIONAL_DECISION", "SYSTEM_DECISION"])).max(8).optional()
		},
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
	}, async (input) => { try { return result(await manager.acknowledgeSessionSync(input)); } catch (error) { return failure(error); } });

	server.registerTool("list_durable_runs", {
		title: "List durable DeepSeek Harness runs",
		description: "List process-independent Task→Run→Session mappings persisted by the Bridge. Use this after Codex/Bridge restart instead of relying on process-local list_runs.",
		inputSchema: {
			workspace: z.string().min(1).optional(), taskId: z.string().min(1).max(256).optional(),
			executionLineageId: z.string().min(1).max(256).optional(), includeTerminal: z.boolean().default(true)
		},
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
	}, async (input) => { try { return result({ runs: await manager.listDurable(input) }); } catch (error) { return failure(error); } });
	server.registerTool("recover_run", {
		title: "Recover a durable DeepSeek Harness run",
		description: "Reattach to an in-progress or completed Harness session without resubmitting the task; reconstruct the original result from persisted events.",
		inputSchema: {
			durableRunId: z.string().uuid().optional(), runId: runIdSchema.optional(), taskId: z.string().min(1).max(256).optional(),
			executionLineageId: z.string().min(1).max(256).optional(), workspace: z.string().min(1).optional()
		},
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
	}, async (input) => { try { return result(await manager.recover(input)); } catch (error) { return failure(error); } });
	server.registerTool("recover_pending_runs", {
		title: "Recover detached DeepSeek Harness runs",
		description: "After Codex/Bridge restart, reattach durable active runs and terminal results not yet acknowledged by Codex. Running tasks stay running; completed tasks are reconstructed without another prompt.",
		inputSchema: {
			workspace: z.string().min(1), taskId: z.string().min(1).max(256).optional(), executionLineageId: z.string().min(1).max(256).optional(),
			maxRuns: z.number().int().min(1).max(32).default(16)
		},
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
	}, async (input) => { try { return result(await manager.recoverPending(input)); } catch (error) { return failure(error); } });
	server.registerTool("ack_run", {
		title: "Acknowledge a durable Harness run result",
		description: "Mark a durable run as delivered to Codex after its terminal result has been ingested. This is not PASS/approval; it only prevents needless redelivery after restart.",
		inputSchema: {
			durableRunId: z.string().uuid().optional(), runId: runIdSchema.optional(), taskId: z.string().min(1).max(256).optional(),
			executionLineageId: z.string().min(1).max(256).optional(), workspace: z.string().min(1).optional()
		},
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
	}, async (input) => { try { return result(await manager.acknowledgeRun(input)); } catch (error) { return failure(error); } });
	server.registerTool("get_run", {
		title: "Read a DeepSeek Harness run",
		description: "Read the current state and assistant response from the same Harness Web session shown to the user.",
		inputSchema: { runId: runIdSchema },
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false
		}
	}, async (input) => {
		try {
			return result(await manager.get(input.runId));
		} catch (error) {
			return failure(error);
		}
	});
	server.registerTool("wait_run_until_terminal", {
		title: "Long-wait for a DeepSeek Harness run",
		description: "Keep polling inside the local Bridge, without re-entering Codex, until the Harness run is terminal or maxWaitSeconds expires. Prefer this after start_run for normal delegated work; use wait_run only for short diagnostics or compatibility fallback.",
		inputSchema: {
			runId: runIdSchema,
			maxWaitSeconds: z.number().int().min(1).max(3600).default(900).describe("Maximum Bridge-side wait. The Bridge polls Harness internally; Codex is not re-entered during this wait."),
			pollIntervalMs: z.number().int().min(250).max(10000).default(1000).describe("Bridge-to-Harness polling interval. This does not create Codex model turns.")
		},
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false
		}
	}, async (input) => {
		try {
			return result(await manager.waitUntilTerminal(input.runId, input.maxWaitSeconds * 1e3, input.pollIntervalMs));
		} catch (error) {
			return failure(error);
		}
	});
	server.registerTool("wait_runs_until_terminal", {
		title: "Long-wait for multiple DeepSeek Harness runs",
		description: "Keep polling a bounded set of runs inside the local Bridge until all are terminal or the deadline expires. Use this for parallel Task Graph branches instead of waking Codex to poll each run separately.",
		inputSchema: {
			runIds: z.array(runIdSchema).min(1).max(32),
			maxWaitSeconds: z.number().int().min(1).max(3600).default(900),
			pollIntervalMs: z.number().int().min(250).max(10000).default(1000)
		},
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false
		}
	}, async (input) => {
		try {
			return result(await manager.waitManyUntilTerminal(input.runIds, input.maxWaitSeconds * 1e3, input.pollIntervalMs));
		} catch (error) {
			return failure(error);
		}
	});
	server.registerTool("list_runs", {
		title: "List local DeepSeek Harness runs",
		description: "List runs attached to the current MCP server process. For restart recovery use list_durable_runs/recover_run; process-local list_runs is not a durable index.",
		inputSchema: {},
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false
		}
	}, async () => result({ runs: await manager.list() }));
	server.registerTool("cancel_run", {
		title: "Cancel a local DeepSeek Harness run",
		description: "Cancel the agent turn in its visible Web session while keeping the Harness Web UI running.",
		inputSchema: { runId: runIdSchema },
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false
		}
	}, async (input) => {
		try {
			return result(await manager.cancel(input.runId));
		} catch (error) {
			return failure(error);
		}
	});
	return server;
}

//#endregion
//#region src/bin.ts
const manager = new RunManager();
const server = createMcpServer(manager);
const transport = new StdioServerTransport();
let closing = false;
async function close() {
	if (closing) return;
	closing = true;
	await manager.close();
	await server.close();
}
server.server.onclose = () => void manager.close();
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
process.once("SIGHUP", () => void close());
process.once("beforeExit", () => void manager.close());
try {
	await server.connect(transport);
} catch (error) {
	console.error(error instanceof Error ? error.stack ?? error.message : String(error));
	process.exitCode = 1;
}

//#endregion
export {  };