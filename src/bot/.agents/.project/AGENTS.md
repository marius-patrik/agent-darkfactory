# DarkFactory project rules

DarkFactory is a separate GitHub-native product that integrates with Agent OS
for local execution and shared personal state.

- Keep webhook handlers in `src/bot.ts` and HTTP routing in `src/server.ts`.
- Keep managed-file discovery in `src/managed-files.ts` and fail closed unless
  the sole `agent-os-data` registration names `marius-patrik/Andromeda-data`
  and resolves exactly to the canonical `$AGENTS_HOME` checkout root;
  unrelated data-repository registrations may coexist but may not claim that
  repository or checkout path.
- Keep repository setup checks in `src/repository-setup.ts`.
- Keep the provider-agnostic prompt/skill library in `prompts/` and its
  validation in `src/prompts.ts`; never embed provider, model, auth, or
  runtime-command mechanics in prompt artifacts, and keep issue/PR/comment
  content inside untrusted-data delimiters.
- Open managed setup pull requests; never write directly to default branches.
- Keep only repository-local context in `.agents/.project/`.
- Route local model work through `agents`; do not add provider homes, model
  registries, fallback executors, or copied shared memory to this repository.
- DarkFactory Autoreview delegates every model-backed review and fix turn to
  the canonical `agents` launcher; workflow policy selects logical tiers, not a
  repository provider or model.
- Add tests under `tests/` for every changed runtime or policy branch.
