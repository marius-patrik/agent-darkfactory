# Status

- Repository: `marius-patrik/DarkFactory`
- Branch: `main`
- Product role: Separate GitHub-native autonomous engineering product
- Managed policy authority: the `managed-repository` child of canonical
  `marius-patrik/Andromeda-data` at `$AGENTS_HOME`
- Managed executable source: this DarkFactory package; duplicate payloads in
  managed data fail closed
- Operational ledger source: `marius-patrik/darkfactory-data`
- Shared state authority: `$AGENTS_HOME`
- Local worker authority: canonical `agents` launcher
- Repository doctor: deterministic read-only diagnosis by default; explicit
  stable-finding issue reporting; no implicit repair
- CI reviewer: provider-agnostic DarkFactory Autoreview through canonical
  Agent OS, with bounded medium review/fix rounds and independent high
  confirmation
- Human CLI: `df` canonical executable plus exact `darkfactory` alias;
  versioned registry/help/JSON, shared issue and PR Autoreview entrypoints,
  high-tier local issue drafting, digest-approved publication, and deterministic
  ready/explain/evidence surfaces
- Worker claims remain `df:running` until verified against live GitHub state
- Validation gate: `npm run check`
