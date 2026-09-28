# Bootstrap

> V10.1 runtime packaging: the canonical Bridge bundle is `vendor/deepseek-harness-for-codex`. Bootstrap copies this vendored derivative into the resolved Codex runtime. A separately installed upstream DeepSeek Harness for Codex plugin is not required.

首次调用与新设备 Bootstrap

本模块是基础设施安装流程，必须遵守 Router 自己的 Risk / Reversibility 原则。Bridge/Runtime 兼容版本以 `compatibility.json` 为唯一包内来源。

## 1. 先 CheckOnly

```powershell
& '<skill>/scripts/bootstrap.ps1' -CheckOnly -Workspace '<当前项目绝对目录>'
```

需要覆盖自动解析时可显式指定：

```powershell
& '<skill>/scripts/bootstrap.ps1' -CheckOnly -Workspace '<当前项目绝对目录>' -CodexHome '<当前 Codex Home>'
```

CheckOnly 只发现状态并输出计划，不安装、不下载、不修改 Codex 配置。

### CODEX_HOME 解析

`bootstrap.ps1` 不要求调用者预先设置 `CODEX_HOME`。Windows 下使用以下顺序解析一次 Codex Home，并让本次脚本中的所有 `codex` 子进程使用同一结果：

```text
-CodexHome 显式参数
↓
当前 CODEX_HOME 环境变量
↓
当前 Windows UserProfile\.codex
↓
HOME\.codex（最后回退）
```

`-CheckOnly` 输出 `resolvedCodexHome` 与 `codexHomeSource`，便于确认实际检查位置。脚本只对自身启动的子进程临时设置该 Home，MUST NOT 要求用户为了预检永久修改全局环境变量。

如果旧版本在未设置 `CODEX_HOME` 时曾报告 `HARNESS_SERVICE` / `MCP_REGISTRATION` 缺失，而显式设置正确 Home 后缺失项为空，**不得依据旧结果重复安装**；使用本版本重新执行 `-CheckOnly`，以 `resolvedCodexHome` 与当前 `missing` 为准。

## 2. 明确授权 Gate

Bootstrap 将副作用分开授权：

```text
-ApproveSystemInstall              → 允许系统级 Node 安装（PARTIALLY_REVERSIBLE）
-ApproveNetworkInstall             → 允许 npm/winget 网络下载
-ApproveConfigMutation             → 允许修改 Codex MCP 配置
-ApproveDisableConflictingPlugin   → 允许禁用冲突的上游插件
```

MUST NOT 因“用户想使用 Harness”就推定上述四种副作用全部获批。环境已有相应能力时不需要对应批准。

## 3. Existing Harness 优先

已有 Harness 时优先复用并 Safe Probe。地址与凭据从当前 MCP 注册 / 当前环境 / 当前用户输入发现，不使用 Skill 内固定端口或旧设备 home。

示例：

```powershell
& '<skill>/scripts/bootstrap.ps1' `
  -Workspace '<当前项目绝对目录>' `
  -HarnessUrl '<当前设备 loopback origin>' `
  -CredentialFile '<当前设备 credential file>' `
  -ApproveNetworkInstall `
  -ApproveConfigMutation
```

若需要禁用冲突插件，再显式添加 `-ApproveDisableConflictingPlugin`。

## 4. 没有 Harness 时

只有 `-ApproveNetworkInstall` 已明确授权时，脚本才 MAY Provision 新 Harness。Provision MUST 使用 `compatibility.json` 的 `defaultProvisionPackage`，MUST NOT `npm install @deepseek-ai/dsh` 浮动安装 latest。

新实例使用 Toharness 管理的 Runtime/Home 与动态空闲 loopback port；不会复用旧设备 Credential。首次认证/模型设置缺失时返回 `BRIDGE_AUTH_REQUIRED` / `AUTH_REQUIRED`，由用户在当前设备完成合法初始化。

## 5. Transaction / Rollback

配置写入使用事务：

```text
PRE_STATE / config backup
→ Bridge runtime prepare
→ Harness provision/reuse
→ MCP registration
→ optional conflict disable
→ verify.mjs Safe Probe

PASS → COMMIT
FAIL → restore Codex config + stop only the service created by this run + remove only newly-created staging/runtime where safe
```

系统级 Node 安装不会自动卸载，因此必须单独授权，并标记 PARTIALLY_REVERSIBLE。

## 6. 验收

`verify.mjs` 使用当前项目随机临时文件，通过正式 MCP 注册执行：

```text
doctor → start_run → wait_run_until_terminal → CWD/SHA256 Evidence → Codex 独立比较
```

PASS 只代表当前正式配置通过端到端验收；原生 MCP Tool 若需要新 Codex Task 才加载，必须单独说明 `BRIDGE_RESTART_REQUIRED`。

## 7. 其他系统

当前自动安装脚本面向 Windows PowerShell。macOS/Linux 不得执行 winget 或 `.cmd` 假设；应使用该平台官方 Node 安装方法，并保持相同的 Compatibility Manifest、授权 Gate、增量配置和 Safe Probe 规则。


### Codex MCP Tool Timeout

Bridge-side long-poll requires the Codex MCP host timeout to exceed the Bridge wait window. The installer MUST ensure `[mcp_servers.deepseek-harness] tool_timeout_sec >= 3700`. Codex defaults this setting to about 60 seconds; leaving the default can re-enter the model while Harness is still running and recreate repeated wait calls. The local adapter intentionally does not expose the legacy `wait_run` MCP tool to Codex; new tasks must use `wait_run_until_terminal`.
