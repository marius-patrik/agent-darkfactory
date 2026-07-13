# Agent OS / Andromeda PRD

## Overview

Agent OS is a single personal agent system that can execute through multiple
models, provider CLIs, harnesses, and machines without creating competing
identity, memory, session, or configuration authorities. The
`Andromeda` repository implements the system, and its `agents` CLI is the
single management and runtime surface.

Andromeda is one program, not a collection of adjacent tools. Every component
in this repository — state/manager core, orchestration harness, model/execution
substrate, and GitHub control plane — is a layer of the same system and is
specified, validated, and released as such.

[Canonical State and Memory v2](docs/state-memory-v2.md) is the authoritative
state specification. This PRD defines the product boundary, the system
layering, and the required capabilities around it.

## North star and program plan

The owner-set end state: **the system runs itself — multi-agent, one system,
GitHub-only control.** An orchestrator assesses global state on schedule, plans
waves, dispatches per-component agents within concurrency caps, posts
dashboards, and escalates only via ask-owner issues. The full backlog drains
through DarkFactory lanes: issue → branch (from `dev`) → PR → CI + Codex Review
gates → automerge → release. Zero orchestrator terminal sessions. "GitHub-only
control" means autonomous orchestration operates exclusively through the GitHub
control plane; the `agents` CLI remains the local operator surface.

This PRD is the repository's specification source of truth. The consolidated
program plan in the Andromeda-data authority at `context/PLAN.md` sequences
execution across lanes: it orders work and records parked scopes, and it does
not supersede repository-owned specification. Owner instruction outranks both;
issues implement this PRD. The program's end-state demo — the full system
running in one container from an agents-os image — is parked with all custom
distro/distribution work until the owner reopens it.

## Naming and authority

- **Agent OS** — final product name.
- **Andromeda** — repository. npm package surface stays `@marius-patrik/agents-manager` (recorded exception).
- **agents** — CLI command.
- **`~/.agents` / `AGENTS_HOME`** — only authoritative runtime state root; a
  checkout of the Andromeda-data authority.
- **`packages/`** — implementation domains, each rooted as one direct child.
- **`plugins/`** — managed product plugins and authored plugin capabilities.

Historical product, repository, and layout names are evidence to migrate and
retire. They are not supported aliases or compatibility contracts.

## System layering

| Component | Role |
| --- | --- |
| `packages/core` | Protobuf sources and generated Go, TypeScript, and Python contracts |
| `packages/manager` | `agents` CLI, state, providers, sessions, memory, orchestration, package/capability registries, and lifecycle operations — the single local management surface |
| `packages/harness` | Canonical session event handling and tool execution; growth disposition pending — roadmap or documented dormancy, no silent limbo |
| `packages/gateway` | Local model registry, routing, health, quota, and transient control-plane relay; switcher control plane and cloud OAuth dispatch |
| `packages/inference` | Gateway-backed Python agent loop, status, persistence, redaction, and package validation; engine discovery and serve profiles |
| `plugins/darkfactory` | Thin GitHub control-plane adapter: issues/PRs/labels ↔ work units, enforcement sync, review gates. No second brain. |

Binding architecture rule: local system management operations are implemented
in the manager and consumed by DarkFactory — no parallel implementations in the
control plane — while gateway and inference own their assigned local runtime
responsibilities. GitHub is the remote control plane; the `agents` CLI is the
local one.

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
- Productize the model/execution substrate: one canonical gateway name and
  registry backend, a stable switcher control-plane contract, credential-gated
  cloud OAuth dispatch, and a supported install/run/update path with runtime
  profiles.
- Enforce the GitHub control plane fail-closed: required CI and review gates on
  `dev` and `main`, managed templates that cover every active toolchain, and
  credential-isolated review takeover.
- Make CI prove the whole system: every active component's suite on every PR,
  real-behavior legs, a Windows matrix leg, and fail-closed suite inventory.

## Non-goals

- Preserve old product names, state roots, top-level provider links, or a
  permanent compatibility layer.
- Treat provider transcripts, provider-generated memory, old handoff files, or
  recovery archives as current truth.
- Blindly merge provider credentials or databases by timestamp.
- Sync mutable provider databases, raw transcripts, secrets, models, caches,
  logs, locks, or process state.
- Replace language/package managers such as Bun, npm, or uv.
- Advance parked scopes (custom distro/distribution including the container
  capstone and Docker-OS TUI terminal, observability stack, and the other
  board-parked items) before the owner explicitly reopens them.

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
- **Substrate:** the model/execution layer (gateway + inference) that serves
  and routes model calls for every other component.
- **Control plane:** the GitHub-facing enforcement and work-dispatch layer
  (DarkFactory) plus the local `agents` management surface.

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
- State publication (projections, backups) is atomic and survives transient
  filesystem failures on every supported platform, Windows included.

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

### CLI surface and distribution

- The installed launcher binds only canonical current paths; `agents` is a
  genuinely global command on supported machines.
