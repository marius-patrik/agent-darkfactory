# Agentos Gateway (VS1-minimal)

The single client-facing LLM edge. OpenAI-format API, config-driven model
registry, per-role model selection, context-window fallback, `<think>`-strip,
and structured traces. **Salvaged + adapted** from the v3 `legacy/src-packages-gateway`
package (FastAPI + httpx + litellm) — re-namespaced from the v3 `agents`
package namespace into `agentos_gateway`.

> **Scope: VS1-minimal.** LOCAL engines are the only enabled defaults. Cloud
> registry stubs remain disabled; the never-meter `allow_cloud` and quota
> degrade-to-local guardrails stay enforced in the router. Credential-gated
> cloud dispatch proof remains deferred — see
> [`docs/gateway.md`](docs/gateway.md).

## Quick start

```bash
cd llm-gateway
uv sync
uv run ruff check agentos_gateway tests
uv run mypy agentos_gateway
uv run pytest -q          # green, no live engines (httpx mocked)
uv run gateway serve      # listens on http://0.0.0.0:4000
```

## API

### `POST /v1/chat/completions`
OpenAI-compatible chat. `model` accepts a model ID or a role alias
(`general`, `coding`, `conversation`, `judge`, `embedding`). `allow_cloud`
defaults to `false`; in VS1 no cloud model is enabled, so cloud is unreachable.

### `GET /v1/models`
List enabled models (OpenAI format).

### `POST /route` and `GET /route/{task_class}`
Resolve a work class to the configured provider, model, params, fallbacks, and
budget caps. Classes are configured in `registry/routing.yaml` and include
`mechanical`, `standard-impl`, `hard-impl`, `review`, and
`judgment/orchestration`. Consumers such as DarkFactory workers should call this
surface instead of hard-coding model names.

### `GET /healthz` (and `/health` alias)
Health report + per-backend probe status. Returns HTTP 200 even when engines
are offline (the report's `status` reflects reachability).

### Switchers (design §06) — REST over the registry
Two axes: host (`/host`) and inference fabric→provider→model
(`/fabric`, `/provider`, `/model`).

- `GET /switcher/state` — the resolved selection (global scope in VS1).
- `GET /{host|fabric|provider|model}` — list options with liveness.
- `POST /{host|fabric|provider|model}/{value}` — set an axis (validated).

> Connect alignment (`proto/rommie/v1/switchers.proto` `SwitcherService`) is
> **VS2**; VS1 ships the REST form over the local registry.

### `POST` / `GET /roles/model`
Pin / show the active model per role (distinct from the switcher model axis;
this is the salvaged v3 role-pin behaviour).

## Model registry

- `registry/models.yaml` — model definitions (validated against
  `registry/schema.json`). VS1 seeds the five local engines:
  `qwen3-8b` (:8001, general), `coder-32b-awq` (:8002, coding),
  `qwen2.5-7b-q4` (:8003, general), `conv-7b-1m` (:8004, conversation),
  `conv-14b-1m` (:8005, conversation) — all `provider: local`,
  `api_base http://127.0.0.1:<port>/v1`.
- `registry/active.yaml` — active model per role (unpinned out-of-box).
- `registry/routing.yaml` — task-class routing policy: class to ordered
  `(provider, model_id, params, budget)` candidates. Disabled cloud candidates
  remain visible as fallbacks but are skipped until enabled and `allow_cloud`
  is set.

Per-model env override: `GATEWAY_MODEL_<ID>_API_BASE` (ID upper-cased,
non-alnum → `_`).

## CLI

```bash
uv run gateway route standard-impl --json
uv run gateway route judgment/orchestration
```

The resolver records `route.resolve` entries in `AGENTS_CREDITS` when that
ledger path is configured. Chat requests may also send `task_class`; successful
requests then write per-provider and per-class token usage to the same ledger.

## Service packaging

The supported service package is the root `Dockerfile` plus
`docker-compose.yml`; legacy Docker assets under `legacy/` are preserved only as
history.

```bash
docker build -t agentos/llm-gateway:local .
docker compose up --build llm-gateway
```

The container listens on port `4000` and has a `/healthz` healthcheck. It starts
without live model engines; health may report `unhealthy` or `degraded` until
local backends are reachable, but the HTTP route remains available. For a
non-Docker package smoke:

```bash
uv run python scripts/packaging_smoke.py
```

## Deferred cloud OAuth dispatch

The registry includes disabled cloud stubs for `claude`, `codex`, `kimi`, and
`agy`. They carry `extra.oauth_provider`, `extra.auth_mode=oauth`, and
`extra.headers_pending_verification` as the follow-up contract. Enabling them is
blocked until the credential-gated provider proof verifies refresh endpoints,
request bodies, and provider-specific headers against live subscription OAuth.
AGY client metadata is intentionally not committed; set
`AGENTOS_AGY_CLIENT_ID` and `AGENTOS_AGY_CLIENT_SECRET` when exercising that
refresh path.

## Tests

Validation uses:

```bash
uv run ruff check agentos_gateway tests
uv run mypy agentos_gateway
uv run pytest -q
```

The pytest suite covers registry/router/health/fallback/switcher/app behavior;
no live engines are required (httpx is mocked; the app smoke test uses
TestClient). Optional live Postgres coverage remains gated by `GATEWAY_PG_DSN`
and is skipped by default.

