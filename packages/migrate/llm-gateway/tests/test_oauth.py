"""Subscription OAuth: REAL cred formats, refresh, and never-metered dispatch config.

NOTE: the prior version of this file used fabricated ISO-string expiry formats
that did not match the real CLI credentials — so it passed green while the loader
was actually broken against live creds (claude/kimi store unix ints; codex carries
no ``expires_in``). These tests use the verified real formats.
"""

from __future__ import annotations

import base64
import json
import os
import stat
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from agentos_gateway import oauth as oauth_mod
from agentos_gateway.oauth import OAuthManager, OAuthError


def _jwt(exp_epoch: int) -> str:
    """A fake unsigned JWT whose payload carries an ``exp`` claim."""
    header = base64.urlsafe_b64encode(b'{"alg":"none"}').rstrip(b"=").decode()
    payload = base64.urlsafe_b64encode(json.dumps({"exp": exp_epoch}).encode()).rstrip(b"=").decode()
    return f"{header}.{payload}.sig"


def _future_dt(minutes: int = 60) -> datetime:
    return datetime.now(timezone.utc) + timedelta(minutes=minutes)


class _FakeResp:
    def __init__(self, status: int, payload: dict):
        self.status_code = status
        self._payload = payload

    def json(self):
        return self._payload


class _FakeClient:
    """Records the last request; returns canned per-method responses."""

    last: dict = {}
    post_response = _FakeResp(200, {})
    get_response = _FakeResp(200, {})

    def __init__(self, *a, **k):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def post(self, url, json=None, data=None, headers=None):
        _FakeClient.last = {"method": "POST", "url": url, "json": json, "data": data, "headers": headers}
        return _FakeClient.post_response

    def get(self, url, headers=None):
        _FakeClient.last = {"method": "GET", "url": url, "headers": headers}
        return _FakeClient.get_response


@pytest.fixture(autouse=True)
def _patch_httpx(monkeypatch):
    monkeypatch.setattr(oauth_mod.httpx, "Client", _FakeClient)
    _FakeClient.last = {}
    yield


# ---- real expiry formats (the 3 bug fixes) --------------------------------
def test_claude_expiry_is_unix_millis(tmp_path: Path):
    future_ms = int(_future_dt(60).timestamp() * 1000)  # REAL: millis int, not ISO
    creds = tmp_path / ".claude" / ".credentials.json"
    creds.parent.mkdir(parents=True)
    creds.write_text(json.dumps({"claudeAiOauth": {"accessToken": "a", "refreshToken": "r", "expiresAt": future_ms}}))
    t = OAuthManager(home=tmp_path).load_tokens("claude")
    assert t.access_token == "a"
    assert t.expires_at > _future_dt(30)  # parsed correctly, ~1h out


def test_kimi_expiry_is_unix_seconds(tmp_path: Path):
    future_s = int(_future_dt(60).timestamp())  # REAL: seconds int
    p = tmp_path / ".kimi-code" / "credentials"
    p.mkdir(parents=True)
    (p / "kimi-code.json").write_text(json.dumps({"access_token": "ka", "refresh_token": "kr", "expires_at": future_s}))
    t = OAuthManager(home=tmp_path).load_tokens("kimi")
    assert t.access_token == "ka"
    assert t.expires_at > _future_dt(30)


def test_codex_expiry_from_jwt_when_no_expires_in(tmp_path: Path):
    exp = int(_future_dt(60).timestamp())
    auth = tmp_path / ".codex" / "auth.json"
    auth.parent.mkdir(parents=True)
    # REAL codex auth.json has NO expires_in; expiry must come from the JWT.
    auth.write_text(json.dumps({
        "auth_mode": "chatgpt",
        "tokens": {"access_token": _jwt(exp), "refresh_token": "cr", "account_id": "acc"},
        "last_refresh": "2026-06-12T18:42:11.922499Z",
    }))
    t = OAuthManager(home=tmp_path).load_tokens("codex")
    assert t.expires_at > _future_dt(30)


