# Bidirectional Context Sync

## 目的

让同一个工作任务可以在两个入口之间往返而不丢状态：

```text
Codex → Harness
Harness Web 中用户直接继续工作
Harness → compact delta → Codex
Codex 再做决策/Review → Harness
```

主控制关系仍然是 `CODEX_SUPERVISED`；本模块只增加 Harness→Codex 的状态回流，不建立第二个 Supervisor。

## 核心原则

1. Harness Session 的 durable event log 是事实来源；MUST NOT 复制完整 conversation database。
2. Codex 只保存同步游标和 compact state，不保存整段 Harness 历史。
3. 同步优先级：`metadata → delta/checkpoint → evidence drilldown`。
4. 默认 MUST NOT 重新读取完整 Harness Session。
5. `Context synchronization != decision approval`。
6. 用户直接在 Harness 的明确要求属于 `HARNESS_USER` activity；Agent 自主行为与用户授权 MUST 区分。

## 持久 Sync Ledger

Bridge 在进程外维护 `session-sync.json`，每个已绑定 Session 至少记录：

```text
workspace
sessionId
lastSyncedEventSeq
lastSeenEventSeq
controlOwner
overrideReviewState
decisionClasses
updatedAt
```

它只记录游标/元数据，不存完整消息正文。

## 三层同步

### Level 1 — Metadata

```text
get_session_cursor
list_unsynced_sessions
```

只回答：当前 Harness cursor 是否超过 Codex 已 ACK 的 cursor。

### Level 2 — Compact Delta

```text
sync_session_delta
```

默认只返回 `lastSyncedEventSeq` 之后的 bounded packet：

```text
USER_REQUESTS
ASSISTANT_OUTPUTS
CONTEXT_CHECKPOINTS
TOOL_CALL_NAMES
ERRORS
EVENT_TYPE_COUNTS
EVENT_REFS
LINKED_DURABLE_RUNS
```

默认字符预算由 Bridge 限制，目标是大约 `800–1500 tokens` 量级。若超预算，返回 truncated/drilldown 指示，而不是把整个 Session 塞给 Codex。

### Level 3 — Evidence Drilldown

```text
read_session_events
```

仅当 Codex 对某个具体决定、错误、输出需要证据时使用。MUST 使用窄范围，不得把它当作默认同步路径。

## ACK

Codex 成功吸收 Delta 后调用：

```text
ack_session_sync
```

它推进 `lastSyncedEventSeq`，并可记录：

```text
CONTROL_OWNER
OVERRIDE_REVIEW_STATE
DECISION_CLASS
```

`ack_session_sync != PASS`。

## 复用 Session 前门禁

如果旧 Harness Session 的 current cursor 大于 `lastSyncedEventSeq`：

```text
start_run(sessionId=old)
→ SESSION_SYNC_REQUIRED
```

正常路径必须：

```text
sync_session_delta
→ Codex absorb/update Task State
→ ack_session_sync
→ start_run(sessionId=old)
```

只有明确的紧急人工 Override 才可 `allowUnsyncedSession=true`。

## 直接 Harness 工作的来源识别

Bridge 通过 event seq 与 Durable Run range 进行确定性分类：

```text
事件落在已知 Run boundary 内 → CODEX_DELEGATED
Run boundary 外的新 user/message → HARNESS_USER
两者同时存在 → MIXED
```

这不是语义决策，只是 provenance 分类。

## CONTEXT_CHECKPOINT

由 Codex 创建/接管的 Harness Session SHOULD 在每个 substantial turn 的最终输出附加简短 checkpoint：

```text
CONTEXT_CHECKPOINT
REQUEST:
DECISIONS:
CHANGES:
TESTS:
UNRESOLVED:
DIRECTION_OR_ACCEPTANCE_CHANGED:
```

Checkpoint 是同步优化，不是唯一数据源。缺少 checkpoint 时仍可从 durable events 做 Delta。

## Token 规则

MUST 优先：

```text
Cursor check → no change → 0 history import
Cursor advanced → compact delta
Delta insufficient → narrow drilldown
```

MUST NOT：

```text
每次返回 Codex 都重读完整 Session
每次让 Codex自己总结全部 Harness Event
```
