# S5 — Contracts / Planning

Harness 委派时加载。DIRECT_CODEX 的纯本地推理任务无需加载完整 Contract 模块。

## 1. Minimum Sufficient Context

Codex 只提供完成任务所需的最小充分上下文。MUST NOT 默认发送：

```text
完整聊天历史
完整推理记录
全 Repository
无关日志
无关 Memory
无关 Skill
```

Harness SHOULD 自行获取机械执行所需上下文。

## 2. Contract Level

```text
LIGHT
→ L0 / 明确 L1
→ RISK=LOW
→ VERIFIABILITY=HIGH
→ 无复杂共享写入 / 无不可逆副作用

STANDARD
→ 普通 L1 / L2
→ 或 RISK=MEDIUM
→ bounded write / 局部 Debug / 状态验证

STRICT
→ L3 / L4
→ 或 RISK=HIGH
→ 或 VERIFIABILITY=LOW
→ 或 REVERSIBILITY=IRREVERSIBLE
→ 或 ORCHESTRATED 且存在多个写节点 / 共享资源
```

高等级条件优先。

## 3. LIGHT_CONTRACT

```text
TASK_ID
EXECUTION_LINEAGE_ID
HARNESS_SESSION_POLICY
LANGUAGE_SYNC_MODE
RESPONSE_LOCALE
SKILL_ASSIGNMENT（如有）
CONTROL_OWNER
CONTEXT_SYNC_STATE
DURABLE_RUN_ID（恢复已有 Run 时）
GOAL
SCOPE
RISK
VERIFIABILITY
REQUIRED_CAPABILITIES
ACCEPTANCE_TESTS
RETURN_FORMAT
```

## 4. STANDARD_CONTRACT

```text
TASK_ID
EXECUTION_LINEAGE_ID
HARNESS_SESSION_POLICY
LANGUAGE_SYNC_MODE
RESPONSE_LOCALE
SKILL_ASSIGNMENT（如有）
CONTROL_OWNER
CONTEXT_SYNC_STATE
DURABLE_RUN_ID（恢复已有 Run 时）
GOAL
CONTEXT
ORCHESTRATION_MODE
TASK_LEVEL
RISK
VERIFIABILITY
REQUIRED_CAPABILITIES
FILES_ALLOWED
FILES_FORBIDDEN
INVARIANTS
IMPLEMENTATION_REQUIREMENTS
ACCEPTANCE_TESTS
ESCALATE_WHEN
RETURN_FORMAT
```

SHOULD 携带：

```text
DECISION_DENSITY
EXECUTION_VOLUME
REVERSIBILITY
IDEMPOTENT
TOOL_BUDGET
```

## 5. STRICT_CONTRACT

STANDARD 全部字段 +：

```text
FILE_OWNERSHIP
RESOURCE_OWNERSHIP
PRE_STATE_REQUIREMENT
ROLLBACK / RECOVERY EXPECTATION
REVIEW_POLICY
REVISION_REQUIREMENT
PARALLELISM_BOUNDARY
```

如果进入 ORCHESTRATED，继续读取 `roles-task-graph.md`。

所有 Harness Contract MUST 与 `session-affinity.md` 和 `language-affinity.md` 一起解析；存在 Skill Assignment 时还 MUST 解析 `skill-routing.md`：

- `start_run` MUST 传 `TASK_ID + EXECUTION_LINEAGE_ID` 以建立 Durable Run Identity；
- 同一 `TASK_ID + EXECUTION_LINEAGE_ID` 默认 `HARNESS_SESSION_POLICY=REUSE`；
- 只有新独立任务、并行 branch、隔离边界或 Fresh Reviewer 才 `NEW/FRESH`；
- 若选择 `NEW/FRESH`，Contract MUST 携带 `SESSION_NEW_REASON`；
- 如果存在 detached/durable run，MUST 先恢复原 Run，不能通过 NEW 绕过；
- 如果因合理原因 NEW 但仍属于同一 TASK_ID，MUST 携带压缩 Continuity Packet，不得复制完整旧对话；
- `start_run` MUST 传 `LANGUAGE_SYNC_MODE + RESPONSE_LOCALE`；默认 `MIRROR_USER`；
- Result Contract 的结构化 key 保持英文，用户可读 value 使用 `RESPONSE_LOCALE`；
- 用户切换语言不构成 Session NEW 的理由。
- 复用已绑定 Session 前若 `CONTEXT_SYNC_STATE=UNSYNCED`，MUST 先执行 `sync_session_delta → absorb → ack_session_sync`。
- 用户直接在 Harness 明确做出越级方向决定时，Contract MUST 接受 `CONTROL_OWNER=HARNESS_USER_OVERRIDE`，后续由 Codex Review/Normalization，而不是自动回滚。

## 6. Acceptance Tests

SHOULD 使用可验证形式，例如：

```text
Input → Expected Output
Pre-state → Action → Expected Post-state
Revision → Check → Expected Evidence
```

Worker MAY 增加测试，但 MUST NOT 删除或弱化 Contract 中的验收要求。

## 7. Durable Delivery

`start_run` SHOULD 始终携带稳定 `TASK_ID / EXECUTION_LINEAGE_ID`。返回的 `DURABLE_RUN_ID` 属于运行态索引，不应写入长期 Skill。若恢复到 terminal-but-unacknowledged Result，Codex 在成功接收 Result Contract 后 SHOULD `ack_run`，但 Review/PASS 仍按 `verification-review.md` 独立执行。


## 8. Skill Assignment Contract

用户指定 Skill 时，Contract MUST 明确 Runtime ownership，而不是只列 Skill 名称：

```yaml
SKILL_ASSIGNMENT:
  codex:
    required:
      - id: <skill-id>
        source: INSTALLED | PATH | ATTACHMENT | INLINE
        read_scope: [SHARED, CODEX]

  harness:
    required:
      - id: <skill-id>
        target: HARNESS | SHARED
        source: PATH | ATTACHMENT | INLINE
        transfer_mode: SNAPSHOT | REFERENCE | INLINE
        apply_to_roles: [WORKER]
        required: true
```

详细输入/转发规则 MUST 读取 `skill-routing.md`；文件 scope 规范读取 `skill-file-spec.md`。

Codex MUST NOT 为了委派而默认把 Harness Skill execution body 展开进自身上下文。Harness Required Skill 无法转发时返回 `BLOCKED`。


## 9. Context Return Contract

用户从 Harness 回到 Codex 时，Codex MUST 先建立一个 bounded Context Return：

```text
SESSION_ID
FROM_EVENT_SEQ
THROUGH_EVENT_SEQ
ORIGIN
USER_REQUESTS
CHECKPOINTS
ERRORS
LINKED_DURABLE_RUNS
CONTROL_OWNER
OVERRIDE_REVIEW_STATE
```

默认只传 compact delta。完整历史不是 Contract 字段。若 Harness-first Session 尚未绑定，先 `adopt_session`。
