# Agent OS repository guidance

Load the project-local authority before non-trivial work:

1. `.agents/.project/AGENTS.md`
2. `.agents/.project/PROJECT.md`
3. `.agents/.project/COMMANDS.md`
4. `.agents/.project/STATUS.md`
5. `.agents/.project/HANDOFF.md`

Shared identity, memory, roles, and skills are installed once under
`$AGENTS_HOME`; this repository does not carry a second global agent floor.

Repository policy, agent guidance, and documentation are root-owned. Do not
add `.agents`, `.darkfactory`, `docs/`, `AGENTS.md`, `README.md`, or `PRD.md`
below `packages/`. Component documentation belongs under root `docs/`, and
component-specific validation commands belong in
`.agents/.project/COMMANDS.md`.

Component boundaries:

- `packages/manager` owns the `agents` CLI, canonical state, providers,
  sessions, memory, orchestration, packages, and lifecycle management.
- `packages/core` owns protobuf contracts and generated Go, TypeScript, and
  Python clients.
- `packages/harness` owns canonical session events and the event-backed tool
  loop; it does not own state-root or provider-discovery policy.
- `packages/gateway` owns local model routing and transient gateway runtime
  state; it requires an explicit absolute `AGENTS_HOME`.
- `packages/inference` owns the Python inference loop and private runtime state.
