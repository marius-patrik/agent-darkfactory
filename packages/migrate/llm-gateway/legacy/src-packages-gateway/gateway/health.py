"""Health endpoint and backend connectivity probes."""

from __future__ import annotations

import asyncio
import os
import time
from typing import Any

import httpx

from agents.packages.gateway.gateway import __version__
from agents.packages.gateway.gateway.registry import ModelRegistry, ActiveRoleManager, ModelEntry


class HealthChecker:
    def __init__(
        self,
        registry: ModelRegistry,
        active_roles: ActiveRoleManager,
        started_at: float,
    ) -> None:
        self.registry = registry
        self.active_roles = active_roles
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

        roles = self.active_roles.all()
        configured = sum(1 for v in roles.values() if v is not None)

        status = "healthy"
        if healthy == 0 and len(enabled) > 0:
            status = "unhealthy"
        elif healthy < len(enabled):
            status = "degraded"

        return {
            "status": status,
            "version": os.environ.get("AGENTS_VERSION", __version__),
            "git_sha": os.environ.get("AGENTS_GIT_SHA", ""),
            "image_tag": os.environ.get("AGENTS_IMAGE_TAG", ""),
            "build_time": os.environ.get("AGENTS_BUILD_TIME", ""),
            "node_id": os.environ.get("AGENTS_NODE_ID", ""),
            "uptime_seconds": round(uptime, 2),
            "models_registered": len(all_models),
            "models_healthy": healthy,
            "roles_configured": configured,
            "details": {
                m.id: (isinstance(r, bool) and r) for m, r in zip(enabled, results)
            },
        }

    async def _probe(self, entry: ModelEntry) -> bool:
        if entry.provider == "litellm-remote":
            return await self._probe_litellm(entry)
        return await self._probe_http(entry)

    async def _probe_http(self, entry: ModelEntry) -> bool:
        if not entry.api_base:
            return False
        try:
            url = f"{entry.api_base.rstrip('/')}/models"
            headers = {}
            api_key = entry.resolve_api_key()
            if api_key:
                headers["Authorization"] = f"Bearer {api_key}"
            resp = await self._http.get(url, headers=headers)
            return resp.status_code < 500
        except Exception:
            return False

    async def _probe_litellm(self, entry: ModelEntry) -> bool:
        try:
            import litellm
            kwargs: dict[str, Any] = {"model": entry.model, "messages": [{"role": "user", "content": "hi"}], "max_tokens": 1}
            if entry.api_base:
                kwargs["api_base"] = entry.api_base
            api_key = entry.resolve_api_key()
            if api_key:
                kwargs["api_key"] = api_key
            await litellm.acompletion(**kwargs)
            return True
        except Exception:
            return False
