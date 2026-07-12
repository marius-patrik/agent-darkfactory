# Status

- Branch policy: use PRs into `dev`.
- Validation: ruff, mypy, pytest, packaging smoke, and wheel/sdist build.
- Runtime state: explicit `AGENTS_HOME` only; the gateway does not read or
  refresh provider credentials.
- Registry authority: package-owned `registry/models.yaml`; the only mutable
  gateway state is append-only trace output under `$AGENTS_HOME/runtime/gateway`.
- Runtime: the package manifest starts the native service on `127.0.0.1:8787`.
