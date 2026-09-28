# Harness Session Affinity / Continuity Policy

按需加载：只要任务进入 `DIRECT_HARNESS` 或 `ORCHESTRATED` 并即将调用 `start_run`，MUST 读取本模块。目标是**同一执行链复用优先，新建会话必须有理由**。

## 1. 核心原则

Codex 对话与 Harness Session 是不同层级。MUST NOT 使用“Codex 出现了新一轮消息”作为新建 Harness Session 的理由。

Harness Session 的默认绑定单位是：

```text
TASK_ID + EXECUTION_LINEAGE_ID + WORKSPACE
```

而不是：

```text
Codex Conversation = Harness Session
```

也不是：

```text
每次 start_run = 新 Harness Session
```

在同一执行链中，只要已有 Session 已完成、Workspace 一致、仍可继续并且不要求隔离，后续 `start_run` MUST 显式传入已有 `sessionId`。

## 2. 固定策略值

```text
HARNESS_SESSION_POLICY : REUSE | NEW | FRESH
```

- `REUSE`：继续已有已完成 Session，`start_run(sessionId=<existing>)`。
- `NEW`：创建新的普通执行 Session；必须记录 `SESSION_NEW_REASON`。
- `FRESH`：为独立验证/Reviewer 创建隔离 Session；与 NEW 一样不传旧 `sessionId`，但只允许最小 Review/Handoff 上下文。

`FRESH` 是隔离语义，不代表 Bridge 提供“fork”。MUST NOT 把它描述成 Harness Session Fork。

## 3. 默认规则：REUSE 优先

以下情况默认 `REUSE`：

```text
同一个 TASK_ID
+ 同一个 EXECUTION_LINEAGE_ID
+ 同一个 Workspace
+ 上一个 Session 已完成且当前未 running
```

典型包括：

- Explorer → Worker 的顺序执行；
- 实现 → 测试；
- 测试失败 → 局部修复 → 再测试；
- Codex Review 后要求同一问题 REWORK；
- 用户在同一目标下追加实现细节；
- 同一执行链仅增补/替换与核心边界兼容的 Harness Skill；
- 同一 Bug 的继续调查；
- 同一 Capability Bootstrap 的连续诊断步骤；
- 同一 Revision lineage 中的后续 bounded 修改；
- 用户在同一个 Harness Session 中直接完成局部工作后，再返回 Codex（同步 Delta 后继续复用）；
- 用户在 Harness 中做了明确 `HARNESS_USER_OVERRIDE` 后，Codex Review/Normalization 再继续同一 lineage。

MUST NOT 因以下原因单独新建 Session：

- Codex 用户又发了一条消息；
- Logical Role 名称变化；
- `wait_run_until_terminal` 已经返回；
- Harness Web 当前显示上一轮已完成；
- Task Contract 有轻微补充，但核心 GOAL 未改变；
- Codex 要求 Worker 根据刚才结果继续处理同一问题。

## 4. NEW 的允许条件

仅在以下任一条件成立时 SHOULD / MUST `NEW`：

1. 新的独立 `TASK_ID` / 用户目标已经语义独立；
2. Workspace 改变；
3. 前一个 Session 不存在、不可恢复或 Bridge 返回 unknown session；
4. 前一个 Session 仍 running，而当前节点必须并行执行；
5. 任务进入新的安全/权限边界，不应继承旧工具上下文；
6. Session 已严重污染、包含明显无关历史，继续复用预计会降低正确性；
7. Provider/Profile/Runtime 发生不兼容变化，使旧 Session 不再安全；
8. Skill 变化改变核心方案/安全边界/权限语义，旧 Session 会造成明显污染；
9. Task Graph 中真正独立的并行 branch 需要自己的 Session；
10. 用户明确要求全新会话/隔离上下文。

任何 `NEW` MUST 记录：

```text
SESSION_NEW_REASON
PARENT_TASK_ID（若有关联）
PARENT_SESSION_ID（若有关联）
```

MUST NOT 仅记录“new task”而不说明语义边界。

## 5. FRESH 的强制条件

以下情况默认 `FRESH`：

- 独立 Reviewer；
- Anti-Anchoring Review；
- 明确要求 fresh context 的安全/审计检查；
- 需要验证“不了解 Worker 推理历史时是否仍能发现问题”的独立检查。

Fresh Reviewer MUST NOT 继承 Worker Session。

Reviewer 首轮只能接收 `verification-review.md` 定义的 REVIEW_PACKET，不接收 Worker 长篇 rationale。

## 6. ORCHESTRATED 模式的 Session 拓扑

默认建立一个 Primary Execution Session：

