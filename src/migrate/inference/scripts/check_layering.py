#!/usr/bin/env python3
"""Enforce the repository import layering contract."""

from __future__ import annotations

import argparse
import ast
import sys
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
def rel(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def fail(errors: list[str]) -> int:
    if not errors:
        return 0
    for error in errors:
        print(error, file=sys.stderr)
    return 1


def py_imports(path: Path) -> list[str]:
    tree = ast.parse(path.read_text(), filename=str(path))
    imports: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imports.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imports.append(node.module)
    return imports


def check_python(root: Path) -> list[str]:
    errors: list[str] = []
    forbidden = ("services", "clients", "plugins")
    paths = list(root.glob("agent/**/*.py")) + list(root.glob("python-agent/agent/**/*.py"))
    for path in paths:
        for imp in py_imports(path):
            if imp.startswith(forbidden):
                errors.append(f"{rel(path, root)}: agent may import only generated contract stubs, not {imp}")
    return errors


def main() -> int:
    if sys.version_info < (3, 10):
        print("check_layering.py needs Python >= 3.10 (repo sources use 3.12 syntax)", file=sys.stderr)
        return 2
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=REPO)
    args = parser.parse_args()
    root = args.root.resolve()
    errors = check_python(root)
    return fail(errors)


if __name__ == "__main__":
    raise SystemExit(main())
