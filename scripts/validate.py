#!/usr/bin/env python3
from __future__ import annotations
import hashlib, json, re, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
errors: list[str] = []
warnings: list[str] = []

def fail(msg: str): errors.append(msg)
def warn(msg: str): warnings.append(msg)

def read(rel: str) -> str:
    p = ROOT / rel
    if not p.is_file():
        fail(f"missing file: {rel}")
        return ""
    return p.read_text(encoding="utf-8")

skill = read("SKILL.md")
readme = read("README.md")
manifest = read("references/MANIFEST.md")
compat_text = read("references/compatibility.json")
try:
    compat = json.loads(compat_text)
except Exception as e:
    compat = {}
    fail(f"invalid compatibility.json: {e}")

m = re.search(r"^version:\s*([0-9]+(?:\.[0-9]+)?)\s*$", skill, re.M)
version = m.group(1) if m else None
if version != "10.1": fail(f"SKILL version must be 10.1, got {version}")
if "v10.1" not in readme.lower(): fail("README must identify v10.1")
if re.search(r"\bv7\b|v6 modularized", skill + "\n" + readme, re.I): fail("stale v6/v7 marker in primary metadata")
if compat.get("orchestratorVersion") != version: fail("compatibility orchestratorVersion does not match SKILL version")

# Reference existence from the kernel.
for ref in sorted(set(re.findall(r"references/([A-Za-z0-9_.-]+\.(?:md|json))", skill))):
    if not (ROOT / "references" / ref).is_file(): fail(f"SKILL references missing module: references/{ref}")

required = [
    "references/context-resolution.md", "references/task-intake.md", "references/risk-policy.md",
    "references/bridge.md", "references/capability-resolution.md", "references/capability-bootstrap.md",
    "references/contracts.md", "references/session-affinity.md", "references/durable-run-recovery.md", "references/bidirectional-context-sync.md", "references/decision-authority.md", "references/skill-routing.md", "references/skill-file-spec.md", "references/roles-task-graph.md", "references/verification-review.md",
    "references/telemetry.md", "references/governance.md", "references/compatibility.json",
    "references/existing-harness-bridge.md", "references/bootstrap.md",
    "scripts/bootstrap.ps1", "scripts/install-existing-bridge.ps1", "scripts/skill_view.py",
    "vendor/deepseek-harness-for-codex/package.json", "vendor/deepseek-harness-for-codex/package-lock.json", "vendor/deepseek-harness-for-codex/dist/bin.mjs",
    "vendor/deepseek-harness-for-codex/verify.mjs", "vendor/deepseek-harness-for-codex/PROVENANCE.md", "vendor/deepseek-harness-for-codex/VENDOR_MANIFEST.json",
    "assets/bridge/package.json", "assets/bridge/dist/bin.mjs",
    "templates/cross-runtime-skill.template.md",
]
for rel in required:
    if not (ROOT / rel).is_file(): fail(f"required package file missing: {rel}")

# No machine-specific runtime history in source docs.
history = read("references/existing-harness-bridge.md")
for pat, label in [
    (r"\b20\d{2}-\d{2}-\d{2}\b", "dated runtime history"),
    (r"\brun[_-]?[A-Za-z0-9]{6,}\b", "run id"),
    (r"\bsession[_-]?[A-Za-z0-9]{6,}\b", "session id"),
    (r"agent协同", "machine/project-specific path marker"),
]:
    if re.search(pat, history, re.I): fail(f"existing-harness-bridge contains {label}")

# Bridge package compatibility consistency.
try:
    pkg = json.loads(read("vendor/deepseek-harness-for-codex/package.json"))
    lock = json.loads(read("vendor/deepseek-harness-for-codex/package-lock.json"))
    adapter = compat.get("bridge", {}).get("adapterVersion")
    if pkg.get("version") != adapter: fail("bridge package version != compatibility bridge.adapterVersion")
    if lock.get("version") != adapter: fail("bridge package-lock version != compatibility bridge.adapterVersion")
except Exception as e:
    fail(f"invalid bridge package metadata: {e}")

