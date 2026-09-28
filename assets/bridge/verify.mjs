import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { writeFile, unlink, realpath } from 'node:fs/promises';
import path from 'node:path';

const workspace = await realpath(process.argv[2] || process.cwd());
const codexEnv = { ...process.env };
const resolvedCodexHome = process.env.TOHARNESS_CODEX_HOME || process.env.MODEL_ROUTER_CODEX_HOME;
if (resolvedCodexHome) codexEnv.CODEX_HOME = resolvedCodexHome;
const configuration = spawnSync(process.env.TOHARNESS_CODEX_COMMAND || process.env.MODEL_ROUTER_CODEX_COMMAND || 'codex', ['mcp', 'get', 'deepseek-harness', '--json'], { encoding: 'utf8', env: codexEnv });
if (configuration.status !== 0) throw new Error('Cannot read registered deepseek-harness MCP configuration.');
const registered = JSON.parse(configuration.stdout).transport;
const filename = `.toharness-probe-${randomUUID()}.txt`;
const taskId = `bootstrap-${randomUUID()}`;
const probe = path.join(workspace, filename);
const content = `Toharness bootstrap verification ${randomUUID()}\n`;
const expected = createHash('sha256').update(content).digest('hex');
const client = new Client({ name: 'toharness-bootstrap-verifier', version: '1.0.0' });
const transport = new StdioClientTransport({ command: registered.command, args: registered.args,
  env: { ...process.env, ...registered.env, DSH_MCP_WORKSPACE_ROOTS: workspace }, stderr: 'pipe' });
