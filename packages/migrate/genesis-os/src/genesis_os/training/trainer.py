from __future__ import annotations

import math
import random
import time
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import torch
import torch.nn.functional as F
from pydantic import BaseModel, ConfigDict, Field
from torch import Tensor
from torch.optim import AdamW
from torch.utils.data import DataLoader

from genesis_os.model.network import GenesisNetwork
from genesis_os.training.dataset import CausalExampleDataset, TrainingBatch, collate_examples


class TrainingConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    seed: int = 42
    epochs: int = Field(default=1, ge=1, le=10000)
    max_steps: int | None = Field(default=None, ge=1)
    batch_size: int = Field(default=8, ge=1, le=4096)
    learning_rate: float = Field(default=3e-4, gt=0.0)
    weight_decay: float = Field(default=0.1, ge=0.0)
    warmup_steps: int = Field(default=20, ge=0)
    gradient_accumulation_steps: int = Field(default=1, ge=1, le=1024)
    max_gradient_norm: float = Field(default=1.0, gt=0.0)
    world_loss_weight: float = Field(default=0.2, ge=0.0)
    value_loss_weight: float = Field(default=0.1, ge=0.0)
    uncertainty_loss_weight: float = Field(default=0.02, ge=0.0)
    device: str = "auto"
    num_workers: int = Field(default=0, ge=0, le=64)
    cpu_threads: int = Field(default=4, ge=1, le=256)
    deterministic: bool = True
    log_every: int = Field(default=10, ge=1)


@dataclass(slots=True)
class TrainingReport:
    steps: int
    epochs_completed: int
    train_loss: float
    language_loss: float
    world_loss: float
    value_loss: float
    uncertainty_loss: float
    tokens: int
    duration_seconds: float
    history: list[dict[str, float]] = field(default_factory=list)

    def as_metrics(self) -> dict[str, float]:
        return {
            "steps": float(self.steps),
            "train_loss": self.train_loss,
            "language_loss": self.language_loss,
            "world_loss": self.world_loss,
            "value_loss": self.value_loss,
            "uncertainty_loss": self.uncertainty_loss,
            "tokens": float(self.tokens),
            "duration_seconds": self.duration_seconds,
        }


def resolve_device(value: str) -> torch.device:
    if value != "auto":
        return torch.device(value)
    if torch.cuda.is_available():
        return torch.device("cuda")
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def set_seed(seed: int, *, deterministic: bool = True) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
    if deterministic:
        torch.use_deterministic_algorithms(True, warn_only=True)
        if hasattr(torch.backends, "cudnn"):
            torch.backends.cudnn.deterministic = True
            torch.backends.cudnn.benchmark = False