```text
TASK_ID T-104
└─ EXECUTION_LINEAGE_ID main
   └─ PRIMARY_SESSION_ID H-123
```

顺序节点 SHOULD 复用 Primary：

```text
Explorer → Worker → Integrator → Tester → Rework
                 H-123
```

如果 Explorer/Researcher/Worker 需要真正并行：

```text
main        → H-123
branch-a    → H-201
branch-b    → H-202
review      → H-301 (FRESH)
```

每个 branch 自己内部继续复用自身 Session。

并行 branch 收敛时，Integrator MUST 接收 branch 的压缩 Result/Evidence；MUST NOT 假设 Primary Session 自动知道其他 Session 的对话历史。

## 7. Task / Session Ledger

Codex MUST 在当前任务运行态维护 Session Ledger；Bridge 同时 MUST 维护进程外 Durable Run Ledger。

当前 Task Ledger 最小结构：

```yaml
TASK_ID: T-104
WORKSPACE: <absolute path>
PRIMARY_LINEAGE_ID: main
PRIMARY_SESSION_ID: H-123
LAST_RUN_ID: R-9
LAST_DURABLE_RUN_ID: DR-9
LAST_REVISION_ID: rev-4
LAST_LANGUAGE_SYNC_MODE: MIRROR_USER
LAST_RESPONSE_LOCALE: <resolved locale>
LAST_SKILL_BINDINGS: <ids + digests + roles>
```

`start_run` MUST 传 `taskId` / `executionLineageId`，Bridge 返回的 `durableRunId / runId / sessionId / sessionReused` MUST 写回当前 Task Ledger。

进程外恢复规则见 `durable-run-recovery.md`。MUST NOT 把真实 sessionId/runId 写回发布 Skill 源文件。

## 8. start_run 调用门禁

每次 `start_run` 之前：

```text
1. Resolve TASK_ID
2. Resolve EXECUTION_LINEAGE_ID
3. 查当前 Task/Session Ledger
4. 若 Codex/Bridge 曾重启或 runId 不可见 → 先执行 Durable Run Recovery
5. 只有确认不存在可恢复 Run 后，才选择 HARNESS_SESSION_POLICY
6. REUSE → 传已有 sessionId
7. NEW/FRESH → 不传旧 sessionId，并记录原因
8. 按 `language-affinity.md` 解析并传 languageSyncMode + responseLocale
9. 若有 `SKILL_ASSIGNMENT`，按 `skill-routing.md` 解析 harnessRole + skillInputs；Codex-only Skill 不得放入 Bridge skillInputs
10. 若 Session cursor 超过 `lastSyncedEventSeq`，MUST 先 `sync_session_delta + ack_session_sync`；
11. start_run 必须传 taskId + executionLineageId
12. 返回后立即记录 durableRunId/runId/sessionId/sessionReused/languageSyncMode/responseLocale/skillBindings
```

如果同一执行链存在 `DETACHED_RUNNING`，MUST NOT `start_run`；应恢复原 Run 并继续等待。

若计划 `REUSE` 但 Bridge 返回 `sessionReused=false` 或恢复后的 Session/Workspace 不匹配，MUST 标记 `SESSION_CONTINUITY_BROKEN`，并进入 Verification/Escalation；MUST NOT 默默宣称上下文已继承。

## 9. Session / Run Recovery

恢复优先级：

```text
Current Task Ledger
→ Durable Run Ledger
→ Harness persisted Session
→ Continuity Packet + NEW（最后手段）
```

当前 Bridge 进程的 `list_runs` 不是持久索引。Codex/Bridge 重启后 MUST 使用 `list_durable_runs / recover_run / recover_pending_runs`。Terminal Result 被当前 Codex 成功接收后 SHOULD 调用 `ack_run`；ACK 仅代表“已交付”，不等于 PASS。完整规则见 `durable-run-recovery.md`。

## 10. Continuity Packet

当同一 TASK_ID 因合理原因必须 NEW，但仍需要继承任务事实时，Codex MUST 发送压缩 Continuity Packet：

```text
TASK_ID
PARENT_SESSION_ID
GOAL
CONFIRMED_DECISIONS
CURRENT_REVISION
RELEVANT_EVIDENCE
UNRESOLVED
INVARIANTS
NEXT_ACTION
```

MUST NOT 为了补上下文把完整旧 Harness 对话重新复制进新 Session。

Fresh Reviewer 是例外：只发送 REVIEW_PACKET，不发送 Worker 的 `CONFIRMED_DECISIONS` 中带有说服性/解释性内容。

## 11. Session 生命周期与防膨胀

