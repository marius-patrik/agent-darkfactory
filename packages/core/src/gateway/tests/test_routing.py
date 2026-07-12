"""Tests for request routing and context-window enforcement."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import httpx
import pytest

from llm_gateway.registry import ModelRegistry
from llm_gateway.router import Router, RoutingError
from llm_gateway.trace import TraceLogger


@pytest.fixture
def router_fixture():
    with tempfile.TemporaryDirectory() as td:
        reg_path = Path(td) / "models.yaml"
        schema_path = Path(td) / "schema.json"
        schema_path.write_text(json.dumps({
            "type": "object",
            "properties": {
                "schema_version": {"type": "string"},
                "models": {"type": "object"},
            },
        }))
        reg_path.write_text(json.dumps({
            "schema_version": "gateway-registry-v1",
            "models": {
                "small": {
                    "id": "small",
                    "provider": "local",
                    "model": "small",
                    "api_base": "http://s001:9999/v1",
                    "role": "general",
                    "context_length": 100,
                    "enabled": True,
                },
                "large": {
                    "id": "large",
                    "provider": "local",
                    "model": "large",
                    "api_base": "http://localhost:9998/v1",
                    "role": "general",
                    "context_length": 10000,
                    "enabled": True,
                },
                "same-context-peer": {
                    "id": "same-context-peer",
                    "provider": "local",
                    "model": "same-context-peer",
                    "api_base": "http://localhost:9993/v1",
                    "role": "general",
                    "context_length": 100,
                    "enabled": True,
                },
                "coder-a": {
                    "id": "coder-a",
                    "provider": "local",
                    "api_base": "http://localhost:9996/v1",
                    "model": "test-model",
                    "role": "coding",
                    "context_length": 1000,
                    "enabled": True,
                },
                "coder-b": {
                    "id": "coder-b",
                    "provider": "local",
                    "api_base": "http://localhost:9994/v1",
                    "model": "test-model",
                    "role": "coding",
                    "context_length": 1000,
                    "enabled": True,
                },
            },
        }))
        reg = ModelRegistry(registry_path=reg_path, schema_path=schema_path)
        tracer = TraceLogger(trace_dir=Path(td) / "traces")
        router = Router(reg, tracer)
        yield router, reg
        tracer.close()


class TestResolveModel:
    def test_resolve_by_id(self, router_fixture):
        router, _ = router_fixture
        entry = router.resolve_model("small")
        assert entry.id == "small"

    def test_resolve_role_alias(self, router_fixture):
        router, _ = router_fixture
        entry = router.resolve_model("general")
        assert entry.id == "small"

    def test_role_alias_uses_registry_declaration_order(self, router_fixture):
        router, _ = router_fixture
        assert router.resolve_model("coding").id == "coder-a"
        assert router.resolve_model("coding").id == "coder-a"

    def test_resolve_missing_raises(self, router_fixture):
        router, _ = router_fixture
        with pytest.raises(RoutingError):
            router.resolve_model("nonexistent")

    def test_embedding_is_not_a_public_role_alias(self, router_fixture):
        """The gateway hides the embedding role until a supported model exists."""
        router, _ = router_fixture
        with pytest.raises(RoutingError) as exc_info:
            router.resolve_model("embedding")
        assert str(exc_info.value) == "Model 'embedding' not found in registry"


class TestContextCheck:
    def test_within_limit(self, router_fixture):
        router, _ = router_fixture
        entry = router.check_context(router.registry.get("small"), 50)
        assert entry.id == "small"

    def test_exceeds_selected_model_raises(self, router_fixture):
        router, _ = router_fixture
        with pytest.raises(RoutingError):
            router.check_context(router.registry.get("small"), 500)

    def test_exceeds_largest_model_raises(self, router_fixture):
        router, _ = router_fixture
        with pytest.raises(RoutingError):
            router.check_context(router.registry.get("large"), 20000)


class TestEstimateTokens:
    def test_empty(self, router_fixture):
        router, _ = router_fixture
        assert router.estimate_tokens([]) >= 0

    def test_basic_messages(self, router_fixture):
        router, _ = router_fixture
        msgs = [{"role": "user", "content": "hello world"}]
        est = router.estimate_tokens(msgs)
        assert est > 0

    def test_max_tokens_added(self, router_fixture):
        router, _ = router_fixture
        msgs = [{"role": "user", "content": "hi"}]
        est_without = router.estimate_tokens(msgs)
        est_with = router.estimate_tokens(msgs, max_tokens=100)
        assert est_with == est_without + 100


class TestGatewayMetadata:
    async def test_non_streaming_response_and_trace_include_gateway_metadata(self, router_fixture):
        router, _ = router_fixture
        ok_resp = httpx.Response(200, json={
            "id": "chatcmpl-test",
            "object": "chat.completion",
            "created": 1,
            "model": "backend-small",
            "choices": [{"message": {"role": "assistant", "content": "ok"}}],
        })
        router._http = MockAsyncClient([ok_resp])  # type: ignore[assignment]

        result = await router.chat_completion(
            model_id="small",
            messages=[{"role": "user", "content": "hi"}],
        )

        metadata = result["llm_gateway"]
        assert metadata["requested_model"] == "small"
        assert metadata["requested_role"] is None
        assert metadata["resolved_model_id"] == "small"
        assert metadata["role"] == "general"
        assert metadata["backend_api_base"] == "http://s001:9999/v1"
        assert metadata["backend_node_id"] == "s001"
        assert metadata["served_model"] == "backend-small"
        assert metadata["response_status"] == "success"
        assert metadata["http_status"] == 200
        assert metadata["request_id"] == metadata["trace_id"]
        assert metadata["timestamp"]
        assert metadata["duration_ms"] >= 0

        trace_files = list(router.tracer.trace_dir.glob("gateway-*.jsonl"))
        events = [
            json.loads(line)
            for trace_file in trace_files
            for line in trace_file.read_text().splitlines()
        ]
        success = next(event for event in events if event["event_type"] == "request.success")
        assert success["request_id"] == metadata["request_id"]
        assert success["trace_id"] == metadata["trace_id"]
        assert success["requested_model"] == "small"
        assert success["resolved_model_id"] == "small"
        assert success["backend_node_id"] == "s001"
        assert success["served_model"] == "backend-small"
        assert success["response_status"] == "success"
        assert success["http_status"] == 200


class TestReasoningNormalization:
    def test_strips_think_blocks_from_non_streaming_content(self, router_fixture):
        router, _ = router_fixture
        result = router._normalize_response({
            "choices": [
                {
                    "message": {
                        "role": "assistant",
                        "content": "<think>private chain</think>\n{\"ok\": true}",
                    }
                }
            ]
        })
        assert result["choices"][0]["message"]["content"] == '{"ok": true}'

    def test_preserves_tool_calls_while_stripping_content(self, router_fixture):
        router, _ = router_fixture
        result = router._normalize_response({
            "choices": [
                {
                    "message": {
                        "role": "assistant",
                        "content": "<think>choose tool</think>",
                        "tool_calls": [{"id": "call_1", "function": {"name": "read_file", "arguments": "{}"}}],
                    }
                }
            ]
        })
        message = result["choices"][0]["message"]
        assert message["content"] == ""
        assert message["tool_calls"][0]["id"] == "call_1"

    def test_strips_unclosed_think_block_from_non_streaming_content(self, router_fixture):
        router, _ = router_fixture
        result = router._normalize_response({
            "choices": [{"message": {"role": "assistant", "content": "visible\n<think>unfinished"}}]
        })
        assert result["choices"][0]["message"]["content"] == "visible"

    def test_strips_split_streaming_think_blocks(self, router_fixture):
        router, _ = router_fixture
        state = False
        chunk1, state = router._normalize_chunk({"choices": [{"delta": {"content": "<think>private"}}]}, state)
        chunk2, state = router._normalize_chunk({"choices": [{"delta": {"content": " reasoning</think>visible"}}]}, state)
        chunk3, state = router._normalize_chunk({"choices": [{"delta": {"content": " text"}}]}, state)

        assert chunk1["choices"][0]["delta"]["content"] == ""
        assert chunk2["choices"][0]["delta"]["content"] == "visible"
        assert chunk3["choices"][0]["delta"]["content"] == " text"
        assert state is False


class MockAsyncClient:
    """Mock httpx.AsyncClient for local HTTP routing tests."""

    def __init__(self, responses: list[httpx.Response]) -> None:
        self.responses = responses
        self.call_index = 0
        self.calls: list[dict] = []

    def _attach_request(self, resp: httpx.Response, url: str, method: str = "POST") -> httpx.Response:
        resp.request = httpx.Request(method, url)
        return resp

    async def post(self, url: str, **kwargs) -> httpx.Response:
        self.calls.append({"method": "post", "url": url, **kwargs})
        resp = self._attach_request(self.responses[self.call_index], url)
        self.call_index += 1
        if resp.status_code >= 400:
            raise httpx.HTTPStatusError(
                "error",
                request=resp.request,
                response=resp,
            )
        return resp

    async def aclose(self) -> None:
        pass

    async def stream(self, method: str, url: str, **kwargs):
        resp = self._attach_request(self.responses[self.call_index], url, method)
        self.call_index += 1
        class _Ctx:
            async def __aenter__(_self):
                if resp.status_code >= 400:
                    raise httpx.HTTPStatusError(
                        "error",
                        request=resp.request,
                        response=resp,
                    )
                return resp
            async def __aexit__(_self, *args):
                pass
        return _Ctx()
