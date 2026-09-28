# S3 — Bridge Check / Session Bootstrap

仅在 `ORCHESTRATION_MODE= DIRECT_HARNESS | ORCHESTRATED` 且当前会话尚无有效 Bridge 证据时加载。

## 1. Session Bootstrap

当前 Codex 会话第一次真正需要 Harness 时执行一次；MUST NOT 每条消息重复检查。

判定标准是“当前 Codex 是否能够调用 Bridge Tool”，MUST NOT 只依据插件名字。

可用探针：

```text
doctor
start_run
wait_run_until_terminal
wait_runs_until_terminal
get_run
list_durable_runs
recover_run
recover_pending_runs
ack_run
stop_service
```

结果：

```text
可用且 Health Check 通过        → BRIDGE_READY
Tool 不存在                    → BRIDGE_MISSING
安装后需新会话/重载            → BRIDGE_RESTART_REQUIRED
凭据缺失/认证失败              → BRIDGE_AUTH_REQUIRED
Bridge/Runtime 存在但协议或进程异常 → BRIDGE_BROKEN
缺前置环境/权限/用户批准而无法继续  → BRIDGE_BLOCKED
```

## 1.1 Session continuation capability

Bridge 的 `start_run` 支持可选 `sessionId`。Router MUST 把它视为 Harness 上下文连续性的正式接口：

```text
不传 sessionId → 创建新 Harness Session
传已完成且属于同一 Workspace 的 sessionId → 继续该 Session
```

Bridge 返回的 `sessionId` 与 `sessionReused` MUST 写入 Session Ledger。是否传 `sessionId` 由 `session-affinity.md` 决定，而不是由 Bridge 自动猜测。

`start_run` 还支持 `languageSyncMode + responseLocale`。Router 默认 MUST 使用 `MIRROR_USER` 并显式传 S0 解析出的 Locale。Bridge 负责把 Locale 约束注入当前 Harness Turn，并把语言元数据写入 Durable Run Ledger；详细规则见 `language-affinity.md`。

当 Contract 含 `SKILL_ASSIGNMENT` 时，`start_run` 还支持 `harnessRole + skillInputs[]`。Harness/Shared Skill 可由 PATH 或 INLINE 输入，并按 `SNAPSHOT | REFERENCE | INLINE` 转交。Bridge 只返回 `skillBindings` 元数据/digest，不回显完整 Skill 正文；详细规则见 `skill-routing.md` 与 `skill-file-spec.md`。

如果计划是 `REUSE`，但 Bridge 报 unknown session / workspace mismatch / session still running，MUST 分类处理，MUST NOT 静默退化成新 Session。


## 1.2 Language Affinity

语言同步只影响 Harness 用户可见自然语言；协议 key、代码、路径、命令、API/Tool 名与 raw error 保持原样。`MIRROR_USER/FIXED` 缺少 `responseLocale` 时 SHOULD 视为 Contract 不完整，而不是静默退回英文。用户改变语言不会触发新 Session。

## 1.3 Skill Forwarding

Bridge Skill forwarding 是 Codex→Harness 的正式数据接口：

```text
start_run(
  harnessRole=<role>,
  skillInputs=[...]
)
```

- `TARGET=CODEX` 的 Skill MUST NOT 放入 `skillInputs`；Codex 自己处理。
- `TARGET=HARNESS|SHARED` 可转交。
- `SNAPSHOT` 默认推荐：Bridge 读取/哈希/缓存并注入当前 Harness Turn。
- `REFERENCE`：只把经验证的 canonical path 转给 Harness；适合大 Skill。
- `INLINE`：适合用户直接粘贴的小 Skill。
- PATH 位于 Workspace/allowed roots 外时，只有用户显式提供/批准该路径才可设置 `externalPathApproved=true`。
- Required Skill 失败 → 当前 Run `BLOCKED`/调用失败；Optional Skill 失败 → `skillWarnings`。
- `applyToRoles` 不匹配当前 `harnessRole` 的 Skill 不注入，避免无关上下文。

Codex SHOULD 用文件物化/路径转交，而不是先把 Harness execution Skill 全文读进自身模型上下文。

## 1.4 Bridge-side Long Poll

Bundled Bridge 提供：

```text
wait_run_until_terminal
wait_runs_until_terminal
```

正常委派在 `start_run` 后 MUST 优先使用 `wait_run_until_terminal`。该调用在 Bridge 进程内部按 `pollIntervalMs` 查询 Harness，直到 Run 到达 `succeeded | failed | cancelled` 或 `maxWaitSeconds` 到期；中间状态 MUST NOT 返回 Codex，因此不会为每次 Harness 状态检查创建新的 Codex model turn。

