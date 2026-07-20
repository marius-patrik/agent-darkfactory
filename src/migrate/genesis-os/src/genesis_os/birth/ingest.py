from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from genesis_os.storage import ArtifactStore

_TEXT_SUFFIXES = {".txt", ".md", ".rst", ".log", ".csv", ".tsv", ".json", ".jsonl"}
_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff"}
_AUDIO_SUFFIXES = {".wav", ".mp3", ".flac", ".m4a", ".ogg", ".opus"}

_SECRET_PATTERNS = [
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}\b"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"(?i)\b(password|passwd|api[_ -]?key|secret|token)\s*[:=]\s*[^\s,;]{8,}"),
]


@dataclass(frozen=True, slots=True)
class PersonalRecord:
    record_id: str
    source_path: str
    source_hash: str
    kind: str
    role: str | None
    content: str | None
    timestamp: str | None
    conversation_id: str | None
    artifact_hash: str | None = None
    quarantined: bool = False
    metadata: dict[str, Any] | None = None


def _hash_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _record_id(source_hash: str, suffix: str) -> str:
    return hashlib.sha256(f"{source_hash}:{suffix}".encode()).hexdigest()[:32]


def _contains_secret(text: str) -> bool:
    return any(pattern.search(text) for pattern in _SECRET_PATTERNS)


def _redact(text: str) -> str:
    value = text
    for pattern in _SECRET_PATTERNS:
        value = pattern.sub("[REDACTED_SECRET]", value)
    return value