bin_text = read("vendor/deepseek-harness-for-codex/dist/bin.mjs")
if adapter and adapter not in bin_text:
    fail("MCP server runtime version does not expose compatibility bridge.adapterVersion")
provision = compat.get("harness", {}).get("defaultProvisionPackage")
if provision and provision not in bin_text: fail("bundled bridge default Harness package does not match compatibility manifest")
if "@deepseek-ai/dsh@0.1.0-rc.6" in bin_text: fail("stale upstream Harness default remains in bundled bridge")
if "npm install --prefix $harnessRuntime" in read("scripts/bootstrap.ps1") and "$harnessPackage" not in read("scripts/bootstrap.ps1"):
    fail("bootstrap Harness install is not manifest-pinned")

# Required bridge states.
for state in ["BRIDGE_READY", "BRIDGE_MISSING", "BRIDGE_RESTART_REQUIRED", "BRIDGE_AUTH_REQUIRED", "BRIDGE_BROKEN", "BRIDGE_BLOCKED"]:
    if state not in skill: fail(f"missing bridge state in kernel: {state}")

# Bootstrap approval/transaction gates.
boot = read("scripts/bootstrap.ps1")
install = read("scripts/install-existing-bridge.ps1")
for flag in ["ApproveSystemInstall", "ApproveNetworkInstall", "ApproveConfigMutation", "ApproveDisableConflictingPlugin"]:
    if flag not in boot: fail(f"bootstrap missing approval gate: {flag}")
if "RollbackTransaction" not in install or "Restore-Transaction" not in install:
    fail("config installer lacks explicit rollback path")
if "compatibility.json" not in boot: fail("bootstrap does not read compatibility manifest")
if re.search(r"npm\s+install[^\n]*['\"]?@deepseek-ai/dsh['\"]?(?:\s|$)", boot, re.I):
    fail("bootstrap contains floating @deepseek-ai/dsh install")


# CODEX_HOME resolution regression guard.
if "Resolve-CodexHome" not in boot or "resolvedCodexHome" not in boot or "codexHomeSource" not in boot:
    fail("bootstrap lacks deterministic CODEX_HOME resolution/reporting")
if "Invoke-CodexWithHome" not in boot:
    fail("bootstrap does not force Codex CLI to use the resolved CODEX_HOME")
if "[string]$CodexHome" not in boot:
    fail("bootstrap lacks explicit -CodexHome override")
if "[string]$CodexHome" not in install or "Invoke-CodexWithHome" not in install:
    fail("bridge installer does not share the resolved CODEX_HOME with Codex CLI")
if "TOHARNESS_CODEX_HOME" not in read("vendor/deepseek-harness-for-codex/verify.mjs"):
    fail("verify.mjs does not propagate the resolved CODEX_HOME through TOHARNESS_CODEX_HOME")
if "MCP_TOOL_TIMEOUT" not in boot or "BRIDGE_ADAPTER_OUTDATED" not in boot:
    fail("CheckOnly does not distinguish stale Bridge/host timeout from missing registration")
if "-not $currentRegistration -or" not in boot:
    fail("CheckOnly config-mutation gate does not preserve reuse of a current healthy registration")

# Session affinity / continuity guards.
session_policy = read("references/session-affinity.md")
contracts = read("references/contracts.md")
verification = read("references/verification-review.md")
roles = read("references/roles-task-graph.md")
for token in ["HARNESS_SESSION_POLICY", "REUSE", "NEW", "FRESH", "EXECUTION_LINEAGE_ID", "Session Ledger", "sessionReused"]:
    if token not in session_policy and token not in skill:
        fail(f"session affinity policy missing token: {token}")
if "references/session-affinity.md" not in skill:
    fail("kernel does not progressively load session-affinity.md")
for token in ["EXECUTION_LINEAGE_ID", "HARNESS_SESSION_POLICY"]:
    if token not in contracts:
        fail(f"contracts missing session field: {token}")
if "Fresh Reviewer" not in session_policy or "FRESH" not in roles:
    fail("fresh reviewer session isolation is not enforced")
if "SESSION_CONTINUITY_BROKEN" not in session_policy or "SESSION_CONTINUITY_BROKEN" not in verification:
    fail("continuity break is not connected to verification")
