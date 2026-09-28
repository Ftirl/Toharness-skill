# Existing Harness Bridge — 通用复用与验收

仅在用户希望复用已经运行的 DeepSeek Harness，或 Bridge 配置指向已有服务时读取。本文不保存任何设备历史。

## 1. 输入边界

可接受来源：当前环境、当前 Codex MCP 注册、用户当前明确提供、当前 Workspace 配置。

```text
Harness URL        → 必须是干净的 loopback HTTP origin
Credential source  → 当前设备的安全文件/环境/合法登录流程
Workspace          → 当前 Codex 任务真实绝对目录
Protocol mode      → 由 Bridge/Provider 当前能力发现；不得凭旧记录猜测
```

MUST NOT 从 Skill 中读取或复制：旧 run/session ID、历史端口、旧设备绝对路径、旧 Cookie/API Key、个人项目名称。

## 2. Discovery

优先顺序：

1. 读取当前 `codex mcp get deepseek-harness --json` 的正式注册；
2. 检查当前环境显式变量；
3. 用户明确提供；
4. 都没有时，返回 `BRIDGE_BLOCKED` / `BRIDGE_AUTH_REQUIRED`，不得反复猜端口或新开第二个服务。

## 3. Read-only Safe Probe

验收链：

```text
doctor
→ start_service / authenticated connectivity probe
→ start_run（只读任务）
→ wait_run_until_terminal
→ Codex 独立核对 Evidence
```

探针必须使用当前 Workspace 内新建的非敏感临时文件，Harness 只读取其真实 CWD 与 SHA256；Codex 独立计算并比较。探针结束删除临时文件。

PASS 条件：

- Run 明确 `succeeded`；
- Harness 报告的 CWD 与当前 Workspace realpath 一致；
- SHA256 与 Codex 本地实算一致；
- 无越界写入；
- 当前认证实际有效。

Skill / Bridge / Runtime 配置变化后 MUST NOT 沿用旧 PASS。

## 4. 服务所有权

若服务由用户或其他进程先启动，Bridge disconnect / MCP process exit MUST NOT 被描述为关闭了该服务。只有明确由本次 Bootstrap 创建且拥有 PID/生命周期的服务，失败回滚时才 MAY 停止。

## 5. Runtime Validation History

真实运行历史属于 runtime evidence，不属于 Skill source。若项目需要保存，写入项目/用户配置的 runtime state backend，并默认 gitignore；Skill 发布包 MUST NOT 携带任何机器特定历史。

## Codex Home 发现规则

连接已有 Harness 前，MUST 先让 Bootstrap 解析实际 Codex Home，再从该 Home 查询正式 MCP 注册。未设置 `CODEX_HOME` 本身不是缺失信号；不得仅因环境变量为空就创建第二套 Harness/MCP。

若 `-CheckOnly` 返回 `missing=[]`，现有通路应直接复用。只有当前解析出的 Home 中确实没有注册、Safe Probe 失败或当前服务不可用时，才进入修复/Bootstrap。



### Codex MCP Tool Timeout

Bridge-side long-poll requires the Codex MCP host timeout to exceed the Bridge wait window. The installer MUST ensure `[mcp_servers.deepseek-harness] tool_timeout_sec >= 3700`. Codex defaults this setting to about 60 seconds; leaving the default can re-enter the model while Harness is still running and recreate repeated wait calls. The local adapter intentionally does not expose the legacy `wait_run` MCP tool to Codex; new tasks must use `wait_run_until_terminal`.
