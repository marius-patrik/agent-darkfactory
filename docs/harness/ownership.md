# Runtime Harness Ownership

| Area | Owner |
| --- | --- |
| Session event schema, locking, replay, and projections | `packages/sdk/harness/session.ts` |
| Tool loop and event-backed provider/model changes | `packages/sdk/harness/tools.ts` |
| Managed provider invocation and startup-memory injection | `packages/cli/src/session-adapters.ts` |
| State roots, provider registry, memory, CLI, packages, and orchestration policy | `packages/cli/src` |
| Shared wire contracts and generated clients | `packages/migrate/core` |
| Model routing and gateway OAuth refresh | `packages/server/gateway` |
| Agent loop and inference execution | `packages/server/inference` |

The harness directory has no independent binary, manifest, release version,
state root, credentials, switcher store, or orchestration ledger. External
harness packages remain ordinary Agent OS package registrations.
