"""Expose generated Agent OS protobuf modules to their absolute imports."""

from __future__ import annotations

import sys
from pathlib import Path

_GEN_ROOT = str(Path(__file__).resolve().parent)
if _GEN_ROOT not in sys.path:
    sys.path.insert(0, _GEN_ROOT)
