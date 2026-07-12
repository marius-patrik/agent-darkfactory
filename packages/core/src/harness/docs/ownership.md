# Runtime Harness Ownership

| Area | Owner |
| --- | --- |
| Session event schema, locking, replay, and projections | `packages/core/src/harness/session.ts` |
| Tool loop and event-backed provider/model changes | `packages/core/src/harness/tools.ts` |
| Managed provider invocation and startup-memory injection | `packages/core/src/manager/session-adapters.ts` |
| State roots, provider registry, memory, CLI, packages, and orchestration policy | `packages/core/src/manager` |
| Shared wire contracts and generated clients | `packages/core/src/core` |
| Model routing and gateway OAuth refresh | `packages/core/src/gateway` |
| Agent loop and inference execution | `packages/core/src/inference` |

The harness directory has no independent binary, manifest, release version,
state root, credentials, switcher store, or orchestration ledger. External
harness packages remain ordinary Agent OS package registrations.
