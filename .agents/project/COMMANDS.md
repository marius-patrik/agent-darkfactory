# Commands

```sh
bun install --frozen-lockfile
bun run check
bun run test
bun run ci
bun run smoke:release
bun run smoke:sync
```

`bun run ci` is the complete local gate. The hosted workflow runs the same
suite contract as independent matrix legs and exposes one required `Validate`
aggregator. A focused suite can be reproduced with:

```sh
node scripts/run-ci-suite.mjs <inventory|core|gateway|gateway-real|engine-real|harness|inference|manager|darkfactory|memory|release|sync|review>
```

Component-focused validation still runs from the repository root unless a
subshell is shown:

```sh
# Core contracts and generated clients
bunx tsc --noEmit -p src/sdk/tsconfig.json
bunx buf lint src/mcp/proto
bun scripts/verify-codegen.ts
(cd src/sdk/contracts-go && go test ./...)

# Harness behavior
node scripts/run-ci-suite.mjs harness

# The exhaustive manager-coupled harness files remain:
bun test src/sdk/harness/test/tools.test.ts \
  src/cli/test/session.test.ts \
  src/cli/test/session-adapters.test.ts \
  src/cli/test/tui-tools.test.ts

# Gateway package
(
  cd src/server/gateway
  uv sync --frozen
  uv run ruff check llm_gateway tests scripts
  uv run mypy llm_gateway
  uv run pytest -q -m 'not live'
  ANDROMEDA_HOME=/absolute/disposable/.agents \
  ANDROMEDA_USER_HOME=/absolute/disposable \
  ANDROMEDA_ROOT=/absolute/Andromeda \
    uv run python scripts/packaging_smoke.py
  uv build
)

# Inference package
bun src/server/inference/scripts/validate.mjs

# Pinned DarkFactory plugin
node scripts/run-ci-suite.mjs darkfactory

# Pinned Memory plugin
node scripts/run-ci-suite.mjs memory

# Real gateway and inferctl seams
node scripts/run-ci-suite.mjs gateway-real
node scripts/run-ci-suite.mjs engine-real
```

Explicit temporary or live state commands must always set all three roots:

```sh
ANDROMEDA_HOME=/absolute/.agents \
ANDROMEDA_USER_HOME=/absolute/user-home \
ANDROMEDA_ROOT=/absolute/Andromeda \
  bun run agents -- state doctor
```

Never run tests with the personal state root unless the test is an intentional
read-only installed-boundary proof.
