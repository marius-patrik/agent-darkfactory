from __future__ import annotations

import asyncio
import json
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any

from genesis_os.config import WorkspacePaths
from genesis_os.storage import ArtifactStore, ExperienceLedger
from genesis_os.tools.base import CallableTool
from genesis_os.tools.context import ToolContext
from genesis_os.tools.python_tool import PythonProcessTool, validate_python_source
from genesis_os.tools.registry import ToolRegistry
from genesis_os.tools.spec import (
    Capability,
    DynamicToolManifest,
    ToolKind,
    ToolSpec,
    WorkflowDefinition,
)
from genesis_os.types import Actor, EventDraft, EventKind, new_id

_OBJECT = {"type": "object"}


def _safe_path(root: Path, relative: str) -> Path:
    candidate = (root / relative).resolve()
    root_resolved = root.resolve()
    if candidate != root_resolved and root_resolved not in candidate.parents:
        raise PermissionError(f"Path escapes workspace: {relative}")
    return candidate


def _spec(
    name: str,
    description: str,
    input_schema: dict[str, Any],
    *,
    output_schema: dict[str, Any] | None = None,
    capabilities: frozenset[Capability] = frozenset(),
    deterministic: bool = False,
    timeout_seconds: float = 15.0,
) -> ToolSpec:
    return ToolSpec(
        name=name,
        description=description,
        input_schema=input_schema,
        output_schema=output_schema or _OBJECT,
        capabilities=capabilities,
        deterministic=deterministic,
        timeout_seconds=timeout_seconds,
        kind=ToolKind.BUILTIN,
    )


