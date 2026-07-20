from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import torch
from safetensors.torch import load_file, save_file
from torch import Tensor

from genesis_os.model.checkpoint import CheckpointManager
from genesis_os.model.constrained import IncrementalByteDecoder, SchemaActionDecoder
from genesis_os.model.network import GenesisNetwork
from genesis_os.model.tokenizer import ByteTokenizer
from genesis_os.types import CheckpointRef, ToolCall


@dataclass(slots=True)
class CognitiveState:
    memory: Tensor
    world_state: Tensor
    step: int = 0


class CognitiveStateStore:
    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def _base(self, lineage_id: str, session_id: str) -> Path:
        safe_session = "".join(
            character if character.isalnum() or character in "-_" else "_"
            for character in session_id
        )
        return self.root / lineage_id / safe_session

    def load(
        self,
        *,
        lineage_id: str,
        session_id: str,
        model: GenesisNetwork,
        device: torch.device | str,
    ) -> CognitiveState:
        base = self._base(lineage_id, session_id)
        tensor_path = base / "cognitive_state.safetensors"
        metadata_path = base / "state.json"
        if not tensor_path.exists():
            return CognitiveState(
                memory=model.initial_memory(1, device=device),
                world_state=torch.zeros(1, model.genome.world_latent_dim, device=device),
            )
        tensors = load_file(tensor_path, device=str(device))
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        return CognitiveState(
            memory=tensors["memory"],
            world_state=tensors["world_state"],
            step=int(metadata.get("step", 0)),
        )

    def save(self, *, lineage_id: str, session_id: str, state: CognitiveState) -> None:
        base = self._base(lineage_id, session_id)
        base.mkdir(parents=True, exist_ok=True)
        save_file(
            {
                "memory": state.memory.detach().cpu().contiguous(),
                "world_state": state.world_state.detach().cpu().contiguous(),
            },
            base / "cognitive_state.safetensors",
        )
        (base / "state.json").write_text(
            json.dumps({"step": state.step}, indent=2, sort_keys=True), encoding="utf-8"
        )


def parse_tool_call(text: str) -> ToolCall:
    decoder = json.JSONDecoder()
    failures: list[str] = []
    for position, character in enumerate(text):
        if character != "{":
            continue
        try:
            value, _ = decoder.raw_decode(text[position:])
        except json.JSONDecodeError as error:
            failures.append(str(error))
            continue
        if not isinstance(value, dict):
            continue
        tool = value.get("tool")
        arguments = value.get("arguments", {})
        if isinstance(tool, str) and isinstance(arguments, dict):
            return ToolCall(tool=tool, arguments=arguments)
    detail = failures[-1] if failures else "no JSON object found"
    raise ValueError(f"Model did not emit a valid tool call: {detail}; raw={text[:500]!r}")


