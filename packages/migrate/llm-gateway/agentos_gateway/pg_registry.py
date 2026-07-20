"""Postgres-backed gateway registry.

``model_routes.engine`` is derived from gateway registry entries because
``ModelEntry`` has no engine field:

- ``provider == "nvcf"`` -> ``nvcf``
- ``provider == "litellm-remote"`` or ``cloud == true`` -> ``litellm-remote``
- ``extra.engine`` in ``{"vllm", "llamacpp", "litellm-remote", "nvcf"}`` wins
- local entries with ``extra.runner == "llamacpp"`` or ids containing
  ``llama``/``gguf`` -> ``llamacpp``
- remaining local entries -> ``vllm``
"""

from __future__ import annotations

import asyncio
import json
import os
import threading
from concurrent.futures import Future
from pathlib import Path
from typing import Any, Callable

from agentos_gateway.registry import DEFAULT_REGISTRY_PATH, ModelEntry, ModelRegistry, ROLE_NAMES

try:
    import asyncpg
except ImportError:  # pragma: no cover - exercised by main boot fallback
    asyncpg = None  # type: ignore[assignment]


class PgRegistryUnavailable(RuntimeError):
    pass


class _PgLoop:
    def __init__(self, dsn: str) -> None:
        if asyncpg is None:
            raise PgRegistryUnavailable("asyncpg is not installed")
        self.dsn = dsn
        self.loop = asyncio.new_event_loop()
        self._ready: Future[Any] = Future()
        self._thread = threading.Thread(target=self._run, name="gateway-pg-registry", daemon=True)
        self._thread.start()
        self.pool = self._ready.result(timeout=10)

    def _run(self) -> None:
        asyncio.set_event_loop(self.loop)
        try:
            pool = self.loop.run_until_complete(asyncpg.create_pool(self.dsn, min_size=1, max_size=4))
            self._ready.set_result(pool)
            self.loop.run_forever()
        except BaseException as exc:
            self._ready.set_exception(exc)

    def call(self, fn: Callable[..., Any], *args: Any) -> Any:
        return asyncio.run_coroutine_threadsafe(fn(*args), self.loop).result(timeout=30)

    async def close_async(self) -> None:
        await self.pool.close()

    def close(self) -> None:
        if self.loop.is_running():
            asyncio.run_coroutine_threadsafe(self.close_async(), self.loop).result(timeout=10)
            self.loop.call_soon_threadsafe(self.loop.stop)
        self._thread.join(timeout=10)


