---
skill_schema: cross-runtime-skill/v1
name: example-cross-runtime-skill
version: 1
default_target: SHARED
codex_read_scope: [SHARED, CODEX]
harness_read_scope: [SHARED, HARNESS, ROLE]
---

# Example Cross-Runtime Skill

## [SHARED]
- 定义所有 Runtime 都必须遵守的术语、边界、不可违反约束。
- Skill 不能扩大 Task Contract 的文件范围、权限、风险或副作用。

## [CODEX]
- Codex 只在这里读取规划、架构、验收与 Review 指南。
- 不在这里描述机械执行步骤。

## [HARNESS]
- Harness 在这里读取执行、工具调用、实现与调试规范。
- 不替代 Codex 做最终架构/验收决策。

## [ROLE:WORKER]
- Worker 的实现规则。

## [ROLE:TESTER]
- Tester 的验证规则。

## [ROLE:REVIEWER]
- Reviewer 的独立审查规则；保持 fresh-context，不继承 Worker rationale。
