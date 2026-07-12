# Status

- Active reconciliation branch: `reconcile/single-state-memory`, tracking
  `origin/dev`.
- Canonical v2 root resolution, manifest, doctor, provider pinning, memory, and
  managed startup injection are implemented.
- The live personal doctor is green with four canonical checksum-pinned
  providers and no standalone provider roots.
- The installer converges to one source checkout and one regular
  `$AGENTS_HOME/bin/agents` launcher; its isolated release smoke passes.
- Retired machine/runtime state is protected under
  `/Users/user/Recovery/agent-os-reconcile-2026-07-10` with a fully verified
  checksum manifest.
- Remaining branch work: session/orchestrator event authority, semantic
  capability migration, Go harness retirement, full CI, installed boundary,
  and PR publication.
