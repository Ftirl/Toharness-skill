# S0 — Context Resolution

仅在 `S0` 加载。本模块负责解析当前任务有效上下文；不进行 Bridge、Capability 或执行决策。

## Context 优先级

```text
Current User Request
↓
Current Workspace / Project Context
↓
Task-specific Instructions
↓
Current Capability State
↓
Relevant Memory
↓
General Defaults
```

旧记忆 MUST NOT 覆盖当前明确要求。

## Memory 的角色

Memory MAY 影响：用户常用工作方式、默认工具偏好、常见项目结构、开发习惯、输出格式偏好、常见约束、长期工作流选择。

Memory MUST NOT：

```text
绕过当前任务要求
覆盖用户当前明确指令
自动授权高风险操作
替代实际 Capability Check
假设某个 MCP / Provider 当前仍然可用
```

Memory 提供 `Preference`，不是 `Execution Truth`。

## 不为用户硬编码 Router

MUST NOT 因某个用户长期使用某类工具，就在 Router 中写“该用户所有任务默认使用 X”。个性化发生在 Context Resolution，不进入 Global Routing Rules。

## S0 输出

S0 输出一个最小有效上下文，供 S1 使用。SHOULD 排除无关旧日志、无关历史方案和与当前目标无关的 Memory。


## Conversation Locale

S0 SHOULD 同时解析当前用户自然语言环境，供后续 Harness Language Affinity 使用：

```text
LANGUAGE_SYNC_MODE = MIRROR_USER（默认）
CONVERSATION_LOCALE
RESPONSE_LOCALE
```

优先使用当前用户明确语言要求与当前用户消息的主要自然语言；代码、日志、API/Tool 名称不参与主要语言判定。当前用户消息中文为主时 SHOULD 输出 `zh-CN`；英文为主时 SHOULD 输出 `en`。若用户明确要求固定语言，可设 `LANGUAGE_SYNC_MODE=FIXED`。Harness 模式的详细规则见 `language-affinity.md`。


## Skill Input Context

用户显式说“Codex 使用 Skill A / Harness 使用 Skill B”、上传 Skill 文件、给出 Skill 路径或粘贴 Skill 正文时，S0 MUST 把它记录为 `SKILL_ASSIGNMENT` 候选，而不是把所有 Skill 当作普通背景文本。

Harness-target Skill 不应默认全量进入 Codex Working Context；只保留 routing metadata，并按 `skill-routing.md` 读取 Codex/Shared 覆盖部分。


## Harness-return Context

如果当前用户提到“刚才在 Harness 里”“继续 Harness 的修改”“从 Harness 接回来”或当前 Task 已绑定 Harness Session，S0 SHOULD 先检查 Context Sync metadata：

```text
SESSION_ID
lastSyncedEventSeq
latestEventSeq
CONTROL_OWNER
OVERRIDE_REVIEW_STATE
```

有 `UNSYNCED` activity 时，MUST 加载 `bidirectional-context-sync.md`；方向/架构/验收发生人工 Harness Override 时同时加载 `decision-authority.md`。Memory 或旧 Codex Task State MUST NOT 覆盖更新后的 Harness/Workspace 现实状态。
