from __future__ import annotations

from typing import Literal

from pydantic import Field, model_validator

from genesis_os.types import FrozenModel


class ModelGenome(FrozenModel):
    architecture: Literal["genesis_workspace_v1"] = "genesis_workspace_v1"
    vocab_size: int = 260
    d_model: int = Field(default=192, ge=32, le=8192)
    n_layers: int = Field(default=6, ge=1, le=128)
    n_heads: int = Field(default=6, ge=1, le=128)
    ff_multiplier: float = Field(default=4.0, ge=1.0, le=16.0)
    max_sequence_length: int = Field(default=1024, ge=64, le=262144)
    memory_slots: int = Field(default=16, ge=1, le=512)
    dropout: float = Field(default=0.0, ge=0.0, lt=1.0)
    image_channels: int = Field(default=3, ge=1, le=16)
    image_patch_size: int = Field(default=16, ge=2, le=64)
    audio_kernel_size: int = Field(default=320, ge=16, le=4096)
    audio_stride: int = Field(default=160, ge=8, le=2048)
    structured_feature_dim: int = Field(default=64, ge=1, le=65536)
    max_modality_tokens: int = Field(default=256, ge=1, le=8192)
    world_latent_dim: int = Field(default=128, ge=16, le=4096)
    tie_embeddings: bool = True

    @model_validator(mode="after")
    def validate_dimensions(self) -> ModelGenome:
        if self.d_model % self.n_heads != 0:
            raise ValueError("d_model must be divisible by n_heads")
        return self
