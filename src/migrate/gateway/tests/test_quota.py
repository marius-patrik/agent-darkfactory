"""Tests for in-process provider quota windows."""

from __future__ import annotations

from llm_gateway.quota import QuotaTracker


def test_quota_window_is_clock_driven(monkeypatch):
    current = 0.0

    def clock() -> float:
        return current

    monkeypatch.setenv("GATEWAY_QUOTA_CODEX_WINDOW_SECONDS", "10")
    monkeypatch.setenv("GATEWAY_QUOTA_CODEX_MAX_TOKENS", "10")
    quota = QuotaTracker(now=clock)
    quota.record_usage("codex", 5, 5)
    assert quota.is_exhausted("codex") is True
    current = 11.0
    assert quota.is_exhausted("codex") is False
