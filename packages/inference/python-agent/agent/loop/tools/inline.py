"""Deterministic host-bound inference worker tools."""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path
from typing import Any


ToolResult = dict[str, str | bool]


def read_file(args: dict[str, Any]) -> ToolResult:
    """Read a UTF-8 file."""
    try:
        path = _resolve(args["path"], args)
        return {"output": path.read_text(encoding="utf-8"), "is_error": False}
    except Exception as exc:
        return {"output": str(exc), "is_error": True}


def write_file(args: dict[str, Any]) -> ToolResult:
    """Write UTF-8 content to a file, creating parents as needed."""
    try:
        path = _resolve(args["path"], args)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(str(args.get("content", "")), encoding="utf-8")
        return {"output": f"wrote {path}", "is_error": False}
    except Exception as exc:
        return {"output": str(exc), "is_error": True}


def edit_file(args: dict[str, Any]) -> ToolResult:
    """Replace one exact text span in a UTF-8 file."""
    try:
        path = _resolve(args["path"], args)
        old = str(args["old"])
        new = str(args["new"])
        content = path.read_text(encoding="utf-8")
        if old not in content:
            return {"output": "old text not found", "is_error": True}
        path.write_text(content.replace(old, new, 1), encoding="utf-8")
        return {"output": f"edited {path}", "is_error": False}
    except Exception as exc:
        return {"output": str(exc), "is_error": True}


def ls(args: dict[str, Any]) -> ToolResult:
    """List directory entries."""
    try:
        path = _resolve(args.get("path", "."), args)
        entries = sorted(os.listdir(path))
        return {"output": "\n".join(entries), "is_error": False}
    except Exception as exc:
        return {"output": str(exc), "is_error": True}


def bash(args: dict[str, Any]) -> ToolResult:
    """Run a shell command through bash intentionally."""
    try:
        timeout = float(args.get("timeout", 120))
        result = subprocess.run(
            [_bash_executable(), "-lc", str(args["command"])],
            cwd=str(_cwd(args)),
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        output = result.stdout + result.stderr
        if result.returncode != 0:
            output = f"exit_code={result.returncode}\n{output}"
        return {"output": output, "is_error": result.returncode != 0}
    except subprocess.TimeoutExpired:
        return {"output": f"timeout after {args.get('timeout', 120)}s", "is_error": True}
    except Exception as exc:
        return {"output": str(exc), "is_error": True}


def _bash_executable() -> str:
    """Resolve a real Bash runtime without selecting the Windows WSL relay."""
    if os.name != "nt":
        return shutil.which("bash") or "bash"

    candidates: list[Path] = []
    program_files = os.environ.get("ProgramFiles")
    if program_files:
        candidates.extend(
            [
                Path(program_files) / "Git" / "bin" / "bash.exe",
                Path(program_files) / "Git" / "usr" / "bin" / "bash.exe",
            ]
        )
    git = shutil.which("git")
    if git:
        git_dir = Path(git).resolve().parent
        candidates.extend([git_dir / "bash.exe", git_dir.parent / "bin" / "bash.exe"])
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    return shutil.which("bash") or "bash"


def _cwd(args: dict[str, Any]) -> Path:
    return Path(str(args.get("_cwd") or os.getcwd())).expanduser().resolve()


def _resolve(path: object, args: dict[str, Any]) -> Path:
    candidate = Path(str(path)).expanduser()
    if candidate.is_absolute():
        return candidate
    return _cwd(args) / candidate