durable_recovery = read("references/durable-run-recovery.md")
for token in ["list_durable_runs", "recover_run", "recover_pending_runs", "DETACHED_RUNNING", "START_EVENT_SEQ"]:
    if token not in durable_recovery and token not in bin_text:
        fail(f"durable recovery missing token: {token}")
if "references/durable-run-recovery.md" not in skill:
    fail("kernel does not progressively load durable-run-recovery.md")
if "sessionId" not in bin_text or "sessionReused" not in bin_text:
    fail("bundled bridge does not expose Harness session continuation metadata")
if "Pass a sessionId returned by an earlier run" not in bin_text:
    fail("bundled bridge start_run schema no longer documents session continuation")
for token in ["wait_run_until_terminal", "wait_runs_until_terminal", "waitUntilTerminal", "waitManyUntilTerminal", "waitTimedOut"]:
    if token not in bin_text:
        fail(f"bundled bridge missing long-poll capability: {token}")
if 'registerTool("wait_run"' in bin_text:
    fail("local Bridge still exposes legacy wait_run to Codex")
if "recommendedCodexToolTimeoutSec" not in bin_text or "3700" not in bin_text:
    fail("Bridge doctor does not advertise the required Codex MCP tool timeout")
bootstrap_ps1 = read("scripts/bootstrap.ps1")
install_ps1 = read("scripts/install-existing-bridge.ps1")
for token in ["MCP_TOOL_TIMEOUT", "BRIDGE_ADAPTER_OUTDATED", "requiredCodexToolTimeoutSec"]:
    if token not in bootstrap_ps1:
        fail(f"bootstrap precheck missing host-wait guard: {token}")
for token in ["tool_timeout_sec", "3700", "Ensure-McpToolTimeout"]:
    if token not in install_ps1:
        fail(f"installer missing Codex MCP timeout enforcement: {token}")
if "wait_run_until_terminal" not in skill or "wait_run_until_terminal" not in verification:
    fail("router execution policy does not prefer Bridge-side long-poll")
if "wait_run → get_run" in skill:
    fail("kernel still documents legacy wait_run as the normal execution path")
verify_js = read("vendor/deepseek-harness-for-codex/verify.mjs")
if "wait_run_until_terminal" not in verify_js:
    fail("bootstrap verification still wakes the client with repeated short wait_run calls")
if "toolNames.has('wait_run')" not in verify_js or compat.get("bridge", {}).get("adapterVersion", "") not in verify_js:
    fail("bootstrap verification does not reject stale Bridge tool catalogs")
if "list_durable_runs" not in verify_js or "ack_run" not in verify_js:
    fail("bootstrap verification does not exercise durable run ledger/acknowledgement")
for token in ["list_durable_runs", "recover_run", "recover_pending_runs", "ack_run", "durableRunId", "durable-runs.json", "DETACHED_RUNNING", "UNACKNOWLEDGED", "ACKNOWLEDGED"]:
    if token not in bin_text:
        fail(f"bundled bridge missing durable recovery capability: {token}")
if "taskId" not in bin_text or "executionLineageId" not in bin_text:
    fail("start_run does not persist orchestrator task/lineage identity")
if "recover_pending_runs" not in read("references/bridge.md") or "durable-run-recovery.md" not in read("references/MANIFEST.md"):
    fail("Bridge/module routing does not expose restart recovery")
if "ack_run" not in read("references/durable-run-recovery.md"):
    fail("durable result delivery acknowledgement is not documented")
if "Explicit stop_service/cancel_run are the only cancellation paths" not in bin_text:
    fail("Bridge close semantics may still cancel detached tasks")

# V10 bidirectional context sync / user override guards.
bidi = read("references/bidirectional-context-sync.md")
auth = read("references/decision-authority.md")
for token in ["Bidirectional Context Sync", "get_session_cursor", "sync_session_delta", "ack_session_sync", "lastSyncedEventSeq", "CONTEXT_CHECKPOINT"]:
    if token not in bidi and token not in skill:
        fail(f"bidirectional context sync missing token: {token}")
