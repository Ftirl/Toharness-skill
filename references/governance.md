# Router Governance / Rule Ownership

仅在修改 Router、Bridge 基础接入、Capability Skill 规则或协议本身时加载。普通业务任务 MUST NOT 加载。

## 1. 规则归属

| 变化来源 | 修改位置 | 不应修改 |
|---|---|---|
| 某 Provider 的 API、Tool 名称、安装方法、版本兼容 | Capability Skill / Provider Skill | AGENTS.md / Router 核心状态机 |
| Bridge 接口变化 | `bridge.md` + `compatibility.json`（若影响 Adapter/Runtime 兼容） | 各 Capability Skill |
| MCP Client 基础兼容策略变化 | `capability-bootstrap.md` + `compatibility.json` | 无关 Provider Skill |
| Gate / Role / Review / Contract 规则变化 | Router 对应 reference + 必要的 SKILL 核心入口 | 具体 Provider 配置 |
| 系统级原则 | AGENTS.md | Provider Skill |
| 用户个性化 | Memory / Context | Router Core |

## 2. 分层

```text
AGENTS.md          = System Constitution
Toharness          = Orchestration Protocol
Capability Skill   = Reusable Domain/Capability Knowledge
Provider Skill     = Provider-specific Knowledge
Memory / Context   = Personal Adaptation
DeepSeek Harness   = Execution Runtime
MCP / Tools        = External Capability
```

## 3. 通用性

未来任何 MCP / Tool / API / IDE / DCC / Database / Browser / Cloud Service / Local Program，只要能声明：

```text
Capabilities
Provider
Authentication
Verification
Risk
```

即可接入，不应要求修改核心 AGENTS.md。

## 4. 最终设计原则

MUST NOT 围绕具体模型、软件、MCP 或用户设计 Router。

MUST 围绕：

```text
Goal | Context | Decision Density | Capability | Risk | Execution | Evidence | Review
```


## 5. Compatibility / Runtime History

`references/compatibility.json` 只保存可发布的兼容策略与经过验证的包版本，不保存某台机器的 run/session、端口、项目路径或认证数据。真实运行历史属于 runtime state backend，默认不进入 Skill 发布包。

修改 bundled Bridge 后 MUST 更新 canonical `vendor/deepseek-harness-for-codex/VENDOR_MANIFEST.json` 与 `PROVENANCE.md` 的版本/SHA256，并同步 `assets/bridge` 兼容镜像后运行 `scripts/validate.py`。

## Session Runtime State

Task→Harness Session Ledger 属于 runtime state，不属于发布 Skill source。MUST NOT 将真实 `sessionId` / `runId` 固化进 references。协议变更可以修改 `session-affinity.md`，运行实例只更新 Ledger/backend。

## Public identity

```text
PUBLIC_SKILL_NAME = Toharness
UPSTREAM_BRIDGE   = DeepSeek Harness for Codex
MCP_SERVER_NAME   = deepseek-harness
```

Public Skill identity MUST remain separate from the upstream Bridge/MCP compatibility identity.
