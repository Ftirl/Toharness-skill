# Toharness v10.1 — Closed-Loop + Embedded Bridge Runtime

**语言 / Language:** 中文 | [English](README.en.md)

通用跨 Runtime Capability Orchestrator。`SKILL.md` 是轻量常驻内核，其余协议按状态渐进加载；核心不绑定具体软件、模型版本或个人工作流。

## 快速开始

1. 将仓库目录复制到 Codex Skills 目录，并命名为 `Toharness`（通常是 `%USERPROFILE%\.codex\skills\Toharness`）。
2. 在该目录运行 `python scripts/validate.py`，检查发布包和内置 Bridge 的一致性。
3. 在 Windows PowerShell 中运行 `./scripts/bootstrap.ps1 -CheckOnly`，查看本机 Node、Harness、Bridge 注册和超时配置状态。内置 Bridge 要求 Node.js 22 或更新版本。
4. 如果检查结果要求安装依赖或修改 Codex 配置，按输出提示审阅后再运行相应的 Bootstrap 授权开关；这些开关分别控制系统安装、网络安装、配置修改和禁用冲突插件。
5. 重启 Codex 后，在任务中说“使用 Toharness 处理这个任务”。

`-CheckOnly` 是只读检查。正常运行会把仓库内 `vendor/deepseek-harness-for-codex/` 复制到 Codex Runtime 目录，并注册 `deepseek-harness` MCP；完整前提和兼容规则见 [Bootstrap 与兼容性](#bootstrap--compatibility)。

**发布内容：**仓库包含 Skill、协议参考、安装与验证脚本，以及内置 Bridge Runtime。`assets/bridge/` 是旧版兼容镜像；Runtime 状态、会话日志和凭据不属于发布包。内置 Bridge 的 MIT 许可证见 `vendor/deepseek-harness-for-codex/LICENSE`；本仓库其余内容未在压缩包中声明统一许可证。

## 调用名称

本 Skill 的公开名称是 **`Toharness`**。安装到 Codex Skills 目录后，后续任务直接使用：

```text
使用 Toharness 处理这个任务。
```

或：

```text
这个任务按 Toharness 编排执行。
```

`DeepSeek Harness for Codex` 仍然是底层 Bridge 的上游来源，不是本 Skill 的对外调用名称。V10.1 已把当前定制版本作为 `vendor/deepseek-harness-for-codex/` 内置在 Skill 中；正常运行不再要求另外安装上游 Codex Plugin。底层 MCP 注册名继续使用 `deepseek-harness`，以保持 Durable Run、Session Recovery 与已有 Codex 配置兼容。

如果从旧版 `model-router` 升级，建议最终只保留一个可发现的编排 Skill：`Toharness`。旧 Runtime 目录和 `MODEL_ROUTER_*` 环境变量仅作为迁移兼容入口，不再作为公共身份。

## 核心能力

```text
Context → Intake → Gate
                ├─ DIRECT_CODEX
                └─ Harness modes
                     → Bridge
                     → Durable Run Recovery
                     → Capability Resolution / Bootstrap
                     → Contract
                     → Session Affinity
                     → Language Affinity
                     → Skill Affinity
                     → Task Graph
                     → Execute / Long-Poll
                     → Evidence / Review
                     → Codex Final Acceptance
```


## V10.1 — Embedded DeepSeek Harness for Codex Runtime

V10.1 把当前 Toharness 对 Bridge 的全部定制固化为 Skill 内置底本：

```text
Toharness/
└─ vendor/deepseek-harness-for-codex/
   ├─ dist/bin.mjs
   ├─ package.json
   ├─ package-lock.json
   ├─ verify.mjs
   ├─ VENDOR_MANIFEST.json
   ├─ UPSTREAM_SOURCE_MANIFEST.json
   ├─ UPSTREAM.md
   ├─ PATCHSET.md
   └─ LICENSE
```

Bootstrap 默认从该目录复制本地 Runtime，并将复制后的 `dist/bin.mjs` 注册成 `deepseek-harness` MCP。外部 `deepseek-harness-for-codex` npm/plugin 不是正常运行依赖；若同时存在，应避免让它与 Toharness vendored runtime 同时暴露重复 Tool Catalog。

`assets/bridge/` 仅作为旧版 Toharness/model-router 的兼容镜像。发布时 Validator 会检查 canonical vendor 与兼容镜像的 runtime hash 是否一致。

## V10 — Bidirectional Context Sync / User Override

V10 把主线从单向 `Codex → Harness` 补成完整闭环，同时保持 Codex 为默认 Supervisor：

```text
用户 → Codex → Harness
             ↑      ↓
             └─ Cursor / Delta / Checkpoint ─┘

用户也可以直接在 Harness 做局部修改或明确的方向 Override，之后再回到 Codex。
```

新增 Bridge tools：

```text
list_persisted_sessions
adopt_session
get_session_cursor
list_unsynced_sessions
sync_session_delta
read_session_events
ack_session_sync
```

### Harness-first

如果任务一开始就在 Harness 中创建，不需要重新开会话：

```text
list_persisted_sessions
→ adopt_session
→ sync_session_delta
→ ack_session_sync
→ Codex 从当前状态继续
```

### Cursor / Delta

Bridge 在进程外维护 `session-sync.json`，只记录游标和 Control metadata，不复制完整 Harness 对话。Codex 返回时先检查 cursor；只有有新事件才读取 compact delta。默认不重新加载整个 Session。

### User Override

默认权限仍然是：

```text
USER > CODEX Supervisor > HARNESS Runtime
```

Harness Agent 自主的方向/系统级改变仍应 Escalate；但如果用户本人直接在 Harness 明确要求越级修改，则允许：

```text
CONTROL_OWNER = HARNESS_USER_OVERRIDE
OVERRIDE_REVIEW_STATE = PENDING
```

Harness 可继续执行。用户之后回到 Codex 时，Codex 先同步 Delta，再以当前现实状态继续，并可记录 `ACCEPT / ACCEPT_WITH_NORMALIZATION / REVISE`。Codex 不应因为该改变发生在 Harness 而自动回滚用户决定。

### Session reuse guard

复用旧 Session 前若检测到未同步 Harness activity：

```text
start_run(sessionId=...)
→ SESSION_SYNC_REQUIRED
```

正常流程必须先 `sync_session_delta → ack_session_sync`。这避免 Codex 带着旧 Task State 覆盖用户刚刚在 Harness 做的修改。


## Host-Wait Enforcement

本地 Bridge 的 long-poll 现在从两层强制：

1. Codex MCP 注册必须设置 `tool_timeout_sec >= 3700`，避免 Codex 默认约 60 秒的工具超时提前打断 long-poll。
2. 本地 Bridge 不再向 Codex 暴露旧 `wait_run`，只保留 `wait_run_until_terminal` / `wait_runs_until_terminal`。

`bootstrap.ps1 -CheckOnly` 会同时检查已注册 Adapter 版本与 MCP Tool Timeout。若看到 `BRIDGE_ADAPTER_OUTDATED` 或 `MCP_TOOL_TIMEOUT`，必须更新本地 Bridge 注册；不要把它当成 Harness 服务缺失而重复安装 Harness。

## Skill Affinity / Skill Routing

V9+ 的 Runtime/Role 级 Skill 分工：

```text
CODEX Skill
→ 只给 Codex 做规划、架构、风险、验收与 Review

HARNESS Skill
→ Codex 只读 routing metadata / 自己覆盖的 section
→ 原文件/正文通过 Bridge 转交 Harness 执行

SHARED Skill
→ Codex 读 [SHARED] + [CODEX]
→ Harness 读 [SHARED] + [HARNESS] + matching [ROLE:*]
```

支持用户三种输入：

```text
1. 上传 Skill 文件
2. 提供 Skill 文件路径
3. 直接粘贴 Skill 正文
```

Harness Skill 最终通过 `start_run.skillInputs[]` 转交：

```text
sourceType    = PATH | INLINE
transferMode  = SNAPSHOT | REFERENCE | INLINE
target        = HARNESS | SHARED
applyToRoles  = WORKER / TESTER / ... / ALL
```

默认推荐 `SNAPSHOT`：Bridge 自己读取文件、计算 SHA256、保存 content-addressed snapshot，并把内容交给 Harness。这样 Codex 不需要先把 Harness execution Skill 全文读入自己的模型上下文。

Bridge 会返回：

```text
harnessRole
skillBindings[]
skillWarnings[]
```

其中 `skillBindings` 只包含 id、target、role、transfer mode、digest、size 等元数据，不回显完整 Skill 正文。

## Cross-Runtime Skill File v1

推荐 Skill 文件按以下结构编写：

```markdown
---
skill_schema: cross-runtime-skill/v1
name: example
version: 1
default_target: SHARED
---

## [SHARED]
所有 Runtime 都要遵守的边界。

## [CODEX]
只供 Codex 规划、决策和 Review。

## [HARNESS]
只供 Harness 执行、工具调用和实现。

## [ROLE:WORKER]
Worker 专用执行规范。

## [ROLE:TESTER]
Tester 专用验证规范。
```

模板：`templates/cross-runtime-skill.template.md`。

为了避免 Codex 误读 Harness execution body，包内提供：

```bash
python scripts/skill_view.py --file <skill.md> --target codex
python scripts/skill_view.py --file <skill.md> --target harness --role WORKER
```

Codex view 只输出 frontmatter、preamble、`[SHARED]`、`[CODEX]`。Legacy Harness-only Skill 没有 scope 标签时，Codex view 不输出执行正文。

## 用户如何告诉 Codex

最简形式：

```text
这个任务继续使用 Toharness。
Codex 使用 system-design Skill。
Harness Worker 使用我上传的 skill.md，SNAPSHOT 转交。
Harness Tester 使用 C:\path\to\test-skill.md。
```

或者结构化：

```yaml
SKILL_ASSIGNMENT:
  codex:
    required:
      - id: system-design
        source: INSTALLED

  harness:
    required:
      - id: domain-worker
        source: ATTACHMENT
        target: HARNESS
        transfer_mode: SNAPSHOT
        apply_to_roles: [WORKER]

      - id: domain-test
        source: PATH
        path: C:\path\to\test-skill.md
        target: HARNESS
        transfer_mode: SNAPSHOT
        apply_to_roles: [TESTER]
```

Codex-only Skill 不应进入 Bridge `skillInputs`。Harness-target Skill 如果无法读取、hash 不匹配、超限或外部路径未经用户批准，Required Skill 会阻断 Run，而不是静默换 Skill。

## Language Affinity

默认 `MIRROR_USER`：

```text
Codex 中文 → Harness 用户可见自然语言中文
Codex English → Harness user-visible natural language English
```

代码、identifier、路径、命令、API/Tool/MCP 名称、raw error 和协议 key 保持原样。Locale 会写入 Durable Run Ledger，跨 Codex/Bridge 重启恢复时不会丢失。

## Session Affinity

同一：

```text
TASK_ID + EXECUTION_LINEAGE_ID + Workspace
```

默认复用 Harness Session。新一轮 Codex 消息、Role 切换、测试失败、局部 REWORK 或兼容的 Skill 增补都不是单独新建 Session 的理由。

Fresh Reviewer 与真正独立并行 branch 仍使用隔离 Session。

## Bridge-side Long-Poll

正常委派：

```text
start_run
→ wait_run_until_terminal
→ terminal result / bounded timeout
```

Harness 状态轮询在 Bridge 内部完成，避免 Codex 每 30 秒被唤醒。并行 DAG 使用 `wait_runs_until_terminal`。

## Durable Run Recovery

Bridge 持久记录：

```text
TASK_ID / lineage
→ durableRunId
→ runId
→ sessionId
→ startEventSeq
→ locale
→ harnessRole + skillBindings metadata
```

Codex/Bridge 被结束不会自动取消 Harness。重新启动后：

```text
recover_pending_runs / recover_run

仍在运行
→ DETACHED_RUNNING
→ 重新挂回原 runId
→ 继续 long-poll

离线期间已完成
→ 从 persisted session events 重建原结果
→ 不重新 Prompt Harness
```

结果交付还区分 `UNACKNOWLEDGED / ACKNOWLEDGED`；`ack_run` 只表示 Codex 已收到结果，不等于 Review PASS。

## Bootstrap / Compatibility

- `references/compatibility.json` 是 Runtime Adapter 兼容来源。
- 已有 Harness：probe-first。
- 新 Provision：使用 manifest 固定兼容版本，不浮动安装 latest。
- Windows 未设置 `CODEX_HOME` 时自动回退 `%USERPROFILE%\.codex`，并将同一结果传给 Codex CLI 子进程。
- Bootstrap 修改配置需要授权 Gate；验证失败时回滚。

## 自检

```bash
python scripts/validate.py
```

Validator 检查：版本/Reference 一致性、Bridge/Compatibility、Session/Language/Skill Affinity、Skill scoped-view 隔离、Long-Poll、Durable Recovery、Result ACK、Bootstrap 授权/回滚、Secret 痕迹与 Node 语法。

## Runtime state

Durable Run Ledger 与 Skill snapshot cache 属于 Runtime state，由 Bridge data directory 管理；不进入发布 Skill 包，也不保存完整 Harness 对话、Reasoning、Tool Log 或 Secret。Harness persisted Session/Event Log 仍是执行历史的事实来源。


### Codex MCP Tool Timeout

Bridge-side long-poll requires the Codex MCP host timeout to exceed the Bridge wait window. The installer MUST ensure `[mcp_servers.deepseek-harness] tool_timeout_sec >= 3700`. Codex defaults this setting to about 60 seconds; leaving the default can re-enter the model while Harness is still running and recreate repeated wait calls. The local adapter intentionally does not expose the legacy `wait_run` MCP tool to Codex; new tasks must use `wait_run_until_terminal`.
