# Agent OS Container Data Contracts

Status: parked supporting design. The program plan and PRD park custom
distro/container work; this document records evidence for a future
owner-authorized issue and does not authorize implementation.

This is the mount/environment contract for the future Agent OS image. Host
paths are resolved by `agents-manager`; container processes consume only the
projected container paths.

## Principles

- The image is replaceable; mounted canonical state and registered data are
  durable.
- One physical `ANDROMEDA_HOME` is mounted read-write. No provider, harness, or
  service receives a second state root.
- Code, operational data, and workspaces are distinct scopes.
- Provider databases, models, caches, logs, locks, and raw transcripts are
  local-only by default.
- Secrets are explicit scoped mounts or environment references and never image
  content, plan output, logs, or ordinary event exchange.
- Every mount appears in `agents os doctor` and lifecycle plan output.

## Container paths

| Variable | Container path | Purpose |
| --- | --- | --- |
| `ANDROMEDA_ROOT` | `/opt/agents-os` | Read-only distribution/package root |
| `ANDROMEDA_HOME` | `/agents/state` | The one canonical state root |
| `ANDROMEDA_USER_HOME` | `/home/agents` | Runtime account home, not state |
| `ANDROMEDA_SYSTEM_DATA_ROOT` | `/agents/state` | The same private-data checkout as `ANDROMEDA_HOME` |
| `ANDROMEDA_WORKSPACE` | `/workspace/agents` | Private Agent OS runtime workspaces |
| `ANDROMEDA_CLIS` | `/agents/state/clis` | Opaque provider homes |
| `ANDROMEDA_IDENTITY` | `/agents/state/identity` | Single Rommie identity and worker roles |
| `ANDROMEDA_MEMORY` | `/agents/state/memory` | Canonical memory authority |
| `ANDROMEDA_SESSIONS` | `/agents/state/sessions` | Canonical session events/projections |
| `ANDROMEDA_ORCHESTRATOR` | `/agents/state/orchestrator` | Orchestrator events/lease/projections |
| `ANDROMEDA_SKILLS` | `/agents/state/skills` | Canonical shared skills |
| `ANDROMEDA_PLUGINS` | `/agents/state/plugins` | Canonical shared plugins |
| `ANDROMEDA_HOOKS` | `/agents/state/hooks` | Canonical shared hooks |
| `ANDROMEDA_TEMPLATES` | `/agents/state/templates` | Canonical templates |
| `ANDROMEDA_HARNESSES` | `/agents/state/harnesses` | Harness-local runtime roots |
| `ANDROMEDA_SECRETS` | `/agents/state/secrets` | Local secret registry/materializations |
| `ANDROMEDA_DATA_REPOS` | `/agents/state/data-repos.json` | Data registry |
| `ANDROMEDA_CREDITS` | `/agents/state/credits.json` | Credit ledger |

Provider-native variables are derived inside the container exactly as on the
host: Codex, Claude, and Kimi keep the real runtime account `HOME`; Agy receives
an isolated `HOME` at `/agents/state/clis/agy`. No standalone `.codex`,
`.claude`, `.kimi-code`, or `.gemini` path is created.

## Host mounts

The lifecycle planner resolves absolute physical paths and rejects symlinked
state roots. A minimum plan maps:

| Host source | Container target | Mode |
| --- | --- | --- |
| `$ANDROMEDA_HOME` | `/agents/state` | read-write, private |
| `$ANDROMEDA_ROOT` or packaged distribution | `/opt/agents-os` | read-only |
| each additional registered data repo | declared `/agents/data/<id>` | package-declared |
| the active registered workspace | declared `/workspace/<id>` | package-declared |

The personal source checkout is separate from state and is not inferred from
`HOME` or cwd. The sole Agent OS data checkout is `$ANDROMEDA_HOME`, recorded
exactly once as `agent-os-data`; `ANDROMEDA_SYSTEM_DATA_ROOT` must equal that same
path. Runtime workspaces live under `$ANDROMEDA_HOME/runtime/workspaces`. Product
validation rejects a missing, renamed, relocated, or aliased system-data
record.

## Package declarations

Package manifests may declare required data repositories, workspaces, secret
scopes, ports, health checks, image inputs, and runtime dependencies. Container
plans are derived from canonical `packages.json`, `data-repos.json`, and
`environments.json`; they do not duplicate those mappings in sidecar state.

Each service receives only its declared writable scopes. DarkFactory may use a
registered operational data repo and workspace, but neither becomes Agent OS
identity, memory, or orchestration authority.

## Secret boundary

- Plans and doctor output show names/scopes only.
- Provider credentials remain in canonical opaque provider homes unless a
  future provider-aware runtime mount is explicitly defined.
- No generic credential copier or timestamp merge exists.
- Container logs and event payloads must redact secret-bearing arguments and
  values.
- Ordinary cross-machine exchange never includes the secret class.
- The private-data Git history carries only authenticated encrypted event
  bundles under `backups/events/`; the local sync key is never committed.

## Removal and recovery

Stopping or removing a managed container does not delete mounts. A future
`--prune-data` operation is a separate destructive decision and must enumerate
the exact registered paths, refuse the canonical state root, and require
verified recovery evidence.
