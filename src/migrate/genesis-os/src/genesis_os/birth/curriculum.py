from __future__ import annotations

import json
import random
import string
from collections import defaultdict
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from itertools import pairwise

from genesis_os.birth.formatting import action, prompt_for
from genesis_os.birth.ingest import PersonalRecord
from genesis_os.birth.spec import CurriculumSpec, CurriculumStageSpec
from genesis_os.birth.teacher import TeacherClient
from genesis_os.types import Actor, Event, EventKind, TrainingExample


def _event(sequence: int, payload: dict[str, object]) -> Event:
    return Event(
        id=f"curriculum_event_{sequence}",
        sequence=sequence,
        timestamp=datetime(2025, 1, 1, tzinfo=UTC),
        kind=EventKind.MEMORY,
        actor=Actor.USER,
        payload=payload,
        session_id="nursery",
        causation_id=None,
        correlation_id=None,
        importance=0.9,
        source="verified_curriculum",
        previous_hash="0" * 64,
        event_hash=f"{sequence:064x}",
    )


@dataclass(slots=True)
class CompiledCurriculum:
    train: list[TrainingExample]
    validation: list[TrainingExample]
    concept_counts: dict[str, int]


class CurriculumProgram:
    def __init__(self, spec: CurriculumSpec, *, teacher: TeacherClient | None = None) -> None:
        self.spec = spec
        self.teacher = teacher
        self.generators: dict[
            str, Callable[[random.Random, CurriculumStageSpec], list[TrainingExample]]
        ] = {
            "language_foundations": self._language,
            "arithmetic": self._arithmetic,
            "symbolic_logic": self._logic,
            "algorithms": self._algorithms,
            "causal_worlds": self._causal_worlds,
            "tool_use": self._tool_use,
            "memory_recall": self._memory,
            "procedural_distillation": self._procedural_distillation,
            "textbook": self._textbook,
        }

    def compile(self, personal_records: list[PersonalRecord] | None = None) -> CompiledCurriculum:
        rng = random.Random(self.spec.seed)
        all_examples: list[TrainingExample] = []
        counts: dict[str, int] = defaultdict(int)
        completed: set[str] = set()
        for stage in self.spec.stages:
            missing = set(stage.prerequisites) - completed
            if missing:
                raise ValueError(f"Stage {stage.name} has unmet prerequisites: {sorted(missing)}")
            try:
                generator = self.generators[stage.generator]
            except KeyError as error:
                raise KeyError(f"Unknown curriculum generator: {stage.generator}") from error
            examples = generator(rng, stage)
            all_examples.extend(examples)
            counts[stage.name] += len(examples)
            completed.add(stage.name)
        if personal_records:
            personal_examples = self._personal(personal_records)
            all_examples.extend(personal_examples)
            counts["personal"] += len(personal_examples)
        if len(all_examples) < 2:
            raise ValueError(
                "A Birth curriculum requires at least two compiled examples for train/validation"
            )
        rng.shuffle(all_examples)
        validation_size = min(
            len(all_examples) - 1,
            max(1, int(len(all_examples) * self.spec.validation_fraction)),
        )
        validation = all_examples[:validation_size]
        train = all_examples[validation_size:]
        return CompiledCurriculum(train=train, validation=validation, concept_counts=dict(counts))

    def remediation(self, task_names: set[str], *, seed_offset: int = 1) -> list[TrainingExample]:
        rng = random.Random(self.spec.seed + seed_offset * 10_000)
        values: list[TrainingExample] = []
        for stage in self.spec.stages:
            if stage.name not in task_names:
                continue
            remedial = stage.model_copy(
                update={"examples": self.spec.remediation_examples_per_task}
            )
            values.extend(self.generators[stage.generator](rng, remedial))
        rng.shuffle(values)
        return values

    @staticmethod
    def _make(
        *,
        observation: str,
        target: str,
        task: str,
        weight: float,
        provenance: dict[str, object],
        memories: list[Event] | None = None,
        next_context: str | None = None,
        outcome: float | None = 1.0,
    ) -> TrainingExample:
        return TrainingExample(
            prompt=prompt_for(observation, memories=memories),
            target=target,
            task=task,
            weight=weight,
            provenance=provenance,
            next_context=next_context,
            outcome=outcome,
        )

    def _language(self, rng: random.Random, stage: CurriculumStageSpec) -> list[TrainingExample]:
        nouns = ["circle", "river", "engine", "tree", "signal", "planet", "window", "model"]
        adjectives = ["small", "bright", "quiet", "rapid", "stable", "curved", "dense", "open"]
        verbs = ["moves", "changes", "rests", "predicts", "connects", "rotates", "learns", "flows"]
        examples: list[TrainingExample] = []
        for index in range(stage.examples):
            noun = rng.choice(nouns)
            adjective = rng.choice(adjectives)
            verb = rng.choice(verbs)
            mode = index % 4
            if mode == 0:
                question = f"Repeat exactly: The {adjective} {noun} {verb}."
                answer = f"The {adjective} {noun} {verb}."
            elif mode == 1:
                word = "".join(rng.choice(string.ascii_lowercase) for _ in range(rng.randint(3, 8)))
                question = f"Spell the token {word} backwards."
                answer = word[::-1]
            elif mode == 2:
                question = f"Which word names the object in: 'The {adjective} {noun} {verb}'?"
                answer = noun
            else:
                question = f"Produce a grammatical sentence using '{noun}' and '{verb}'."
                answer = f"The {noun} {verb}."
            examples.append(
                self._make(
                    observation=question,
                    target=action("communication.respond", {"text": answer}),
                    task=stage.name,
                    weight=stage.weight,
                    provenance={"generator": stage.generator, "index": index},
                )
            )
        return examples

    def _arithmetic(self, rng: random.Random, stage: CurriculumStageSpec) -> list[TrainingExample]:
        examples: list[TrainingExample] = []
        for index in range(stage.examples):
            operation = index % 5
            a = rng.randint(-99, 999)
            b = rng.randint(1, 99)
            if operation == 0:
                question, answer = f"Compute {a} + {b}.", a + b
            elif operation == 1:
                question, answer = f"Compute {a} - {b}.", a - b
            elif operation == 2:
                a, b = rng.randint(-20, 20), rng.randint(-20, 20)
                question, answer = f"Compute {a} * {b}.", a * b
            elif operation == 3:
                quotient = rng.randint(-30, 30)
                divisor = rng.randint(1, 20)
                dividend = quotient * divisor
                question, answer = f"Compute {dividend} ÷ {divisor}.", quotient
            else:
                values = [rng.randint(-50, 50) for _ in range(4)]
                question = f"What is the sum of {values}?"
                answer = sum(values)
            examples.append(
                self._make(
                    observation=question,
                    target=action("communication.respond", {"text": str(answer)}),
                    task=stage.name,
                    weight=stage.weight,
                    provenance={"generator": stage.generator, "verified_answer": answer},
                )
            )
        return examples

    def _logic(self, rng: random.Random, stage: CurriculumStageSpec) -> list[TrainingExample]:
        examples: list[TrainingExample] = []
        for index in range(stage.examples):
            symbols = rng.sample(list("ABCDEFGHJKLMNPQRSTUVWXYZ"), 4)
            a, b, c, _d = symbols
            truth = rng.choice([True, False])
            if index % 3 == 0:
                premise = f"Every {a} is a {b}. Every {b} is a {c}. Object x is a {a}."
                question = f"{premise} Is x necessarily a {c}?"
                answer = "yes"
            elif index % 3 == 1:
                premise = f"No {a} is a {b}. Object x is a {a}."
                question = f"{premise} Can x be a {b}?"
                answer = "no"
            else:
                left = truth
                right = rng.choice([True, False])
                operator = rng.choice(["AND", "OR", "XOR"])
                result = {
                    "AND": left and right,
                    "OR": left or right,
                    "XOR": left != right,
                }[operator]
                question = f"Evaluate: {str(left).lower()} {operator} {str(right).lower()}."
                answer = str(result).lower()
            examples.append(
                self._make(
                    observation=question,
                    target=action("communication.respond", {"text": answer}),
                    task=stage.name,
                    weight=stage.weight,
                    provenance={"generator": stage.generator, "verified": True},
                )
            )
        return examples

    def _algorithms(self, rng: random.Random, stage: CurriculumStageSpec) -> list[TrainingExample]:
        examples: list[TrainingExample] = []
        for index in range(stage.examples):
            mode = index % 4
            if mode == 0:
                values = [rng.randint(-50, 50) for _ in range(rng.randint(3, 8))]
                question = f"Sort these integers ascending: {values}."
                answer = json.dumps(sorted(values), separators=(",", ":"))
            elif mode == 1:
                values = [rng.randint(0, 20) for _ in range(rng.randint(4, 10))]
                question = f"Remove duplicates while preserving first occurrence: {values}."
                answer = json.dumps(list(dict.fromkeys(values)), separators=(",", ":"))
            elif mode == 2:
                text = "".join(
                    rng.choice(string.ascii_lowercase) for _ in range(rng.randint(4, 12))
                )
                shift = rng.randint(1, 25)
                shifted = "".join(chr((ord(char) - 97 + shift) % 26 + 97) for char in text)
                question = f"Shift each lowercase letter in '{text}' forward by {shift} modulo 26."
                answer = shifted
            else:
                values = [rng.randint(-20, 20) for _ in range(rng.randint(4, 10))]
                question = f"Return the largest value in {values}."
                answer = str(max(values))
            examples.append(
                self._make(
                    observation=question,
                    target=action("communication.respond", {"text": answer}),
                    task=stage.name,
                    weight=stage.weight,
                    provenance={"generator": stage.generator, "verified": True},
                )
            )
        return examples

    def _causal_worlds(
        self, rng: random.Random, stage: CurriculumStageSpec
    ) -> list[TrainingExample]:
        examples: list[TrainingExample] = []
        for _index in range(stage.examples):
            position = rng.randint(-20, 20)
            velocity = rng.randint(-5, 5)
            action_delta = rng.randint(-3, 3)
            next_velocity = velocity + action_delta
            next_position = position + next_velocity
            observation = (
                f"In an invented one-dimensional world, state is position={position}, "
                f"velocity={velocity}. Intervention adds {action_delta} to velocity, then the object "
                "moves once using the new velocity. Predict the next state."
            )
            answer = f"position={next_position}, velocity={next_velocity}"
            next_context = f"Observed next state: {answer}."
            examples.append(
                self._make(
                    observation=observation,
                    target=action("communication.respond", {"text": answer}),
                    task=stage.name,
                    weight=stage.weight,
                    provenance={
                        "generator": stage.generator,
                        "initial": [position, velocity],
                        "intervention": action_delta,
                    },
                    next_context=prompt_for(next_context),
                )
            )
        return examples

    def _tool_use(self, rng: random.Random, stage: CurriculumStageSpec) -> list[TrainingExample]:
        examples: list[TrainingExample] = []
        for index in range(stage.examples):
            mode = index % 8
            token = "".join(rng.choice(string.ascii_lowercase) for _ in range(6))
            if mode == 0:
                text = f"Acknowledged {token}."
                observation = f"Reply exactly with: {text}"
                target = action("communication.respond", {"text": text})
            elif mode == 1:
                observation = f"Remember this exact code word for later: {token}."
                target = action(
                    "memory.append",
                    {"content": f"The user supplied code word {token}.", "tags": ["code-word"]},
                )
            elif mode == 2:
                observation = f"Search your exact memory for the code word {token}."
                target = action("memory.search", {"query": f"code word {token}"})
            elif mode == 3:
                observation = "No response is needed; end this turn."
                target = action("runtime.yield", {"reason": "no response requested"})
            elif mode == 4:
                observation = "List the tools currently installed."
                target = action("tool.list", {})
            elif mode == 5:
                path = f"notes/{token}.txt"
                observation = f"Write '{token}' to workspace file {path}."
                target = action("workspace.write", {"path": path, "content": token})
            elif mode == 6:
                path = f"notes/{token}.txt"
                observation = f"Read workspace file {path}."
                target = action("workspace.read", {"path": path})
            else:
                observation = f"Request sleep so experience about {token} can consolidate."
                target = action("sleep.request", {"reason": f"consolidate {token}"})
            examples.append(
                self._make(
                    observation=observation,
                    target=target,
                    task=stage.name,
                    weight=stage.weight,
                    provenance={"generator": stage.generator, "mode": mode},
                )
            )
        return examples

    def _memory(self, rng: random.Random, stage: CurriculumStageSpec) -> list[TrainingExample]:
        examples: list[TrainingExample] = []
        for index in range(stage.examples):
            token = "".join(rng.choice(string.ascii_uppercase) for _ in range(8))
            event = _event(
                index + 1,
                {
                    "role": "user",
                    "claim_type": "explicit_memory",
                    "content": f"The verified token is {token}.",
                },
            )
            if index % 3 == 0:
                question = "What is the verified token in relevant memory?"
                answer = token
            elif index % 3 == 1:
                question = "Who supplied the statement in relevant memory?"
                answer = "the user"
            else:
                question = "Which exact event supports the supplied memory?"
                answer = event.id
            examples.append(
                self._make(
                    observation=question,
                    target=action("communication.respond", {"text": answer}),
                    task=stage.name,
                    weight=stage.weight,
                    provenance={"generator": stage.generator, "event_id": event.id},
                    memories=[event],
                )
            )
        return examples

    def _procedural_distillation(
        self, rng: random.Random, stage: CurriculumStageSpec
    ) -> list[TrainingExample]:
        # A task yields a procedural plan action and a separately verified execution action.
        # Stage examples continue to mean output examples rather than hidden teacher calls.
        from genesis_os.birth.distillation import ProceduralDistiller

        task_count = max(1, (stage.examples + 1) // 2)
        configured_required = bool(self.spec.teacher.required) if self.spec.teacher else False
        teacher_required = bool(stage.parameters.get("teacher_required", configured_required))
        values = ProceduralDistiller(self.teacher).compile(
            rng=rng,
            tasks=task_count,
            task_name=stage.name,
            weight=stage.weight,
            teacher_required=teacher_required,
        )
        return values[: stage.examples]

    def _textbook(self, rng: random.Random, stage: CurriculumStageSpec) -> list[TrainingExample]:
        del rng  # Ordering is encoded by the prerequisite graph, not random generation.
        from genesis_os.birth.textbook import TextbookLoader

        raw_paths = stage.parameters.get("paths")
        if not isinstance(raw_paths, (list, tuple)) or not raw_paths:
            raise ValueError(
                f"Textbook stage {stage.name!r} requires parameters.paths with YAML/JSON files"
            )
        paths: list[str] = []
        for value in raw_paths:
            if not isinstance(value, (str, bytes)):
                raise TypeError(f"Textbook path must be a string, got {type(value).__name__}")
            paths.append(value.decode() if isinstance(value, bytes) else value)
        loader = TextbookLoader()
        lessons = loader.load(paths)
        return loader.compile(
            lessons,
            task=stage.name,
            weight=stage.weight,
            limit=stage.examples,
        )

    def _personal(self, records: list[PersonalRecord]) -> list[TrainingExample]:
        examples: list[TrainingExample] = []
        conversation_messages: dict[str, list[PersonalRecord]] = defaultdict(list)
        for record in records:
            if record.conversation_id:
                conversation_messages[record.conversation_id].append(record)
            if record.kind != "text" or not record.content or record.quarantined:
                continue
            if record.role == "user":
                excerpt = record.content[:2000]
                signal = self._personal_signal(excerpt)
                event = _event(
                    len(examples) + 10_000,
                    {
                        "role": "user",
                        "content": excerpt,
                        "source_hash": record.source_hash,
                        "timestamp": record.timestamp,
                    },
                )
                examples.append(
                    TrainingExample(
                        prompt=prompt_for(
                            "State exactly what the user said in the supplied autobiographical event.",
                            memories=[event],
                            source="personal_nursery",
                        ),
                        target=action("communication.respond", {"text": excerpt}),
                        task="personal_user_model",
                        weight=1.2,
                        provenance={
                            "record_id": record.record_id,
                            "source_hash": record.source_hash,
                            "role": "user",
                        },
                    )
                )
                examples.append(
                    TrainingExample(
                        prompt=prompt_for(
                            "Who is the source of the supplied autobiographical statement?",
                            memories=[event],
                            source="personal_nursery",
                        ),
                        target=action("communication.respond", {"text": "the user"}),
                        task="personal_provenance",
                        weight=0.8,
                        provenance={
                            "record_id": record.record_id,
                            "source_hash": record.source_hash,
                            "role": "user",
                        },
                    )
                )
                if signal is not None:
                    examples.append(
                        TrainingExample(
                            prompt=prompt_for(excerpt, source="personal_user_model"),
                            target=action(
                                "memory.append",
                                {
                                    "content": f"Verified user {signal}: {excerpt}",
                                    "tags": ["personal", "user-model", signal],
                                    "importance": 0.9,
                                    "confidence": 1.0,
                                },
                            ),
                            task="personal_user_model_write",
                            weight=1.1,
                            provenance={
                                "record_id": record.record_id,
                                "source_hash": record.source_hash,
                                "signal": signal,
                                "role": "user",
                            },
                        )
                    )
            elif record.role == "assistant":
                # Assistant history is evidence about prior assistant behavior, never user ground truth.
                excerpt = record.content[:2000]
                event = _event(
                    len(examples) + 20_000,
                    {
                        "role": "assistant",
                        "content": excerpt,
                        "source_hash": record.source_hash,
                        "timestamp": record.timestamp,
                    },
                )
                examples.append(
                    TrainingExample(
                        prompt=prompt_for(
                            "Who produced the supplied historical statement?",
                            memories=[event],
                            source="personal_nursery",
                        ),
                        target=action("communication.respond", {"text": "the assistant"}),
                        task="personal_provenance",
                        weight=0.5,
                        provenance={
                            "record_id": record.record_id,
                            "source_hash": record.source_hash,
                            "role": "assistant",
                            "not_user_ground_truth": True,
                        },
                    )
                )
            elif record.role is None:
                excerpt = record.content[:2000]
                examples.append(
                    TrainingExample(
                        prompt=prompt_for(
                            f"Preserve this personal source excerpt with its provenance:\n{excerpt}",
                            source="personal_nursery",
                        ),
                        target=action(
                            "memory.append",
                            {
                                "content": f"Personal source excerpt: {excerpt}",
                                "tags": ["personal", "document", record.source_hash[:12]],
                                "importance": 0.7,
                                "confidence": 1.0,
                            },
                        ),
                        task="personal_documents",
                        weight=0.5,
                        provenance={
                            "record_id": record.record_id,
                            "source_hash": record.source_hash,
                        },
                    )
                )

        # Teach chronology and role attribution without imitating historical assistant claims.
        for conversation_id, messages in conversation_messages.items():
            ordered = sorted(messages, key=lambda value: value.timestamp or "")
            visible = [
                value
                for value in ordered
                if value.kind == "text"
                and value.content
                and not value.quarantined
                and value.role in {"user", "assistant"}
            ]
            for position, (previous, current) in enumerate(pairwise(visible)):
                previous_event = _event(
                    30_000 + len(examples) * 2,
                    {
                        "role": previous.role,
                        "content": previous.content[:1200],
                        "timestamp": previous.timestamp,
                        "conversation_id": conversation_id,
                    },
                )
                current_event = _event(
                    30_001 + len(examples) * 2,
                    {
                        "role": current.role,
                        "content": current.content[:1200],
                        "timestamp": current.timestamp,
                        "conversation_id": conversation_id,
                    },
                )
                examples.append(
                    TrainingExample(
                        prompt=prompt_for(
                            "Which role spoke immediately after the first supplied event?",
                            memories=[previous_event, current_event],
                            source="personal_timeline",
                        ),
                        target=action("communication.respond", {"text": str(current.role)}),
                        task="personal_timeline",
                        weight=0.55,
                        provenance={
                            "conversation_id": conversation_id,
                            "position": position,
                            "previous_record": previous.record_id,
                            "current_record": current.record_id,
                        },
                    )
                )

        if self.spec.personal.include_assistant_imitation:
            for messages in conversation_messages.values():
                ordered = sorted(messages, key=lambda value: value.timestamp or "")
                for previous, current in pairwise(ordered):
                    if (
                        previous.role == "user"
                        and current.role == "assistant"
                        and previous.content
                        and current.content
                        and not previous.quarantined
                        and not current.quarantined
                    ):
                        examples.append(
                            TrainingExample(
                                prompt=prompt_for(
                                    previous.content[:4000], source="personal_history"
                                ),
                                target=action(
                                    "communication.respond", {"text": current.content[:4000]}
                                ),
                                task="assistant_history_imitation",
                                weight=self.spec.personal.assistant_imitation_weight,
                                provenance={
                                    "user_record": previous.record_id,
                                    "assistant_record": current.record_id,
                                    "warning": "assistant output is historical behavior, not user ground truth",
                                },
                            )
                        )
        return examples

    @staticmethod
    def _personal_signal(text: str) -> str | None:
        lowered = f" {text.lower()} "
        categories = (
            ("preference", (" i prefer ", " i like ", " i dislike ", " my preference ")),
            ("requirement", (" i want ", " we need ", " must ", " has to ", " should ")),
            ("identity", (" i am ", " i'm ", " my name ", " i work as ", " my role ")),
            ("decision", (" i decided ", " we decided ", " let's use ", " we will ")),
            ("goal", (" my goal ", " our goal ", " i plan ", " we plan ")),
        )
        for category, markers in categories:
            if any(marker in lowered for marker in markers):
                return category
        return None
