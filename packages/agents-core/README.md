# Agentos Core

Shared Agentos contracts and generated client packages.

## Contents

- `proto/` holds the canonical Rommie/Agentos protobuf wire contract.
- `contracts-go/` holds generated Go protobuf and Connect stubs.
- `clients/shared-ts/` holds generated TypeScript protobuf descriptors and shared client exports.
- `clients/tui/` and `clients/web/` are placeholder client workspaces for the future TUI and web applications; they import `@agentos/shared-ts` for types and service descriptors.
- `docs/contracts/` holds protocol, engine, execution-lane, and worker lifecycle contracts.
- `buf.gen.yaml` regenerates the in-repo Go and TypeScript stubs from this package boundary.

## Package surface

`agents-core` is a **contracts / shared-client package**, not a CLI or end-user
application. It ships generated wire-contract stubs for downstream OS components:

- **Go:** module `github.com/marius-patrik/agentos/agentos-core/contracts-go`
  - Messages: `rommiev1 "github.com/marius-patrik/agentos/agentos-core/contracts-go/gen/rommie/v1"`
  - Connect services: `"github.com/marius-patrik/agentos/agentos-core/contracts-go/gen/rommie/v1/rommiev1connect"`
  - Consumer: `inference-engine` Go services via `../inference-engine/go.work`.
- **TypeScript:** workspace packages `@agentos/shared-ts`, `@agentos/tui`, `@agentos/web`
  - Shared descriptors and types: `@agentos/shared-ts/gen`
  - Consumers: the TUI and web clients (`clients/tui` and `clients/web` are placeholders).
- **Python:** plain protobuf stubs generated to the sibling `inference-engine/python-agent/agent/gen`
  - Bootstrap: `import agent.gen`
  - Messages: `from rommie.v1 import session_frames_pb2, registry_pb2`
  - Consumer: the `inference-engine` Python agent.

There is no user-facing installable CLI or app. `contracts-go/cmd/contracts-go`
is a development placeholder; downstream services consume the generated module
directly.

Run default in-repo codegen from this directory:

```sh
bunx --bun @bufbuild/buf generate proto
```

That updates the committed Go and TypeScript outputs only. Python stubs for the
sibling `inference-engine` repo are intentionally split into
`buf.gen.python.yaml`; run that template only when you are deliberately updating
that sibling repo in the same change.

Run the full package validation from this directory:

```sh
bun install
bun run check
```

The committed `bun.lock` is the lockfile for the TypeScript workspaces. On
Windows, prefix `PATH` with `C:/Program Files/Go/bin` before `bun run check` if
`go` is not already available.
