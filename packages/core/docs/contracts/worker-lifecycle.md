# Worker-Lifecycle Contract

**Authority:** `.plans/design/drafts/D5-orchestration-algo.md` (§B — primary);
`D1-decomposition.md` (§D1.2 — boundary call);
`.plans/design/15-orchestration.md` (OR1 claims, OR2 status vocabulary);
`.plans/EXECUTION-STATE.md` entry D-029 (in-process-first, per-NODE instancing,
claim-on-first-write, pause-aware TTL).

**Status:** VS0 contract — additive only; no field may be removed or renamed
without a new contract version.

---

## 1. What the conductor is (and is not)

The **conductor** is the deterministic, decide-free worker-lifecycle mechanism.
It is the *only* component that creates, tracks, and destroys worker runtime
units, acquires write-scope claims, mediates blackboard I/O, and signals
non-progress.  It makes no model calls and has no opinion about the *content*
of the work.

The **thought** role (an LLM-driven intra-agent executive) drives the conductor.
Thought decides *what* to do; the conductor does *how* — spawn, track, kill,
suspend, resume.  This separation is structural: `thought` must stay free of
process-management mechanics; `conductor` must stay free of work semantics.

The conductor is **not**:
- A scheduler that decides which work items to tackle.
- A quality gate (the no-false-green gate lives in `thought`).
- A model caller or reasoner.
- A messaging bus (it uses NATS; it does not replace it).

---

## 2. Per-NODE instancing

One conductor instance is bound to **one agent session** and lives on the **node
that owns that session** (session affinity, D-020 / §01 G5).  A node running
ten concurrent sessions runs ten conductor instances — they share Postgres and
NATS but have separate in-memory liveness tables.

All durable state (claims ledger, dispatch ledger) is in Postgres so that a
conductor crash or restart rehydrates deterministically: re-read the dispatch
ledger, re-subscribe to worker heartbeat subjects, re-arm watchdogs.

---

## 3. The contract surface

The full, typed Python contract is implemented by the in-repository inference
package at `../inference/python-agent/agent/conductor/lifecycle.py` as
`WorkerLifecycle` (a `typing.Protocol`).  This document is the Agent OS core
semantic contract; the Python file is the implementation shape.

### 3.1 Types

| Type | Role |
|---|---|
| `WorkSpec` | Everything the conductor needs to assign a unit: role name, task text, acceptance criteria, inputs, write scope, model id, tools allowlist, budget envelope, parent session id, item id. |
| `WorkerHandle` | Opaque reference returned by `assign()`.  Stable for the worker's lifetime.  Callers must not inspect anything except `worker_id`, `session_id`, `role`, `item_id`. |
| `WorkerStatusCode` | OR2-aligned controlled vocabulary (see §4). |
| `WorkerStatus` | Point-in-time snapshot: handle, status code, last heartbeat timestamp, latest ProgressSignal, stale-risk flag. |
| `WorkerEvent` | Lifecycle delta event: kind (STARTED / HEARTBEAT / DONE / FAILED / NON_PROGRESS / SUSPENDED / RESUMED / KILLED), handle, timestamp, optional payload fields. |
| `ProgressSignal` | Heartbeat payload for the non-progress watchdog: turn_count, blackboard_hash, artifact_count, state_digest, claim_renew flag. |
| `ClaimScope` | Typed union: `PathGlobScope | LogicalScope | TaskScope`. |
| `ClaimConflict` | Surfaced to the claims hook: holder_worker_id, conflicting_scope, item_id. |

### 3.2 Methods

```
assign(spec)               → WorkerHandle | ClaimConflict
observe(handle)            → (WorkerStatus, AsyncIterator[WorkerEvent])
cancel(worker_id, reason)  → None
suspend(handle, reason?)   → None
resume(handle)             → None
register_claims_hook(hook)        → None
register_nonprogress_hook(hook)   → None
```

**assign** acquires the write-scope claim (or defers to the first
`blackboard_write` call if `spec.write_scope` is `None` — claim-on-first-write,
D-029), then spawns the runtime unit, inserts the dispatch-ledger row, and arms
the heartbeat monitor and non-progress watchdog.  Returns `ClaimConflict` when
the scope overlaps an active claim; thought then serializes / re-scopes / merges
(D5 §C3).

**observe** returns both a snapshot and an async event iterator so callers can
query state without a race between two separate calls.  The stream ends on any
terminal event.

