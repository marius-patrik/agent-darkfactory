# Canonical State and Memory v2

Status: implemented local-state contract; cross-machine exchange remains gated.

## Objective

`~/.agents` is the only authoritative Agent OS state root. Models, provider
CLIs, desktop surfaces, harnesses, roles, and machines are execution surfaces
for one agent identity; they must not create independent user or project truth.

"Single state" does not mean one mutable file. It means one versioned authority
with explicit provenance, deterministic projections, and no second writable
copy of an authoritative record.

## Implementation status

The v2 root resolver, manifest, private directory modes, generated environment,
read-only doctor, pinned provider registry, evidence-backed memory store,
immutable session/orchestrator events, content-addressed capability floor, and
managed identity/memory/capability startup projection are implemented.
Provider discovery is canonical only, raw provider execution is not a CLI
surface, and no credential copier, provider-adoption engine, mutable Git
snapshot-sync engine, old launcher, or legacy runtime tree remains live.

The personal installation has one physical provider root per CLI below
`/Users/user/.agents/clis`. The standalone provider homes and Chrome native
host have been preserved offline and removed; the live doctor is green.

The current master thread is the first canonical orchestrator session, and the
personal install exposes one `agents` launcher. Remaining product work is
adapter-native provider continuation where a provider exposes a stable resume
handle, plus future two-machine encrypted event exchange. Exchange stays
disabled until its full merge, tombstone, interruption, and adversarial safety
contract is proven.

## Canonical paths

```text
~/.agents/
  manifest.json
  env
  config.json
  identity/
    agent.json
    persona.md
    capabilities.md
    roles/
    prompts/
    rules/
  clis/
    codex/
    claude/
    kimi/
    agy/
  sessions/<session-id>/
    events/<machine-id>/<sequence>-<event-id>.json
    state.json
    transcript.json
  memory/
    events/<machine-id>/<sequence>-<event-id>.json
    records/
    views/
      startup.md
    snapshots/
  orchestrator/
    events/<machine-id>/<sequence>-<event-id>.json
    state.json
    STATE.md
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
    registry.json
    materialized/
  runtime/
    locks/
    pids/
    tmp/
    cache/
    logs/
  sync/
    config.json
    repo/
    outbox/
    status.json
  provenance/
    events/<machine-id>/<event-id>.json
    migrations/<migration-id>/manifest.json
  harnesses/<harness-id>/runtime/
  models/
```

The existing top-level registry files remain canonical to avoid creating a
second writable registry tree. No retired symlink is part of the final layout.

## Environment contract

- `AGENTS_HOME` is the absolute canonical state root. For the personal install,
  it is `/Users/user/.agents`.
- `AGENTS_USER_HOME` is the real OS user home and remains stable even when a
  provider requires an isolated `HOME`.
- `AGENTS_ROOT` identifies the active Agent OS code/distribution checkout. It
  is not a second state root.
- No retired product-specific root variable is accepted as a state locator.
- Without `AGENTS_HOME`, the manager uses the real OS account home plus
  `/.agents`; it never creates runtime state in the current repository's
  project-guidance `.agents` directory. A rooted provider home must never be
  interpreted as the user home.

Provider processes receive these roots:

| Provider | Native state root | `HOME` |
| --- | --- | --- |
| Codex | `CODEX_HOME=~/.agents/clis/codex` | real user home |
| Claude | `CLAUDE_CONFIG_DIR=~/.agents/clis/claude` | real user home |
| Kimi | `KIMI_CODE_HOME=~/.agents/clis/kimi` | real user home |
| Agy | isolated under `~/.agents/clis/agy` | isolated only for the provider process |

An isolated provider `HOME` must not leak into general tool subprocesses.

## Provider and desktop state

Provider-native directories are opaque runtime state. They may contain session
evidence and caches, but they are never memory authority.

Standalone locations `~/.codex`, `~/.claude`, `~/.kimi-code`, and `~/.gemini` must
be absent in the final state. A physical directory or link at any of those
paths is a failure. Existing content requires an offline semantic merge into
the matching canonical CLI home followed by verified removal of the standalone
path. Auth files must never be reconciled with a blind last-write-wins copy.

