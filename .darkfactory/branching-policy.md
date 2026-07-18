# DarkFactory Branching Policy

Managed code repositories use `dev` as the integration branch and `main` as the release branch.

- Work pull requests target `dev`.
- `dev` to `main` pull requests are release synchronization only.
- Merging to `main` should correspond to tag and GitHub release automation where the repository ships releases.
- Both `dev` and `main` use strict GitHub-Actions-bound branch protection with
  `Validate` and `DarkFactory Autoreview` required. A clean medium review alone
  is insufficient; Autoreview succeeds only after an independent schema-valid
  clean high confirmation.
- Force pushes and branch deletion are disabled on both protected branches.
- Repository auto-merge may be enabled, but a queued merge lands only after the
  protected branch is current and both required checks report success.
- A separate pull-request approval is not required; `DarkFactory Autoreview` is
  the automated review gate. Administrator enforcement remains disabled, and
  automation does not use the available bypass.
- State and data repositories may use continuous `main` only when their own
  documented protection and admission policy permits it.

The live Andromeda settings and evidence for this policy are recorded in
[`docs/managed-enforcement.md`](../docs/managed-enforcement.md).
