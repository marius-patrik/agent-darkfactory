# Commands

```sh
bun install --frozen-lockfile
bun run check
bun run test
bun run ci
bun run smoke:release
```

Explicit temporary or live state commands must always set all three roots:

```sh
AGENTS_HOME=/absolute/.agents \
AGENTS_USER_HOME=/absolute/user-home \
AGENTS_ROOT=/absolute/agents-manager \
  bun run agents -- state doctor
```

Never run tests with the personal state root unless the test is an intentional
read-only installed-boundary proof.
