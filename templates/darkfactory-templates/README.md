# darkfactory-templates

Bun and TypeScript templates monorepo for DarkFactory-managed repositories.

This repository publishes the canonical starter templates used by DarkFactory. Each template is a standalone repository that can also be consumed independently. The monorepo ties them together with shared validation, sync scripts, and release conventions.

## Monorepo layout

### Workspace packages

- `packages/cli` – command-line package template (`@template/cli`).
- `packages/web` – web package template served by Bun (`@template/web`).

### Template submodules

- `templates/template-cli` – Bun CLI application template.
- `templates/template-web` – Bun web application template.
- `templates/template-bot` – TypeScript GitHub App bot template.
- `templates/template-repo` – generic Bun repository template.

Each submodule points to its own repository under `marius-patrik` and is tracked at the `main` branch.

## Setup

```powershell
bun install
bun run sync:submodules
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

This installs dependencies, checks the managed file set across the root and template submodules, runs each repository's managed stack verifier, then executes typecheck, test, and build across all workspace packages. Submodule package validation is run inside each submodule repository.

Managed enforcement can be checked without running the full workspace CI:

```powershell
bun run check:managed-conformance
bun run check:managed-stack
```

## Sync

To pull the latest submodule commits:

```powershell
bun run sync:submodules
```

To bump submodule gitlinks after a submodule release, open a dedicated bump PR against `dev`. Routine documentation-only changes should not mix in submodule gitlink bumps, but a coordinated refresh (such as updating root docs and pinning templates to their refreshed commits) may combine both in one PR.

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
