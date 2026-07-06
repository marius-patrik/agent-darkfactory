# templates

Bun and TypeScript starter templates for DarkFactory-managed repositories.

These are the canonical starter templates used by DarkFactory. They were folded into the control
repository as normal folders (formerly the standalone `darkfactory-templates` monorepo and its
`template-*` submodule repositories, all archived after the fold). Shared validation, sync
scripts, and release conventions live alongside them here.

## Layout

### Workspace packages

- `packages/cli` – command-line package template (`@template/cli`).
- `packages/web` – web package template served by Bun (`@template/web`).

### Template folders

- `templates/template-cli` – Bun CLI application template.
- `templates/template-web` – Bun web application template.
- `templates/template-bot` – TypeScript GitHub App bot template.
- `templates/template-repo` – generic Bun repository template.

Each template is a normal folder in this repository; edit templates directly through pull
requests against `dev` like any other control-repo change.

## Setup

```powershell
bun install
bun run typecheck
bun run build
```

Run package scripts from the root:

```powershell
bun run dev:cli
bun run dev:web
```

## Validation

Root CI runs:

```powershell
bun run ci
```

This executes `bun run typecheck && bun run build` across all workspace packages. Template
folder validation runs in this repository's CI.

## Release and enforcement model

- The `main` branch is the stable, release-ready state.
- The `dev` branch collects approved changes before they are promoted to `main`.
- All changes land through pull requests targeting `dev`.
- DarkFactory-managed files (under `.darkfactory/`, `.agents/.global/`, and repository policy files) are updated by automated tooling or explicit governance PRs. Manual edits should keep their structure intact.
- `.github/` workflows and `AGENTS.md` are part of the managed scaffold; update them through the normal PR process.

## DarkFactory-managed files

- `.agents/.global/` contains reusable agent operating rules. Keep these files intact when creating a new repository from a template.
- `.agents/.project/` contains project-specific facts, commands, decisions, status, and handoff context. Replace these files with the new repository's own context after using a template.

See each template's README for setup, scripts, expected customization steps, validation, and release notes.
