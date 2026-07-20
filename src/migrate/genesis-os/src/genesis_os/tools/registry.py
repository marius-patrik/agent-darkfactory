from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from genesis_os.tools.base import Tool
from genesis_os.tools.python_tool import PythonProcessTool, validate_python_source
from genesis_os.tools.spec import DynamicToolManifest, ToolKind
from genesis_os.tools.workflow import WorkflowTool


class ToolRegistry:
    def __init__(self, dynamic_root: str | Path) -> None:
        self.dynamic_root = Path(dynamic_root)
        self.dynamic_root.mkdir(parents=True, exist_ok=True)
        self._tools: dict[str, Tool] = {}
        self._dynamic_names: set[str] = set()

    def register(self, tool: Tool, *, replace: bool = False, dynamic: bool = False) -> None:
        name = tool.spec.name
        if name in self._tools and not replace:
            raise KeyError(f"Tool already registered: {name}")
        self._tools[name] = tool
        if dynamic:
            self._dynamic_names.add(name)

    @property
    def dynamic_names(self) -> set[str]:
        return set(self._dynamic_names)

    def get(self, name: str) -> Tool:
        try:
            return self._tools[name]
        except KeyError as error:
            raise KeyError(f"Unknown tool: {name}") from error

    def list(self) -> list[Tool]:
        return [self._tools[name] for name in sorted(self._tools)]

    def specs(self) -> list[dict[str, Any]]:
        return [tool.spec.model_dump(mode="json") for tool in self.list()]

    def render_catalog(self) -> str:
        lines: list[str] = []
        for tool in self.list():
            spec = tool.spec
            lines.append(
                json.dumps(
                    {
                        "name": spec.name,
                        "description": spec.description,
                        "input_schema": spec.input_schema,
                    },
                    sort_keys=True,
                    separators=(",", ":"),
                )
            )
        return "\n".join(lines)

    def refresh_dynamic(self) -> list[str]:
        for name in tuple(self._dynamic_names):
            self._tools.pop(name, None)
        self._dynamic_names.clear()
        loaded: list[str] = []
        for manifest_path in sorted(self.dynamic_root.glob("*/manifest.json")):
            data = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest = DynamicToolManifest.model_validate(data)
            spec = manifest.spec
            if spec.kind == ToolKind.WORKFLOW:
                if manifest.workflow is None:
                    raise ValueError(f"Workflow tool lacks workflow definition: {spec.name}")
                tool: Tool = WorkflowTool(spec=spec, definition=manifest.workflow)
            elif spec.kind == ToolKind.PYTHON:
                if not manifest.entrypoint:
                    raise ValueError(f"Python tool lacks entrypoint: {spec.name}")
                source_path = (manifest_path.parent / manifest.entrypoint).resolve()
                if manifest_path.parent.resolve() not in source_path.parents:
                    raise ValueError(f"Python tool entrypoint escapes package: {spec.name}")
                source = source_path.read_text(encoding="utf-8")
                validate_python_source(source, spec.capabilities)
                tool = PythonProcessTool(spec=spec, source_path=source_path)
            else:
                raise ValueError(f"Dynamic manifests cannot declare builtin tools: {spec.name}")
            self.register(tool, dynamic=True)
            loaded.append(spec.name)
        return loaded
