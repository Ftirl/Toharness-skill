# ORCHESTRATED — Logical Roles / Task Graph

只有 `ORCHESTRATION_MODE=ORCHESTRATED` 时加载。

## 1. Logical Roles

| 角色 | 职责 | 约束 |
|---|---|---|
| `Explorer` | 文件、状态、Tool、Capability、Dependency、Existing Implementation 发现 | `READ_ONLY` |
| `Researcher` | API、SDK、Provider、External Facts、Compatibility、Documentation | `READ_ONLY`，主要输出 Evidence |
| `Worker` | 实际修改与 Bounded Execution | MUST 定义 `WRITE_SCOPE` |
| `Integrator` | 合并多个 bounded Worker 输出，执行机械/可判定整合，生成统一 Revision | MUST NOT 自行做架构/算法/需求语义决策 |
| `Tester` | 产生 Verification Evidence | MUST NOT 决定最终 PASS |
| `Reviewer` | Fresh-context Challenge | `READ_ONLY`；MUST NOT 修复自己的 Finding |

角色与模型解耦。

## 2. Integrator

使用条件：多个 Worker 产生可独立实现、但需要统一 Revision 的结果。

Integrator MAY：

- 检查 Ownership；
- 合并无语义冲突的变更；
- 机械处理 import / formatting / deterministic merge；
- 生成统一 Revision；
- 将冲突事实压缩给 Codex。

Integrator MUST NOT：

- 决定新架构；
- 替换核心算法；
- 修改用户目标或 Invariant；
- 在两个本质不同方案间自行选择。

出现 `Semantic Integration Conflict` → `STATUS: ESCALATE`。

## 3. Task Graph

复杂任务形成 DAG。每个节点 MUST 包含：

```text
ID
ROLE
DEPENDS_ON
READ_SCOPE
WRITE_SCOPE
CAPABILITIES
SKILLS
ACCEPTANCE
```

典型：

```text
Explore ──────┐
              ├→ Plan → Worker(s) → Integrator? → Tester → Reviewer
Research ─────┘
```

MUST NOT 为了“多 Agent”人为制造并行。

## 4. Parallelism

允许并行：

- Read-only Exploration；
- Research；
- 独立 Test；
- 不同 Ownership 的 Worker。

写任务前 MUST 检查 File Ownership 与 External Resource Ownership。

## 5. Resource Ownership

不仅文件需要 Ownership。任何共享可变资源 MAY 声明：

```text
file
database
asset
external document
workspace state
remote resource
```

原则：

```text
One File = One Active Writer
同一可变资源默认 Single Writer
```

多个 Worker 需要修改同一可变资源 → MUST 改为串行，或重新拆分任务。

## 6. Session Affinity by Role

本模块的 Role 分离不等于 Session 分离。默认规则来自 `session-affinity.md`：

```text
Explorer → Worker → Integrator → Tester → Rework
同一顺序执行 lineage SHOULD REUSE 同一个 Primary Session
```

- Explorer 结束后进入同一 Worker，MUST NOT 仅因 Role 变化新建 Session。
- Tester 对同一实现做连续验证时 SHOULD REUSE；测试失败后的 Worker REWORK MUST 默认 REUSE。
- 真正并行 branch 必须拥有独立 Session，因为同一 Harness Session 不能同时承载多个 active run；branch 内部继续 REUSE。
- Integrator 收敛多个 branch 时接收各 branch 的压缩 Result/Evidence，MUST NOT 假设 Primary Session 自动继承其他 branch 历史。
- Reviewer MUST 使用 `FRESH` Session，不复用 Worker/Primary Session。

每个 Task Graph 节点 SHOULD 额外标记：

```text
EXECUTION_LINEAGE_ID
HARNESS_SESSION_POLICY
SESSION_ID（运行后记录）
SKILL_ASSIGNMENT（该 Role 需要时）
```

Role Skill 解析遵循 `skill-routing.md`。Bridge 的 `harnessRole` MUST 与 Task Graph 节点 `ROLE` 一致；只有 `applyToRoles` 匹配该 Role 的 Harness Skill 才应注入当前 Run。Fresh Reviewer 不得自动继承 Worker execution Skill。



## 7. Role Output Language

所有逻辑角色的用户可见自然语言遵循 `language-affinity.md`。Role 切换不得改变 Locale，也不得因为 Locale 改变而拆 Session。Fresh Reviewer 虽然使用 `FRESH` Session，但仍使用当前 `RESPONSE_LOCALE`。


## Direct Harness User Work

`HARNESS_USER_OVERRIDE` 不是新的 Logical Role。它是 Control/Authority metadata。用户在 Harness 直接修改期间可继续使用当前 Worker/Tester 等 Role；回到 Codex 后通过 Delta Sync 将结果重新并入 Task Graph。Control Owner 切换本身不要求新 Session 或新 Role。
