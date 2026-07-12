"""Tests for the no-false-green status state-machine core."""

from __future__ import annotations

from pathlib import Path

import pytest

from agent.status import (
    CodeChangeValidator,
    GenericArtifactValidator,
    IllegalTransition,
    InMemoryStatusStore,
    RunContext,
    RunRecord,
    SourceState,
    StatusValue,
    Trigger,
    Verdict,
    create_run,
    from_proto,
    get_validator,
    rollup,
    to_proto,
    transition,
    verdict_to_trigger,
)
from agent.status.machine import TRANSITIONS


# ---------------------------------------------------------------------------
# StatusValue vocabulary
# ---------------------------------------------------------------------------


def test_status_value_helpers() -> None:
    assert StatusValue.useful_result.is_success()
    assert StatusValue.released.is_success()
    assert StatusValue.failed.is_terminal()
    assert StatusValue.expired.is_terminal()
    assert StatusValue.released.is_terminal()
    assert StatusValue.no_artifact.is_recoverable()
    assert StatusValue.blocked.is_recoverable()
    assert not StatusValue.failed.is_recoverable()


def test_state_class() -> None:
    assert StatusValue.useful_result.state_class() == "success"
    assert StatusValue.released.state_class() == "post-success"
    assert StatusValue.unresolved.state_class() == "not-done-yet"
    assert StatusValue.no_artifact.state_class() == "not-done-yet"
    assert StatusValue.missing_evidence.state_class() == "not-done-yet"
    assert StatusValue.blocked.state_class() == "stalled"
    assert StatusValue.failed.state_class() == "terminal-neg"
    assert StatusValue.expired.state_class() == "terminal-neg"


# ---------------------------------------------------------------------------
# Proto mapping
# ---------------------------------------------------------------------------


def test_proto_round_trip() -> None:
    for status in StatusValue:
        assert from_proto(to_proto(status)) is status


def test_to_proto_raises_for_liveness_and_unspecified() -> None:
    with pytest.raises(ValueError, match="liveness state"):
        to_proto(from_proto(9))
    with pytest.raises(ValueError, match="liveness state"):
        from_proto(9)
    with pytest.raises(ValueError, match="liveness state"):
        from_proto(10)
    with pytest.raises(ValueError, match="not a result state"):
        from_proto(0)
    with pytest.raises(ValueError, match="not a known result state"):
        from_proto(99)


def test_proto_values_are_stable() -> None:
    expected = {
        StatusValue.useful_result: 1,
        StatusValue.no_artifact: 2,
        StatusValue.missing_evidence: 3,
        StatusValue.unresolved: 4,
        StatusValue.blocked: 5,
        StatusValue.failed: 6,
        StatusValue.released: 7,
        StatusValue.expired: 8,
    }
    for status, value in expected.items():
        assert to_proto(status) == value


# ---------------------------------------------------------------------------
# State-machine transitions T1–T15
# ---------------------------------------------------------------------------


def test_t1_create_run() -> None:
    assert create_run() is StatusValue.unresolved


def test_t2_unresolved_to_useful_result() -> None:
    assert transition(StatusValue.unresolved, Trigger.check_pass) is StatusValue.useful_result


def test_t3_unresolved_to_no_artifact() -> None:
    assert (
        transition(StatusValue.unresolved, Trigger.check_no_artifact) is StatusValue.no_artifact
    )


def test_t4_unresolved_to_missing_evidence() -> None:
    assert (
        transition(StatusValue.unresolved, Trigger.check_missing_evidence)
        is StatusValue.missing_evidence
    )


def test_t5_unresolved_to_failed() -> None:
    assert transition(StatusValue.unresolved, Trigger.check_fail) is StatusValue.failed
    assert transition(StatusValue.unresolved, Trigger.non_progress) is StatusValue.failed


def test_t6_and_t7_remediate() -> None:
    assert transition(StatusValue.no_artifact, Trigger.remediate) is StatusValue.unresolved
    assert (
        transition(StatusValue.missing_evidence, Trigger.remediate) is StatusValue.unresolved
    )


def test_t8_recheck_pass_after_missing() -> None:
    assert transition(StatusValue.no_artifact, Trigger.check_pass) is StatusValue.useful_result
    assert (
        transition(StatusValue.missing_evidence, Trigger.check_pass) is StatusValue.useful_result
    )


