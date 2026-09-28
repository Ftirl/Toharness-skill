---
name: Toharness
description: 通用跨 Runtime Agent Orchestration Skill。负责 Codex 与 DeepSeek Harness 之间的任务分类、能力解析、双向上下文同步、委派、Capability Bootstrap、逻辑角色、验证、Review 与 Token 优化。采用轻核心 + 按状态加载 references 的渐进式协议；不绑定具体软件、模型或用户工作流。
version: 10.1
format: agent-executable-modular
spec-version-of: Toharness-SKILL.md (v10.1 embedded-vendored-runtime + closed-loop)
---

# Toharness / Capability Orchestrator

## 0. 使用方式

本文件是**常驻轻核心**。执行本 Skill 时，只加载当前状态明确要求的 `references/*.md`，MUST NOT 在任务开始时一次性读取全部 references。

公共调用名为 `Toharness`。当用户说“使用 Toharness”“通过 Toharness 调用/处理”或等价表达时，应进入本协议。`DeepSeek Harness for Codex` 是底层 Bridge 的上游来源；V10.1 正常运行使用 Skill 内置的 `vendor/deepseek-harness-for-codex` 定制底本。MCP 注册名 `deepseek-harness` 保持兼容，不等于本 Skill 的公开名称。

关键词：`MUST` 必须；`MUST NOT` 禁止；`SHOULD` 默认如此，偏离需说明；`MAY` 可选。

术语：

- `Codex`：Supervisor / Planner / Architect / Router / Integrator / Final Reviewer。
- `Harness`：DeepSeek Harness，Execution Runtime。
- `Bridge`：`deepseek-harness-for-codex`。
- `Capability`：任务需要的抽象能力。
- `Provider`：提供能力的 MCP / CLI / API / Tool / Script / Native Tool。

系统只关心「当前任务需要什么 Capability」，而不是「用户正在使用什么具体软件」。MUST NOT 在本核心或长期规则中绑定具体模型版本。

## 1. 职责边界

| 主体 | 核心职责 |
|---|---|
| Codex | Decide：理解目标、判断复杂度/风险、定义边界与验收、选择委派方式、最终验收 |
| Harness | Execute：承载逻辑角色、驱动工具、执行任务、产生证据 |
| Capability / Provider | Explain & Perform：说明并提供可执行能力 |
| Tests / Evidence | Prove：证明结果 |
| Codex Review | Accept：最终放行 |

## 2. 固定标识符

```text
ORCHESTRATION_MODE : DIRECT_CODEX | DIRECT_HARNESS | ORCHESTRATED
CONTRACT_LEVEL      : LIGHT | STANDARD | STRICT
TASK_LEVEL          : L0 | L1 | L2 | L3 | L4
DECISION_DENSITY    : LOW | MEDIUM | HIGH
EXECUTION_VOLUME    : LOW | MEDIUM | HIGH
VERIFIABILITY       : LOW | MEDIUM | HIGH
RISK                : LOW | MEDIUM | HIGH
REVERSIBILITY       : REVERSIBLE | PARTIALLY_REVERSIBLE | IRREVERSIBLE
IDEMPOTENT          : true | false | unknown
CAPABILITY_STATE    : UNKNOWN | MISSING | PROVISIONING | REGISTERED | AUTH_REQUIRED | READY | BROKEN | BLOCKED
PROVIDER_STATE      : UNKNOWN | MISSING | INSTALLED | RUNNING | BROKEN
BRIDGE_STATE        : BRIDGE_READY | BRIDGE_MISSING | BRIDGE_RESTART_REQUIRED
                      | BRIDGE_AUTH_REQUIRED | BRIDGE_BROKEN | BRIDGE_BLOCKED
CAPABILITY_SCOPE    : TASK | PROJECT | PROFILE | USER
HARNESS_SESSION_POLICY : REUSE | NEW | FRESH
LANGUAGE_SYNC_MODE   : MIRROR_USER | FIXED | AUTO
DURABLE_RUN_STATE    : SUBMITTED | ACTIVE | DETACHED_RUNNING | COMPLETED | DETACHED_COMPLETED
                      | FAILED | CANCELLED | RECOVERY_REQUIRED | RECOVERED
RUN_DELIVERY_STATE    : UNACKNOWLEDGED | ACKNOWLEDGED
SKILL_TARGET          : CODEX | HARNESS | SHARED
SKILL_SOURCE          : INSTALLED | PATH | ATTACHMENT | INLINE
SKILL_TRANSFER_MODE   : SNAPSHOT | REFERENCE | INLINE
SKILL_STATE           : UNRESOLVED | RESOLVED | FORWARDED | BLOCKED
CONTEXT_SYNC_STATE    : IN_SYNC | UNSYNCED | SYNC_REQUIRED | SYNCED
CONTROL_OWNER         : CODEX | HARNESS | HARNESS_USER_OVERRIDE
DECISION_CLASS        : LOCAL_EXECUTION | DIRECTIONAL_DECISION | SYSTEM_DECISION
OVERRIDE_REVIEW_STATE : NONE | PENDING | ACCEPTED | ACCEPTED_WITH_NORMALIZATION | REVISED
STATUS              : SUCCESS | FAILED | ESCALATE | BLOCKED
FINAL_STATUS        : PASS | REWORK | ESCALATED | BLOCKED | FAILED
```

