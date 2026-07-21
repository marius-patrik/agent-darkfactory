"""HTTP client for the inference worker's gateway boundary."""

from __future__ import annotations

import os
from typing import Any

import httpx


class LoopError(RuntimeError):
    """Raised when the agent loop cannot continue safely."""


class GatewayClient:
    """Async OpenAI-compatible gateway client.

    The worker uses non-streaming chat completions so native
    ``tool_calls`` arrive as one complete message.
    """

    def __init__(self, base_url: str | None = None, timeout: float = 120.0) -> None:
        self.base_url = (base_url or os.environ.get("AGENTS_GATEWAY_URL") or "http://127.0.0.1:8787").rstrip("/")
        self.timeout = timeout

    async def chat_completion(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        model: str,
        tool_choice: str = "auto",
    ) -> dict[str, Any]:
        """Return the first non-streaming assistant message and finish reason."""
        payload = {
            "model": model,
            "messages": messages,
            "tools": tools,
            "tool_choice": tool_choice,
            "stream": False,
        }
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.post(f"{self.base_url}/v1/chat/completions", json=payload)
                response.raise_for_status()
                body = response.json()
        except httpx.HTTPStatusError as exc:
            detail = _safe_error_detail(exc.response)
            raise LoopError(f"Gateway chat completion failed: HTTP {exc.response.status_code}: {detail}") from exc
        except Exception as exc:
            raise LoopError(f"Gateway chat completion failed: {exc}") from exc

        try:
            choice = body["choices"][0]
            message = dict(choice["message"])
            message["finish_reason"] = choice.get("finish_reason")
            return message
        except Exception as exc:
            raise LoopError("Gateway chat completion response did not contain choices[0].message") from exc

    async def model_context_length(self, model: str) -> int | None:
        """Return the advertised context length for ``model`` if available."""
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.get(f"{self.base_url}/v1/models")
                response.raise_for_status()
                body = response.json()
        except httpx.HTTPStatusError as exc:
            detail = _safe_error_detail(exc.response)
            raise LoopError(f"Gateway model list failed: HTTP {exc.response.status_code}: {detail}") from exc
        except Exception as exc:
            raise LoopError(f"Gateway model list failed: {exc}") from exc

        for entry in body.get("data", []):
            if entry.get("id") == model:
                value = entry.get("context_length")
                return int(value) if value is not None else None
        return None


def estimate_tokens(text: str | list[dict[str, Any]]) -> int:
    """Estimate tokens with the gateway heuristic without importing gateway code."""
    messages = text if isinstance(text, list) else [{"content": text}]
    total = 0
    for msg in messages:
        content = str(msg.get("content") or "")
        total += len(content) // 4 + 1
    return total + len(messages) * 4


def _safe_error_detail(response: httpx.Response) -> str:
    detail = response.text[:1000]
    for prefix in ("sk-ant-", "sk-proj-", "sk-"):
        if prefix in detail:
            detail = detail.replace(prefix, "redacted-")
    return detail
