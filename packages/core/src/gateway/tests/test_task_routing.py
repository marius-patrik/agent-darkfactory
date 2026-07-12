from __future__ import annotations

import json

from llm_gateway.quota import QuotaTracker
from llm_gateway.registry import ModelRegistry
from llm_gateway.router import Router
from llm_gateway.task_routing import TaskRouter, TaskRoutingError
from llm_gateway.trace import TraceLogger


def test_resolves_first_available_candidate():
    registry = ModelRegistry()
    router = TaskRouter(registry)

    route = router.resolve("hard-impl")

    assert route.task_class == "hard-impl"
    assert route.provider == "local"
    assert route.model_id == "coder-32b-awq"
    assert route.params["model_reasoning_effort"] == "high"
    assert route.fallback_model_ids == []

def test_unknown_task_class_is_rejected():
    router = TaskRouter(ModelRegistry())

    try:
        router.resolve("not-a-class")
    except TaskRoutingError as exc:
        assert "Unknown task class" in str(exc)
    else:
        raise AssertionError("expected TaskRoutingError")


def test_chat_usage_records_task_class(monkeypatch, tmp_path):
    registry_path = tmp_path / "models.yaml"
    schema_path = tmp_path / "schema.json"
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
""",
        encoding="utf-8",
    )
    registry = ModelRegistry(registry_path=registry_path, schema_path=schema_path)
    tracer = TraceLogger(trace_dir=tmp_path / "traces")
    router = Router(registry, tracer, quota=QuotaTracker(now=lambda: 1.0))

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

    assert result["llm_gateway"]["task_class"] == "mechanical"
    assert router.quota.snapshot()["local"]["requests"] == 1


def run_async(coro):
    import asyncio

    return asyncio.run(coro)
