# Status

- Andromeda v0.2.2 is released at `d7bafd4f660c275bb327b9dd97b371f26a48adc2` after PRs #169, #170, and #172 passed CI and automated review.
- The complete Windows gate passes: 208 manager tests, generated-code freshness, and 27 review-takeover tests, with zero failures.
- The last v0.2.2 cross-machine acceptance installed exact
  `main@d7bafd4f660c` on Windows and Mac. Its encrypted 18-entry exchange was
  idempotent in both directions, and both machines replayed the same nine
  memory events at that acceptance boundary.
- Windows now has four checksum-verified providers and green memory, session,
  orchestrator, capability, registry, and sync-safety checks. Its installed
  launcher/source-install binding is stale after repository convergence.
- Post-acceptance provider-memory consolidation intentionally advances Windows
  to 26 memory events. Mac parity was not asserted; the interrupted Mac tail is
  parked.
- `data/agent-os/context/TASK.md` is the canonical owner-facing task list. It
  contains three ordered Planned rows and one final Parked row; the completed
  memory backlog is removed.
- Fable/Codex memory consolidation and Dream/Codex hygiene are complete: 26
  immutable events replay to 26 verified records, with 20 active startup facts,
  six explicit supersessions, zero disputes/retractions/secrets, and projection
  hash `4afbecaefeb816928b9e7c1ace4a7eae2a10e0041ca6fb4bae44e5763fa67d8e`.
- Shared runtime identity, memory, sessions, orchestration, and providers live
  under `.agents`. Provider-local memories and transcripts are cache or
  hash-addressed rollback evidence only.
- Repairing the installed `agents` launcher/source-install binding belongs to
  Planned 3 rather than this completed memory slice.
