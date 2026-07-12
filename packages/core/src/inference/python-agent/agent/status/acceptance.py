"""Acceptance-check contract + deterministic validators.

This module defines the pluggable ``AcceptanceCheck`` interface and the
START-scope validators that need no model judgment and no cluster:

* ``GenericArtifactValidator`` — existence + optional schema/shape.
* ``CodeChangeValidator`` — existence + build + tests.

Undeclared checks are emitted as ``skip`` and never counted as evidence.

OPEN-1 default
~~~~~~~~~~~~~~

A ``generic-artifact`` task with **no schema declared** passes on existence
alone, but everything beyond existence is logged in
``source_state.claimed``.  This is the conservative, simplest-first escape
hatch: the validator never pretends an unverified property was proven.  The
user may tighten acceptance later by adding a schema.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Literal, Protocol, runtime_checkable

from agent.status.machine import Trigger


@dataclass(frozen=True)
class CheckResult:
    """A single acceptance check.

    Attributes:
        name: Stable check identifier, e.g. ``artifact-exists``.
        required: Whether a failure of this check gates the verdict.
        result: One of ``pass``, ``fail``, ``skip``, ``na``.
        detail: Human-readable explanation.
        by: The validator or worker that produced the check.
    """

    name: str
    required: bool
    result: Literal["pass", "fail", "skip", "na"]
    detail: str
    by: str


@dataclass(frozen=True)
class Artifact:
    """A validated artifact reference.

    Attributes:
        kind: Artifact kind, e.g. ``file``, "diff", ``pr_url``.
        ref: Content-addressed blob id, path, URL, etc.
    """

    kind: str
    ref: str


@dataclass(frozen=True)
class Evidence:
    """A piece of evidence backing a claim.

    Attributes:
        claim: The claim being supported.
        proof_ref: Reference to the proof artifact / run / URL.
        source_class: One of ``verified``, ``claimed``, ``inferred``.
    """

    claim: str
    proof_ref: str
    source_class: Literal["verified", "claimed", "inferred"]


@dataclass(frozen=True)
class SourceState:
    """Source-separated state buckets (OR3).

    Attributes:
        verified: Provable by deterministic check.
        claimed: Agent/worker assertions not independently verified.
        inferred: Hypotheses / extrapolations.
        missing: Known gaps.
    """

    verified: list[str] = field(default_factory=list)
    claimed: list[str] = field(default_factory=list)
    inferred: list[str] = field(default_factory=list)
    missing: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class Verdict:
    """The result of an acceptance check.

    Attributes:
        outcome: One of ``pass``, ``no_artifact``, ``missing_evidence``, ``fail``.
        artifacts: Artifacts that were found / inspected.
        evidence: Evidence claims produced by the validator.
        checks: Every check that was run.
        source_state: OR3 buckets summarizing verification state.
        reviewers: OR4 review packets (empty if self-only).
        confidence: 0..1 aggregate confidence.
        notes: Free-form explanation for operators.
    """

    outcome: Literal["pass", "no_artifact", "missing_evidence", "fail"]
    artifacts: list[Artifact]
    evidence: list[Evidence]
    checks: list[CheckResult]
    source_state: SourceState
    reviewers: list[dict[str, Any]]
    confidence: float
    notes: str


@dataclass(frozen=True)
class RunContext:
    """The run being evaluated.

    Attributes:
        run_id: Unique run identifier.
        task_type: Registered task/validator type.
        workdir: Optional working directory for relative paths.
        declared_outputs: Paths/refs the run claims to have produced.
        metadata: Opaque run metadata.
    """

    run_id: str
    task_type: str
    workdir: Path | None
    declared_outputs: list[str]
    metadata: dict[str, Any]


@runtime_checkable
class AcceptanceCheck(Protocol):
    """Protocol for per-task-type acceptance validators."""

    def check(self, run: RunContext, acceptance: dict[str, Any]) -> Verdict:
        """Evaluate ``run`` against its declared ``acceptance`` block.

        Args:
            run: The run context.
            acceptance: Task acceptance declaration.

        Returns:
            A verdict driving the state-machine trigger.
        """
        ...


# Validator registry: task_type -> AcceptanceCheck instance.
_validators: dict[str, AcceptanceCheck] = {}


def register_validator(task_type: str, validator: AcceptanceCheck) -> None:
    """Register an acceptance validator for a task type.

    Args:
        task_type: The task type that selects this validator.
        validator: An ``AcceptanceCheck`` implementation.
    """
    _validators[task_type] = validator


def get_validator(task_type: str) -> AcceptanceCheck:
    """Return the validator for ``task_type``.

    Args:
        task_type: The task type.

    Returns:
        The registered validator, or ``GenericArtifactValidator`` for unknown
        types.
    """
    return _validators.get(task_type, GenericArtifactValidator())


def _resolve_path(ref: str, workdir: Path | None) -> Path:
    """Resolve a declared output ref to an absolute path."""
    p = Path(ref)
    if p.is_absolute():
        return p
    return (workdir or Path.cwd()) / p


def _run_command(cmd: list[str], cwd: Path | None, timeout: float = 600.0) -> tuple[bool, str]:
    """Run a command safely without shell injection.

    Args:
        cmd: Argument vector (never a shell string).
        cwd: Working directory, or ``None`` for the current directory.
        timeout: Seconds before the run is killed.

    Returns:
        ``(ok, detail)`` where ``ok`` is ``returncode == 0``.
    """
    try:
        result = subprocess.run(
            _portable_command(cmd),
            cwd=str(cwd) if cwd else None,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        tail = (result.stdout + result.stderr)[-1000:]
        return result.returncode == 0, tail
    except subprocess.TimeoutExpired:
        return False, f"timeout after {timeout}s"
    except Exception as exc:  # pragma: no cover - defensive
        return False, str(exc)


def _portable_command(cmd: list[str]) -> list[str]:
    if os.name == "nt" and len(cmd) == 1:
        if cmd[0] == "true":
            return [sys.executable, "-c", "import sys; sys.exit(0)"]
        if cmd[0] == "false":
            return [sys.executable, "-c", "import sys; sys.exit(1)"]
    return cmd


class GenericArtifactValidator:
    """Default validator: existence + optional schema/shape.

    With no schema declared the verdict can still be ``pass``, but every
    property beyond existence is logged in ``source_state.claimed`` (OPEN-1
    conservative default).
    """

    def check(self, run: RunContext, acceptance: dict[str, Any]) -> Verdict:
        """Validate generic artifacts.

        Args:
            run: Run context with declared outputs.
            acceptance: May contain ``schema`` as ``{key: type_name}`` or a
                callable ``Callable[[Any], bool]``.

        Returns:
            A verdict with outcome ``pass``, ``no_artifact``,
            ``missing_evidence`` or ``fail``.
        """
        checks: list[CheckResult] = []
        artifacts: list[Artifact] = []
        source_state = SourceState()
        workdir = run.workdir
        declared = run.declared_outputs
        schema = acceptance.get("schema")

        if not declared:
            checks.append(
                CheckResult(
                    name="artifact-exists",
                    required=True,
                    result="fail",
                    detail="no declared outputs",
                    by="GenericArtifactValidator",
                )
            )
            source_state.missing.append("declared_outputs")
            return Verdict(
                outcome="no_artifact",
                artifacts=artifacts,
                evidence=[],
                checks=checks,
                source_state=source_state,
                reviewers=[],
                confidence=0.0,
                notes="No declared outputs for the run.",
            )

        missing_refs: list[str] = []
        present_paths: list[Path] = []
        for ref in declared:
            path = _resolve_path(ref, workdir)
            artifacts.append(Artifact(kind="file", ref=str(path)))
            if not path.exists():
                missing_refs.append(ref)
                source_state.missing.append(f"artifact:{ref}")
            else:
                present_paths.append(path)
                source_state.verified.append(f"artifact:{ref}")

        exists_ok = not missing_refs
        checks.append(
            CheckResult(
                name="artifact-exists",
                required=True,
                result="pass" if exists_ok else "fail",
                detail=("all artifacts present" if exists_ok else f"missing: {missing_refs}"),
                by="GenericArtifactValidator",
            )
        )
        if not exists_ok:
            return Verdict(
                outcome="no_artifact",
                artifacts=artifacts,
                evidence=[],
                checks=checks,
                source_state=source_state,
                reviewers=[],
                confidence=0.0,
                notes=f"Missing declared artifact(s): {missing_refs}",
            )

        # Schema / shape check.
        if schema is not None:
            schema_ok = self._check_schema(present_paths, schema, source_state)
            checks.append(
                CheckResult(
                    name="schema",
                    required=True,
                    result="pass" if schema_ok else "fail",
                    detail=("schema validated" if schema_ok else "schema mismatch"),
                    by="GenericArtifactValidator",
                )
            )
            if not schema_ok:
                return Verdict(
                    outcome="missing_evidence",
                    artifacts=artifacts,
                    evidence=[],
                    checks=checks,
                    source_state=source_state,
                    reviewers=[],
                    confidence=0.0,
                    notes="Artifact exists but does not satisfy declared schema.",
                )
        else:
            checks.append(
                CheckResult(
                    name="schema",
                    required=False,
                    result="na",
                    detail="no schema declared (OPEN-1 weak-acceptance default)",
                    by="GenericArtifactValidator",
                )
            )
            source_state.claimed.append("schema:not_declared")

        # Non-empty / sanity check.
        empty: list[str] = []
        for path in present_paths:
            if path.stat().st_size == 0:
                empty.append(str(path))
                source_state.missing.append(f"sanity:empty:{path}")
            else:
                source_state.verified.append(f"sanity:non-empty:{path}")
        sanity_ok = not empty
        checks.append(
            CheckResult(
                name="non-empty",
                required=True,
                result="pass" if sanity_ok else "fail",
                detail=("artifacts are non-empty" if sanity_ok else f"empty: {empty}"),
                by="GenericArtifactValidator",
            )
        )
        if not sanity_ok:
            return Verdict(
                outcome="no_artifact",
                artifacts=artifacts,
                evidence=[],
                checks=checks,
                source_state=source_state,
                reviewers=[],
                confidence=0.0,
                notes=f"Declared artifact(s) are empty: {empty}",
            )

        return Verdict(
            outcome="pass",
            artifacts=artifacts,
            evidence=[],
            checks=checks,
            source_state=source_state,
            reviewers=[],
            confidence=1.0,
            notes="Artifact exists and satisfies declared checks.",
        )

    def _check_schema(
        self,
        paths: list[Path],
        schema: dict[str, str] | Callable[[Any], bool],
        source_state: SourceState,
    ) -> bool:
        """Return True if every artifact satisfies ``schema``.

        A dict schema validates a JSON object's keys/types.  A callable is
        invoked on the parsed JSON object.
        """
        for path in paths:
            try:
                data = json.loads(path.read_text())
            except Exception as exc:
                source_state.missing.append(f"schema:{path}:parse_error:{exc}")
                return False

            if isinstance(schema, dict):
                for key, type_name in schema.items():
                    if key not in data:
                        source_state.missing.append(f"schema:{path}:missing_key:{key}")
                        return False
                    if type(data[key]).__name__ != type_name:
                        source_state.missing.append(
                            f"schema:{path}:type_mismatch:{key}="
                            f"{type(data[key]).__name__}!={type_name}"
                        )
                        return False
                    source_state.verified.append(f"schema:{path}:{key}")
            elif callable(schema):
                if not schema(data):
                    source_state.missing.append(f"schema:{path}:callable_false")
                    return False
                source_state.verified.append(f"schema:{path}:callable")
            else:
                source_state.missing.append(f"schema:{path}:unsupported_schema_type")
                return False
        return True


class CodeChangeValidator:
    """Deterministic core of the code-change validator.

    Required checks in START scope:

    * ``artifact-exists`` — declared diff/files exist.
    * ``build`` — ``acceptance['build_cmd']`` exits 0 (hard fail on error).
    * ``tests`` — ``acceptance['test_cmd']`` exits 0 (missing_evidence on error).

    Optional checks that are not declared are emitted as ``skip`` rather than
    being treated as evidence.
    """

    def check(self, run: RunContext, acceptance: dict[str, Any]) -> Verdict:
        """Validate a code change.

        Args:
            run: Run context with declared outputs.
            acceptance: May contain ``build_cmd`` and ``test_cmd`` as argument
                vectors (lists of strings).

        Returns:
            A verdict with outcome ``pass``, ``no_artifact``,
            ``missing_evidence`` or ``fail``.
        """
        checks: list[CheckResult] = []
        artifacts: list[Artifact] = []
        source_state = SourceState()
        workdir = run.workdir
        declared = run.declared_outputs
        build_cmd = acceptance.get("build_cmd")
        test_cmd = acceptance.get("test_cmd")

        if not declared:
            checks.append(
                CheckResult(
                    name="artifact-exists",
                    required=True,
                    result="fail",
                    detail="no declared outputs",
                    by="CodeChangeValidator",
                )
            )
            source_state.missing.append("declared_outputs")
            return Verdict(
                outcome="no_artifact",
                artifacts=artifacts,
                evidence=[],
                checks=checks,
                source_state=source_state,
                reviewers=[],
                confidence=0.0,
                notes="No declared outputs for the code change.",
            )

        missing_refs: list[str] = []
        for ref in declared:
            path = _resolve_path(ref, workdir)
            artifacts.append(Artifact(kind="file", ref=str(path)))
            if not path.exists():
                missing_refs.append(ref)
                source_state.missing.append(f"artifact:{ref}")
            else:
                source_state.verified.append(f"artifact:{ref}")

        exists_ok = not missing_refs
        checks.append(
            CheckResult(
                name="artifact-exists",
                required=True,
                result="pass" if exists_ok else "fail",
                detail=("all artifacts present" if exists_ok else f"missing: {missing_refs}"),
                by="CodeChangeValidator",
            )
        )
        if not exists_ok:
            return Verdict(
                outcome="no_artifact",
                artifacts=artifacts,
                evidence=[],
                checks=checks,
                source_state=source_state,
                reviewers=[],
                confidence=0.0,
                notes=f"Missing declared file(s): {missing_refs}",
            )

        # Build check.
        build_missing = False
        if build_cmd:
            ok, detail = _run_command(build_cmd, workdir)
            checks.append(
                CheckResult(
                    name="build",
                    required=True,
                    result="pass" if ok else "fail",
                    detail=detail,
                    by="CodeChangeValidator",
                )
            )
            if ok:
                source_state.verified.append("build:passed")
            else:
                source_state.missing.append("build:failed")
                return Verdict(
                    outcome="fail",
                    artifacts=artifacts,
                    evidence=[],
                    checks=checks,
                    source_state=source_state,
                    reviewers=[],
                    confidence=0.0,
                    notes="Build command failed.",
                )
        else:
            # D6 §4.2a lists build as a default-REQUIRED check. An absent build_cmd is
            # treated as MISSING required evidence (not an optional skip) so a change
            # with only a passing test_cmd cannot reach useful_result without a verified
            # build — unless the task explicitly opts out via acceptance["build_required"].
            build_required = acceptance.get("build_required", True)
            if build_required:
                build_missing = True
                checks.append(
                    CheckResult(
                        name="build",
                        required=True,
                        result="skip",
                        detail="no build_cmd declared (build_required)",
                        by="CodeChangeValidator",
                    )
                )
                source_state.missing.append("build:not_run")
            else:
                checks.append(
                    CheckResult(
                        name="build",
                        required=False,
                        result="skip",
                        detail="no build_cmd declared (build_required=False)",
                        by="CodeChangeValidator",
                    )
                )
                source_state.claimed.append("build:not_run")

        # Tests check.
        if test_cmd:
            ok, detail = _run_command(test_cmd, workdir)
            checks.append(
                CheckResult(
                    name="tests",
                    required=True,
                    result="pass" if ok else "fail",
                    detail=detail,
                    by="CodeChangeValidator",
                )
            )
            if ok:
                source_state.verified.append("tests:passed")
                if build_missing:
                    return Verdict(
                        outcome="missing_evidence",
                        artifacts=artifacts,
                        evidence=[],
                        checks=checks,
                        source_state=source_state,
                        reviewers=[],
                        confidence=0.0,
                        notes="Tests passed but the required build was not run.",
                    )
                return Verdict(
                    outcome="pass",
                    artifacts=artifacts,
                    evidence=[],
                    checks=checks,
                    source_state=source_state,
                    reviewers=[],
                    confidence=1.0,
                    notes="Build and tests passed.",
                )
            else:
                source_state.missing.append("tests:failed")
                return Verdict(
                    outcome="missing_evidence",
                    artifacts=artifacts,
                    evidence=[],
                    checks=checks,
                    source_state=source_state,
                    reviewers=[],
                    confidence=0.0,
                    notes="Tests failed or were not run.",
                )

        # No test_cmd provided: required evidence is missing.
        checks.append(
            CheckResult(
                name="tests",
                required=True,
                result="skip",
                detail="no test_cmd declared",
                by="CodeChangeValidator",
            )
        )
        source_state.missing.append("tests:not_run")

        # run-proof is a layer-in dimension (S4).
        checks.append(
            CheckResult(
                name="run-proof",
                required=False,
                result="skip",
                detail="layer-in (S4)",
                by="CodeChangeValidator",
            )
        )
        source_state.claimed.append("run-proof:layer-in")

        return Verdict(
            outcome="missing_evidence",
            artifacts=artifacts,
            evidence=[],
            checks=checks,
            source_state=source_state,
            reviewers=[],
            confidence=0.0,
            notes="No test command was declared; evidence is missing.",
        )


def run_acceptance(run: RunContext, acceptance: dict[str, Any]) -> Verdict:
    """Convenience: select the validator by ``acceptance['type']`` and run it.

    Args:
        run: Run context.
        acceptance: Task acceptance declaration.

    Returns:
        The validator's verdict.
    """
    validator = get_validator(acceptance.get("type", "generic"))
    return validator.check(run, acceptance)


def verdict_to_trigger(verdict: Verdict) -> Trigger:
    """Map a verdict outcome to the state-machine trigger.

    Args:
        verdict: An acceptance verdict.

    Returns:
        The trigger enum member.
    """
    mapping: dict[str, Trigger] = {
        "pass": Trigger.check_pass,
        "no_artifact": Trigger.check_no_artifact,
        "missing_evidence": Trigger.check_missing_evidence,
        "fail": Trigger.check_fail,
    }
    return mapping[verdict.outcome]