for token in ["HARNESS_USER_OVERRIDE", "CONTROL_OWNER", "LOCAL_EXECUTION", "DIRECTIONAL_DECISION", "SYSTEM_DECISION", "ACCEPT_WITH_NORMALIZATION"]:
    if token not in auth and token not in skill:
        fail(f"decision authority missing token: {token}")
if "references/bidirectional-context-sync.md" not in skill or "references/decision-authority.md" not in skill:
    fail("kernel does not progressively load V10 context-sync/decision-authority modules")
for token in ["list_persisted_sessions", "adopt_session", "get_session_cursor", "list_unsynced_sessions", "sync_session_delta", "read_session_events", "ack_session_sync", "session-sync.json", "SESSION_SYNC_REQUIRED"]:
    if token not in bin_text:
        fail(f"bundled bridge missing V10 context-sync capability: {token}")
for token in ["sessionSync", "lastSyncedEventSeq", "controlOwner", "overrideReviewState"]:
    if token not in bin_text:
        fail(f"V10 session sync ledger missing field: {token}")
if "allowUnsyncedSession" not in bin_text:
    fail("start_run lacks explicit unsynced-session emergency override gate")
for token in ["turnNumber", "turnStartSeq", "turnEndSeq", "turn/start", "turn/end"]:
    if token not in bin_text:
        fail(f"V10 run boundary is not isolated to a Harness turn: {token}")
if "Cross-Runtime Context Sync" not in bin_text or "CONTEXT_CHECKPOINT" not in bin_text:
    fail("Harness execution prompt lacks V10 checkpoint/context-return directive")
if "acknowledgeSessionSyncInternal" not in bin_text or "acknowledgeRun" not in bin_text:
    fail("run acknowledgement is not connected to session sync cursor")
for feature in ["bidirectional-context-sync", "session-cursor-delta-sync", "harness-first-session-adoption", "direct-harness-user-override", "control-owner-audit", "checkpoint-assisted-context-return"]:
    if feature not in compat_text:
        fail(f"compatibility manifest does not declare V10 feature: {feature}")
for token in ["list_persisted_sessions", "adopt_session", "sync_session_delta", "ack_session_sync"]:
    if token not in verify_js:
        fail(f"bootstrap verifier does not require V10 tool: {token}")
if "session-sync.json" not in bidi:
    fail("V10 sync ledger filename is not documented")
if "HARNESS_USER_OVERRIDE" not in verification or "CONTEXT_CONTINUITY_BROKEN" not in verification:
    fail("V10 override/context continuity is not connected to verification")
if "SESSION_SYNC_REQUIRED" not in session_policy:
    fail("Session Affinity does not enforce sync-before-reuse")
if "CONTROL_OWNER" not in contracts or "CONTEXT_SYNC_STATE" not in contracts:
    fail("Contracts do not carry V10 control/sync state")

# Language affinity / locale sync guards.
language_affinity = read("references/language-affinity.md")
for token in ["LANGUAGE_SYNC_MODE", "MIRROR_USER", "FIXED", "AUTO", "RESPONSE_LOCALE", "LANGUAGE_AFFINITY_BROKEN"]:
    if token not in language_affinity and token not in skill:
        fail(f"language affinity missing token: {token}")
if "references/language-affinity.md" not in skill:
    fail("kernel does not progressively load language-affinity.md")
for token in ["LANGUAGE_SYNC_MODE", "RESPONSE_LOCALE"]:
    if token not in contracts:
        fail(f"contracts missing language field: {token}")
for token in ["languageSyncMode", "responseLocale", "taskWithLanguagePolicy", "Language Affinity"]:
    if token not in bin_text:
        fail(f"bundled bridge missing language sync capability: {token}")
if "responseLocale is required when languageSyncMode is MIRROR_USER or FIXED" not in bin_text:
    fail("bridge can silently lose locale for MIRROR_USER/FIXED")
if "languageSyncMode: run.languageSyncMode" not in bin_text or "responseLocale: run.responseLocale" not in bin_text:
    fail("durable ledger does not persist language affinity metadata")
if "languageSyncMode: record.languageSyncMode" not in bin_text or "responseLocale: record.responseLocale" not in bin_text:
    fail("durable recovery does not restore language affinity metadata")
