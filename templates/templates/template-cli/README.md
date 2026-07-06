# template-cli

Bun and TypeScript command-line application template.

## What it includes

- Bun runtime and package management.
- TypeScript with strict compiler settings.
- A small argument parser with help, name, and shout options.
- Tests for CLI behavior.
- Scripts for development, typechecking, tests, build, and CI.
- GitHub Actions CI for pushes and pull requests to `main` and `dev`.

## Use this template

After creating a repository from this template, replace:

- package name and binary name in `package.json`
- README title and project summary
- command behavior in `src/index.ts`
- sample tests in `tests/index.test.ts`
- project-specific agent context in `.agents/.project/`

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
bun run dev -- --name DarkFactory
bun run typecheck
bun test
bun run build
bun run ci
```

The build output is written to `dist/`.
