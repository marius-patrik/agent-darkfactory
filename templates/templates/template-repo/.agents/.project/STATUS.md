# Status

## Current State

| Area | State |
| --- | --- |
| Repository | `marius-patrik/template-repo` |
| Branch | `codex/bun-project-ci` |
| Pull request | `#2` draft, targets `main` |
| Scaffold | Bun and TypeScript project template |
| Agent files | `.agents/.global/` reusable, `.agents/.project/` project-specific |
| CI | GitHub Actions `validate` job |

## Validation

Latest local validation for the scaffold:

- `bun install`
- `bun run typecheck`
- `bun test`
- `bun run build`
- `bun run ci`

## Next Actions

- Keep PR #2 updated until merged.
- After merge, update this file if branch or PR status changes.
- When creating a new repo from this template, replace this file with that repo's current state.
