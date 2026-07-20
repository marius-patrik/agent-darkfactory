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
- Post-merge convergence is exact Git tree identity backed by trusted reviewed
  PR ancestry; merge-commit SHA identity is neither required nor simulated with
  protected-ref writes. Main-ahead state returns to `dev` through a reviewed PR.
- DarkFactory and Andromeda retain their explicit independent product, version,
  tag, and release authority.
- Only `marius-patrik/Andromeda-data` and `marius-patrik/darkfactory-data` use
  the private, main-only data policy. Their protection remains required. An
  exact plan-upgrade HTTP 403 is recorded as `accepted_residue`, not healthy
  protection, with [Andromeda PR #190](https://github.com/marius-patrik/Andromeda/pull/190)
  encrypted-bundle admission and plaintext rejection as the compensating
  control. Every other missing, inaccessible, or unsafe posture fails closed.

DarkFactory owns the executable policy contract. Shared managed-policy source
is canonical Andromeda-data under `$AGENTS_HOME`; runtime ledgers remain in the
separate darkfactory-data repository.