**cancel** follows the D5 §B4 protocol: cooperative cancel signal → grace window
(default 20 s) → hard terminate via host daemon → unconditional claim release →
dispatch-ledger update → `worker.failed` event emitted.

**suspend / resume** implement pause-aware TTL (D-029): a suspended worker's
claim TTL is frozen, not counting down, until resumed.  The worker is quiesced
(told to stop accepting new turns) but its state is preserved.

**register_claims_hook** registers a callback invoked whenever a conflict is
detected at spawn time *or* at first-write time (claim-on-first-write path).
Signature: `(handle: WorkerHandle, conflict: ClaimConflict) -> None`.

**register_nonprogress_hook** registers a callback invoked when the watchdog
detects `consecutive_no_progress_turns >= K` (proposed default K=3, see §6).
Signature: `(handle: WorkerHandle, consecutive_no_progress_turns: int) -> None`.
The conductor signals; thought decides kill / retry / re-decompose.

---

## 4. OR2 status vocabulary (LOCKED)

From `15-orchestration.md §OR2` — command-success is not useful-result.

| Code | Meaning |
|---|---|
| `useful_result` | Validated artifact present, acceptance check passed, NFG gate passed. |
| `no_artifact` | Worker exited cleanly but produced no artifact. |
| `missing_evidence` | Artifact present but acceptance or source-separation check failed. |
| `unresolved` | Work item open; no conclusive outcome yet. |
| `blocked` | Cannot proceed; waiting on an external condition or claim release. |
| `failed` | Crashed, ceiling exceeded, or killed after exhausting recovery. |
| `released` | Claim released voluntarily before producing a terminal result. |
| `expired` | Claim TTL elapsed with no renewal. |
| `pending` | Claim acquired; assign in progress. *(lifecycle state, not OR2 terminal)* |
| `running` | Active, emitting heartbeats. *(lifecycle state)* |
| `suspended` | Pause-suspended; claim TTL frozen. *(lifecycle state)* |
| `killed` | Hard-killed by conductor; claim released. *(lifecycle state)* |

A tool or subprocess exiting with code 0 does **not** imply `useful_result`.
Only `assign()` returning a valid `WorkerHandle` followed eventually by an
`observe()` terminal event with `result_status == WorkerStatusCode.USEFUL_RESULT`
and a non-None `artifact` may be passed to the NFG gate.

---

## 5. Write-scope claims (OR1, LOCKED in part)

Claims are work-dedup: no two workers may hold overlapping active write claims.
They complement CRDT (CRDT = data convergence; claims = change ownership).

### Scope types

`PathGlobScope` — filesystem write-scope: repo identifier + tuple of glob
patterns (`!`-prefix = exclusion).  Overlap: glob-language intersection.

`LogicalScope` — abstract resource write-scope: `resource` string such as
`session:<id>.plan`, `registry:capability:<name>`,
`cascade:<agent>:<session>:context.md`, `domain:<id>:state`,
`memory:<agent>:<topic>`.  Overlap: exact resource-id equality with
parent/child rule.

`TaskScope` — coarsest scope: a whole task / run by `task_id`.  Overlap:
`task_id` equality.

### TTL and renewal (D5 §C2)

Default TTL by lane (the claim should outlive a normal worker turn but not a
dead worker):

| Lane | Default TTL |
|---|---|
| Inline worker (in-process sub-session) | 120 s |
| Detached / k3s Job body | 600 s |
| Subagent (full agent loop) | 1800 s |

Renewal is piggybacked on the heartbeat via `ProgressSignal.claim_renew = True`.
No separate renewal RPC exists.  A live, progressing worker always renews before
expiry; a dead worker's claim expires and is swept (lazy sweep every `TTL/4` and
on every `Acquire`).

Pause-aware TTL (D-029): while a worker is in `SUSPENDED` state its claim TTL
does not count down.

### Claim-on-first-write (D-029)

If `WorkSpec.write_scope` is `None`, the conductor defers claim acquisition to
the worker's first `blackboard_write` call.  This is the right default when
output paths are not statically known at assign time.  The claims hook
(`register_claims_hook`) fires if that late acquisition conflicts.

### Conflict resolution (thought's job, not conductor's)

The conductor returns `ClaimConflict` or fires the claims hook; it does not
block or choose resolution.  Thought then:

