# Status

- Andromeda v0.2.1 is released from `main`; PR #169 merged the final event-export and Windows codegen verification fixes, and PR #170 back-synced that reviewed history plus the canonical task board to `dev`.
- The complete Windows gate passes: 208 manager tests, generated-code freshness, and 27 review-takeover tests, with zero failures.
- `data/agent-os/context/TASK.md` is the canonical owner-facing task list. Completed work is folded into release history; the board contains one Backlog row followed by one final Parked row.
- Shared runtime identity, memory, sessions, orchestration, and providers live under `.agents`; that shared context references the Git-backed TASK.md board instead of maintaining a competing provider-local task list. Provider-local memories and transcripts are supporting evidence only.
- PR #172 is the dedicated `dev`-to-`main` v0.2.2 release. After it merges, final acceptance requires tagging its merge commit, installing that exact `main` commit on Windows and Mac, a green state doctor on both, and an idempotent encrypted two-way event exchange.
