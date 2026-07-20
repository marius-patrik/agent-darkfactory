"""Subscription OAuth: token load, refresh, and never-metered dispatch config.

Verified provider params (extracted from the live CLI binaries, 2026-06-14 — these
are NOT publicly documented; they were read out of the shipped CLIs so the gateway
can reuse the user's existing subscription. Subs are the default/focus (the user
never pays metered); metered API keys are also supported via the normal key path):

  claude  token   https://console.anthropic.com/v1/oauth/token   client 9d1c250a-e61b-44d9-88ed-5944d1962f5e   (JSON body)
          infer   https://api.anthropic.com/v1/messages          header  anthropic-beta: oauth-2025-04-20        (custom adapter — Messages API)
  codex   token   https://auth.openai.com/oauth/token            client app_EMoamEEZ73f0CkXaXp7hrann          (form body)
          infer   https://chatgpt.com/backend-api/codex          (custom adapter — Responses API)
  kimi    token   https://auth.kimi.com/<discovered>             (RFC 8414 .well-known discovery)
          infer   https://api.kimi.com/coding/v1                 (OpenAI-compatible — litellm-native)
  agy     token   https://oauth2.googleapis.com/token            client 1071006060591-...apps.googleusercontent.com (form + client_secret)
          infer   https://cloudcode-pa.googleapis.com            (custom adapter — Code Assist)

NEVER log token values. Refreshed tokens persist to ~/.rommie/secrets/<provider>.json (0600).
"""

from __future__ import annotations

import base64
import json
import os
import tempfile
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx


@dataclass
class ProviderTokens:
    # Secret fields are repr=False so a future caller that logs/exceptions a
    # ProviderTokens instance can never leak the token values (defense-in-depth;
    # the persistence-boundary redactor is the other layer).
    access_token: str = field(repr=False)
    refresh_token: str = field(repr=False)
    expires_at: datetime
    provider: str


@dataclass(frozen=True)
class DispatchConfig:
    """How the router reaches a provider's never-metered (subscription) endpoint."""

    provider: str
    api_base: str
    # litellm `model` string. For litellm_native providers the router sends the
    # OAuth access token as the Bearer api_key (OpenAI-compatible). For non-native
    # providers a custom adapter (claude/codex/agy) owns the request shape.
    model: str
    litellm_native: bool
    # Extra headers required on every inference call (built per-request with the
    # live access token; placeholder "{token}" is substituted by build_headers()).
    header_template: dict[str, str]


# Verified, non-secret OAuth/dispatch constants (read from the shipped CLIs).
# Client metadata that looks like an app credential is loaded from environment or
# CLI credential metadata instead of being committed to the public repo.
_PROVIDER_OAUTH: dict[str, dict[str, Any]] = {
    "claude": {
        "token_url": "https://console.anthropic.com/v1/oauth/token",
        "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
        "client_secret": None,
        "body_style": "json",
        "scope": None,
        "infer_base": "https://api.anthropic.com",
        "infer_model": "claude-sonnet-4-5",
        "litellm_native": False,  # Anthropic Messages API + OAuth Bearer (not x-api-key)
        "header_template": {
            "Authorization": "Bearer {token}",
            "anthropic-beta": "oauth-2025-04-20",
        },
    },
    "codex": {
        "token_url": "https://auth.openai.com/oauth/token",
        "client_id": "app_EMoamEEZ73f0CkXaXp7hrann",
        "client_secret": None,
        "body_style": "form",
        "scope": "openid profile email offline_access",
        "infer_base": "https://chatgpt.com/backend-api/codex",
        "infer_model": "gpt-5-codex",
        "litellm_native": False,  # ChatGPT-backend Responses API — custom adapter
        "header_template": {"Authorization": "Bearer {token}"},
    },
    "kimi": {
        # token_url is resolved at refresh time via RFC 8414 discovery against
        # the auth server (the CLI registers a client dynamically).
        "token_url": None,
        "auth_server": "https://auth.kimi.com",
        "client_id": None,  # dynamic client registration; filled from cred file if present
        "client_secret": None,
        "body_style": "json",
        "scope": "kimi-code",
        "infer_base": "https://api.kimi.com/coding/v1",
        "infer_model": "kimi-for-coding",
        "litellm_native": True,  # OpenAI-compatible — Bearer token == api_key
        "header_template": {"Authorization": "Bearer {token}"},
    },
    "agy": {
        "token_url": "https://oauth2.googleapis.com/token",
        "client_id": None,
        "client_secret": None,
        "client_id_env": "AGENTOS_AGY_CLIENT_ID",
        "client_secret_env": "AGENTOS_AGY_CLIENT_SECRET",
        "body_style": "form",
        "scope": None,
        "infer_base": "https://cloudcode-pa.googleapis.com",
        "infer_model": "gemini-2.5-pro",
        "litellm_native": False,  # Code Assist endpoint — custom adapter
        "header_template": {"Authorization": "Bearer {token}"},
    },
}


