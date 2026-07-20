from __future__ import annotations

import json

from genesis_os.birth.ingest import PersonalDataIngestor
from genesis_os.storage import ArtifactStore


def test_chatgpt_export_preserves_roles_provenance_and_quarantines_secrets(tmp_path):
    export = tmp_path / "conversations.json"
    export.write_text(
        json.dumps(
            [
                {
                    "id": "conversation-1",
                    "title": "Genesis discussion",
                    "mapping": {
                        "u": {
                            "message": {
                                "author": {"role": "user"},
                                "create_time": 1_700_000_000,
                                "content": {
                                    "parts": [
                                        "I want a persistent model. api_key=super-secret-value-123"
                                    ]
                                },
                            }
                        },
                        "a": {
                            "message": {
                                "author": {"role": "assistant"},
                                "create_time": 1_700_000_001,
                                "content": {"parts": ["Use a Birth/Wake/Sleep lifecycle."]},
                            }
                        },
                    },
                }
            ]
        ),
        encoding="utf-8",
    )
    store = ArtifactStore(tmp_path / "artifacts")
    records = PersonalDataIngestor(artifacts=store, redact_secrets=True).ingest([export])

    assert [record.role for record in records] == ["user", "assistant"]
    assert {record.conversation_id for record in records} == {"conversation-1"}
    assert records[0].quarantined is True
    assert "super-secret-value-123" not in (records[0].content or "")
    assert "[REDACTED_SECRET]" in (records[0].content or "")
    assert records[1].quarantined is False
    assert all(record.artifact_hash and store.verify(record.artifact_hash) for record in records)