`STATUS` 是单次 Run 状态；`FINAL_STATUS` 是任务级状态；MUST NOT 混用。

## 3. 主状态机

```text
S0 CONTEXT_RESOLUTION
↓
S1 TASK_INTAKE
↓
S2 ORCHESTRATION_GATE
├─ DIRECT_CODEX ───────────────────────────────┐
└─ DIRECT_HARNESS / ORCHESTRATED              │
      ↓                                        │
   S3 BRIDGE_CHECK                             │
      ↓                                        │
   S4 CAPABILITY_RESOLUTION                    │
      ↓                                        │
   S5 PLAN ←───────────────────────────────────┘
      ↓
   S6 EXECUTION
      ↓
   S7 VERIFICATION_REVIEW
      ↓
   FINAL_STATUS
```

Capability Bootstrap 是 `S4` 的子流程，不是常驻主阶段。

## 4. 按状态加载规则

这是本版本的核心。MUST 先判断状态，再加载对应模块。

| 状态/条件 | 必须加载 | 不应提前加载 |
|---|---|---|
| `S0` | `references/context-resolution.md` | Bridge / Bootstrap / Roles / Telemetry |
| `S1` | `references/task-intake.md` | Bridge / Bootstrap |
| 用户指定 Skill / 提供 Skill 文件、路径或正文 | `references/skill-routing.md`；使用跨 Runtime 文件格式时再读 `references/skill-file-spec.md` | MUST NOT 因 Harness Skill 存在而把其执行正文全量加载进 Codex |
| Risk 明显为 `MEDIUM/HIGH`、可逆性不清或需要领域细化 | `references/risk-policy.md` | 无需对纯只读 LOW 任务加载完整 Risk 模块 |
| `S2` | 使用本文件 §5 Gate；复杂边界不清时再读 `references/task-intake.md` | Bridge |
| Harness 模式进入 `S3` | `references/bridge.md` | Capability Bootstrap |
| Bridge/Codex 曾重启、旧 `runId` 不可见、或存在 detached run | `references/durable-run-recovery.md` | MUST 在创建替代 Session 前加载 |
| 已绑定 Harness Session 存在直接用户交互、用户从 Harness 返回 Codex、或复用 Session 前检测到未同步事件 | `references/bidirectional-context-sync.md` + `references/decision-authority.md` | MUST NOT 重新读取整个 Session；先 Cursor，再 Delta |
| `S4` | `references/capability-resolution.md` | Bootstrap 模块仅在 Capability 非 READY 时读取 |
| Capability `MISSING/BROKEN/AUTH_REQUIRED` | `references/capability-bootstrap.md` | Roles / Telemetry |
| `S5` Harness 委派 | `references/contracts.md` + `references/session-affinity.md` + `references/language-affinity.md`；有 Skill Assignment 时再加载 `references/skill-routing.md` | ORCHESTRATED 角色模块仅在需要时读取 |
| `ORCHESTRATED` | `references/roles-task-graph.md` | DIRECT_HARNESS MUST NOT 加载完整 DAG 规则 |
| Harness Result / Revision / 外部可变状态 / 高风险任务进入 `S6/S7` | `references/verification-review.md` | Telemetry 不参与当前结果正确性判断 |
| 简单 `DIRECT_CODEX` 且仅纯推理或低量只读 Codex-native 能力 | 使用本核心 §13 最小验收即可 | MUST NOT 为形式完整加载整套 Verification 模块 |
| 任务结束且启用成本/路由统计 | `references/telemetry.md` | MUST NOT 为每个任务提前加载 |
| 修改 Router/Skill/协议本身 | `references/governance.md` | 普通业务任务无需加载 |

