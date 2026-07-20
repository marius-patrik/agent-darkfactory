from __future__ import annotations

from enum import StrEnum
from pathlib import Path

from pydantic import Field

from genesis_os.birth.teacher import TeacherSpec
from genesis_os.model.genome import ModelGenome
from genesis_os.training.trainer import TrainingConfig
from genesis_os.types import FrozenModel


class InitializationMode(StrEnum):
    RANDOM = "random"
    INHERIT = "inherit"


class InitializationSpec(FrozenModel):
    mode: InitializationMode = InitializationMode.RANDOM
    checkpoint: Path | None = None
    strict: bool = True


class CurriculumStageSpec(FrozenModel):
    name: str
    generator: str
    examples: int = Field(default=256, ge=1, le=100_000_000)
    weight: float = Field(default=1.0, gt=0.0)
    prerequisites: tuple[str, ...] = ()
    parameters: dict[str, object] = Field(default_factory=dict)


class PersonalDataSpec(FrozenModel):
    sources: tuple[Path, ...] = ()
    include_assistant_imitation: bool = False
    assistant_imitation_weight: float = Field(default=0.15, ge=0.0, le=1.0)
    redact_secrets: bool = True
    max_record_characters: int = Field(default=16_000, ge=128, le=1_000_000)


class CurriculumSpec(FrozenModel):
    seed: int = 42
    validation_fraction: float = Field(default=0.08, gt=0.0, lt=0.5)
    teacher: TeacherSpec | None = None
    stages: tuple[CurriculumStageSpec, ...] = (
        CurriculumStageSpec(name="language", generator="language_foundations", examples=256),
        CurriculumStageSpec(name="arithmetic", generator="arithmetic", examples=512),
        CurriculumStageSpec(name="logic", generator="symbolic_logic", examples=384),
        CurriculumStageSpec(name="algorithms", generator="algorithms", examples=384),
        CurriculumStageSpec(name="causality", generator="causal_worlds", examples=384),
        CurriculumStageSpec(name="tools", generator="tool_use", examples=512, weight=1.4),
        CurriculumStageSpec(name="memory", generator="memory_recall", examples=384, weight=1.3),
    )
    personal: PersonalDataSpec = PersonalDataSpec()
    mastery_threshold: float = Field(default=0.65, ge=0.0, le=1.0)
    remediation_rounds: int = Field(default=1, ge=0, le=20)
    remediation_examples_per_task: int = Field(default=128, ge=1, le=100_000)


class ViabilitySpec(FrozenModel):
    max_validation_loss: float = Field(default=8.0, gt=0.0)
    min_tool_name_accuracy: float = Field(default=0.0, ge=0.0, le=1.0)
    generation_samples: int = Field(default=24, ge=0, le=10_000)
    max_generation_tokens: int = Field(default=256, ge=16, le=8192)


class BirthSpec(FrozenModel):
    name: str = "genesis-organism"
    lineage_id: str | None = None
    seed: int = 42
    genome: ModelGenome = ModelGenome()
    initialization: InitializationSpec = InitializationSpec()
    curriculum: CurriculumSpec = CurriculumSpec()
    training: TrainingConfig = TrainingConfig()
    viability: ViabilitySpec = ViabilitySpec()
    metadata: dict[str, object] = Field(default_factory=dict)
