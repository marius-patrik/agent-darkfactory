# Project

Agent OS is one personal-agent product. This `Andromeda` repository owns
the implementation; `agents` is the only operator/runtime CLI and
`/Users/user/.agents` is the personal installation's only state root.

Implementation components are direct children of `src/`: `manager`,
`core`, `harness`, `gateway`, and `inference`. Managed plugin repositories and
managed applications are also Git submodules under `src/`, and
development data repositories are under `data/`. `data/andromeda` pins the
Andromeda-data source contract while `data/darkfactory` pins DarkFactory's data
ledger; the live Andromeda-data checkout remains `$AGENTS_HOME` itself. Their
names identify components, not alternate Agent OS products or state authorities.

All repository authority is rooted here: `.agents/` owns project guidance,
`.darkfactory/` owns managed-repository policy, and `docs/` owns component,
protocol, architecture, and specification documentation. Superproject-owned
implementation packages contain implementation and package manifests only;
they must not carry nested repository authorities or documentation trees.
Managed repository gitlinks below `src/` retain their independently owned
child authority and documentation without becoming Andromeda authority.

Component ownership:

- `src/migrate/manager` — `agents` CLI, state, installs, credentials/secrets,
  providers, sessions, memory, package/capability registries, lifecycle
  management, and — until the #218 harness migration is implemented and
  accepted — the orchestrator runtime.
- `src/migrate/core` — protobuf sources and generated Go, TypeScript, and Python
  contracts.
- `src/migrate/harness` — canonical session event handling and tool execution.
  Owner-ruled target (2026-07-13, #218): the operation engine owning
  orchestration, with the orchestrator runtime migrating from the manager.
- `src/migrate/gateway` — local model registry, routing, health, quota, and
  transient control-plane relay.
- `src/migrate/inference` — gateway-backed Python agent loop, status, persistence,
  redaction, and package validation.

Historical product names, provider-home paths, launchers, and variables are
recovery evidence only. Do not add aliases, bridges, forwarding shims, or
fallback loaders.

`AGENTS_SYSTEM_DATA_ROOT` and `$AGENTS_HOME` must resolve to the same physical
Andromeda-data checkout. Plaintext runtime state remains local and ignored;
authenticated encrypted bundles under `backups/events/` are the only Git-backed
state backup and synchronization surface.

Branch policy: active implementation uses a feature branch and a PR into `dev`.
Release synchronization then propagates the tested `dev` tip to `main` through a
dedicated `dev` to `main` PR; feature work never targets `main` directly. A narrowly
scoped `pull_request_target` review-infrastructure bootstrap may target `main` only when
GitHub can load the fix solely from the default branch. The PR must state that reason,
pass the existing default-branch gate, and be reconciled into `dev` and the next release.
