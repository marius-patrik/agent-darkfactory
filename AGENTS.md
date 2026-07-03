# Agents Manager Repo Instructions

This repository owns the `agents` local management CLI. Keep changes scoped to the CLI source in `src/`, tests in `test/`, and package-level documentation or metadata.

## Validation

Run these commands from the repository root before opening a PR:

```powershell
bun install
bun run check
bun run test
```

`bun run ci` is the package-local aggregate and must stay equivalent to the documented check and test commands.

## Development Rules

- Do not commit directly to `main`.
- Keep this repo independently runnable with Bun; avoid depending on the parent monorepo package metadata for package-local validation.
- Do not add GitHub settings, branch protection, labels, or managed workflow enforcement here unless the issue explicitly requests that settings/enforcement work.
- Keep secrets out of fixtures, logs, docs, and test output.
- Prefer tests that use temporary directories and local fake commands over live GitHub or provider mutations.
