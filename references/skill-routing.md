# Skill Routing / Skill Affinity

按需加载：用户显式指定 Codex/Harness Skill、提供 Skill 文件/路径/正文，或 Task Contract 含 `SKILL_ASSIGNMENT` 时读取。

## 1. 目标

Skill 必须按 Runtime/Role 分工，而不是因为 Codex 能看到文件就全部加载进 Codex 上下文。

```text
User Skill Input
↓
Skill Resolution
├─ CODEX  → Codex 只读 CODEX + SHARED scope
├─ HARNESS → Codex 只做路由/完整性检查；Bridge 转交 Harness
└─ SHARED → Codex 读 CODEX + SHARED；Harness 读 HARNESS + SHARED + role scope
```

核心原则：

```text
Codex = Decide / Plan / Review
Harness = Execute
Skill Assignment MUST preserve this boundary
```

Harness-target Skill 的执行正文 MUST NOT 因“方便”被 Codex 全量消费后自行执行。

## 2. 固定标识符

```text
SKILL_TARGET        : CODEX | HARNESS | SHARED
SKILL_SOURCE        : INSTALLED | PATH | ATTACHMENT | INLINE
SKILL_TRANSFER_MODE : SNAPSHOT | REFERENCE | INLINE
SKILL_STATE         : UNRESOLVED | RESOLVED | FORWARDED | BLOCKED
SKILL_READ_SCOPE    : METADATA | CODEX | HARNESS | SHARED | ROLE
```

## 3. Skill Assignment

Task Contract MAY / SHOULD 在用户指定 Skill 时包含：

```yaml
SKILL_ASSIGNMENT:
  codex:
    required:
      - id: architecture-guidance
        source: INSTALLED
        read_scope: [SHARED, CODEX]

  harness:
    required:
      - id: domain-execution
        source: PATH
        target: HARNESS
        apply_to_roles: [WORKER, TESTER]
        transfer_mode: SNAPSHOT
        path: <user supplied path>
```

Codex 与 Harness Skill Registry MUST 被视为不同 Registry；同名 Skill 不表示同一文件或相同职责。

## 4. Codex Read Budget

对 `TARGET=HARNESS`：

- 对符合规范的本地文件，Codex SHOULD 优先调用 `scripts/skill_view.py --target codex` 获取裁剪视图，而不是读取全文；
- Codex SHOULD 只读取 frontmatter / metadata / scope index；
- 若文件符合 `skill-file-spec.md`，Codex MAY 再读取 `[SHARED]` 与 `[CODEX]` section；
- Codex MUST NOT 为了理解执行细节而默认读取 `[HARNESS]` / `[ROLE:*]` 全文；
- 文件无 scope 标记且用户已明确它是 Harness Skill 时，正文默认视为 `HARNESS`，Codex 只做可读性/路径/大小/摘要元数据检查，然后转交。

对 `TARGET=SHARED`：Codex 只读取 `[SHARED] + [CODEX]`，Harness 接收 `[SHARED] + [HARNESS] + 当前 Role`。

对 `TARGET=CODEX`：Codex 正常加载；MUST NOT 自动转发 Harness，除非用户另行指定 `SHARED`。

“Codex 不读取 Harness execution section”是上下文消费约束，不是安全边界；如果 Harness Skill 与更高优先级用户/系统/Task Contract 冲突，Task Contract 优先。

## 5. 用户输入方式

支持三类用户体验：

### A. 用户上传 Skill 文件

Codex SHOULD：

1. 保留原文件，不改写正文；
2. 获取/物化一个 Bridge 可读取的稳定路径，但不需要先把全文读进模型上下文；
3. 按 `ATTACHMENT → PATH` 交给 Bridge；
4. 默认使用 `SNAPSHOT`，让 Bridge 计算 SHA256 并保存内容快照后转交 Harness。

### B. 用户提供本机 Skill 路径

Codex SHOULD 直接把该路径作为 `PATH` 输入给 Bridge。若路径位于 Workspace / 配置允许根之外，只有当该路径是用户明确提供/批准时，才可设置 `externalPathApproved=true`。

### C. 用户直接粘贴 Skill 正文

Codex 将其视为 `INLINE` payload。即使文本已经出现在 Codex 对话中，Codex 仍 MUST 按 Skill Target 限制后续职责使用；Bridge 将正文转交 Harness。

## 6. Bridge Forwarding Contract

Harness Skill 通过 `start_run.skillInputs[]` 转交。每项最小字段：

```text
id
target = HARNESS | SHARED
sourceType = PATH | INLINE
transferMode = SNAPSHOT | REFERENCE | INLINE
applyToRoles[]
required
path OR content
expectedSha256 (optional)
externalPathApproved (PATH outside allowed roots only)
```

Bridge MUST：

- 校验文件存在、为 regular file、大小受限；
- 计算 SHA256；
- `SNAPSHOT`：保存 content-addressed 本地快照，并把内容注入该 Harness Turn；
- `REFERENCE`：只传经验证的 canonical path，由 Harness 自行读取；
- `INLINE`：直接注入该 Turn；
- 返回 `skillBindings`，包含 id/target/role/digest/transfer metadata，但 MUST NOT 回显完整 Skill 正文；
- Durable Run Ledger 只持久化 Skill 元数据与 digest，不复制完整 Skill 正文。

## 7. Role-aware Routing

`start_run.harnessRole` 指明本 Run 的逻辑角色。Skill 可用 `applyToRoles` 限定：

```text
ALL
EXPLORER
RESEARCHER
WORKER
INTEGRATOR
TESTER
REVIEWER
CAPABILITY_BOOTSTRAP
```

Bridge 只把与当前 Role 匹配的 Skill 注入该 Run，以减少 Harness context。

Reviewer 默认只接收 Reviewer/SHARED Skill；MUST NOT 因 Worker Skill 存在而自动注入 Worker execution guidance，避免破坏 Fresh Review。

## 8. Precedence

Skill 不得扩大任务边界。优先级：

```text
System / Safety
>
Current User Request
>
Task Contract / Scope / Risk / Ownership
>
Shared Skill Constraints
>
Runtime-target Skill
>
Role Skill
>
Skill Defaults
```

若 Skill 要求与 Contract 冲突，Harness MUST `ESCALATE`，不得偷偷按 Skill 扩展权限、文件范围或副作用。

## 9. Session / Durable Integration

Skill Assignment 不决定是否 NEW Session。

- 同一 Task/Lineage 的 Skill 小幅增补 → 默认 `REUSE`；
- Skill 改变导致核心方案、安全边界或执行语义不兼容 → Codex MAY NEW，并记录原因；
- Durable Run 已提交后 Codex 崩溃 → 恢复原 Run 时 MUST NOT 再次注入/重发 Skill；Skill 已是原 Harness Turn 的一部分；
- `skillBindings` 元数据随 Run Snapshot/Durable Ledger 恢复，用于审计原 Run 当时加载了哪些 Skill。

## 10. Failure Policy

Required Skill 出现以下任一情况：

```text
missing
unreadable
hash mismatch
oversize
invalid source combination
external path not user-approved
```

→ `BLOCKED`，MUST NOT 静默跳过或换成相似 Skill。

Optional Skill MAY 跳过，但 Result 必须在 `UNRESOLVED/RISKS` 中说明。