同一状态已读取并且相关条件未变化时，MUST NOT 重复加载相同 reference。

## 5. S2 — Orchestration Gate

先基于 `TASK_PROFILE` 判断：

| 模式 | 典型条件 | 行为 |
|---|---|---|
| `DIRECT_CODEX` | `DECISION_DENSITY=HIGH` + `EXECUTION_VOLUME=LOW` + 不需要非平凡外部写入 | Codex 直接推理；MAY 使用低量只读 Codex-native 能力；MUST NOT 承担非平凡外部可变状态执行 |
| `DIRECT_HARNESS` | `DECISION_DENSITY=LOW` + `EXECUTION_VOLUME=HIGH` + `VERIFIABILITY=HIGH` | 短 Contract → Harness → Light Review |
| `ORCHESTRATED` | 多阶段 / 多 Capability / 多依赖 / 需要独立验证 | Task Graph + Logical Roles |

`RISK=HIGH` 或 `VERIFIABILITY=LOW` 时 MUST 加重 Review；不得仅凭执行量选择最轻模式。

`DIRECT_CODEX` 是 reasoning-first path，不是“Codex 自己执行所有工具”的快捷方式。若任务需要大量外部读取、任何非平凡外部写入、Provider-specific 执行或长链 Tool/MCP 操作，MUST 改为 `DIRECT_HARNESS` 或 `ORCHESTRATED`；可采用 `Harness Explorer → 压缩 Evidence → Codex Reasoning` 的混合路径。

## 6. 最小 Risk 快速判定

为了避免所有任务都加载完整 Risk 模块：

```text
明显只读 + 无外部副作用
→ LOW

有限写入 + 可恢复，或影响共享状态但有明确回滚
→ 至少 MEDIUM

权限/认证/安全边界变化，或无恢复路径的关键 destructive 操作
→ HIGH
```

以下情况 MUST 加载 `references/risk-policy.md`：

- `REVERSIBILITY != REVERSIBLE`；
- 涉及共享/公开/外部关键状态；
- Provider/Capability 有领域 Risk 规则；
- 无法确认是否有副作用；
- 需要决定 Dry Run / Retry / Fresh Reviewer。

## 7. 核心门禁

```text
S0 完成前                  → MUST NOT 做任务级执行决策
TASK_PROFILE 完成前        → MUST NOT 选择 ORCHESTRATION_MODE
S2 完成前                  → MUST NOT 判断是否需要 Bridge
DIRECT_CODEX 需要非平凡外部写入 → MUST 重新路由到 DIRECT_HARNESS / ORCHESTRATED
Harness 模式且 Bridge 非 READY → MUST NOT 委派 Harness 正式任务
REQUIRED_CAPABILITIES 未解析   → MUST NOT 正式执行
依赖的 Capability 非 READY     → MUST NOT 提交依赖它的正式任务
Harness 委派且 Contract 未定义 → MUST NOT 执行
并行写入未定义 Ownership       → MUST NOT 并行写
Revision 发生变化               → 旧 Verification/Review MUST NOT 自动继承
复用已绑定 Harness Session 且存在 UNSYNCED activity → MUST 先 Delta Sync；默认 MUST NOT 带旧上下文直接继续派发
HARNESS_USER_OVERRIDE            → MUST 视为用户授权的状态变化，不得自动回滚；Codex 回流后进行 Review/Normalization
```