if "languageSyncMode: 'FIXED'" not in verify_js or "responseLocale: 'zh-CN'" not in verify_js:
    fail("bootstrap verifier does not exercise Bridge language affinity")
if "language-affinity-locale-sync" not in compat_text:
    fail("compatibility manifest does not declare language affinity feature")

# Skill Routing / file-forwarding guards.
skill_routing = read("references/skill-routing.md")
skill_file_spec = read("references/skill-file-spec.md")
for token in ["SKILL_TARGET", "CODEX", "HARNESS", "SHARED", "SKILL_TRANSFER_MODE", "SNAPSHOT", "REFERENCE", "INLINE", "SKILL_ASSIGNMENT"]:
    if token not in skill_routing and token not in skill:
        fail(f"skill routing missing token: {token}")
if "references/skill-routing.md" not in skill or "references/skill-file-spec.md" not in skill:
    fail("kernel does not progressively load Skill Routing / Skill File Spec")
for token in ["SKILL_ASSIGNMENT", "skill-routing.md"]:
    if token not in contracts:
        fail(f"contracts missing Skill Assignment integration: {token}")
for token in ["skillInputs", "harnessRole", "prepareSkillInputs", "skillBindings", "skillWarnings", "Skill Routing / Skill Affinity", "expectedSha256", "externalPathApproved"]:
    if token not in bin_text:
        fail(f"bundled bridge missing Skill forwarding capability: {token}")
for token in ["SKILL_MAX_COUNT", "SKILL_MAX_FILE_BYTES", "SKILL_MAX_INJECTED_BYTES"]:
    if token not in bin_text:
        fail(f"bundled bridge missing Skill budget guard: {token}")
if 'target: z.enum(["HARNESS", "SHARED"])' not in bin_text:
    fail("Bridge skillInputs must reject CODEX-only Skills")
if "skillBindings: run.skillBindings" not in bin_text or "skillBindings: record.skillBindings" not in bin_text:
    fail("Durable run metadata does not persist/restore Skill bindings")
if "skillInputs:" not in verify_js or "bootstrap-readonly-probe" not in verify_js:
    fail("bootstrap verifier does not exercise Skill forwarding")
if "SKILL_AFFINITY_BROKEN" not in verification:
    fail("Skill binding mismatch is not connected to verification")
if "SKILLS" not in roles or "harnessRole" not in roles:
    fail("Task Graph nodes are not connected to role-scoped Skill routing")
for feature in ["skill-affinity-routing", "skill-file-forwarding", "role-scoped-skill-inputs", "skill-snapshot-integrity"]:
    if feature not in compat_text:
        fail(f"compatibility manifest does not declare Skill feature: {feature}")
template = read("templates/cross-runtime-skill.template.md")
for token in ["cross-runtime-skill/v1", "[SHARED]", "[CODEX]", "[HARNESS]", "[ROLE:WORKER]", "[ROLE:TESTER]"]:
    if token not in template:
        fail(f"cross-runtime Skill template missing token: {token}")

# Scoped Skill view helper must keep Codex execution context clean.
try:
    sv = subprocess.run([sys.executable, str(ROOT/"scripts/skill_view.py"), "--file", str(ROOT/"templates/cross-runtime-skill.template.md"), "--target", "codex"], capture_output=True, text=True, timeout=10)
    if sv.returncode != 0:
        fail(f"skill_view.py codex view failed: {sv.stderr.strip()}")
    else:
        if "[CODEX]" not in sv.stdout or "[SHARED]" not in sv.stdout:
            fail("skill_view.py codex view omits required CODEX/SHARED scopes")
        if "[HARNESS]" in sv.stdout or "[ROLE:WORKER]" in sv.stdout:
            fail("skill_view.py codex view leaks Harness execution scopes")
except Exception as e:
    fail(f"skill_view.py validation failed: {e}")

# Secret-like values: detect obvious assignments, excluding placeholders/docs.
for rel in ["SKILL.md"] + [str(p.relative_to(ROOT)) for p in (ROOT/"references").glob("*.md")]:
    txt = read(rel)
    if re.search(r"(?i)(api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*['\"]?[A-Za-z0-9_\-]{20,}", txt):
        fail(f"possible embedded secret in {rel}")

