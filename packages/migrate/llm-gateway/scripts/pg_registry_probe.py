"""Live PG registry proof helper.

Run with:
    GATEWAY_PG_DSN=postgres://... uv run python scripts/pg_registry_probe.py
"""

from __future__ import annotations

import os

from agentos_gateway.pg_registry import PgActiveRoleManager, PgModelRegistry
from agentos_gateway.registry import ModelEntry


def main() -> None:
    dsn = os.environ["GATEWAY_PG_DSN"]
    reg = PgModelRegistry(dsn)
    active = PgActiveRoleManager(dsn, pg_loop=reg._pg)
    try:
        before = len(reg.list_all())
        entry = ModelEntry({
            "id": "probe-s3-2-route",
            "name": "S3.2 probe route",
            "provider": "local",
            "model": "probe-s3-2",
            "api_base": "http://127.0.0.1:65531/v1",
            "role": "judge",
            "context_length": 1024,
            "enabled": True,
            "cloud": False,
            "extra": {"engine": "llamacpp"},
        })
        reg.add(entry)
        reg.update(entry.id, {"context_length": 2048})
        active.set("judge", entry.id)
        reg.load()
        active.load()
        route_count = len(reg.list_all())
        pinned = active.get("judge")
        print(f"model_routes_before={before}")
        print(f"model_routes_after_add={route_count}")
        print(f"probe_context_length={reg.get(entry.id).context_length if reg.get(entry.id) else 'missing'}")
        print(f"active_role_judge={pinned}")
    finally:
        reg.remove("probe-s3-2-route")
        active.set("judge", None)
        active.close()
        reg.close()


if __name__ == "__main__":
    main()
