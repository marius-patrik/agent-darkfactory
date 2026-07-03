from __future__ import annotations

import json

from agentos_gateway.quota import QuotaTracker


def test_quota_records_agents_credit_ledger(monkeypatch, tmp_path):
    credits = tmp_path / "credits.json"
    credits.write_text(
        json.dumps({"schemaVersion": 1, "balances": {}, "providers": {}, "ledger": [], "updatedAt": ""}) + "\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("AGENTS_CREDITS", str(credits))

    quota = QuotaTracker(now=lambda: 1.0)
    quota.record_usage("claude", 12, 7)

    store = json.loads(credits.read_text(encoding="utf-8"))
    assert store["providers"]["claude"]["requests"] == 1
    assert store["providers"]["claude"]["tokensIn"] == 12
    assert store["providers"]["claude"]["tokensOut"] == 7
    assert store["ledger"][0]["provider"] == "claude"
    assert store["ledger"][0]["consumer"] == "agentos.gateway"
    assert store["ledger"][0]["action"] == "usage"