- Bare `agents` enters the TUI directly. Every manager action is reachable from
  the TUI, which supports switchable style presets (Claude Code, Codex, and
  Kimi aesthetics plus a default Agent OS identity theme) and a preset default
  provider and model (owner selection pending).
- Help output is command-specific at the root and every subcommand: usage,
  arguments, options, defaults, examples, and related commands.
- Distribution is release-backed: per-platform binaries or self-contained
  archives with signed artifacts/checksums, a Windows PowerShell installer
  alongside the Bash installer, and an `agents update` self-update path.

### Model/execution substrate (gateway and inference)

- One canonical gateway identity: public name, distribution name, import
  namespace, CLI script name, and agent package id are decided and consistent;
  any retained compatibility naming is explicit and tested.
- One canonical registry backend with a deterministic local fallback; operator
  migration off ad-hoc YAML state; persistence semantics covered by non-live
  tests plus gated live tests.
- The switcher control plane implements the canonical proto/Connect
  SwitcherService contract with session > project > global scope resolution and
  persistence; REST remains only as a compatibility shim.
- Cloud OAuth dispatch is credential-gated and fail-closed: provider adapters
  for subscription OAuth paths reuse the Agent OS provider credential homes
  (no second credential store), enable only after live proof, never meter, and
  degrade to local serving on quota exhaustion.
- The gateway ships a supported install/run/update/rollback path and `agents os
  deploy` runtime profiles for gateway and inference (ports, env, health
  checks, data mounts, secrets), with a no-live-engine smoke.
- Engine discovery, registration, and routing are exercised end-to-end through
  the inferctl seam.

### GitHub control plane (DarkFactory)

- Required status checks (Validate + Codex Review) are enforced on `dev` and
  `main`; force pushes and deletions stay blocked; automerge lands only on
  green.
- Managed templates cover every active toolchain (Node/Bun, Go, uv) and stay
  robust to PRs that introduce managed files, without weakening the
  `pull_request_target` trust boundary.
- Review quota/auth takeover is credential-isolated and fail-closed: the
  secondary provider receives the exact immutable prompt, no filesystem/tool
  authority, and no access to primary-provider credentials; both-provider
  failure blocks the merge.
- Work dispatch through DarkFactory lanes (routing, baton ownership, progress
  reporting, duplicate-ownership prevention) resumes only on explicit owner
  authorization per the program plan.

### Continuous integration

- Every active component's full test suite runs in Validate on every PR:
  `packages/{core,gateway,harness,inference,manager}` and
  `plugins/darkfactory`; parked plugins stay excluded.
- Real-behavior legs, not only mocks: a real gateway process round-trip
  (plain and streaming) against an OpenAI-wire backend and an engine
  discovery→registration→routing pass; no hardcoded registry counts.
- A Windows matrix leg covers the platform-sensitive suites.
- Product-surface smokes run on the PR gate: installer/doctor, release smoke,
  and an encrypted-bundle sync round-trip.
- Suite inventory is fail-closed: a component without wired tests fails CI
  rather than passing by omission.

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

CI runs the full validation gate:

```sh
bun run ci
```

The gate's required end state — whole-monorepo suites, real-behavior legs, a
Windows matrix leg, product-surface smokes, and fail-closed suite inventory —
is specified in the Continuous integration requirements above and tracked by
issue #206.

Acceptance requires the behavioral proofs in
[Canonical State and Memory v2](docs/state-memory-v2.md), including idempotent
bootstrap/migration, provider write-root proofs, deterministic replay and
projection hashes, correct supersession, two-machine tombstones, and
secret/symlink rejection.

## Delivery milestones

Milestones 1–5 of the state/memory reconciliation are delivered and folded into
release history (v0.2.x): v2 bootstrap/doctor, journalled migration, canonical
event replay, capability content-addressing, and two-machine encrypted event
exchange. Milestone 6 is partially delivered: the reconciled Agent OS passed
source-install activation and two-machine acceptance (recorded in the v0.2.x
release history), while release-backed distribution and the repaired global
launcher remain active work (program lane 4 below, issue #217).

The active program (sequenced in the Andromeda-data `context/PLAN.md`):

1. **Enforcement and CI truth** — managed enforcement baseline (delivered,
   issue #203) and the full-coverage CI gate (issue #206).
2. **Gateway productization** — naming convergence, canonical registry
   backend, switcher Connect contract, credential-gated cloud OAuth dispatch,
   packaging and runtime profiles.
3. **Platform and repository hardening** — Windows-safe atomic state
   publication; root metadata/docs consolidation residue.
4. **CLI, TUI, and distribution** — global launcher, TUI-first UX with style
   presets, command-specific help, release-backed installers and self-update.
5. **DarkFactory work resumption** — owner-gated: DarkFactory spec/issue lane,
   then provider routing, baton ownership, and dispatch.
6. **Harness disposition** — explicit roadmap or documented dormancy.

Parked (owner-gated): custom distro/distribution including the container
capstone demo, observability stack, and the other board-parked scopes.