class PersonalDataIngestor:
    """Compiles personal sources with role/provenance retention and default secret quarantine."""

    def __init__(
        self,
        *,
        artifacts: ArtifactStore,
        redact_secrets: bool = True,
        max_record_characters: int = 16_000,
    ) -> None:
        self.artifacts = artifacts
        self.redact_secrets = redact_secrets
        self.max_record_characters = max_record_characters

    def ingest(self, sources: tuple[Path, ...] | list[Path]) -> list[PersonalRecord]:
        records: list[PersonalRecord] = []
        for source in sources:
            source = Path(source).expanduser().resolve()
            if source.is_dir():
                for path in sorted(item for item in source.rglob("*") if item.is_file()):
                    records.extend(self._ingest_file(path))
            elif source.is_file():
                records.extend(self._ingest_file(source))
            else:
                raise FileNotFoundError(source)
        return records

    def _ingest_file(self, path: Path) -> list[PersonalRecord]:
        data = path.read_bytes()
        digest = _hash_bytes(data)
        artifact_hash = self.artifacts.put_bytes(data)
        suffix = path.suffix.lower()
        if path.name == "conversations.json" or (
            suffix == ".json" and b'"mapping"' in data[:2_000_000]
        ):
            try:
                return self._chatgpt_export(path, data, digest, artifact_hash)
            except (json.JSONDecodeError, TypeError, KeyError):
                pass
        if suffix == ".jsonl":
            records = self._jsonl(path, data, digest, artifact_hash)
            if records:
                return records
        if suffix in _TEXT_SUFFIXES:
            text = data.decode("utf-8", errors="replace")
            return [
                self._text_record(
                    path=path,
                    source_hash=digest,
                    artifact_hash=artifact_hash,
                    content=text,
                    suffix="document",
                    role=None,
                    timestamp=None,
                    conversation_id=None,
                )
            ]
        if suffix in _IMAGE_SUFFIXES:
            kind = "image"
        elif suffix in _AUDIO_SUFFIXES:
            kind = "audio"
        else:
            kind = "binary"
        return [
            PersonalRecord(
                record_id=_record_id(digest, "binary"),
                source_path=str(path),
                source_hash=digest,
                kind=kind,
                role=None,
                content=None,
                timestamp=datetime.fromtimestamp(path.stat().st_mtime, UTC).isoformat(),
                conversation_id=None,
                artifact_hash=artifact_hash,
                metadata={"bytes": len(data), "suffix": suffix},
            )
        ]

    def _text_record(
        self,
        *,
        path: Path,
        source_hash: str,
        artifact_hash: str,
        content: str,
        suffix: str,
        role: str | None,
        timestamp: str | None,
        conversation_id: str | None,
        metadata: dict[str, Any] | None = None,
    ) -> PersonalRecord:
        content = content[: self.max_record_characters]
        quarantined = self.redact_secrets and _contains_secret(content)
        safe_content = _redact(content) if self.redact_secrets else content
        return PersonalRecord(
            record_id=_record_id(source_hash, suffix),
            source_path=str(path),
            source_hash=source_hash,
            kind="text",
            role=role,
            content=safe_content,
            timestamp=timestamp,
            conversation_id=conversation_id,
            artifact_hash=artifact_hash,
            quarantined=quarantined,
            metadata=metadata,
        )

    def _chatgpt_export(
        self, path: Path, data: bytes, digest: str, artifact_hash: str
    ) -> list[PersonalRecord]:
        conversations = json.loads(data)
        if not isinstance(conversations, list):
            raise TypeError("ChatGPT conversations export must be a list")
        records: list[PersonalRecord] = []
        for conversation_index, conversation in enumerate(conversations):
            conversation_id = str(
                conversation.get("id") or conversation.get("conversation_id") or conversation_index
            )
            title = conversation.get("title")
            mapping = conversation.get("mapping", {})
            messages: list[tuple[float, str, dict[str, Any]]] = []
            if isinstance(mapping, dict):
                for node_id, node in mapping.items():
                    message = node.get("message") if isinstance(node, dict) else None
                    if not isinstance(message, dict):
                        continue
                    create_time = message.get("create_time") or 0.0
                    try:
                        order = float(create_time)
                    except (TypeError, ValueError):
                        order = 0.0
                    messages.append((order, str(node_id), message))
            messages.sort(key=lambda value: (value[0], value[1]))
            for message_index, (order, node_id, message) in enumerate(messages):
                author = message.get("author", {})
                role = str(author.get("role", "unknown"))
                content = message.get("content", {})
                parts = content.get("parts", []) if isinstance(content, dict) else []
                text_parts: list[str] = []
                for part in parts:
                    if isinstance(part, str):
                        text_parts.append(part)
                    elif isinstance(part, dict) and isinstance(part.get("text"), str):
                        text_parts.append(part["text"])
                text = "\n".join(text_parts).strip()
                if not text:
                    continue
                timestamp = datetime.fromtimestamp(order, UTC).isoformat() if order > 0 else None
                records.append(
                    self._text_record(
                        path=path,
                        source_hash=digest,
                        artifact_hash=artifact_hash,
                        content=text,
                        suffix=f"{conversation_id}:{node_id}:{message_index}",
                        role=role,
                        timestamp=timestamp,
                        conversation_id=conversation_id,
                        metadata={"title": title, "node_id": node_id},
                    )
                )
        return records

    def _jsonl(
        self, path: Path, data: bytes, digest: str, artifact_hash: str
    ) -> list[PersonalRecord]:
        records: list[PersonalRecord] = []
        for index, line in enumerate(data.decode("utf-8", errors="replace").splitlines()):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                return []
            if not isinstance(value, dict):
                continue
            content = value.get("content") or value.get("text") or value.get("message")
            if not isinstance(content, str):
                continue
            records.append(
                self._text_record(
                    path=path,
                    source_hash=digest,
                    artifact_hash=artifact_hash,
                    content=content,
                    suffix=f"jsonl:{index}",
                    role=value.get("role"),
                    timestamp=value.get("timestamp") or value.get("created_at"),
                    conversation_id=value.get("conversation_id") or value.get("session_id"),
                    metadata={key: value[key] for key in ("title", "source") if key in value},
                )
            )
        return records
