"""Postgres registry tests.

The live test is skipped unless ``GATEWAY_PG_DSN`` is set.
"""

from __future__ import annotations

import os

import pytest

from agentos_gateway.pg_registry import PgActiveRoleManager, PgModelRegistry
from agentos_gateway.registry import ModelEntry


@pytest.mark.live
def test_pg_registry_round_trip_live():
    dsn = os.environ.get("GATEWAY_PG_DSN")
    if not dsn:
        pytest.skip("GATEWAY_PG_DSN is not set")
    reg = PgModelRegistry(dsn)
    active = PgActiveRoleManager(dsn, pg_loop=reg._pg)
    try:
        assert len(reg.list_all()) > 0
        entry = ModelEntry({
            "id": "pytest-live-route",
            "name": "pytest live route",
            "provider": "local",
            "model": "pytest-live",
            "api_base": "http://127.0.0.1:65530/v1",
            "role": "judge",
            "context_length": 1024,
            "enabled": True,
            "cloud": False,
            "extra": {"engine": "llamacpp"},
        })
        reg.add(entry)
        assert reg.get("pytest-live-route") is not None
        updated = reg.update("pytest-live-route", {"context_length": 2048})
        assert updated is not None
        assert updated.context_length == 2048
        previous = active.set("judge", "pytest-live-route")
        assert previous is None or isinstance(previous, str)
        active.load()
        assert active.get("judge") == "pytest-live-route"
    finally:
        reg.remove("pytest-live-route")
        active.set("judge", None)
        active.close()
        reg.close()