def test_agy_expiry_is_unix_millis(tmp_path: Path):
    future_ms = int(_future_dt(60).timestamp() * 1000)
    p = tmp_path / ".gemini"
    p.mkdir(parents=True)
    (p / "oauth_creds.json").write_text(json.dumps({"access_token": "ga", "refresh_token": "gr", "expiry_date": future_ms}))
    t = OAuthManager(home=tmp_path).load_tokens("agy")
    assert t.access_token == "ga"
    assert t.expires_at > _future_dt(30)


# ---- refresh (verified endpoints, real bodies) ----------------------------
def test_refresh_claude_json_body_client_id_and_persist_0600(tmp_path: Path):
    past_ms = int((datetime.now(timezone.utc) - timedelta(hours=1)).timestamp() * 1000)
    creds = tmp_path / ".claude" / ".credentials.json"
    creds.parent.mkdir(parents=True)
    creds.write_text(json.dumps({"claudeAiOauth": {"accessToken": "old", "refreshToken": "oldr", "expiresAt": past_ms}}))
    _FakeClient.post_response = _FakeResp(200, {"access_token": "newA", "refresh_token": "newR", "expires_in": 3600})

    t = OAuthManager(home=tmp_path).refresh("claude")

    assert (t.access_token, t.refresh_token) == ("newA", "newR")
    call = _FakeClient.last
    assert call["url"] == "https://console.anthropic.com/v1/oauth/token"
    assert call["json"]["grant_type"] == "refresh_token"
    assert call["json"]["refresh_token"] == "oldr"
    assert call["json"]["client_id"] == "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
    secret = tmp_path / ".rommie" / "secrets" / "claude.json"
    assert secret.exists()
    if os.name != "nt":
        assert stat.S_IMODE(secret.stat().st_mode) == 0o600


