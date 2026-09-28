# Durable Run Recovery / Detached Reattach

按需加载：Codex/Bridge 进程曾中断、`runId` 在当前 MCP 进程不可见、或需要恢复上一次尚未结束/已经结束但结果尚未被 Codex 接收的 Harness 任务时读取。

## 1. 目标

Codex/Bridge 生命周期 MUST 与 Harness 执行生命周期解耦。

```text
Codex / Bridge 退出
!=
Harness Run 取消
```

只有显式 `cancel_run` / `stop_service` 才表示取消意图。控制端断开时，正在运行的 Harness 任务 SHOULD 继续执行。

## 2. Durable Run Identity

Bridge 在 `start_run` 返回前 MUST 持久化：

```text
DURABLE_RUN_ID
RUN_ID
TASK_ID
EXECUTION_LINEAGE_ID
WORKSPACE
SESSION_ID
START_EVENT_SEQ
LANGUAGE_SYNC_MODE
RESPONSE_LOCALE
HARNESS_ROLE
SKILL_BINDINGS（metadata/digest only）
WEB_URL / connection metadata
STATE
DELIVERY_STATE
TIMESTAMPS
```

持久 Ledger 只保存索引与边界，MUST NOT 复制完整 Harness 对话、Reasoning、Tool Log 或 Secret。

Ledger 默认位于 Bridge 的持久 data directory，由 Runtime 管理；发布 Skill MUST NOT 写入真实 run/session ID。

## 3. Durable Run State

```text
SUBMITTED
ACTIVE
DETACHED_RUNNING
COMPLETED
DETACHED_COMPLETED
FAILED
CANCELLED
RECOVERY_REQUIRED
RECOVERED

RUN_DELIVERY_STATE:
UNACKNOWLEDGED | ACKNOWLEDGED
```

Bridge 进程消失时无法可靠写终态也没关系：下一进程 MUST 以 Harness 持久 Session 为事实来源重新判定。

## 4. Restart Recovery Order

Codex 新进程在当前 Workspace 第一次需要 Harness 时：

```text
1. Bridge READY
2. list_durable_runs(workspace, includeTerminal=false)
3. 如存在 ACTIVE/detached 或 terminal-but-UNACKNOWLEDGED 候选 → recover_pending_runs(workspace, taskId/lineage when known)
4. 对每个恢复结果分类：
   running   → DETACHED_RUNNING → 继续 wait_run_until_terminal(原 runId)
   succeeded → DETACHED_COMPLETED → 直接读取重建结果 → Codex Review → 当前 Codex 接收后 ack_run
   failed    → 恢复失败结果 → Codex 决策
5. 只有确认没有可恢复 Run，才允许为同一执行链 start_run NEW
```

MUST NOT 因当前 `list_runs` 为空就断言旧任务不存在；`list_runs` 只是当前 Bridge 进程索引。

## 5. In-progress Reattach

若 `recover_run` / `recover_pending_runs` 发现 Harness Session 仍 `running`：

- MUST 重新把原 `runId` 挂入当前 Bridge；
- MUST 保持原 `sessionId`、`TASK_ID`、`EXECUTION_LINEAGE_ID`、`START_EVENT_SEQ`；
- MUST NOT 再发送原 Task Prompt；
- MUST NOT 创建新 Harness Session；
- SHOULD 直接对原 `runId` 调用 `wait_run_until_terminal`。

这称为：

```text
DETACHED_RUNNING → REATTACHED_RUNNING
```

## 6. Completed-while-detached Recovery

若 Codex 离线期间 Harness 已完成：

```text
DETACHED_RUNNING
→ Harness completes
→ Codex restart
→ recover_run
→ 从 Session Event Log 的 START_EVENT_SEQ 之后重建 assistant output
→ DETACHED_COMPLETED
```

MUST NOT 为了取得结果再次 Prompt Harness “请总结刚才结果”。结果恢复应是只读数据恢复，不产生新的模型 Turn。

## 7. Result Boundary

同一 Harness Session 可以包含多个 Turn，因此恢复 MUST 依赖持久边界：

```text
SESSION_ID + START_EVENT_SEQ + TURN_NUMBER / TURN_START_SEQ / TURN_END_SEQ
```

若未来 Harness 提供稳定 Turn ID，MAY 使用 Turn ID 替代/补充 Sequence Boundary。

恢复只能把 `START_EVENT_SEQ` 之后、属于该次 Run 的事件作为 Result Evidence。

## 8. Auto Recovery by runId

