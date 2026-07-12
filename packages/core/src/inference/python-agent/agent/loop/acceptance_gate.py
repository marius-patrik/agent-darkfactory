"""No-false-green acceptance gate for inference worker runs."""

from __future__ import annotations

import time
from typing import Any

from agent.loop.persistence import append_event
from agent.status import RunContext, RunRecord, run_acceptance, transition, verdict_to_trigger


def evaluate(session: Any) -> RunRecord:
    """Run deterministic acceptance and persist the resulting transition."""
    record = session.run_record
    declared = sorted(set(session.config.declared_outputs) | set(session.written_paths))
    run = RunContext(
        run_id=session.config.session_id,
        task_type=session.config.acceptance_type,
        workdir=session.config.workdir,
        declared_outputs=declared,
        metadata={"agent_id": session.config.agent_id},
    )
    acceptance = {"type": session.config.acceptance_type}
    if session.config.build_cmd:
        acceptance["build_cmd"] = session.config.build_cmd
    if session.config.test_cmd:
        acceptance["test_cmd"] = session.config.test_cmd
    verdict = run_acceptance(run, acceptance)
    trigger = verdict_to_trigger(verdict)
    old = record.status
    new = transition(old, trigger)
    record.status = new
    record.status_reason = verdict.notes
    record.source_state = verdict.source_state
    record.updated_at = time.time()
    record.append_verdict(verdict)
    session.status_store.persist(record)
    session.status_store.emit_transition(
        record.run_id,
        old,
        new,
        trigger,
        by="acceptance_gate",
        verdict_summary=verdict.notes,
    )
    append_event(
        session,
        "status",
        {
            "status": {"state": new.value, "detail": verdict.notes, "run_status": new.value},
            "trigger": trigger.value,
            "verdict": {"outcome": verdict.outcome, "notes": verdict.notes},
        },
    )
    return record
