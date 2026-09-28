# S6 / S7 — Execution, Verification & Review

Harness 执行完成后加载。DIRECT_CODEX 仅纯推理/低量只读且 LOW Risk 时 MAY 使用核心最小验收；只要涉及外部可变状态、RISK>=MEDIUM、LOW VERIFIABILITY、Revision/Evidence 或独立 Reviewer 要求，MUST 加载本模块。

## 1. Result Contract

Harness 返回：

```text
TASK_ID
EXECUTION_LINEAGE_ID
SESSION_ID
SESSION_REUSED
ROLE
STATUS
REVISION
SUMMARY
CAPABILITIES_USED
RESOURCES_CHANGED
EVIDENCE
TEST_RESULTS
UNRESOLVED
RISKS
ESCALATION_REASON
```

`SESSION_ID` / `SESSION_REUSED` 应来自 Bridge run metadata，不由 Worker 自行猜测。`STATUS` 是单次 Run 状态，MUST NOT 与任务级 `FINAL_STATUS` 混用。

## 2. Result Compression

MUST NOT 默认返回：

```text
完整日志
完整 Tool 调用
全部文件
全部 MCP 原始响应
无关探索过程
Worker 长篇自我解释
```

SHOULD 优先返回：事实、变化、证据、风险、未解决问题。

## 3. Revision-bound Verification

执行结果 SHOULD 产生 `REVISION_ID`，例如：

```text
Git Commit
Diff Hash
Artifact Hash
External State Version
Snapshot ID
Database Transaction ID
```

Tester 验证 Revision A；若修改产生 Revision B，Revision A 的验证 MUST NOT 自动应用于 Revision B。

## 4. Evidence

SUCCESS MUST 附带 Evidence，例如：

```text
Test Result
Command Result
Artifact Hash
State Snapshot
Tool Result
Diff
Safe Probe
API Response Summary
```

Tester Evidence Contract：

```text
REVISION
CHECKS
COMMANDS
RESULTS
STATE_DIFF
UNRESOLVED
```

## 5. State Snapshot

对影响外部状态的任务，如果能力支持：

```text
PRE_STATE
→ Action
→ POST_STATE
```

用于 Verification / Diff / Rollback。

## 6. Reversibility / Dry Run

任务标记：

```text
REVERSIBLE | PARTIALLY_REVERSIBLE | IRREVERSIBLE
```

`RISK=HIGH` 且 Provider 支持 Dry Run 时 SHOULD：

```text
DRY_RUN → Review → EXECUTE
```

否则 MAY 使用 Preview / Simulation / State Diff Prediction。

## 7. Idempotency / Retry

```text
IDEMPOTENT: true | false | unknown
```

自动 Retry 只适用于以下全部成立：

```text
明确根因
局部失败
低风险
结果可验证
```

未知根因 MUST NOT 无限 Retry。有限次数耗尽 → ESCALATE。

## 8. Escalation

Harness MUST 在以下情况停止扩大修改：

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

返回 `STATUS: ESCALATE` + `ESCALATION_REASON`。

## 9. Polling / Long Wait

正常 Harness 任务：

```text
start_run
→ wait_run_until_terminal
→ terminal Result
→ get_run（仅异常或需要补充结果时）
```

Bridge MUST 在内部执行状态轮询，避免 `running → Codex → wait → running` 的重复主控回合。并行 Run SHOULD 使用 `wait_runs_until_terminal`。

本地 Adapter 不向 Codex 暴露旧 `wait_run`。MUST NOT 用连续 `get_run` 构造轮询。Long-poll 超时只表示本次等待窗口结束，MUST NOT 自动把正在运行的 Harness Run 标成 FAILED，也 MUST NOT 自动创建新 Session。

## 10. Review Policy

Review 深度由：

```text
Risk | Verifiability | Decision Density | Reversibility
```

共同决定。

以下情况 SHOULD 使用独立 Fresh Reviewer：

```text
HIGH RISK
LOW VERIFIABILITY
复杂 ORCHESTRATED Task
公共行为变化
不可逆操作
```

## 11. Reviewer Isolation / Anti-Anchoring

Reviewer 第一轮只接收 `REVIEW_PACKET`：

```text
Task Contract
REVISION_ID
Diff / State Diff
Evidence
Acceptance Tests
Risk / Reversibility
Unresolved
```

