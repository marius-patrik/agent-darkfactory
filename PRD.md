# Agent OS / Andromeda PRD

## Overview

Agent OS is a single personal agent system that can execute through multiple
models, provider CLIs, harnesses, and machines without creating competing
identity, memory, session, or configuration authorities. The
`Andromeda` repository implements the system, and its `agents` CLI is the
single management and runtime surface.

[Canonical State and Memory v2](docs/state-memory-v2.md) is the authoritative
state specification. This PRD defines the product boundary and required CLI
capabilities around it.

## Naming and authority

- **Agent OS** — final product name.
- **Andromeda** — repository. npm package surface stays `@marius-patrik/agents-manager` (recorded exception).
- **agents** — CLI command.
- **`~/.agents` / `AGENTS_HOME`** — only authoritative runtime state root.
- **`packages/`** — implementation domains, each rooted as one direct child.
- **`plugins/`** — managed product plugins and authored plugin capabilities.

Historical product, repository, and layout names are evidence to migrate and
retire. They are not supported aliases or compatibility contracts.

## Goals

- Give one agent identity access to Codex, Claude, Kimi, Agy, future
  providers, and managed harnesses.
- Maintain one versioned state and memory authority with explicit provenance,
  supersession, deterministic projections, and bounded startup context.
- Root all provider-native state below `AGENTS_HOME/clis/<provider>`.
- Preserve ordered canonical session and orchestration events across provider
  switches while retaining native resume handles where supported.
- Manage packages, data repositories, environments, skills, plugins, hooks,
  templates, secrets, and credits through `agents`.
- Provide journalled, idempotent, reversible migration from inventoried retired
  data into the final layout, then remove every superseded live path.
- Provide safe cross-machine event exchange with deterministic replay,
  tombstones, locking, and secret/symlink rejection.
- Validate the real installed provider invocation and filesystem-write
  contracts, not only mocked adapters.

## Non-goals

- Preserve old product names, state roots, top-level provider links, or a
  permanent compatibility layer.
- Treat provider transcripts, provider-generated memory, old handoff files, or
  recovery archives as current truth.
- Blindly merge provider credentials or databases by timestamp.
- Sync mutable provider databases, raw transcripts, secrets, models, caches,
  logs, locks, or process state.
- Replace language/package managers such as Bun, npm, or uv.

## Users

- A person operating one long-lived agent identity across multiple models and
  interfaces.
- Agent developers managing packages, harnesses, and runtime capabilities.
- Automation that needs deterministic state discovery and auditable changes.

## Core concepts

- **Canonical state:** the sole writable authority below `AGENTS_HOME`.
- **Provider home:** opaque provider-native state below `clis/<provider>`;
  evidence and runtime storage, never memory authority.
- **Memory record:** immutable, provenance-backed fact with lifecycle status
  and explicit supersession.
- **Projection:** generated state (for example Markdown memory views or mutable
  session manifests) rebuilt from canonical records/events.
- **Session:** stable Agent OS id plus ordered canonical events and provider
  resume handles.
- **Orchestrator:** a session mode whose baton is a lease and whose durable
  state is reconstructed from events.
- **Capability:** an installed skill, plugin, hook, template, CLI, or harness.
- **Package:** a registered local or git-backed Agent OS component.
- **Data repository:** a managed data checkout recorded in canonical registry
  state; it is not another Agent OS state root.

## Functional requirements

### State and memory

- `agents state init` bootstraps the v2 manifest and canonical directories
  without moving provider content.
- `agents state env` renders the canonical environment projection.
- `agents state doctor [--json]` detects multiple roots, forbidden standalone
  provider paths, invalid links, unsafe exchange state, and retired artifacts.
- `agents state status [--json]` uses the unambiguous states `forbidden`,
  `canonical`, `split`, and `missing`.
- Retired provider-adoption and Git snapshot-sync commands are absent; migration
  is an offline, journalled operation rather than a runtime compatibility path.
- Cross-machine exchange is disabled until immutable-event merge, tombstones,
  encrypted transport, and adversarial safety proofs are complete.
- `agents memory remember|list|status|supersede|retract|render` manages
  provenance-backed canonical records and generated views. Mutations require
  source URI, content hash, source class, and confidence.

### Providers, sessions, and orchestration

- `agents cli list|doctor|pin|env` inspects provider adapters and pins executable
  versions/checksums. Provider execution occurs only through managed Agent OS
  sessions, which inject canonical startup context.
- `agents run`, `agents tui`, and `agents sessions list|resume` provide the
  operator session surface.
- `agents session run|list|show` provides explicit provider/model execution and
  inspection.
- Provider switching preserves ordered user, assistant, tool, usage, and
  handoff events. A rendered-transcript replay is an explicitly labelled
  fallback, not native continuation.
- Provider processes write only to their declared canonical homes, and their
  tool subprocesses see the real OS user home where required.

### Packages and capabilities

- `agents list|info|add|remove|sync` manages git-backed package checkouts.
- `agents packages register|list|run` manages local package manifests.
- `agents packages distro ...` and `agents packages container ...` provide the
  typed package/image surface; unavailable mutations must fail explicitly.
