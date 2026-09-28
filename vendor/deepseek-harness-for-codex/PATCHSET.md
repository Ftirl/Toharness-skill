# Toharness patchset

Relative to the upstream 0.3.1 behavior, the vendored runtime carries the Toharness execution contract, including:

- reuse of an existing authenticated local Harness service;
- session continuation and affinity;
- Bridge-side single/multi-run long-poll;
- removal of the legacy short `wait_run` tool from the Codex-facing catalog;
- persistent durable-run ledger and detached-run reattach;
- terminal-result reconstruction and explicit delivery ACK;
- language/locale affinity;
- role-scoped Skill forwarding and content-addressed Skill snapshots;
- bidirectional cursor/delta context sync;
- Harness-first session adoption;
- user-authorized decision override/control-owner audit;
- strict single-turn Run boundary;
- Codex MCP host timeout alignment.

The Toharness Skill protocol remains the policy source of truth; this package is the runtime adapter that implements the corresponding MCP surface.
