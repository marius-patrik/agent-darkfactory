# Dream Plugin

The **Dream** package is a standalone plugin that contains only the `dream`
workflow for temporal replay and retrospective continuity.

It can run a resumable multi-pass workflow over rollout summaries, detect
unfinished work and blockers, and persist continuity snapshots into:

- `.dream-state.json`
- `cache.md`
- `SHORT.md`
- `handoff.md`

## What it provides

- `skill`: `dream`
- `command`: `run_dream.ps1` (via the `dream` skill interface)
- `mode`: resumable full replay with optional `-Reset`, `-MaxSessions`, `-DryRun`, and
  `-VerboseRun`

## Install locally

From the repository root:

```sh
agents packages register plugins/dream
```

Or install as a shared plugin:

```sh
agents install plugin dream plugins/dream
```


## Run

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\skills\dream\scripts\run_dream.ps1
```

## Validate

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tests\run_dream.ps1
```

Full CI validation:

```powershell
npm run ci
```

