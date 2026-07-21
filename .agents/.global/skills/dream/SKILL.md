---
name: dream
description: Run temporal replay of rollout sessions and produce proactive retrospective memory updates in a single end-to-end workflow.
---

# Dream

Use `dream` when Andromeda needs to replay unresolved sessions end-to-end and persist what should be carried forward into the next active session.

## Workflow

`dream` is a single-call workflow that behaves like a tiny multi-agent system:

1. **Replay Agent** loads rollout summaries in strict filename order and applies a cursor checkpoint.
2. **Retrospective Agent** extracts outcomes, follow-ups, blockers, and recurring lessons.
3. **Memory Agent** writes a consolidated snapshot to `SHORT.md`, `cache.md`, `handoff.md`, and `.dream-state.json`.

It is resumable:
- normal runs continue from the latest cursor (`.dream-state.json`)
- `-Reset` rebuilds from the oldest available session
- `-MaxSessions` chunks work when you want staged progress

## Command

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\skills\dream\scripts\run_dream.ps1
```

Optional flags:

- `-Reset` rebuild all sessions from the beginning.
- `-MaxSessions 25` limits the number of sessions processed in this call.
- `-DryRun` prints the planned work only.
- `-VerboseRun` prints stage-by-stage worker output.
- `-MemoryRoot "C:\Users\patrik\.codex\memories"` overrides memory location.

## Continuity markers

The generated memory files (`cache.md`, `SHORT.md`, `handoff.md`) use
`<!-- rommie:dream:* -->` HTML comment blocks as continuity markers. These
markers are intentionally retained so existing memory blocks continue to be
updated in place; new blocks use the same markers for continuity.

