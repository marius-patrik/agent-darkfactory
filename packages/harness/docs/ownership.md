# Runtime Harness Ownership

| Area | Owner |
| --- | --- |
| Session event schema, locking, replay, and projections | `packages/harness/session.ts` |
| Tool loop and event-backed provider/model changes | `packages/harness/tools.ts` |
| Managed provider invocation and startup-memory injection | `packages/manager/src/session-adapters.ts` |
| State roots, provider registry, memory, CLI, packages, and orchestration policy | `packages/manager/src` |
| Shared wire contracts and generated clients | `packages/core` |
| Model routing and gateway OAuth refresh | `packages/gateway` |
| Agent loop and inference execution | `packages/inference` |

The harness directory has no independent binary, manifest, release version,
state root, credentials, switcher store, or orchestration ledger. External
harness packages remain ordinary Agent OS package registrations.
