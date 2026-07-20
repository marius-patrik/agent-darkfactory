from __future__ import annotations

import secrets
from dataclasses import dataclass
from enum import StrEnum


class AuthorityPurpose(StrEnum):
    BIRTH = "birth"
    SLEEP = "sleep"
    EVOLUTION = "evolution"


@dataclass(frozen=True, slots=True)
class TrainingAuthority:
    purpose: AuthorityPurpose
    _nonce: str


class TrainingAuthorityIssuer:
    """Issues in-process capabilities required by durable checkpoint writers."""

    def __init__(self) -> None:
        self._secret = secrets.token_hex(32)

    def issue(self, purpose: AuthorityPurpose) -> TrainingAuthority:
        return TrainingAuthority(purpose=purpose, _nonce=self._derive(purpose))

    def validate(self, authority: TrainingAuthority, *allowed: AuthorityPurpose) -> None:
        if authority.purpose not in allowed or not secrets.compare_digest(
            authority._nonce, self._derive(authority.purpose)
        ):
            raise PermissionError(
                "Durable model writes are restricted to Birth, Sleep, or Evolution"
            )

    def _derive(self, purpose: AuthorityPurpose) -> str:
        import hashlib

        return hashlib.sha256(f"{self._secret}:{purpose.value}".encode()).hexdigest()
