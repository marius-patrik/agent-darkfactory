from __future__ import annotations

from dataclasses import dataclass

from genesis_os.config import RuntimeSettings
from genesis_os.tools.spec import Capability, ToolSpec


@dataclass(frozen=True, slots=True)
class ToolPolicy:
    allowed: frozenset[Capability]

    @classmethod
    def from_settings(cls, settings: RuntimeSettings) -> ToolPolicy:
        allowed = {
            Capability.EMIT_MESSAGE,
            Capability.MEMORY_READ,
            Capability.MEMORY_WRITE,
            Capability.WORKSPACE_READ,
            Capability.WORKSPACE_WRITE,
            Capability.SLEEP_REQUEST,
            Capability.EVOLUTION_PROPOSE,
            Capability.TOOL_INSTALL,
        }
        if settings.allow_process_tools:
            allowed.add(Capability.PROCESS_EXECUTE)
        if settings.allow_network_tools:
            allowed.add(Capability.NETWORK_ACCESS)
        if settings.allow_python_tools:
            allowed.add(Capability.CODE_EXECUTE)
        return cls(frozenset(allowed))

    def check(self, spec: ToolSpec) -> None:
        denied = sorted(capability.value for capability in spec.capabilities - self.allowed)
        if denied:
            raise PermissionError(
                f"Tool {spec.name} requests capabilities not granted by runtime policy: {denied}"
            )
