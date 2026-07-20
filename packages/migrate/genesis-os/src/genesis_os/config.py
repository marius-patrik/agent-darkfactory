from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field


class WorkspacePaths(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    root: Path
    database: Path
    artifacts: Path
    lineages: Path
    datasets: Path
    dynamic_tools: Path
    state: Path
    logs: Path

    @classmethod
    def from_root(cls, root: str | Path) -> WorkspacePaths:
        root_path = Path(root).expanduser().resolve()
        return cls(
            root=root_path,
            database=root_path / "genesis.sqlite3",
            artifacts=root_path / "artifacts",
            lineages=root_path / "lineages",
            datasets=root_path / "datasets",
            dynamic_tools=root_path / "tools",
            state=root_path / "state",
            logs=root_path / "logs",
        )

    def ensure(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        for directory in (
            self.artifacts,
            self.lineages,
            self.datasets,
            self.dynamic_tools,
            self.state,
            self.logs,
        ):
            directory.mkdir(parents=True, exist_ok=True)


class RuntimeSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    max_tool_steps: int = Field(default=8, ge=1, le=128)
    max_generation_tokens: int = Field(default=384, ge=16, le=8192)
    temperature: float = Field(default=0.7, ge=0.0, le=2.0)
    top_p: float = Field(default=0.95, gt=0.0, le=1.0)
    memory_results: int = Field(default=8, ge=0, le=100)
    allow_python_tools: bool = False
    allow_process_tools: bool = False
    allow_network_tools: bool = False
    tool_timeout_seconds: float = Field(default=15.0, gt=0.0, le=3600.0)
