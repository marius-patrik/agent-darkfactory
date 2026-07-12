"""In-memory request and token quota windows for local model providers."""

from __future__ import annotations

import os
import time
from collections import defaultdict, deque
from collections.abc import Callable
from typing import Any


class QuotaTracker:
    """Track per-provider request and token usage in a sliding window."""

    def __init__(self, now: Callable[[], float] | None = None) -> None:
        self._now = now or time.monotonic
        self._requests: dict[str, deque[float]] = defaultdict(deque)
        self._tokens: dict[str, deque[tuple[float, int]]] = defaultdict(deque)

    def record_usage(
        self,
        provider: str,
        tokens_in: int,
        tokens_out: int,
        task_class: str | None = None,
        model_id: str | None = None,
    ) -> None:
        now = self._now()
        clean_in = max(0, int(tokens_in))
        clean_out = max(0, int(tokens_out))
        self._prune(provider, now)
        self._requests[provider].append(now)
        self._tokens[provider].append((now, clean_in + clean_out))

    def record_route_resolution(self, provider: str, task_class: str, model_id: str) -> None:
        # The gateway keeps only its in-process quota window. Canonical provider
        # accounting is owned by the Agent OS harness and must not be mutated by
        # a second process with a different locking or schema contract.
        return None

    def is_exhausted(self, provider: str) -> bool:
        now = self._now()
        self._prune(provider, now)
        max_requests = self._limit(provider, "MAX_REQUESTS")
        max_tokens = self._limit(provider, "MAX_TOKENS")
        if max_requests is not None and len(self._requests[provider]) >= max_requests:
            return True
        if max_tokens is not None and sum(count for _, count in self._tokens[provider]) >= max_tokens:
            return True
        return False

    def snapshot(self) -> dict[str, Any]:
        now = self._now()
        providers = set(self._requests) | set(self._tokens)
        out: dict[str, Any] = {}
        for provider in providers:
            self._prune(provider, now)
            out[provider] = {
                "window_seconds": self._window(provider),
                "requests": len(self._requests[provider]),
                "tokens": sum(count for _, count in self._tokens[provider]),
                "exhausted": self.is_exhausted(provider),
            }
        return out

    def _prune(self, provider: str, now: float) -> None:
        cutoff = now - self._window(provider)
        requests = self._requests[provider]
        while requests and requests[0] < cutoff:
            requests.popleft()
        tokens = self._tokens[provider]
        while tokens and tokens[0][0] < cutoff:
            tokens.popleft()

    def _window(self, provider: str) -> float:
        return float(os.environ.get(f"GATEWAY_QUOTA_{_env_provider(provider)}_WINDOW_SECONDS", "3600"))

    def _limit(self, provider: str, suffix: str) -> int | None:
        value = os.environ.get(f"GATEWAY_QUOTA_{_env_provider(provider)}_{suffix}")
        if value is None or value.strip() == "":
            return None
        return int(value)

def _env_provider(provider: str) -> str:
    return "".join(ch if ch.isalnum() else "_" for ch in provider).upper()
