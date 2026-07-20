"""Production default acceptance validator registration."""

from __future__ import annotations

from agent.status.acceptance import CodeChangeValidator, GenericArtifactValidator, register_validator


def register_default_validators() -> None:
    """Register deterministic validators used by production consumers."""
    register_validator("generic", GenericArtifactValidator())
    register_validator("code-change", CodeChangeValidator())
