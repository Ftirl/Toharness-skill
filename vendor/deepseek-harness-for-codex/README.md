# Toharness Embedded DeepSeek Harness for Codex Runtime

This directory is the **canonical vendored Bridge runtime** shipped with Toharness v10.1.

- Local package: `toharness-deepseek-harness-for-codex`
- Local adapter: `0.3.1-toharness.10.1`
- Upstream: `Seann0824/deepseek-harness-for-codex`
- Upstream base: `0.3.1`
- License: MIT (`LICENSE`)
- Runtime entry: `dist/bin.mjs`

## Runtime policy

Toharness Bootstrap copies this directory into the resolved `CODEX_HOME` runtime and registers the copied local `dist/bin.mjs` as the `deepseek-harness` MCP server. A separately installed upstream Codex plugin is **not required** and should normally remain disabled to avoid duplicate tool catalogs.

The upstream package remains the provenance/base. Toharness-specific behavior is carried by this vendored derivative, including session affinity, bridge-side long-poll, durable reattach/result recovery, language affinity, skill routing, bidirectional context sync, Harness-first adoption, user override audit, and host-wait enforcement.

`VENDOR_MANIFEST.json` is the machine-readable source of truth for the embedded runtime identity and hashes.