只读 Bridge Health Check、Capability Check、Safe Probe 属于基础设施探针，不视为正式业务任务。

## 8. S1 最小 TASK_PROFILE

S1 至少产生：

```text
GOAL
CONTEXT
TASK_LEVEL
DECISION_DENSITY
EXECUTION_VOLUME
VERIFIABILITY
RISK
REVERSIBILITY
REQUIRED_CAPABILITIES
LANGUAGE_SYNC_MODE
CONVERSATION_LOCALE
RESPONSE_LOCALE
SKILL_ASSIGNMENT（用户指定 Skill 时）
CONTROL_OWNER
CONTEXT_SYNC_STATE（已绑定 Harness Session 时）
```

详细定级只在需要时读取 `references/task-intake.md` 和 `references/risk-policy.md`。

## 9. Skill Routing 核心规则

用户显式指定 Codex/Harness Skill、上传 Skill 文件、提供 Skill 路径或粘贴 Skill 正文时，MUST 加载 `references/skill-routing.md`。

核心约束：

```text
TARGET=CODEX
→ Codex 使用；默认不转发 Harness

TARGET=HARNESS
→ Codex 只消费 routing metadata / [SHARED] / [CODEX] 覆盖部分
→ execution body 通过 Bridge 转交 Harness

TARGET=SHARED
→ Codex 只读 [SHARED]+[CODEX]
→ Harness 使用 [SHARED]+[HARNESS]+matching ROLE
```

若 Skill 文件遵循 `cross-runtime-skill/v1`，按 `references/skill-file-spec.md` 的 scope section 读取。Legacy Harness Skill 无 scope 时，正文默认属于 Harness execution content；Codex MUST NOT 因此承担执行职责。

用户上传的 Skill 文件 SHOULD 物化为稳定路径后使用 `SNAPSHOT` 转交；用户明确给出的本机路径 MAY 直接转交。Required Skill 无法解析/读取/校验时 MUST `BLOCKED`，禁止静默替代。

## 10. Bidirectional Context Sync / Decision Authority

默认主线仍为 `CODEX_SUPERVISED`：Codex 是 Supervisor，Harness 是 Execution Runtime。允许用户直接在 Harness Web 中继续局部执行、修改方向，甚至显式做原本属于 Codex 层级的决定；**职责边界约束 Agent 自主行为，不限制用户本人。**

```text
默认权责：
USER > CODEX Supervisor > HARNESS Runtime

用户直接在 Harness 做局部执行
→ CONTROL_OWNER=HARNESS

用户直接在 Harness 做方向/系统级决定
→ CONTROL_OWNER=HARNESS_USER_OVERRIDE
→ OVERRIDE_REVIEW_STATE=PENDING
→ Harness MAY 按用户明确要求继续执行
→ 后续回到 Codex 时必须同步 Delta，再从当前现实状态继续
```

同步路径 MUST 使用：

```text
get_session_cursor / list_unsynced_sessions
→ 仅判断是否有新活动

sync_session_delta
→ 只拉 lastSyncedEventSeq 之后的 compact delta/checkpoint

read_session_events
→ 仅在 Delta 不足时按需 drilldown

ack_session_sync
→ Codex 已吸收本次 Delta 后推进游标
```

MUST NOT 默认把完整 Harness Session 重新注入 Codex。同步预算 SHOULD 先控制在约 `800–1500 tokens` 对应的 compact packet；超预算先摘要/截断，再按需读取证据。

若 Harness 中出现用户授权的越级决定，Codex 回流后可记录：

```text
ACCEPT
ACCEPT_WITH_NORMALIZATION
REVISE
```

但 Codex MUST NOT 把“用户在 Harness 明确授权的决定”当成 Harness 自主违规并自动回滚。`Context synchronization != decision approval`；Review 的作用是把新现实状态重新纳入 Task Contract、Risk、Invariant 与 Acceptance。

详细规则见 `references/bidirectional-context-sync.md` 与 `references/decision-authority.md`。

