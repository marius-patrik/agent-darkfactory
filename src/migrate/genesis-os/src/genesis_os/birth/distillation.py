from __future__ import annotations

import json
import random
import string
from collections.abc import Callable
from dataclasses import dataclass

from genesis_os.birth.formatting import action, prompt_for
from genesis_os.birth.teacher import TeacherClient, extract_json_object
from genesis_os.types import TrainingExample


@dataclass(frozen=True, slots=True)
class ProceduralTask:
    prompt: str
    answer: str
    deterministic_strategy: str
    verifier: Callable[[str], bool]
    family: str


class ProceduralDistiller:
    """Transfers abstract procedures through randomized, executable micro-worlds rather than facts."""

    SYSTEM = """You are generating process supervision for a new model.
The task is an invented, randomized formal world. Return only JSON:
{"strategy":"a concise domain-general procedure","answer":"the exact verified final answer"}
Do not introduce external facts, named people, real places, cultural knowledge, or unverifiable claims.
Describe operations such as representation, decomposition, simulation, checking, contradiction, search, and revision."""

    def __init__(self, teacher: TeacherClient | None = None) -> None:
        self.teacher = teacher

    def compile(
        self,
        *,
        rng: random.Random,
        tasks: int,
        task_name: str,
        weight: float,
        teacher_required: bool = False,
    ) -> list[TrainingExample]:
        values: list[TrainingExample] = []
        for index in range(tasks):
            task = self._task(rng, index)
            strategy = task.deterministic_strategy
            teacher_used = False
            if self.teacher is not None:
                try:
                    response = self.teacher.complete(system=self.SYSTEM, user=task.prompt)
                    parsed = extract_json_object(response)
                    candidate_answer = str(parsed.get("answer", "")).strip()
                    candidate_strategy = str(parsed.get("strategy", "")).strip()
                    if task.verifier(candidate_answer) and candidate_strategy:
                        strategy = candidate_strategy[:1500]
                        teacher_used = True
                    elif teacher_required:
                        raise ValueError(
                            f"Teacher failed executable verification for {task.family}: "
                            f"{response[:500]!r}"
                        )
                except Exception:
                    if teacher_required:
                        raise
            elif teacher_required:
                raise RuntimeError("procedural_distillation requires a configured teacher")

            plan_target = action(
                "cognition.record",
                {
                    "kind": "subproblem",
                    "content": strategy,
                    "confidence": 0.9,
                },
            )
            values.append(
                TrainingExample(
                    prompt=prompt_for(
                        f"Construct a general procedure before solving this invented task:\n{task.prompt}",
                        source="procedural_distillation",
                    ),
                    target=plan_target,
                    task=task_name,
                    weight=weight,
                    provenance={
                        "family": task.family,
                        "teacher_used": teacher_used,
                        "verified": True,
                        "phase": "strategy",
                    },
                )
            )
            values.append(
                TrainingExample(
                    prompt=prompt_for(
                        f"Apply this verified procedure:\n{strategy}\n\nTASK:\n{task.prompt}",
                        source="procedural_distillation",
                    ),
                    target=action("communication.respond", {"text": task.answer}),
                    task=task_name,
                    weight=weight * 1.1,
                    provenance={
                        "family": task.family,
                        "teacher_used": teacher_used,
                        "verified": True,
                        "phase": "execution",
                    },
                )
            )
        return values

    def _task(self, rng: random.Random, index: int) -> ProceduralTask:
        family = index % 5
        if family == 0:
            values = [rng.randint(-30, 30) for _ in range(rng.randint(4, 8))]
            answer = json.dumps(sorted(values), separators=(",", ":"))
            return ProceduralTask(
                prompt=f"Invented symbols carry integer payloads {values}. Return payloads in ascending order.",
                answer=answer,
                deterministic_strategy=(
                    "Represent each payload as a comparable scalar, repeatedly select the smallest remaining "
                    "value, append it to the output, and verify the output is nondecreasing and preserves the multiset."
                ),
                verifier=lambda value, expected=answer: value.replace(" ", "") == expected,
                family="ordering",
            )
        if family == 1:
            start = rng.randint(-20, 20)
            operations = [rng.choice([-3, -2, -1, 1, 2, 3]) for _ in range(rng.randint(3, 7))]
            answer = str(start + sum(operations))
            return ProceduralTask(
                prompt=f"A state begins at {start}. Apply signed transitions {operations} in order. What is the final state?",
                answer=answer,
                deterministic_strategy=(
                    "Encode the current state explicitly, apply one transition at a time without reordering, "
                    "and independently check the final result by summing all deltas once."
                ),
                verifier=lambda value, expected=answer: value.strip() == expected,
                family="state_transition",
            )
        if family == 2:
            symbols = rng.sample(list(string.ascii_uppercase), 4)
            a, b, c, _ = symbols
            answer = "yes"
            return ProceduralTask(
                prompt=(
                    f"In a novel logic: every {a} is a {b}; every {b} is a {c}; object z is a {a}. "
                    f"Must z be a {c}?"
                ),
                answer=answer,
                deterministic_strategy=(
                    "Translate each universal statement into a directed implication, follow the implication chain "
                    "from the object's known class, and check whether the queried class is reachable."
                ),
                verifier=lambda value: value.strip().lower() == "yes",
                family="deduction",
            )
        if family == 3:
            width = rng.randint(3, 6)
            bits = [rng.randint(0, 1) for _ in range(width)]
            parity = sum(bits) % 2
            answer = str(parity)
            return ProceduralTask(
                prompt=f"An invented machine outputs parity for bits {bits}. Return 0 for even ones and 1 for odd ones.",
                answer=answer,
                deterministic_strategy=(
                    "Count the active bits modulo two rather than storing the full count; toggle a one-bit state "
                    "for each active input and verify against the ordinary count."
                ),
                verifier=lambda value, expected=answer: value.strip() == expected,
                family="finite_state_algorithm",
            )
        mapping = {character: rng.randint(1, 9) for character in rng.sample(list("uvwxyz"), 4)}
        sequence = [rng.choice(list(mapping)) for _ in range(5)]
        answer = str(sum(mapping[value] for value in sequence))
        return ProceduralTask(
            prompt=f"In a temporary codebook {mapping}, decode sequence {sequence} and sum the numeric values.",
            answer=answer,
            deterministic_strategy=(
                "Treat the codebook as local task state, substitute each symbol exactly once, aggregate the decoded "
                "values, and re-check every lookup against the supplied mapping rather than prior knowledge."
            ),
            verifier=lambda value, expected=answer: value.strip() == expected,
            family="variable_binding",
        )
