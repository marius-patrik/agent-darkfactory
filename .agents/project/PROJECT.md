# Project

Agent OS is one personal-agent product. This `Andromeda` repository owns the
implementation; `agents` is the only operator/runtime CLI, and the personal
installation's only state root is `$ANDROMEDA_HOME`, which is the `private-data`
checkout.

The repository is a single monorepo with **no submodules**. Everything that was
once a separate repository is folded in with its full history:

- **Target components** — `sdk`, `mcp`, `server`, `clients/{cli,app,web}`, and
  `plugins` — carry their contracts and are where new implementation belongs.
- **Carried trees** — `src/bot/`, `agents/<project>/`, and
  `templates/<project>/` — hold former standalone repositories. They keep their
  own identity and versioning, nothing outside them may depend on them, and code
  leaves `src/bot` by reimplementation against the sdk rather than by
  re-import or deletion.

Durable state is not part of this repository. It lives in `private-data` and is
reached through the Agent OS state lane.

All repository authority is rooted here: `docs/.agents/` owns project guidance,
`.darkfactory/` owns managed-repository policy, and `docs/` owns component,
protocol, architecture, and specification documentation. Target components carry
exactly one contract README at their own root and no nested documentation trees.
Carried trees retain their original project docs as evidence, which does not make
them Andromeda authority.

Target component ownership:

- `sdk` — the core package everything is implemented through: types, receipts,
  client bindings, the plugin contract. A pure library.
- `mcp` — the protocol and orchestration layer every call passes through.
  Passive: no daemon of its own. Carries MCP in both directions and integrates
  standard agent harnesses.
- `server` — per-machine deployment of the cluster system.
- `clients/cli`, `clients/app`, `clients/web` — clients only, no business logic.
- `plugins` — capabilities loaded through the sdk plugin contract.

Carried component ownership, frozen under `src/bot` and mined by
reimplementation:

- `src/cli` — `agents` CLI, state, installs, credentials/secrets,
  providers, sessions, memory, package/capability registries, lifecycle
  management, and — until the #218 harness migration is implemented and
  accepted — the orchestrator runtime.
- `src/sdk` — generated Go, TypeScript, and Python contracts and the
  suite that verifies them. The protobuf sources are `src/mcp/proto`.
- `src/sdk/harness` — canonical session event handling and tool execution.
  Owner-ruled target (2026-07-13, #218): the operation engine owning
  orchestration, with the orchestrator runtime migrating from the manager.
- `src/server/gateway` — local model registry, routing, health, quota, and
  transient control-plane relay.
- `src/server/inference` — gateway-backed Python agent loop, status, persistence,
  redaction, and package validation.

Historical product names, provider-home paths, launchers, and variables are
recovery evidence only. Do not add aliases, bridges, forwarding shims, or
fallback loaders.

`ANDROMEDA_SYSTEM_DATA_ROOT` and `$ANDROMEDA_HOME` must resolve to the same physical
private-data checkout. Plaintext runtime state remains local and ignored;
authenticated encrypted bundles under `backups/events/` are the only Git-backed
state backup and synchronization surface.

Branch policy: active implementation uses a feature branch and a PR into `dev`.
Release synchronization then propagates the tested `dev` tip to `main` through a
dedicated `dev` to `main` PR; feature work never targets `main` directly. A narrowly
scoped `pull_request_target` review-infrastructure bootstrap may target `main` only when
GitHub can load the fix solely from the default branch. The PR must state that reason,
pass the existing default-branch gate, and be reconciled into `dev` and the next release.
