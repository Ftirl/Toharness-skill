# S1 — Task Intake

仅在 `S1` 加载。建立 `TASK_PROFILE`；不要在这里检查 Bridge。

## TASK_PROFILE

```text
TASK_ID
EXECUTION_LINEAGE_ID
GOAL
CONTEXT
TASK_LEVEL
DECISION_DENSITY
EXECUTION_VOLUME
VERIFIABILITY
RISK
REVERSIBILITY
REQUIRED_CAPABILITIES
```

 `TASK_ID` 标识用户目标级任务；`EXECUTION_LINEAGE_ID` 标识该任务内一条连续执行链。Harness 委派时两者用于 Session Affinity；如果任务尚未拆 branch，默认 lineage 为 `main`。

## TASK_LEVEL

| LEVEL | 定义 | Codex 前置产出 | 执行倾向 |
|---|---|---|---|
| `L0` | 机械执行、低推理、高可验证 | 无 | 优先 Harness |
| `L1` | Specification 明确 | 定义边界 | Harness 实现 |
| `L2` | 普通 Debug | `Observed / Expected / Likely Scope` | Harness 调查与实现 |
| `L3` | 复杂逻辑 | `Root Cause Model / Algorithm / Invariants / Boundary Conditions` | Harness 执行 |
| `L4` | 架构与高层设计 | Codex 主导设计 | Harness 只做 Research / Explore / Implementation / Testing |

## DECISION_DENSITY

```text
LOW | MEDIUM | HIGH
```

表示任务中有多少步骤需要真正决定“应该怎么做”，而不是按已确定方案执行。

## EXECUTION_VOLUME

```text
LOW | MEDIUM | HIGH
```

读取大量文件、调用大量 Tool、批量修改、Build、Tests 通常属于高 Execution Volume。

## VERIFIABILITY

```text
LOW | MEDIUM | HIGH
```

- `HIGH`：可通过明确测试、Schema、编译、Hash、确定性输出验证。
- `MEDIUM`：机器证据充分，但仍需人工/主控判断部分语义。
- `LOW`：主要依赖设计、长期行为、视觉/语义判断或难以穷举的状态。

## REQUIRED_CAPABILITIES

先写能力，不写产品名。示例：

```text
repository.read
repository.write
test.run
artifact.generate
browser.control
external.search
asset.modify
```

若 Risk 不是明显 LOW，或可逆性/副作用不清，继续读取 `risk-policy.md`。


## Skill Assignment Intake

若用户指定 Skill，TASK_PROFILE SHOULD 追加：

```text
SKILL_ASSIGNMENT
SKILL_TARGETS
SKILL_REQUIRED_STATE
```

Skill 是执行/决策知识输入，不自动等价于 Capability。需要外部工具的 Skill 仍必须单独进入 `REQUIRED_CAPABILITIES`。
