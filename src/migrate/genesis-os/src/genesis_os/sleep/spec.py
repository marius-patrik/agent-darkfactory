from __future__ import annotations

from pydantic import Field

from genesis_os.training.trainer import TrainingConfig
from genesis_os.types import FrozenModel


class PromotionGateSpec(FrozenModel):
    max_new_loss_regression: float = Field(default=0.0, ge=0.0)
    min_new_loss_improvement: float = Field(default=0.0, ge=0.0)
    max_foundation_relative_regression: float = Field(default=0.03, ge=0.0, le=1.0)
    max_tool_accuracy_drop: float = Field(default=0.05, ge=0.0, le=1.0)
    require_ledger_integrity: bool = True


class SleepSpec(FrozenModel):
    seed: int = 1337
    min_new_events: int = Field(default=1, ge=1)
    validation_fraction: float = Field(default=0.15, gt=0.0, lt=0.5)
    replay_examples: int = Field(default=512, ge=0, le=10_000_000)
    max_experience_examples: int = Field(default=50_000, ge=1)
    generation_samples: int = Field(default=12, ge=0, le=10_000)
    max_generation_tokens: int = Field(default=256, ge=16, le=8192)
    training: TrainingConfig = TrainingConfig(
        epochs=1,
        max_steps=200,
        batch_size=8,
        learning_rate=1e-4,
        weight_decay=0.05,
        warmup_steps=10,
    )
    gate: PromotionGateSpec = PromotionGateSpec()
