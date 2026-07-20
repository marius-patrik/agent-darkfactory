# Agent OS templates

This is the one template workspace shipped with DarkFactory.

## Packages

- `packages/cli` — Bun and TypeScript command-line starter
- `packages/web` — Bun and TypeScript web starter

Shared Agent OS identity, memory, roles, skills, providers, and sessions are
installed under `$AGENTS_HOME`; templates never copy that state. Generated
repositories carry only their own project guidance and DarkFactory policy.

## Validation

```sh
bun install --frozen-lockfile
bun run ci
```

The workspace is validated as one product surface. There are no folded
standalone template repositories or alternate template roots.