class OAuthError(RuntimeError):
    pass


class OAuthManager:
    def __init__(self, home: Path | None = None, *, http_timeout: float = 20.0) -> None:
        self.home = home or Path.home()
        self._tokens: dict[str, ProviderTokens] = {}
        self._client_meta: dict[str, dict[str, Any]] = {}
        self._http_timeout = http_timeout

    # ---- load -------------------------------------------------------------
    def load_tokens(self, provider: str, *, home: Path | None = None) -> ProviderTokens:
        root = home or self.home
        # Prefer the gateway's own refreshed copy if present (kept fresh by refresh()).
        secrets_copy = root / ".rommie" / "secrets" / f"{provider}.json"
        if secrets_copy.exists():
            data = _read_json(secrets_copy)
            tokens = ProviderTokens(
                access_token=data["access_token"],
                refresh_token=data["refresh_token"],
                expires_at=_parse_datetime(data["expires_at"]),
                provider=provider,
            )
            self._tokens[provider] = tokens
            return tokens

        data = _read_json(_provider_path(provider, root))
        if provider == "claude":
            oauth = data["claudeAiOauth"]
            tokens = ProviderTokens(
                access_token=oauth["accessToken"],
                refresh_token=oauth["refreshToken"],
                expires_at=_epoch_to_dt(oauth["expiresAt"]),  # unix MILLIS
                provider=provider,
            )
        elif provider == "codex":
            raw = data["tokens"]
            tokens = ProviderTokens(
                access_token=raw["access_token"],
                refresh_token=raw["refresh_token"],
                expires_at=_codex_expiry(data, raw),
                provider=provider,
            )
            self._client_meta.setdefault("codex", {})["account_id"] = raw.get("account_id")
        elif provider == "kimi":
            tokens = ProviderTokens(
                access_token=data["access_token"],
                refresh_token=data["refresh_token"],
                expires_at=_epoch_to_dt(data["expires_at"]),  # unix SECONDS
                provider=provider,
            )
            if data.get("client_id"):
                self._client_meta.setdefault("kimi", {})["client_id"] = data["client_id"]
        elif provider == "agy":
            tokens = ProviderTokens(
                access_token=data["access_token"],
                refresh_token=data["refresh_token"],
                expires_at=_epoch_to_dt(data["expiry_date"]),  # unix MILLIS
                provider=provider,
            )
        else:
            raise ValueError(f"unknown oauth provider '{provider}'")
        self._tokens[provider] = tokens
        return tokens

    # ---- access -----------------------------------------------------------
    def get_token(self, provider: str) -> str:
        tokens = self._tokens.get(provider) or self.load_tokens(provider)
        if tokens.expires_at <= datetime.now(timezone.utc) + timedelta(minutes=5):
            tokens = self.refresh(provider)
        return tokens.access_token

    def dispatch_config(self, provider: str) -> DispatchConfig:
        cfg = _PROVIDER_OAUTH.get(provider)
        if cfg is None:
            raise ValueError(f"unknown oauth provider '{provider}'")
        return DispatchConfig(
            provider=provider,
            api_base=cfg["infer_base"],
            model=cfg["infer_model"],
            litellm_native=bool(cfg["litellm_native"]),
            header_template=dict(cfg["header_template"]),
        )

    def build_headers(self, provider: str, token: str) -> dict[str, str]:
        cfg = _PROVIDER_OAUTH[provider]
        return {k: v.replace("{token}", token) for k, v in cfg["header_template"].items()}

    # ---- refresh ----------------------------------------------------------
    def refresh(self, provider: str) -> ProviderTokens:
        cfg = _PROVIDER_OAUTH.get(provider)
        if cfg is None:
            raise ValueError(f"unknown oauth provider '{provider}'")
        current = self._tokens.get(provider) or self.load_tokens(provider)

        token_url = cfg.get("token_url") or self._discover_token_url(provider, cfg)
        body, headers = self._refresh_request(provider, cfg, current)

        with httpx.Client(timeout=self._http_timeout) as client:
            if cfg["body_style"] == "form":
                resp = client.post(token_url, data=body, headers=headers)
            else:
                resp = client.post(token_url, json=body, headers=headers)
        if resp.status_code >= 400:
            # Never include the response body verbatim — it can echo tokens.
            raise OAuthError(f"oauth refresh for {provider} failed: HTTP {resp.status_code}")
        payload = resp.json()

        access = payload.get("access_token")
        if not access:
            raise OAuthError(f"oauth refresh for {provider} returned no access_token")
        # Google does not rotate the refresh_token; reuse the current one when absent.
        new_refresh = payload.get("refresh_token") or current.refresh_token
        expires_at = self._expiry_from_payload(payload, access)
        tokens = ProviderTokens(
            access_token=access, refresh_token=new_refresh, expires_at=expires_at, provider=provider
        )
        self._tokens[provider] = tokens
        self._persist(tokens)
        return tokens

    def _refresh_request(
        self, provider: str, cfg: dict[str, Any], current: ProviderTokens
    ) -> tuple[dict[str, str], dict[str, str]]:
        client_id = (
            cfg.get("client_id")
            or self._client_meta.get(provider, {}).get("client_id")
            or _env_value(cfg.get("client_id_env"))
        )
        client_secret = cfg.get("client_secret") or _env_value(cfg.get("client_secret_env"))
        body: dict[str, str] = {
            "grant_type": "refresh_token",
            "refresh_token": current.refresh_token,
        }
        if client_id:
            body["client_id"] = client_id
        if client_secret:
            body["client_secret"] = client_secret
        if cfg.get("scope"):
            body["scope"] = cfg["scope"]
        headers = {"Accept": "application/json"}
        if cfg["body_style"] == "form":
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        return body, headers

    def _discover_token_url(self, provider: str, cfg: dict[str, Any]) -> str:
        auth_server = cfg.get("auth_server")
        if not auth_server:
            raise OAuthError(f"no token_url or auth_server configured for {provider}")
        well_known = f"{auth_server.rstrip('/')}/.well-known/oauth-authorization-server"
        with httpx.Client(timeout=self._http_timeout) as client:
            resp = client.get(well_known, headers={"Accept": "application/json"})
        if resp.status_code >= 400:
            raise OAuthError(f"oauth discovery for {provider} failed: HTTP {resp.status_code}")
        endpoint = resp.json().get("token_endpoint")
        if not endpoint:
            raise OAuthError(f"oauth discovery for {provider}: no token_endpoint")
        return endpoint

    @staticmethod
    def _expiry_from_payload(payload: dict[str, Any], access_token: str) -> datetime:
        expires_in = payload.get("expires_in")
        if isinstance(expires_in, (int, float)):
            return datetime.now(timezone.utc) + timedelta(seconds=float(expires_in))
        jwt_exp = _jwt_exp(access_token)
        if jwt_exp is not None:
            return jwt_exp
        # Conservative default: treat as already near-expiry so the next call refreshes.
        return datetime.now(timezone.utc) + timedelta(minutes=5)

    # ---- persist ----------------------------------------------------------
    def materialize(self, provider: str) -> Path:
        tokens = self._tokens.get(provider) or self.load_tokens(provider)
        return self._persist(tokens)

    def _persist(self, tokens: ProviderTokens) -> Path:
        target_dir = self.home / ".rommie" / "secrets"
        target_dir.mkdir(parents=True, exist_ok=True)
        os.chmod(target_dir, 0o700)
        target = target_dir / f"{tokens.provider}.json"
        payload = {
            "provider": tokens.provider,
            "access_token": tokens.access_token,
            "refresh_token": tokens.refresh_token,
            "expires_at": tokens.expires_at.isoformat(),
        }
        fd, tmp_name = tempfile.mkstemp(prefix=f".{tokens.provider}.", suffix=".json", dir=target_dir)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(payload, f)
            os.chmod(tmp_name, 0o600)
            os.replace(tmp_name, target)
        finally:
            if os.path.exists(tmp_name):
                os.unlink(tmp_name)
        os.chmod(target, 0o600)
        return target


