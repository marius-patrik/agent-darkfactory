# template-repo

Bun and TypeScript project template for a small repository.

## What it includes

- Bun runtime and package management.
- TypeScript with strict compiler settings.
- A small `src/` entrypoint with a Bun test.
- Scripts for development, typechecking, tests, build, and CI.
- GitHub Actions CI for pushes and pull requests to `main`.

## Use this template

After creating a repository from this template, replace:

- package name in `package.json`
- README title and project summary
- sample code in `src/index.ts`
- sample tests in `tests/index.test.ts`
- project-specific context in `.agents/.project/`

Keep `.agents/.global/` when you want the shared agent operating rules. Replace only `.agents/.project/` for the new repository's facts, commands, decisions, status, and handoff.

## Requirements

- Bun 1.3.14 or newer.

## Setup

```powershell
bun install
bun run ci
```

## Scripts

```powershell
bun run dev
bun run typecheck
bun test
bun run build
bun run ci
```

The build output is written to `dist/`.
