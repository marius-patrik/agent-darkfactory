# Provider Session Capture

Andromeda can reconcile Claude and Codex provider transcripts into canonical
local sessions without making provider-owned files authoritative. Capture is
launcher-independent: desktop apps, editor integrations, and CLI/SDK
entrypoints are covered when they append the supported native JSONL format to
the provider evidence roots below the real `ANDROMEDA_USER_HOME`.

## Supported evidence

| Provider | Evidence root and files | Native identity and visible messages |
| --- | --- | --- |
| Claude | `.claude/projects/**/*.jsonl` | The UUID filename must match every visible record's `sessionId`. Non-meta `user` and `assistant` records retain native `uuid`, timestamp, role, and visible `text` content. |
| Codex | `.codex/sessions/**/rollout-*.jsonl` | The UUID in the rollout filename must match the owner `session_meta` on line 1. A bounded, contiguous owner-to-root lineage block may follow. Only owner user and assistant `response_item` messages are visible evidence; transport-level `event_msg` records are ignored. |

Discovery does not filter on a launcher name. Claude `entrypoint` values and
Codex `originator` values are retained as provenance. Raw reasoning, thinking,
tool calls, and tool results are not copied into the visible canonical
transcript. Source working directories are evidence metadata only; they do not
become canonical working-directory authority.

System/developer policy records, Claude `isMeta: true` records, and Codex
transport events are not imported. A source prefix with no visible
user/assistant message can be checkpointed, but it does not create an empty
canonical provider session. A page containing only valid Claude hidden-meta
records advances safely without letting their content or timestamps seed the
later visible session.

Codex lineage admission is format-aware. Line 1 is the sole owner and its
`id`, not `session_id`, must match the rollout filename. Current Codex
subagent rollouts retain the root thread UUID in `session_id`, so that field
is UUID-validated lineage metadata and is never substituted for owner
identity. Additional leading metas must be distinct lowercase UUIDs linked
exactly by the preceding meta's `parent_thread_id`; repeats, cycles, gaps,
unlinked metas, conflicting `forked_from_id`, and any meta after the leading
block fail closed. The lineage is capped at 16 nodes.

A multi-node lineage must terminate at a node with no parent. Codex desktop
also emits a bounded truncated form in which only the owner meta is retained
even though it declares a parent; only that one-node form is admitted as
truncated. Forked rollouts contain copied ancestor history. Capture excludes
all messages before the first exact
`inter_agent_communication_metadata` record whose `trigger_turn` is boolean
`true`, persists that boundary across capture pages, and derives canonical
fields only from the owner meta. A false trigger does not open the boundary,
and a non-boolean trigger fails closed.

Each native session maps deterministically to
`desktop-<provider>-<native-session-uuid>` below
`ANDROMEDA_HOME/sessions/`. The source provider, native session id, native
record id, timestamp, format, and root-relative source path remain attached to
the canonical session or message. Re-running capture is idempotent; continuing
append-only records extend the same canonical session.

## One-shot reconciliation

```sh
andromeda sessions ingest --json
andromeda sessions ingest --provider claude --json
andromeda sessions ingest --provider codex --json
```

The default provider selection is `all`. The JSON report distinguishes files,
sessions, and messages that were imported, already present, unchanged,
deferred, or failed. Permanent file failures make the command exit non-zero;
a provider file that is still being appended is deferred and is safe to retry.

The cursor at
`ANDROMEDA_HOME/runtime/session-capture/cursor.json` avoids redundant
reconciliation. Each source checkpoint binds a safe byte offset, physical file
identity, cumulative line/message counts, contiguous page hashes and a chained
prefix digest. Every pass rechecks first/tail guards and one deterministically
rotated older page. The cursor is not session authority; immutable canonical
events remain authoritative.

One capture pass admits at most one bounded page per source and rotates its
starting source across runs. A transcript larger than the default 64 MiB page
quantum therefore makes incremental progress instead of blocking later files.
The total-byte ceiling is a per-run read budget, including verification reads.
Existing whole-prefix cursor entries are upgraded only after their stored hash
has been verified.

Session listing is read-only and does not trust generated state projections.
It performs one bounded immutable-event collection and replay per session,
then maps that replay directly to the summary. Listing takes no state lock and
does not repair or rewrite projection files.

## Continuous Windows capture

```sh
andromeda sessions capture install --json
andromeda sessions capture status --json
andromeda sessions capture uninstall --json
```

`install` registers the exact `Andromeda-Session-Capture` Scheduled Task for
the current interactive user. Every five minutes it invokes the canonical
Andromeda launcher through a hidden WScript wrapper, suppresses overlapping
runs, and applies a four-minute execution limit. The wrapper lives below
`ANDROMEDA_HOME/runtime/session-capture/`, outside the launcher-only `bin`
directory. No console window is opened.

`status` verifies the task identity, action, arguments, interval, hidden flag,
non-overlap policy, limited interactive principal, and wrapper contents. It is
non-zero when a supported installation is missing or drifted. `uninstall`
removes only a task whose complete definition still matches that canonical
identity, plus its Andromeda-owned wrapper. Installation never force-overwrites
a same-name drifted task, and a failed installation rolls back only the task
and wrapper changes made by that invocation. Automatic lifecycle installation
is currently Windows-only; one-shot ingest remains available on every
supported platform.

## Append and failure semantics

- Only newline-terminated JSONL records are admitted. A partial final record is
  left untouched and retried after the provider completes it; any complete
  prefix can still be reconciled safely.
- Every physical ancestor from the filesystem root through the configured
  evidence root and discovered subdirectory is admitted and revalidated around
  traversal. File content is read through an identity-checked handle and the
  path is revalidated afterward. Concurrent mutation is retryable and does not
  advance the source offset.
- A file that shrinks or changes before its prior admitted append boundary is
  rejected as `source_rewritten`. Boundary guards catch first/tail changes
  immediately; the rotating page audit detects older interior changes over
  bounded subsequent passes. Existing canonical content is unchanged.
- A malformed complete line, native session-id mismatch, conflicting native
  record, unsupported provider drift, symlink, or configured scan-limit breach
  fails closed. The cursor advances only after that file's canonical
  reconciliation succeeds.

Capture is bounded by file count, tree depth, scanned entries, page and
per-run bytes, lines, line size, visible messages, checkpoint pages, and cursor
size. Evidence roots, every ancestor, and JSONL files must be physical
directories or regular files, never links or junctions.

## Canonical-local versus event exchange

Captured sessions are canonical for local session listing and continuation,
but their metadata is explicitly `exchange: local-only` with reason
`provider-transcript`. Encrypted event export skips each such session as one
unit before secret scanning; it never exports a subset of the session. The
export report includes the number skipped and the reason.

This exception is granted only after immutable events prove the manager's
exact provider provenance, canonical source path, deterministic imported turn,
and at least one complete start/message/complete triple. Metadata alone,
partial turns, traversal-shaped paths, and generic `local-only` sessions do not
bypass secret scanning. Ordinary canonical session events remain eligible for
the allow-listed encrypted event transport. Raw provider roots remain local,
non-authoritative evidence and are never exchange sources.
