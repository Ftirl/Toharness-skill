# Decision Authority / User Override

## 权责层级

```text
USER
  ↓
CODEX Supervisor
  ↓
HARNESS Runtime
```

该层级约束 Agent 默认自主权限，不限制用户本人。用户可以在 Codex 或 Harness 任一入口显式改变方向。

## Decision Class

```text
LOCAL_EXECUTION
DIRECTIONAL_DECISION
SYSTEM_DECISION
```

### LOCAL_EXECUTION

通常允许 Harness 自主处理：

- 既定方案内实现
- 小 Bug
- 参数/样式调整
- 局部重构
- 补测试/日志分析
- 不改变接口/架构/验收的机械修改

### DIRECTIONAL_DECISION

Harness Agent 自主发现需要改变算法、数据流、实现方向或跨模块约束时，默认 SHOULD Escalate 给 Codex。

### SYSTEM_DECISION

架构、范围、安全边界、权限、关键依赖、Task Contract、Acceptance Criteria、不可逆风险变化，Harness Agent 默认 MUST Escalate。

## User Override

如果**用户本人**直接在 Harness 明确要求 DIRECTIONAL/SYSTEM 决策：

```text
CONTROL_OWNER = HARNESS_USER_OVERRIDE
OVERRIDE_REVIEW_STATE = PENDING
```

Harness MAY 按用户明确要求继续执行。MUST NOT 因“超出 Harness 默认 Agent 权限”而阻断用户授权本身。

必须记录：

```text
DECISION_SOURCE = HARNESS_USER
PREVIOUS_DIRECTION
NEW_DIRECTION
AFFECTED_SCOPE
TESTS / EVIDENCE
UNRESOLVED
```

如果用户没有明确授权，而是 Harness Agent 自己想越级，则仍按默认 Escalation。

## 返回 Codex

当用户之后回到 Codex：

1. MUST 先读取 Cursor/Delta。
2. MUST 以当前 Workspace/Harness 状态为现实基线。
3. MUST NOT 自动回滚用户在 Harness 明确授权的修改。
4. Codex 重新把现实状态纳入 Contract/Risk/Invariant/Acceptance。

Codex 可记录：

```text
ACCEPT
ACCEPT_WITH_NORMALIZATION
REVISE
```

对应持久状态：

```text
ACCEPTED
ACCEPTED_WITH_NORMALIZATION
REVISED
```

### ACCEPT

用户在 Harness 的决定直接进入主线。

### ACCEPT_WITH_NORMALIZATION

方向保留，但 Codex 补齐架构、接口、测试、Contract 或风险控制。

### REVISE

Codex 基于新证据提出进一步调整；这不是否定用户权限，而是在当前现实状态上继续决策。

## Control Owner

```text
CODEX
HARNESS
HARNESS_USER_OVERRIDE
```

- `CODEX`：当前处于规划/架构/Review/升级处理。
- `HARNESS`：当前处于局部执行阶段。
- `HARNESS_USER_OVERRIDE`：用户在 Harness 直接做了超出默认 Harness Agent 权限的决定，并允许其继续执行。

Control Owner 可以切换，不要求新 Session。

## 不变量

```text
Harness direct interaction != Harness gains permanent supervisor authority
User override != Agent autonomous override
Context sync != approval
Codex review != automatic rollback
Language change != new Session
Control owner change != new Session
```