- `agents env list|create|switch|sync` manages named environment records and
  actions, with unavailable behavior reported explicitly.
- `agents data repo list|set|path|env` manages data-repository registry entries.
- `agents harness list|doctor|run` manages runtime harnesses.
- `agents install <kind> ...` and `agents installs` manage capability installs.
- `agents secrets ...` manages secret metadata/materialization and explicit
  GitHub-secret synchronization without printing values.
- `agents credits ...` maintains the shared credit ledger.
- `agents doctor` validates package registration and the integrated system.
- `agents os ...` manages the declared Agent OS image and environment lifecycle.

## Canonical state layout

```text
~/.agents/
  manifest.json
  env
  config.json
  node.yaml
  identity/
  clis/<provider>/
  sessions/<session-id>/
  memory/
    events/<machine-id>/<event-id>.json
    records/
    views/
    index.sqlite
  orchestrator/
  skills/
  plugins/
  hooks/
  templates/
  store/sha256/
  installs.json
  packages.json
  data-repos.json
  environments.json
  providers.json
  secrets/
  runtime/
  sync/
  provenance/
  harnesses/<harness-id>/runtime/
  models/
  data/
```

The top-level registry files shown above remain canonical; they are not
duplicated into another registry tree. `~/.agents/state` is forbidden. The
final installation also has no physical directory or link at `~/.codex`,
`~/.claude`, `~/.kimi-code`, or `~/.gemini`.

## Environment contract

- `AGENTS_HOME` is the absolute canonical state root and the only accepted
  state locator.
- `AGENTS_USER_HOME` is the stable real OS account home.
- `AGENTS_ROOT` identifies the active Agent OS code/distribution checkout; it
  never changes state authority.
- Provider-native variables such as `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, and
  `KIMI_CODE_HOME` are generated projections pointing below
  `AGENTS_HOME/clis/`; they are not independently configurable roots.
- No historical product-specific root variable is accepted as a state locator.

## Provider contract

| Provider | Canonical native home | Process home |
| --- | --- | --- |
| Codex | `AGENTS_HOME/clis/codex` | real user home |
| Claude | `AGENTS_HOME/clis/claude` | real user home |
| Kimi | `AGENTS_HOME/clis/kimi` | real user home |
| Agy | `AGENTS_HOME/clis/agy` | isolated only inside the provider process when required |

Credential reconciliation is explicit, provider-aware, non-destructive, and
journalled. It never uses blind last-write-wins copying and never prints secret
values.

## Memory and projection contract

Explicit current user instruction outranks verified live facts, which outrank
active canonical memory. Inference must be labelled; provider transcripts and
archives are evidence only. At most one scalar record is active for a given
agent/scope/subject/predicate tuple. Conflicts are superseded, retracted, or
kept disputed rather than silently overwritten.

Canonical events are append-only and machine-partitioned. Projection writes
use a lease/lock, temporary file, flush, and atomic rename. Startup context is
a bounded generated view of active facts and work with age and provenance
labels.

## Sync and migration safety

Roaming state consists of non-sensitive identity/configuration plus canonical
memory, session, and orchestrator events. Reproducible capabilities are restored
from source/content-addressed stores. Machine facts remain per-machine. Provider
databases, raw transcripts, secrets, models, caches, logs, locks, and process
state remain local-only.

No retired adoption or snapshot-sync engine remains. Migration is staged,
journalled, idempotent, reversible, and verified by count/hash parity before
any old live path is removed. Future event exchange
rejects symlinks/path escapes and secrets, exchanges immutable events, supports
tombstones, and produces identical projection hashes on participating machines.

## Repository layout

```text
packages/core/
packages/manager/
packages/harness/
packages/gateway/
packages/inference/
plugins/darkfactory/
plugins/life-support/
plugins/skyblock-agent/
plugins/singularity/
skills/
hooks/
roles/
commands/
persona.md
data/agent-os/
```

No obsolete `os/` package topology is part of the final product.

## Installation and validation

The supported source install maintains one checkout of
`marius-patrik/Andromeda`, writes one regular `AGENTS_HOME/bin/agents`
launcher, initializes explicit canonical roots, pins installed providers, and
runs `agents state doctor`. It uses no global package-manager link. Old product
checkout locations and installers are not supported update paths.

CI runs:

```sh
bun run check
bun run test
```

Acceptance requires the behavioral proofs in
[Canonical State and Memory v2](docs/state-memory-v2.md), including idempotent
bootstrap/migration, provider write-root proofs, deterministic replay and
projection hashes, correct supersession, two-machine tombstones, and
secret/symlink rejection.

## Delivery milestones

1. Non-destructive root resolution, v2 bootstrap/doctor, correct provider
   invocation, and disabled unsafe mutations.
2. Journalled provider-home and memory migration with verified retired-state removal.
3. Canonical session/orchestrator event replay and native continuation proofs.
4. Capability content-addressing and provider projections.
5. Two-machine event exchange, tombstones, locking, and recovery proofs.
6. Release-backed installation and daily-use activation of the reconciled Agent
   OS.
