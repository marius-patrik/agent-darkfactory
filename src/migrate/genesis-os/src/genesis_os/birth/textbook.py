from __future__ import annotations

import json
from collections import defaultdict, deque
from pathlib import Path
from typing import Any

import yaml
from pydantic import Field

from genesis_os.birth.formatting import action, prompt_for
from genesis_os.types import FrozenModel, TrainingExample


class TextbookExercise(FrozenModel):
    question: str
    answer: str
    rationale: str | None = None
    verifier: str = "exact"


class TextbookLesson(FrozenModel):
    concept: str
    title: str
    prerequisites: tuple[str, ...] = ()
    explanation: str
    examples: tuple[str, ...] = ()
    counterexamples: tuple[str, ...] = ()
    exercises: tuple[TextbookExercise, ...] = ()
    metadata: dict[str, Any] = Field(default_factory=dict)


class TextbookLoader:
    def load(self, paths: list[str | Path]) -> list[TextbookLesson]:
        lessons: list[TextbookLesson] = []
        for raw_path in paths:
            path = Path(raw_path).expanduser().resolve()
            if not path.exists():
                raise FileNotFoundError(path)
            if path.suffix.lower() in {".yaml", ".yml"}:
                value = yaml.safe_load(path.read_text(encoding="utf-8"))
                records = value.get("lessons", value) if isinstance(value, dict) else value
                if not isinstance(records, list):
                    raise TypeError(f"Textbook YAML must contain a lesson list: {path}")
                lessons.extend(TextbookLesson.model_validate(record) for record in records)
            elif path.suffix.lower() == ".json":
                value = json.loads(path.read_text(encoding="utf-8"))
                records = value.get("lessons", value) if isinstance(value, dict) else value
                if not isinstance(records, list):
                    raise TypeError(f"Textbook JSON must contain a lesson list: {path}")
                lessons.extend(TextbookLesson.model_validate(record) for record in records)
            elif path.suffix.lower() == ".jsonl":
                with path.open("r", encoding="utf-8") as handle:
                    for line in handle:
                        if line.strip():
                            lessons.append(TextbookLesson.model_validate_json(line))
            else:
                raise ValueError(f"Unsupported textbook format: {path}")
        return self._topological_order(lessons)

    @staticmethod
    def _topological_order(lessons: list[TextbookLesson]) -> list[TextbookLesson]:
        by_concept = {lesson.concept: lesson for lesson in lessons}
        if len(by_concept) != len(lessons):
            raise ValueError("Textbook concept identifiers must be unique")
        incoming = {concept: 0 for concept in by_concept}
        outgoing: dict[str, list[str]] = defaultdict(list)
        for lesson in lessons:
            for prerequisite in lesson.prerequisites:
                if prerequisite not in by_concept:
                    raise ValueError(
                        f"Lesson {lesson.concept} references unknown prerequisite {prerequisite}"
                    )
                incoming[lesson.concept] += 1
                outgoing[prerequisite].append(lesson.concept)
        queue = deque(sorted(concept for concept, count in incoming.items() if count == 0))
        ordered: list[TextbookLesson] = []
        while queue:
            concept = queue.popleft()
            ordered.append(by_concept[concept])
            for dependent in sorted(outgoing[concept]):
                incoming[dependent] -= 1
                if incoming[dependent] == 0:
                    queue.append(dependent)
        if len(ordered) != len(lessons):
            raise ValueError("Textbook prerequisite graph contains a cycle")
        return ordered

    def compile(
        self,
        lessons: list[TextbookLesson],
        *,
        task: str,
        weight: float,
        limit: int | None = None,
    ) -> list[TrainingExample]:
        values: list[TrainingExample] = []
        for lesson in lessons:
            provenance = {
                "concept": lesson.concept,
                "title": lesson.title,
                "prerequisites": list(lesson.prerequisites),
                **lesson.metadata,
            }
            values.append(
                TrainingExample(
                    prompt=prompt_for(
                        f"Study this lesson, then explain the concept '{lesson.title}' in the same precise terms.\n\n"
                        f"LESSON:\n{lesson.explanation}",
                        source="textbook_nursery",
                    ),
                    target=action("communication.respond", {"text": lesson.explanation.strip()}),
                    task=task,
                    weight=weight,
                    provenance={**provenance, "lesson_component": "explanation"},
                )
            )
            for index, example in enumerate(lesson.examples):
                values.append(
                    TrainingExample(
                        prompt=prompt_for(
                            f"Identify what concept the following worked example demonstrates and explain why.\n"
                            f"CONCEPT: {lesson.title}\nEXAMPLE: {example}",
                            source="textbook_nursery",
                        ),
                        target=action(
                            "communication.respond",
                            {"text": f"This demonstrates {lesson.title}: {example}"},
                        ),
                        task=task,
                        weight=weight,
                        provenance={
                            **provenance,
                            "lesson_component": "example",
                            "index": index,
                        },
                    )
                )
            for index, counterexample in enumerate(lesson.counterexamples):
                values.append(
                    TrainingExample(
                        prompt=prompt_for(
                            f"Explain why this is a counterexample to {lesson.title}: {counterexample}",
                            source="textbook_nursery",
                        ),
                        target=action(
                            "communication.respond",
                            {"text": f"It is a counterexample to {lesson.title}: {counterexample}"},
                        ),
                        task=task,
                        weight=weight,
                        provenance={
                            **provenance,
                            "lesson_component": "counterexample",
                            "index": index,
                        },
                    )
                )
            for index, exercise in enumerate(lesson.exercises):
                values.append(
                    TrainingExample(
                        prompt=prompt_for(exercise.question, source="textbook_nursery"),
                        target=action("communication.respond", {"text": exercise.answer}),
                        task=task,
                        weight=weight * 1.2,
                        provenance={
                            **provenance,
                            "lesson_component": "exercise",
                            "index": index,
                            "verifier": exercise.verifier,
                            "rationale": exercise.rationale,
                        },
                    )
                )
            if limit is not None and len(values) >= limit:
                return values[:limit]
        return values[:limit] if limit is not None else values
