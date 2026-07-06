# Handoff

## Current Work

The active branch is `codex/bun-project-ci` for PR #2.

## Completed In This Branch

- Added Bun and TypeScript project scaffold.
- Added GitHub Actions CI.
- Added reusable `.agents/.global/` content.
- Added project-specific `.agents/.project/` content.

## Validation To Run Before Final Merge

```powershell
bun run ci
```

Confirm GitHub Actions `validate` passes on PR #2.

## Template Follow-Up

After a new repository is created from this template, replace `.agents/.project/` with that repository's project facts, decisions, status, and handoff.
