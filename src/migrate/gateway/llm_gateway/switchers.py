"""Runtime switcher state backed by live gateway registry and cluster data."""

from __future__ import annotations

import os

from agent_os.v1.common_pb import Fabric, Host, Model, Node, Provider, SwitcherAxis, SwitcherScope, SwitcherState
from agent_os.v1.switchers_pb import SwitcherOption
from connectrpc.code import Code
from connectrpc.errors import ConnectError

from llm_gateway.registry import ModelEntry, ModelRegistry, is_local_entry


def cluster_hosts(registry: ModelRegistry) -> dict[str, bool]:
    hosts: dict[str, bool] = {}
    for raw in os.environ.get("GATEWAY_CLUSTER_HOSTS", "").split(","):
        item = raw.strip()
        if item:
            hosts[item.split("=", 1)[0].strip()] = True
    for entry in registry.list_all():
        node = entry.extra.get("node_id") or entry.extra.get("backend_node_id")
        if isinstance(node, str) and node:
            hosts[node] = hosts.get(node, False) or entry.enabled
    return hosts


def entry_fabric(entry: ModelEntry) -> Fabric:
    if entry.extra.get("node_id") or entry.extra.get("backend_node_id"):
        return Fabric.CLUSTER
    return Fabric.LOCAL if is_local_entry(entry) else Fabric.CLOUD


