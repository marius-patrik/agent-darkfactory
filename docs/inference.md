# Agent OS Inference

This package contains the gateway-backed inference worker loop and its
verification.

## State authority

`AGENTS_HOME` is required and must be absolute. Inference owns only private
runtime state below `$AGENTS_HOME/runtime/inference`:

- worker runs: `runs/`

Inference does not write the canonical Agent OS session, memory, capability,
configuration, or credit stores. Its generated `common_pb2` module uses the
canonical `agent_os.v1` protocol emitted from `packages/mcp/proto`.

## Contents

- `python-agent/` — worker loop, status machine, and persistence-boundary
  redaction.

## Verify

```sh
bun packages/server/inference/scripts/validate.mjs
```

That command runs ruff, mypy, pytest, the Python package build, generated
protocol import checks, and layering checks. Live model probes are separate
operator actions because they require the gateway and local engines.
Deployment belongs exclusively to the root `agents os` lifecycle.
