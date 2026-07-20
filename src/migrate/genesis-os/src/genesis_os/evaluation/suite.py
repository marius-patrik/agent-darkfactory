from __future__ import annotations

from collections import defaultdict

import torch
from pydantic import BaseModel, ConfigDict, Field

from genesis_os.model.network import GenesisNetwork
from genesis_os.model.organism import parse_tool_call
from genesis_os.model.tokenizer import ByteTokenizer
from genesis_os.training.dataset import CausalExampleDataset
from genesis_os.training.trainer import Trainer, TrainingConfig, resolve_device
from genesis_os.types import EvaluationResult, TrainingExample


class EvaluationSuite(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    examples: list[TrainingExample]
    generation_samples: int = Field(default=24, ge=0)
    max_generation_tokens: int = Field(default=256, ge=16)
    max_validation_loss: float = Field(default=8.0, gt=0.0)
    min_tool_name_accuracy: float = Field(default=0.0, ge=0.0, le=1.0)


@torch.inference_mode()
def _greedy_generate(
    model: GenesisNetwork,
    prompt: str,
    *,
    tokenizer: ByteTokenizer,
    max_new_tokens: int,
    device: torch.device,
) -> str:
    max_new_tokens = min(max_new_tokens, max(16, model.genome.max_sequence_length // 2))
    max_prompt = max(1, model.genome.max_sequence_length - max_new_tokens)
    prompt_ids = tokenizer.encode(prompt, bos=True)[-max_prompt:]
    input_ids = torch.tensor([prompt_ids], dtype=torch.long, device=device)
    memory = model.initial_memory(1, device=device)
    world = torch.zeros(1, model.genome.world_latent_dim, device=device)
    output = model(input_ids, memory_state=memory, world_state=world, use_cache=True)
    logits = output.logits[:, -1]
    cache = output.past_key_values
    generated: list[int] = []
    for _ in range(max_new_tokens):
        token = torch.argmax(logits, dim=-1)
        token_id = int(token.item())
        if token_id == tokenizer.EOS:
            break
        generated.append(token_id)
        output = model(
            token.view(1, 1),
            memory_state=memory,
            world_state=world,
            past_key_values=cache,
            use_cache=True,
        )
        logits = output.logits[:, -1]
        cache = output.past_key_values
    return tokenizer.decode(generated)


def evaluate_model(
    model: GenesisNetwork,
    suite: EvaluationSuite,
    *,
    device: str = "auto",
) -> EvaluationResult:
    resolved = resolve_device(device)
    model.to(resolved).eval()
    dataset = CausalExampleDataset(
        suite.examples,
        max_sequence_length=model.genome.max_sequence_length,
    )
    evaluator = Trainer(TrainingConfig(device=str(resolved), batch_size=8, epochs=1))
    validation_loss = evaluator.evaluate_loss(model, dataset)
    tokenizer = ByteTokenizer()
    sample_count = min(suite.generation_samples, len(suite.examples))
    tool_correct = 0
    exact_correct = 0
    parseable = 0
    by_task: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    failures: list[str] = []
    for example in suite.examples[:sample_count]:
        generated = _greedy_generate(
            model,
            example.prompt,
            tokenizer=tokenizer,
            max_new_tokens=suite.max_generation_tokens,
            device=resolved,
        )
        try:
            predicted = parse_tool_call(generated)
            expected = parse_tool_call(example.target)
            parseable += 1
            correct_tool = predicted.tool == expected.tool
            if correct_tool:
                tool_correct += 1
            if predicted.tool == expected.tool and predicted.arguments == expected.arguments:
                exact_correct += 1
            by_task[example.task][1] += 1
            if correct_tool:
                by_task[example.task][0] += 1
            elif len(failures) < 20:
                failures.append(
                    f"{example.task}: expected {expected.tool}, got {predicted.tool}; raw={generated[:200]!r}"
                )
        except ValueError as error:
            by_task[example.task][1] += 1
            if len(failures) < 20:
                failures.append(f"{example.task}: {error}")
    denominator = max(sample_count, 1)
    metrics = {
        "validation_loss": validation_loss,
        "parseable_rate": parseable / denominator,
        "tool_name_accuracy": tool_correct / denominator,
        "exact_call_accuracy": exact_correct / denominator,
    }
    for task, (correct, count) in by_task.items():
        metrics[f"task.{task}.tool_accuracy"] = correct / max(count, 1)
    passed = (
        validation_loss <= suite.max_validation_loss
        and metrics["tool_name_accuracy"] >= suite.min_tool_name_accuracy
    )
    if validation_loss > suite.max_validation_loss:
        failures.append(
            f"validation_loss {validation_loss:.4f} exceeds {suite.max_validation_loss:.4f}"
        )
    if metrics["tool_name_accuracy"] < suite.min_tool_name_accuracy:
        failures.append(
            f"tool_name_accuracy {metrics['tool_name_accuracy']:.4f} below "
            f"{suite.min_tool_name_accuracy:.4f}"
        )
    return EvaluationResult(
        suite=suite.name,
        metrics=metrics,
        passed=passed,
        failures=failures,
        details={"sample_count": sample_count},
    )
