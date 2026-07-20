"""Trace output: structured, append-only, machine-readable events."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from llm_gateway.state import gateway_runtime_dir


class TraceLogger:
    def __init__(self, trace_dir: Path | None = None) -> None:
        self.trace_dir = trace_dir or gateway_runtime_dir() / "traces"
        self.trace_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.trace_dir, 0o700)
        self._file = self._open_file()

    def _open_file(self) -> Any:
        date_stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        path = self.trace_dir / f"gateway-{date_stamp}.jsonl"
        handle = open(path, "a", encoding="utf-8", buffering=1)
        os.chmod(path, 0o600)
        return handle

    def log(
        self,
        trace_id: str,
        event_type: str,
        model_id: str | None = None,
        role: str | None = None,
        duration_ms: float | None = None,
        tokens_in: int | None = None,
        tokens_out: int | None = None,
        error: str | None = None,
        request_id: str | None = None,
        requested_model: str | None = None,
        requested_role: str | None = None,
        resolved_model_id: str | None = None,
        provider: str | None = None,
        backend_type: str | None = None,
        backend_api_base: str | None = None,
        backend_node_id: str | None = None,
        served_model: str | None = None,
        resource_class: str | None = None,
        response_status: str | None = None,
        http_status: int | None = None,
        extra: dict[str, Any] | None = None,
    ) -> None:
        event = {
            "trace_id": trace_id,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "event_type": event_type,
            "model_id": model_id,
            "role": role,
            "requested_model": requested_model,
            "requested_role": requested_role,
            "resolved_model_id": resolved_model_id,
            "provider": provider,
            "backend_type": backend_type,
            "backend_api_base": backend_api_base,
            "backend_node_id": backend_node_id,
            "served_model": served_model,
            "resource_class": resource_class,
            "response_status": response_status,
            "http_status": http_status,
            "duration_ms": round(duration_ms, 2) if duration_ms is not None else None,
            "tokens_in": tokens_in,
            "tokens_out": tokens_out,
            "error": error,
            "request_id": request_id,
            "extra": extra or {},
        }
        # Strip None for compactness
        event = {k: v for k, v in event.items() if v is not None}
        self._file.write(json.dumps(event, default=str) + "\n")
        self._file.flush()

    def close(self) -> None:
        self._file.close()