let activeRun;
let report;
await writeFile(probe, content, { flag: 'wx' });
try {
  await client.connect(transport);
  const catalog = await client.listTools();
  const toolNames = new Set((catalog.tools || []).map((tool) => tool.name));
  if (!toolNames.has('wait_run_until_terminal')) throw new Error('Registered Bridge does not expose wait_run_until_terminal.');
  if (toolNames.has('wait_run')) throw new Error('Registered Bridge still exposes legacy wait_run; stale or conflicting adapter is active.');
  for (const requiredTool of ['get_session_cursor','list_unsynced_sessions','sync_session_delta','ack_session_sync','list_persisted_sessions','adopt_session']) {
    if (!toolNames.has(requiredTool)) throw new Error(`Registered Bridge is missing V10 context-sync tool: ${requiredTool}`);
  }
  const health = await client.callTool({ name: 'doctor', arguments: {} });
  if (!health.structuredContent?.ready) throw new Error('doctor is not ready.');
  if (health.structuredContent?.adapterVersion !== '0.3.1-toharness.10.1') throw new Error(`Unexpected Bridge adapter version: ${health.structuredContent?.adapterVersion || 'unknown'}`);
  if ((health.structuredContent?.recommendedCodexToolTimeoutSec || 0) < 3700) throw new Error('Bridge doctor did not advertise the required Codex MCP tool timeout.');
  const skillContent = `---\nskill_schema: cross-runtime-skill/v1\nname: bootstrap-readonly-probe\nversion: 1\ndefault_target: HARNESS\n---\n\n## [HARNESS]\n本次验收只允许读取指定探针文件并计算 SHA256；不得修改其他文件，不得安装依赖。\n\n## [ROLE:TESTER]\n必须用实际工具验证工作目录和文件摘要，不得猜测。\n`;
  const skillSha256 = createHash('sha256').update(skillContent).digest('hex');
  const start = await client.callTool({ name: 'start_run', arguments: { workspace, openBrowser: false, taskId, executionLineageId: 'bootstrap-verify', languageSyncMode: 'FIXED', responseLocale: 'zh-CN', harnessRole: 'TESTER',
    skillInputs: [{ id: 'bootstrap-readonly-probe', target: 'HARNESS', sourceType: 'INLINE', transferMode: 'INLINE', applyToRoles: ['TESTER'], required: true, content: skillContent, expectedSha256: skillSha256 }],
    task: `这是一次只读 MCP 连通验收。不修改文件、不安装依赖、只读取当前项目内 ${filename}。用实际工具取得当前工作目录，并实算此文件 SHA256。严格返回三行：MCP_TEST_OK；CWD=<实际绝对目录>；SHA256=<实算值>。失败则说明错误，不猜测。` } }, undefined, { timeout: 150000 });
  if (start.isError || !start.structuredContent?.runId) throw new Error(start.content?.[0]?.text || 'start_run failed; inspect availability, authentication, and API compatibility.');
  activeRun = start.structuredContent.runId;
  if (!start.structuredContent.durableRunId) throw new Error('start_run did not return durableRunId.');
  const binding = start.structuredContent.skillBindings?.find((item) => item.id === 'bootstrap-readonly-probe');
  if (!binding || binding.sha256 !== skillSha256 || start.structuredContent.harnessRole !== 'TESTER') throw new Error('start_run did not apply the expected Skill binding/role metadata.');
  const durable = await client.callTool({ name: 'list_durable_runs', arguments: { workspace, taskId, executionLineageId: 'bootstrap-verify', includeTerminal: true } });
  if (durable.isError || !durable.structuredContent?.runs?.some((r) => r.durableRunId === start.structuredContent.durableRunId)) throw new Error('durable run ledger did not persist start_run.');
  const wait = await client.callTool(
    { name: 'wait_run_until_terminal', arguments: { runId: activeRun, maxWaitSeconds: 180, pollIntervalMs: 1000 } },
    undefined,
    { timeout: 210000 }
  );
  if (wait.isError) throw new Error(wait.content?.[0]?.text || 'wait_run_until_terminal failed.');
  const outcome = wait.structuredContent;
  const text = outcome?.assistantText || '';
  const cwd = text.match(/^CWD=(.+)$/m)?.[1]?.trim();
  const hash = text.match(/^SHA256=([a-fA-F0-9]{64})$/m)?.[1]?.toLowerCase();
  const actualDirectory = cwd ? await realpath(cwd) : null;
  const passed = outcome?.status === 'succeeded' && actualDirectory === workspace && hash === expected;
  report = { status: passed ? 'PASS' : 'FAILED', workspace, cwd: actualDirectory, hashMatches: hash === expected,
    runId: activeRun, durableRunId: start.structuredContent.durableRunId, sessionId: start.structuredContent.sessionId, webUrl: start.structuredContent.webUrl };
  if (passed) {
    const delta = await client.callTool({ name: 'sync_session_delta', arguments: { sessionId: start.structuredContent.sessionId, workspace, maxEvents: 200, maxChars: 6000 } });
    if (delta.isError || delta.structuredContent?.sessionId !== start.structuredContent.sessionId) throw new Error('V10 session delta sync failed.');
    await client.callTool({ name: 'ack_session_sync', arguments: { sessionId: start.structuredContent.sessionId, workspace, throughEventSeq: delta.structuredContent.throughEventSeq, controlOwner: 'CODEX', overrideReviewState: 'NONE' } });
    await client.callTool({ name: 'ack_run', arguments: { durableRunId: start.structuredContent.durableRunId } });
    const cursor = await client.callTool({ name: 'get_session_cursor', arguments: { sessionId: start.structuredContent.sessionId, workspace } });
    if (cursor.isError || cursor.structuredContent?.unsynced) throw new Error('V10 session sync cursor did not acknowledge the probe delta.');
  }
  if (outcome?.status === 'running') await client.callTool({ name: 'cancel_run', arguments: { runId: activeRun } });
  if (!passed) process.exitCode = 1;
} catch (error) {
  if (activeRun) try { await client.callTool({ name: 'cancel_run', arguments: { runId: activeRun } }); } catch {}
  report = { status: 'BLOCKED', workspace, reason: error.message };
  process.exitCode = 1;
} finally {
  await client.close();
  await unlink(probe);
  console.log(JSON.stringify({ ...report, temporaryProbeRemoved: true }));
}