The former Codex desktop/Chrome surface required a separate `~/.codex` state
model for Browser, Chrome, Computer Use, enrollment, and plugin data. Those
assets and its native-host manifest are preserved as offline migration evidence
and removed from live use. Chrome was reopened after retirement and did not
recreate the root. The final product retains no bridge for that surface.

## Memory authority

The authority order is:

1. explicit current user instruction;
2. verified live runtime, repository, or remote fact;
3. active canonical memory record;
4. clearly labelled inference;
5. provider transcript, generated provider memory, or archived document.

Provider history and external recovery archives are evidence only and are never
loaded into a startup prompt directly. Canonical provenance stores hashes and
source references, not old writable product trees.

Each canonical fact has:

- immutable record id;
- agent id, scope, subject, predicate, and typed value;
- source URI and content hash;
- source class (`verified` or `inferred`) and confidence;
- sensitivity classification;
- observed, valid-from, optional expiry, and creation timestamps;
- machine and author ids;
- status (`active`, `superseded`, `retracted`, `disputed`, or `parked`);
- explicit `supersedes` record ids.

There may be at most one active scalar value for
`(agentId, scope, subject, predicate)`. A conflicting value must supersede the
old record or remain disputed. Markdown views and search indexes are generated
projections, not writable sources of truth.

Memory authority is exclusively the strict schema-v2 event tree at
`memory/events/<machine-id>/<16-digit-sequence>-<event-id>.json`. There is no
schema-v1 reader, legacy root, migration reader, or mutable-record fallback.
Every event has an exact envelope containing its agent, machine, per-machine
sequence, author, normalized timestamp, previous event hash, event hash, type,
and type-specific data. Unknown fields, renamed files, sequence gaps, duplicate
ids or hashes, broken chains, non-normalized timestamps, and hash mismatches
fail closed.

The only event intents are:

- `memory.remembered`, carrying the immutable fact seed;
- `memory.superseded`, carrying a new active fact seed plus the explicit prior
  record ids it replaces;
- `memory.retracted`, carrying a prior record id and new retraction evidence.

Events never carry post-operation record snapshots. Each machine partition is
contiguous from sequence one and hash-chained to its own previous event.
Replay order is deterministic by normalized event timestamp, machine id,
machine sequence, and event id. Replay derives record creation, status changes,
supersession links, and retractions, and checks the one-active-scalar invariant
after every event.

`memory/records/*.json` and `memory/views/startup.md` are replaceable
projections. Reads and mutations replay the event tree under the canonical
memory lock, then atomically repair those projections; they never parse record
files as authority. The startup context has fixed bounds and uses the latest
event timestamp for expiry and age labels, so identical events always produce
identical bytes. Secret and sensitive records are excluded. A deterministic
projection digest covers event heads, replayed records, and startup bytes.

`agents state doctor` inspects this boundary without taking a lock or writing:
it reports event integrity separately from projection integrity. Event damage
is not repairable by projection rebuild. Missing, stale, forged, or modified
projections can be rebuilt byte-for-byte from intact events.

## Sessions and orchestration

Sessions use stable Agent OS ids. Canonical events are append-only,
hash-chained, and machine-partitioned. An immutable JSON file per event is the
local storage form; it avoids partial JSONL appends while retaining
deterministic replay. `state.json`, `transcript.json`, and orchestrator
`state.json`/`STATE.md` are generated projections rebuilt from events and are
never authority. A projection-only retired session intentionally fails closed.

Projection writes use a lock plus temporary file, flush, and atomic rename.
Locks include the machine, process id and start time, session id, and lease
expiry. The orchestrator baton is a lease, not an unlocked Markdown file.

Provider switching must preserve ordered user, assistant, tool, usage, and
handoff events. Replaying a rendered transcript into a fresh CLI process is not
equivalent to native continuation and is only an explicitly labelled fallback.

## Sync classes

- **Roaming:** identity, non-sensitive config, memory events, canonical session
  events, and orchestrator events.
- **Reproducible:** capability manifests and lockfiles; payloads are restored
  from content-addressed or source stores.
- **Per-machine:** machine facts and provider availability.
- **Local-only:** provider databases/WALs, models, caches, logs, temporary files,
  locks, and process state.
