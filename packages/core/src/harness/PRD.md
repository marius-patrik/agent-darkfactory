# Agent OS Runtime Harness PRD

## Purpose

Provide the in-process TypeScript execution layer for one Agent OS identity.
The harness records canonical session events, reconstructs projections, invokes
provider adapters selected by the manager, and executes declared tools without
creating another authority.

## Requirements

- Session mutations append immutable, hash-linked events under the supplied
  `AGENTS_HOME` state descriptor.
- Session writes are serialized with private leases and projections are
  rebuildable from events.
- Provider and model changes are represented as session events.
- Managed provider turns receive canonical Agent OS startup context through the
  manager-owned adapters.
- Tool execution records user, assistant, tool, usage, quota, and completion
  results through the same session event stream.

## Non-goals

- A standalone harness CLI, package release, or compatibility entrypoint.
- State-root discovery, provider-home fallback, provider binary discovery, or
  credential copying.
- A second agent registry, switcher database, scheduler, swarm store, or
  orchestration ledger.
- Treating provider history or provider-generated memory as authority.

## Acceptance

- TypeScript typecheck and session/tool tests pass.
- No retired Go harness, `rommie` command, retired root variable, or standalone
  harness manifest is reachable from the repository.
- All persisted harness state is derived from the explicit canonical Agent OS
  state descriptor.
