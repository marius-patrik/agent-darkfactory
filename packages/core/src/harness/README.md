# Agent OS Runtime Harness

This directory contains the TypeScript runtime harness used by `agents`. It is
part of the consolidated `packages/core` implementation and is not a separate
product, install, release, or state authority.

## Current surface

| Path | Responsibility |
| --- | --- |
| `session.ts` | Append-only canonical session events, write leases, replay, and generated projections. |
| `session-adapters.ts` | Provider-adapter interface support and deterministic test adapters. |
| `tools.ts` | Tool-call parsing/execution and event-backed provider/model switching. |

Managed provider processes are resolved and launched by
`packages/core/src/manager`. Harness state is rooted only through the explicit
Agent OS state descriptor below `AGENTS_HOME`; provider-native state remains
under `AGENTS_HOME/clis/<provider>`.

Agent OS may also register external packages of kind `harness` and run them
through `agents harness run`. That generic package facility does not make this
source directory a self-registered harness package.

## Retired surface

The former Go `rommie` compatibility CLI, its standalone package manifest,
provider-exec delegation, credential materialization, switcher store, and
mutable orchestration ledger had no live caller after the TypeScript runtime
became canonical and are not part of this tree. The stable personal agent id
`rommie` remains valid identity/protocol data; no executable or state-root alias
is derived from it.

## Validation

From the repository root:

```sh
bun run check
bun test packages/core/test/manager/session.test.ts \
  packages/core/test/manager/session-adapters.test.ts \
  packages/core/test/manager/tui-tools.test.ts
```

See [PRD.md](PRD.md) for the behavioral boundary and
[docs/ownership.md](docs/ownership.md) for the owner map.
