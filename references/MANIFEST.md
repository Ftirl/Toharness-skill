# Module Manifest

本文件用于维护模块边界；正常执行由根 `../SKILL.md` 的状态机驱动，MUST NOT 为“完整”一次性加载全部模块。

```text
S0 → context-resolution.md
      └─ 已绑定 Harness 有直接交互 / 回流 → bidirectional-context-sync.md + decision-authority.md
S1 → task-intake.md
      ├─ Risk 非显然 / MEDIUM / HIGH → risk-policy.md
      └─ 指定 Skill / Skill file/path → skill-routing.md → skill-file-spec.md (按需)
S2 → root SKILL Gate
S3 → bridge.md                              (Harness mode only)
      ├─ Codex/Bridge restart / detached run → durable-run-recovery.md
      ├─ 复用已有 Harness → existing-harness-bridge.md
      └─ 新设备/缺 Bridge → bootstrap.md + compatibility.json
S4 → capability-resolution.md
      └─ not READY → capability-bootstrap.md
S5 → contracts.md + session-affinity.md + language-affinity.md    (Harness delegation)
      ├─ 有 SKILL_ASSIGNMENT → skill-routing.md
      └─ cross-runtime-skill/v1 文件 → skill-file-spec.md
      └─ ORCHESTRATED → roles-task-graph.md
S6/S7 → verification-review.md             (有 Result/Revision/外部状态/非低风险时)
END + telemetry enabled → telemetry.md
Router maintenance only → governance.md
```

## 常驻与条件模块

- `SKILL.md`：唯一常驻执行内核。
- `compatibility.json`：仅 Bridge/Bootstrap/兼容诊断时读取；不参与普通任务规划。
- `bootstrap.md` / `existing-harness-bridge.md`：只在 S3 对应条件触发。
- `session-affinity.md`：仅 Harness 委派时加载；控制 REUSE/NEW/FRESH 与 Task→Session Ledger。
- `language-affinity.md`：仅 Harness 委派时加载；控制 MIRROR_USER/FIXED/AUTO、Locale 解析、Bridge 语言同步与恢复语义。
- `skill-routing.md`：仅用户指定 Skill 或 Contract 存在 Skill Assignment 时加载；控制 Codex/Harness/Role Skill ownership 与转交。
- `skill-file-spec.md`：仅处理跨 Runtime Skill 文件 scope/输入规范时加载；普通 installed Skill 不需要。
- `durable-run-recovery.md`：仅跨 Codex/Bridge 进程恢复、未知旧 runId、detached run 时加载。
- `bidirectional-context-sync.md`：Harness 直接用户交互需要回流 Codex、复用 Session 前发现 UNSYNCED activity、或用户从 Harness 返回 Codex 时加载。
- `decision-authority.md`：出现 Harness 直接用户决策、越级人工 Override、Control Owner 切换或 Codex 回流 Review 时加载。
- `verification-review.md`：简单纯推理/低量只读 `DIRECT_CODEX` 可不加载。
- `telemetry.md`：任务结束且启用统计时加载。

Runtime 验证历史、run/session ID、端口、机器路径和凭据 MUST NOT 存在于发布 Skill 中。

- Host-wait enforcement: Codex MCP `tool_timeout_sec >= 3700`; legacy `wait_run` hidden from the local Adapter tool catalog.


## V10.1 Runtime Packaging

- `vendor/deepseek-harness-for-codex/`：canonical embedded Bridge runtime，正常 Bootstrap/注册必须以此为底本。
- `assets/bridge/`：仅旧版升级兼容镜像；不得作为新协议的唯一 source of truth。
- `references/compatibility.json` + `vendor/.../VENDOR_MANIFEST.json`：共同锁定 adapter version、上游 base 与 runtime hash。