## 11. S4 Capability-first 核心规则

```text
任务
→ REQUIRED_CAPABILITIES
→ Capability Registry
→ Provider Selection
→ READY?
```

Capability ID SHOULD 描述能力而不是产品。一个 Capability MAY 有多个 Provider。MCP 只是 Capability Transport / Interface；MUST NOT 假设所有能力都来自 MCP。

Codex 看不到某 MCP Tool，不代表 Harness 中不存在该能力。Harness 模式下的 MCP 能力事实应通过 S4 Capability Check 确认。

## 12. S5 Contract 选择

```text
LIGHT
→ L0 / 明确 L1 + LOW Risk + HIGH Verifiability

STANDARD
→ 普通 L1/L2 或 MEDIUM Risk

STRICT
→ L3/L4 或 HIGH Risk 或 LOW Verifiability
   或 IRREVERSIBLE 或复杂 ORCHESTRATED 写入任务
```

具体 Contract 字段加载 `references/contracts.md`。

## 13. ORCHESTRATED 角色核心

只有 `ORCHESTRATED` 才加载 `references/roles-task-graph.md`。

逻辑角色：

```text
Explorer    → Read-only discovery
Researcher  → Read-only external/domain evidence
Worker      → Bounded write/execution
Integrator  → Mechanical integration of bounded worker outputs
Tester      → Verification evidence
Reviewer    → Fresh-context challenge, read-only
```

它们是逻辑角色，不绑定模型。

## 14. Escalation 快速条件

出现以下情况，Harness MUST 停止扩大自主修改并返回 Codex：

```text
Requirement Conflict
Architecture / Core Algorithm Change
Capability Unavailable
Provider Semantics Unknown
Unexpected State
Scope Expansion
High-risk Irreversible Operation
Semantic Integration Conflict
Repeated Failure
Verification Conflict
Risk Semantics Unknown
```

详细 Retry / Escalation / Review 读取 `references/verification-review.md`。

## 15. S7 最终验收核心

简单 `DIRECT_CODEX` 且仅纯推理/低量只读 native 能力时，可在本核心完成最小验收，不必加载完整 Verification 模块。只要存在 Harness Result、`REVISION_ID`、外部可变状态、`RISK>=MEDIUM`、`VERIFIABILITY=LOW` 或独立 Reviewer 要求，MUST 加载 `references/verification-review.md`。

Harness `STATUS=SUCCESS` **不等于** `FINAL_STATUS=PASS`.

Codex 最终至少检查：

```text
Goal
Contract / Scope
Revision
Evidence
Acceptance Tests
Risk
Reviewer Findings（若启用）
Unresolved
```

最终状态只能是：

```text
PASS | REWORK | ESCALATED | BLOCKED | FAILED
```

## 16. Result Compression

Harness 默认只返回：

```text
事实
变化
Revision
证据
测试结果
风险
未解决问题
```

MUST NOT 默认回传完整日志、全部 Tool 调用、全部文件、全部 MCP 原始响应或长篇自我解释。

## 17. Execution Affinity / Polling

Harness 委派 MUST 按需加载 `references/session-affinity.md` 与 `references/language-affinity.md`。默认 Session 策略是：

```text
同一 TASK_ID + 同一 EXECUTION_LINEAGE_ID + 同一 Workspace
→ REUSE 优先
```

新一轮 Codex 对话、Logical Role 变化、测试失败、局部 REWORK 都 MUST NOT 单独成为新建 Harness Session 的理由。只有独立任务、并行 branch、隔离边界或 Fresh Reviewer 等明确条件才 `NEW/FRESH`。

每次 `start_run` 前 MUST 先解析 Session Ledger；选择 `REUSE` 时必须显式传已有 `sessionId`，并检查 Bridge 返回的 `sessionReused`。若 Codex/Bridge 曾重启或旧 `runId` 在当前进程不可见，MUST 先读取 `references/durable-run-recovery.md` 并尝试 Durable Run Recovery，禁止直接 NEW。

Bridge 调用优先：