如果新的 Codex 上下文仍保留旧 `runId`，`get_run` / `wait_run_until_terminal` SHOULD 自动尝试 Durable Ledger rehydrate，而不是立即返回 `Unknown runId`。

若自动恢复成功，调用方无需额外 `recover_run`。

## 9. Recovery by Task Identity

如果旧 `runId` 丢失，但仍知道：

```text
TASK_ID + EXECUTION_LINEAGE_ID + WORKSPACE
```

Codex SHOULD 调用 `list_durable_runs` / `recover_run` 查回对应 Run。

存在多个无法可靠消歧的候选时 MUST NOT 猜测；返回候选并由 Codex 基于任务上下文选择。

## 10. Current-process vs Durable Index

```text
list_runs
= 当前 MCP Bridge 进程已挂载的 Run

list_durable_runs
= 跨 Bridge/Codex 进程持久的 Task→Run→Session 索引
```

恢复场景 MUST 优先使用 Durable Index。

## 11. Cancellation Semantics

以下行为 MUST NOT 自动取消 Harness：

- Codex UI/CLI 被关闭；
- MCP stdio 断开；
- Codex 进程崩溃/被结束；
- long-poll Tool Call 被外层 Host timeout；
- Bridge 当前进程丢失内存 Run Map。

只有显式：

```text
cancel_run
stop_service
```

才表示主动停止意图。

## 12. Session Affinity Integration

Durable Recovery 优先级高于创建新 Session：

```text
同一 TASK_ID / lineage
→ 当前 Session Ledger
→ Durable Run Ledger
→ Harness persisted Session recovery
→ Continuity Packet + NEW（最后手段）
```

`NEW` 不能作为恢复失败前的默认行为。

## 13. Delivery Acknowledgement

Harness Run 的执行终态与结果交付状态 MUST 分离。

```text
COMPLETED + UNACKNOWLEDGED
```

表示 Harness 已完成，但不能证明 Codex 已经收到/保存结果。`recover_pending_runs` MUST 继续恢复这类记录。

只有当前 Codex 已成功取得并纳入本次任务上下文后，才 SHOULD 调用：

```text
ack_run(durableRunId/runId)
```

ACK 仅表示“结果已交付给 Codex”，MUST NOT 被解释为最终 `PASS`、Review 通过或用户批准。若 Codex 在 terminal result 返回后、ACK 前再次崩溃，下一进程重复恢复同一结果是允许且安全的。


## 14. Language Metadata Recovery

Durable Run Ledger MUST 持久化该 Run 提交时的 `languageSyncMode / responseLocale`。`recover_run` / `recover_pending_runs` MUST 原样恢复并返回这两个字段。

- 仍在运行：继续等待原 Run，MUST NOT 为改变语言重新 Prompt。
- 已完成：恢复原 assistant output；MUST NOT通过二次翻译覆盖持久结果。
- 新的后续 Run 才按当前用户消息重新解析 Locale。


## 15. Skill Metadata Recovery

Durable Run Ledger MUST 保存该 Run 实际使用的 `harnessRole + skillBindings` 元数据：Skill id、target、transfer mode、role scope、SHA256、byte length，以及必要的 reference/snapshot identifier。

MUST NOT 把完整 Skill 正文复制进 Durable Run Ledger。原 Run 恢复时不重新注入 Skill，因为该 Skill 已经属于原 Harness Turn；`skillBindings` 只用于审计和确认“该结果是在什么 Skill Assignment 下产生的”。

后续新的 Rework Run 若需要同一 Skill，Codex 应按当前 Task Contract 再次解析/转发；如果源文件 digest 已变化，应视为新的 Skill revision，而不是假设与旧 Run 相同。


## 16. Session Sync Ledger Recovery

Durable Run Recovery 与 `session-sync.json` 独立但协同：

- `durable-runs.json` 回答“原 Run/Session 是什么、执行/交付到哪”；
- `session-sync.json` 回答“Codex 已经吸收到 Harness Session 的哪个 event seq”。

Codex/Bridge 重启后 MUST 同时保留两者。恢复原 Run 不代表 Harness direct activity 已同步；恢复完成后若 session cursor 超过 sync cursor，仍需 `sync_session_delta`。


## 17. Turn-isolated Result Boundary

V10 SHOULD 以该 Run 首个 `turn/start` 与同 turn 的 `turn/end` 作为终止边界。即使用户在原 Run 结束后立刻通过 Harness Web 继续新一轮输入，后续 Turn MUST NOT 被吸收到旧 Run 的 `assistantText / lastEventSeq / ack_run` 范围。