class Organism:
    """Read-only Wake-time wrapper around a promoted checkpoint and persistent cognitive state."""

    def __init__(
        self,
        *,
        reference: CheckpointRef,
        model: GenesisNetwork,
        state_store: CognitiveStateStore,
        device: torch.device | str = "cpu",
    ) -> None:
        self.reference = reference
        self.model = model.to(device).eval()
        self.state_store = state_store
        self.device = torch.device(device)
        if self.device.type == "cpu":
            torch.set_num_threads(min(4, max(1, torch.get_num_threads())))
        self.tokenizer = ByteTokenizer()
        for parameter in self.model.parameters():
            parameter.requires_grad_(False)

    @classmethod
    def from_checkpoint(
        cls,
        reference: CheckpointRef,
        *,
        state_root: str | Path,
        device: torch.device | str = "cpu",
    ) -> Organism:
        model, _, _ = CheckpointManager.load(reference.path, device=device)
        return cls(
            reference=reference,
            model=model,
            state_store=CognitiveStateStore(state_root),
            device=device,
        )

    @torch.inference_mode()
    def generate_raw(
        self,
        prompt: str,
        *,
        session_id: str,
        max_new_tokens: int,
        temperature: float = 0.0,
        top_p: float = 0.95,
    ) -> str:
        max_new_tokens = min(max_new_tokens, max(16, self.model.genome.max_sequence_length // 2))
        state = self.state_store.load(
            lineage_id=self.reference.lineage_id,
            session_id=session_id,
            model=self.model,
            device=self.device,
        )
        max_prompt = max(1, self.model.genome.max_sequence_length - max_new_tokens)
        prompt_ids = self.tokenizer.encode(prompt, bos=True)[-max_prompt:]
        input_ids = torch.tensor([prompt_ids], dtype=torch.long, device=self.device)
        output = self.model(
            input_ids,
            memory_state=state.memory,
            world_state=state.world_state,
            use_cache=True,
        )
        cache = output.past_key_values
        logits = output.logits[:, -1, :]
        generated: list[int] = []
        final_pooled = output.pooled
        final_world_mean = output.world_mean
        for _ in range(max_new_tokens):
            next_token = self._sample(logits, temperature=temperature, top_p=top_p)
            token_id = int(next_token.item())
            if token_id == self.tokenizer.EOS:
                break
            generated.append(token_id)
            step_output = self.model(
                next_token.view(1, 1),
                memory_state=state.memory,
                past_key_values=cache,
                use_cache=True,
                world_state=state.world_state,
            )
            cache = step_output.past_key_values
            logits = step_output.logits[:, -1, :]
            final_pooled = step_output.pooled
            final_world_mean = step_output.world_mean
        state.memory = self.model.advance_memory(state.memory, final_pooled)
        state.world_state = final_world_mean
        state.step += 1
        self.state_store.save(
            lineage_id=self.reference.lineage_id,
            session_id=session_id,
            state=state,
        )
        return self.tokenizer.decode(generated)

    @staticmethod
    def _sample(logits: Tensor, *, temperature: float, top_p: float) -> Tensor:
        if temperature <= 0:
            return torch.argmax(logits, dim=-1)
        scaled = logits / max(temperature, 1e-6)
        probabilities = torch.softmax(scaled, dim=-1)
        if top_p < 1.0:
            sorted_probabilities, sorted_indices = torch.sort(probabilities, descending=True)
            cumulative = torch.cumsum(sorted_probabilities, dim=-1)
            remove = cumulative - sorted_probabilities > top_p
            sorted_probabilities = sorted_probabilities.masked_fill(remove, 0.0)
            sorted_probabilities /= sorted_probabilities.sum(dim=-1, keepdim=True)
            sampled_position = torch.multinomial(sorted_probabilities, num_samples=1)
            return sorted_indices.gather(-1, sampled_position).squeeze(-1)
        return torch.multinomial(probabilities, num_samples=1).squeeze(-1)

    def generate_tool_call(
        self,
        prompt: str,
        *,
        session_id: str,
        max_new_tokens: int,
        temperature: float,
        top_p: float,
        tool_specs: list[dict[str, object]] | None = None,
    ) -> tuple[ToolCall, str]:
        if not tool_specs:
            raw = self.generate_raw(
                prompt,
                session_id=session_id,
                max_new_tokens=max_new_tokens,
                temperature=temperature,
                top_p=top_p,
            )
            return parse_tool_call(raw), raw
        max_new_tokens = min(max_new_tokens, max(32, self.model.genome.max_sequence_length // 2))
        state = self.state_store.load(
            lineage_id=self.reference.lineage_id,
            session_id=session_id,
            model=self.model,
            device=self.device,
        )
        decoder = IncrementalByteDecoder(
            model=self.model,
            tokenizer=self.tokenizer,
            prompt=prompt,
            memory=state.memory,
            world_state=state.world_state,
            max_new_tokens=max_new_tokens,
            device=self.device,
        )
        tool_name, arguments = SchemaActionDecoder(decoder).decode(tool_specs)
        state.memory = self.model.advance_memory(state.memory, decoder.state.pooled)
        state.world_state = decoder.state.world_mean
        state.step += 1
        self.state_store.save(
            lineage_id=self.reference.lineage_id,
            session_id=session_id,
            state=state,
        )
        raw = decoder.text()
        return ToolCall(tool=tool_name, arguments=arguments), raw

    @property
    def self_state(self) -> dict[str, Any]:
        return {
            "lineage_id": self.reference.lineage_id,
            "release_id": self.reference.release_id,
            "parent_release_id": self.reference.parent_release_id,
            "wake_weights_mutable": False,
        }
