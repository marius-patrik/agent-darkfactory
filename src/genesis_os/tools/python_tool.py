from __future__ import annotations

import ast
import asyncio
import json
import os
import resource
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from genesis_os.tools.context import ToolContext
from genesis_os.tools.spec import Capability, ToolSpec

_ALWAYS_DENIED_IMPORTS = {
    "ctypes",
    "multiprocessing",
    "pty",
    "resource",
    "signal",
}


class PythonToolSecurityError(ValueError):
    pass


def validate_python_source(source: str, capabilities: frozenset[Capability]) -> None:
    tree = ast.parse(source)
    denied = set(_ALWAYS_DENIED_IMPORTS)
    if Capability.PROCESS_EXECUTE not in capabilities:
        denied.update({"subprocess"})
    if Capability.NETWORK_ACCESS not in capabilities:
        denied.update({"socket", "ssl", "urllib", "http", "ftplib"})
    if not ({Capability.WORKSPACE_READ, Capability.WORKSPACE_WRITE} & capabilities):
        denied.update({"pathlib", "os", "shutil", "glob", "tempfile"})
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names = [alias.name.split(".")[0] for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            names = [node.module.split(".")[0]] if node.module else []
        else:
            names = []
        for name in names:
            if name in denied:
                raise PythonToolSecurityError(
                    f"Import is not allowed for requested capabilities: {name}"
                )
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id in {"eval", "exec", "compile", "__import__"}
        ):
            raise PythonToolSecurityError(f"Dynamic code primitive is not allowed: {node.func.id}")
    functions = [node for node in tree.body if isinstance(node, ast.FunctionDef)]
    if not any(function.name == "run" for function in functions):
        raise PythonToolSecurityError("Python tool must define run(arguments, context)")


def _limits(cpu_seconds: int, memory_bytes: int) -> None:
    resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds + 1))
    resource.setrlimit(resource.RLIMIT_AS, (memory_bytes, memory_bytes))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    resource.setrlimit(resource.RLIMIT_NPROC, (16, 16))


@dataclass(slots=True)
class PythonProcessTool:
    spec: ToolSpec
    source_path: Path

    async def invoke(self, context: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
        runner = r"""
import importlib.util, json, pathlib, resource, sys
cpu_seconds = int(sys.argv[2])
memory_bytes = int(sys.argv[3])
resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds + 1))
resource.setrlimit(resource.RLIMIT_AS, (memory_bytes, memory_bytes))
resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
resource.setrlimit(resource.RLIMIT_NPROC, (16, 16))
source = pathlib.Path(sys.argv[1]).resolve()
spec = importlib.util.spec_from_file_location("genesis_dynamic_tool", source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
payload = json.loads(sys.stdin.read())
result = module.run(payload["arguments"], payload["context"])
if not isinstance(result, dict):
    raise TypeError("run() must return a dict")
sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
"""
        environment = {
            "PATH": os.environ.get("PATH", ""),
            "PYTHONIOENCODING": "utf-8",
            "GENESIS_WORKSPACE": str(context.workspace_root),
        }
        payload = json.dumps(
            {
                "arguments": arguments,
                "context": {
                    "session_id": context.session_id,
                    "workspace": str(context.workspace_root),
                },
            }
        ).encode("utf-8")
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-I",
            "-c",
            runner,
            str(self.source_path),
            str(max(1, int(self.spec.timeout_seconds))),
            str(512 * 1024 * 1024),
            cwd=str(self.source_path.parent),
            env=environment,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(
                process.communicate(payload), timeout=self.spec.timeout_seconds
            )
        except TimeoutError:
            process.kill()
            await process.wait()
            raise TimeoutError(f"Dynamic Python tool timed out: {self.spec.name}") from None
        if len(stdout) > 4 * 1024 * 1024 or len(stderr) > 1024 * 1024:
            raise RuntimeError("Dynamic tool exceeded output limits")
        if process.returncode != 0:
            detail = stderr.decode("utf-8", errors="replace")[-4000:]
            raise RuntimeError(f"Dynamic Python tool failed ({process.returncode}): {detail}")
        value = json.loads(stdout.decode("utf-8"))
        if not isinstance(value, dict):
            raise TypeError("Dynamic Python tool output must be an object")
        return value
