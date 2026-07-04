# Project

`agents-mono` is the root repository and aggregator for the agents-mono topology.
The root package exposes the `agents` CLI and validates the `os/agents-manager`
TypeScript test surface.

## Naming contract

- `agents-mono` — the root aggregator repository and workspace.
- `agents` — the unified management CLI implemented in `os/agents-manager`.
- `os/agents-*` — OS/platform packages (`agents-core`, `agents-manager`, `agents-harness`).
- `agentos-data` — retained as the compatibility name for the default git-backed data repository and its env var (`AGENTOS_DATA_ROOT`).
- `Agentos`, `Andromeda`, `Rommie`, and other legacy names are intentionally retained only where they identify an existing repo, env var, or historical concept; new docs use the current names above.

Most child directories are submodules. Avoid recursive submodule mutation for root-only workflow and policy changes.
