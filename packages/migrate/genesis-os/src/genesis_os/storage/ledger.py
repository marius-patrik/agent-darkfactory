from __future__ import annotations

import hashlib
import sqlite3
import threading
from collections.abc import Iterable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import orjson

from genesis_os.types import Actor, Event, EventDraft, EventKind, new_id

GENESIS_HASH = "0" * 64


def _canonical_json(value: Any) -> bytes:
    return orjson.dumps(value, option=orjson.OPT_SORT_KEYS)


def _event_digest(record: dict[str, Any]) -> str:
    return hashlib.sha256(_canonical_json(record)).hexdigest()


class ExperienceLedger:
    """Append-only, hash-chained autobiographical event ledger backed by SQLite."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._local = threading.local()
        self._initialize()

    def _connection(self) -> sqlite3.Connection:
        connection = getattr(self._local, "connection", None)
        if connection is None:
            connection = sqlite3.connect(self.path, timeout=30.0, isolation_level=None)
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA synchronous=FULL")
            connection.execute("PRAGMA foreign_keys=ON")
            self._local.connection = connection
        return connection

    def _initialize(self) -> None:
        connection = sqlite3.connect(self.path)
        try:
            connection.executescript(
                """
                PRAGMA journal_mode=WAL;
                PRAGMA synchronous=FULL;
                CREATE TABLE IF NOT EXISTS events (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    id TEXT NOT NULL UNIQUE,
                    timestamp TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    actor TEXT NOT NULL,
                    payload_json BLOB NOT NULL,
                    session_id TEXT NOT NULL,
                    causation_id TEXT,
                    correlation_id TEXT,
                    importance REAL NOT NULL,
                    source TEXT,
                    previous_hash TEXT NOT NULL,
                    event_hash TEXT NOT NULL UNIQUE
                );
                CREATE INDEX IF NOT EXISTS idx_events_session_sequence
                    ON events(session_id, sequence);
                CREATE INDEX IF NOT EXISTS idx_events_kind_sequence
                    ON events(kind, sequence);
                CREATE TRIGGER IF NOT EXISTS events_no_update
                    BEFORE UPDATE ON events
                    BEGIN SELECT RAISE(ABORT, 'events are immutable'); END;
                CREATE TRIGGER IF NOT EXISTS events_no_delete
                    BEFORE DELETE ON events
                    BEGIN SELECT RAISE(ABORT, 'events are immutable'); END;
                CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
                    event_id UNINDEXED,
                    text,
                    tokenize='unicode61 remove_diacritics 2'
                );
                """
            )
            connection.commit()
        finally:
            connection.close()

    def append(self, draft: EventDraft) -> Event:
        connection = self._connection()
        connection.execute("BEGIN IMMEDIATE")
        try:
            previous = connection.execute(
                "SELECT event_hash FROM events ORDER BY sequence DESC LIMIT 1"
            ).fetchone()
            previous_hash = str(previous["event_hash"]) if previous else GENESIS_HASH
            event_id = new_id("event")
            timestamp = datetime.now(UTC).isoformat()
            digest_record = {
                "id": event_id,
                "timestamp": timestamp,
                "kind": draft.kind.value,
                "actor": draft.actor.value,
                "payload": draft.payload,
                "session_id": draft.session_id,
                "causation_id": draft.causation_id,
                "correlation_id": draft.correlation_id,
                "importance": draft.importance,
                "source": draft.source,
                "previous_hash": previous_hash,
            }
            event_hash = _event_digest(digest_record)
            payload_json = _canonical_json(draft.payload)
            cursor = connection.execute(
                """
                INSERT INTO events(
                    id, timestamp, kind, actor, payload_json, session_id,
                    causation_id, correlation_id, importance, source,
                    previous_hash, event_hash
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    event_id,
                    timestamp,
                    draft.kind.value,
                    draft.actor.value,
                    sqlite3.Binary(payload_json),
                    draft.session_id,
                    draft.causation_id,
                    draft.correlation_id,
                    draft.importance,
                    draft.source,
                    previous_hash,
                    event_hash,
                ),
            )
            sequence = int(cursor.lastrowid)
            fts_text = self._extract_search_text(draft.payload)
            connection.execute(
                "INSERT INTO events_fts(event_id, text) VALUES (?, ?)", (event_id, fts_text)
            )
            connection.execute("COMMIT")
        except Exception:
            connection.execute("ROLLBACK")
            raise
        return Event(
            id=event_id,
            sequence=sequence,
            timestamp=datetime.fromisoformat(timestamp),
            kind=draft.kind,
            actor=draft.actor,
            payload=draft.payload,
            session_id=draft.session_id,
            causation_id=draft.causation_id,
            correlation_id=draft.correlation_id,
            importance=draft.importance,
            source=draft.source,
            previous_hash=previous_hash,
            event_hash=event_hash,
        )

    def append_many(self, drafts: Iterable[EventDraft]) -> list[Event]:
        return [self.append(draft) for draft in drafts]

    @staticmethod
    def _extract_search_text(payload: dict[str, Any]) -> str:
        chunks: list[str] = []

        def walk(value: Any) -> None:
            if isinstance(value, str):
                chunks.append(value)
            elif isinstance(value, dict):
                for key, item in value.items():
                    chunks.append(str(key))
                    walk(item)
            elif isinstance(value, list):
                for item in value:
                    walk(item)
            elif value is not None:
                chunks.append(str(value))

        walk(payload)
        return "\n".join(chunks)

    @staticmethod
    def _row_to_event(row: sqlite3.Row) -> Event:
        return Event(
            id=str(row["id"]),
            sequence=int(row["sequence"]),
            timestamp=datetime.fromisoformat(str(row["timestamp"])),
            kind=EventKind(str(row["kind"])),
            actor=Actor(str(row["actor"])),
            payload=orjson.loads(row["payload_json"]),
            session_id=str(row["session_id"]),
            causation_id=row["causation_id"],
            correlation_id=row["correlation_id"],
            importance=float(row["importance"]),
            source=row["source"],
            previous_hash=str(row["previous_hash"]),
            event_hash=str(row["event_hash"]),
        )

    def get(self, event_id: str) -> Event:
        row = (
            self._connection().execute("SELECT * FROM events WHERE id = ?", (event_id,)).fetchone()
        )
        if row is None:
            raise KeyError(event_id)
        return self._row_to_event(row)

    def events(
        self,
        *,
        session_id: str | None = None,
        kinds: Iterable[EventKind] | None = None,
        after_sequence: int = 0,
        limit: int = 1000,
        descending: bool = False,
    ) -> list[Event]:
        clauses = ["sequence > ?"]
        parameters: list[Any] = [after_sequence]
        if session_id is not None:
            clauses.append("session_id = ?")
            parameters.append(session_id)
        kind_values = [kind.value for kind in kinds] if kinds is not None else []
        if kind_values:
            placeholders = ",".join("?" for _ in kind_values)
            clauses.append(f"kind IN ({placeholders})")
            parameters.extend(kind_values)
        order = "DESC" if descending else "ASC"
        parameters.append(limit)
        rows = self._connection().execute(
            f"SELECT * FROM events WHERE {' AND '.join(clauses)} ORDER BY sequence {order} LIMIT ?",
            parameters,
        )
        return [self._row_to_event(row) for row in rows]

    def search(self, query: str, *, limit: int = 10, session_id: str | None = None) -> list[Event]:
        if not query.strip():
            return []
        parameters: list[Any] = [query]
        session_clause = ""
        if session_id is not None:
            session_clause = "AND e.session_id = ?"
            parameters.append(session_id)
        parameters.append(limit)
        try:
            rows = self._connection().execute(
                f"""
                SELECT e.*
                FROM events_fts f
                JOIN events e ON e.id = f.event_id
                WHERE events_fts MATCH ? {session_clause}
                ORDER BY bm25(events_fts), e.importance DESC, e.sequence DESC
                LIMIT ?
                """,
                parameters,
            )
        except sqlite3.OperationalError:
            escaped = " ".join(part.replace('"', "") for part in query.split())
            if not escaped:
                return []
            parameters[0] = f'"{escaped}"'
            rows = self._connection().execute(
                f"""
                SELECT e.*
                FROM events_fts f
                JOIN events e ON e.id = f.event_id
                WHERE events_fts MATCH ? {session_clause}
                ORDER BY e.importance DESC, e.sequence DESC
                LIMIT ?
                """,
                parameters,
            )
        return [self._row_to_event(row) for row in rows]

    def latest_sequence(self) -> int:
        row = self._connection().execute("SELECT MAX(sequence) AS value FROM events").fetchone()
        return int(row["value"] or 0)

    def verify(self) -> tuple[bool, list[str]]:
        errors: list[str] = []
        previous_hash = GENESIS_HASH
        rows = self._connection().execute("SELECT * FROM events ORDER BY sequence ASC")
        for row in rows:
            event = self._row_to_event(row)
            if event.previous_hash != previous_hash:
                errors.append(
                    f"sequence {event.sequence}: previous hash {event.previous_hash} != {previous_hash}"
                )
            record = {
                "id": event.id,
                "timestamp": event.timestamp.isoformat(),
                "kind": event.kind.value,
                "actor": event.actor.value,
                "payload": event.payload,
                "session_id": event.session_id,
                "causation_id": event.causation_id,
                "correlation_id": event.correlation_id,
                "importance": event.importance,
                "source": event.source,
                "previous_hash": event.previous_hash,
            }
            expected = _event_digest(record)
            if event.event_hash != expected:
                errors.append(
                    f"sequence {event.sequence}: event hash {event.event_hash} != {expected}"
                )
            previous_hash = event.event_hash
        return not errors, errors

    def export_jsonl(self, target: str | Path) -> Path:
        target_path = Path(target)
        target_path.parent.mkdir(parents=True, exist_ok=True)
        with target_path.open("w", encoding="utf-8") as handle:
            for event in self.events(limit=max(self.latest_sequence(), 1)):
                handle.write(event.model_dump_json() + "\n")
        return target_path