async def _respond(context: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    text = str(arguments["text"])
    context.emit(text)
    event = context.ledger.append(
        EventDraft(
            kind=EventKind.MESSAGE,
            actor=Actor.ORGANISM,
            payload={"role": "assistant", "content": text},
            session_id=context.session_id,
            importance=0.75,
            source="respond.tool",
        )
    )
    return {"delivered": True, "message_id": event.id, "text": text}


async def _yield(context: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    context.flags["yielded"] = True
    return {"yielded": True, "reason": arguments.get("reason", "turn complete")}


async def _memory_append(context: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    event = context.ledger.append(
        EventDraft(
            kind=EventKind.MEMORY,
            actor=Actor.ORGANISM,
            payload={
                "namespace": arguments.get("namespace", "autobiographical"),
                "content": arguments["content"],
                "tags": arguments.get("tags", []),
                "confidence": arguments.get("confidence", 1.0),
                "supersedes": arguments.get("supersedes"),
            },
            session_id=context.session_id,
            importance=float(arguments.get("importance", 0.8)),
            source="memory.append.tool",
        )
    )
    return {"event_id": event.id, "sequence": event.sequence, "event_hash": event.event_hash}


async def _memory_search(context: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    events = context.ledger.search(
        str(arguments["query"]),
        limit=int(arguments.get("limit", context.settings.memory_results)),
        session_id=arguments.get("session_id"),
    )
    return {
        "matches": [
            {
                "event_id": event.id,
                "sequence": event.sequence,
                "timestamp": event.timestamp.isoformat(),
                "kind": event.kind.value,
                "actor": event.actor.value,
                "payload": event.payload,
                "importance": event.importance,
                "source": event.source,
            }
            for event in events
        ]
    }


async def _memory_get(context: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    event = context.ledger.get(str(arguments["event_id"]))
    return {"event": event.model_dump(mode="json")}


async def _memory_timeline(context: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    events = context.ledger.events(
        session_id=arguments.get("session_id"),
        after_sequence=int(arguments.get("after_sequence", 0)),
        limit=int(arguments.get("limit", 100)),
        descending=bool(arguments.get("descending", False)),
    )
    return {"events": [event.model_dump(mode="json") for event in events]}


async def _sleep_request(context: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    context.flags["sleep_requested"] = True
    context.flags["sleep_reason"] = arguments.get("reason", "organism requested consolidation")
    event = context.ledger.append(
        EventDraft(
            kind=EventKind.SLEEP_REQUEST,
            actor=Actor.ORGANISM,
            payload={"reason": context.flags["sleep_reason"]},
            session_id=context.session_id,
            importance=0.9,
            source="sleep.request.tool",
        )
    )
    return {"requested": True, "event_id": event.id}


async def _tool_list(context: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    registry: ToolRegistry = context.services["tool_registry"]
    return {"tools": registry.specs()}


async def _tool_describe(context: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    registry: ToolRegistry = context.services["tool_registry"]
    tool = registry.get(str(arguments["name"]))
    return {"tool": tool.spec.model_dump(mode="json")}


async def _tool_refresh(context: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    registry: ToolRegistry = context.services["tool_registry"]
    loaded = registry.refresh_dynamic()
    return {"loaded": loaded, "count": len(loaded)}


async def _tool_create_workflow(context: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    registry: ToolRegistry = context.services["tool_registry"]
    definition = WorkflowDefinition.model_validate(
        {"steps": arguments["steps"], "output": arguments.get("output", {})}
    )
    nested_capabilities: set[Capability] = {Capability.TOOL_INSTALL}
    for step in definition.steps:
        if step.tool == arguments["name"]:
            raise ValueError("A workflow cannot invoke itself")
        nested_capabilities.update(registry.get(step.tool).spec.capabilities)
    spec = ToolSpec(
        name=arguments["name"],
        version=arguments.get("version", "1.0.0"),
        description=arguments["description"],
        input_schema=arguments["input_schema"],
        output_schema=arguments.get("output_schema", _OBJECT),
        capabilities=frozenset(nested_capabilities),
        kind=ToolKind.WORKFLOW,
        timeout_seconds=float(arguments.get("timeout_seconds", 30.0)),
        deterministic=all(registry.get(step.tool).spec.deterministic for step in definition.steps),
        tags=tuple(arguments.get("tags", [])),
    )
    manifest = DynamicToolManifest(spec=spec, workflow=definition)
    package = context.paths.dynamic_tools / spec.name.replace(".", "__")
    if package.exists() and not bool(arguments.get("replace", False)):
        raise FileExistsError(f"Dynamic tool already exists: {spec.name}")
    temporary = Path(tempfile.mkdtemp(prefix="tool-", dir=context.paths.dynamic_tools))
    try:
        (temporary / "manifest.json").write_text(
            manifest.model_dump_json(indent=2), encoding="utf-8"
        )
        if package.exists():
            shutil.rmtree(package)
        os.replace(temporary, package)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    loaded = registry.refresh_dynamic()
    return {"installed": spec.name, "loaded": spec.name in loaded, "path": str(package)}


async def _tool_create_python(context: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    registry: ToolRegistry = context.services["tool_registry"]
    requested = frozenset(Capability(value) for value in arguments.get("capabilities", []))
    capabilities = requested | {Capability.CODE_EXECUTE, Capability.TOOL_INSTALL}
    source = str(arguments["source"])
    validate_python_source(source, capabilities)
    spec = ToolSpec(
        name=arguments["name"],
        version=arguments.get("version", "1.0.0"),
        description=arguments["description"],
        input_schema=arguments["input_schema"],
        output_schema=arguments.get("output_schema", _OBJECT),
        capabilities=capabilities,
        kind=ToolKind.PYTHON,
        timeout_seconds=float(arguments.get("timeout_seconds", 15.0)),
        deterministic=bool(arguments.get("deterministic", False)),
        tags=tuple(arguments.get("tags", [])),
    )
    manifest = DynamicToolManifest(
        spec=spec,
        entrypoint="tool.py",
        tests=tuple(arguments.get("tests", [])),
    )

    # Verify in a disposable workspace before installation.
    with tempfile.TemporaryDirectory(prefix="genesis-tool-verify-") as temporary_root:
        temp_root = Path(temporary_root)
        source_path = temp_root / "tool.py"
        source_path.write_text(source, encoding="utf-8")
        test_context = ToolContext(
            session_id=new_id("tooltest"),
            paths=WorkspacePaths.from_root(temp_root / "workspace"),
            settings=context.settings,
            ledger=ExperienceLedger(temp_root / "test.sqlite3"),
            artifacts=ArtifactStore(temp_root / "artifacts"),
        )
        test_context.paths.ensure()
        candidate = PythonProcessTool(spec=spec, source_path=source_path)
        for index, test in enumerate(manifest.tests):
            actual = await candidate.invoke(test_context, dict(test.get("input", {})))
            expected = test.get("expected")
            if expected is not None and actual != expected:
                raise AssertionError(
                    f"Dynamic tool test {index} failed: expected {expected!r}, got {actual!r}"
                )

    package = context.paths.dynamic_tools / spec.name.replace(".", "__")
    if package.exists() and not bool(arguments.get("replace", False)):
        raise FileExistsError(f"Dynamic tool already exists: {spec.name}")
    temporary = Path(tempfile.mkdtemp(prefix="tool-", dir=context.paths.dynamic_tools))
    try:
        (temporary / "manifest.json").write_text(
            manifest.model_dump_json(indent=2), encoding="utf-8"
        )
        (temporary / "tool.py").write_text(source, encoding="utf-8")
        if package.exists():
            shutil.rmtree(package)
        os.replace(temporary, package)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    loaded = registry.refresh_dynamic()
    return {"installed": spec.name, "loaded": spec.name in loaded, "path": str(package)}


async def _tool_remove(context: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    registry: ToolRegistry = context.services["tool_registry"]
    name = str(arguments["name"])
    package = context.paths.dynamic_tools / name.replace(".", "__")
    if not package.exists():
        raise FileNotFoundError(name)
    shutil.rmtree(package)
    loaded = registry.refresh_dynamic()
    return {"removed": name, "remaining_dynamic": loaded}


async def _workspace_read(context: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    path = _safe_path(context.workspace_root, str(arguments["path"]))
    limit = int(arguments.get("max_bytes", 1_000_000))
    data = path.read_bytes()
    if len(data) > limit:
        raise ValueError(f"File is {len(data)} bytes, exceeding max_bytes={limit}")
    return {"path": str(path.relative_to(context.workspace_root)), "content": data.decode("utf-8")}


async def _workspace_write(context: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    path = _safe_path(context.workspace_root, str(arguments["path"]))
    path.parent.mkdir(parents=True, exist_ok=True)
    content = str(arguments["content"])
    mode = "a" if bool(arguments.get("append", False)) else "w"
    with path.open(mode, encoding="utf-8") as handle:
        handle.write(content)
    digest = context.artifacts.put_bytes(path.read_bytes())
    return {
        "path": str(path.relative_to(context.workspace_root)),
        "bytes": path.stat().st_size,
        "artifact_hash": digest,
    }


async def _workspace_list(context: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    path = _safe_path(context.workspace_root, str(arguments.get("path", ".")))
    recursive = bool(arguments.get("recursive", False))
    limit = int(arguments.get("limit", 500))
    iterator = path.rglob("*") if recursive else path.iterdir()
    entries: list[dict[str, Any]] = []
    for item in iterator:
        if len(entries) >= limit:
            break
        entries.append(
            {
                "path": str(item.relative_to(context.workspace_root)),
                "type": "directory" if item.is_dir() else "file",
                "bytes": item.stat().st_size if item.is_file() else None,
            }
        )
    return {"entries": entries, "truncated": len(entries) >= limit}


async def _process_run(context: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    argv = [str(value) for value in arguments["argv"]]
    if not argv:
        raise ValueError("argv must not be empty")
    cwd = _safe_path(context.workspace_root, str(arguments.get("cwd", ".")))
    environment = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": str(context.workspace_root),
        "LANG": "C.UTF-8",
        "PYTHONIOENCODING": "utf-8",
    }
    for key, value in dict(arguments.get("env", {})).items():
        if key.startswith("GENESIS_") or key in {"PATH", "HOME", "LANG"}:
            environment[key] = str(value)
    process = await asyncio.create_subprocess_exec(
        *argv,
        cwd=str(cwd),
        env=environment,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    timeout = min(
        float(arguments.get("timeout_seconds", context.settings.tool_timeout_seconds)), 3600.0
    )
    stdin = str(arguments.get("stdin", "")).encode("utf-8")
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(stdin), timeout=timeout)
    except TimeoutError:
        process.kill()
        await process.wait()
        raise TimeoutError(f"Process timed out after {timeout}s") from None
    max_output = int(arguments.get("max_output_bytes", 2_000_000))
    if len(stdout) + len(stderr) > max_output:
        raise RuntimeError("Process output exceeded configured limit")
    return {
        "argv": argv,
        "returncode": process.returncode,
        "stdout": stdout.decode("utf-8", errors="replace"),
        "stderr": stderr.decode("utf-8", errors="replace"),
    }


async def _evolution_propose(context: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    proposal_id = new_id("proposal")
    directory = context.paths.state / "evolution_proposals"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{proposal_id}.json"
    payload = {
        "proposal_id": proposal_id,
        "target": arguments["target"],
        "rationale": arguments["rationale"],
        "mutation": arguments["mutation"],
        "evaluation_plan": arguments["evaluation_plan"],
        "status": "proposed",
    }
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    context.ledger.append(
        EventDraft(
            kind=EventKind.EVOLUTION,
            actor=Actor.ORGANISM,
            payload=payload,
            session_id=context.session_id,
            importance=0.9,
            source="evolution.propose.tool",
        )
    )
    return {"proposal_id": proposal_id, "path": str(path)}


async def _cognition_record(context: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    notes = context.flags.setdefault("working_notes", [])
    note = {
        "kind": arguments.get("kind", "note"),
        "content": arguments["content"],
        "confidence": float(arguments.get("confidence", 0.5)),
    }
    notes.append(note)
    return {"recorded": True, "index": len(notes) - 1, "note": note}


async def _cognition_inspect(context: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    return {"notes": list(context.flags.get("working_notes", []))}


async def _reality_simulate(context: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    simulator = context.services.get("reality_model")
    if simulator is None:
        raise RuntimeError("No reality_model service is attached to this runtime")
    return simulator.simulate(arguments)


def register_builtin_tools(registry: ToolRegistry) -> None:
    def required(*values: Capability) -> frozenset[Capability]:
        return frozenset(values)

    tools = [
        CallableTool(
            _spec(
                "communication.respond",
                "Deliver a message to the current user or environment. All organism speech uses this tool.",
                {
                    "type": "object",
                    "properties": {"text": {"type": "string", "minLength": 1}},
                    "required": ["text"],
                    "additionalProperties": False,
                },
                capabilities=required(Capability.EMIT_MESSAGE),
            ),
            _respond,
        ),
        CallableTool(
            _spec(
                "runtime.yield",
                "End the current wake turn without another external action.",
                {
                    "type": "object",
                    "properties": {"reason": {"type": "string"}},
                    "additionalProperties": False,
                },
                deterministic=True,
            ),
            _yield,
        ),
        CallableTool(
            _spec(
                "memory.append",
                "Append an explicit, provenance-preserving memory to the immutable autobiography.",
                {
                    "type": "object",
                    "properties": {
                        "content": {"type": "string", "minLength": 1},
                        "namespace": {"type": "string"},
                        "tags": {"type": "array", "items": {"type": "string"}},
                        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                        "importance": {"type": "number", "minimum": 0, "maximum": 1},
                        "supersedes": {"type": ["string", "null"]},
                    },
                    "required": ["content"],
                    "additionalProperties": False,
                },
                capabilities=required(Capability.MEMORY_WRITE),
            ),
            _memory_append,
        ),
        CallableTool(
            _spec(
                "memory.search",
                "Search exact autobiographical events and memories. Use this when precision or provenance matters.",
                {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "minLength": 1},
                        "limit": {"type": "integer", "minimum": 1, "maximum": 100},
                        "session_id": {"type": ["string", "null"]},
                    },
                    "required": ["query"],
                    "additionalProperties": False,
                },
                capabilities=required(Capability.MEMORY_READ),
                deterministic=True,
            ),
            _memory_search,
        ),
        CallableTool(
            _spec(
                "memory.get",
                "Read one exact event by its immutable event identifier.",
                {
                    "type": "object",
                    "properties": {"event_id": {"type": "string"}},
                    "required": ["event_id"],
                    "additionalProperties": False,
                },
                capabilities=required(Capability.MEMORY_READ),
                deterministic=True,
            ),
            _memory_get,
        ),
        CallableTool(
            _spec(
                "memory.timeline",
                "Read an ordered slice of the autobiographical ledger.",
                {
                    "type": "object",
                    "properties": {
                        "session_id": {"type": ["string", "null"]},
                        "after_sequence": {"type": "integer", "minimum": 0},
                        "limit": {"type": "integer", "minimum": 1, "maximum": 1000},
                        "descending": {"type": "boolean"},
                    },
                    "additionalProperties": False,
                },
                capabilities=required(Capability.MEMORY_READ),
                deterministic=True,
            ),
            _memory_timeline,
        ),
        CallableTool(
            _spec(
                "sleep.request",
                "Request a Sleep transaction. This does not mutate weights during Wake.",
                {
                    "type": "object",
                    "properties": {"reason": {"type": "string"}},
                    "additionalProperties": False,
                },
                capabilities=required(Capability.SLEEP_REQUEST),
            ),
            _sleep_request,
        ),
        CallableTool(
            _spec(
                "tool.list",
                "List every tool currently installed in the AI operating system.",
                {"type": "object", "additionalProperties": False},
                capabilities=required(Capability.MEMORY_READ),
                deterministic=True,
            ),
            _tool_list,
        ),
        CallableTool(
            _spec(
                "tool.describe",
                "Read the runtime manifest of one tool.",
                {
                    "type": "object",
                    "properties": {"name": {"type": "string"}},
                    "required": ["name"],
                    "additionalProperties": False,
                },
                capabilities=required(Capability.MEMORY_READ),
                deterministic=True,
            ),
            _tool_describe,
        ),
        CallableTool(
            _spec(
                "tool.refresh",
                "Reload dynamically installed tool manifests without restarting the organism.",
                {"type": "object", "additionalProperties": False},
                capabilities=required(Capability.TOOL_INSTALL),
            ),
            _tool_refresh,
        ),
        CallableTool(
            _spec(
                "tool.create_workflow",
                "Create and install a safe dynamic tool by composing existing tools into an audited workflow.",
                {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "version": {"type": "string"},
                        "description": {"type": "string"},
                        "input_schema": {"type": "object"},
                        "output_schema": {"type": "object"},
                        "steps": {"type": "array", "minItems": 1, "items": {"type": "object"}},
                        "output": {"type": "object"},
                        "timeout_seconds": {"type": "number", "minimum": 0.1},
                        "tags": {"type": "array", "items": {"type": "string"}},
                        "replace": {"type": "boolean"},
                    },
                    "required": ["name", "description", "input_schema", "steps"],
                    "additionalProperties": False,
                },
                capabilities=required(Capability.TOOL_INSTALL),
            ),
            _tool_create_workflow,
        ),
        CallableTool(
            _spec(
                "tool.create_python",
                "Create, verify in a disposable workspace, and install a gated Python subprocess tool.",
                {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "version": {"type": "string"},
                        "description": {"type": "string"},
                        "input_schema": {"type": "object"},
                        "output_schema": {"type": "object"},
                        "source": {"type": "string"},
                        "capabilities": {"type": "array", "items": {"type": "string"}},
                        "tests": {"type": "array", "items": {"type": "object"}},
                        "timeout_seconds": {"type": "number", "minimum": 0.1},
                        "deterministic": {"type": "boolean"},
                        "tags": {"type": "array", "items": {"type": "string"}},
                        "replace": {"type": "boolean"},
                    },
                    "required": ["name", "description", "input_schema", "source"],
                    "additionalProperties": False,
                },
                capabilities=required(Capability.CODE_EXECUTE, Capability.TOOL_INSTALL),
                timeout_seconds=60.0,
            ),
            _tool_create_python,
        ),
        CallableTool(
            _spec(
                "tool.remove",
                "Remove a dynamically installed tool package and refresh the registry.",
                {
                    "type": "object",
                    "properties": {"name": {"type": "string"}},
                    "required": ["name"],
                    "additionalProperties": False,
                },
                capabilities=required(Capability.TOOL_INSTALL),
            ),
            _tool_remove,
        ),
        CallableTool(
            _spec(
                "workspace.read",
                "Read a UTF-8 file inside the organism workspace.",
                {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "max_bytes": {"type": "integer", "minimum": 1, "maximum": 10000000},
                    },
                    "required": ["path"],
                    "additionalProperties": False,
                },
                capabilities=required(Capability.WORKSPACE_READ),
                deterministic=True,
            ),
            _workspace_read,
        ),
        CallableTool(
            _spec(
                "workspace.write",
                "Write or append a UTF-8 file inside the organism workspace and content-address it.",
                {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "content": {"type": "string"},
                        "append": {"type": "boolean"},
                    },
                    "required": ["path", "content"],
                    "additionalProperties": False,
                },
                capabilities=required(Capability.WORKSPACE_WRITE),
            ),
            _workspace_write,
        ),
        CallableTool(
            _spec(
                "workspace.list",
                "List files and directories inside the organism workspace.",
                {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "recursive": {"type": "boolean"},
                        "limit": {"type": "integer", "minimum": 1, "maximum": 5000},
                    },
                    "additionalProperties": False,
                },
                capabilities=required(Capability.WORKSPACE_READ),
                deterministic=True,
            ),
            _workspace_list,
        ),
        CallableTool(
            _spec(
                "process.run",
                "Run an argv-only subprocess in the workspace. Shell interpolation is never used.",
                {
                    "type": "object",
                    "properties": {
                        "argv": {"type": "array", "minItems": 1, "items": {"type": "string"}},
                        "cwd": {"type": "string"},
                        "env": {"type": "object", "additionalProperties": {"type": "string"}},
                        "stdin": {"type": "string"},
                        "timeout_seconds": {"type": "number", "minimum": 0.1, "maximum": 3600},
                        "max_output_bytes": {"type": "integer", "minimum": 1},
                    },
                    "required": ["argv"],
                    "additionalProperties": False,
                },
                capabilities=required(Capability.PROCESS_EXECUTE),
                timeout_seconds=3600.0,
            ),
            _process_run,
        ),
        CallableTool(
            _spec(
                "cognition.record",
                "Record a structured transient thought, hypothesis, decomposition, or uncertainty in working state.",
                {
                    "type": "object",
                    "properties": {
                        "kind": {
                            "enum": [
                                "note",
                                "goal",
                                "subproblem",
                                "hypothesis",
                                "prediction",
                                "uncertainty",
                                "critique",
                            ]
                        },
                        "content": {"type": "string", "minLength": 1},
                        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                    },
                    "required": ["content"],
                    "additionalProperties": False,
                },
                deterministic=True,
            ),
            _cognition_record,
        ),
        CallableTool(
            _spec(
                "cognition.inspect",
                "Inspect transient working-state notes recorded during the current Wake transaction.",
                {"type": "object", "additionalProperties": False},
                deterministic=True,
            ),
            _cognition_inspect,
        ),
        CallableTool(
            _spec(
                "reality.simulate",
                "Run probabilistic action-conditional latent simulations using the organism's learned reality model.",
                {
                    "type": "object",
                    "properties": {
                        "state": {"type": "string"},
                        "interventions": {
                            "type": "array",
                            "minItems": 1,
                            "items": {"type": "string"},
                        },
                        "horizon": {"type": "integer", "minimum": 1, "maximum": 256},
                        "samples": {"type": "integer", "minimum": 1, "maximum": 1024},
                        "seed": {"type": "integer"},
                    },
                    "required": ["state", "interventions"],
                    "additionalProperties": False,
                },
                deterministic=False,
                timeout_seconds=120.0,
            ),
            _reality_simulate,
        ),
        CallableTool(
            _spec(
                "evolution.propose",
                "Propose a versioned mutation to the model genome, curriculum, sleep program, or tool harness.",
                {
                    "type": "object",
                    "properties": {
                        "target": {"enum": ["model", "curriculum", "sleep", "tools", "evaluation"]},
                        "rationale": {"type": "string"},
                        "mutation": {"type": "object"},
                        "evaluation_plan": {"type": "object"},
                    },
                    "required": ["target", "rationale", "mutation", "evaluation_plan"],
                    "additionalProperties": False,
                },
                capabilities=required(Capability.EVOLUTION_PROPOSE),
            ),
            _evolution_propose,
        ),
    ]
    for tool in tools:
        registry.register(tool)
