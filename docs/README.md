# Andromeda documentation

This is the repository's only documentation root. Package directories contain
implementation and manifests, not nested repository policy or documentation.

## Authority

Authority has two explicit dimensions. Current owner instruction is highest,
and private-data `context/TASK.md` records authorization, high-level
sequencing, and parked scopes; no plan, PRD, issue, or supporting document can
reopen a board-gated scope. Within authorized work, the program derivation
chain recorded by [#219](https://github.com/marius-patrik/Andromeda/issues/219)
is owner instruction → private-data `context/PLAN.md` → root
[`PRD.md`](../PRD.md) → GitHub issues. The plan feeds the PRD, the PRD specifies
the system, and issues implement it. The documents indexed here support those
authorities; they do not replace them or authorize work.

## Product and state

- [Canonical state and memory v2](state-memory-v2.md)
- [State synchronization](state-sync.md)
- [Capabilities](capabilities.md)
- [Managed enforcement](managed-enforcement.md)
- [CI validation](ci-validation.md)

## Components

- [Manager](manager.md)
- [Core contracts](core.md)
- [Runtime harness](harness.md)
- [Gateway runtime](gateway-runtime.md)
- [Gateway architecture](gateway.md)
- [Inference](inference.md)

These documents describe the current implementation. Target behavior and
authorized changes come from the PRD and their GitHub issues.

## Active contracts and component boundaries

- [Wire contract](contracts/wire.md)
- [Manager boundary](specs/manager.md)
- [Harness boundary](specs/harness.md)

## Parked design material

The custom distro/container scope is parked in the program plan and PRD. These
files preserve supporting design material only; they are not implementation
authority or permission to resume the scope:

- [Container architecture](andromeda-os/ARCHITECTURE.md)
- [Image build and release](andromeda-os/BUILD.md)
- [Container data contracts](andromeda-os/DATA-CONTRACTS.md)
- [Packages and environments groundwork](packages-and-environments.md)

## Retired design evidence

These documents describe implementation seams that are absent from the current
tree and depend on superseded planning authorities. They are preserved only as
evidence for the successor PRD issues:

- [Engine interface](contracts/engine.md)
- [Execution lane](contracts/exec-lane.md)
- [Worker lifecycle](contracts/worker-lifecycle.md)
