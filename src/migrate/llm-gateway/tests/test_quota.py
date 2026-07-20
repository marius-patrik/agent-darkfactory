"""Tests for cloud quota degradation."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from agentos_gateway.quota import QuotaTracker
from agentos_gateway.registry import ActiveRoleManager, ModelRegistry
from agentos_gateway.router import Router
from agentos_gateway.trace import TraceLogger


def test_resolve_cloud_degrades_to_local_when_provider_quota_exhausted(monkeypatch):
    now = 1000.0

    def clock() -> float:
        return now

    monkeypatch.setenv("GATEWAY_QUOTA_CLAUDE_MAX_REQUESTS", "1")
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        reg_path = root / "models.yaml"
        active_path = root / "active.yaml"
        schema_path = root / "schema.json"
        schema_path.write_text(json.dumps({"type": "object", "properties": {"models": {"type": "object"}}}))
        reg_path.write_text(json.dumps({
            "schema_version": "gateway-registry-v1",
            "models": {
                "local-general": {
                    "id": "local-general",
                    "provider": "local",
                    "api_base": "http://127.0.0.1:8001/v1",
                    "role": "general",
                    "context_length": 4096,
                    "enabled": True,
                    "cloud": False,
                },
                "claude-cloud": {
                    "id": "claude-cloud",
                    "provider": "litellm-remote",
                    "role": "general",
                    "context_length": 200000,
                    "enabled": True,
                    "cloud": True,
                    "extra": {"oauth_provider": "claude"},
                },
            },
        }))
        quota = QuotaTracker(now=clock)
        quota.record_usage("claude", 1, 1)
        tracer = TraceLogger(trace_dir=root / "traces")
        router = Router(ModelRegistry(reg_path, schema_path), ActiveRoleManager(active_path), tracer, quota=quota)
        try:
            entry = router.resolve_model("claude-cloud", allow_cloud=True)
            assert entry.id == "local-general"
            events = [
                json.loads(line)
                for trace_file in (root / "traces").glob("gateway-*.jsonl")
                for line in trace_file.read_text().splitlines()
            ]
            assert any(event["event_type"] == "quota.degrade_to_local" for event in events)
        finally:
            tracer.close()


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
