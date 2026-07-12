"""Status state-machine + legal transitions.

The transition table is the runtime implementation of the canonical
``agent_os.v1.RunStatus`` result invariants:

* ``useful_result`` is produced ONLY by ``Trigger.check_pass``.
* Terminal states (``failed``, ``released``, ``expired``) have no outgoing
  transitions.
* ``useful_result`` cannot regress to ``unresolved`` / ``no_artifact`` /
  ``missing_evidence``.
* ``unresolved`` cannot jump directly to ``released``.
"""

from __future__ import annotations

from enum import Enum

from agent.status.statuses import StatusValue


class Trigger(str, Enum):
    """Events that drive status transitions.

    Attributes:
        created: A new run is created (T1).
        check_pass: Acceptance-check passed (T2/T8).
        check_no_artifact: Validator found no artifact (T3).
        check_missing_evidence: Artifact exists but proof is insufficient (T4).
        check_fail: Hard/structural acceptance failure (T5/T9/T13).
        remediate: Remediation dispatched, re-attempt the run (T6/T7).
        release: Write-claims released and result integrated (T10).
        block: External dependency blocks progress (T11).
        unblock: Dependency cleared, resume from stored state (T12).
        ttl_lapse: Claim or run TTL expired (T14/T15).
        non_progress: No new validated artifact across attempts (T5/T9).
        dependency_unsatisfiable: External dependency permanently unsatisfiable (T13).
    """

    created = "created"
    check_pass = "check_pass"
    check_no_artifact = "check_no_artifact"
    check_missing_evidence = "check_missing_evidence"
    check_fail = "check_fail"
    remediate = "remediate"
    release = "release"
    block = "block"
    unblock = "unblock"
    ttl_lapse = "ttl_lapse"
    non_progress = "non_progress"
    dependency_unsatisfiable = "dependency_unsatisfiable"


class IllegalTransition(ValueError):
    """Raised when a status transition violates the state-machine invariants.

    Attributes:
        current: The state the transition started from.
        trigger: The trigger that was requested.
    """

    def __init__(self, current: StatusValue, trigger: Trigger) -> None:
        super().__init__(f"Illegal transition {current.value!r} via {trigger.value!r}")
        self.current = current
        self.trigger = trigger


# Authority: (from_state, trigger) -> to_state.  The ``unblock`` trigger is
# special: the destination is the stored ``unblock_from`` state (default
# ``unresolved``), so it is not encoded as a fixed target here.
TRANSITIONS: dict[tuple[StatusValue, Trigger], StatusValue] = {
    # T1 is handled by ``create_run()``; ``created`` is not a normal transition.

    # T2: unresolved -> useful_result on passing acceptance.
    (StatusValue.unresolved, Trigger.check_pass): StatusValue.useful_result,
    # T3: unresolved -> no_artifact.
    (StatusValue.unresolved, Trigger.check_no_artifact): StatusValue.no_artifact,
    # T4: unresolved -> missing_evidence.
    (StatusValue.unresolved, Trigger.check_missing_evidence): StatusValue.missing_evidence,
    # T5: unresolved -> failed (hard fail / non-progress kill).
    (StatusValue.unresolved, Trigger.check_fail): StatusValue.failed,
    (StatusValue.unresolved, Trigger.non_progress): StatusValue.failed,

    # T6: no_artifact -> unresolved (remediation).
    (StatusValue.no_artifact, Trigger.remediate): StatusValue.unresolved,
    # T7: missing_evidence -> unresolved (remediation).
    (StatusValue.missing_evidence, Trigger.remediate): StatusValue.unresolved,
    # T8: re-check passes after remediation.
    (StatusValue.no_artifact, Trigger.check_pass): StatusValue.useful_result,
    (StatusValue.missing_evidence, Trigger.check_pass): StatusValue.useful_result,
    # T9: remediation exhausted / acceptance now impossible.
    (StatusValue.no_artifact, Trigger.check_fail): StatusValue.failed,
    (StatusValue.no_artifact, Trigger.non_progress): StatusValue.failed,
    (StatusValue.missing_evidence, Trigger.check_fail): StatusValue.failed,
    (StatusValue.missing_evidence, Trigger.non_progress): StatusValue.failed,

    # T10: useful_result -> released.
    (StatusValue.useful_result, Trigger.release): StatusValue.released,

    # T11: block any recoverable state.
    (StatusValue.unresolved, Trigger.block): StatusValue.blocked,
    (StatusValue.no_artifact, Trigger.block): StatusValue.blocked,
    (StatusValue.missing_evidence, Trigger.block): StatusValue.blocked,

    # T13: blocked -> failed (dependency unsatisfiable).
    (StatusValue.blocked, Trigger.check_fail): StatusValue.failed,
    (StatusValue.blocked, Trigger.dependency_unsatisfiable): StatusValue.failed,
    (StatusValue.blocked, Trigger.non_progress): StatusValue.failed,

    # T14: any non-terminal (except useful_result) -> expired.
    (StatusValue.unresolved, Trigger.ttl_lapse): StatusValue.expired,
    (StatusValue.no_artifact, Trigger.ttl_lapse): StatusValue.expired,
    (StatusValue.missing_evidence, Trigger.ttl_lapse): StatusValue.expired,
    (StatusValue.blocked, Trigger.ttl_lapse): StatusValue.expired,

    # T15: useful_result -> expired (result superseded + validity window lapsed).
    (StatusValue.useful_result, Trigger.ttl_lapse): StatusValue.expired,
}


def transition(
    current: StatusValue,
    trigger: Trigger,
    *,
    unblock_from: StatusValue | None = None,
) -> StatusValue:
    """Apply one legal status transition.

    Args:
        current: The present status of the run.
        trigger: The event driving the transition.
        unblock_from: The state to restore when ``trigger`` is ``unblock``.
            Defaults to ``unresolved``.  Ignored for other triggers.

    Returns:
        The new status value.

    Raises:
        IllegalTransition: If the requested transition is not in the authority
            table or violates an explicit invariant.
    """
    if current.is_terminal():
        raise IllegalTransition(current, trigger)

    if trigger == Trigger.unblock:
        if current != StatusValue.blocked:
            raise IllegalTransition(current, trigger)
        target = unblock_from or StatusValue.unresolved
        # T12 may only restore into a recoverable state — the only states `block`
        # (T11) can fire from. Without this guard, unblock_from=useful_result/released
        # would mint a success state with NO acceptance check, bypassing the founding
        # no-false-green invariant (only check_pass may produce useful_result).
        if target not in (
            StatusValue.unresolved,
            StatusValue.no_artifact,
            StatusValue.missing_evidence,
        ):
            raise IllegalTransition(current, trigger)
        return target

    key = (current, trigger)
    if key not in TRANSITIONS:
        raise IllegalTransition(current, trigger)

    return TRANSITIONS[key]


def create_run() -> StatusValue:
    """Return the status for a newly created run (T1).

    Returns:
        ``StatusValue.unresolved``.
    """
    return StatusValue.unresolved
