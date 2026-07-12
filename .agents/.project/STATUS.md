# Status

- Andromeda v0.2.1 is released from `main`; PR #169 merged the final event-export and Windows codegen verification fixes for the v0.2.2 acceptance pass.
- The complete Windows gate passes: 208 manager tests, generated-code freshness, and 27 review-takeover tests, with zero failures.
- `data/agent-os/context/TASK.md` is the canonical owner-facing task list. Completed work is folded into release history; the board contains one Backlog row followed by one final Parked row.
- Shared identity, memory, sessions, orchestration, providers, and task authority live under `.agents`; provider-local memories and transcripts are supporting evidence only.
- Final v0.2.2 acceptance requires installing the final `main` commit on Windows and Mac, a green state doctor on both, and an idempotent encrypted two-way event exchange.
