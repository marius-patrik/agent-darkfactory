# Project Agent Rules

These rules are specific to `agent-darkfactory`.

## Scope

This repository builds a TypeScript GitHub App bot that receives GitHub webhooks and comments on repository activity.

## Managed Repository Setup

- `.agents/.global/` is version-enforced by DarkFactory from `workspace-darkfactory`.
- `.agents/.project/` is version-enforced only when a repo-specific workspace overlay exists.
- `.github` is bootstrap-enforced by DarkFactory in installed repositories.
- Open managed setup PRs instead of writing directly to default branches.
- Keep runtime-generated `.agents` metadata out of git.

## Bot Boundary

- Keep webhook handlers registered in `src/bot.ts`.
- Keep managed setup checks in `src/repository-setup.ts`.
- Keep HTTP routing and signature handoff behavior in `src/server.ts`.
- Keep environment parsing in `src/config.ts`.
- Add tests under `tests/` for new config, webhook, and setup-check behavior.
