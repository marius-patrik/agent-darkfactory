# Gateway (llm-gateway) — VS1-minimal salvage + VS2 backlog

The gateway is the **one literal salvage** from v3 (Master Plan §13): the v3
Python `legacy/src-packages-gateway` (FastAPI + httpx + litellm, ~1650 LOC, has tests)
is **copied + adapted** into `llm-gateway` as `agentos_gateway`. The v3
source is preserved under `legacy/src-packages-gateway`.

See also: `.plans/design/01-gateway.md` (the gateway contract) and
`.plans/design/06-switchers.md` (the two-axis switcher contract).

## What VS1 delivers (this slice)

1. **Re-namespace** the v3 `agents` package namespace →
   `agentos_gateway` (package, imports, response-metadata key `agentos_gateway`,
   request-id prefix `rommie-req-`, env prefix `ROMMIE_*`).
2. **LOCAL engines only.** Generic-HTTP backend routing to OpenAI-compatible
   `api_base`s (`provider: local`). No cloud entry is enabled; `allow_cloud`
   defaults to `false`. The **never-meter guard** in `router.resolve_model`
   (reject cloud models unless the request opts in) **stays enforced** — this
   is the exact guardrail that prevents the prior metered-API outage (§9). The
   `litellm-remote` / `nvcf` code paths and the `litellm` import remain, but no
   cloud path is reachable through the seeded registry.
3. **Registry seeded with the five VS1 models** (`registry/models.yaml`):
   `qwen3-8b` (:8001, general), `coder-32b-awq` (:8002, coding),
   `qwen2.5-7b-q4` (:8003, general), `conv-7b-1m` (:8004, conversation),
   `conv-14b-1m` (:8005, conversation). All `provider: local`,
   `api_base http://127.0.0.1:<port>/v1`. Role aliases:
   `general` / `coding` / `conversation`.
4. **Switcher endpoints** `/host` `/fabric` `/provider` `/model` — REST over the
   registry. `GET` lists options (with liveness), `POST /{axis}/{value}` sets an
   axis, `GET /switcher/state` resolves the selection (global scope only in VS1).
5. **Task-class route resolution** (`registry/routing.yaml`, `POST /route`,
   `GET /route/{task_class}`, and `gateway route <class>`): DarkFactory workers,
   harnesses, and agents-manager resolve `mechanical`, `standard-impl`,
   `hard-impl`, `review`, and `judgment/orchestration` to ordered configured
   provider/model/params candidates instead of hard-coding model names. Route
   resolution and request usage can write per-class entries to `AGENTS_CREDITS`.
6. **Tests adapted + extended** (pytest, no live engines — httpx mocked, app via
   TestClient): registry / router / health / fallback / switcher / app.
7. **Current service packaging** at the repo root: `Dockerfile`,
   `docker-compose.yml`, and `scripts/packaging_smoke.py`. The container exposes
   port 4000 and checks `/healthz`; it can start before live engines are up.
8. **`pyproject.toml`** (uv, py>=3.12) so
   `cd llm-gateway && uv sync && uv run pytest` is green.

## Connect alignment is VS2

The canonical switcher contract is the Connect/protobuf `SwitcherService`
(`proto/rommie/v1/switchers.proto`: `GetSwitcherState`, `SetSwitcher`,
`ListSwitcherOptions`). **VS1 ships a REST form over the local registry**; VS2
aligns these REST endpoints to that protobuf service and the cluster-synced
state. The REST shapes here intentionally mirror the proto messages
(`SwitcherOption{value,label,available,unavailable_reason}`, axis = host /
fabric / provider / model) so the VS2 swap is mechanical.

## Deliberately left for VS2 (the rest of the §13 adaptation list)

- **Cloud fabric + subscription OAuth** (§01 G3, §13 "central gateway design
  problem"): claude/kimi/codex/agy as cloud providers via litellm + subscription
  OAuth tokens (refresh-token flow owned by the gateway), **never metered keys**.
  Cloud registry entries stay absent/disabled until each provider verifies.
- **Cluster-synced registry** (§01 G4, §13 #3): today `registry.save()` writes a
  local file; VS2 makes the registry the statesync `config`/`model-routing`
  class over NATS, replacing the local-file `save()`.
- **The `inferctl` seam** (§13 #4): inferctl (Go, in `inference-engine/services/inferctl`) brings
  local engine endpoints UP and writes the live `api_base` into the registry;
  VS1 hard-codes the loopback `api_base`s for the five engines.
- **The embedding model** (§13 #5): the `embedding` role exists but no model is
  registered yet (VS1 ships general/coding/conversation only).
- **Connect control plane + WS sessions** (§01 G2): the gateway's Connect RPCs
  (`ListModels/Providers/Hosts`, `CreateSession`, …) and the duplex WebSocket
  session frames are VS2+; VS1 is the OpenAI-format HTTP edge + the REST
  switcher surface.
- **Session relay + multi-client attach, mTLS edge, usage/budget degrade-to-local
  (§01 G6)** — all VS2+.
- **Cluster/host axes actually reachable**: VS1 advertises the full host set
  (`client|gateway|s001|s002|desktop|mac`) and the three fabrics
  (`cluster|local|cloud`) but only `host=gateway` / `fabric=local` are
  `available`. The cluster nodes light up when the active-active cluster lands
  (VS2+).

