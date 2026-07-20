from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import torch
from safetensors.torch import load_file, save_file

from genesis_os.model.genome import ModelGenome
from genesis_os.model.network import GenesisNetwork
from genesis_os.security.authority import (
    AuthorityPurpose,
    TrainingAuthority,
    TrainingAuthorityIssuer,
)


class CheckpointManager:
    def __init__(self, issuer: TrainingAuthorityIssuer) -> None:
        self.issuer = issuer

    def save(
        self,
        model: GenesisNetwork,
        genome: ModelGenome,
        directory: str | Path,
        *,
        authority: TrainingAuthority,
        metadata: dict[str, Any] | None = None,
    ) -> Path:
        self.issuer.validate(
            authority, AuthorityPurpose.BIRTH, AuthorityPurpose.SLEEP, AuthorityPurpose.EVOLUTION
        )
        target = Path(directory)
        target.mkdir(parents=True, exist_ok=True)
        tensors = {
            name: tensor.detach().cpu().contiguous().clone()
            for name, tensor in model.state_dict().items()
        }
        save_file(tensors, target / "model.safetensors")
        (target / "genome.json").write_text(genome.model_dump_json(indent=2), encoding="utf-8")
        (target / "checkpoint.json").write_text(
            json.dumps(metadata or {}, indent=2, sort_keys=True, ensure_ascii=False),
            encoding="utf-8",
        )
        return target

    @staticmethod
    def load(
        directory: str | Path,
        *,
        device: torch.device | str = "cpu",
    ) -> tuple[GenesisNetwork, ModelGenome, dict[str, Any]]:
        source = Path(directory)
        genome = ModelGenome.model_validate_json(
            (source / "genome.json").read_text(encoding="utf-8")
        )
        model = GenesisNetwork(genome).to(device)
        state = load_file(source / "model.safetensors", device=str(device))
        missing, unexpected = model.load_state_dict(state, strict=False)
        if missing or unexpected:
            raise RuntimeError(f"Checkpoint mismatch: missing={missing}, unexpected={unexpected}")
        metadata_path = source / "checkpoint.json"
        metadata = (
            json.loads(metadata_path.read_text(encoding="utf-8")) if metadata_path.exists() else {}
        )
        return model, genome, metadata
