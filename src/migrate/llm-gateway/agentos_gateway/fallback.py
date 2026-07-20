"""Retry, backoff, and context-window fallback orchestration."""

from __future__ import annotations

import asyncio
import random
from typing import Awaitable, Callable, TypeVar

T = TypeVar("T")

MAX_RETRIES = 3
BASE_DELAY = 1.0
MAX_DELAY = 30.0


class FallbackError(Exception):
    pass


async def with_retry(
    fn: Callable[[], Awaitable[T]],
    max_retries: int = MAX_RETRIES,
    base_delay: float = BASE_DELAY,
    max_delay: float = MAX_DELAY,
    retryable_exceptions: tuple[type[Exception], ...] = (Exception,),
) -> T:
    """Execute an async callable with exponential backoff and jitter.

    Retries only on exceptions matching *retryable_exceptions*.
    """
    last_exc: Exception | None = None
    for attempt in range(max_retries + 1):
        try:
            return await fn()
        except retryable_exceptions as exc:
            last_exc = exc
            if attempt >= max_retries:
                break
            delay = min(base_delay * (2 ** attempt), max_delay)
            jitter = random.uniform(0, delay * 0.5)
            await asyncio.sleep(delay + jitter)

    raise FallbackError(f"Failed after {max_retries + 1} attempts: {last_exc}") from last_exc


def is_context_window_error(exc: Exception) -> bool:
    """Heuristic detection of context-window exceeded errors.

    Matches common error substrings from LiteLLM and OpenAI-compatible backends.
    """
    msg = str(exc).lower()
    markers = [
        "context length",
        "context_window",
        "maximum context length",
        "too many tokens",
        "token limit",
        "exceeds max tokens",
        "max_prompt_tokens",
        "invalid_request_error",  # OpenAI often wraps context errors here
    ]
    return any(m in msg for m in markers)


async def chat_with_fallback(
    router_call: Callable[[str], Awaitable[T]],
    primary_model_id: str,
    fallback_model_id: str | None,
    max_retries: int = MAX_RETRIES,
) -> T:
    """Call the router with retry; on context-window error, attempt fallback once.

    Args:
        router_call: Async callable that takes a model_id and returns the completion.
        primary_model_id: The initially requested model.
        fallback_model_id: Optional fallback model if context is exceeded.
        max_retries: Retries per model attempt.
    """
    async def _try(model_id: str) -> T:
        return await with_retry(
            lambda: router_call(model_id),
            max_retries=max_retries,
            retryable_exceptions=(Exception,),
        )

    try:
        return await _try(primary_model_id)
    except Exception as exc:
        if fallback_model_id and is_context_window_error(exc):
            return await _try(fallback_model_id)
        raise
