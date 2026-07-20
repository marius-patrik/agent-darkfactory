from __future__ import annotations

from typing import Any

import torch

from genesis_os.model.network import GenesisNetwork
from genesis_os.model.tokenizer import ByteTokenizer
from genesis_os.training.trainer import resolve_device


class RealityModel:
    """Probabilistic, action-conditional latent simulator backed by Genesis world heads."""

    def __init__(self, model: GenesisNetwork, *, device: str = "auto") -> None:
        self.device = resolve_device(device)
        self.model = model.to(self.device).eval()
        self.tokenizer = ByteTokenizer()

    @torch.inference_mode()
    def encode_state(self, description: str) -> torch.Tensor:
        ids = self.tokenizer.encode(f"WORLD STATE:\n{description}", bos=True)[
            -self.model.genome.max_sequence_length :
        ]
        input_ids = torch.tensor([ids], dtype=torch.long, device=self.device)
        output = self.model(input_ids)
        return self.model.encode_world_target(output.pooled)

    @torch.inference_mode()
    def simulate(self, request: dict[str, Any]) -> dict[str, Any]:
        state_description = str(request["state"])
        interventions = [str(value) for value in request["interventions"]]
        horizon = int(request.get("horizon", len(interventions)))
        samples = int(request.get("samples", 8))
        seed = int(request.get("seed", 0))
        generator = torch.Generator(device=self.device).manual_seed(seed)
        initial = self.encode_state(state_description).expand(samples, -1).clone()
        trajectories: list[torch.Tensor] = [initial]
        means: list[torch.Tensor] = []
        deviations: list[torch.Tensor] = []
        current = initial
        memory = self.model.initial_memory(samples, device=self.device)
        for step in range(horizon):
            intervention = interventions[min(step, len(interventions) - 1)]
            ids = self.tokenizer.encode(f"INTERVENTION {step}:\n{intervention}", bos=True)[
                -self.model.genome.max_sequence_length :
            ]
            input_ids = torch.tensor([ids], dtype=torch.long, device=self.device).expand(
                samples, -1
            )
            output = self.model(input_ids, memory_state=memory, world_state=current)
            standard_deviation = torch.exp(0.5 * output.world_log_variance)
            noise = torch.randn(
                output.world_mean.shape,
                generator=generator,
                device=self.device,
                dtype=output.world_mean.dtype,
            )
            current = output.world_mean + standard_deviation * noise
            memory = output.next_memory
            trajectories.append(current)
            means.append(output.world_mean.mean(dim=0))
            deviations.append(current.std(dim=0, unbiased=False))
        stacked = torch.stack(trajectories, dim=1)
        return {
            "representation": "genesis_world_latent_v1",
            "horizon": horizon,
            "samples": samples,
            "latent_dimension": self.model.genome.world_latent_dim,
            "trajectory_mean": stacked.mean(dim=0).cpu().tolist(),
            "trajectory_std": stacked.std(dim=0, unbiased=False).cpu().tolist(),
            "step_predictive_means": [value.cpu().tolist() for value in means],
            "step_sample_std": [value.cpu().tolist() for value in deviations],
            "calibration_note": (
                "These are learned latent distributions, not guaranteed physical truth. Fidelity depends "
                "on the model's experience and evaluation in the requested domain."
            ),
        }
