# Event Exchange Safety Runbook

Status: encrypted cross-machine event exchange is implemented. It is disabled
by default and must be enabled independently on each machine with the same
local key.

Agent OS has one authoritative state root per machine, `AGENTS_HOME` (normally
`~/.agents`). Exchange moves only immutable, machine-partitioned memory,
session, and orchestrator events. Records, views, session transcripts, state
documents, and baton Markdown remain derived projections and are rebuilt after
the complete imported history validates.

## Enable and exchange

Generate a 32-byte key on the first machine and enable exchange:

```sh
agents sync enable --generate-key
agents secrets path AGENTS_SYNC_KEY
```

Transfer `AGENTS_SYNC_KEY.secret` through an authenticated, private channel to
the same canonical secret path on the other machine, then enable exchange
there without `--generate-key`. The key is never embedded in a bundle.

```sh
agents sync enable
agents sync status --json
agents sync export /private/path/windows-to-mac.bundle.json --json
agents sync import /private/path/windows-to-mac.bundle.json --json
agents sync recover --json
```

Exchange is symmetric: export and import a bundle in each direction. A bundle
contains the complete immutable event set known to its source. Reimporting the
same authenticated payload is idempotent. `agents sync disable` disables
export/import without deleting canonical events or the local key. Bare
`agents sync` and `agents sync source` retain the repository/submodule update
operation; they do not exchange runtime state.

## Security and recovery contract

- Bundles use AES-256-GCM with a random nonce and authenticated payload hash.
- Only `memory/events`, `sessions/*/events`, and `orchestrator/events` JSON
  files are eligible. Credentials, provider homes, mutable databases, runtime
  state, and projections cannot enter a bundle.
- Paths are allow-listed. Symbolic links, path escapes, hidden entries,
  unsupported files, secret memory, private keys, credential field names,
  bearer/JWT/connection-string formats, provider-token formats, credential
  assignments, and long mixed high-entropy strings fail closed before export
  or publication. False positives must be removed or rephrased locally; they
  are never bypassed by the transport.
- Imports decrypt and validate every entry, build the combined local+incoming
  history in a disposable shadow root, and run the canonical event validators
  before writing any event.
- Existing paths with identical bytes are no-ops. Existing paths with different
  bytes are immutable-event collisions and abort the import.
- `sync/imports/<payload-hash>.json` records `prepared` and `committed` phases
  together with the exact encrypted envelope and checked entry metadata.
  `agents sync recover` reauthenticates that durable envelope with the local key,
  resumes without the original external bundle, verifies already-published
  bytes, rebuilds projections, and commits the journal. `state doctor` fails
  while an import is prepared.
- Memory retraction and supersession events are the deletion/tombstone model.
  Authoritative event files are append-only and are never deleted by exchange.
- Session and orchestrator hash chains are verified per machine. Cross-machine
  order is deterministic by Lamport clock, machine id, machine sequence, and
  event id.

## Inspection

```sh
agents sync status --json
agents state doctor --json
agents memory status
agents sessions list --json
```

`state doctor` is read-only. When exchange is enabled it verifies the encrypted
bundle transport selection, local 32-byte key, physical import journal
directory, absence of interrupted imports, and absence of retired snapshot
sync artifacts.

## Path and authority contract

- `AGENTS_HOME` is the only state root on a machine.
- Provider homes are `AGENTS_HOME/clis/<provider>`.
- Exchange configuration and journals live below `AGENTS_HOME/sync/`.
- Roaming authority consists of immutable events, never projections.
- Raw provider databases/WALs, provider transcripts, credentials, models,
  caches, logs, temporary files, locks, process state, and arbitrary files are
  local-only.
- Migration evidence remains below `AGENTS_HOME/provenance/migrations/` and in
  the separately protected Recovery archive.

The following are failures: a second writable state root; a provider bridge;
a mutable Git machine snapshot presented as exchange; an unauthenticated or
wrong-key bundle; a different event at an existing immutable path; any
unallowlisted, secret-like, or linked exchange entry; or a prepared import that
has not been recovered.

On Windows, physical top-level `.codex` and `.claude` directories used by the
desktop applications may coexist as `app-owned` surfaces only when distinct
canonical CLI homes exist below `AGENTS_HOME/clis`. They are never exchange
sources or Agent OS authority.

See [Canonical State and Memory v2](state-memory-v2.md) for the complete
authority and acceptance contract.
