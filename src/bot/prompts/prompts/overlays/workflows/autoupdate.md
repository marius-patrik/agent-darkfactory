### Pointer autoupdate workflow overlay

- Consume only stable deterministic pointer-drift findings from trusted policy and
  verified child release state.
- Reconcile one marker-owned parent branch and pull request, preserving exact gitlink
  paths and updating only to an accessible green released child commit.
- Validate recursive checkout in an isolated least-privilege lane, then require the
  normal validation, Autoreview, and parent release policy.
- Close drift only after the released parent contains the pointer and any downstream
  root update is verified.
