#!/usr/bin/env python3
"""Assert each planted layering violation is caught."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "check_layering.py"
FIXTURES = {
    "python": REPO / "tests" / "layering" / "fixtures" / "python",
}


def main() -> int:
    for name, fixture in FIXTURES.items():
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--root", str(fixture)],
            cwd=REPO,
            text=True,
            capture_output=True,
            check=False,
        )
        if result.returncode == 0:
            print(f"{name} planted violation was not caught", file=sys.stderr)
            return 1
        print(f"{name} planted violation caught")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
