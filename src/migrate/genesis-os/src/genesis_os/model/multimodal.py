from __future__ import annotations

from dataclasses import dataclass

import torch
from torch import Tensor, nn

from genesis_os.model.genome import ModelGenome


@dataclass(slots=True)
class MultimodalInputs:
    images: Tensor | None = None  # [batch, channels, height, width]
    audio: Tensor | None = None  # [batch, samples] or [batch, 1, samples]
    structured: Tensor | None = None  # [batch, feature_dim]


@dataclass(slots=True)
class ModalityEncoding:
    shared: Tensor
    private: Tensor
    mask: Tensor
    type_ids: Tensor


class SharedPrivateProjector(nn.Module):
    """Preserves modality-private residuals while exposing a shared world representation."""

    def __init__(self, d_model: int) -> None:
        super().__init__()
        self.shared = nn.Sequential(nn.LayerNorm(d_model), nn.Linear(d_model, d_model))
        self.private = nn.Sequential(nn.LayerNorm(d_model), nn.Linear(d_model, d_model))
        self.gate = nn.Sequential(nn.Linear(d_model * 2, d_model), nn.Sigmoid())

    def forward(self, values: Tensor) -> tuple[Tensor, Tensor, Tensor]:
        shared = self.shared(values)
        private = self.private(values)
        gate = self.gate(torch.cat((shared, private), dim=-1))
        fused = gate * shared + (1.0 - gate) * private
        return fused, shared, private


class ImagePatchEncoder(nn.Module):
    def __init__(self, channels: int, d_model: int, patch_size: int) -> None:
        super().__init__()
        self.projection = nn.Conv2d(
            channels, d_model, kernel_size=patch_size, stride=patch_size, bias=False
        )
        self.normalization = nn.LayerNorm(d_model)

    def forward(self, images: Tensor) -> Tensor:
        if images.ndim != 4:
            raise ValueError("images must have shape [batch, channels, height, width]")
        values = self.projection(images).flatten(2).transpose(1, 2)
        return self.normalization(values)


class AudioFrameEncoder(nn.Module):
    def __init__(self, d_model: int, kernel_size: int, stride: int) -> None:
        super().__init__()
        self.projection = nn.Conv1d(1, d_model, kernel_size=kernel_size, stride=stride, bias=False)
        self.normalization = nn.LayerNorm(d_model)

    def forward(self, audio: Tensor) -> Tensor:
        if audio.ndim == 2:
            audio = audio.unsqueeze(1)
        if audio.ndim != 3 or audio.shape[1] != 1:
            raise ValueError("audio must have shape [batch, samples] or [batch, 1, samples]")
        if audio.shape[-1] < self.projection.kernel_size[0]:
            padding = self.projection.kernel_size[0] - audio.shape[-1]
            audio = torch.nn.functional.pad(audio, (0, padding))
        values = self.projection(audio).transpose(1, 2)
        return self.normalization(values)


class StructuredFeatureEncoder(nn.Module):
    def __init__(self, feature_dim: int, d_model: int) -> None:
        super().__init__()
        self.network = nn.Sequential(
            nn.LayerNorm(feature_dim),
            nn.Linear(feature_dim, d_model * 2),
            nn.GELU(),
            nn.Linear(d_model * 2, d_model),
            nn.LayerNorm(d_model),
        )

    def forward(self, structured: Tensor) -> Tensor:
        if structured.ndim != 2:
            raise ValueError("structured features must have shape [batch, feature_dim]")
        return self.network(structured).unsqueeze(1)


class ModalityEncoderBank(nn.Module):
    IMAGE_TYPE = 1
    AUDIO_TYPE = 2
    STRUCTURED_TYPE = 3

    def __init__(self, genome: ModelGenome) -> None:
        super().__init__()
        self.genome = genome
        self.image = ImagePatchEncoder(
            genome.image_channels, genome.d_model, genome.image_patch_size
        )
        self.audio = AudioFrameEncoder(
            genome.d_model, genome.audio_kernel_size, genome.audio_stride
        )
        self.structured = StructuredFeatureEncoder(genome.structured_feature_dim, genome.d_model)
        self.projectors = nn.ModuleDict(
            {
                "image": SharedPrivateProjector(genome.d_model),
                "audio": SharedPrivateProjector(genome.d_model),
                "structured": SharedPrivateProjector(genome.d_model),
            }
        )

    def forward(self, inputs: MultimodalInputs | None) -> ModalityEncoding | None:
        if inputs is None:
            return None
        encoded: list[tuple[str, int, Tensor]] = []
        if inputs.images is not None:
            encoded.append(("image", self.IMAGE_TYPE, self.image(inputs.images)))
        if inputs.audio is not None:
            encoded.append(("audio", self.AUDIO_TYPE, self.audio(inputs.audio)))
        if inputs.structured is not None:
            encoded.append(("structured", self.STRUCTURED_TYPE, self.structured(inputs.structured)))
        if not encoded:
            return None
        shared_parts: list[Tensor] = []
        private_parts: list[Tensor] = []
        fused_parts: list[Tensor] = []
        type_parts: list[Tensor] = []
        for name, type_id, values in encoded:
            values = values[:, : self.genome.max_modality_tokens]
            fused, shared, private = self.projectors[name](values)
            fused_parts.append(fused)
            shared_parts.append(shared)
            private_parts.append(private)
            type_parts.append(
                torch.full(
                    (values.shape[0], values.shape[1]),
                    type_id,
                    dtype=torch.long,
                    device=values.device,
                )
            )
        fused = torch.cat(fused_parts, dim=1)[:, : self.genome.max_modality_tokens]
        shared = torch.cat(shared_parts, dim=1)[:, : self.genome.max_modality_tokens]
        private = torch.cat(private_parts, dim=1)[:, : self.genome.max_modality_tokens]
        type_ids = torch.cat(type_parts, dim=1)[:, : self.genome.max_modality_tokens]
        mask = torch.ones(fused.shape[:2], dtype=torch.bool, device=fused.device)
        # Fused is represented as shared + private residual; both are returned for auxiliary losses.
        return ModalityEncoding(
            shared=fused + 0.0 * shared,
            private=private,
            mask=mask,
            type_ids=type_ids,
        )