class Trainer:
    def __init__(self, config: TrainingConfig) -> None:
        self.config = config
        self.device = resolve_device(config.device)
        if self.device.type == "cpu":
            torch.set_num_threads(config.cpu_threads)

    def train(
        self,
        model: GenesisNetwork,
        dataset: CausalExampleDataset,
        *,
        progress: Any | None = None,
    ) -> TrainingReport:
        if len(dataset) == 0:
            raise ValueError("Training dataset is empty")
        set_seed(self.config.seed, deterministic=self.config.deterministic)
        model.to(self.device).train()
        loader = DataLoader(
            dataset,
            batch_size=self.config.batch_size,
            shuffle=True,
            num_workers=self.config.num_workers,
            collate_fn=collate_examples,
            generator=torch.Generator().manual_seed(self.config.seed),
        )
        total_possible = len(loader) * self.config.epochs
        total_steps = min(total_possible, self.config.max_steps or total_possible)
        optimizer = AdamW(
            model.parameters(),
            lr=self.config.learning_rate,
            weight_decay=self.config.weight_decay,
            betas=(0.9, 0.95),
        )
        started = time.perf_counter()
        optimizer.zero_grad(set_to_none=True)
        aggregate = {
            "loss": 0.0,
            "language": 0.0,
            "world": 0.0,
            "value": 0.0,
            "uncertainty": 0.0,
        }
        history: list[dict[str, float]] = []
        steps = 0
        tokens = 0
        epochs_completed = 0
        for epoch in range(self.config.epochs):
            for batch in loader:
                if steps >= total_steps:
                    break
                steps += 1
                batch = batch.to(self.device)
                learning_rate = self._learning_rate(steps, total_steps)
                for group in optimizer.param_groups:
                    group["lr"] = learning_rate
                losses = self._losses(model, batch)
                scaled = losses["loss"] / self.config.gradient_accumulation_steps
                scaled.backward()
                if steps % self.config.gradient_accumulation_steps == 0 or steps == total_steps:
                    torch.nn.utils.clip_grad_norm_(
                        model.parameters(), self.config.max_gradient_norm
                    )
                    optimizer.step()
                    optimizer.zero_grad(set_to_none=True)
                for key in aggregate:
                    aggregate[key] += float(losses[key].detach().cpu())
                tokens += int(batch.attention_mask.sum().item())
                if steps % self.config.log_every == 0 or steps == total_steps:
                    point = {
                        "step": float(steps),
                        "loss": aggregate["loss"] / steps,
                        "language_loss": aggregate["language"] / steps,
                        "world_loss": aggregate["world"] / steps,
                        "value_loss": aggregate["value"] / steps,
                        "learning_rate": learning_rate,
                    }
                    history.append(point)
                    if progress is not None:
                        progress(point)
            epochs_completed = epoch + 1
            if steps >= total_steps:
                break
        model.eval()
        divisor = max(steps, 1)
        return TrainingReport(
            steps=steps,
            epochs_completed=epochs_completed,
            train_loss=aggregate["loss"] / divisor,
            language_loss=aggregate["language"] / divisor,
            world_loss=aggregate["world"] / divisor,
            value_loss=aggregate["value"] / divisor,
            uncertainty_loss=aggregate["uncertainty"] / divisor,
            tokens=tokens,
            duration_seconds=time.perf_counter() - started,
            history=history,
        )

    def _learning_rate(self, step: int, total_steps: int) -> float:
        if self.config.warmup_steps > 0 and step <= self.config.warmup_steps:
            return self.config.learning_rate * step / self.config.warmup_steps
        progress = (step - self.config.warmup_steps) / max(
            1, total_steps - self.config.warmup_steps
        )
        return self.config.learning_rate * 0.5 * (1.0 + math.cos(math.pi * progress))

    def _losses(self, model: GenesisNetwork, batch: TrainingBatch) -> dict[str, Tensor]:
        output = model(batch.input_ids, attention_mask=batch.attention_mask)
        vocabulary = output.logits.shape[-1]
        token_losses = F.cross_entropy(
            output.logits.reshape(-1, vocabulary),
            batch.labels.reshape(-1),
            ignore_index=-100,
            reduction="none",
        ).view_as(batch.labels)
        target_mask = batch.labels.ne(-100)
        per_example = (token_losses * target_mask).sum(dim=1) / target_mask.sum(dim=1).clamp_min(1)
        language_loss = (per_example * batch.weights).sum() / batch.weights.sum().clamp_min(1e-8)

        world_loss = torch.zeros((), device=self.device)
        if batch.next_input_ids is not None and batch.next_attention_mask is not None:
            with torch.no_grad():
                target_output = model(
                    batch.next_input_ids, attention_mask=batch.next_attention_mask
                )
                target_world = model.encode_world_target(target_output.pooled).detach()
            inverse_variance = torch.exp(-output.world_log_variance)
            world_nll = 0.5 * (
                output.world_log_variance
                + (target_world - output.world_mean).pow(2) * inverse_variance
            ).mean(dim=-1)
            world_loss = (world_nll * batch.weights).sum() / batch.weights.sum().clamp_min(1e-8)

        value_loss = torch.zeros((), device=self.device)
        uncertainty_loss = torch.zeros((), device=self.device)
        if batch.outcome_mask.any():
            mask = batch.outcome_mask
            value_errors = output.value[mask] - batch.outcomes[mask]
            value_loss = value_errors.pow(2).mean()
            uncertainty_target = value_errors.detach().abs()
            uncertainty_loss = F.smooth_l1_loss(output.uncertainty[mask], uncertainty_target)
        total = (
            language_loss
            + self.config.world_loss_weight * world_loss
            + self.config.value_loss_weight * value_loss
            + self.config.uncertainty_loss_weight * uncertainty_loss
        )
        return {
            "loss": total,
            "language": language_loss,
            "world": world_loss,
            "value": value_loss,
            "uncertainty": uncertainty_loss,
        }

    @torch.inference_mode()
    def evaluate_loss(
        self, model: GenesisNetwork, dataset: CausalExampleDataset, *, batch_size: int | None = None
    ) -> float:
        model.to(self.device).eval()
        loader = DataLoader(
            dataset,
            batch_size=batch_size or self.config.batch_size,
            shuffle=False,
            collate_fn=collate_examples,
        )
        total = 0.0
        count = 0
        for batch in loader:
            batch = batch.to(self.device)
            loss = self._losses(model, batch)["loss"]
            total += float(loss.cpu()) * len(batch.example_ids)
            count += len(batch.example_ids)
        return total / max(count, 1)
