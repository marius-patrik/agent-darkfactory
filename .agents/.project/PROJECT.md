# Project

Agent OS is one personal-agent product. This `Andromeda` repository owns
the implementation; `agents` is the only operator/runtime CLI and
`/Users/user/.agents` is the personal installation's only state root.

Implementation components are direct children of `packages/`: `manager`,
`core`, `harness`, `gateway`, and `inference`. Managed product repositories are
Git submodules under `plugins/`; the sole data submodule is `data/agent-os`.
Their names identify components, not alternate Agent OS products or state
authorities.

All repository authority is rooted here: `.agents/` owns project guidance,
`.darkfactory/` owns managed-repository policy, and `docs/` owns component,
protocol, architecture, and specification documentation. Package directories
contain implementation and package manifests only; they must not carry nested
repository authorities or documentation trees.

Component ownership:

- `packages/manager` — `agents` CLI, state, providers, sessions, memory,
  orchestration, package/capability registries, and lifecycle operations.
- `packages/core` — protobuf sources and generated Go, TypeScript, and Python
  contracts.
- `packages/harness` — canonical session event handling and tool execution.
- `packages/gateway` — local model registry, routing, health, quota, and
  transient control-plane relay.
- `packages/inference` — gateway-backed Python agent loop, status, persistence,
  redaction, and package validation.

Historical product names, provider-home paths, launchers, and variables are
recovery evidence only. Do not add aliases, bridges, forwarding shims, or
fallback loaders.

Branch policy: active implementation uses a feature branch and a PR into `dev`.
Release synchronization then propagates the tested `dev` tip to `main` through a
dedicated `dev` to `main` PR; feature work never targets `main` directly. A narrowly
scoped `pull_request_target` review-infrastructure bootstrap may target `main` only when
GitHub can load the fix solely from the default branch. The PR must state that reason,
pass the existing default-branch gate, and be reconciled into `dev` and the next release.
