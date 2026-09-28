# Toharness v10.1 — Closed Loop Orchestration with an Embedded Bridge

**Language / 语言:** [中文](README.md) | English

Toharness is a cross runtime capability orchestrator for Codex and DeepSeek Harness. `SKILL.md` is the small core that stays in context; the detailed protocols under `references/` are loaded only when the task reaches the relevant state. The core is independent of a particular application, model version, or personal workflow.

## Quick start

1. Copy this repository directory into your Codex Skills directory as `Toharness` (typically `%USERPROFILE%\.codex\skills\Toharness` on Windows).
2. Run `python scripts/validate.py` from that directory to check the package and embedded Bridge for consistency.
3. On Windows, run `./scripts/bootstrap.ps1 -CheckOnly` in PowerShell. This reports the local Node.js, Harness, Bridge registration, and MCP timeout status without changing them. The embedded Bridge requires Node.js 22 or newer.
4. If the report calls for installation or a Codex configuration change, review the result and rerun Bootstrap with the relevant approval switches. The switches separately authorize system installation, network installation, configuration changes, and disabling a conflicting plugin.
5. Restart Codex and invoke the skill in a task, for example: “Use Toharness for this task.”

The normal Bootstrap path copies `vendor/deepseek-harness-for-codex/` into the resolved Codex runtime directory and registers its `dist/bin.mjs` as the `deepseek-harness` MCP server. A separate installation of the upstream Bridge plugin is not required.

## What is included

- `SKILL.md`: routing states, responsibilities, gates, and acceptance rules.
- `references/`: detailed protocols for context resolution, task intake, capability selection, contracts, session and language affinity, skill routing, recovery, risk, and review.
- `scripts/bootstrap.ps1`: local Bootstrap and read-only health check.
- `scripts/validate.py`: package consistency and syntax checks.
- `scripts/skill_view.py` and `templates/`: scoped cross runtime Skill viewing and a template.
- `vendor/deepseek-harness-for-codex/`: the canonical embedded Bridge runtime, its manifests, provenance, and MIT license.
- `assets/bridge/`: a compatibility mirror for earlier Toharness and model-router installations. The validator checks its runtime hash against the canonical vendor copy.

Runtime state, skill snapshots, credentials, and full Harness conversation logs are not part of this package.

## How orchestration works

```text
Context → Intake → Gate
                ├─ DIRECT_CODEX
                └─ Harness modes
                     → Bridge and capability resolution
                     → Contract and session/skill/language affinity
                     → Execute and wait for terminal result
                     → Evidence, review, and Codex acceptance
```

Codex acts as the default supervisor: it decides scope, risk, routing, and final acceptance. DeepSeek Harness is the execution runtime. Capability providers supply the actual tools. The detailed requirements are in `SKILL.md` and the relevant reference files.

## Closed loop context sync

Version 10 adds a return path from direct Harness work to Codex. A user can work in Harness first, or make an explicit change there, then return to Codex. Codex checks a persisted cursor, reads only the new compact delta, and continues from the current session state. This avoids reloading the entire Harness conversation or overwriting recent user work with an older task plan.

The Bridge supports `list_persisted_sessions`, `adopt_session`, `get_session_cursor`, `list_unsynced_sessions`, `sync_session_delta`, `read_session_events`, and `ack_session_sync`. A reused session with unsynced activity returns `SESSION_SYNC_REQUIRED` until the delta has been reviewed and acknowledged.

The default authority order is `USER > CODEX Supervisor > HARNESS Runtime`. Explicit user changes in Harness are recorded as `HARNESS_USER_OVERRIDE` for later Codex review; they are not automatically rolled back merely because they originated in Harness.

## Session, language, and skill affinity

Work with the same task ID, execution lineage, and workspace normally reuses its Harness session. A new Codex message, role change, test failure, or local revision alone does not justify a new session. An independent branch or fresh reviewer can use a separate session.

The default language mode is `MIRROR_USER`: user-facing Harness prose follows the user's current language while code, paths, protocol keys, and raw errors remain unchanged. The locale is persisted with durable run metadata so recovery retains it.

Cross runtime Skills can target `CODEX`, `HARNESS`, or `SHARED`. Harness Skills are forwarded through Bridge `skillInputs[]`, with `SNAPSHOT` as the recommended transfer mode. Scoped files can define `[SHARED]`, `[CODEX]`, `[HARNESS]`, and `[ROLE:...]` sections. Use `python scripts/skill_view.py --file <skill.md> --target codex` or `--target harness --role WORKER` to inspect the view for each runtime.

## Durable runs and long polling

The normal delegation path is `start_run → wait_run_until_terminal → review`. Parallel task graphs use `wait_runs_until_terminal`. The Bridge performs status polling internally. Its local adapter hides the legacy `wait_run` tool, and Codex's `[mcp_servers.deepseek-harness]` registration must set `tool_timeout_sec >= 3700` so the host does not interrupt a long wait early.

The durable ledger preserves run, session, lineage, locale, role, and Skill binding metadata. If Codex or the Bridge restarts, the run can be reattached. A result that finished while detached can be reconstructed from persisted session events without prompting Harness again. `ack_run` confirms delivery to Codex; final acceptance still requires review.

## Bootstrap and compatibility

`references/compatibility.json` pins the supported adapter and Harness package. Bootstrap probes an existing Harness before provisioning, and uses the pinned package when provisioning is necessary. On Windows it resolves `CODEX_HOME` to the current user's `.codex` directory if the environment variable is absent. It requires explicit switches before installing software, using the network, changing Codex configuration, or disabling a conflicting plugin; it rolls back a failed registration.

The canonical embedded adapter is based on `Seann0824/deepseek-harness-for-codex` 0.3.1 and is identified as `0.3.1-toharness.10.1`. See `vendor/deepseek-harness-for-codex/UPSTREAM.md`, `PATCHSET.md`, `PROVENANCE.md`, and `VENDOR_MANIFEST.json` for provenance and integrity details.

## Validation and licensing

Run `python scripts/validate.py` to check version and reference consistency, Bridge packaging, affinity and recovery invariants, Bootstrap safeguards, secret traces, and Node syntax.

The embedded Bridge has an MIT license in `vendor/deepseek-harness-for-codex/LICENSE`. The source archive did not declare a repository-wide license for the other Toharness content.
