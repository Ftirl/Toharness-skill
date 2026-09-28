# Cross-Runtime Skill File Specification v1

用于同一 Skill 文件同时声明 Codex / Harness / Role 的可读范围。该规范是推荐格式；legacy Skill 仍可通过 `TARGET=HARNESS` 原样转发。

## 1. 文件类型

推荐 UTF-8 Markdown：

```text
*.md
*.skill.md
```

Bridge 对 PATH/INLINE 内容按 UTF-8 文本处理。二进制 Skill 文件不属于本规范。

## 2. Frontmatter

推荐：

```yaml
---
skill_schema: cross-runtime-skill/v1
name: example-skill
version: 1
default_target: HARNESS
codex_read_scope: [SHARED, CODEX]
harness_read_scope: [SHARED, HARNESS, ROLE]
---
```

`default_target` 只作为未显式 Assignment 时的建议；用户/Task Contract 的 `SKILL_TARGET` 优先。

## 3. Scope Sections

使用以下一级或二级标题标签：

```markdown
## [SHARED]
所有 Runtime 都必须遵守的事实、边界、术语、接口约束。

## [CODEX]
只供 Codex 做规划、风险判断、验收和 Review 的内容。

## [HARNESS]
只供 Harness 执行实现、工具调用、调试、测试的内容。

## [ROLE:WORKER]
仅 Worker 使用。

## [ROLE:TESTER]
仅 Tester 使用。
```

允许 Role：

```text
EXPLORER
RESEARCHER
WORKER
INTEGRATOR
TESTER
REVIEWER
CAPABILITY_BOOTSTRAP
```

## 4. Read Rules

```text
Codex target view:
frontmatter + [SHARED] + [CODEX]

Harness target view:
[SHARED] + [HARNESS] + matching [ROLE:*]

Harness MUST ignore [CODEX] as execution instruction.
Codex MUST NOT默认消费 [HARNESS]/[ROLE:*] execution body.
```

Bridge 当前负责可靠转交和 Role 过滤，不把 Markdown section parser 当作安全边界。Harness 会收到明确 scope directive。为了达到最强 Token 隔离，Codex SHOULD 使用包内 `scripts/skill_view.py`，只把自己的 section 输出到模型上下文：

```bash
python scripts/skill_view.py --file <skill.md> --target codex
python scripts/skill_view.py --file <skill.md> --target harness --role WORKER
```

第一个命令只输出 frontmatter、preamble、`[SHARED]`、`[CODEX]`；不会输出 `[HARNESS] / [ROLE:*]`。Legacy Harness-only Skill 对 Codex 只返回 metadata/omitted marker。

## 5. Legacy Skill

如果没有 `skill_schema` 或 scope 标签，并且 Assignment 已明确：

```text
TARGET=HARNESS
```

则：

```text
entire body = HARNESS execution content
Codex view = metadata / routing only
```

如果目标未声明且文件也无 routing metadata，Codex MUST 请求/推断最保守 assignment；无法安全判断时 `BLOCKED`，不要同时加载给两边。

## 6. File Input Envelope

用户上传文件或提供路径最终规范化为：

```yaml
id: domain-skill
target: HARNESS
sourceType: PATH
path: <canonical-or-user-path>
transferMode: SNAPSHOT
applyToRoles: [WORKER]
required: true
expectedSha256: <optional sha256>
externalPathApproved: false
```

Inline：

```yaml
id: domain-skill
target: HARNESS
sourceType: INLINE
content: <skill markdown>
transferMode: INLINE
applyToRoles: [WORKER]
required: true
```

## 7. Transfer Modes

### SNAPSHOT — 默认推荐

Bridge 读取文件、计算 SHA256、保存 content-addressed cache，并将 snapshot 内容注入当前 Harness Turn。

优点：
- 原路径之后变化也不影响已提交 Run；
- 可审计 digest；
- Codex 不必把全文读入自己的模型上下文。

### REFERENCE

Bridge 只验证并传 canonical path；Harness 按路径读取。

适用于大 Skill 或希望避免把文件正文放入 Harness prompt 的情况。路径在 Run 生命周期中 MUST 保持可访问。

### INLINE

正文直接注入。适用于用户粘贴的小 Skill。

## 8. Size / Integrity

默认 Bridge 限制：

```text
单 Skill <= 512 KiB
单 Run 所有注入 Skill 总计 <= 1 MiB
最多 16 个 Skill input
```

`expectedSha256` 提供时 MUST 匹配；不匹配直接 `BLOCKED`。

## 9. Example

见 `templates/cross-runtime-skill.template.md`。
