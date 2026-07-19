from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

import torch
from torch import Tensor
from torch.utils.data import Dataset

from genesis_os.model.tokenizer import ByteTokenizer
from genesis_os.types import TrainingExample


def canonical_example(example: TrainingExample) -> TrainingExample:
    """Assign a content-derived identifier so compiled datasets are reproducible."""
    payload = example.model_dump(mode="json", exclude={"id"})
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    identifier = f"example_{hashlib.sha256(encoded).hexdigest()[:32]}"
    return example.model_copy(update={"id": identifier})


@dataclass(slots=True)
class TokenizedExample:
    input_ids: list[int]
    labels: list[int]
    next_input_ids: list[int] | None
    weight: float
    outcome: float | None
    example_id: str
    task: str


@dataclass(slots=True)
class TrainingBatch:
    input_ids: Tensor
    attention_mask: Tensor
    labels: Tensor
    next_input_ids: Tensor | None
    next_attention_mask: Tensor | None
    weights: Tensor
    outcomes: Tensor
    outcome_mask: Tensor
    example_ids: list[str]
    tasks: list[str]

    def to(self, device: torch.device | str) -> TrainingBatch:
        return TrainingBatch(
            input_ids=self.input_ids.to(device),
            attention_mask=self.attention_mask.to(device),
            labels=self.labels.to(device),
            next_input_ids=None if self.next_input_ids is None else self.next_input_ids.to(device),
            next_attention_mask=(
                None if self.next_attention_mask is None else self.next_attention_mask.to(device)
            ),
            weights=self.weights.to(device),
            outcomes=self.outcomes.to(device),
            outcome_mask=self.outcome_mask.to(device),
            example_ids=self.example_ids,
            tasks=self.tasks,
        )


class CausalExampleDataset(Dataset[TokenizedExample]):
    def __init__(
        self,
        examples: list[TrainingExample],
        *,
        tokenizer: ByteTokenizer | None = None,
        max_sequence_length: int = 1024,
    ) -> None:
        self.examples = examples
        self.tokenizer = tokenizer or ByteTokenizer()
        self.max_sequence_length = max_sequence_length

    @classmethod
    def from_jsonl(
        cls,
        path: str | Path,
        *,
        tokenizer: ByteTokenizer | None = None,
        max_sequence_length: int = 1024,
    ) -> CausalExampleDataset:
        examples: list[TrainingExample] = []
        with Path(path).open("r", encoding="utf-8") as handle:
            for line in handle:
                if line.strip():
                    examples.append(TrainingExample.model_validate_json(line))
        return cls(examples, tokenizer=tokenizer, max_sequence_length=max_sequence_length)

    def __len__(self) -> int:
        return len(self.examples)

    def __getitem__(self, index: int) -> TokenizedExample:
        example = self.examples[index]
        target = self.tokenizer.encode(example.target, eos=True)
        if len(target) >= self.max_sequence_length:
            target = [*target[: self.max_sequence_length - 1], self.tokenizer.EOS]
        prompt_budget = self.max_sequence_length - len(target)
        prompt = self.tokenizer.encode(example.prompt, bos=True)
        if len(prompt) > prompt_budget:
            # Preserve BOS and the most recent prompt bytes.
            prompt = [self.tokenizer.BOS, *prompt[-max(0, prompt_budget - 1) :]]
        sequence = prompt + target
        input_ids = sequence[:-1]
        labels = sequence[1:]
        prediction_start = max(0, len(prompt) - 1)
        labels = [-100] * prediction_start + labels[prediction_start:]
        next_input_ids: list[int] | None = None
        if example.next_context:
            next_input_ids = self.tokenizer.encode(example.next_context, bos=True)[
                -self.max_sequence_length :
            ]
        return TokenizedExample(
            input_ids=input_ids,
            labels=labels,
            next_input_ids=next_input_ids,
            weight=example.weight,
            outcome=example.outcome,
            example_id=example.id,
            task=example.task,
        )


def collate_examples(examples: list[TokenizedExample]) -> TrainingBatch:
    if not examples:
        raise ValueError("Cannot collate an empty batch")
    pad = ByteTokenizer.PAD
    max_length = max(len(example.input_ids) for example in examples)
    input_ids = torch.full((len(examples), max_length), pad, dtype=torch.long)
    labels = torch.full((len(examples), max_length), -100, dtype=torch.long)
    attention_mask = torch.zeros((len(examples), max_length), dtype=torch.bool)
    for row, example in enumerate(examples):
        length = len(example.input_ids)
        input_ids[row, :length] = torch.tensor(example.input_ids, dtype=torch.long)
        labels[row, :length] = torch.tensor(example.labels, dtype=torch.long)
        attention_mask[row, :length] = True

    next_values = [example.next_input_ids for example in examples]
    next_input_ids: Tensor | None = None
    next_attention_mask: Tensor | None = None
    if any(value is not None for value in next_values):
        next_max = max(len(value or [pad]) for value in next_values)
        next_input_ids = torch.full((len(examples), next_max), pad, dtype=torch.long)
        next_attention_mask = torch.zeros((len(examples), next_max), dtype=torch.bool)
        for row, value in enumerate(next_values):
            if value:
                next_input_ids[row, : len(value)] = torch.tensor(value, dtype=torch.long)
                next_attention_mask[row, : len(value)] = True

    outcomes = torch.tensor(
        [0.0 if example.outcome is None else example.outcome for example in examples],
        dtype=torch.float32,
    )
    outcome_mask = torch.tensor(
        [example.outcome is not None for example in examples], dtype=torch.bool
    )
    return TrainingBatch(
        input_ids=input_ids,
        attention_mask=attention_mask,
        labels=labels,
        next_input_ids=next_input_ids,
        next_attention_mask=next_attention_mask,
        weights=torch.tensor([example.weight for example in examples], dtype=torch.float32),
        outcomes=outcomes,
        outcome_mask=outcome_mask,
        example_ids=[example.example_id for example in examples],
        tasks=[example.task for example in examples],
    )


def write_examples(path: str | Path, examples: list[TrainingExample]) -> Path:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("w", encoding="utf-8") as handle:
        for example in examples:
            canonical = canonical_example(example)
            handle.write(
                json.dumps(
                    canonical.model_dump(mode="json"),
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                )
                + "\n"
            )
    return target


def read_examples(path: str | Path) -> list[TrainingExample]:
    values: list[TrainingExample] = []
    with Path(path).open("r", encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                values.append(TrainingExample.model_validate(json.loads(line)))
    return values
