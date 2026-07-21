# Packages and Environments Groundwork

Status: parked supporting design. The program plan and PRD park custom
distro/container implementation; this document preserves the already-landed
scaffold boundary and does not authorize further work.

This document defines the local desired-state groundwork for future real
OS/container package and named-environment management. Image build/publication
and named-environment switching remain gated by the current Agent OS image and
release contracts.

## Current Boundary

Implemented now:

- `.agents/environments.json` state file with typed records for future distro packages, container packages, environments, and OS containers.
- `ANDROMEDA_ENVIRONMENTS` exported through `.agents/env` and package/harness execution environments.
- CLI command skeletons for `agents packages distro ...`, `agents packages container ...`, and `agents env ...`.
- `agents os` lifecycle commands with dry-run plans for Docker-based container management.
- Clear `not yet implemented` errors for operations that would mutate OS packages or active environments beyond the scaffolded lifecycle surface.

Not implemented now:

- Installing host OS packages.
- Real container image builds or pulls against a published `andromeda-os` image (the scaffold records metadata and produces dry-run plans).
- Creating, switching, or syncing named environments.
- Per-agent workspace environment provisioning.

## State File

Path: `.agents/environments.json`

```json
{
  "schemaVersion": 1,
  "activeEnvironmentId": "host",
  "distroPackages": [
    {
      "id": "base-curl",
      "target": "host",
      "manager": "apt",
      "name": "curl",
      "version": "8.0.0",
      "source": "andromeda-os"
    }
  ],
  "containerPackages": [
    {
      "id": "andromeda-os-base",
      "image": "ghcr.io/marius-patrik/andromeda-os",
      "digest": "sha256:...",
      "tags": ["latest"],
      "runtime": "docker"
    }
  ],
  "environments": [
    {
      "id": "host",
      "kind": "host",
      "packages": ["base-curl"],
      "secretsScope": "host",
      "createdAt": "2026-07-03T00:00:00.000Z"
    }
  ],
  "containers": [
    {
      "id": "andromeda-os-dev",
      "name": "andromeda-os-dev",
      "environment": "dev",
      "image": "andromeda-os:dev",
      "channel": "dev",
      "createdAt": "2026-07-04T00:00:00.000Z",
      "status": "running",
      "ports": [{ "name": "http", "container": 8080, "host": 8080 }],
      "profiles": ["full-system"]
    }
  ]
}
```

The initial file is empty except for `schemaVersion: 1` and empty arrays. Future implementations should treat records as desired state, not proof that a host package or container image is currently installed.

## CLI Skeleton

```text
agents packages distro <define|install|upgrade|remove> ...
agents packages container <define|pull|pin|upgrade|remove> ...
agents env list [--json]
agents env create <id> [--kind host|container|agent-workspace]
agents env switch <id>
agents env sync <id>
agents os doctor [--json]
agents os image list [--json]
agents os image build --image <image> [--channel dev] [--file path] [--context path] [--dry-run]
agents os image pull --image <image> [--channel dev] [--dry-run]
agents os create --name <name> --image <image> [--env andromeda-os] [--channel dev] [--dry-run]
agents os start <name> [--dry-run]
agents os stop <name> [--dry-run]
agents os status <name> [--json]
agents os logs <name> [--follow]
agents os exec <name> -- <args...>
agents os terminal <name> [--shell bash]
agents os remove <name> [--prune-data] [--dry-run]
agents os deploy <profile> [--image andromeda-os] [--env andromeda-os] [--channel dev] [--dry-run]
```

`agents env list` may read local desired-state records. Unsupported mutating
`agents packages` and `agents env` commands fail explicitly until the image,
release, and environment contracts have real implementations. `agents os`
commands expose dry-run plans and may invoke Docker only on implemented
non-dry-run paths.

## Integration Rules

- Keep all package and environment operations under the `agents` CLI to satisfy the single-management-surface mandate from #7.
- Reuse `.agents/secrets` scopes rather than creating a separate secret store for environments.
- Use Docker as the first container runtime target unless a future issue changes that contract.
- Never pretend a package was installed or an image was pulled without invoking the real provider and recording evidence.
