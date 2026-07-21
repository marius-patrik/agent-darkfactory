# Agent OS repository guidance

Load the project-local authority before non-trivial work:

1. `capabilities/.project/AGENTS.md`
2. `capabilities/.project/PROJECT.md`
3. `capabilities/.project/COMMANDS.md`
4. `capabilities/.project/STATUS.md`
5. `capabilities/.project/HANDOFF.md`

Shared identity, memory, roles, and skills are installed once under
`$ANDROMEDA_HOME`; this repository does not carry a second global agent floor.

Andromeda-owned repository policy, agent guidance, and documentation are
root-owned. Do not add `capabilities`, `.darkfactory`, `docs/`, `AGENTS.md`,
`README.md`, or `PRD.md` inside superproject-owned implementation packages.
Managed repository gitlinks below `src/` retain their independently owned
child policy and documentation; those child files do not become Andromeda
authority. Andromeda component documentation belongs under root `docs/`, and
component-specific validation commands belong in `capabilities/.project/COMMANDS.md`.

Component boundaries:

- `packages/cli` owns the `agents` CLI, canonical state, installs,
  credentials/secrets, providers, sessions, memory, packages, lifecycle
  management, and — until the #218 harness migration is implemented and
  accepted — orchestration.
- `packages/sdk` owns the generated Go, TypeScript, and Python clients and the
  suite that verifies them; `packages/mcp` owns the protobuf sources.
- `packages/sdk/harness` owns canonical session events and the event-backed tool
  loop, with the owner-ruled target (#218) of becoming the operation engine
  owning orchestration; it does not own state-root or provider-discovery
  policy.
- `packages/server/gateway` owns local model routing and transient gateway runtime
  state; it requires an explicit absolute `ANDROMEDA_HOME`.
- `packages/server/inference` owns the Python inference loop and private runtime state.
