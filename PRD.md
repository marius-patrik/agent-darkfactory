# Agent OS / Andromeda PRD

## Overview

Agent OS is a single personal agent system that can execute through multiple
models, provider CLIs, harnesses, and machines without creating competing
identity, memory, session, or configuration authorities. The
`Andromeda` repository implements the system, and its `agents` CLI is the
single management and runtime surface.

Andromeda is one program, not a collection of adjacent tools. Every component
in this repository — the management core (state, installs, credentials), the
harness (session events and tool execution, owner-ruled to become the
operation engine per #218), the model/execution substrate, and the GitHub
control plane — is a layer of the same system and is specified, validated, and
released as such.

[Canonical State and Memory v2](docs/state-memory-v2.md) is the authoritative
state specification. This PRD defines the product boundary, the system
layering, and the required capabilities around it.

## North star and program plan

The owner-set end state: **the system runs itself — multi-agent, one system,
GitHub-only control.** An orchestrator assesses global state on schedule, plans
waves, dispatches per-component agents within concurrency caps, posts
dashboards, and escalates only via ask-owner issues. The full backlog drains
through DarkFactory lanes: issue → branch (from `dev`) → PR → Validate + DarkFactory Autoreview
gates → automerge → release. Zero orchestrator terminal sessions. "GitHub-only
control" means autonomous orchestration operates exclusively through the GitHub
control plane; the `agents` CLI remains the local operator surface.

This PRD is the repository's specification source of truth. The owner-facing
task board in the Andromeda-data authority at `context/TASK.md` remains the
canonical authorization and sequencing surface; the consolidated program plan
at `context/PLAN.md` records the detailed execution lanes and parked scopes
under that board and supersedes neither the board nor repository-owned
specification. Owner instruction outranks all of them; issues implement this
PRD. The program's end-state demo — the full system running in one container
from an agents-os image — is parked with all custom distro/distribution work
until the owner reopens it.

## Naming and authority

- **Agent OS** — final product name.
- **Andromeda** — repository. npm package surface stays `@marius-patrik/agents-manager` (recorded exception).
- **agents** — CLI command.
- **`~/.agents` / `AGENTS_HOME`** — only authoritative runtime state root; a
  checkout of the Andromeda-data authority.
- **`packages/`** — implementation domains, each rooted as one direct child.
- **`plugins/`** — authored repository-owned plugin capabilities; managed product
  repository gitlinks live under `packages/`.
- **`data/`** — development pins for separate state and ledger repositories.

Historical product, repository, and layout names are evidence to migrate and
retire. They are not supported aliases or compatibility contracts.

## System layering

| Component | Role |
| --- | --- |
| `packages/migrate/core` | Protobuf sources and generated Go, TypeScript, and Python contracts |
| `packages/migrate/manager` | `agents` CLI, state, installs, credentials/secrets, providers, sessions, memory, package/capability registries, and lifecycle management — the single local management surface; hosts the orchestrator runtime until the #218 migration is implemented and accepted |
| `packages/migrate/harness` | Canonical session event handling and tool execution today. Owner-ruled target (2026-07-13, #218): the operation engine owning orchestration, with the orchestrator runtime migrating from the manager |
| `packages/migrate/gateway` | Local model registry, routing, health, quota, and transient control-plane relay; switcher control plane and cloud OAuth dispatch |
| `packages/migrate/inference` | Gateway-backed Python agent loop, status, persistence, redaction, and package validation; engine discovery and serve profiles |
| `agents/darkfactory` | Thin GitHub control-plane adapter: issues/PRs/labels ↔ work units, enforcement sync, review gates. No second brain. |

Binding architecture rule: the manager manages and the harness operates — as
the owner-ruled target architecture. Local system management (state, installs,
credentials, registries, lifecycle) is implemented in the manager and consumed
by DarkFactory — no parallel implementations in the control plane. Operation
(orchestration, session execution, tool execution) becomes harness-owned when
the #218 migration is implemented and accepted; until then orchestration
remains manager-owned. Gateway and inference own their assigned local runtime
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
  Agent OS-routed provider-agnostic Autoreview.
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
- **Action receipt:** a small durable record of one control-plane action — the
  authorizing intent (issue/wave/owner directive), acting agent, exact
  repo+ref boundary, permitted action scope, result (PR, release, blocked ask,
  or no-op), observed CI/review/policy gates, and downstream handoff
  references.

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

### Operation engine (harness — owner-ruled target, epic #218)

Target requirements for the harness as the operation engine; current authority
keeps the orchestrator runtime manager-owned until the #221 migration is
implemented and accepted.

- A recorded runtime contract covers orchestration primitives (waves,
  baton/lease semantics, scheduling, concurrency caps), canonical session event
  handling, and the event-backed tool loop, consistent with the state/memory v2
  event contracts (#221).
- The concurrent brain: one thought/coordination lane routes work to two or
  more concurrent workers over a shared blackboard, integrating results into a
  single validated artifact; a warm interactive session lane coexists with
  background workers without blocking them (#222).
- Thought, worker, and blackboard state is exposed through canonical session
  events — no private side channels — so the TUI can render a brain view
  (#217, #222).
- Bounded subagent orchestration: declared scope, budget, and concurrency
  caps; results return through canonical events; duplicate ownership is
  prevented within one engine (#223).
- A non-progress watchdog detects stalled lanes and kills or escalates
  deterministically, fail-closed on scope/budget/cap violations, with a
  durable event trail (#223).
- The harness ships a test floor wired into Validate; its behavioral
  acceptance proofs are real tasks, not mocks (#206, #221–#223).

### Model/execution substrate (gateway and inference)

- One canonical gateway identity: public name, distribution name, import
  namespace, CLI script name, and agent package id converge fully on the
  decided name. Historical names are recovery evidence only — no aliases,
  bridges, or forwarding shims; any exception must be an explicitly recorded
  canonical exception (as with the npm package name).
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

Owner-ruled substrate scope (2026-07-13, epic #224): the inference substrate
ties multiple machines together into a compute cluster and handles local LLM
inference across the full cluster. Owner inputs resolved the same day: the
initial cluster nodes are specifically the Windows desktop and the Mac
(further nodes join through the same fabric), and the FULL scope is the
required target — both engine tiers, lifecycle, routing, and scheduling
together, with no tier-first partial milestone.

- Cluster fabric rides Agent OS machine identity — nodes join and leave the
  compute mesh with cluster-wide discoverable capabilities (GPU/VRAM/RAM/
  architecture), health, and liveness; no second identity or state authority.
- Local serving engines are organized in capability tiers (GPU-backed and
  RAM/GGUF-backed at minimum) behind one engine contract, with per-node engine
  lifecycle driven through discovery.
- Model lifecycle (fetch, verify, cache, serve) uses content-addressed storage
  with per-node placement rules; models never travel through the state sync
  lane.
- The gateway routes inference cluster-wide — local-first, capability- and
  load-aware — fail-closed when no capable node exists and degrading
  gracefully when a node drops mid-stream.
- Per-node GPU/RAM co-budget scheduling with explicit exclusive-vs-shared
  policies and explicit queued-vs-rejected behavior.
- Acceptance is a live two-machine round-trip: a request entering the gateway
  on one machine is served by an engine on another and returns a validated
  response, with node-drop degradation proven (gated live proofs plus #206
  contract legs).
- Distro/container packaging of the cluster remains parked scope.

### Self-improvement (autolearn — recorded scope, owner-gated, epic #225)

Scope is recorded; execution requires explicit owner authorization. Brakes
come first: the system may only learn in ways it can prove it can stop.

- A curated trace store enforces a strict train/test wall (provenance-tagged;
  the eval set is mechanically held out of training; no synthetic training
  data in the first generation).
- The eval gate must demonstrably catch a deliberately planted bad adapter
  before any promotion path opens.
- Adapter training runs on local hardware within the inference substrate's
  resource budgets; artifacts are content-addressed.
- Promotion is canary-first with operator-confirm by default and auto-revert
  always on; closed-loop auto-promote exists only behind a default-off owner
  flag.
- The substrate serves per-role adapters behind the same engine contract.

### Cognitive memory operations (packages/memory — owner-ruled, epic #227)

The reflection/cognitive layer lives in a new `packages/memory` plugin, which
also absorbs existing memory operations tooling. The canonical memory
authority and state contracts remain manager/core-owned — the plugin operates
strictly through them.

- A reflection engine performs guided temporal replay over canonical session
  events and records, emitting typed, provenance-backed memory records
  exclusively through the canonical mutation path.
- Dreams are typed memories: scheduled/idle-time distillation of recent
  activity into records with supersession semantics — never direct file
  writes.
- Corpus batch processing turns historical transcripts and archives (evidence
  sources) into candidate records with visible provenance.
- The existing provider-side Dream tooling migrates into the plugin with its
  processed-timeline state preserved; other standalone memory operations
  tooling consolidates there as discovered.
- The plugin ships its own suite wired into Validate and claims no second
  memory authority.

### GitHub control plane (DarkFactory)

- Required status checks (Validate + DarkFactory Autoreview) are enforced on `dev` and
  `main`; force pushes and deletions stay blocked; automerge lands only on
  green.
- Managed templates cover every active toolchain (Node/Bun, Go, uv) and stay
  robust to PRs that introduce managed files, without weakening the
  `pull_request_target` trust boundary.
- Autoreview is provider-agnostic and fail-closed: Agent OS owns routing,
  credentials, and execution; a complete clean medium round plus an independent
  clean high-tier confirmation is required, and an unavailable route blocks the
  merge.
- Every dispatched package-lane action produces a durable action receipt. The
  orchestrator plans waves by reasoning over receipts, not agent self-report,
  and receipts give the owner a compact audit trail without reopening
  terminals.
- `df:ask-owner` escalations are generated from failed or ambiguous receipts,
  not from raw agent uncertainty — keeping escalation rare and specific.
- Work dispatch through DarkFactory lanes (routing, baton ownership, progress
  reporting, duplicate-ownership prevention, and the receipt contract) resumes
  only on explicit owner authorization per the program plan.

### Continuous integration

- Every active component's full test suite runs in Validate on every PR:
  `packages/{core,gateway,harness,inference,manager}` and
  `agents/darkfactory`; parked plugins and applications stay excluded.
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
packages/migrate/core/
packages/migrate/manager/
packages/migrate/harness/
packages/migrate/gateway/
packages/migrate/inference/
agents/darkfactory/
packages/memory/
agents/lifequest/
agents/skyagent/
packages/migrate/singularity/
packages/fabrica/
skills/
hooks/
roles/
commands/
persona.md
data/andromeda/
data/darkfactory/
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

The active program below is derived detail: authorization and high-level
sequencing stay with the owner board (Andromeda-data `context/TASK.md`), and
the lane breakdown lives in the program plan (`context/PLAN.md`):

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
6. **Operation engine** — the #218 epic: runtime contract and orchestrator
   migration (#221), concurrent brain core (#222), subagent orchestration and
   non-progress watchdog (#223).
7. **Inference cluster substrate** — the #224 epic: multi-machine compute
   cluster with cluster-wide local LLM inference.
8. **Autolearn** — the #225 epic: brakes-first self-improvement, recorded
   scope only, execution owner-gated.
9. **Memory plugin** — the #227 epic: reflection, dreams, and corpus
   processing in `packages/memory` through the canonical memory contract, with
   the Dream tooling migrated.

Program acceptance: one continuous woven live session — an operator task from
the TUI exercising the concurrent brain with subagents, cluster-served local
inference, memory-informed behavior, and a synthetic mid-run fault with clean
recovery, producing validated artifacts end to end. The container/distro demo
variant of this acceptance stays parked with the distro scope.

Parked (owner-gated): custom distro/distribution including the container
capstone demo, observability stack, and the other board-parked scopes.
