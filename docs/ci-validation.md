# CI Validation

`Validate` is a fail-closed aggregate, not a single optimistic test command.
It succeeds only when every matrix leg declared in `.github/ci/test-inventory.json`
succeeds. The same commands run locally through
`node scripts/run-ci-suite.mjs <suite>`; `bun run ci` runs every unique suite.

## Active component suites

| Component | Suite | Hosted platforms | Coverage |
| --- | --- | --- | --- |
| `packages/migrate/core` | `core` | Ubuntu, Windows | TypeScript types/imports, generated contract freshness, Python imports, Go tests |
| `packages/server/gateway` | `gateway` | Ubuntu | uv lock sync, lint, types, all non-live tests, packaging smoke, build |
| `packages/sdk/harness` | `harness` | Ubuntu | direct tool-boundary tests plus the complete manager-coupled session, adapter, and tool-loop suites |
| `packages/server/inference` | `inference` | Ubuntu | uv lock sync, lint, types, all non-live tests, build, CLI/import/layering checks |
| `packages/cli` | `manager` | Ubuntu, Windows | TypeScript types, all manager tests, compact-capsule regression |
| `packages/darkfactory` | `darkfactory` | Ubuntu | pinned public submodule, npm clean install, full check including templates and build |
| `packages/memory` | `memory` | Ubuntu, Windows | pinned public submodule, manager-integrated TypeScript and plugin behavior tests |

Inventory `requiredPaths` are durable coverage anchors, not an exhaustive test
allowlist. Core, harness, and manager recursively discover every Bun
`*.test.*`/`*.spec.*` file under their owned test roots; pytest and Go keep their
native suite discovery. Adding a test under an active component therefore adds
it to `Validate` without another hand-maintained path entry.

Harness has an explicit test-location exemption. Its session implementation
depends on manager-owned canonical state and CLI adapters, so the exhaustive
session tests remain under `packages/cli/test`. The inventory names those
files individually and fails if any disappear; `packages/sdk/harness/test` owns
the package-local tool-boundary regression triplet.

The parked `packages/lifequest`, `packages/skyagent`, and `packages/fabrica`
gitlinks are classified but intentionally have no CI suite.
Adding any package, plugin, or app without classifying and wiring it makes
layout validation fail.

## Real-behavior legs

The `gateway-real` suite starts the actual uvicorn gateway process and drives
plain and streaming OpenAI-wire completions over loopback sockets to a bounded
echo backend. It also proves that a malformed backend response fails closed.

The `engine-real` suite supplies the echo backend through the
`inferctl-local-engines-v1` status seam, then verifies discovery, model
registration, task routing, and completion delivery through the running
gateway. Live GPU acceptance remains a machine-level gate and is not part of
hosted CI.

## Product smokes

The `release` suite runs the source installer twice in a disposable sandbox,
initializes every pinned component through deterministic local stubs, invokes
the installed launcher, performs a fresh `state init`, and requires
`state doctor --json` to stay green. It also exercises wrong-origin and nested
checkout failures.

The `sync` suite creates two independent disposable state roots with the same
local exchange key. It exports and imports an authenticated encrypted bundle,
proves replay idempotence, exchanges a reverse event, and requires both memory
projections to finish with the same parity digest.

## Required result

Every suite is an independent job with `fail-fast: false`, so failures remain
visible across the complete inventory. The protected `Validate` job runs with
`always()` and succeeds only when the entire suite matrix succeeds. A skipped,
cancelled, missing, or failed matrix leg therefore cannot appear green.