```text
[restart/recovery needed]
list_durable_runs / recover_pending_runs
→ running: wait_run_until_terminal(original runId)
→ completed: reconstruct result → Review → ack_run(after result ingestion)

[new work only]
start_run(taskId, executionLineageId, sessionId=<reuse when applicable>, languageSyncMode, responseLocale, harnessRole, skillInputs=<when assigned>)
→ wait_run_until_terminal(maxWaitSeconds=<bounded>)
→ get_run（仅需要补充结果或异常细节时）
```

`wait_run_until_terminal` 的 Harness 状态轮询 MUST 在 Bridge 内部完成，MUST NOT 每次轮询都重新唤醒 Codex。并行 Task Graph SHOULD 使用 `wait_runs_until_terminal` 一次等待多个 Run。

`wait_run` MUST NOT 出现在本地 Bridge 的 Codex Tool Catalog 中。若 long-poll 返回 `waitTimedOut=true` 且 Run 仍为 `running`，Codex MAY 再发起一次有界 `wait_run_until_terminal`，或进入异常诊断，但 MUST NOT 高频轮询。MUST NOT 用一个长期 Session 承载整个项目历史。

Language Affinity 默认 `MIRROR_USER`：Codex 当前用户中文→Harness 用户可见自然语言中文；英文→英文。协议字段、代码、路径、命令、API/Tool 名和 raw error 保持原样。语言变化 MUST NOT 单独触发新 Session。`start_run` MUST 显式携带 `languageSyncMode + responseLocale`；Durable Recovery MUST 恢复原 Run 的语言元数据。

Skill Affinity 在存在 `SKILL_ASSIGNMENT` 时启用：Codex-only Skill 留在 Codex；Harness/Shared Skill 通过 `harnessRole + skillInputs` 转交。符合 `cross-runtime-skill/v1` 的文件，Codex SHOULD 用 `scripts/skill_view.py --target codex` 只读取自身 scope；Harness execution body 不应被 Codex 默认全量消费。

## 18. 通用性与个性化

- Memory / Context 提供 `Preference`，不是 `Execution Truth`。
- 用户当前明确要求 > 当前 Workspace/Project > Task-specific Instructions > 当前 Capability State > Relevant Memory > Defaults。
- MUST NOT 因长期用户偏好在 Router 核心硬编码某 Provider。
- 具体 Provider/API/Tool/版本知识进入 Capability Skill / Provider Skill，而不是本核心。

## 19. 最终原则

MUST NOT 围绕「某个模型 / 某个软件 / 某个 MCP / 某个用户」设计 Router。

MUST 围绕：

```text
Goal | Context | Decision Density | Capability | Risk | Execution | Evidence | Review
```

优化目标不是最低 Token，而是：

```text
Quality × Reliability / Cost
```


## MCP Host Wait Invariant

For the local Bridge, `tool_timeout_sec` MUST be >= 3700 seconds. `wait_run_until_terminal` is the preferred primitive. The local adapter MUST NOT expose the legacy `wait_run` tool to Codex. Repeated `wait_run` calls therefore indicate a stale/duplicate Bridge registration or a host/runtime wait mechanism rather than the current adapter.


## V10 Closed-Loop Invariants

```text
PRIMARY_ORCHESTRATION_MODE = CODEX_SUPERVISED
HARNESS_DIRECT_INTERACTION = ENABLED
DEFAULT_DECISION_AUTHORITY = CODEX
USER_OVERRIDE = ALLOWED

Codex → Harness delegation
AND
Harness direct user work → Cursor/Delta → Codex

两条路径共享同一个 Task / Session / Durable State，不创建第二套 conversation database。
```

- Harness direct interaction MUST NOT 破坏 Session Affinity、Language Affinity、Skill Affinity 或 Durable Reattach。
- Codex 回流 MUST 以当前 Harness/Workspace 状态为现实基线，不得无依据退回旧 Task Contract。
- 用户在 Harness 的显式决定拥有高于 Agent 默认职责边界的权限；Agent 自主越级仍需按 Decision Authority 规则 Escalate。
- `ack_session_sync` 只表示 Context Delta 已被 Codex 吸收，不代表最终 PASS。
