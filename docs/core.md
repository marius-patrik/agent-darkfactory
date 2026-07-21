# Agent OS Core

Shared Agent OS contracts and generated client packages.

## Contents

- `proto/` holds the canonical Agent OS protobuf wire contract.
- `contracts-go/` holds generated Go protobuf and Connect stubs.
- `clients/shared-ts/` holds generated TypeScript protobuf descriptors and shared client exports.
- `clients/tui/` and `clients/web/` are placeholder client workspaces for the future TUI and web applications; they import `@agent-os/shared-ts` for types and service descriptors.
- root `packages/mcp/contracts/` holds protocol, engine, execution-lane, and worker lifecycle contracts.
- `packages/migrate/core/buf.gen.yaml` regenerates the in-repo Go and TypeScript stubs from this package boundary.

## Package surface

`agent-os-core` is a **contracts / shared-client package**, not a CLI or end-user
application. It ships generated wire-contract stubs for downstream OS components:

- **Go:** module `github.com/marius-patrik/agents-manager/src/migrate/core/contracts-go`
  - Messages: `agent_osv1 "github.com/marius-patrik/agents-manager/src/migrate/core/contracts-go/gen/agent_os/v1"`
  - Connect services: `"github.com/marius-patrik/agents-manager/src/migrate/core/contracts-go/gen/agent_os/v1/agent_osv1connect"`
  - Consumers: the Go services under `packages/server/inference/`.
- **TypeScript:** workspace packages `@agent-os/shared-ts`, `@agent-os/tui`, `@agent-os/web`
  - Shared descriptors and types: `@agent-os/shared-ts/gen`
  - Consumers: the TUI and web clients (`clients/tui` and `clients/web` are placeholders).
- **Python:** plain protobuf stubs generated to `packages/server/inference/python-agent/agent/gen`
  - Bootstrap: `import agent.gen`
  - Messages: `from agent_os.v1 import session_frames_pb2, registry_pb2`
  - Consumer: the Agent OS inference Python agent.

There is no user-facing installable CLI or app. `contracts-go/cmd/contracts-go`
is a development placeholder; downstream services consume the generated module
directly.

Run default in-repo codegen from the repository root:

```sh
cd packages/migrate/core
bunx --bun @bufbuild/buf generate proto
```

That updates the committed Go and TypeScript outputs. Python stubs are refreshed
with `buf.gen.python.yaml` when the in-repository inference consumer is part of
the same change.

Run the full package validation from the repository root:

```sh
bun install
bun run check
```

The committed `bun.lock` is the lockfile for the TypeScript workspaces. On
Windows, prefix `PATH` with `C:/Program Files/Go/bin` before `bun run check` if
`go` is not already available.
