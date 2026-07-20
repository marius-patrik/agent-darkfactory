from __future__ import annotations

import asyncio
import json

from genesis_os.birth import BirthRunner, BirthSpec
from genesis_os.birth.spec import CurriculumSpec, CurriculumStageSpec, ViabilitySpec
from genesis_os.model.genome import ModelGenome
from genesis_os.runtime.wake import WakeRuntime
from genesis_os.sleep import SleepProgram, SleepSpec
from genesis_os.sleep.spec import PromotionGateSpec
from genesis_os.storage import ExperienceLedger, LineageStore
from genesis_os.training.trainer import TrainingConfig
from genesis_os.types import Observation, ToolCall


def minimal_birth_spec() -> BirthSpec:
    return BirthSpec(
        name="test-organism",
        genome=ModelGenome(
            d_model=32,
            n_layers=1,
            n_heads=4,
            max_sequence_length=128,
            memory_slots=2,
            world_latent_dim=16,
            max_modality_tokens=8,
            structured_feature_dim=4,
            image_patch_size=4,
            audio_kernel_size=16,
            audio_stride=8,
        ),
        curriculum=CurriculumSpec(
            validation_fraction=0.2,
            stages=(
                CurriculumStageSpec(name="tools", generator="tool_use", examples=12),
                CurriculumStageSpec(name="memory", generator="memory_recall", examples=8),
            ),
            remediation_rounds=0,
        ),
        training=TrainingConfig(
            epochs=1,
            max_steps=2,
            batch_size=4,
            learning_rate=0.001,
            warmup_steps=0,
            device="cpu",
            cpu_threads=2,
        ),
        viability=ViabilitySpec(
            max_validation_loss=100.0,
            generation_samples=0,
            max_generation_tokens=64,
        ),
    )


def test_birth_wake_sleep_lineage_roundtrip(tmp_path):
    certificate = BirthRunner(tmp_path).run(minimal_birth_spec())
    assert (
        LineageStore(tmp_path / "lineages").current(certificate.lineage_id).release_id
        == certificate.release.release_id
    )

    class Policy:
        def __init__(self):
            self.calls = iter(
                [
                    ToolCall(
                        tool="memory.append",
                        arguments={"content": "The test token is LANTERN-9.", "importance": 1.0},
                    ),
                    ToolCall(tool="runtime.yield", arguments={"reason": "done"}),
                ]
            )

        @property
        def self_state(self):
            return {
                "lineage_id": certificate.lineage_id,
                "release_id": certificate.release.release_id,
                "wake_weights_mutable": False,
            }

        def generate_tool_call(self, *args, **kwargs):
            call = next(self.calls)
            return call, json.dumps({"tool": call.tool, "arguments": call.arguments})

    wake = WakeRuntime(workspace=tmp_path, policy=Policy())
    result = asyncio.run(
        wake.observe(Observation(source="user", content="Remember LANTERN-9"), session_id="s")
    )
    assert [value.tool for value in result.tool_results] == ["memory.append", "runtime.yield"]

    sleep = SleepProgram(tmp_path).run(
        certificate.lineage_id,
        SleepSpec(
            replay_examples=4,
            generation_samples=0,
            training=TrainingConfig(
                epochs=1,
                max_steps=1,
                batch_size=2,
                learning_rate=1e-5,
                warmup_steps=0,
                device="cpu",
                cpu_threads=2,
            ),
            gate=PromotionGateSpec(
                max_new_loss_regression=10.0,
                min_new_loss_improvement=0.0,
                max_foundation_relative_regression=1.0,
                max_tool_accuracy_drop=1.0,
            ),
        ),
    )
    assert sleep.candidate is not None
    assert sleep.parent.release_id == certificate.release.release_id
    assert ExperienceLedger(tmp_path / "genesis.sqlite3").verify()[0]


def test_lineage_refuses_to_promote_tampered_release(tmp_path):
    import pytest

    certificate = BirthRunner(tmp_path).run(minimal_birth_spec())
    store = LineageStore(tmp_path / "lineages")
    model_path = (
        tmp_path
        / "lineages"
        / certificate.lineage_id
        / "releases"
        / certificate.release.release_id
        / "model.safetensors"
    )
    model_path.write_bytes(model_path.read_bytes() + b"tamper")
    with pytest.raises(ValueError, match="hash mismatch"):
        store.promote_release(
            certificate.lineage_id,
            certificate.release.release_id,
            reason={"test": "tampering"},
        )


def test_cli_auto_lineage_resolution(tmp_path):
    from genesis_os.cli import _resolve_lineage
    import pytest
    from typer import BadParameter

    # 1. No lineages in workspace -> raises BadParameter
    with pytest.raises(BadParameter, match="No lineages found"):
        _resolve_lineage(tmp_path, None)

    # 2. Birth an organism -> auto-resolves promoted lineage
    certificate = BirthRunner(tmp_path).run(minimal_birth_spec())
    resolved = _resolve_lineage(tmp_path, None)
    assert resolved == certificate.lineage_id

    # 3. Explicit valid lineage -> resolves properly
    assert _resolve_lineage(tmp_path, certificate.lineage_id) == certificate.lineage_id

    # 4. Invalid lineage -> raises BadParameter with helpful message
    with pytest.raises(BadParameter, match="has no promoted release"):
        _resolve_lineage(tmp_path, "invalid_lineage_xyz")


def test_cli_auto_workspace_resolution(tmp_path, monkeypatch):
    from genesis_os.cli import _resolve_workspace

    # Explicit workspace passed
    assert _resolve_workspace(tmp_path) == tmp_path.resolve()

    # GENESIS_WORKSPACE env var
    monkeypatch.setenv("GENESIS_WORKSPACE", str(tmp_path))
    assert _resolve_workspace(None) == tmp_path.resolve()


