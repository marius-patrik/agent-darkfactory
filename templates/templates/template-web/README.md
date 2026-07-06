# template-web

Bun and TypeScript web application template.

## What it includes

- Bun runtime and package management.
- TypeScript with strict compiler settings.
- A small HTTP server that serves static HTML and browser TypeScript.
- Testable page and HTML helpers.
- Scripts for development, typechecking, tests, build, and CI.
- GitHub Actions CI for pushes and pull requests to `main` and `dev`.

## Use this template

After creating a repository from this template, replace:

- package name in `package.json`
- README title and project summary
- sample page content in `src/page.ts`
- server routes in `src/server.ts`
- browser behavior in `src/client.ts`
- sample tests in `tests/page.test.ts`
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
bun run dev
bun run typecheck
bun test
bun run build
bun start
```

The browser bundle is written to `dist/client.js`.
