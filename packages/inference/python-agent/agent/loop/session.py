"""Run orchestration for the single inference worker loop."""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from agent.loop.acceptance_gate import evaluate
from agent.loop.gateway_client import GatewayClient, LoopError
from agent.loop.permissions import PermissionMode
from agent.loop.persistence import append_event, write_cascade_file
from agent.loop.turn import run_turn
from agent.redaction import Redactor
from agent.state import ensure_private_dir, inference_runs_dir
from agent.status import InMemoryStatusStore, RunRecord, StatusValue, Trigger, create_run, transition


@dataclass
class SessionConfig:
    """Configuration for one worker run."""

    session_id: str
    agent_id: str
    goal: str
    task: str
    acceptance_type: str
    declared_outputs: list[str] = field(default_factory=list)
    build_cmd: list[str] | None = None
    test_cmd: list[str] | None = None
    model: str = "qwen3-8b"
    max_turns: int = 12
    workdir: Path = field(default_factory=Path.cwd)
    gateway_url: str | None = None
    permission_mode: PermissionMode = PermissionMode.full_auto


@dataclass
class LoopOutcome:
    """Structured result printed by the CLI."""

    status: StatusValue
    run_record: RunRecord
    declared_outputs: list[str]
    summary: str

    def to_json_dict(self) -> dict[str, Any]:
        """Return a JSON-friendly representation."""
        return {
            "status": self.status.value,
            "run_id": self.run_record.run_id,
            "declared_outputs": self.declared_outputs,
            "summary": self.summary,
            "status_reason": self.run_record.status_reason,
            "verdict": self.run_record.verdict.outcome if self.run_record.verdict else None,
        }


@dataclass
class Session:
    """Mutable state for one loop run."""

    config: SessionConfig
    gateway_client: GatewayClient
    redactor: Redactor
    status_store: InMemoryStatusStore
    run_record: RunRecord
    context_window: int
    context_budget: int
    messages: list[dict[str, Any]] = field(default_factory=list)
    written_paths: set[str] = field(default_factory=set)
    turn_count: int = 0
    _seq: int = 0

    @property
    def root(self) -> Path:
        return inference_runs_dir() / self.config.session_id

    @property
    def context_dir(self) -> Path:
        return self.root / "context"

    @property
    def events_path(self) -> Path:
        return self.root / "events.ndjson"

    def next_seq(self) -> int:
        """Return the next event sequence number."""
        self._seq += 1
        return self._seq

    def add_written_path(self, path: str) -> None:
        """Record a path produced by a write-capable tool."""
        self.written_paths.add(path)


async def run_session(config: SessionConfig) -> LoopOutcome:
    """Create and run one worker to acceptance."""
    session = await _start_session(config)
    stopped = False
    try:
        while session.turn_count < config.max_turns:
            result = await run_turn(session)
            if not result.needs_another_turn:
                stopped = True
                break
    except LoopError as exc:
        return _fail_session(session, f"loop_error: {session.redactor.redact(str(exc))}")
    except AssertionError:
        # Never swallow invariant/test assertions into a silent `failed` — those signal
        # a real bug (and would make redaction/no-false-green tests vacuous). Surface them.
        raise
    except Exception as exc:  # defensive terminalization of unexpected operational errors
        return _fail_session(session, f"unexpected_error: {session.redactor.redact(str(exc))}")

    if stopped:
        record = evaluate(session)
    else:
        old = session.run_record.status
        new = transition(old, Trigger.non_progress)
        session.run_record.status = new
        session.run_record.status_reason = f"max_turns exceeded: {config.max_turns}"
        session.run_record.updated_at = time.time()
        session.status_store.persist(session.run_record)
        session.status_store.emit_transition(
            session.run_record.run_id,
            old,
            new,
            Trigger.non_progress,
            by="worker",
            verdict_summary=session.run_record.status_reason,
        )
        append_event(
            session,
            "status",
            {"status": {"state": new.value, "detail": session.run_record.status_reason, "run_status": new.value}},
        )
        record = session.run_record

    declared = sorted(set(config.declared_outputs) | set(session.written_paths))
    if record.status == StatusValue.useful_result:
        write_cascade_file(session, "handoff.md", f"Status: useful_result\nOutputs: {declared}\n")
    append_event(session, "session_event", {"session_event": {"kind": "SESSION_EVENT_KIND_WORKER", "worker": {"worker_id": config.agent_id, "role": "worker", "parent": config.session_id, "status": record.status.value, "model": config.model, "phase": "closed", "claim": "", "claim_ttl_seconds": 0, "activity": record.status_reason}}})
    return LoopOutcome(status=record.status, run_record=record, declared_outputs=declared, summary=record.status_reason)


def _fail_session(session: Session, reason: str) -> LoopOutcome:
    old = session.run_record.status
    new = transition(old, Trigger.check_fail)
    session.run_record.status = new
    session.run_record.status_reason = reason
    session.run_record.updated_at = time.time()
    session.status_store.persist(session.run_record)
    session.status_store.emit_transition(
        session.run_record.run_id,
        old,
        new,
        Trigger.check_fail,
        by="worker",
        verdict_summary=reason,
    )
    append_event(
        session,
        "status",
        {"status": {"state": new.value, "detail": reason, "run_status": new.value}},
    )
    append_event(session, "session_event", {"session_event": {"kind": "SESSION_EVENT_KIND_WORKER", "worker": {"worker_id": session.config.agent_id, "role": "worker", "parent": session.config.session_id, "status": new.value, "model": session.config.model, "phase": "closed", "claim": "", "claim_ttl_seconds": 0, "activity": reason}}})
    declared = sorted(set(session.config.declared_outputs) | set(session.written_paths))
    return LoopOutcome(status=new, run_record=session.run_record, declared_outputs=declared, summary=reason)


async def _start_session(config: SessionConfig) -> Session:
    config.workdir = Path(config.workdir).expanduser().resolve()
    if Path(config.session_id).name != config.session_id or config.session_id in {"", ".", ".."}:
        raise ValueError("session_id contains unsafe path characters")
    gateway_client = GatewayClient(config.gateway_url)
    context_window = await _context_window(gateway_client, config.model)
    output_reserve = min(max(int(context_window * 0.25), 4096), 32768)
    context_budget = max(context_window - output_reserve - 512, 1024)
    root = inference_runs_dir() / config.session_id
    ensure_private_dir(root / "context")
    status = create_run()
    record = RunRecord(
        run_id=config.session_id,
        parent_id=None,
        task_type=config.acceptance_type,
        status=status,
        status_reason="created",
        updated_at=time.time(),
    )
    store = InMemoryStatusStore()
    store.persist(record)
    session = Session(
        config=config,
        gateway_client=gateway_client,
        redactor=Redactor.from_secrets_dir(),
        status_store=store,
        run_record=record,
        context_window=context_window,
        context_budget=context_budget,
    )
    write_cascade_file(session, "goal.md", config.goal)
    write_cascade_file(session, "task.md", config.task)
    write_cascade_file(session, "plan.md", "1. Complete the task with tools.\n2. Validate declared artifacts via acceptance gate.")
    write_cascade_file(session, "short.md", "")
    write_cascade_file(session, "context.md", "")
    append_event(session, "status", {"status": {"state": status.value, "detail": "created", "run_status": status.value}})
    return session


async def _context_window(gateway_client: GatewayClient, model: str) -> int:
    try:
        return await gateway_client.model_context_length(model) or 32768
    except LoopError:
        return 32768


def outcome_to_json(outcome: LoopOutcome) -> str:
    """Serialize an outcome."""
    return json.dumps(outcome.to_json_dict(), sort_keys=True)