class SwitcherStore:
    """Resolve global/project/session overrides without mutating other axes."""

    def __init__(self, registry: ModelRegistry) -> None:
        self.registry = registry
        first = next(iter(registry.list_enabled()), None)
        self._global = SwitcherState(
            host="gateway",
            fabric=entry_fabric(first) if first else Fabric.LOCAL,
            provider=first.provider if first else "local",
            model=first.id if first else "",
            agent=os.environ.get("GATEWAY_DEFAULT_AGENT", "rommie"),
            scope_source=SwitcherScope.GLOBAL,
        )
        self._project: dict[str, object] = {}
        self._sessions: dict[str, dict[str, object]] = {}

    def state(self, session_id: str = "") -> SwitcherState:
        return self._resolved_state(include_project=True, session_id=session_id)

    def clear_session(self, session_id: str) -> None:
        self._sessions.pop(session_id, None)

    def seed_session(self, session_id: str, desired: SwitcherState) -> SwitcherState:
        previous = dict(self._sessions[session_id]) if session_id in self._sessions else None
        try:
            updates = (
                (SwitcherAxis.FABRIC, desired.fabric.name.lower() if desired.fabric is not Fabric.UNSPECIFIED else ""),
                (SwitcherAxis.PROVIDER, desired.provider),
                (SwitcherAxis.MODEL, desired.model),
                (SwitcherAxis.HOST, desired.host),
                (SwitcherAxis.AGENT, desired.agent),
            )
            state = self.state(session_id)
            for axis, value in updates:
                if value:
                    state = self.set(axis, value, SwitcherScope.SESSION, session_id)
            return state
        except Exception:
            if previous is None:
                self._sessions.pop(session_id, None)
            else:
                self._sessions[session_id] = previous
            raise

    def set(self, axis: SwitcherAxis, value: str, scope: SwitcherScope, session_id: str = "") -> SwitcherState:
        if axis is SwitcherAxis.UNSPECIFIED:
            raise ConnectError(Code.INVALID_ARGUMENT, "switcher axis is required")
        if scope is SwitcherScope.UNSPECIFIED:
            raise ConnectError(Code.INVALID_ARGUMENT, "switcher scope is required")
        if scope is SwitcherScope.SESSION and not session_id:
            raise ConnectError(Code.INVALID_ARGUMENT, "session_id is required for session scope")
        current = self._state_for_scope(scope, session_id)
        valid = {option.value for option in self._options_for_state(axis, current) if option.available}
        if value not in valid:
            raise ConnectError(Code.INVALID_ARGUMENT, f"{value!r} is not an available {axis.name.lower()} option")

        changes: dict[str, object] = {}
        if axis is SwitcherAxis.FABRIC:
            fabric = _fabric(value)
            candidates = self._route_entries(fabric)
            if not candidates:
                raise ConnectError(Code.INVALID_ARGUMENT, f"no enabled route is available for fabric {value!r}")
            changes.update(fabric=fabric, provider=candidates[0].provider, model=candidates[0].id)
        elif axis is SwitcherAxis.PROVIDER:
            candidates = self._route_entries(current.fabric, value)
            if not candidates:
                raise ConnectError(Code.INVALID_ARGUMENT, f"no enabled model is available for provider {value!r}")
            changes.update(provider=value, model=candidates[0].id)
        else:
            changes[_axis_field(axis)] = value
        if scope is SwitcherScope.SESSION:
            self._sessions.setdefault(session_id, {}).update(changes)
        elif scope is SwitcherScope.PROJECT:
            self._project.update(changes)
        else:
            values = _state_values(self._global)
            values.update(changes)
            self._global = self._make_state(values, SwitcherScope.GLOBAL)
        return self._state_for_scope(scope, session_id)

    def options(self, axis: SwitcherAxis, session_id: str = "") -> list[SwitcherOption]:
        return self._options_for_state(axis, self.state(session_id))

    def _options_for_state(self, axis: SwitcherAxis, state: SwitcherState) -> list[SwitcherOption]:
        if axis is SwitcherAxis.HOST:
            hosts = [SwitcherOption(value="gateway", label="gateway", available=True)]
            hosts.extend(
                SwitcherOption(value=name, label=name, available=online, unavailable_reason="node_offline" if not online else "")
                for name, online in sorted(cluster_hosts(self.registry).items())
            )
            return hosts
        if axis is SwitcherAxis.FABRIC:
            entries = self.registry.list_all()
            available = {entry_fabric(entry) for entry in entries if entry.enabled}
            if cluster_hosts(self.registry):
                available.add(Fabric.CLUSTER)
            return [
                SwitcherOption(
                    value=fabric.name.lower(),
                    label=fabric.name.lower(),
                    available=fabric in available or fabric is Fabric.LOCAL,
                    unavailable_reason="fabric_unavailable" if fabric not in available and fabric is not Fabric.LOCAL else "",
                )
                for fabric in (Fabric.LOCAL, Fabric.CLUSTER, Fabric.CLOUD)
            ]
        if axis is SwitcherAxis.PROVIDER:
            providers = sorted({entry.provider for entry in self.registry.list_enabled() if entry_fabric(entry) == state.fabric})
            return [SwitcherOption(value=value, label=value, available=True) for value in providers]
        if axis is SwitcherAxis.MODEL:
            return [
                SwitcherOption(value=entry.id, label=entry.name, available=entry.enabled, unavailable_reason="model_unavailable" if not entry.enabled else "")
                for entry in self.registry.list_all()
                if entry_fabric(entry) == state.fabric and entry.provider == state.provider
            ]
        if axis is SwitcherAxis.AGENT:
            agents = [item.strip() for item in os.environ.get("GATEWAY_AGENTS", "rommie,claude,codex,kimi,agy").split(",") if item.strip()]
            return [SwitcherOption(value=value, label=value, available=True) for value in agents]
        raise ConnectError(Code.INVALID_ARGUMENT, "switcher axis is required")

    def _state_for_scope(self, scope: SwitcherScope, session_id: str) -> SwitcherState:
        if scope is SwitcherScope.GLOBAL:
            return _copy_state(self._global)
        if scope is SwitcherScope.PROJECT:
            return self._resolved_state(include_project=True)
        return self.state(session_id)

    def _resolved_state(self, *, include_project: bool, session_id: str = "") -> SwitcherState:
        values = _state_values(self._global)
        source = SwitcherScope.GLOBAL
        if include_project and self._project:
            values.update(self._project)
            source = SwitcherScope.PROJECT
        session = self._sessions.get(session_id) if session_id else None
        if session:
            values.update(session)
            source = SwitcherScope.SESSION
        return self._make_state(values, source)

    def _make_state(self, values: dict[str, object], source: SwitcherScope) -> SwitcherState:
        fabric = values["fabric"]
        if not isinstance(fabric, Fabric):
            raise RuntimeError("resolved switcher fabric must be a Fabric enum")
        provider = str(values["provider"])
        model = str(values["model"])
        matching = [
            entry
            for entry in self._route_entries(fabric, provider)
            if entry.id == model
        ]
        if not matching:
            candidates = self._route_entries(fabric, provider) or self._route_entries(fabric)
            if candidates:
                provider = candidates[0].provider
                model = candidates[0].id
        return SwitcherState(
            host=str(values["host"]),
            fabric=fabric,
            provider=provider,
            model=model,
            agent=str(values["agent"]),
            scope_source=source,
        )

    def _route_entries(self, fabric: Fabric, provider: str | None = None) -> list[ModelEntry]:
        return [
            entry
            for entry in self.registry.list_enabled()
            if entry_fabric(entry) == fabric and (provider is None or entry.provider == provider)
        ]

    def hosts(self) -> list[Host]:
        return [Host(id="gateway", label="gateway", online=True)] + [
            Host(id=name, label=name, online=online) for name, online in sorted(cluster_hosts(self.registry).items())
        ]

    def nodes(self) -> list[Node]:
        return [Node(id=name, role="inference", online=online) for name, online in sorted(cluster_hosts(self.registry).items())]

    def models(self) -> list[Model]:
        return [
            Model(
                id=entry.id,
                provider_id=entry.provider,
                fabric=entry_fabric(entry),
                role=entry.role,
                context_length=entry.context_length,
                quant=entry.quant or "",
                enabled=entry.enabled,
                cloud=entry_fabric(entry) is Fabric.CLOUD,
            )
            for entry in self.registry.list_all()
        ]

    def providers(self) -> list[Provider]:
        items: dict[tuple[str, Fabric], bool] = {}
        for entry in self.registry.list_all():
            fabric = entry_fabric(entry)
            key = (entry.provider, fabric)
            items[key] = items.get(key, False) or entry.enabled
        return [
            Provider(id=provider, label=provider, fabric=fabric, enabled=enabled)
            for (provider, fabric), enabled in sorted(items.items(), key=lambda item: (item[0][0], item[0][1].value))
        ]


def _copy_state(state: SwitcherState) -> SwitcherState:
    return SwitcherState(
        host=state.host,
        fabric=state.fabric,
        provider=state.provider,
        model=state.model,
        agent=state.agent,
        scope_source=state.scope_source,
    )


def _state_values(state: SwitcherState) -> dict[str, object]:
    return {
        "host": state.host,
        "fabric": state.fabric,
        "provider": state.provider,
        "model": state.model,
        "agent": state.agent,
        "scope_source": state.scope_source,
    }


def _axis_field(axis: SwitcherAxis) -> str:
    return {
        SwitcherAxis.HOST: "host",
        SwitcherAxis.FABRIC: "fabric",
        SwitcherAxis.PROVIDER: "provider",
        SwitcherAxis.MODEL: "model",
        SwitcherAxis.AGENT: "agent",
    }[axis]


def _fabric(value: str) -> Fabric:
    try:
        return Fabric[value.upper()]
    except KeyError as exc:
        raise ConnectError(Code.INVALID_ARGUMENT, f"unknown fabric {value!r}") from exc
