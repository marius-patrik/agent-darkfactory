"""Private persistence helpers for inference worker runs."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from agent.state import ensure_private_dir


def append_event(session: Any, kind: str, payload: dict[str, Any], ts_unix: float | None = None) -> dict[str, Any]:
    """Append one redacted NDJSON event and return it."""
    event = {
        "seq": session.next_seq(),
        "kind": kind,
        "ts_unix": time.time() if ts_unix is None else ts_unix,
        "session_id": session.config.session_id,
        "payload": session.redactor.redact_obj(payload),
    }
    path = session.events_path
    ensure_private_dir(path.parent)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(event, sort_keys=True) + "\n")
    path.chmod(0o600)
    return event


def write_cascade_file(session: Any, name: str, content: str) -> Path:
    """Write a cascade context file."""
    path = session.context_dir / name
    ensure_private_dir(path.parent)
    path.write_text(content, encoding="utf-8")
    path.chmod(0o600)
    return path


def append_short(session: Any, content: str) -> None:
    """Append a redacted line to ``short.md``."""
    path = session.context_dir / "short.md"
    ensure_private_dir(path.parent)
    redacted = session.redactor.redact(str(content))
    with path.open("a", encoding="utf-8") as fh:
        fh.write(redacted.rstrip() + "\n")
    path.chmod(0o600)


def compact_short_to_context(session: Any, summary: str) -> None:
    """Append a structured compaction summary to context and clear short."""
    context = session.context_dir / "context.md"
    short = session.context_dir / "short.md"
    with context.open("a", encoding="utf-8") as fh:
        fh.write("\n## Compaction\n")
        fh.write(session.redactor.redact(summary).rstrip() + "\n")
    short.write_text("", encoding="utf-8")
    context.chmod(0o600)
    short.chmod(0o600)
    append_event(
        session,
        "session_event",
        {
            "session_event": {
                "kind": "SESSION_EVENT_KIND_COMPACTION",
                "compaction": {"turns_compacted": session.turn_count, "summary_label": "short-to-context"},
            }
        },
    )
