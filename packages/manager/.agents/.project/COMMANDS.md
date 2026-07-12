# Agent OS Manager Commands

Run from the repository root:

```sh
bun run check
bun test packages/manager/test/*.test.ts
bun run ci
bun run agents -- state doctor --json
bun run agents -- memory status
```

Tests that touch state must use explicit disposable `AGENTS_HOME`,
`AGENTS_USER_HOME`, and `AGENTS_ROOT` values. The personal root is only for
intentional read-only or installed-boundary validation.
