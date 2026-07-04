# Status

## Current State

| Area | State |
| --- | --- |
| Repository | `marius-patrik/darkfactory-agent` |
| Branch | `main` |
| Issue | n/a |
| Purpose | GitHub App bot for repository automation |
| Version | `0.2.0` |
| Managed setup | Workspace-backed `.agents/.global`, optional repo-specific `.agents/.project`, GitHub bootstrap, and Codex Review workflow PRs |
| Release | `v0.2.0` shipped (M2 planning loop) |
| CI | GitHub Actions `validate` job |

## Validation

Run before committing:

- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run check`

## Next Actions

- Configure `DARK_FACTORY_APP_ID` and `DARK_FACTORY_PRIVATE_KEY` secrets before using managed sync or release workflows.
- Configure `CODEX_AUTH_JSON` in every managed repository where Codex Review should approve pull requests.
- Install the GitHub App on all repositories through GitHub's installation UI.