```text
Codex → start_run → wait_run_until_terminal
                    [Bridge ↔ Harness internal polling]
                  → terminal result → Codex
```

并行 Task Graph SHOULD 使用 `wait_runs_until_terminal(runIds=[...])`，避免 Codex 分别轮询每个 branch。

- 默认建议 `maxWaitSeconds=900`，调用方 MAY 根据任务设置 1..3600 秒。
- `pollIntervalMs` 只影响 Bridge↔Harness，不应造成 Codex Token 消耗；默认 1000ms。
- 超时不取消 Run：返回 `waitTimedOut=true`、`status=running` 和等待元数据。Codex 可以再执行一次有界 long-poll，或在异常迹象存在时读取 `get_run`。
- 如果 Codex/MCP Host 自身的 Tool-call timeout 比 `maxWaitSeconds` 更短，外层调用可能先超时；这 MUST NOT 被解释为 Harness Run 失败。先用原 `runId` 恢复/检查 Run，再对同一 Run 继续 long-poll，MUST NOT 新建 Session 绕过等待。部署时 SHOULD 把 Host Tool timeout 配置为大于常用 `maxWaitSeconds`。
- 本地 Adapter 不向 Codex 暴露旧 `wait_run`；`get_run` 只用于诊断/读取快照，正常等待必须使用 `wait_run_until_terminal`。

## 1.5 Durable Run Recovery

Bundled Bridge 必须把 `start_run` 的 `runId → sessionId → TASK_ID/lineage → startEventSeq` 写入持久 Ledger。Codex/Bridge 重启后：

```text
list_runs             = 当前进程索引
list_durable_runs     = 跨进程索引
recover_run           = 恢复指定旧 Run
recover_pending_runs  = 恢复当前 Workspace 的 detached Runs + 未 ACK 的 terminal Results
ack_run               = 当前 Codex 已接收 terminal result 后做 delivery acknowledgement
```

如果恢复后 Harness Session 仍运行，返回 `DETACHED_RUNNING` 并继续对原 `runId` 使用 `wait_run_until_terminal`。如果 Harness 已在 Codex 离线期间完成，Bridge MUST 从持久 Session event history 重建原结果，不得重新 Prompt Harness。

Codex/MCP 断开不构成取消意图。仅显式 `cancel_run / stop_service` 可以停止任务。Terminal Result 的 `ack_run` 只是交付确认，不是 PASS。详细规则见 `durable-run-recovery.md`。

## 2. Health Check

首次使用执行一次 `doctor`，确认 Runtime、Node/npx、Harness、Credential、Workspace 基础状态。MUST NOT 每个任务重复 doctor。

Health Check MUST 分类失败原因，MUST NOT 把所有失败都当成“重新安装”：认证问题 → `BRIDGE_AUTH_REQUIRED`；协议/进程/损坏 → `BRIDGE_BROKEN`；缺少系统权限或批准 → `BRIDGE_BLOCKED`。

## 3. Bridge 缺失 / Vendored Runtime

V10.1 正常路径 MUST 优先使用 Skill 内置 `vendor/deepseek-harness-for-codex`。Bootstrap 将其复制到 resolved `CODEX_HOME` runtime 后注册本地 `dist/bin.mjs`；MUST NOT 为正常使用再次安装上游 `deepseek-harness-for-codex` plugin/npm 包。

前置检查：

```text
node --version
npx --version
codex --version
```

上游插件模式仅作为显式维护/诊断 fallback，不是默认运行路径。若用户明确选择上游插件模式，可使用上游项目自己的安装流程；不得与 Toharness vendored runtime 同时保持重复 MCP Tool Catalog。第三方依赖安装如需审批，MUST 先取得批准。

安装后 MUST NOT 假设当前会话热加载；标记 `BRIDGE_RESTART_REQUIRED`，新建/重载 Codex Session 后重新 `Bridge Check → doctor`。

Bridge 正常时 MUST NOT 重复安装。只有明确损坏、用户要求更新、已确认兼容问题才进入维护。

## 4. 已有 Harness / 直连

需要复用已运行 Harness 时读取 `references/existing-harness-bridge.md`。该文件只能包含通用验收流程，MUST NOT 存放设备历史、旧 run/session ID、个人项目路径或持久认证值。

本模块不臆造缺失的环境地址、凭据或旧设备路径。

通路验收 SHOULD 使用只读探针，并由 Codex 独立核对真实 Workspace/CWD 与已知文件内容或 Hash。配置或 Skill 更新后 MUST NOT 沿用旧验证结果。

连接已有用户手动服务时，Bridge 退出/断开 MUST NOT 被描述成关闭了用户服务，除非实际控制权明确。

