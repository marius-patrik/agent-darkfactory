### Release convergence workflow overlay

- Start from deterministic branch classification and fresh protection, ref, check,
  mergeability, and release-policy evidence.
- Reconcile default-ahead state through review; surface semantic divergence as an
  owner question with exact conflicts.
- Use one protected temporary release branch and one marker-owned pull request into
  the default branch. Never use the long-lived integration branch as a deletable head.
- Verify green gates, merge, publications, post-default checks, branch synchronization,
  linked closure, cleanup, and ledger state before reporting released.
