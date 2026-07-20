"""Resolve local Agent OS models and call their OpenAI-format endpoints."""

from __future__ import annotations

import re
import time
from datetime import datetime, timezone
from typing import Any, AsyncIterator
from urllib.parse import urlparse

import httpx
from llm_gateway.quota import QuotaTracker
from llm_gateway.registry import ModelEntry, ModelRegistry, generate_request_id, is_local_entry, ROLE_NAMES
from llm_gateway.trace import TraceLogger

ROLE_ALIASES = ROLE_NAMES
_BACKEND_META_KEY = "_llm_gateway_backend"


class RoutingError(Exception):
    pass


class Router:
    def __init__(
        self,
        registry: ModelRegistry,
        tracer: TraceLogger,
        quota: QuotaTracker | None = None,
        timeout: float = 120.0,
    ) -> None:
        self.registry = registry
        self.tracer = tracer
        self.quota = quota or QuotaTracker()
        self.timeout = timeout
        self._http = httpx.AsyncClient(timeout=timeout)

    async def close(self) -> None:
        await self._http.aclose()

    def resolve_model(self, model_id: str, *, allow_cloud: bool = False) -> ModelEntry:
        """Resolve a model identifier to a registry entry.

        Supports:
        - Direct model IDs
        - Role aliases: 'general', 'coding', 'conversation', 'judge'
        """
        entry = self.registry.get(model_id)
        if entry is None and model_id in ROLE_ALIASES:
            entry = self._resolve_role(model_id)

        if entry is None:
            raise RoutingError(f"Model '{model_id}' not found in registry")

        if not entry.enabled:
            raise RoutingError(f"Model '{entry.id}' is disabled")

        if entry.cloud and (not allow_cloud or self.quota.is_exhausted(entry.provider)):
            fallback = next(
                (
                    candidate
                    for candidate in self.registry.list_by_role(entry.role)
                    if candidate.enabled and is_local_entry(candidate)
                ),
                None,
            )
            if fallback is None:
                reason = "disabled" if not allow_cloud else f"budget for '{entry.provider}' is exhausted"
                raise RoutingError(f"Cloud routing is {reason} and no local fallback is available")
            return fallback

        return entry

    def _resolve_role(self, role: str) -> ModelEntry | None:
        """Resolve a role alias to a concrete model.

        Registry declaration order is the single deterministic priority order.
        Provider/model selection belongs to canonical Agent OS session state;
        the gateway does not keep a second mutable role-selection store.
        """
        pool = self.registry.list_by_role(role)
        return pool[0] if pool else None

    def estimate_tokens(self, messages: list[dict[str, Any]], max_tokens: int | None = None) -> int:
        """Estimate tokens with the gateway's deterministic character heuristic."""
        total = 0
        for msg in messages:
            content = str(msg.get("content") or "")
            total += len(content) // 4 + 1
        total += len(messages) * 4

        if max_tokens:
            total += max_tokens

        return total

    def check_context(self, entry: ModelEntry, estimated_tokens: int) -> ModelEntry:
        """Reject requests that exceed the selected model's context limit."""
        if estimated_tokens <= entry.context_length:
            return entry

        raise RoutingError(
            f"Prompt estimated at {estimated_tokens} tokens exceeds model "
            f"'{entry.id}' context limit of {entry.context_length}."
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
        task_class: str | None = None,
        allow_cloud: bool = False,
    ) -> dict[str, Any] | AsyncIterator[dict[str, Any]]:
        """Route a chat-completion request to the resolved backend."""
        req_id = generate_request_id()
        t0 = time.perf_counter()

        requested_entry = self.registry.get(model_id)
        if requested_entry is None and model_id in ROLE_ALIASES:
            requested_entry = self._resolve_role(model_id)
        entry = self.resolve_model(model_id, allow_cloud=allow_cloud)
        degraded_to_local = bool(
            requested_entry is not None
            and requested_entry.id != entry.id
            and requested_entry.cloud
            and is_local_entry(entry)
        )
        role_hint = entry.role
        requested_role = model_id if model_id in ROLE_ALIASES else None

        estimated = self.estimate_tokens(messages, max_tokens)
        entry = self.check_context(entry, estimated)
        trace_fields = self._trace_fields(
            request_id=req_id,
            requested_model=model_id,
            requested_role=requested_role,
            entry=entry,
            response_status="started",
        )

        self.tracer.log(
            trace_id=req_id,
            event_type="request.start",
            model_id=entry.id,
            role=role_hint,
            tokens_in=estimated,
            **trace_fields,
        )

        try:
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
            if task_class:
                self.quota.record_usage(
                    entry.provider,
                    estimated,
                    tokens_out,
                    task_class=task_class,
                    model_id=entry.id,
                )
            response_meta = self._response_metadata(
                request_id=req_id,
                requested_model=model_id,
                requested_role=requested_role,
                entry=entry,
                duration_ms=duration_ms,
                response_status="success",
                backend_meta=backend_meta,
                task_class=task_class,
                degraded_to_local=degraded_to_local,
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
                error=str(exc),
                **self._trace_fields(
                    request_id=req_id,
                    requested_model=model_id,
                    requested_role=requested_role,
                    entry=entry,
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
            "response_status": response_status,
            "http_status": http_status,
        }

    def _response_metadata(
        self,
        request_id: str,
        requested_model: str,
        requested_role: str | None,
        entry: ModelEntry,
        duration_ms: float,
        response_status: str,
        backend_meta: dict[str, Any] | None = None,
        task_class: str | None = None,
        degraded_to_local: bool = False,
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
            "response_status": response_status,
            "http_status": backend_meta.get("http_status", 200),
            "task_class": task_class,
            "degraded_to_local": degraded_to_local,
        }

    def _backend_node_id(self, entry: ModelEntry, api_base: str | None) -> str | None:
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
                result["llm_gateway"] = gateway_metadata
            return result
        for choice in choices:
            if not isinstance(choice, dict):
                continue
            message = choice.get("message")
            if not isinstance(message, dict):
                continue
            message["content"] = self._strip_reasoning_blocks(message.get("content"))
        if gateway_metadata is not None:
            result["llm_gateway"] = gateway_metadata
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
