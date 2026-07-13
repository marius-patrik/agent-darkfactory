---
name: compact
description: Prepare a compaction-safe handoff in canonical Agent OS memory and synchronize its encrypted Andromeda-data state backup. Use when the user asks to compact, prepare for compaction, preserve current work state, make compaction useful, or before reminding the user to compact after substantial work.
---

# Compact

Use compact to store active work as one superseding immutable Agent OS memory
record, render canonical startup context, synchronize the encrypted state
repository, and refresh hook-compatible projections. The projections are never
memory authority.

Invariant: `$AGENTS_HOME/memory` immutable events are the sole compaction
authority. Never redirect the script to `.codex/memories`, write a second
canonical handoff, or bypass an authority mismatch with a path override.
The authority path must be physically contained in `AGENTS_HOME`; links,
symlinks, and Windows reparse-point/junction escapes are rejected. All path
construction must remain portable across Windows, macOS, and Linux. Apply the
same physical-path checks to compatibility roots and every projection file;
provider-local projections are untrusted destinations, not an authority carveout.
The compatibility root and the complete `AGENTS_HOME` tree must be disjoint in
both directions; neither may be an ancestor or descendant of the other. The
compatibility root stays under the resolved user home so macOS system aliases
above that boundary do not get mistaken for provider-local link escapes.

## Workflow

1. Capture the current objective, completed work, repo/path state, validation, blockers, and exact next actions.
2. Prefer facts that a fresh agent needs to resume, not a transcript summary.
3. Run the capsule script with explicit values. It discovers `AGENTS_HOME` and
   `AGENTS_MEMORY` from `agents state env`; no memory-root or mandatory-step
   bypass is allowed. The script preflights repository synchronization before
   mutation and only then selects the active scalar, holds a persistent-file
   exclusive canonical lock through publication, then rolls canonical memory
   and compatibility files back if final publication fails. The lock file is
   never unlinked during handoff. First creation is atomic; reused lock entries
   are link-checked before and after a read-only exclusive open:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\skills\compact\scripts\write_compaction_capsule.ps1 -Objective "current goal" -State "what is done now" -Next "next command or decision" -Validation "checks run and results" -Blockers "known blockers or None"
```

4. Verify the returned JSON has `ok=true`, a canonical record ID, a snapshot,
   a projection hash, and `repositorySynced=true`. A zero process exit is not
   sufficient: sync JSON must confirm the push and include restore and backup
   evidence. `backup.committed=false` is valid when the content-addressed bundle
   was already tracked; `pushed=true` plus the complete bundle evidence is the
   publication contract. Restore evidence requires a SHA-256 projection hash;
   backup evidence requires an authenticated `backups/events/` bundle whose
   filename matches its payload hash. After sync, the script must rerender
   memory and prove its exact record is still the sole active compaction scalar.
5. If the script detects authority drift, multiple active compaction records,
   projection-integrity failure, or state-sync failure, stop. Repair this skill
   and add a regression case before compacting; do not work around the defect.
   Recovery may restore a prior value only while the failed local record is
   still the sole active scalar; otherwise preserve synchronized authority.
6. If active work remains, describe the exact next action. If work is complete,
   say so without inventing follow-up work.
7. Tell the user compaction is ready and remind them to compact the task.

## Capsule Quality Bar

A useful compaction capsule names:

- Current repo paths and important commits.
- Dirty files or clean-state evidence.
- Commands already run and their results.
- Failed validations that still matter.
- The exact next action if work resumes.
- The canonical memory record, projection hash, and encrypted repository-sync
  result.
