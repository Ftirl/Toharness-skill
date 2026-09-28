# Risk Policy

按需加载：Risk 明显为 MEDIUM/HIGH、可逆性不清、涉及共享/外部状态、需要 Dry Run/Retry/Reviewer 决策时读取。

## 1. Risk 的作用

`RISK` 是控制防护投入的总开关，影响：

- Orchestration Mode；
- Contract Level；
- Dry Run；
- Retry；
- Fresh Reviewer；
- Escalation 与 Final Review 深度。

## 2. 两层 Risk 模型

```text
协议层 → 通用 Risk Floor
Capability / Provider Skill → 领域细化，可提高或精细化
Codex → 处理真正无法判断的语义与例外
```

MUST NOT 因缺少领域 Skill 就自动 Escalate。

## 3. 通用 Risk Floor

```text
LOW
→ Read Only；或
→ 仅修改隔离/自有资源，范围有限、可完整恢复、无共享/公开/权限副作用

MEDIUM
→ 有限写入但可恢复；或
→ PARTIALLY_REVERSIBLE；或
→ 影响共享/外部状态但有明确回滚；或
→ 批量范围较大但影响边界清晰

HIGH
→ 不可逆且具有实质影响；或
→ Authentication / Permission / Security Boundary 变化；或
→ 修改生产、公开、共享关键状态且失败影响他人；或
→ destructive delete / overwrite 且无经过验证的恢复路径；或
→ Provider / Capability Skill 明确标记 HIGH
```

## 4. 强制规则

```text
REVERSIBILITY=IRREVERSIBLE
→ RISK >= MEDIUM
→ 若影响共享/外部关键状态且无恢复路径 → HIGH

REVERSIBILITY=PARTIALLY_REVERSIBLE
→ RISK >= MEDIUM，除非 Codex 有明确可追溯的降级理由

修改共享资源 / 他人可见状态
→ RISK >= MEDIUM

Authentication / Permission / Security Boundary 变化
→ RISK = HIGH

RISK=HIGH
→ MUST NOT 使用最轻 Review
```

每次 Risk 定级 MUST 可追溯到通用判据、领域判据或 Codex 裁决。

## 5. 领域 Risk Skill

Capability / Provider Skill MAY / SHOULD 声明：

```text
RISK_GRADING
HIGH_RISK_OPERATIONS
REVERSIBILITY_MAP
RISK_INPUTS
```

领域规则 MAY 提高 Risk，MAY 细化 Review / Dry Run；MUST NOT 静默降低通用 Risk Floor。

## 6. Risk Semantics Unknown

没有领域 Risk 规则时：

```text
通用 Risk Floor 可明确分类
→ 直接使用；MUST NOT 仅因缺少领域判据 Escalate

无法确认是否修改外部/共享状态、是否可逆、是否涉及权限边界
→ STATUS: ESCALATE
→ ESCALATION_REASON: Risk Semantics Unknown
```
