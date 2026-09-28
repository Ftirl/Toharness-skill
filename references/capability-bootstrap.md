# S4 子流程 — Capability Bootstrap

只有 Capability 非 READY 时加载。MUST NOT 在所有任务开始时预加载本模块。

## 1. 固定顺序

```text
Provider Discovery
↓
Provider Provisioning
↓
Runtime Registration
↓
Authentication
↓
Runtime Reload
↓
Safe Probe
↓
READY
```

MUST NOT 跳步或调换顺序。

## 2. Provider Discovery

先确定 Provider 是否已经存在，MUST NOT 直接安装。

```text
PROVIDER_STATE: UNKNOWN | MISSING | INSTALLED | RUNNING | BROKEN
```

## 3. Provider Provisioning

只有 Provider 真正不存在时才安装/初始化。

具体方法优先来自 Provider Skill / Tool Documentation / Current Environment；MUST NOT 把具体第三方 Provider 安装方法硬编码进 Toharness。

## 4. Runtime Registration

Provider 已存在但 Harness 尚未连接时执行 Registration。

```text
Provider Running + Harness Registration Missing
→ 只注册，MUST NOT 重新安装 Provider

Harness Registered + Provider Offline
→ Provider 侧问题，MUST NOT 当作注册缺失处理
```

## 5. MCP Client

对 MCP SHOULD 优先使用 Harness 当前支持的官方 MCP Client `@deepseek-ai/dsh-mcp-client`，但 MUST NOT 锁死 Client 版本；先检测 Harness Version / Active Profile / Existing MCP Client，再选择 Runtime-compatible 版本。

MCP Client 只负责连接外部 MCP Server 并把工具注册到 Harness Tool Registry；它不负责下载第三方 Provider、初始化 Provider 数据、创建云账号或监管独立 HTTP 服务。因此 Provider Provisioning 与 Harness Registration MUST 保持分离。

Transport 按 Provider 声明使用 `stdio` 或 `streamable-http`，MUST NOT 自行改变；`serverName` MUST 在当前注册作用域唯一并满足 Provider/Runtime 当前约束。

## 6. 配置安全

Runtime 配置 MUST 增量修改；MUST NOT 覆盖整个 Profile；MUST 保留其他 MCP、Plugin、Runtime Configuration。

Secret：

```text
MUST NOT 把 Token 写进 Skill
MUST NOT 把 API Key 写进 Repository
MUST NOT 在日志回显 Secret
MUST NOT 把 OAuth Secret 放进 Task Contract
```

只声明需要什么 Credential。

## 7. Runtime Reload

Registration 改动要求重载时，由 Codex/Bridge 协调。MUST NOT 让正在运行的 Harness Agent 杀死自己。

## 8. Safe Probe

Registration 后 MUST 验证：

```text
Read Only
No Side Effects
Repeatable
No user-data mutation
```

只有 Safe Probe PASS 才能标记 Capability READY。

## 9. Registry Update

验证后增量更新 Registry：

```text
capability
provider
provider_version
runtime
runtime_profile
scope
status
verified_at
config_fingerprint
tool_registry_fingerprint
verification
```

配置写入、Provider 更新、Profile/Auth/Tool Registry 变化后 MUST NOT 沿用旧 READY 证据。

## 10. Scope / Tool Budget

作用域优先：

```text
TASK → PROJECT → PROFILE → USER
```

MUST NOT 无必要把项目专用 Provider 注册到全局。

每个 Run MUST 限制 `ACTIVE_CAPABILITIES`，只启用当前任务需要的 Tool，降低 Tool Schema Context 与 Tool Selection Noise。
