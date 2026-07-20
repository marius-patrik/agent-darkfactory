---
name: memory
description: Manage the user's layered Codex memory and experience system and enforce memory hygiene. Use when Codex needs to read, update, or reason about LONG.md, MEMORY.md, SHORT.md, PARK.md, ARCHIVE.md, cache.md, handoff.md, startup or stop memory hooks, cross-session handoffs, context compaction survival, multi-session workstreams, or the experience plugin repository.
---

# Memory

Use the layered memory files deliberately:

- `LONG.md`: stable general operating rules that should apply across projects and sessions.
- `MEMORY.md`: relevant remembered facts and preferences that may later be removed or parked.
- `SHORT.md`: active multi-session workstreams that must survive context compaction and overlapping sessions.
- `cache.md`: immediate task cache for volatile errors, commands, paths, hypotheses, and partial results.
- `handoff.md`: end-of-work summary for the next session.
- `PARK.md`: inactive context that may be useful later but should not drive current work by default.
- `ARCHIVE.md`: distilled, durable lessons extracted from older or parked material.

At session start, expect the hook to inject these layers in this order:

1. `LONG.md`
2. `SHORT.md`
3. `cache.md`
4. `handoff.md`
5. `memory_summary.md`
6. `MEMORY.md`
7. `PARK.md`
8. `ARCHIVE.md`
9. ad-hoc memory notes

When working:

- Prefer explicit user instructions, current repo files, and live command output over stale memory.
- Read `SHORT.md`, `cache.md`, and `handoff.md` before resuming ongoing or ambiguous work.
- Update `cache.md` during complex work when context compaction would otherwise lose key transient facts.
- Update `SHORT.md` when a workstream remains active across sessions.
- Update `handoff.md` when work is finished, paused, or ready for another session.
- Move no-longer-current context from `MEMORY.md` or `SHORT.md` to `PARK.md` instead of deleting it when it may still matter.
- Distill repeated or stable lessons from `PARK.md` or handoffs into `ARCHIVE.md`.
- Keep each entry compact, dated, and tied to a project or workstream when possible.

Do not store secrets, tokens, private keys, or credentials in these files.
