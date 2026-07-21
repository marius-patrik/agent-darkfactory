# DarkFactory Branching Policy

Managed code repositories are trunk-based: `main` is the only long-lived branch
and is the canonical released product state.

- Work branches off `main` and returns through a reviewed pull request into
  `main`. There is no `dev` integration branch and no separate release pull
  request.
- `main` requires strict, GitHub-Actions-bound `Validate` and
  `DarkFactory Autoreview` checks. A clean medium review alone is insufficient;
  Autoreview succeeds only after an independent schema-valid clean high confirmation.
- Force-pushes, deletion, and administrative gate bypass remain disabled.
- Every merge into `main` publishes a release. The tag is derived from the
  product version, so a release is cut exactly once per version and a merge that
  does not change the version publishes nothing rather than duplicating a tag.
- Because `main` is the only long-lived branch, post-merge convergence is
  trivially exact: there is no second branch to reconcile and no tree-identity
  comparison to maintain.
- DarkFactory and Andromeda retain their explicit independent product, version,
  tag, and release authority.
- Only `marius-patrik/private-data` and `marius-patrik/darkfactory-data` use
  the private, main-only data policy. Their protection remains required. An
  exact plan-upgrade HTTP 403 is recorded as `accepted_residue`, not healthy
  protection, with [Andromeda PR #190](https://github.com/marius-patrik/Andromeda/pull/190)
  encrypted-bundle admission and plaintext rejection as the compensating
  control. Every other missing, inaccessible, or unsafe posture fails closed.

DarkFactory owns the executable policy contract. Shared managed-policy source
is canonical private-data under `$ANDROMEDA_HOME`; runtime ledgers remain in the
separate darkfactory-data repository.
