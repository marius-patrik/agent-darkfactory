# Status

- Andromeda v0.9.0 is released on `main`, with `dev` and `main` tree-identical.
  The release carries the layout refactor and the template consolidation.
- The repository is a single monorepo with no submodules. `.gitmodules` is
  empty, and the repository contract fails closed if that changes without the
  CI workflow initializing the declared set.
- Durable state lives in the separate `private-data` repository, reached
  through the Agent OS state lane. It is no longer a submodule of this
  repository, and `context/TASK.md` there remains the owner-facing task board.
- Target components are scaffolded and carry their contracts: `sdk`, `mcp`,
  `server`, `clients/{cli,app,web}`, and `plugins`. They hold contract READMEs
  rather than implementation; the fail-closed inventory requires that a
  component gaining code also gains a test suite.
- The previous implementation is carried under `packages/bot` — `manager`,
  `core`, `harness`, `gateway`, `inference`, `memory`, `dream`, `experience`,
  and the folded predecessors of the developmental runtime, the retired
  gateway, the legacy manager, and the workspace substrate — frozen and mined
  by reimplementation against the sdk.
- `packages/bot` carries the GitHub control-plane agent project, and
  `templates/` carries the five folded template repositories.
- Every folded repository was verified before its source was deleted. Where a
  branch could not be merged into the fold, its commits are preserved as an
  `archive/<repo>/<branch>` tag in this repository, so nothing was discarded.
- The full CI gate passes: component suites on Linux and Windows, real-process
  legs, product smokes, the fail-closed inventory, the repository contract, and
  the DarkFactory managed setup check.
- Provider route: canonical Claude is the working medium and high tier. Codex
  is quota-limited, Kimi is decommissioned, and Agy is not an approved review
  route. A complete Autoreview run needs a clean medium round and a high
  confirmation round back to back, which a single-review provider pool cannot
  satisfy in one pass.
