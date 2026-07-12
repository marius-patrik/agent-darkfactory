# Agent OS Manager PRD

The root [PRD](../../PRD.md) and
[canonical state specification](../state-memory-v2.md) are the
product authority. This file records the manager package boundary.

## Ownership

The Bun/TypeScript manager owns:

- one-root bootstrap, environment projection, and read-only doctor;
- provider-home derivation, executable pinning, and managed session launch;
- evidence-backed memory and startup projection;
- canonical session/orchestrator events and projections;
- package, data-repository, environment, capability, secret-metadata, and
  credit registries;
- the `agents` CLI, TUI, installer boundary, and declared container lifecycle
  surface.

It does not maintain alternate provider homes, copy credentials from retired
paths, expose raw provider execution, or synchronize mutable machine snapshots.

## Current operator surface

```text
agents run|tui|sessions ...
agents state init|env|doctor|status
agents memory remember|list|status|supersede|retract|render
agents cli list|doctor|pin|env
agents list|info|add|remove|sync
agents packages ...
agents data repo ...
agents env ...
agents harness ...
agents install ...
agents secrets ...
agents credits ...
agents os ...
```

Unsupported package/environment/image mutations fail explicitly. Dry-run
container plans are not evidence that Docker, an image build, or a deployment
ran.

## State boundary

All writable authority is below explicit `AGENTS_HOME`. Provider executables
and native state live below `clis/<provider>`, capabilities below their
canonical top-level directories, and harness-private runtime below
`harnesses/<id>/runtime`. `AGENTS_ROOT` is code; `AGENTS_USER_HOME` is the real
account home; neither is another state root.

## Validation

`bun run ci` must pass from the repository root. Release acceptance also
requires the isolated installer smoke, a green live state doctor, provider
checksum verification, and real write-boundary probes where safe.
