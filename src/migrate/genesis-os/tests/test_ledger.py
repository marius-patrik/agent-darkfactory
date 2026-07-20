from __future__ import annotations

import sqlite3

import pytest

from genesis_os.storage import ExperienceLedger
from genesis_os.types import Actor, EventDraft, EventKind


def test_ledger_is_hash_chained_and_immutable(tmp_path):
    ledger = ExperienceLedger(tmp_path / "ledger.sqlite3")
    first = ledger.append(
        EventDraft(
            kind=EventKind.OBSERVATION,
            actor=Actor.USER,
            payload={"content": "alpha"},
            session_id="s1",
        )
    )
    second = ledger.append(
        EventDraft(
            kind=EventKind.MEMORY,
            actor=Actor.ORGANISM,
            payload={"content": "beta"},
            session_id="s1",
        )
    )
    assert second.previous_hash == first.event_hash
    assert ledger.verify() == (True, [])
    assert ledger.search("beta")[0].id == second.id

    connection = sqlite3.connect(tmp_path / "ledger.sqlite3")
    with pytest.raises(sqlite3.IntegrityError):
        connection.execute("UPDATE events SET source = 'tampered' WHERE id = ?", (first.id,))
    with pytest.raises(sqlite3.IntegrityError):
        connection.execute("DELETE FROM events WHERE id = ?", (first.id,))