# ---- helpers --------------------------------------------------------------
def _provider_path(provider: str, home: Path) -> Path:
    agents_path = _agents_provider_path(provider)
    if agents_path is not None and agents_path.exists():
        return agents_path
    if provider == "claude":
        return home / ".claude" / ".credentials.json"
    if provider == "codex":
        return home / ".codex" / "auth.json"
    if provider == "kimi":
        return home / ".kimi-code" / "credentials" / "kimi-code.json"
    if provider == "agy":
        return home / ".gemini" / "oauth_creds.json"
    raise ValueError(f"unknown oauth provider '{provider}'")


def _agents_provider_path(provider: str) -> Path | None:
    agents_clis = os.environ.get("AGENTS_CLIS", "").strip()
    if not agents_clis:
        return None
    root = Path(agents_clis)
    if provider == "claude":
        return root / "claude" / ".credentials.json"
    if provider == "codex":
        return root / "codex" / "auth.json"
    if provider == "kimi":
        return root / "kimi" / "credentials" / "kimi-code.json"
    if provider == "agy":
        return root / "agy" / ".gemini" / "oauth_creds.json"
    raise ValueError(f"unknown oauth provider '{provider}'")


def _read_json(path: Path) -> dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _env_value(name: str | None) -> str | None:
    if not name:
        return None
    value = os.environ.get(name)
    return value or None


