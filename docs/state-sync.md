# Event Exchange Safety Runbook

Status: cross-machine exchange is disabled. No snapshot-sync or provider-root
adoption engine remains in the product.

Agent OS has one authoritative state root, `AGENTS_HOME` (normally
`~/.agents`). Local memory and session authority is immutable events plus
deterministic projections; a Git copy of mutable machine state is not a sync
protocol and is not exposed by the CLI.

## Available inspection

```sh
agents state doctor --json
agents state status --json
agents memory status
agents sessions list --json
```

`state doctor` is read-only. `state status` reports canonical, forbidden,
split, or missing provider roots. There is no command that moves a provider
home, creates a bridge, exports mutable state, commits a machine snapshot, or
pushes state to a remote.

## Path contract

- `AGENTS_HOME` is the only state root.
- Provider homes are `AGENTS_HOME/clis/<provider>`.
- Exchange configuration and future transport state live below
  `AGENTS_HOME/sync/`.
- Roaming authority consists of immutable records/events, not projections.
- Migration evidence lives below `AGENTS_HOME/provenance/migrations/` and in
  the separately protected Recovery archive.

The following are failures:

- `AGENTS_HOME/state/`;
- a second writable state root;
- top-level `~/.codex`, `~/.claude`, `~/.kimi-code`, or `~/.gemini` paths,
  including links;
- a historical root variable used as a locator;
- a mutable Git machine snapshot presented as restore-capable exchange.

## Preconditions for future exchange

Before transport can be enabled, the implementation must:

1. exchange append-only, machine-partitioned memory, session, and orchestrator
   events;
2. authenticate and encrypt transport without placing credentials in roaming
   payloads;
3. merge deterministically, import idempotently, and support deletion
   tombstones;
4. reject symbolic links, path escapes, planted secrets, and mutable provider
   databases;
5. distinguish roaming, reproducible, per-machine, local-only, and secret
   classes;
6. journal imports and prove interruption recovery;
7. converge two machines to identical projection hashes under adversarial
   replay and reordering tests.

Raw provider transcripts are local evidence by default because filenames
cannot classify secrets embedded in content. Provider databases/WALs,
credentials, models, caches, logs, temporary files, locks, and process state
are never normal exchange payloads.

Provider-root migration is an offline semantic operation with source and
destination hashes, tool versions, timestamps, outcome, and rollback evidence.
After verification, the old live path is removed. No link, loader, dry-run
adoption command, or compatibility mode remains.

See [Canonical State and Memory v2](state-memory-v2.md) for the complete
authority and acceptance contract.
