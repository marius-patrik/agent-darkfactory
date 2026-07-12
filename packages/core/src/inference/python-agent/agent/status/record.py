"""Run records and the in-process status store.

Verdict history is append-only: superseding verdicts append, never overwrite
to preserve audit history.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from agent.status.acceptance import SourceState, Verdict
from agent.status.machine import Trigger
from agent.status.statuses import StatusValue


@dataclass
class RunRecord:
    """System-of-record for a single run.

    Attributes:
        run_id: Unique run identifier.
        parent_id: Optional parent run/job identifier.
        task_type: Registered task type.
        status: Current status value.
        status_reason: Human-readable reason for the current status.
        unblock_from: State to restore when unblocking (default unresolved).
        acceptance_ref: Reference to the acceptance declaration.
        verdict: Latest acceptance verdict.
        source_state: OR3 source-separated buckets.
        claim_ids: Active write-scope claim identifiers.
        ttl: Optional claim/run TTL in seconds.
        updated_at: Unix timestamp of last update.
        verdict_history: Append-only list of all verdicts.
    """

    run_id: str
    parent_id: str | None
    task_type: str
    status: StatusValue
    status_reason: str
    unblock_from: StatusValue | None = None
    acceptance_ref: str | None = None
    verdict: Verdict | None = None
    source_state: SourceState = field(default_factory=SourceState)
    claim_ids: list[str] = field(default_factory=list)
    ttl: float | None = None
    updated_at: float | None = None
    verdict_history: list[Verdict] = field(default_factory=list)

    def append_verdict(self, verdict: Verdict) -> None:
        """Append a verdict to the immutable history.

        Args:
            verdict: Verdict to record.
        """
        self.verdict = verdict
        self.verdict_history.append(verdict)


@runtime_checkable
class StatusStore(Protocol):
    """Persistence seam for run status records and transition events."""

    def persist(self, record: RunRecord) -> None:
        """Persist ``record`` to the store.

        Args:
            record: Run record to persist.
        """
        ...

    def emit_transition(
        self,
        run_id: str,
        frm: StatusValue,
        to: StatusValue,
        trigger: Trigger,
        by: str,
        verdict_summary: str,
    ) -> None:
        """Emit a transition event.

        Args:
            run_id: Run identifier.
            frm: Previous status.
            to: New status.
            trigger: Event that drove the transition.
            by: Worker/role that fired the trigger.
            verdict_summary: Short summary of the verdict, if any.
        """
        ...


class InMemoryStatusStore(StatusStore):
    """In-memory store for tests + single-node default.

    Attributes:
        records: Map of run_id -> RunRecord.
        events: Append-only list of transition events.
    """

    def __init__(self) -> None:
        self.records: dict[str, RunRecord] = {}
        self.events: list[dict[str, Any]] = []

    def persist(self, record: RunRecord) -> None:
        """Persist ``record`` in memory."""
        self.records[record.run_id] = record

    def emit_transition(
        self,
        run_id: str,
        frm: StatusValue,
        to: StatusValue,
        trigger: Trigger,
        by: str,
        verdict_summary: str,
    ) -> None:
        """Append a transition event to the in-memory log."""
        self.events.append(
            {
                "run_id": run_id,
                "from": frm.value,
                "to": to.value,
                "trigger": trigger.value,
                "by": by,
                "verdict_summary": verdict_summary,
            }
        )
