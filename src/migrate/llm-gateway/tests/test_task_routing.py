from __future__ import annotations

import json

from agentos_gateway.quota import QuotaTracker
from agentos_gateway.registry import ActiveRoleManager, ModelRegistry
from agentos_gateway.router import Router
from agentos_gateway.task_routing import TaskRouter, TaskRoutingError
from agentos_gateway.trace import TraceLogger


def test_resolves_first_available_candidate(monkeypatch, tmp_path):
    credits = tmp_path / "credits.json"
    monkeypatch.setenv("AGENTS_CREDITS", str(credits))

    registry = ModelRegistry()
    router = TaskRouter(registry)

    route = router.resolve("hard-impl")

    assert route.task_class == "hard-impl"
    assert route.provider == "local"
    assert route.model_id == "coder-32b-awq"
    assert route.params["model_reasoning_effort"] == "high"
    assert route.fallback_model_ids == ["codex-subscription"]

    store = json.loads(credits.read_text(encoding="utf-8"))
    ledger = store["ledger"][0]
    assert ledger["action"] == "route.resolve"
    assert ledger["consumer"] == "agentos.gateway"
    assert ledger["taskClass"] == "hard-impl"
    assert ledger["modelId"] == "coder-32b-awq"
    assert store["providers"]["local"]["classes"]["hard-impl"]["resolutions"] == 1


def test_unknown_task_class_is_rejected():
    router = TaskRouter(ModelRegistry())

    try:
        router.resolve("not-a-class")
    except TaskRoutingError as exc:
        assert "Unknown task class" in str(exc)
    else:
        raise AssertionError("expected TaskRoutingError")


def test_chat_usage_records_task_class(monkeypatch, tmp_path):
    credits = tmp_path / "credits.json"
    monkeypatch.setenv("AGENTS_CREDITS", str(credits))

    registry_path = tmp_path / "models.yaml"
    schema_path = tmp_path / "schema.json"
    active_path = tmp_path / "active.yaml"
    schema_path.write_text(json.dumps({"type": "object", "properties": {"models": {"type": "object"}}}), encoding="utf-8")
    registry_path.write_text(
        """
schema_version: gateway-registry-v1
models:
  local-small:
    id: local-small
    provider: local
    model: backend-small
    api_base: http://unused.invalid/v1
    role: general
    context_length: 1000
    enabled: true
    cloud: false
""",
        encoding="utf-8",
    )
    registry = ModelRegistry(registry_path=registry_path, schema_path=schema_path)
    active = ActiveRoleManager(active_path=active_path)
    tracer = TraceLogger(trace_dir=tmp_path / "traces")
    router = Router(registry, active, tracer, quota=QuotaTracker(now=lambda: 1.0))

    async def fake_via_http(**kwargs):
        return {
            "choices": [{"message": {"content": "ok"}}],
            "usage": {"completion_tokens": 3},
        }

    monkeypatch.setattr(router, "_via_http", fake_via_http)
    try:
        result = run_async(
            router.chat_completion(
                model_id="local-small",
                messages=[{"role": "user", "content": "hello"}],
                task_class="mechanical",
            )
        )
    finally:
        tracer.close()

    assert result["agentos_gateway"]["task_class"] == "mechanical"
    store = json.loads(credits.read_text(encoding="utf-8"))
    ledger = store["ledger"][0]
    assert ledger["action"] == "usage"
    assert ledger["taskClass"] == "mechanical"
    assert ledger["modelId"] == "local-small"
    assert store["providers"]["local"]["classes"]["mechanical"]["requests"] == 1


def run_async(coro):
    import asyncio

    return asyncio.run(coro)
