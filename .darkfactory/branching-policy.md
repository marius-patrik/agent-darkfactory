# DarkFactory Branching Policy

Managed code repositories use `dev` for work integration and `main` for each
repository's canonical released product state.

- Work pull requests target `dev`.
- `dev` and `main` require strict, GitHub-Actions-bound `Validate` and
  `DarkFactory Autoreview` checks. A clean medium review alone is insufficient;
  Autoreview succeeds only after an independent schema-valid clean high confirmation.
- Force-pushes, deletion, and administrative gate bypass remain disabled.
- Release pull requests move reviewed `dev` state to `main` through an eligible
  `release/<id>` branch without deleting long-lived `dev`.
- DarkFactory and Andromeda retain their explicit independent product, version,
  tag, and release authority.
- State and data repositories may commit directly to `main` when their own policy permits it.

DarkFactory owns the executable policy contract. Shared managed-policy source
is canonical Andromeda-data under `$AGENTS_HOME`; migration of the current
compatibility adapter is tracked by #255.
