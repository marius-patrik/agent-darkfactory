"""Two-axis switcher surface (host + fabric/provider/model) — REST over the registry.

Design §06. VS1 exposes the switcher as plain REST endpoints reading/writing the
local registry + active-role state. The canonical contract is the Connect
``SwitcherService`` (``proto/rommie/v1/switchers.proto``); VS2 aligns this REST
surface to that protobuf service + cluster-synced state. Until then these
endpoints are the working control plane the TUI/CLI can drive.

Scope note (VS1): only the GLOBAL default scope is resolved/mutated. The
session > project > global resolution order (§06 SW2) lands in VS2.
"""

from __future__ import annotations

from typing import Any

from agentos_gateway.registry import ModelRegistry, ActiveRoleManager

# Axis 1 — tool host (§06 SW1). VS1 is single-host/local; the full host set is
# advertised but only the local edge is "available".
HOSTS = ("client", "gateway", "s001", "s002", "desktop", "mac")

# Axis 2 — fabric (§06 SW1). VS1 reaches LOCAL engines only; cluster/cloud are
# advertised-but-unavailable until VS2 (cluster) / cloud-OAuth (deferred).
FABRICS = ("cluster", "local", "cloud")

# The role aliases surfaced as part of the model axis options.
# NOTE: 'conversation' is intentionally excluded here. The design docs §01 G1
# and §06 SW1 enumerate the public role aliases as (general/coding/judge/
# embedding). 'conversation' exists as an INTERNAL routing role (conv-* models
# are reachable by model ID), but it is NOT exposed as a public routable alias
# until the Connect proto SwitcherService is co-authored in VS2 and the alias
# list is ratified in the design docs. Exposing it prematurely would create
# forward schema drift against the proto contract (§06 SW3).
ROLE_ALIASES = ("general", "coding", "judge", "embedding")


class SwitcherService:
    """Read/resolve the two-axis switcher state over the registry.

    VS1: in-process, global-scope only, no persistence of host/fabric/provider
    selection beyond the active-role pins the registry already stores. The
    selection here is advisory state that the TUI reads to render the status
    line; per-session/per-project scope is VS2.
    """

    def __init__(self, registry: ModelRegistry, active_roles: ActiveRoleManager) -> None:
        self.registry = registry
        self.active_roles = active_roles
        # VS1 defaults: local fabric (no cluster yet), gateway-selected host.
        self._state: dict[str, str | None] = {
            "host": "gateway",
            "fabric": "local",
            "provider": None,
            "model": None,
        }
        loader = getattr(self.active_roles, "get_scoped", None)
        if loader is not None:
            saved = loader("global", "switcher_state")
            if isinstance(saved, dict):
                self._state.update({k: saved.get(k, v) for k, v in self._state.items()})

    # --- state ---------------------------------------------------------------
    def get_state(self) -> dict[str, Any]:
        return {**self._state, "scope_source": "global"}

    def set_axis(
        self,
        axis: str,
        value: str,
        *,
        scope: str = "global",
        project_id: str = "",
        agent_id: str = "",
        node_id: str = "",
        session_id: str = "",
    ) -> dict[str, Any]:
        if axis not in ("host", "fabric", "provider", "model"):
            raise ValueError(f"unknown switcher axis '{axis}'")
        valid = {opt["value"] for opt in self.list_options(axis)}
        if value not in valid:
            raise ValueError(f"'{value}' is not a valid option for axis '{axis}'")
        # Setting a concrete model also pins it for its role (the registry's
        # existing active-role mechanism), so role-aliased traffic follows.
        if axis == "model":
            entry = self.registry.get(value)
            if entry is not None and entry.role in ROLE_ALIASES:
                self.active_roles.set(entry.role, value)
        self._state[axis] = value
        self._persist_state(scope, project_id=project_id, agent_id=agent_id, node_id=node_id, session_id=session_id)
        return self.get_state()

    def _persist_state(
        self,
        scope: str,
        *,
        project_id: str = "",
        agent_id: str = "",
        node_id: str = "",
        session_id: str = "",
    ) -> None:
        writer = getattr(self.active_roles, "set_scoped", None)
        if writer is None:
            return
        writer(
            scope,
            "switcher_state",
            dict(self._state),
            project_id=project_id if scope == "project" else "",
            agent_id=agent_id if scope == "agent" else "",
            node_id=node_id if scope == "node" else "",
            session_id=session_id if scope == "session" else "",
        )

    # --- options -------------------------------------------------------------
    def list_options(self, axis: str) -> list[dict[str, Any]]:
        if axis == "host":
            # VS1: only the local gateway edge is actually reachable.
            return [
                {
                    "value": h,
                    "label": h,
                    "available": h == "gateway",
                    "unavailable_reason": None if h == "gateway" else "vs2_cluster_pending",
                }
                for h in HOSTS
            ]
        if axis == "fabric":
            cloud_available = any(m.enabled and m.cloud for m in self.registry.list_all())
            return [
                {
                    "value": f,
                    "label": f,
                    "available": f == "local" or (f == "cloud" and cloud_available),
                    "unavailable_reason": None if (f == "local" or (f == "cloud" and cloud_available)) else (
                        "vs2_cluster_pending" if f == "cluster" else "cloud_disabled"
                    ),
                }
                for f in FABRICS
            ]
        if axis == "provider":
            if self._state.get("fabric") == "cloud":
                providers = sorted({
                    str(m.extra.get("oauth_provider") or m.extra.get("provider") or m.provider)
                    for m in self.registry.list_enabled()
                    if m.cloud
                })
            else:
                providers = sorted({
                    m.provider for m in self.registry.list_enabled() if not m.cloud
                })
            return [
                {"value": p, "label": p, "available": True, "unavailable_reason": None}
                for p in providers
            ]
        if axis == "model":
            # Model axis = the concrete enabled, non-cloud models + the role
            # aliases that resolve to them.
            opts: list[dict[str, Any]] = []
            for m in sorted(self.registry.list_enabled(), key=lambda e: e.id):
                if m.cloud:
                    continue
                opts.append({
                    "value": m.id,
                    "label": m.name,
                    "available": True,
                    "unavailable_reason": None,
                })
            served_roles = {
                m.role for m in self.registry.list_enabled()
                if not m.cloud and m.role in ROLE_ALIASES
            }
            for role in ROLE_ALIASES:
                opts.append({
                    "value": role,
                    "label": f"role:{role}",
                    "available": role in served_roles,
                    "unavailable_reason": None if role in served_roles else "no_model_for_role",
                })
            return opts
        raise ValueError(f"unknown switcher axis '{axis}'")
