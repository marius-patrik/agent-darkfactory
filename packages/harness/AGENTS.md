# Agent OS Harness Notes

This directory owns the TypeScript execution harness used by the canonical
`agents` runtime. Before changing it, read the repository-root `AGENTS.md`,
`README.md`, `PRD.md`, this directory's `README.md` and `PRD.md`, and
`docs/ownership.md`.

## Boundary

- `session.ts` owns canonical session events, locking, and generated session
  projections.
- `session-adapters.ts` owns harness-level adapter contracts and test adapters.
- `tools.ts` owns the event-backed tool loop used by managed sessions.
- `packages/manager/src` owns `AGENTS_HOME`, provider pinning and
  invocation, the `agents` CLI, memory, and orchestration policy.

Do not add another executable, state root, provider wrapper, credential copier,
mutable orchestration ledger, provider-specific memory loader, or compatibility
surface here. The stable personal agent id may remain `rommie`; it is identity
data, not a retired CLI or product root.

Validate from the repository root with `bun run check` and the relevant Bun
tests under `packages/manager/test`.
