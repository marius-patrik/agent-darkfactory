"""In-memory provider quota tracking for never-meter cloud degradation."""

from __future__ import annotations

import json
import os
import time
from collections import defaultdict, deque
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class QuotaTracker:
    """Track per-provider request and token usage in a sliding window."""

    def __init__(self, now: Callable[[], float] | None = None) -> None:
        self._now = now or time.monotonic
        self._requests: dict[str, deque[float]] = defaultdict(deque)
        self._tokens: dict[str, deque[tuple[float, int]]] = defaultdict(deque)

    def record_usage(self, provider: str, tokens_in: int, tokens_out: int) -> None:
        now = self._now()
        clean_in = max(0, int(tokens_in))
        clean_out = max(0, int(tokens_out))
        self._prune(provider, now)
        self._requests[provider].append(now)
        self._tokens[provider].append((now, clean_in + clean_out))
        self._record_agents_credit(provider, clean_in, clean_out)

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

    def _record_agents_credit(self, provider: str, tokens_in: int, tokens_out: int) -> None:
        path = os.environ.get("AGENTS_CREDITS", "").strip()
        if not path:
            return
        credit_path = Path(path)
        try:
            credit_path.parent.mkdir(parents=True, exist_ok=True)
            store = _read_credit_store(credit_path)
            now = datetime.now(timezone.utc).isoformat()
            provider_state = store.setdefault("providers", {}).setdefault(provider, {})
            provider_state["requests"] = int(provider_state.get("requests", 0)) + 1
            provider_state["tokensIn"] = int(provider_state.get("tokensIn", 0)) + tokens_in
            provider_state["tokensOut"] = int(provider_state.get("tokensOut", 0)) + tokens_out
            store.setdefault("ledger", []).append(
                {
                    "provider": provider,
                    "consumer": "agentos.gateway",
                    "action": "usage",
                    "tokensIn": tokens_in,
                    "tokensOut": tokens_out,
                    "at": now,
                }
            )
            store["updatedAt"] = now
            tmp_path = credit_path.with_suffix(credit_path.suffix + ".tmp")
            tmp_path.write_text(json.dumps(store, indent=2) + "\n", encoding="utf-8")
            os.replace(tmp_path, credit_path)
        except OSError:
            return
        except json.JSONDecodeError:
            return


def _read_credit_store(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"schemaVersion": 1, "balances": {}, "providers": {}, "ledger": [], "updatedAt": ""}
    store = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(store, dict):
        return {"schemaVersion": 1, "balances": {}, "providers": {}, "ledger": [], "updatedAt": ""}
    store.setdefault("schemaVersion", 1)
    store.setdefault("balances", {})
    store.setdefault("providers", {})
    store.setdefault("ledger", [])
    return store


def _env_provider(provider: str) -> str:
    return "".join(ch if ch.isalnum() else "_" for ch in provider).upper()