def test_t9_recheck_fail_after_missing() -> None:
    assert transition(StatusValue.no_artifact, Trigger.check_fail) is StatusValue.failed
    assert transition(StatusValue.no_artifact, Trigger.non_progress) is StatusValue.failed
    assert transition(StatusValue.missing_evidence, Trigger.check_fail) is StatusValue.failed
    assert transition(StatusValue.missing_evidence, Trigger.non_progress) is StatusValue.failed


def test_t10_useful_result_to_released() -> None:
    assert transition(StatusValue.useful_result, Trigger.release) is StatusValue.released


def test_t11_block_recoverable_states() -> None:
    for src in (StatusValue.unresolved, StatusValue.no_artifact, StatusValue.missing_evidence):
        assert transition(src, Trigger.block) is StatusValue.blocked


def test_t12_unblock_defaults_to_unresolved() -> None:
    assert transition(StatusValue.blocked, Trigger.unblock) is StatusValue.unresolved


def test_t12_unblock_to_stored_state() -> None:
    assert (
        transition(StatusValue.blocked, Trigger.unblock, unblock_from=StatusValue.missing_evidence)
        is StatusValue.missing_evidence
    )


def test_unblock_into_non_recoverable_state_is_illegal() -> None:
    # unblock_from must be one of the recoverable states block can fire from.
    # Restoring into a success/terminal state would mint useful_result/released with
    # NO acceptance check — the founding no-false-green hole.
    for bad in (
        StatusValue.useful_result,
        StatusValue.released,
        StatusValue.failed,
        StatusValue.expired,
        StatusValue.blocked,
    ):
        with pytest.raises(IllegalTransition):
            transition(StatusValue.blocked, Trigger.unblock, unblock_from=bad)
    # the three legal restore targets still work
    for good in (
        StatusValue.unresolved,
        StatusValue.no_artifact,
        StatusValue.missing_evidence,
    ):
        assert transition(StatusValue.blocked, Trigger.unblock, unblock_from=good) is good


def test_t13_blocked_to_failed() -> None:
    assert transition(StatusValue.blocked, Trigger.check_fail) is StatusValue.failed
    assert (
        transition(StatusValue.blocked, Trigger.dependency_unsatisfiable) is StatusValue.failed
    )
    assert transition(StatusValue.blocked, Trigger.non_progress) is StatusValue.failed


def test_t14_non_terminal_to_expired() -> None:
    for src in (StatusValue.unresolved, StatusValue.no_artifact, StatusValue.missing_evidence):
        assert transition(src, Trigger.ttl_lapse) is StatusValue.expired
    assert transition(StatusValue.blocked, Trigger.ttl_lapse) is StatusValue.expired


def test_t15_useful_result_to_expired() -> None:
    assert transition(StatusValue.useful_result, Trigger.ttl_lapse) is StatusValue.expired


# ---------------------------------------------------------------------------
# Illegal transitions + founding invariant
# ---------------------------------------------------------------------------


def test_terminal_states_have_no_outgoing_transitions() -> None:
    terminal = (StatusValue.failed, StatusValue.released, StatusValue.expired)
    for state in terminal:
        for trigger in Trigger:
            with pytest.raises(IllegalTransition):
                transition(state, trigger)


def test_useful_result_cannot_regress() -> None:
    for trigger in (Trigger.remediate, Trigger.check_no_artifact, Trigger.check_missing_evidence):
        with pytest.raises(IllegalTransition):
            transition(StatusValue.useful_result, trigger)


def test_unresolved_cannot_skip_gate_to_released() -> None:
    with pytest.raises(IllegalTransition):
        transition(StatusValue.unresolved, Trigger.release)


def test_only_check_pass_mints_useful_result() -> None:
    """The founding no-false-green invariant."""
    for (frm, trig), to in TRANSITIONS.items():
        if to is StatusValue.useful_result:
            assert trig is Trigger.check_pass, f"{frm.value} -> {trig.value} produced useful_result"


def test_no_trigger_except_check_pass_yields_useful_result() -> None:
    """Loop over legal transitions and confirm useful_result only from check_pass."""
    for (frm, trig), to in TRANSITIONS.items():
        if to is StatusValue.useful_result:
            assert trig is Trigger.check_pass


# ---------------------------------------------------------------------------
# Acceptance validators
# ---------------------------------------------------------------------------


