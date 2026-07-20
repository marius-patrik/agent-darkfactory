# Agents LLM Gateway

Single hub for all platform LLM traffic. OpenAI-format API, absolute routing,
config-driven model registry, per-role model selection, context-window fallback,
and retry/backoff.

This service is on the **`v3.0`** release line. The gateway listens on **`:4000`**, routes all platform LLM
traffic, and keeps **local-first** as the default; cloud use is opt-in and non-default.

## Quick start

```bash
cd gateway
uv pip install -e .
gateway serve
```

The gateway listens on `http://0.0.0.0:4000`.

## API

### `POST /v1/chat/completions`

OpenAI-compatible chat completions. The `model` field accepts either a model ID
or a role alias (`general`, `coding`, `judge`, `embedding`).

```bash
curl http://localhost:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "general",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

To allow cloud models, add `"allow_cloud": true` to the request body.

### `GET /v1/models`

List enabled models in OpenAI format.

### `GET /health`

Health and probe status.

### `POST /model`

Switch the active model for a role.

```bash
curl -X POST http://localhost:4000/model \
  -H "Content-Type: application/json" \
  -d '{"role": "coding", "model_id": "<model-id>"}'
```

### `GET /model`

Show active models and available models per role.

## How to add a model

1. Create a YAML file:

```yaml
id: my-model
name: My Local Model
provider: vllm
model: org/model-name
api_base: http://localhost:8000/v1
role: general
context_length: 32768
quant: fp16
gpu: "0"
tensor_parallel: 1
enabled: true
cloud: false
```

2. Add it:

```bash
gateway model-add my-model.yaml
```

3. Select it for a role:

```bash
gateway model-select general my-model
```

The registry chooses active models by role. Do not hardcode model names into callers.

## Model registry

- `registry/models.yaml` — model definitions (validated against `registry/schema.json`)
- `registry/active.yaml` — active model per role

## Run with Docker

```bash
docker compose up --build
```

## Tests

```bash
cd gateway
pytest -v
```

## Design

- **LiteLLM** handles remote-model calls.
- **HTTP forwarding** handles local backends (vLLM, llama.cpp) via their OpenAI-compatible endpoints.
- **Context enforcement** estimates token count before sending; falls back to a configured model if the limit is exceeded.
- **Retry/backoff** with jitter is applied per request.
- **Traces** are written to `traces/gateway-YYYY-MM-DD.jsonl`.

