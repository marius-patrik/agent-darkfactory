"""Subscription cloud dispatch (#1288): a subscription entry authenticates with
its OAuth token (a stray metered key on the same entry is NOT used — the user's
default is subs); non-litellm-native providers fail closed (custom adapter not
built yet). Also asserts our tool definitions pass through to the backend (the
path-1 'our tool-calling through our harness' plumbing). Metered-key entries are
supported separately via the normal key path."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest

from agentos_gateway import router as router_mod
from agentos_gateway.oauth import DispatchConfig
from agentos_gateway.registry import ModelRegistry, ActiveRoleManager
from agentos_gateway.router import Router, RoutingError
from agentos_gateway.trace import TraceLogger


class _FakeOAuth:
    def __init__(self, *, native: bool, token: str = "OAUTH-TOKEN"):
        self._native = native
        self._token = token
        self.get_token_calls: list[str] = []

    def dispatch_config(self, provider: str) -> DispatchConfig:
        return DispatchConfig(
            provider=provider,
            api_base="https://api.kimi.com/coding/v1",
            model="openai/kimi-for-coding",
            litellm_native=self._native,
            header_template={"Authorization": "Bearer {token}"},
        )

    def get_token(self, provider: str) -> str:
        self.get_token_calls.append(provider)
        return self._token


def _make_router(oauth, tmp: str):
    reg_path = Path(tmp) / "models.yaml"
    schema_path = Path(tmp) / "schema.json"
    active_path = Path(tmp) / "active.yaml"
    schema_path.write_text(json.dumps({"type": "object", "properties": {"models": {"type": "object"}}}))
    reg_path.write_text(json.dumps({
        "schema_version": "gateway-registry-v1",
        "models": {
            "kimi-cloud": {
                "id": "kimi-cloud",
                "provider": "litellm-remote",
                "model": "openai/kimi-for-coding",
                "api_base": "https://api.kimi.com/coding/v1",
                # A metered key is DELIBERATELY present to prove it is never used.
                "api_key": "METERED-SHOULD-NEVER-BE-USED",
                "role": "general",
                "context_length": 200000,
                "fallback_model": "local-fb",
                "enabled": True,
                "cloud": True,
                "extra": {"oauth_provider": "kimi"},
            },
            "claude-cloud": {
                "id": "claude-cloud",
                "provider": "litellm-remote",
                "model": "anthropic/claude-sonnet-4-5",
                "api_base": "https://api.anthropic.com",
                "role": "general",
                "context_length": 200000,
                "fallback_model": "local-fb",
                "enabled": True,
                "cloud": True,
                "extra": {"oauth_provider": "claude"},
            },
            "kimi-misconfigured": {
                # oauth_provider set but provider is NOT litellm-remote (operator
                # footgun) — must fail closed, never reach a metered path.
                "id": "kimi-misconfigured",
                "provider": "nvcf",
                "model": "x",
                "api_base": "http://localhost:9992/v1",
                "role": "general",
                "context_length": 200000,
                "fallback_model": "local-fb",
                "enabled": True,
                "cloud": True,
                "extra": {"oauth_provider": "kimi"},
            },
            "local-fb": {
                "id": "local-fb",
                "provider": "local",
                "api_base": "http://localhost:9999/v1",
                "role": "general",
                "context_length": 200000,
                "enabled": True,
                "cloud": False,
            },
        },
    }))
    reg = ModelRegistry(registry_path=reg_path, schema_path=schema_path)
    active = ActiveRoleManager(active_path=active_path)
    tracer = TraceLogger(trace_dir=Path(tmp) / "traces")
    return Router(reg, active, tracer, oauth=oauth), tracer


@pytest.mark.asyncio
async def test_kimi_uses_oauth_token_never_metered_key_and_passes_tools(monkeypatch):
    captured = {}

    async def fake_acompletion(**kwargs):
        captured.update(kwargs)
        return {"choices": [{"message": {"content": "ok"}}], "usage": {"completion_tokens": 1}}

    monkeypatch.setattr(router_mod, "acompletion", fake_acompletion)

    tools = [{"type": "function", "function": {"name": "read_file", "parameters": {}}}]
    with tempfile.TemporaryDirectory() as td:
        router, tracer = _make_router(_FakeOAuth(native=True), td)
        try:
            await router.chat_completion(
                model_id="kimi-cloud",
                messages=[{"role": "user", "content": "hi"}],
                tools=tools,
                allow_cloud=True,
            )
        finally:
            tracer.close()
            await router.close()

    # NEVER-METER: the OAuth token is the auth; the metered key is never sent.
    assert captured["api_key"] == "OAUTH-TOKEN"
    assert captured["api_key"] != "METERED-SHOULD-NEVER-BE-USED"
    # path-1 plumbing: our tool definitions reach the backend unchanged.
    assert captured["tools"] == tools


@pytest.mark.asyncio
async def test_non_native_provider_fails_closed(monkeypatch):
    async def fake_acompletion(**kwargs):  # pragma: no cover - must never be called
        raise AssertionError("acompletion must not be reached for a non-native provider")

    monkeypatch.setattr(router_mod, "acompletion", fake_acompletion)

    with tempfile.TemporaryDirectory() as td:
        router, tracer = _make_router(_FakeOAuth(native=False), td)
        try:
            with pytest.raises(RoutingError, match="custom dispatch adapter"):
                await router.chat_completion(
                    model_id="claude-cloud",
                    messages=[{"role": "user", "content": "hi"}],
                    allow_cloud=True,
                )
        finally:
            tracer.close()
            await router.close()


@pytest.mark.asyncio
async def test_oauth_entry_on_non_litellm_provider_fails_closed(monkeypatch):
    # Defense-in-depth: a subscription entry mis-set to provider=nvcf must fail
    # closed BEFORE any dispatch, never falling through to a metered key path.
    async def fake_acompletion(**kwargs):  # pragma: no cover
        raise AssertionError("must not dispatch a misconfigured oauth entry")

    monkeypatch.setattr(router_mod, "acompletion", fake_acompletion)
    with tempfile.TemporaryDirectory() as td:
        router, tracer = _make_router(_FakeOAuth(native=True), td)
        try:
            with pytest.raises(RoutingError, match="Refusing to dispatch"):
                await router.chat_completion(
                    model_id="kimi-misconfigured",
                    messages=[{"role": "user", "content": "hi"}],
                    allow_cloud=True,
                )
        finally:
            tracer.close()
            await router.close()


@pytest.mark.asyncio
async def test_oauth_entry_without_manager_fails_closed(monkeypatch):
    async def fake_acompletion(**kwargs):  # pragma: no cover
        raise AssertionError("must not dispatch without an oauth manager")

    monkeypatch.setattr(router_mod, "acompletion", fake_acompletion)

    with tempfile.TemporaryDirectory() as td:
        router, tracer = _make_router(None, td)  # no OAuthManager
        try:
            with pytest.raises(RoutingError, match="no OAuthManager"):
                await router.chat_completion(
                    model_id="kimi-cloud",
                    messages=[{"role": "user", "content": "hi"}],
                    allow_cloud=True,
                )
        finally:
            tracer.close()
            await router.close()
