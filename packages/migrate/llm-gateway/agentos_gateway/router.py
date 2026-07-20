"""Request routing: resolve model, enforce rules, call backend.

Both subscription (OAuth) and metered (API-key) cloud providers are supported —
litellm handles either. The default + focus is the user's subscriptions (they
never pay metered), so subscription entries authenticate with their sub token;
metered-key entries work via the normal key path when explicitly chosen. The
``allow_cloud`` per-request opt-in is a safety so a cloud model is only used when
asked for — a guard, not a ban (§9 / §13).
"""

from __future__ import annotations

import asyncio
import re
import time
from datetime import datetime, timezone
from typing import Any, AsyncIterator
from urllib.parse import urlparse

import httpx
from litellm import acompletion

from agentos_gateway.oauth import OAuthManager
from agentos_gateway.quota import QuotaTracker
from agentos_gateway.registry import ModelEntry, ModelRegistry, ActiveRoleManager, generate_request_id, ROLE_NAMES
from agentos_gateway.trace import TraceLogger

ROLE_ALIASES = ROLE_NAMES
_BACKEND_META_KEY = "_agentos_gateway_backend"


class RoutingError(Exception):
    pass


class Router:
    def __init__(
        self,
        registry: ModelRegistry,
        active_roles: ActiveRoleManager,
        tracer: TraceLogger,
        quota: QuotaTracker | None = None,
        timeout: float = 120.0,
        oauth: "OAuthManager | None" = None,
    ) -> None:
        self.registry = registry
        self.active_roles = active_roles
        self.tracer = tracer
        self.quota = quota or QuotaTracker()
        self.timeout = timeout
        # Subscription-OAuth manager for never-metered cloud dispatch (#1288).
        # When None, cloud entries carrying an ``oauth_provider`` are unreachable.
        self.oauth = oauth
        self._http = httpx.AsyncClient(timeout=timeout)
        # Per-role round-robin cursors so a role alias spreads load across all
        # enabled replicas of that role (e.g. coding -> both GPU coders).
        self._rr: dict[str, int] = {}

    async def close(self) -> None:
        await self._http.aclose()

    def resolve_model(self, model_id: str, allow_cloud: bool = False) -> ModelEntry:
        """Resolve a model identifier to a registry entry.

        Supports:
        - Direct model IDs
        - Role aliases: 'general', 'coding', 'conversation', 'judge', 'embedding'
        """
        entry = self.registry.get(model_id)
        if entry is None and model_id in ROLE_ALIASES:
            entry = self._resolve_role(model_id)

        if entry is None:
            raise RoutingError(f"Model '{model_id}' not found in registry")

        if not entry.enabled:
            raise RoutingError(f"Model '{entry.id}' is disabled")

        if entry.cloud and self.quota.is_exhausted(self._quota_provider(entry)):
            fallback = self._local_fallback_for_role(entry.role)
            if fallback is None:
                raise RoutingError(f"Cloud quota exhausted for provider '{self._quota_provider(entry)}' and no local fallback serves role '{entry.role}'")
            self.tracer.log(
                trace_id=generate_request_id(),
                event_type="quota.degrade_to_local",
                model_id=entry.id,
                role=entry.role,
                provider=self._quota_provider(entry),
                resolved_model_id=fallback.id,
                fallback_used=True,
                fallback_to=fallback.id,
                cloud=True,
                extra={"from_model_id": entry.id, "to_model_id": fallback.id},
            )
            entry = fallback

        # Cloud opt-in guard (§9 / §13): a cloud model is only reachable when the
        # request explicitly opts in (allow_cloud). A safety so cloud/metered use
        # is deliberate — not a ban; both subs and metered are supported.
        if entry.cloud and not allow_cloud:
            raise RoutingError(
                f"Model '{entry.id}' is a cloud model and this request did not opt in (allow_cloud=false)"
            )

        return entry

    def _quota_provider(self, entry: ModelEntry) -> str:
        return str(entry.extra.get("oauth_provider") or entry.extra.get("provider") or entry.provider)

    def _local_fallback_for_role(self, role: str) -> ModelEntry | None:
        pool = sorted(
            (m for m in self.registry.list_by_role(role) if not m.cloud and m.enabled),
            key=lambda m: (-int(m.context_length), m.id),
        )
        return pool[0] if pool else None

    def _resolve_role(self, role: str) -> ModelEntry | None:
        """Resolve a role alias to a concrete model.

        When more than one enabled local model serves the role (e.g. a coder on
        each GPU), round-robin across them so load spreads over every replica.
        The operator-pinned active model is honoured as the rotation anchor: it
        is always tried first, so a single request still hits the pinned model,
        while sustained traffic fans out to every replica. Cloud models are
        excluded from rotation (they require explicit per-request opt-in).
        Falls back to the active pin when no enabled model declares the role.
        """
        active_id = self.active_roles.get(role)
        pool = sorted(
            (m for m in self.registry.list_by_role(role) if not m.cloud),
            key=lambda m: m.id,
        )
        if not pool:
            # A role alias may be declared in ROLE_NAMES (and in active.yaml) but
            # have no model registered for it (e.g. 'embedding' deferred to VS2 —
            # docs/gateway.md §"Deliberately left for VS2"). Return None here so
            # resolve_model raises a clear RoutingError rather than silently
            # routing to an unrelated model via the active-pin fallback.
            if active_id:
                entry = self.registry.get(active_id)
                if entry is not None and entry.role == role:
                    return entry
            return None
        # Anchor the rotation on the pinned model when it is part of the pool.
        anchor = next((m for m in pool if m.id == active_id), None)
        if anchor is not None:
            pool = [anchor] + [m for m in pool if m.id != active_id]
        if len(pool) == 1:
            return pool[0]
        idx = self._rr.get(role, 0) % len(pool)
        self._rr[role] = idx + 1
        return pool[idx]

    def estimate_tokens(self, messages: list[dict[str, Any]], max_tokens: int | None = None) -> int:
        """Conservative token estimation.

        Uses tiktoken if available for OpenAI-compatible models,
        otherwise falls back to a character heuristic (~4 chars/token).
        """
        try:
            import tiktoken
            enc = tiktoken.get_encoding("cl100k_base")
            total = 0
            for msg in messages:
                content = msg.get("content") or ""
                total += len(enc.encode(content))
                total += 4  # per-message overhead
            total += 2  # reply priming
        except Exception:
            total = 0
            for msg in messages:
                content = msg.get("content") or ""
                total += len(content) // 4 + 1
            total += len(messages) * 4

        if max_tokens:
            total += max_tokens

        return total

    def check_context(self, entry: ModelEntry, estimated_tokens: int) -> ModelEntry:
        """Enforce context limit with fallback.

        Raises RoutingError if the estimated tokens exceed the model's context
        and no fallback is configured.
        """
        if estimated_tokens <= entry.context_length:
            return entry

        if entry.fallback_model:
            fallback = self.registry.get(entry.fallback_model)
            if fallback and fallback.enabled and fallback.context_length > entry.context_length and estimated_tokens <= fallback.context_length:
                return fallback

        raise RoutingError(
            f"Prompt estimated at {estimated_tokens} tokens exceeds model "
            f"'{entry.id}' context limit of {entry.context_length} and no usable fallback is configured."
        )

    async def chat_completion(
        self,
        model_id: str,
        messages: list[dict[str, Any]],
        temperature: float | None = None,
        top_p: float | None = None,
        max_tokens: int | None = None,
        stream: bool = False,
        stop: str | list[str] | None = None,
        presence_penalty: float | None = None,
        frequency_penalty: float | None = None,
        tools: list[dict[str, Any]] | None = None,
        tool_choice: str | dict[str, Any] | None = None,
        allow_cloud: bool = False,
        task_class: str | None = None,
    ) -> dict[str, Any] | AsyncIterator[dict[str, Any]]:
        """Route a chat-completion request to the resolved backend."""
        req_id = generate_request_id()
        t0 = time.perf_counter()

        entry = self.resolve_model(model_id, allow_cloud=allow_cloud)
        role_hint = entry.role
        requested_role = model_id if model_id in ROLE_ALIASES else None

        estimated = self.estimate_tokens(messages, max_tokens)
        original_entry = entry
        entry = self.check_context(entry, estimated)
        fallback_used = entry.id != original_entry.id
        trace_fields = self._trace_fields(
            request_id=req_id,
            requested_model=model_id,
            requested_role=requested_role,
            entry=entry,
            allow_cloud=allow_cloud,
            response_status="started",
        )

        self.tracer.log(
            trace_id=req_id,
            event_type="request.start",
            model_id=entry.id,
            role=role_hint,
            tokens_in=estimated,
            fallback_used=fallback_used,
            fallback_to=entry.id if fallback_used else None,
            **trace_fields,
        )

        # Defense-in-depth (#1288 review): the subscription-OAuth branch lives only
        # in _via_litellm. A subscription entry mis-set to a non-litellm provider
        # would bypass it — fail CLOSED loudly rather than silently fall through to
        # the metered/api-key paths (_via_http/_via_nvcf use resolve_api_key()).
        if entry.extra.get("oauth_provider") and entry.provider != "litellm-remote":
            raise RoutingError(
                f"Model '{entry.id}' carries oauth_provider='{entry.extra['oauth_provider']}' "
                f"but provider='{entry.provider}' (not litellm-remote); subscription entries "
                f"must route through litellm. Refusing to dispatch (fail-closed)."
            )

        try:
            if entry.provider == "litellm-remote":
                result = await self._via_litellm(
                    entry=entry,
                    messages=messages,
                    temperature=temperature,
                    top_p=top_p,
                    max_tokens=max_tokens,
                    stream=stream,
                    stop=stop,
                    presence_penalty=presence_penalty,
                    frequency_penalty=frequency_penalty,
                    tools=tools,
                    tool_choice=tool_choice,
                )
            elif entry.provider == "nvcf":
                result = await self._via_nvcf(
                    entry=entry,
                    messages=messages,
                    temperature=temperature,
                    top_p=top_p,
                    max_tokens=max_tokens,
                    stream=stream,
                    stop=stop,
                    presence_penalty=presence_penalty,
                    frequency_penalty=frequency_penalty,
                    tools=tools,
                    tool_choice=tool_choice,
                )
            else:
                result = await self._via_http(
                    entry=entry,
                    messages=messages,
                    temperature=temperature,
                    top_p=top_p,
                    max_tokens=max_tokens,
                    stream=stream,
                    stop=stop,
                    presence_penalty=presence_penalty,
                    frequency_penalty=frequency_penalty,
                    tools=tools,
                    tool_choice=tool_choice,
                )

            duration_ms = (time.perf_counter() - t0) * 1000
            backend_meta = self._pop_backend_metadata(result)
            tokens_out = self._tokens_out(result)
            if original_entry.cloud or task_class:
                self.quota.record_usage(
                    self._quota_provider(original_entry),
                    estimated,
                    tokens_out,
                    task_class=task_class,
                    model_id=original_entry.id,
                )
            response_meta = self._response_metadata(
                request_id=req_id,
                requested_model=model_id,
                requested_role=requested_role,
                entry=entry,
                allow_cloud=allow_cloud,
                duration_ms=duration_ms,
                response_status="success",
                fallback_used=fallback_used,
                fallback_to=entry.id if fallback_used else None,
                backend_meta=backend_meta,
                task_class=task_class,
            )
            success_trace_fields = {
                key: response_meta[key]
                for key in (
                    "request_id",
                    "requested_model",
                    "requested_role",
                    "resolved_model_id",
                    "provider",
                    "backend_type",
                    "backend_api_base",
                    "backend_node_id",
                    "served_model",
                    "resource_class",
                    "allow_cloud",
                    "cloud",
                    "response_status",
                    "http_status",
                )
            }
            success_extra = {"task_class": task_class} if task_class else None
            self.tracer.log(
                trace_id=req_id,
                event_type="request.success",
                model_id=entry.id,
                role=role_hint,
                duration_ms=duration_ms,
                tokens_in=estimated,
                tokens_out=tokens_out,
                fallback_used=fallback_used,
                fallback_to=entry.id if fallback_used else None,
                extra=success_extra,
                **success_trace_fields,
            )
            return self._normalize_response(result, response_meta if not stream else None)
        except Exception as exc:
            duration_ms = (time.perf_counter() - t0) * 1000
            http_status = self._exception_http_status(exc)
            self.tracer.log(
                trace_id=req_id,
                event_type="request.failure",
                model_id=entry.id,
                role=role_hint,
                duration_ms=duration_ms,
                tokens_in=estimated,
                fallback_used=fallback_used,
                fallback_to=entry.id if fallback_used else None,
                error=str(exc),
                **self._trace_fields(
                    request_id=req_id,
                    requested_model=model_id,
                    requested_role=requested_role,
                    entry=entry,
                    allow_cloud=allow_cloud,
                    response_status="error",
                    http_status=http_status,
                ),
            )
            raise

    def _trace_fields(
        self,
        request_id: str,
        requested_model: str,
        requested_role: str | None,
        entry: ModelEntry,
        allow_cloud: bool,
        response_status: str,
        http_status: int | None = None,
    ) -> dict[str, Any]:
        return {
            "request_id": request_id,
            "requested_model": requested_model,
            "requested_role": requested_role,
            "resolved_model_id": entry.id,
            "provider": entry.provider,
            "backend_type": entry.provider,
            "backend_api_base": entry.api_base,
            "backend_node_id": self._backend_node_id(entry, entry.api_base),
            "served_model": entry.model,
            "resource_class": entry.gpu,
            "allow_cloud": allow_cloud,
            "cloud": entry.cloud,
            "response_status": response_status,
            "http_status": http_status,
        }

    def _response_metadata(
        self,
        request_id: str,
        requested_model: str,
        requested_role: str | None,
        entry: ModelEntry,
        allow_cloud: bool,
        duration_ms: float,
        response_status: str,
        fallback_used: bool,
        fallback_to: str | None,
        backend_meta: dict[str, Any] | None = None,
        task_class: str | None = None,
    ) -> dict[str, Any]:
        backend_meta = backend_meta or {}
        backend_api_base = backend_meta.get("backend_api_base", entry.api_base)
        served_model = backend_meta.get("served_model", entry.model)
        return {
            "request_id": request_id,
            "trace_id": request_id,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "duration_ms": round(duration_ms, 2),
            "requested_model": requested_model,
            "requested_role": requested_role,
            "resolved_model_id": entry.id,
            "role": entry.role,
            "provider": entry.provider,
            "backend_type": entry.provider,
            "backend_api_base": backend_api_base,
            "backend_node_id": backend_meta.get("backend_node_id", self._backend_node_id(entry, backend_api_base)),
            "served_model": served_model,
            "resource_class": entry.gpu,
            "allow_cloud": allow_cloud,
            "cloud": entry.cloud,
            "response_status": response_status,
            "http_status": backend_meta.get("http_status", 200),
            "fallback_used": fallback_used,
            "fallback_to": fallback_to,
            "task_class": task_class,
        }

    def _backend_node_id(self, entry: ModelEntry, api_base: str | None) -> str | None:
        extra_node = entry.extra.get("node_id") or entry.extra.get("backend_node_id")
        if extra_node:
            return str(extra_node)
        for node_id in ("s001", "s002"):
            if entry.id.endswith(f"-{node_id}"):
                return node_id
        if api_base:
            hostname = urlparse(api_base).hostname or ""
            for node_id in ("s001", "s002"):
                if hostname == node_id or hostname.startswith(f"{node_id}.") or hostname.startswith(f"{node_id}-"):
                    return node_id
        if entry.gpu:
            for node_id in ("s001", "s002"):
                if entry.gpu.startswith(node_id):
                    return node_id
        return None

    def _backend_metadata(self, entry: ModelEntry, api_base: str | None, served_model: str, http_status: int) -> dict[str, Any]:
        return {
            "backend_api_base": api_base,
            "backend_node_id": self._backend_node_id(entry, api_base),
            "served_model": served_model,
            "http_status": http_status,
        }

    @staticmethod
    def _pop_backend_metadata(result: dict[str, Any] | AsyncIterator[dict[str, Any]]) -> dict[str, Any] | None:
        if isinstance(result, dict):
            meta = result.pop(_BACKEND_META_KEY, None)
            return meta if isinstance(meta, dict) else None
        return None

    @staticmethod
    def _exception_http_status(exc: Exception) -> int | None:
        response = getattr(exc, "response", None)
        status_code = getattr(response, "status_code", None)
        return status_code if isinstance(status_code, int) else None

    @staticmethod
    def _tokens_out(result: dict[str, Any] | AsyncIterator[dict[str, Any]]) -> int:
        if not isinstance(result, dict):
            return 0
        usage = result.get("usage")
        if isinstance(usage, dict):
            for key in ("completion_tokens", "output_tokens"):
                value = usage.get(key)
                if isinstance(value, int):
                    return value
        return 0

    async def _via_litellm(
        self,
        entry: ModelEntry,
        messages: list[dict[str, Any]],
        temperature: float | None,
        top_p: float | None,
        max_tokens: int | None,
        stream: bool,
        stop: str | list[str] | None,
        presence_penalty: float | None,
        frequency_penalty: float | None,
        tools: list[dict[str, Any]] | None,
        tool_choice: str | dict[str, Any] | None,
    ) -> dict[str, Any] | AsyncIterator[dict[str, Any]]:
        kwargs: dict[str, Any] = {
            "model": entry.model,
            "messages": messages,
            "stream": stream,
        }
        if entry.api_base:
            kwargs["api_base"] = entry.api_base

        oauth_provider = entry.extra.get("oauth_provider")
        if oauth_provider:
            # Subscription (OAuth) dispatch (#1288). A sub entry authenticates with
            # its sub token — we don't let a stray metered key override a sub entry
            # (the user's default is subs). Metered-key entries use the else-branch.
            if self.oauth is None:
                raise RoutingError(
                    f"Model '{entry.id}' needs subscription OAuth ('{oauth_provider}') but no OAuthManager is configured"
                )
            cfg = self.oauth.dispatch_config(oauth_provider)
            if not cfg.litellm_native:
                # claude (Messages API) / codex (ChatGPT Responses) / agy (Code
                # Assist) speak non-OpenAI protocols litellm can't dispatch with a
                # bare Bearer token — they need a custom adapter (not built yet).
                raise RoutingError(
                    f"Cloud provider '{oauth_provider}' requires a custom dispatch adapter "
                    f"(not litellm-native); tracked in the #1288 follow-up."
                )
            token = await asyncio.to_thread(self.oauth.get_token, oauth_provider)
            # OpenAI-compatible endpoint: litellm sends the api_key as Bearer.
            kwargs["api_key"] = token
        else:
            # Metered/local key path (supported; used for non-subscription entries).
            api_key = entry.resolve_api_key()
            if api_key:
                kwargs["api_key"] = api_key
        if temperature is not None:
            kwargs["temperature"] = temperature
        if top_p is not None:
            kwargs["top_p"] = top_p
        if max_tokens is not None:
            kwargs["max_tokens"] = max_tokens
        if stop is not None:
            kwargs["stop"] = stop
        if presence_penalty is not None:
            kwargs["presence_penalty"] = presence_penalty
        if frequency_penalty is not None:
            kwargs["frequency_penalty"] = frequency_penalty
        if tools is not None:
            kwargs["tools"] = tools
        if tool_choice is not None:
            kwargs["tool_choice"] = tool_choice

        result = await acompletion(**kwargs)
        if not stream and not isinstance(result, dict):
            if hasattr(result, "model_dump"):
                result = result.model_dump()
            elif hasattr(result, "dict"):
                result = result.dict()
        if isinstance(result, dict) and not stream:
            result[_BACKEND_META_KEY] = self._backend_metadata(entry, entry.api_base, entry.model, 200)
        return result

    async def _via_nvcf(
        self,
        entry: ModelEntry,
        messages: list[dict[str, Any]],
        temperature: float | None,
        top_p: float | None,
        max_tokens: int | None,
        stream: bool,
        stop: str | list[str] | None,
        presence_penalty: float | None,
        frequency_penalty: float | None,
        tools: list[dict[str, Any]] | None,
        tool_choice: str | dict[str, Any] | None,
    ) -> dict[str, Any] | AsyncIterator[dict[str, Any]]:
        """Local load-based NVCF dispatcher.

        Tries the primary endpoint first. On load-related failures (503, 429,
        timeouts, connection errors), falls back to a pipeline-parallel (PP)
        deployment configured in entry.extra.
        """
        load_errors = (httpx.HTTPStatusError, httpx.ConnectError, httpx.TimeoutException, httpx.NetworkError)

        async def _try_endpoint(api_base: str, model: str) -> dict[str, Any] | AsyncIterator[dict[str, Any]]:
            temp_entry = ModelEntry({
                "id": entry.id,
                "provider": "local",
                "model": model,
                "api_base": api_base,
                "role": entry.role,
                "context_length": entry.context_length,
                "enabled": True,
                "cloud": False,
                "gpu": entry.gpu,
                "extra": {
                    **entry.extra,
                    "backend_node_id": self._backend_node_id(entry, api_base),
                },
            })
            return await self._via_http(
                entry=temp_entry,
                messages=messages,
                temperature=temperature,
                top_p=top_p,
                max_tokens=max_tokens,
                stream=stream,
                stop=stop,
                presence_penalty=presence_penalty,
                frequency_penalty=frequency_penalty,
                tools=tools,
                tool_choice=tool_choice,
            )

        primary_base = entry.api_base
        primary_model = entry.model
        pp_base = entry.extra.get("pp_api_base") if entry.extra else None
        pp_model = entry.extra.get("pp_model", primary_model) if entry.extra else primary_model

        if not primary_base:
            raise RoutingError(f"Model '{entry.id}' has no primary api_base configured")

        try:
            return await _try_endpoint(primary_base, primary_model)
        except load_errors as exc:
            status_code = getattr(getattr(exc, "response", None), "status_code", 0)
            if status_code not in (429, 502, 503, 504) and not isinstance(exc, (httpx.ConnectError, httpx.TimeoutException, httpx.NetworkError)):
                raise
            if pp_base:
                self.tracer.log(
                    trace_id=generate_request_id(),
                    event_type="nvcf.pp_fallback",
                    model_id=entry.id,
                    error=str(exc),
                    extra={"pp_model": pp_model, "pp_api_base": pp_base},
                )
                return await _try_endpoint(pp_base, pp_model)
            raise RoutingError(f"Primary endpoint overloaded and no PP fallback configured for '{entry.id}'") from exc

    async def _via_http(
        self,
        entry: ModelEntry,
        messages: list[dict[str, Any]],
        temperature: float | None,
        top_p: float | None,
        max_tokens: int | None,
        stream: bool,
        stop: str | list[str] | None,
        presence_penalty: float | None,
        frequency_penalty: float | None,
        tools: list[dict[str, Any]] | None,
        tool_choice: str | dict[str, Any] | None,
    ) -> dict[str, Any] | AsyncIterator[dict[str, Any]]:
        if not entry.api_base:
            raise RoutingError(f"Model '{entry.id}' has no api_base configured")

        payload: dict[str, Any] = {
            "model": entry.model,
            "messages": messages,
            "stream": stream,
        }
        if temperature is not None:
            payload["temperature"] = temperature
        if top_p is not None:
            payload["top_p"] = top_p
        if max_tokens is not None:
            payload["max_tokens"] = max_tokens
        if stop is not None:
            payload["stop"] = stop
        if presence_penalty is not None:
            payload["presence_penalty"] = presence_penalty
        if frequency_penalty is not None:
            payload["frequency_penalty"] = frequency_penalty
        if tools is not None:
            payload["tools"] = tools
        if tool_choice is not None:
            payload["tool_choice"] = tool_choice

        headers = {"Content-Type": "application/json"}
        api_key = entry.resolve_api_key()
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        url = f"{entry.api_base.rstrip('/')}/chat/completions"

        if stream:
            return self._stream_http(url, headers, payload)

        response = await self._http.post(url, headers=headers, json=payload)
        response.raise_for_status()
        result = response.json()
        if isinstance(result, dict):
            result[_BACKEND_META_KEY] = self._backend_metadata(
                entry,
                entry.api_base,
                str(result.get("model") or entry.model),
                response.status_code,
            )
        return result

    async def _stream_http(
        self,
        url: str,
        headers: dict[str, str],
        payload: dict[str, Any],
    ) -> AsyncIterator[dict[str, Any]]:
        in_reasoning = False
        async with self._http.stream("POST", url, headers=headers, json=payload) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if line.startswith("data: "):
                    data = line[6:]
                    if data == "[DONE]":
                        break
                    import json
                    chunk, in_reasoning = self._normalize_chunk(json.loads(data), in_reasoning)
                    yield chunk

    _THINK_RE = re.compile(r"<think\b[^>]*>.*?</think>", re.IGNORECASE | re.DOTALL)

    @classmethod
    def _strip_reasoning_blocks(cls, content: str | None) -> str | None:
        """Remove local reasoning-model private thoughts from assistant content."""
        if content is None:
            return None
        cleaned = cls._THINK_RE.sub("", content)
        stripped, _ = cls._strip_reasoning_delta(cleaned, False)
        return stripped.strip() if stripped is not None else None

    def _normalize_response(
        self,
        result: dict[str, Any] | AsyncIterator[dict[str, Any]],
        gateway_metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any] | AsyncIterator[dict[str, Any]]:
        if not isinstance(result, dict):
            return result
        choices = result.get("choices")
        if not isinstance(choices, list):
            if gateway_metadata is not None:
                result["agentos_gateway"] = gateway_metadata
            return result
        for choice in choices:
            if not isinstance(choice, dict):
                continue
            message = choice.get("message")
            if not isinstance(message, dict):
                continue
            message["content"] = self._strip_reasoning_blocks(message.get("content"))
        if gateway_metadata is not None:
            result["agentos_gateway"] = gateway_metadata
        return result

    @staticmethod
    def _strip_reasoning_delta(content: str | None, in_reasoning: bool) -> tuple[str | None, bool]:
        if content is None:
            return None, in_reasoning

        out: list[str] = []
        i = 0
        lower = content.lower()
        while i < len(content):
            if in_reasoning:
                end = lower.find("</think>", i)
                if end == -1:
                    return "".join(out), True
                i = end + len("</think>")
                in_reasoning = False
                continue

            start = lower.find("<think", i)
            if start == -1:
                out.append(content[i:])
                break
            out.append(content[i:start])
            tag_end = lower.find(">", start)
            if tag_end == -1:
                return "".join(out), True
            i = tag_end + 1
            in_reasoning = True

        return "".join(out), in_reasoning

    def _normalize_chunk(self, chunk: dict[str, Any], in_reasoning: bool = False) -> tuple[dict[str, Any], bool]:
        choices = chunk.get("choices")
        if not isinstance(choices, list):
            return chunk, in_reasoning
        for choice in choices:
            if not isinstance(choice, dict):
                continue
            delta = choice.get("delta")
            if not isinstance(delta, dict):
                continue
            if "content" in delta:
                delta["content"], in_reasoning = self._strip_reasoning_delta(delta.get("content"), in_reasoning)
        return chunk, in_reasoning
