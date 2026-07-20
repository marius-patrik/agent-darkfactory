# experience

Codex plugin for a layered local experience and memory system.

Layers:
- `LONG.md`: stable general operating rules.
- `MEMORY.md`: relevant remembered facts that may later be parked.
- `SHORT.md`: active multi-session workstreams.
- `cache.md`: volatile task-local cache.
- `handoff.md`: updated when work is finished or paused.
- `PARK.md`: inactive context kept for possible recovery.
- `ARCHIVE.md`: distilled low-churn lessons.

The plugin includes a `memory` skill plus `SessionStart` and `Stop` hook templates. The active hooks on this machine live under `C:\Users\patrik\.codex\hooks`.