1. **Serializes** (default): marks the new item `blocked-on(holder_item)`;
   re-assigns when the holder's claim releases.
2. **Re-scopes**: narrows one item's `write_scope` to remove the overlap.
3. **Merges items**: folds two items that genuinely need the same resource into
   one item assigned to one worker.

Priority preemption is not supported in 4.0.

---

## 6. Non-progress detection (D5 §D)

The watchdog fires when `consecutive_no_progress_turns >= K`.

A turn made progress iff:
- `artifact_count` increased, **or**
- `blackboard_hash` changed **and** `state_digest` changed.

An identical `state_digest` across consecutive turns (same plan, same todo,
same tool calls, no new validated output) = a no-progress turn.

Proposed defaults (OPEN per D5 §D-II — K=3 vs K=5 is a cost/quality trade):
- `K_NOPROGRESS = 3` consecutive no-progress turns → fire non-progress hook.
- `SIB_K = 2` siblings with identical state_digest → fire duplicate-fanout hook.
- Soft `TURN_CEILING = 50` turns → fire non-progress hook (escalate-to-thought,
  not hard kill).
- Soft `WALL_CEILING = 30 min` → fire non-progress hook.

These are soft escalation thresholds: the watchdog signals thought; thought
decides kill / re-route / re-decompose / ask user (D5 §A4 recovery ladder).
Only an unrecoverable stuck loop ends in `kill()`.  Legitimate deep work is
unbounded (OR6a, LOCKED).

---

## 7. Blackboard mediation

Workers never write directly to the CRDT session log or context cascade.  All
hot-class writes flow through the conductor's `blackboard_write` path (D5 §E2),
which:

1. Verifies the worker's claim covers the target (hard reject on write if not).
2. Runs secret redaction (§05 L6 boundary).
3. Appends to the CRDT log (HLC-ordered) or patches the cascade file (claim
   guarantees no clobber).
4. Publishes a `blackboard.<session>.changed` NATS event to wake subscribers.

`blackboard_read` returns a deterministic fold; it registers advisory read
presence and may carry a `stale_risk: True` flag when a writer holds an
overlapping claim.  Reads are otherwise unrestricted (OR1, LOCKED).

The `blackboard_write` and `blackboard_read` method signatures are
**implementation-level** on the conductor class; they are not part of the
`WorkerLifecycle` Protocol because workers call them directly on their conductor
reference, not through thought.

---

## 8. The conductor-extraction seam

### What stays fixed (the contract)

When the conductor moves from an in-process Python component
(`../inference/python-agent/agent/conductor/`) to a standalone Go service,
the following must not change:

- The `WorkerLifecycle` Protocol signature (all method names, parameter types,
  return types).
- All type shapes: `WorkSpec`, `WorkerHandle`, `WorkerStatus`, `WorkerEvent`,
  `ProgressSignal`, `ClaimScope`, `ClaimConflict`.
- The `WorkerStatusCode` enum values (string literals are the wire values).
- The hook callable signatures.
- The claim-on-first-write behavior (deferred acquisition when
  `spec.write_scope is None`).
- Pause-aware TTL semantics (frozen TTL during SUSPENDED state).
- The non-progress signal definition (D5 §D-I formula).

### What changes

- **Transport:** in-process Python calls → NATS RPC (request/reply subjects
  per session).
- **Implementation language:** Python → Go.
- **Spawn lane:** in-process sub-session (VS0/S2) → k3s Jobs + Knative
  (S3+/post-4.0).
- **Liveness table:** in-process dict → in-process dict on the Go service side
  (same semantics, different runtime).

### How callers insulate themselves

Callers obtain a conductor from the session context (dependency injection).
They import only `WorkerLifecycle` from `agent.conductor.lifecycle` and call
`assign` / `observe` / `cancel` / `suspend` / `resume`.  At extraction
time the session context returns an object that satisfies `WorkerLifecycle` via
a thin NATS-RPC adapter; no caller changes.

---

## 9. Files

| Path | Content |
|---|---|
| `../inference/python-agent/agent/conductor/__init__.py` | Package init; re-exports all public names. |
| `../inference/python-agent/agent/conductor/lifecycle.py` | Typed contract: all types + `WorkerLifecycle` Protocol. |
| `docs/contracts/worker-lifecycle.md` | This document. |

Implementation files (VS0 stub, later Go adapter) live under
`../inference/python-agent/agent/conductor/` and are **not** part of this
contract repo.