def test_refresh_agy_form_with_client_secret_reuses_refresh_token(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    past_ms = int((datetime.now(timezone.utc) - timedelta(hours=1)).timestamp() * 1000)
    p = tmp_path / ".gemini"
    p.mkdir(parents=True)
    (p / "oauth_creds.json").write_text(json.dumps({"access_token": "ga", "refresh_token": "gr", "expiry_date": past_ms}))
    monkeypatch.setenv("AGENTOS_AGY_CLIENT_ID", "local-test-client-id")
    monkeypatch.setenv("AGENTOS_AGY_CLIENT_SECRET", "local-test-client-secret")
    # Google does NOT return a new refresh_token.
    _FakeClient.post_response = _FakeResp(200, {"access_token": "ga2", "expires_in": 3599})

    t = OAuthManager(home=tmp_path).refresh("agy")

    assert t.access_token == "ga2"
    assert t.refresh_token == "gr"  # reused, not lost
    call = _FakeClient.last
    assert call["url"] == "https://oauth2.googleapis.com/token"
    assert call["data"]["grant_type"] == "refresh_token"
    assert call["data"]["client_id"] == "local-test-client-id"
    assert call["data"]["client_secret"] == "local-test-client-secret"
    assert "x-www-form-urlencoded" in call["headers"]["Content-Type"]


def test_refresh_kimi_discovers_token_endpoint_and_uses_dynamic_client(tmp_path: Path):
    p = tmp_path / ".kimi-code" / "credentials"
    p.mkdir(parents=True)
    (p / "kimi-code.json").write_text(json.dumps({
        "access_token": "ka", "refresh_token": "kr", "expires_at": 0, "client_id": "dyn-client",
    }))
    _FakeClient.get_response = _FakeResp(200, {"token_endpoint": "https://auth.kimi.com/oauth/token"})
    _FakeClient.post_response = _FakeResp(200, {"access_token": "ka2", "refresh_token": "kr2", "expires_in": 900})

    t = OAuthManager(home=tmp_path).refresh("kimi")

    assert t.access_token == "ka2"
    assert _FakeClient.last["url"] == "https://auth.kimi.com/oauth/token"
    assert _FakeClient.last["json"]["client_id"] == "dyn-client"


def test_refresh_failure_never_leaks_response_body(tmp_path: Path):
    creds = tmp_path / ".claude" / ".credentials.json"
    creds.parent.mkdir(parents=True)
    creds.write_text(json.dumps({"claudeAiOauth": {"accessToken": "o", "refreshToken": "SECRET-RT", "expiresAt": 0}}))
    _FakeClient.post_response = _FakeResp(401, {"error": "echoes SECRET-RT here"})

    with pytest.raises(OAuthError) as ei:
        OAuthManager(home=tmp_path).refresh("claude")

    msg = str(ei.value)
    assert "SECRET-RT" not in msg  # body never echoed
    assert "401" in msg


def test_get_token_refreshes_when_near_expiry(tmp_path: Path):
    near_ms = int(_future_dt(1).timestamp() * 1000)  # 1 min out => inside the 5-min window
    creds = tmp_path / ".claude" / ".credentials.json"
    creds.parent.mkdir(parents=True)
    creds.write_text(json.dumps({"claudeAiOauth": {"accessToken": "old", "refreshToken": "r", "expiresAt": near_ms}}))
    _FakeClient.post_response = _FakeResp(200, {"access_token": "fresh", "refresh_token": "r2", "expires_in": 3600})

    assert OAuthManager(home=tmp_path).get_token("claude") == "fresh"


# ---- dispatch config (litellm-native vs custom adapter) -------------------
def test_dispatch_config_kimi_is_litellm_native(tmp_path: Path):
    cfg = OAuthManager(home=tmp_path).dispatch_config("kimi")
    assert cfg.litellm_native is True
    assert cfg.api_base == "https://api.kimi.com/coding/v1"


def test_dispatch_config_claude_not_native_and_builds_beta_header(tmp_path: Path):
    m = OAuthManager(home=tmp_path)
    assert m.dispatch_config("claude").litellm_native is False
    headers = m.build_headers("claude", "TKN")
    assert headers["Authorization"] == "Bearer TKN"
    assert headers["anthropic-beta"] == "oauth-2025-04-20"


def test_prefers_gateway_refreshed_secrets_copy(tmp_path: Path):
    # When ~/.rommie/secrets/<p>.json exists, it wins over the source cred file.
    secrets = tmp_path / ".rommie" / "secrets"
    secrets.mkdir(parents=True)
    (secrets / "claude.json").write_text(json.dumps({
        "provider": "claude", "access_token": "from-secrets", "refresh_token": "r",
        "expires_at": _future_dt(60).isoformat(),
    }))
    # A stale source file that must be ignored.
    creds = tmp_path / ".claude" / ".credentials.json"
    creds.parent.mkdir(parents=True)
    creds.write_text(json.dumps({"claudeAiOauth": {"accessToken": "STALE", "refreshToken": "r", "expiresAt": 0}}))
    assert OAuthManager(home=tmp_path).load_tokens("claude").access_token == "from-secrets"


def test_prefers_agents_managed_cli_credentials(monkeypatch, tmp_path: Path):
    future_ms = int(_future_dt(60).timestamp() * 1000)
    legacy = tmp_path / ".claude" / ".credentials.json"
    legacy.parent.mkdir(parents=True)
    legacy.write_text(json.dumps({"claudeAiOauth": {"accessToken": "legacy", "refreshToken": "r", "expiresAt": future_ms}}))

    agents_clis = tmp_path / ".agents" / "clis"
    managed = agents_clis / "claude" / ".credentials.json"
    managed.parent.mkdir(parents=True)
    managed.write_text(json.dumps({"claudeAiOauth": {"accessToken": "managed", "refreshToken": "r", "expiresAt": future_ms}}))
    monkeypatch.setenv("AGENTS_CLIS", str(agents_clis))

    assert OAuthManager(home=tmp_path).load_tokens("claude").access_token == "managed"
