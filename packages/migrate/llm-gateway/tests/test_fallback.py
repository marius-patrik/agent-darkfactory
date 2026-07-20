"""Tests for retry, backoff, and context-window fallback orchestration."""

from __future__ import annotations

import pytest

from agentos_gateway.fallback import with_retry, is_context_window_error, chat_with_fallback, FallbackError


class TestWithRetry:
    async def test_success_no_retry(self):
        calls = 0
        async def fn():
            nonlocal calls
            calls += 1
            return "ok"
        result = await with_retry(fn, max_retries=2, base_delay=0.01)
        assert result == "ok"
        assert calls == 1

    async def test_retry_then_success(self):
        calls = 0
        async def fn():
            nonlocal calls
            calls += 1
            if calls < 3:
                raise RuntimeError("transient")
            return "ok"
        result = await with_retry(fn, max_retries=3, base_delay=0.01)
        assert result == "ok"
        assert calls == 3

    async def test_exhausted_raises(self):
        async def fn():
            raise RuntimeError("always fails")
        with pytest.raises(FallbackError):
            await with_retry(fn, max_retries=1, base_delay=0.01)


class TestIsContextWindowError:
    def test_detects(self):
        assert is_context_window_error(Exception("context length exceeded"))
        assert is_context_window_error(Exception("maximum context length"))
        assert is_context_window_error(Exception("too many tokens"))

    def test_rejects(self):
        assert not is_context_window_error(Exception("network timeout"))
        assert not is_context_window_error(Exception("unauthorized"))


class TestChatWithFallback:
    async def test_primary_succeeds(self):
        calls = []
        async def router_call(model_id: str):
            calls.append(model_id)
            return {"model": model_id}

        result = await chat_with_fallback(router_call, "primary", "fallback", max_retries=0)
        assert result["model"] == "primary"
        assert calls == ["primary"]

    async def test_fallback_on_context_error(self):
        calls = []
        async def router_call(model_id: str):
            calls.append(model_id)
            if model_id == "primary":
                raise Exception("context length exceeded")
            return {"model": model_id}

        result = await chat_with_fallback(router_call, "primary", "fallback", max_retries=0)
        assert result["model"] == "fallback"
        assert calls == ["primary", "fallback"]

    async def test_no_fallback_on_other_error(self):
        calls = []
        async def router_call(model_id: str):
            calls.append(model_id)
            raise Exception("network timeout")

        with pytest.raises(FallbackError):
            await chat_with_fallback(router_call, "primary", "fallback", max_retries=0)
        assert calls == ["primary"]

    async def test_no_fallback_configured(self):
        calls = []
        async def router_call(model_id: str):
            calls.append(model_id)
            raise Exception("context length exceeded")

        with pytest.raises(FallbackError):
            await chat_with_fallback(router_call, "primary", None, max_retries=0)
        assert calls == ["primary"]