# JS syntax checks when node is available.
try:
    r = subprocess.run(["node", "--version"], capture_output=True, text=True, timeout=5)
    if r.returncode == 0:
        for rel in ["vendor/deepseek-harness-for-codex/dist/bin.mjs", "vendor/deepseek-harness-for-codex/verify.mjs"]:
            c = subprocess.run(["node", "--check", str(ROOT/rel)], capture_output=True, text=True, timeout=15)
            if c.returncode != 0: fail(f"node syntax failed for {rel}: {c.stderr.strip()}")
    else: warn("node unavailable; JS syntax checks skipped")
except Exception:
    warn("node unavailable; JS syntax checks skipped")

# Provenance hash check.
prov = read("vendor/deepseek-harness-for-codex/PROVENANCE.md")
mh = re.search(r"dist/bin\.mjs SHA256:\s*`([a-f0-9]{64})`", prov, re.I)
if mh:
    actual = hashlib.sha256((ROOT/"vendor/deepseek-harness-for-codex/dist/bin.mjs").read_bytes()).hexdigest()
    if actual.lower() != mh.group(1).lower(): fail("PROVENANCE dist/bin.mjs SHA256 mismatch")
else:
    fail("PROVENANCE missing dist/bin.mjs SHA256")



if compat.get("orchestratorName") != "Toharness":
    fail("compatibility manifest orchestratorName is not Toharness")

# V10.1 embedded vendored runtime integrity.
try:
    vm = json.loads(read("vendor/deepseek-harness-for-codex/VENDOR_MANIFEST.json"))
    if vm.get("adapterVersion") != compat.get("bridge", {}).get("adapterVersion"):
        fail("vendor manifest adapterVersion != compatibility adapterVersion")
    if vm.get("upstream", {}).get("baseVersion") != compat.get("bridge", {}).get("upstreamBaseVersion"):
        fail("vendor manifest upstream base != compatibility upstreamBaseVersion")
    vh = vm.get("hashes", {}).get("dist/bin.mjs")
    actual_vendor = hashlib.sha256((ROOT/"vendor/deepseek-harness-for-codex/dist/bin.mjs").read_bytes()).hexdigest()
    if vh != actual_vendor:
        fail("vendor runtime hash mismatch")
    mirror = ROOT/"assets/bridge/dist/bin.mjs"
    if mirror.exists() and hashlib.sha256(mirror.read_bytes()).hexdigest() != actual_vendor:
        fail("assets/bridge compatibility mirror diverges from canonical vendor runtime")
except Exception as e:
    fail(f"invalid vendored runtime manifest: {e}")
boot_text = read("scripts/bootstrap.ps1")
if "vendor\\deepseek-harness-for-codex" not in boot_text or "usingCanonicalVendoredRuntime" not in boot_text:
    fail("bootstrap does not prefer canonical vendored runtime")

if "toharness-public-skill-identity" not in compat.get("bridge", {}).get("localFeatures", []):
    fail("compatibility manifest does not declare Toharness public identity")

# Toharness public identity / migration guards.
if "name: Toharness" not in skill:
    fail("public Skill name is not Toharness")
if "# Toharness / Capability Orchestrator" not in skill:
    fail("kernel title is not branded Toharness")
if "# Toharness v10" not in read("README.md"):
    fail("README is not branded Toharness v10")
if "name: model-router" in skill or "# model-router" in read("README.md"):
    fail("stale model-router public Skill identity remains")
if "TOHARNESS_CODEX_HOME" not in verify_js or "MODEL_ROUTER_CODEX_HOME" not in verify_js:
    fail("Toharness verifier must support new env identity plus legacy model-router migration fallback")
if "runtimes\\toharness-bridge" not in boot or "runtimes\\model-router-bridge" not in boot:
    fail("bootstrap does not support Toharness runtime path with legacy model-router migration fallback")

print(json.dumps({"status":"PASS" if not errors else "FAILED", "errors":errors, "warnings":warnings}, ensure_ascii=False, indent=2))
sys.exit(1 if errors else 0)
