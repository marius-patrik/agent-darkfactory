# Status

- Repository: `marius-patrik/DarkFactory`
- Branch: `main`
- Product role: Separate GitHub-native autonomous engineering product
- Managed policy source: the `managed-repository` child of the sole
  `agent-os-data` checkout at `$AGENTS_ROOT/data/agent-os`
- Managed executable source: this DarkFactory package; duplicate payloads in
  managed data fail closed
- Operational ledger source: `marius-patrik/darkfactory-data`
- Shared state authority: `$AGENTS_HOME`
- Local worker authority: canonical `agents` launcher
- CI reviewer: isolated Codex-only job with no repository model pin
- Worker claims remain `df:running` until verified against live GitHub state
- Validation gate: `npm run check`
