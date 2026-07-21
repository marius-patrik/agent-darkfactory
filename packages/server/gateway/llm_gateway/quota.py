"""In-memory request and token quota windows for local model providers."""

from __future__ import annotations

import os
import json
import time
from collections import defaultdict, deque
from collections.abc import Callable
from typing import Any
from pathlib import Path


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
        return self._persistent_budget_exhausted(provider)

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

    def _persistent_budget_exhausted(self, provider: str) -> bool:
        """Read durable Agent OS/provider budgets without becoming a writer."""
        raw_path = os.environ.get("GATEWAY_BUDGETS_PATH") or os.environ.get("ANDROMEDA_CREDITS")
        if not raw_path:
            return False
        path = Path(raw_path)
        try:
            store = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(store, dict):
                return True
            providers = store.get("providers", {})
            if not isinstance(providers, dict) or provider not in providers:
                return True
            state = providers[provider]
            if not isinstance(state, dict):
                return True
            budget = state.get("budget", {})
            if not isinstance(budget, dict):
                return True
            requests = _integer(state.get("requests"))
            tokens = _integer(state.get("tokensIn")) + _integer(state.get("tokensOut"))
            max_requests = _optional_integer(
                budget.get("maxRequests"),
                os.environ.get(f"GATEWAY_BUDGET_{_env_provider(provider)}_MAX_REQUESTS_TOTAL"),
            )
            max_tokens = _optional_integer(
                budget.get("maxTokens"),
                os.environ.get(f"GATEWAY_BUDGET_{_env_provider(provider)}_MAX_TOKENS_TOTAL"),
            )
            return (max_requests is not None and requests >= max_requests) or (max_tokens is not None and tokens >= max_tokens)
        except (OSError, json.JSONDecodeError, TypeError, ValueError):
            # A configured but unreadable budget authority cannot authorize
            # metered/cloud work. Local routing remains available.
            return True

def _env_provider(provider: str) -> str:
    return "".join(ch if ch.isalnum() else "_" for ch in provider).upper()


def _integer(value: Any) -> int:
    return max(0, int(value or 0))


def _optional_integer(primary: Any, fallback: Any) -> int | None:
    value = primary if primary is not None and str(primary).strip() else fallback
    return None if value is None or not str(value).strip() else max(0, int(value))