## 5. 首次设备 Bootstrap

如果项目另有 `references/bootstrap.md` / `scripts/bootstrap.ps1`，按其流程执行。Bridge 未接通前，MUST NOT 把“安装 Bridge 自己”的任务委派给尚不可用的 Harness。

登录、API Key、Harness 地址/home 等无法从当前环境可靠确认的值，MUST NOT 自造、复制旧设备凭据或绕过认证。

Skill 包 MUST NOT 包含真实 API Key、Cookie、认证文件、机器环境文件或旧设备绝对凭据路径。


## 6. Compatibility Manifest

Bridge/Runtime 的兼容版本 MUST 从 `references/compatibility.json` 读取。核心协议不绑定版本，但 Bootstrap/Adapter MUST 使用 manifest 声明的兼容策略。

- 已有 Harness：probe-first；通过 Safe Probe 即优先复用，不因“不是默认版本”强制降级/升级。
- 新 Provision：只安装 `defaultProvisionPackage`，MUST NOT 浮动安装 latest。
- 未在 manifest 验证列表中的版本：MAY 尝试只读兼容探针；通过后可作为本次运行 Evidence，但 MUST NOT 自动改写 manifest。

## CODEX_HOME 一致性

Bridge 检查与安装 MUST 使用 `bootstrap.ps1` 已解析的 Codex Home。不得出现“Router 自己读取 `%USERPROFILE%\.codex`，但 `codex mcp get` 子进程读取另一 Home”的分叉。

- 未显式设置 `CODEX_HOME` 不等于 MCP 未注册。
- `bootstrap.ps1 -CheckOnly` 输出的 `resolvedCodexHome` 是本次预检的事实来源。
- 若 `missing=[]`，MUST 复用现有配置，MUST NOT 因旧预检结果再次安装 Harness 或 MCP 注册。
- 用户可用 `-CodexHome` 显式覆盖自动解析，但这不是正常运行的必需步骤。



### Codex MCP Tool Timeout

Bridge-side long-poll requires the Codex MCP host timeout to exceed the Bridge wait window. The installer MUST ensure `[mcp_servers.deepseek-harness] tool_timeout_sec >= 3700`. Codex defaults this setting to about 60 seconds; leaving the default can re-enter the model while Harness is still running and recreate repeated wait calls. The local adapter intentionally does not expose the legacy `wait_run` MCP tool to Codex; new tasks must use `wait_run_until_terminal`.

## 1.6 V10 Bidirectional Context Sync

Bundled Bridge 额外提供：

```text
list_persisted_sessions
adopt_session
get_session_cursor
list_unsynced_sessions
sync_session_delta
read_session_events
ack_session_sync
```

用途：

- `list_persisted_sessions`：发现 Workspace 内 Harness 已持久化 Session，包括 Harness-first 会话。
- `adopt_session`：把已有 Harness Session 绑定到 Toharness Task/lineage，不发送新 Prompt。
- `get_session_cursor`：metadata-only 检查 latest seq 与 last synced seq。
- `list_unsynced_sessions`：发现已绑定 Session 中 Codex 尚未吸收的新活动。
- `sync_session_delta`：确定性提取 last sync cursor 之后的 bounded delta/checkpoint。
- `read_session_events`：仅在需要证据时窄范围 drilldown。
- `ack_session_sync`：推进持久 sync cursor，并记录 `CONTROL_OWNER / OVERRIDE_REVIEW_STATE / DECISION_CLASS`。

Bridge 使用独立 `session-sync.json` 保存游标，不复制完整 Harness 对话。复用旧 Session 前若存在未同步事件，默认 `start_run` 返回 `SESSION_SYNC_REQUIRED`；正常路径必须先同步再继续。

Harness-first：

```text
list_persisted_sessions
→ adopt_session
→ sync_session_delta
→ ack_session_sync
→ 后续 start_run(sessionId=<same>)
```

用户直接在 Harness 中明确做方向/系统级修改时允许 `HARNESS_USER_OVERRIDE`。该 Override 代表用户权限，不表示 Harness Agent 获得永久 Supervisor 权限；Codex 后续同步并 Review/Normalize。

## 1.7 Run Turn Boundary

V10 将 Codex 派发 Run 的持久边界收紧为 Harness 的单个 Turn：

```text
START_EVENT_SEQ
→ first matching turn/start
→ same turn/end
```

Durable Ledger 记录 `turnNumber / turnStartSeq / turnEndSeq`。因此原 Codex Run 完成后，用户立即在同一 Harness Session 继续的后续人工 Turn 不应被混入原 Run Result，也不会被 `ack_run` 越界 ACK。