REUSE 优先不等于永久复用。

以下情况 SHOULD 结束当前 lineage 并在后续独立任务 NEW：

- `FINAL_STATUS=PASS/FAILED/BLOCKED` 且用户目标已结束；
- 新请求与原 GOAL 无直接实现连续性；
- Session 中无关历史明显超过当前任务相关历史；
- Context contamination 已成为风险；
- Workspace/Provider 安全边界改变。

MUST NOT 使用一个 Harness Session 承载整个项目所有历史。

## 12. Rework / Retry

同一方案内的 `REWORK` MUST 默认 `REUSE` 原执行 lineage。

只有以下情况才 NEW：

- Codex 已推翻原方案并重新定义任务；
- 旧 Session 上下文会强烈锚定已否定方案；
- 新工作需要独立并行 branch。

普通测试失败与局部 Retry MUST NOT 创建新 Session。

## 13. Capability Bootstrap Session

Capability Bootstrap 可以使用专用 lineage，例如：

```text
capability:<capability-id>
```

同一次 Bootstrap 的 Discovery → Registration → Verify SHOULD 复用该 lineage Session；完成后不应把它作为业务 Worker 的长期 Primary Session，除非 Task Contract 明确需要连续继承其诊断上下文。


## 14. Long-poll 不改变 Session Affinity

`wait_run_until_terminal` 只是等待同一个 Run 的 Bridge-side primitive，不创建 Harness Session，也不改变 `TASK_ID / EXECUTION_LINEAGE_ID / sessionId` 映射。

- long-poll terminal 返回 → 后续同 lineage 的新 `start_run` 仍按本文件 `REUSE` 规则显式传原 `sessionId`。
- long-poll timeout → 当前 Run 仍在运行，MUST NOT 另建 Session 绕过等待；继续 long-poll 或诊断当前 Run。
- MCP Host/Tool transport timeout 也不等于 Harness Run terminal；必须先根据原 `runId` 恢复状态，禁止因此生成新的 execution lineage/session。
- Fresh Reviewer 仍然按 `FRESH` 新 Session，不因 long-poll 优化而复用 Worker Session。


## 15. Language Affinity

Session 连续性与语言连续性分离。用户在同一个 `TASK_ID/lineage/sessionId` 中从中文切换为英文（或反向）时，MUST 复用原 Session，并在下一次 `start_run` 使用新的 `responseLocale`；MUST NOT 因语言变化 NEW。已经运行中的旧 Run 继续保持提交时 Locale。详细规则见 `language-affinity.md`。

## 16. Skill Affinity

Skill Assignment 与 Session Affinity 是正交维度：

- Role 改变导致注入不同 Role Skill，不等于必须 NEW；
- 同一 Session 的后续 Run MUST 重新明确当前 `harnessRole + skillInputs`，不能假设上一轮 Skill 自动成为永久 Session policy；
- 兼容的 Skill revision/增补默认可 `REUSE`；
- 若 Skill revision 改变核心架构、安全/权限边界、关键 Invariant 或会强烈锚定已否定方案，Codex MAY 选择 `NEW`，并记录 `SESSION_NEW_REASON=SKILL_CONTEXT_INCOMPATIBLE`；
- Fresh Reviewer 只接收 Reviewer/Shared Skill，不自动继承 Worker-only Skill。

Bridge 返回的 `skillBindings` 是“该 Run 实际转交了哪些 Skill”的事实来源；Task Ledger SHOULD 记录 id + SHA256 + role，用于后续 Review。


## 15. Bidirectional Sync Integration

Session Affinity 与 Context Sync 共享同一个绑定单位：

```text
TASK_ID + EXECUTION_LINEAGE_ID + WORKSPACE + SESSION_ID
```

用户直接在 Harness 工作不会自动导致 NEW。Codex 回流时：

```text
get_session_cursor
→ UNSYNCED ? sync_session_delta : continue
→ ack_session_sync
→ REUSE 原 sessionId
```

若会话完全由 Harness-first 创建：

```text
list_persisted_sessions
→ adopt_session
→ Delta Sync
→ 后续纳入正常 Session Affinity
```

## 16. SESSION_SYNC_REQUIRED Gate

如果 Bridge 在复用旧 `sessionId` 前发现 Harness event cursor 已超过 Codex 的 `lastSyncedEventSeq`，默认返回：

```text
SESSION_SYNC_REQUIRED
```

Codex MUST 先执行 `sync_session_delta → absorb → ack_session_sync`，再继续 `start_run(sessionId=<same>)`。`allowUnsyncedSession=true` 仅供用户明确要求的紧急人工 Override，不得作为正常路径。