def _make_context(tmp_path: Path, outputs: list[str]) -> RunContext:
    return RunContext(
        run_id="r1",
        task_type="generic",
        workdir=tmp_path,
        declared_outputs=outputs,
        metadata={},
    )


def test_generic_artifact_existing_file_passes(tmp_path: Path) -> None:
    (tmp_path / "out.json").write_text('{"ok": true}')
    ctx = _make_context(tmp_path, ["out.json"])
    validator = GenericArtifactValidator()
    verdict = validator.check(ctx, {})
    assert verdict.outcome == "pass"
    assert any(c.name == "artifact-exists" and c.result == "pass" for c in verdict.checks)
    assert "schema:not_declared" in verdict.source_state.claimed


def test_generic_artifact_missing_file_is_no_artifact(tmp_path: Path) -> None:
    ctx = _make_context(tmp_path, ["missing.json"])
    validator = GenericArtifactValidator()
    verdict = validator.check(ctx, {})
    assert verdict.outcome == "no_artifact"


def test_generic_artifact_schema_mismatch(tmp_path: Path) -> None:
    (tmp_path / "out.json").write_text('{"count": "not-a-number"}')
    ctx = _make_context(tmp_path, ["out.json"])
    validator = GenericArtifactValidator()
    verdict = validator.check(ctx, {"schema": {"count": "int"}})
    assert verdict.outcome in ("missing_evidence", "fail")


def test_generic_artifact_schema_passes(tmp_path: Path) -> None:
    (tmp_path / "out.json").write_text('{"count": 42}')
    ctx = _make_context(tmp_path, ["out.json"])
    validator = GenericArtifactValidator()
    verdict = validator.check(ctx, {"schema": {"count": "int"}})
    assert verdict.outcome == "pass"


def test_generic_artifact_empty_file_is_no_artifact(tmp_path: Path) -> None:
    (tmp_path / "out.json").write_text("")
    ctx = _make_context(tmp_path, ["out.json"])
    validator = GenericArtifactValidator()
    verdict = validator.check(ctx, {})
    assert verdict.outcome == "no_artifact"


def test_code_change_passes(tmp_path: Path) -> None:
    (tmp_path / "change.py").write_text("print('hello')")
    ctx = _make_context(tmp_path, ["change.py"])
    ctx = RunContext(
        run_id="r1",
        task_type="code-change",
        workdir=tmp_path,
        declared_outputs=["change.py"],
        metadata={},
    )
    validator = CodeChangeValidator()
    verdict = validator.check(
        ctx,
        {"build_cmd": ["true"], "test_cmd": ["true"]},
    )
    assert verdict.outcome == "pass"


def test_code_change_build_failure_is_fail(tmp_path: Path) -> None:
    (tmp_path / "change.py").write_text("print('hello')")
    ctx = RunContext(
        run_id="r1",
        task_type="code-change",
        workdir=tmp_path,
        declared_outputs=["change.py"],
        metadata={},
    )
    validator = CodeChangeValidator()
    verdict = validator.check(ctx, {"build_cmd": ["false"]})
    assert verdict.outcome == "fail"


def test_code_change_missing_tests_is_missing_evidence(tmp_path: Path) -> None:
    (tmp_path / "change.py").write_text("print('hello')")
    ctx = RunContext(
        run_id="r1",
        task_type="code-change",
        workdir=tmp_path,
        declared_outputs=["change.py"],
        metadata={},
    )
    validator = CodeChangeValidator()
    verdict = validator.check(ctx, {"build_cmd": ["true"]})
    assert verdict.outcome == "missing_evidence"


def test_code_change_missing_file_is_no_artifact(tmp_path: Path) -> None:
    ctx = RunContext(
        run_id="r1",
        task_type="code-change",
        workdir=tmp_path,
        declared_outputs=["change.py"],
        metadata={},
    )
    validator = CodeChangeValidator()
    verdict = validator.check(ctx, {"build_cmd": ["true"], "test_cmd": ["true"]})
    assert verdict.outcome == "no_artifact"


