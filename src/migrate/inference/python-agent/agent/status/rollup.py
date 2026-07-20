"""Parent-status roll-up by worst-wins precedence.

Precedence (highest first): ``failed > expired > blocked > missing_evidence >
no_artifact > unresolved > useful_result > released``.

A parent is ``useful_result`` only when **all** children are ``useful_result``
or ``released``.
"""

from __future__ import annotations

from agent.status.statuses import StatusValue

# Worst-wins precedence order.  Lower index = worse.
_PRECEDENCE: list[StatusValue] = [
    StatusValue.failed,
    StatusValue.expired,
    StatusValue.blocked,
    StatusValue.missing_evidence,
    StatusValue.no_artifact,
    StatusValue.unresolved,
    StatusValue.useful_result,
    StatusValue.released,
]

_RANK: dict[StatusValue, int] = {s: i for i, s in enumerate(_PRECEDENCE)}


def rollup(children: list[StatusValue]) -> StatusValue:
    """Roll up a list of child statuses into a parent status.

    Args:
        children: Child status values.

    Returns:
        The worst status by precedence, or ``released`` for an empty list.
    """
    if not children:
        return StatusValue.released
    return min(children, key=lambda s: _RANK[s])
