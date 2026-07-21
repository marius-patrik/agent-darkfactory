# Agent OS Container Architecture

Status: parked supporting design. The repository has lifecycle planning code,
but the program plan and PRD park custom distro/container work. This document
does not authorize resumption. There is no released Agent OS image or root
Dockerfile; commands must not report an image build, pull, deployment, or
environment switch as complete unless a future owner-authorized issue implements
and verifies the real container boundary.

## Product boundary

Agent OS remains one product inside or outside a container:

- `agents-manager` owns state discovery, provider pinning, sessions, memory,
  capabilities, package registries, and lifecycle commands.
- `packages/cli`, `packages/sdk/harness`, `packages/sdk`, `packages/server/gateway`,
  and `packages/server/inference` are implementation components, not separate products.
- `packages/darkfactory` is a GitHub control-plane package, not a second agent
  brain.
- `packages/memory` is the cognitive memory-operations plugin; it reads and
  mutates memory only through manager-owned canonical contracts.
- `packages/lifequest` and `packages/skyagent` are managed plugins;
  `packages/fabrica` is a managed application.
- `data/andromeda` and `data/darkfactory` pin the separate Andromeda and
  DarkFactory data repositories for development.
- private-data is checked out at `andromeda_home`; it is the same physical root
  as `ANDROMEDA_SYSTEM_DATA_ROOT`, not an alternate state authority.

The container is replaceable compute. It must mount the one authoritative
`andromeda_home`; it must never seed or maintain another writable identity,
memory, provider, session, or capability authority.

## Image contract

A future image must:

1. use a pinned Linux base and pinned Bun, Node.js, Python/uv, and Go versions;
2. run as a non-root user under a real init/supervisor;
3. install the `agents-manager` source or release artifact as `agents`;
4. contain reproducible package code only, with no credential or mutable user
   state baked into a layer;
5. declare health checks for every enabled service;
6. record source commit, build time, channel, version, and immutable digest;
7. pass `agents state doctor` against a disposable mounted state root.

Expected references are `agents-os:<version>` locally and
`ghcr.io/marius-patrik/agents-os:<version>` when a publication workflow exists.
Moving tags such as `dev` are discovery channels, never provenance.

## Runtime contract

The MVP may supervise manager, harness, inference, gateway, and DarkFactory
processes in one container. Each process receives the same canonical root
projection and a package-declared data/workspace scope. Splitting services into
multiple containers later must not change state authority.

Required rules:

- provider homes remain `andromeda_home/clis/<provider>`;
- raw provider databases, models, caches, logs, and locks are local-only;
- Git-backed state sync commits authenticated encrypted event bundles only;
- secret names/scopes may appear in plans, but values never do;
- mounted source/data/workspaces use absolute host paths;
- container removal never removes mounted data without a separate explicit
  prune decision;
- no lifecycle operation follows a symlinked state root.

## Lifecycle surface

The declared command family is:

```text
agents os doctor [--json]
agents os image list [--json]
agents os image build|pull ... [--dry-run]
agents os create|start|stop|status|logs|exec|terminal|remove ...
agents os deploy <profile> ... [--dry-run]
```

Dry-run output is a plan, not evidence. A non-dry-run command must verify
Docker availability, the exact image/digest, mounts, environment, container
labels, and health before recording success. Until the missing image build and
release artifacts exist, unsupported mutations fail explicitly.

Managed containers use labels in the `io.andromeda.*` namespace and default to
no automatic restart for local development. The TUI is a view over this same
command/state surface; it cannot maintain a separate registry.

See [Data Contracts](DATA-CONTRACTS.md) for mounts and
[Build and Release](BUILD.md) for the current implementation gate.
