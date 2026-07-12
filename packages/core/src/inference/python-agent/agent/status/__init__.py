"""No-false-green status state-machine + acceptance-check contract.

Public API for the runtime backbone that enforces: a command exiting 0 does
NOT earn ``useful_result`` — only a passed acceptance-check over a validated
artifact does.
"""

from agent.status.acceptance import (
    AcceptanceCheck,
    Artifact,
    CheckResult,
    CodeChangeValidator,
    Evidence,
    GenericArtifactValidator,
    RunContext,
    SourceState,
    Verdict,
    get_validator,
    register_validator,
    run_acceptance,
    verdict_to_trigger,
)
from agent.status.defaults import register_default_validators
from agent.status.machine import (
    IllegalTransition,
    Trigger,
    create_run,
    transition,
)
from agent.status.record import (
    InMemoryStatusStore,
    RunRecord,
    StatusStore,
)
from agent.status.rollup import rollup
from agent.status.statuses import (
    StatusValue,
    from_proto,
    to_proto,
)

register_default_validators()

__all__ = [
    "StatusValue",
    "Trigger",
    "transition",
    "IllegalTransition",
    "create_run",
    "AcceptanceCheck",
    "Verdict",
    "CheckResult",
    "SourceState",
    "Artifact",
    "Evidence",
    "RunContext",
    "register_validator",
    "get_validator",
    "run_acceptance",
    "verdict_to_trigger",
    "GenericArtifactValidator",
    "CodeChangeValidator",
    "register_default_validators",
    "rollup",
    "RunRecord",
    "StatusStore",
    "InMemoryStatusStore",
    "to_proto",
    "from_proto",
]
