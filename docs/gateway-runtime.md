# Agent OS Gateway

The gateway is Agent OS's model-routing edge. It exposes an OpenAI-format API,
routes task classes to the package-owned local model registry and probes model
health.
`llm_gateway` is its internal Python import namespace; the distribution,
package, service, and CLI identity is `agent-os-gateway`.

## State contract

`AGENTS_HOME` is required and must be absolute. Append-only traces live below
`$AGENTS_HOME/runtime/gateway`. The static local model
registry is `registry/models.yaml`; runtime variables cannot replace its path
or endpoints. The gateway does not read provider CLI credentials and does not
write Agent OS memory, sessions, capabilities, provider configuration, or the
canonical credit ledger. Cloud providers are executed only by the canonical
manager-owned provider harnesses.

## Run

```sh
cd packages/server/gateway
uv sync --frozen
AGENTS_HOME=/absolute/.agents uv run agent-os-gateway serve
```

The native service listens only on `127.0.0.1:8787` by default and provides:

- `POST /v1/chat/completions`
- `GET /v1/models`
- `POST /route` and `GET /route/{task_class}`
- `GET /health`

Requested role aliases resolve deterministically from registry declaration
order. The gateway has no mutable provider/model selector; canonical session
provider/model events remain owned by the TypeScript runtime.

## Verify

```sh
cd packages/server/gateway
uv run ruff check llm_gateway tests scripts
uv run mypy llm_gateway
uv run pytest -q -m 'not live'
AGENTS_HOME=/tmp/agent-os-gateway-smoke uv run python scripts/packaging_smoke.py
uv build
```

Tests mock local model traffic. No provider credential is required.
