# Handoff

## Current Work

The active branch is `codex/managed-folder-enforcement` for issue #1.

## Goal

Add `.agents` to `vibe-bot` and make the bot enforce shared repository setup in installed repositories.

## Expanded Goal

Add release automation and managed setup sync so Vibe Bot can open PRs that install or update shared setup in every repository where the GitHub App is installed.

## Validation To Run Before PR

```powershell
npm run check
npm run typecheck
npm test
npm run build
```

Confirm GitHub Actions `validate` passes after opening the PR.

## Follow-Up

- Configure `VIBE_BOT_APP_ID` and `VIBE_BOT_PRIVATE_KEY` as repository secrets.
- Install the GitHub App on all repositories through the GitHub installation UI.
- Run `Sync Managed Repositories` after the app has all-repo access.
- Consider Checks API enforcement later if comments are not strong enough.
