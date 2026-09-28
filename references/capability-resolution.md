# S4 — Capability Resolution

仅在任务需要外部/Runtime Capability 时加载。

## 1. Capability-first

```text
任务
→ REQUIRED_CAPABILITIES
→ Capability Registry
→ Provider Selection
→ Capability Check
```

Capability ID SHOULD 描述能力而不是产品。一个 Capability MAY 有多个 Provider。

Provider 可以是 MCP / CLI / API / Local Script / Repository Tool / Filesystem Tool / Native Tool。MUST NOT 假设所有能力都来自 MCP。

MCP 是 Capability Transport / Interface，不是系统本体。MUST NOT 把所有 Tool Schema 永久加载进 Codex。

## 2. Capability Registry

Registry 是能力状态缓存与证据索引，不是永久真相。推荐记录：

```yaml
capability:
  id: <capability-id>
provider:
  id: <provider-id>
  type: mcp | cli | api | script | native
  server_name: <name>
  version: <version-or-unknown>
runtime:
  id: <runtime>
  version: <version-or-unknown>
  profile: <profile-or-default>
scope: TASK | PROJECT | PROFILE | USER
status: <CAPABILITY_STATE>
verification:
  safe_probe: <probe-id-or-method>
  verified_at: <timestamp>
  freshness_window: <duration-or-policy>
  config_fingerprint: <hash-or-version>
  tool_registry_fingerprint: <hash-or-version>
```

Registry MUST NOT 包含 Secret。

### Registry Backend

Registry 是逻辑接口，不要求本协议硬编码物理路径。默认行为：

```text
SESSION backend
→ 当前 Codex/Harness 协作会话内存态
→ 无持久 backend 时 MUST 使用此模式
→ 新会话首次使用 Capability 时重新 Probe

PROJECT / PROFILE / USER backend
→ MAY 由 Workspace policy、Runtime 或外部 Registry Provider 提供
→ 物理路径/数据库位置 MUST 由该 backend 自己声明
→ Toharness MUST NOT 猜测固定路径
```

任何持久 backend MUST：原子写入；不保存 Secret；保存 scope/fingerprint/verified_at；配置或认证边界变化时使缓存失效。若没有可用持久 backend，MUST 降级为 SESSION，而不是伪装成跨会话 READY。

### Registry Invalidation

下列变化 MUST 使相关 `READY → UNKNOWN`：

```text
Provider version changed
Runtime profile changed
Runtime / Provider config fingerprint changed
Authentication expired / changed
Tool Registry changed
Safe Probe failed
Provider endpoint / transport changed
```

Session/TASK scoped registration 在 Runtime Restart 后 MUST 重新验证。

Persistent PROJECT/PROFILE/USER registration 在 fingerprint 未变化时 MAY 复用缓存，但超过 freshness window 后首次使用 MUST Safe Probe。

SHOULD 使用惰性再验证：只在任务真正需要 Capability 时 Probe，MUST NOT 为维护 Registry 主动扫描全部 Provider。

## 3. Provider Selection

选择依据：

```text
Availability | Reliability | Risk | Authentication | Scope
| Cost | Tool Context Cost | User Preference | Existing Workspace State
```

Memory MAY 提供偏好，但 MUST 服从当前任务和当前 Capability State。

## 4. Capability Skill

- 已有对应 Skill → 按需加载；
- Tool Schema 足够 → MUST NOT 强制 Skill；
- Skill 只承载可重复、稳定、高价值、领域特定知识；
- SHOULD 按稳定能力领域划分，而不是强制“一软件一 Skill”。

## 5. Capability Check

第一次真正需要 Capability 时确认：

```text
AVAILABLE?
REGISTERED?
AUTHENTICATED?
READY?
```

`READY` → 进入 Plan。

`MISSING/BROKEN/AUTH_REQUIRED` → 读取 `capability-bootstrap.md`。

### MCP Check

Codex 看不到某 MCP Tool，MUST NOT 推断 Harness 中没有它。Harness 模式下使用 Bridge `start_run` 执行只读 Capability Check：

```text
GOAL: 验证 REQUIRED_CAPABILITIES 是否可用
MODE: READ_ONLY_CAPABILITY_CHECK
RULES:
- 不修改配置
- 不安装依赖
- 不产生副作用
- 检查当前 Tool Registry
- 必要时执行 Safe Probe
RETURN:
AVAILABLE_CAPABILITIES
MISSING_CAPABILITIES
PROVIDER_STATUS
AUTH_STATUS
READY
NOTES
```

Capability Check 的状态字段是能力检查状态，不要与业务 Result Contract 的 `STATUS` 混用。
