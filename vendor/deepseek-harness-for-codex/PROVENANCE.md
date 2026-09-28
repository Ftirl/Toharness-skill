# Bundled Bridge Provenance

- Canonical vendored runtime: `vendor/deepseek-harness-for-codex`
- Local adapter: `0.3.1-toharness.10.1`
- Upstream project: `Seann0824/deepseek-harness-for-codex`
- Upstream base: `0.3.1`
- License: MIT (see `LICENSE`)
- dist/bin.mjs SHA256: `590261de004cc908a880ae136aa56af24477805f44542c7a11399b5e8c351879`

The runtime is shipped inside the Toharness Skill package and is copied to the resolved Codex runtime by Bootstrap. External installation of the upstream plugin is not required for normal Toharness operation.

`assets/bridge` is retained only as an in-package compatibility mirror for earlier Toharness/model-router upgrade paths. The canonical runtime identity and hashes are recorded in `vendor/deepseek-harness-for-codex/VENDOR_MANIFEST.json`.