- **Secret:** never synced unless a future explicit encrypted-secret protocol
  is selected.

Raw transcripts are local-only by default because path names cannot classify
secrets embedded in content. Sync must reject symlinks and path escapes, use
immutable event exchange plus deterministic replay, support tombstones, and be
idempotent.

## Migration

Migration is staged, journalled, idempotent, and reversible:

1. **Freeze and preserve:** inventory active processes; snapshot every unique
   worktree and provider root; create hashes, Git bundles, and rollback data.
2. **Bootstrap v2:** create the manifest, machine identity, canonical
   directories, generated environment, runtime locks, and doctor. Move no
   provider content.
3. **Provider homes:** while providers are stopped, stage semantic merges,
   validate provider databases/config, atomically swap, remove standalone roots,
   and prove each retained provider surface writes only below `AGENTS_HOME`.
4. **Memory:** ingest old memory as provenance candidates, hash-dedupe, classify
   conflicts, require supersession, and generate one startup view. Move old
   `global`, `shared`, and `agents` trees to the external recovery archive only
   after count/hash parity, then remove them from the live root.
5. **Sessions and orchestrator:** import native session ids and make this master
   session the first canonical orchestrator session.
6. **Capabilities:** content-address shared capabilities and expose them through
   provider-native projections; vendor system skills remain provider-owned.
7. **Sync:** prove two-machine event exchange, deterministic materialization,
   tombstones, and secret/symlink rejection.
8. **Retire shims:** remove obsolete paths only after rollback and acceptance
   proofs pass.

Every migration records source/destination paths, counts, hashes, tool version,
start/end timestamps, result, and rollback instructions under
`provenance/migrations/<id>/manifest.json`.

## Acceptance criteria

- `agents state doctor --json` reports one absolute `AGENTS_HOME`, no standalone
  provider path, no writable duplicate root, no active retired loader, and
  no secret or symlink in sync candidates.
- State bootstrap and migration are idempotent; rerunning them changes nothing.
- Codex, Claude, Kimi, and Agy authenticate and write only to their declared
  roots. Any desktop surface that recreates an external root is excluded.
- The real user home is visible to Codex, Claude, and Kimi tool shells.
- A newer verified fact explicitly supersedes an older value; both remain in
  provenance and only the newer value appears in `memory/views/startup.md`.
- Concurrent writers and forced termination cannot truncate canonical state;
  event replay produces the same projection hash.
- Provider switch and switch-back preserve ordered canonical events and native
  resume handles where the provider supports them.
- Two machines exchange events and reach the same projection hash; deletion
  tombstones work; planted secrets and symlink escapes are rejected.
- Removed retired state has source/recovery count and hash parity and cannot be
  loaded by any active adapter.

## Implemented local system

1. Real-user-home and Agent OS root resolution are centralized and test-isolated.
2. `.agents/clis/<provider>` is the only provider-home target.
3. Status terms are `forbidden`, `canonical`, `split`, and `missing`.
4. The v2 manifest, private directories, generated environment, and read-only
   doctor are live.
5. Installed provider invocation forms are tested; executables are pinned by
   version and SHA-256 and resolved only from canonical homes.
6. Retired adoption, credential-copy, raw-provider-exec, and Git snapshot-sync
   surfaces have been deleted rather than retained behind guards.
7. Memory records require provenance, explicit supersession, private immutable
   events, and bounded generated startup context injected into every managed
   provider turn.
8. Temporary-home tests and real installed-boundary checks prove state does not
   leak below a hostile `HOME` or into standalone provider roots.
9. Sessions and orchestration use immutable machine-partitioned hash chains,
   serialized writers, expiring leases, deterministic replay, and atomic
   projections with collision, tamper, and concurrency proofs.
10. Eleven shared skills and six worker roles are validated, content-addressed,
    checksum-registered, atomically installed, and injected with the one Rommie
    identity into every managed provider turn.
11. The master director thread is imported as the first canonical orchestrator
    session, and the installed boundary contains one regular `agents` launcher.
12. Exact Recovery parity was verified before removing the live `global`,
    `shared`, and multi-agent trees; the doctor rejects their reappearance.