def _parse_datetime(value: Any) -> datetime:
    if isinstance(value, (int, float)):
        return _epoch_to_dt(value)
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _epoch_to_dt(value: Any) -> datetime:
    """Accept unix seconds OR milliseconds (heuristic: > 1e12 => millis)."""
    n = float(value)
    if n > 1e12:  # milliseconds
        n /= 1000.0
    return datetime.fromtimestamp(n, tz=timezone.utc)


def _codex_expiry(data: dict[str, Any], raw: dict[str, Any]) -> datetime:
    # Real codex auth.json carries no expires_in; the access_token is a JWT.
    jwt_exp = _jwt_exp(raw.get("access_token", ""))
    if jwt_exp is not None:
        return jwt_exp
    last_refresh = data.get("last_refresh")
    expires_in = data.get("expires_in")
    if last_refresh is not None and expires_in is not None:
        base = _parse_datetime(last_refresh)
        return base + timedelta(seconds=float(expires_in))
    # Unknown — treat as near-expiry so the caller refreshes.
    return datetime.now(timezone.utc) + timedelta(minutes=5)


def _jwt_exp(token: str) -> datetime | None:
    """Decode an unverified JWT's `exp` claim (no signature check — read-only)."""
    parts = token.split(".")
    if len(parts) < 2:
        return None
    try:
        payload_b64 = parts[1] + "=" * (-len(parts[1]) % 4)
        claims = json.loads(base64.urlsafe_b64decode(payload_b64))
        exp = claims.get("exp")
        if isinstance(exp, (int, float)):
            return datetime.fromtimestamp(float(exp), tz=timezone.utc)
    except Exception:
        return None
    return None
