from __future__ import annotations

from fastapi.testclient import TestClient

from genesis_os.birth import BirthRunner, BirthSpec
from genesis_os.birth.spec import CurriculumSpec, CurriculumStageSpec, ViabilitySpec
from genesis_os.config import RuntimeSettings
from genesis_os.model.genome import ModelGenome
from genesis_os.server import create_app
from genesis_os.training.trainer import TrainingConfig


def _birth_spec() -> BirthSpec:
    return BirthSpec(
        name="api-smoke",
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
            remediation_rounds=0,
            stages=(CurriculumStageSpec(name="tools", generator="tool_use", examples=10),),
        ),
        training=TrainingConfig(
            epochs=1,
            max_steps=1,
            batch_size=2,
            learning_rate=0.001,
            warmup_steps=0,
            device="cpu",
            cpu_threads=2,
        ),
        viability=ViabilitySpec(max_validation_loss=100.0, generation_samples=0),
    )


def test_api_exposes_lineage_tools_and_audited_invocation(tmp_path, monkeypatch):
    certificate = BirthRunner(tmp_path).run(_birth_spec())
    monkeypatch.setenv("GENESIS_API_TOKEN", "test-token")
    app = create_app(
        workspace=tmp_path,
        lineage_id=certificate.lineage_id,
        device="cpu",
        settings=RuntimeSettings(max_tool_steps=1),
    )
    client = TestClient(app)

    assert client.get("/health").status_code == 401
    headers = {"authorization": "Bearer test-token"}
    health = client.get("/health", headers=headers)
    assert health.status_code == 200
    assert health.json()["release_id"] == certificate.release.release_id

    tools = client.get("/v1/tools", headers=headers)
    assert tools.status_code == 200
    names = {tool["name"] for tool in tools.json()["tools"]}
    assert {"communication.respond", "tool.create_workflow", "sleep.request"} <= names

    invoked = client.post(
        "/v1/tools/invoke",
        headers=headers,
        json={
            "tool": "communication.respond",
            "arguments": {"text": "API path is audited."},
            "session_id": "api-test",
        },
    )
    assert invoked.status_code == 200
    assert invoked.json()["ok"] is True

    events = client.get("/v1/events", headers=headers)
    assert events.status_code == 200
    event_kinds = [event["kind"] for event in events.json()["events"]]
    assert "tool_call" in event_kinds
    assert "tool_result" in event_kinds
    assert "message" in event_kinds