class PgModelRegistry:
    def __init__(self, dsn: str, registry_path: Path | None = None) -> None:
        self.dsn = dsn
        self.registry_path = registry_path or DEFAULT_REGISTRY_PATH
        self._pg = _PgLoop(dsn)
        self._models: dict[str, ModelEntry] = {}
        self._pg.call(self._ensure_seeded)
        self.load()

    def close(self) -> None:
        self._pg.close()

    def load(self) -> None:
        rows = self._pg.call(self._fetch_models)
        self._models = {}
        for row in rows:
            config = _json_value(row["config"])
            if "id" not in config:
                config["id"] = row["model_id"]
            if "enabled" not in config:
                config["enabled"] = bool(row["active"])
            self._models[row["model_id"]] = ModelEntry(config)

    def save(self) -> None:
        self._pg.call(self._replace_models, list(self._models.values()))

    def get(self, model_id: str) -> ModelEntry | None:
        return self._models.get(model_id)

    def list_all(self) -> list[ModelEntry]:
        return list(self._models.values())

    def list_enabled(self) -> list[ModelEntry]:
        return [m for m in self._models.values() if m.enabled]

    def list_by_role(self, role: str) -> list[ModelEntry]:
        return [m for m in self._models.values() if m.role == role and m.enabled]

    def add(self, entry: ModelEntry) -> None:
        self._models[entry.id] = entry
        self._pg.call(self._upsert_entry, entry)

    def remove(self, model_id: str) -> bool:
        if model_id not in self._models:
            return False
        del self._models[model_id]
        self._pg.call(self._delete_entry, model_id)
        return True

    def update(self, model_id: str, fields: dict[str, Any]) -> ModelEntry | None:
        entry = self._models.get(model_id)
        if entry is None:
            return None
        for key, value in fields.items():
            if hasattr(entry, key):
                setattr(entry, key, value)
        self._pg.call(self._upsert_entry, entry)
        return entry

    def record_health(self, model_id: str, healthy: bool, latency_ms: int | None, error: str | None = None) -> None:
        self._pg.call(self._upsert_health, model_id, healthy, latency_ms, error)

    async def _ensure_seeded(self) -> None:
        async with self._pg.pool.acquire() as conn:
            count = await conn.fetchval("SELECT count(*) FROM model_routes")
            if count:
                return
        seed = ModelRegistry(registry_path=self.registry_path)
        await self._replace_models(seed.list_all())

    async def _fetch_models(self) -> list[Any]:
        async with self._pg.pool.acquire() as conn:
            return await conn.fetch("SELECT model_id, active, config FROM model_routes ORDER BY model_id")

    async def _replace_models(self, entries: list[ModelEntry]) -> None:
        async with self._pg.pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute("DELETE FROM model_routes")
                for entry in entries:
                    await self._upsert_entry_conn(conn, entry)

    async def _upsert_entry(self, entry: ModelEntry) -> None:
        async with self._pg.pool.acquire() as conn:
            await self._upsert_entry_conn(conn, entry)

    async def _upsert_entry_conn(self, conn: Any, entry: ModelEntry) -> None:
        await conn.execute(
            """
            INSERT INTO model_routes (model_id, engine, active, config, updated_at)
            VALUES ($1, $2, $3, $4::jsonb, now())
            ON CONFLICT (model_id) DO UPDATE SET
                engine = EXCLUDED.engine,
                active = EXCLUDED.active,
                config = EXCLUDED.config,
                updated_at = now()
            """,
            entry.id,
            derive_engine(entry),
            entry.enabled,
            json.dumps(_entry_dict(entry)),
        )

    async def _delete_entry(self, model_id: str) -> None:
        async with self._pg.pool.acquire() as conn:
            await conn.execute("DELETE FROM model_routes WHERE model_id = $1", model_id)

    async def _upsert_health(self, model_id: str, healthy: bool, latency_ms: int | None, error: str | None) -> None:
        node = os.environ.get("ROMMIE_NODE_ID", "local") or "local"
        status = "healthy" if healthy else "unhealthy"
        async with self._pg.pool.acquire() as conn:
            route_id = await conn.fetchval("SELECT id FROM model_routes WHERE model_id = $1", model_id)
            if route_id is None:
                return
            previous = await conn.fetchrow(
                "SELECT error_count FROM model_health WHERE model_route_id = $1 AND node = $2",
                route_id,
                node,
            )
            error_count = 0 if healthy else (int(previous["error_count"]) + 1 if previous else 1)
            await conn.execute(
                """
                INSERT INTO model_health (
                    model_route_id, node, status, latency_ms, last_check, error_count, metadata, updated_at
                ) VALUES ($1, $2, $3, $4, now(), $5, $6::jsonb, now())
                ON CONFLICT (model_route_id, node) DO UPDATE SET
                    status = EXCLUDED.status,
                    latency_ms = EXCLUDED.latency_ms,
                    last_check = EXCLUDED.last_check,
                    error_count = EXCLUDED.error_count,
                    metadata = EXCLUDED.metadata,
                    updated_at = now()
                """,
                route_id,
                node,
                status,
                latency_ms,
                error_count,
                json.dumps({"error": error} if error else {}),
            )


