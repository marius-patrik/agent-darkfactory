"""Health endpoint and backend connectivity probes."""

from __future__ import annotations

import asyncio
import os
import time
from typing import Any

import httpx

from llm_gateway import __version__
from llm_gateway.registry import ModelRegistry, ModelEntry


class HealthChecker:
    def __init__(
        self,
        registry: ModelRegistry,
        started_at: float,
    ) -> None:
        self.registry = registry
        self.started_at = started_at
        self._http = httpx.AsyncClient(timeout=3.0)

    async def close(self) -> None:
        await self._http.aclose()

    async def check(self) -> dict[str, Any]:
        uptime = time.time() - self.started_at
        all_models = self.registry.list_all()
        enabled = self.registry.list_enabled()
        healthy = 0

        probes = [self._probe(m) for m in enabled]
        results = await asyncio.gather(*probes, return_exceptions=True)
        for r in results:
            if isinstance(r, bool) and r:
                healthy += 1

        available_roles = {model.role for model in enabled}

        status = "healthy"
        if healthy == 0 and len(enabled) > 0:
            status = "unhealthy"
        elif healthy < len(enabled):
            status = "degraded"

        return {
            "status": status,
            "version": __version__,
            "git_sha": os.environ.get("AGENTS_GIT_SHA", ""),
            "build_time": os.environ.get("AGENTS_BUILD_TIME", ""),
            "node_id": os.environ.get("AGENTS_NODE_ID", ""),
            "uptime_seconds": round(uptime, 2),
            "models_registered": len(all_models),
            "models_healthy": healthy,
            "roles_available": len(available_roles),
            "details": {
                m.id: (isinstance(r, bool) and r) for m, r in zip(enabled, results)
            },
        }

    async def _probe(self, entry: ModelEntry) -> bool:
        try:
            return await self._probe_http(entry)
        except Exception:
            return False

    async def _probe_http(self, entry: ModelEntry) -> bool:
        if not entry.api_base:
            return False
        try:
            url = f"{entry.api_base.rstrip('/')}/models"
            resp = await self._http.get(url)
            return resp.status_code < 500
        except Exception:
            return False
