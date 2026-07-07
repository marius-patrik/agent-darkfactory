# State Sync Runbook

This guide activates the `agents state status/adopt/sync` workflow so session and orchestrator state lives under `~/.agents` and syncs across machines (Windows + Mac) through the private `agents-data` repository.

## What gets synced

`agents state sync` copies files from `~/.agents` into `~/.agents/state-repo/machines/<hostname>/` and pushes to the configured remote. The default allowlist covers:

- `skills/**`
- `bin/**`
- `state/**`
- `sessions/**` — session state and transcripts
- `orchestrator/**` — orchestrator ledger and heartbeat (`STATE.md`)
- `clis/**/config.*` and `clis/**/settings.*`
- `data-repos.json`, `packages.json`, `installs.json`, `environments.json`

The following are **always denied** regardless of the allowlist:

- `.git`, `node_modules`
- paths containing `auth`, `token`, `secret`, `credential`, `key`, `cookie`
- paths containing `cache`, `log`, `transcript` (as a directory), `history`

Denials are reported by `agents state sync --dry-run`.

## 1. Check current state

```sh
agents state status
agents state status --json
```

This shows whether each tool state is `in-place`, `adopted`, `missing`, or in `conflict`, and whether the state repo is configured.

## 2. Adopt tool state (one-time per machine)

Adopting moves a tool's state directory from its original location into `~/.agents/state/<tool>` and leaves a junction (Windows) or symlink (Mac) behind.

```sh
# Adopt Claude, Codex, or Kimi state
agents state adopt kimi
agents state adopt claude
agents state adopt codex
```

Windows notes:

- The junction is created with `mklink /J` and requires no elevated privileges.
- Close the target CLI before adopting; the directory must not be locked.

Mac notes:

- A symlink is created with `ln -s`.
- macOS may ask for Finder/Terminal permissions the first time the symlink is followed.

Verify adoption:

```sh
agents state status
```

You should see `adopted` with a link target pointing into `~/.agents/state/`.

## 3. Activate sync

The first sync clones the private `agents-data` repository into `~/.agents/state-repo`, copies allowed state into `machines/<hostname>/`, commits, and pushes.

```sh
agents state sync --dry-run
agents state sync
```

The dry-run lists every file that would be synced or skipped and why.

## 4. On a second machine

1. Install the `agents` CLI and run `agents state init`.
2. Adopt the same tool states if desired.
3. Run `agents state sync`.
4. The other machine's state appears under:

```
~/.agents/state-repo/machines/<other-hostname>/
```

Session and orchestrator ledgers are visible immediately because they are covered by the allowlist.

## 5. Conflict behavior

`agents state sync` uses `git pull --rebase` before pushing. This keeps the machine-specific `machines/<hostname>/` directories linear and avoids merge commits. If the same machine syncs from two locations simultaneously, the second sync rebases its local commit on top of the remote copy.

To avoid conflicts:

- Sync from one location per hostname at a time.
- Run `agents state sync --dry-run` before making large changes.
- Do not edit files directly inside `~/.agents/state-repo`; change them in `~/.agents` and sync.

## 6. Customize the allowlist

Edit `~/.agents/state-sync.json`:

```json
{
  "schemaVersion": 1,
  "include": [
    "skills/**",
    "sessions/**",
    "orchestrator/**"
  ],
  "exclude": [
    "sessions/**/private/**"
  ]
}
```

Run `agents state sync --dry-run` to confirm the change before syncing.
