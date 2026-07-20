from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from genesis_os.config import RuntimeSettings, WorkspacePaths
from genesis_os.storage import ArtifactStore, ExperienceLedger


@dataclass(slots=True)
class ToolContext:
    session_id: str
    paths: WorkspacePaths
    settings: RuntimeSettings
    ledger: ExperienceLedger
    artifacts: ArtifactStore
    messages: list[str] = field(default_factory=list)
    flags: dict[str, Any] = field(default_factory=dict)
    services: dict[str, Any] = field(default_factory=dict)
    call_stack: list[str] = field(default_factory=list)

    @property
    def workspace_root(self) -> Path:
        return self.paths.root

    def emit(self, message: str) -> None:
        self.messages.append(message)
