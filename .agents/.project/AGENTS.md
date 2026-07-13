# DarkFactory project rules

DarkFactory is a separate GitHub-native product that integrates with Agent OS
for local execution and shared personal state.

- Keep webhook handlers in `src/bot.ts` and HTTP routing in `src/server.ts`.
- Keep managed-file discovery in `src/managed-files.ts` and fail closed unless
  the sole `agent-os-data` registration resolves to
  `$AGENTS_ROOT/data/agent-os`.
- Keep repository setup checks in `src/repository-setup.ts`.
- Open managed setup pull requests; never write directly to default branches.
- Keep only repository-local context in `.agents/.project/`.
- Route local model work through `agents`; do not add provider homes, model
  registries, fallback executors, or copied shared memory to this repository.
- The isolated Codex PR-review job is CI infrastructure, not local provider or
  model authority, and must not pin a repository model.
- Add tests under `tests/` for every changed runtime or policy branch.
