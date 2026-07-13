# Handoff

Andromeda v0.2.2 acceptance and provider-memory consolidation are complete.
Resume planning from `data/andromeda/context/TASK.md`; do not recreate completed
rows from stale Fable, Claude, Codex, or Dream task stores.

The v0.2.2 cross-machine acceptance remains historical evidence. Windows memory,
session, orchestrator, capability, registry, provider, and sync-safety checks
are green after consolidation, but the installed launcher/source-install record
still targets the retired manager path. Do not infer current Mac parity; its
remaining convergence tail is parked.

```powershell
$env:AGENTS_HOME = "$HOME\.agents"
$env:AGENTS_USER_HOME = "$HOME"
$env:AGENTS_ROOT = "$HOME\marius-patrik\Andromeda"
Set-Location $env:AGENTS_ROOT
bun packages/manager/src/cli.ts state doctor --json
```

The remaining active sequence is: Planned 1 consolidates specifications into one
issue lane; Planned 2 resumes Claude, Codex, Kimi, and Agy through DarkFactory.
The global `agents` entrypoint and TUI UX are folded into the issue lane rather
than retained as a separate board row. There is no Backlog row. The final Parked
row, now including the interrupted Mac convergence tail, remains frozen until
Patrik explicitly reopens an item.

The personal `.agents` directory is the Andromeda-data checkout and the sole
state/data authority. `agents state backup|restore|sync` operates on
authenticated encrypted event bundles in that repository; never commit
plaintext credentials, provider homes, keys, locks, caches, or projections.