第一轮 MUST NOT 默认注入：

```text
Worker 长篇解释
Worker 自我评价
Worker persuasive rationale
完整执行对话
其他 Reviewer 结论
```

只有第一轮独立检查后仍有事实歧义时，Reviewer MAY 请求特定 Worker Explanation、原始日志或 Tool Response。

Reviewer MUST NOT 自行修复自己的 Finding；需要修改时返回 Finding / REWORK。

## 12. Codex Final Review

Harness `SUCCESS` 不等于 `PASS`。

Codex MUST 检查：

```text
Goal
Contract
Revision
Evidence
Acceptance Tests
Risk
Findings
Unresolved
```

最终状态：

```text
PASS | REWORK | ESCALATED | BLOCKED | FAILED
```

## 13. Session Policy

详细规则由 `session-affinity.md` 定义。Verification 阶段必须遵循：

- 同一实现 lineage 的测试失败、REWORK、局部 Retry → 默认 `REUSE` 原 Session；
- 不得因为 Codex 进入新一轮消息或 Tester/Worker Role 切换就 NEW；
- Fresh Reviewer → MUST `FRESH`，不得继承 Worker Session；
- Reviewer 第一轮只接收 REVIEW_PACKET；
- 若同一 TASK_ID 被迫 NEW，必须使用 Continuity Packet 保留事实、Revision、Evidence、Invariants 和未解决项；
- 新 Session MUST NOT 被描述成自动继承旧 Harness 对话。

Codex Final Review SHOULD 检查 Result 中的 `sessionId/sessionReused` 是否与计划的 Session Policy 一致；依赖连续上下文的任务若发生 `SESSION_CONTINUITY_BROKEN`，不得直接 PASS。


## 14. Language Affinity Verification

若 Contract 为 `MIRROR_USER/FIXED`，Codex SHOULD 检查 Harness 的用户可见自然语言是否与 `RESPONSE_LOCALE` 一致。明显不一致时标记 `LANGUAGE_AFFINITY_BROKEN`。MUST NOT 因语言问题新建 Session；需要修正时在同一 lineage 下一 Run 重新声明 Locale。结构化协议 key、代码、路径、命令和 raw error 不参与语言一致性判定。


## 15. Skill Assignment Verification

存在 `SKILL_ASSIGNMENT` 时，Codex Final Review SHOULD 对照 Bridge 返回的 `harnessRole / skillBindings / skillWarnings`：

```text
required Skill id 是否出现
target 是否正确
applyToRoles 是否匹配当前 Role
SHA256 / revision 是否与预期一致（如已 pin）
required Skill 是否出现 warning / missing
Reviewer 是否错误继承了 Worker-only Skill
```

Required Harness Skill 未实际加载或 digest 不匹配 → `SKILL_AFFINITY_BROKEN`，MUST NOT 直接 PASS。

Skill 本身不能作为 Evidence 替代测试/状态验证；它只是执行知识与约束来源。


### Codex MCP Tool Timeout

Bridge-side long-poll requires the Codex MCP host timeout to exceed the Bridge wait window. The installer MUST ensure `[mcp_servers.deepseek-harness] tool_timeout_sec >= 3700`. Codex defaults this setting to about 60 seconds; leaving the default can re-enter the model while Harness is still running and recreate repeated wait calls. The local adapter intentionally does not expose the legacy `wait_run` MCP tool to Codex; new tasks must use `wait_run_until_terminal`.


## Bidirectional Sync / Override Review

从 Harness 直接交互回流的修改在 Review 前 MUST 有对应 Sync cursor/Delta。

```text
UNSYNCED Harness activity
→ MUST NOT 宣称 Codex 拥有最新 Task State

HARNESS_USER_OVERRIDE
→ MUST NOT 自动回滚
→ Review 当前现实状态、Risk、Invariant、Acceptance
→ ACCEPT / ACCEPT_WITH_NORMALIZATION / REVISE
```

若 `sync_session_delta.truncated=true` 且关键决策证据不完整，Reviewer MAY 使用 `read_session_events` 做窄范围 drilldown；MUST NOT 默认拉取完整 Session。

如果 Codex 在未同步状态下继续向同一 Session 派发并覆盖了用户修改，标记：

```text
CONTEXT_CONTINUITY_BROKEN
```

`ack_session_sync` 只表示 Context 已吸收，不等于 PASS。