def test_code_change_absent_build_is_not_green(tmp_path: Path) -> None:
    # build is a default-required check (D6 §4.2a): a change with only a passing
    # test_cmd and NO build_cmd must NOT reach useful_result — it's missing_evidence.
    (tmp_path / "change.py").write_text("print('hello')")
    ctx = RunContext(
        run_id="r1",
        task_type="code-change",
        workdir=tmp_path,
        declared_outputs=["change.py"],
        metadata={},
    )
    validator = CodeChangeValidator()
    verdict = validator.check(ctx, {"test_cmd": ["true"]})
    assert verdict.outcome == "missing_evidence"
    assert "build:not_run" in verdict.source_state.missing
    # explicit opt-out (interpreted change, no build step) is allowed to pass
    opted_out = validator.check(ctx, {"test_cmd": ["true"], "build_required": False})
    assert opted_out.outcome == "pass"


# ---------------------------------------------------------------------------
# Validator registry
# ---------------------------------------------------------------------------


def test_validator_registry_defaults_to_generic() -> None:
    validator = get_validator("unknown-task")
    assert isinstance(validator, GenericArtifactValidator)


def test_validator_registry_registers_code_change() -> None:
    assert isinstance(get_validator("code-change"), CodeChangeValidator)


def test_run_acceptance_selects_validator(tmp_path: Path) -> None:
    (tmp_path / "out.json").write_text('{"ok": true}')
    ctx = _make_context(tmp_path, ["out.json"])
    from agent.status.acceptance import run_acceptance

    verdict = run_acceptance(ctx, {"type": "generic"})
    assert verdict.outcome == "pass"


# ---------------------------------------------------------------------------
# Verdict → trigger
# ---------------------------------------------------------------------------


def test_verdict_to_trigger_mapping() -> None:
    assert verdict_to_trigger(_dummy_verdict("pass")) is Trigger.check_pass
    assert verdict_to_trigger(_dummy_verdict("no_artifact")) is Trigger.check_no_artifact
    assert verdict_to_trigger(_dummy_verdict("missing_evidence")) is Trigger.check_missing_evidence
    assert verdict_to_trigger(_dummy_verdict("fail")) is Trigger.check_fail


def _dummy_verdict(outcome: str) -> Verdict:
    return Verdict(
        outcome=outcome,  # type: ignore[arg-type]
        artifacts=[],
        evidence=[],
        checks=[],
        source_state=SourceState(),
        reviewers=[],
        confidence=0.0,
        notes="",
    )


# ---------------------------------------------------------------------------
# Roll-up
# ---------------------------------------------------------------------------


def test_rollup_worst_wins() -> None:
    children = [
        StatusValue.useful_result,
        StatusValue.missing_evidence,
        StatusValue.released,
    ]
    assert rollup(children) is StatusValue.missing_evidence


def test_rollup_all_success_is_useful_result() -> None:
    assert rollup([StatusValue.useful_result, StatusValue.released]) is StatusValue.useful_result


def test_rollup_one_missing_evidence_not_success() -> None:
    assert rollup([StatusValue.useful_result, StatusValue.missing_evidence]) is StatusValue.missing_evidence


def test_rollup_failed_overrides_all() -> None:
    assert (
        rollup([StatusValue.released, StatusValue.failed, StatusValue.useful_result])
        is StatusValue.failed
    )


def test_rollup_empty_is_released() -> None:
    assert rollup([]) is StatusValue.released


# ---------------------------------------------------------------------------
# In-memory store
# ---------------------------------------------------------------------------


def test_in_memory_store_persists_and_emits() -> None:
    store = InMemoryStatusStore()
    record = RunRecord(
        run_id="r1",
        parent_id=None,
        task_type="generic",
        status=StatusValue.unresolved,
        status_reason="created",
    )
    store.persist(record)
    store.emit_transition(
        run_id="r1",
        frm=StatusValue.unresolved,
        to=StatusValue.useful_result,
        trigger=Trigger.check_pass,
        by="test",
        verdict_summary="pass",
    )
    assert store.records["r1"] is record
    assert len(store.events) == 1
    assert store.events[0]["to"] == "useful_result"


def test_verdict_history_append_only() -> None:
    record = RunRecord(
        run_id="r1",
        parent_id=None,
        task_type="generic",
        status=StatusValue.unresolved,
        status_reason="created",
    )
    v1 = _dummy_verdict("missing_evidence")
    v2 = _dummy_verdict("pass")
    record.append_verdict(v1)
    record.append_verdict(v2)
    assert record.verdict is v2
    assert record.verdict_history == [v1, v2]
