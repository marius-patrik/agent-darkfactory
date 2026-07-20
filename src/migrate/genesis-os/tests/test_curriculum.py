from __future__ import annotations

import random
from pathlib import Path

import pytest
import yaml

from genesis_os.birth.curriculum import CurriculumProgram
from genesis_os.birth.distillation import ProceduralDistiller
from genesis_os.birth.spec import CurriculumSpec, CurriculumStageSpec
from genesis_os.birth.textbook import TextbookLoader
from genesis_os.model.organism import parse_tool_call


def test_textbook_loader_orders_prerequisites_and_compiles(tmp_path: Path) -> None:
    source = tmp_path / "lessons.yaml"
    source.write_text(
        yaml.safe_dump(
            {
                "lessons": [
                    {
                        "concept": "child",
                        "title": "Child",
                        "prerequisites": ["root"],
                        "explanation": "A child depends on the root.",
                        "exercises": [{"question": "Dependency?", "answer": "root"}],
                    },
                    {
                        "concept": "root",
                        "title": "Root",
                        "explanation": "A root has no prerequisite.",
                    },
                ]
            },
            sort_keys=False,
        ),
        encoding="utf-8",
    )
    loader = TextbookLoader()
    lessons = loader.load([source])
    assert [lesson.concept for lesson in lessons] == ["root", "child"]
    examples = loader.compile(lessons, task="foundations", weight=1.0)
    assert len(examples) == 3
    assert all(
        parse_tool_call(example.target).tool == "communication.respond" for example in examples
    )


def test_textbook_loader_rejects_cycles(tmp_path: Path) -> None:
    source = tmp_path / "cycle.yaml"
    source.write_text(
        yaml.safe_dump(
            {
                "lessons": [
                    {
                        "concept": "a",
                        "title": "A",
                        "prerequisites": ["b"],
                        "explanation": "A",
                    },
                    {
                        "concept": "b",
                        "title": "B",
                        "prerequisites": ["a"],
                        "explanation": "B",
                    },
                ]
            }
        ),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="cycle"):
        TextbookLoader().load([source])


def test_procedural_distillation_is_verified_and_knowledge_minimized() -> None:
    examples = ProceduralDistiller().compile(
        rng=random.Random(11),
        tasks=10,
        task_name="procedural",
        weight=1.0,
    )
    assert len(examples) == 20
    assert {parse_tool_call(example.target).tool for example in examples} == {
        "cognition.record",
        "communication.respond",
    }
    assert all(example.provenance["verified"] is True for example in examples)
    assert all(example.provenance["teacher_used"] is False for example in examples)


def test_curriculum_program_combines_textbook_and_distillation(tmp_path: Path) -> None:
    source = tmp_path / "lesson.yaml"
    source.write_text(
        yaml.safe_dump(
            {
                "lessons": [
                    {
                        "concept": "state",
                        "title": "State",
                        "explanation": "State is the information required for the next transition.",
                        "exercises": [
                            {"question": "What is state?", "answer": "transition information"}
                        ],
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    spec = CurriculumSpec(
        validation_fraction=0.2,
        remediation_rounds=0,
        stages=(
            CurriculumStageSpec(
                name="textbook",
                generator="textbook",
                examples=2,
                parameters={"paths": [str(source)]},
            ),
            CurriculumStageSpec(
                name="reasoning",
                generator="procedural_distillation",
                examples=10,
                prerequisites=("textbook",),
            ),
        ),
    )
    compiled = CurriculumProgram(spec).compile()
    assert len(compiled.train) + len(compiled.validation) == 12
    assert compiled.concept_counts == {"textbook": 2, "reasoning": 10}
    assert all(parse_tool_call(example.target) for example in compiled.train + compiled.validation)


def test_personal_curriculum_preserves_roles_and_extracts_user_requirements(tmp_path: Path) -> None:
    from genesis_os.birth.ingest import PersonalRecord

    records = [
        PersonalRecord(
            record_id="u1",
            source_path="history.json",
            source_hash="a" * 64,
            kind="text",
            role="user",
            content="I want every operational action to use a dynamic tool.",
            timestamp="2026-01-01T00:00:00+00:00",
            conversation_id="c1",
        ),
        PersonalRecord(
            record_id="a1",
            source_path="history.json",
            source_hash="a" * 64,
            kind="text",
            role="assistant",
            content="I proposed a tool kernel.",
            timestamp="2026-01-01T00:01:00+00:00",
            conversation_id="c1",
        ),
    ]
    spec = CurriculumSpec(stages=(), validation_fraction=0.2, remediation_rounds=0)
    compiled = CurriculumProgram(spec).compile(records)
    examples = compiled.train + compiled.validation
    calls = [parse_tool_call(example.target) for example in examples]
    assert any(call.tool == "memory.append" for call in calls)
    assert any(
        example.task == "personal_provenance"
        and parse_tool_call(example.target).arguments.get("text") == "the assistant"
        for example in examples
    )
    assert not any(example.task == "assistant_history_imitation" for example in examples)


def test_compiled_dataset_serialization_is_content_deterministic(tmp_path: Path) -> None:
    from genesis_os.training.dataset import write_examples

    spec = CurriculumSpec(
        seed=99,
        validation_fraction=0.2,
        remediation_rounds=0,
        stages=(CurriculumStageSpec(name="math", generator="arithmetic", examples=20),),
    )
    first = CurriculumProgram(spec).compile()
    second = CurriculumProgram(spec).compile()
    first_path = write_examples(tmp_path / "first.jsonl", first.train + first.validation)
    second_path = write_examples(tmp_path / "second.jsonl", second.train + second.validation)
    assert first_path.read_bytes() == second_path.read_bytes()
