# Harness Language Affinity / Locale Sync

按需加载：只要任务将委派给 Harness，MUST 与 `contracts.md`、`session-affinity.md` 一起读取。目标是让 Harness 的**用户可见自然语言**与当前 Codex 用户对话语言同步，同时保持协议字段、代码和技术标识稳定。

## 1. 固定策略

```text
LANGUAGE_SYNC_MODE : MIRROR_USER | FIXED | AUTO
```

默认：

```text
LANGUAGE_SYNC_MODE = MIRROR_USER
```

- `MIRROR_USER`：Harness 跟随当前用户自然语言；中文对话→中文，英文对话→英文。
- `FIXED`：由当前任务/项目明确固定 `RESPONSE_LOCALE`。
- `AUTO`：仅兼容回退；允许 Harness 自行判断。MUST NOT 作为 Router 默认。

## 2. Locale 来源优先级

解析 `RESPONSE_LOCALE` 时：

```text
当前用户明确指定的输出语言
↓
当前用户消息的主要自然语言
↓
当前 Codex Conversation Locale
↓
同一 Task/Session 最近一次 Locale
↓
Relevant Memory / User Preference
↓
General Default
```

语言判断只看用户自然语言意图；MUST 忽略代码、日志、API 名、文件内容、Tool Schema 中大量英文造成的偏差。

例如：

```text
“帮我检查这个 C++ function 的 lifetime issue”
→ RESPONSE_LOCALE = zh-CN
```

## 3. Bridge 调用

Harness `start_run` MUST 传：

```text
languageSyncMode
responseLocale
```

正常默认：

```text
languageSyncMode = MIRROR_USER
responseLocale = <S0 resolved locale>
```

Bridge MUST 把语言指令注入该次 Harness Turn，并返回/持久化：

```text
languageSyncMode
responseLocale
```

`MIRROR_USER` / `FIXED` 若缺少 `responseLocale`，Bridge SHOULD 拒绝静默执行，避免退回英文。

## 4. 什么必须跟随 Locale

以下 Harness 用户可见自然语言 MUST 使用 `RESPONSE_LOCALE`：

- progress / status updates；
- findings；
- clarification questions；
- implementation summaries；
- test summaries；
- risks / unresolved explanations；
- final result 中的人类可读值。

MUST NOT 要求或暴露私有 chain-of-thought；本规则只约束用户可见内容。

## 5. 什么保持原样

以下内容 MUST NOT 因语言同步被翻译或改名，除非用户明确要求：

```text
code
identifiers
file paths
commands
API / Tool / MCP names
raw error messages
protocol keys
structured field names
```

因此 Result Contract SHOULD 保持：

```yaml
STATUS: SUCCESS
SUMMARY: |
  已完成目标文件修改，并通过测试。
EVIDENCE:
  - 12 个测试全部通过
```

而不是把 `STATUS / SUMMARY / EVIDENCE` 翻译成不同字段名。

## 6. Session Affinity 集成

Language Affinity 与 Session Affinity 正交。

- 同一 Session 后续 Run 默认继承最近 Locale，但每次新 `start_run` MUST 以当前用户语言重新解析。
- 用户中途切换语言，不构成 `NEW/FRESH` Session 的理由。
- 继续同一 Session 时，可从本 Turn 起更新 Locale。
- `FRESH` Reviewer 仍使用新的 Session，但 Reviewer 输出 Locale 仍跟随当前用户。

Task/Session Ledger SHOULD 记录：

```text
LAST_LANGUAGE_SYNC_MODE
LAST_RESPONSE_LOCALE
```

## 7. Durable Run Recovery 集成

一个已经提交的 Durable Run 的语言属于该 Run 的不可变执行元数据。

Codex/Bridge 重启后：

```text
recover_run
→ 恢复该 Run 原 languageSyncMode / responseLocale
→ running：继续等待原 Run，不发送新语言 Prompt
→ completed：按原始输出恢复结果
```

MUST NOT 为了改变语言而重发正在运行的旧任务。若用户在恢复后切换语言，新的后续 Run 可使用新 Locale；旧 Run 的原始 Result 保持其提交时 Locale。

## 8. Language Continuity Check

如果 Harness 明显违反 `MIRROR_USER/FIXED`，标记：

```text
LANGUAGE_AFFINITY_BROKEN
```

处理原则：

- 不因此创建新 Session；
- 若仍需 Harness 后续工作，在同一 lineage 下一 Run 重新声明 Locale；
- Codex 最终可按当前用户语言呈现结果，但 SHOULD 保留技术字面量；
- 若人工复核 Harness Web 是验收要求，语言不匹配 MAY 触发 `REWORK`。

## 9. 推荐抽象

```text
Execution Affinity
├─ Workspace Affinity
├─ Session Affinity
├─ Durable Run Affinity
└─ Language Affinity
```


## 10. Bidirectional Sync

Harness direct user turns 的 Delta 保持原始用户可见语言；Bridge 不为了同步重新翻译。Codex 根据当前 Conversation Locale 解释/呈现，但 evidence literal SHOULD 保持原文。Language change 不影响 sync cursor，也不要求新 Session。