class PgActiveRoleManager:
    def __init__(self, dsn: str, pg_loop: _PgLoop | None = None) -> None:
        self.dsn = dsn
        self._pg = pg_loop or _PgLoop(dsn)
        self._owns_pg = pg_loop is None
        self._active: dict[str, str | None] = {}
        self.load()

    def close(self) -> None:
        if self._owns_pg:
            self._pg.close()

    def load(self) -> None:
        rows = self._pg.call(self._fetch_active)
        self._active = {role: None for role in ROLE_NAMES}
        for row in rows:
            key = row["key"]
            role = key.removeprefix("active_role_")
            value = _json_value(row["value"])
            self._active[role] = value.get("model_id")

    def save(self) -> None:
        for role, model_id in self._active.items():
            self._pg.call(self._upsert_role, role, model_id)

    def get(self, role: str) -> str | None:
        return self._active.get(role)

    def set(self, role: str, model_id: str | None) -> str | None:
        previous = self._active.get(role)
        self._active[role] = model_id
        self._pg.call(self._upsert_role, role, model_id)
        return previous

    def set_scoped(
        self,
        layer: str,
        key: str,
        value: dict[str, Any],
        *,
        project_id: str = "",
        agent_id: str = "",
        node_id: str = "",
        session_id: str = "",
    ) -> None:
        self._pg.call(self._upsert_config, layer, project_id, agent_id, node_id, session_id, key, value)

    def get_scoped(
        self,
        layer: str,
        key: str,
        *,
        project_id: str = "",
        agent_id: str = "",
        node_id: str = "",
        session_id: str = "",
    ) -> dict[str, Any] | None:
        row = self._pg.call(self._fetch_config, layer, project_id, agent_id, node_id, session_id, key)
        return _json_value(row["value"]) if row else None

    def all(self) -> dict[str, str | None]:
        return dict(self._active)

    async def _fetch_active(self) -> list[Any]:
        async with self._pg.pool.acquire() as conn:
            return await conn.fetch(
                """
                SELECT key, value FROM config_projection
                WHERE layer = 'global'
                  AND project_id = '' AND agent_id = '' AND node_id = '' AND session_id = ''
                  AND key LIKE 'active_role_%'
                """
            )

    async def _upsert_role(self, role: str, model_id: str | None) -> None:
        await self._upsert_config("global", "", "", "", "", f"active_role_{role}", {"model_id": model_id})

    async def _fetch_config(
        self,
        layer: str,
        project_id: str,
        agent_id: str,
        node_id: str,
        session_id: str,
        key: str,
    ) -> Any:
        async with self._pg.pool.acquire() as conn:
            return await conn.fetchrow(
                """
                SELECT value FROM config_projection
                WHERE layer = $1 AND project_id = $2 AND agent_id = $3
                  AND node_id = $4 AND session_id = $5 AND key = $6
                """,
                layer,
                project_id,
                agent_id,
                node_id,
                session_id,
                key,
            )

    async def _upsert_config(
        self,
        layer: str,
        project_id: str,
        agent_id: str,
        node_id: str,
        session_id: str,
        key: str,
        value: dict[str, Any],
    ) -> None:
        async with self._pg.pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO config_projection (
                    layer, project_id, agent_id, node_id, session_id, key, value, precedence, source
                ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 0, 'gateway')
                ON CONFLICT (layer, project_id, agent_id, node_id, session_id, key) DO UPDATE SET
                    value = EXCLUDED.value,
                    source = EXCLUDED.source,
                    updated_at = now()
                """,
                layer,
                project_id,
                agent_id,
                node_id,
                session_id,
                key,
                json.dumps(value),
            )


def derive_engine(entry: ModelEntry) -> str:
    explicit = entry.extra.get("engine") if entry.extra else None
    if explicit in {"vllm", "llamacpp", "litellm-remote", "nvcf"}:
        return str(explicit)
    if entry.provider == "nvcf":
        return "nvcf"
    if entry.provider == "litellm-remote" or entry.cloud:
        return "litellm-remote"
    runner = str(entry.extra.get("runner", "")).lower() if entry.extra else ""
    if runner == "llamacpp" or "llama" in entry.id.lower() or "gguf" in entry.id.lower():
        return "llamacpp"
    return "vllm"


def _entry_dict(entry: ModelEntry) -> dict[str, Any]:
    return {
        "id": entry.id,
        "name": entry.name,
        "provider": entry.provider,
        "model": entry.model,
        "api_base": entry.api_base,
        "api_key": entry.api_key,
        "api_key_env": entry.api_key_env,
        "role": entry.role,
        "context_length": entry.context_length,
        "quant": entry.quant,
        "gpu": entry.gpu,
        "tensor_parallel": entry.tensor_parallel,
        "fallback_model": entry.fallback_model,
        "enabled": entry.enabled,
        "cloud": entry.cloud,
        "extra": entry.extra,
    }


def _json_value(value: Any) -> Any:
    if isinstance(value, str):
        return json.loads(value)
    return value
