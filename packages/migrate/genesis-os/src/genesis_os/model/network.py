from __future__ import annotations

import math
from dataclasses import dataclass

import torch
import torch.nn.functional as F
from torch import Tensor, nn

from genesis_os.model.genome import ModelGenome
from genesis_os.model.multimodal import ModalityEncoderBank, MultimodalInputs


@dataclass(slots=True)
class NetworkOutput:
    logits: Tensor
    pooled: Tensor
    next_memory: Tensor
    world_mean: Tensor
    world_log_variance: Tensor
    value: Tensor
    uncertainty: Tensor
    self_state: Tensor
    user_state: Tensor
    past_key_values: list[tuple[Tensor, Tensor]] | None = None
    private_modality_state: Tensor | None = None


class RMSNorm(nn.Module):
    def __init__(self, dimension: int, epsilon: float = 1e-6) -> None:
        super().__init__()
        self.weight = nn.Parameter(torch.ones(dimension))
        self.epsilon = epsilon

    def forward(self, values: Tensor) -> Tensor:
        normalized = values * torch.rsqrt(values.pow(2).mean(dim=-1, keepdim=True) + self.epsilon)
        return self.weight * normalized


class CausalSelfAttention(nn.Module):
    def __init__(self, genome: ModelGenome) -> None:
        super().__init__()
        self.n_heads = genome.n_heads
        self.head_dim = genome.d_model // genome.n_heads
        self.qkv = nn.Linear(genome.d_model, genome.d_model * 3, bias=False)
        self.output = nn.Linear(genome.d_model, genome.d_model, bias=False)
        self.dropout = genome.dropout

    def forward(
        self,
        values: Tensor,
        *,
        key_padding_mask: Tensor | None = None,
        past_key_value: tuple[Tensor, Tensor] | None = None,
        use_cache: bool = False,
    ) -> tuple[Tensor, tuple[Tensor, Tensor] | None]:
        batch, sequence, dimension = values.shape
        qkv = self.qkv(values).view(batch, sequence, 3, self.n_heads, self.head_dim)
        query, key, value = qkv.unbind(dim=2)
        query = query.transpose(1, 2)
        key = key.transpose(1, 2)
        value = value.transpose(1, 2)
        past_length = 0
        if past_key_value is not None:
            past_key, past_value = past_key_value
            past_length = past_key.shape[2]
            key = torch.cat((past_key, key), dim=2)
            value = torch.cat((past_value, value), dim=2)
        total_key_length = key.shape[2]

        attention_mask: Tensor | None = None
        is_causal = past_key_value is None and key_padding_mask is None
        if not is_causal:
            query_positions = torch.arange(
                past_length, past_length + sequence, device=values.device
            ).view(sequence, 1)
            key_positions = torch.arange(total_key_length, device=values.device).view(
                1, total_key_length
            )
            allowed = key_positions <= query_positions
            attention_mask = torch.zeros(
                (batch, 1, sequence, total_key_length),
                dtype=values.dtype,
                device=values.device,
            )
            attention_mask.masked_fill_(~allowed.view(1, 1, sequence, total_key_length), -torch.inf)
            if key_padding_mask is not None:
                if key_padding_mask.shape != (batch, total_key_length):
                    raise ValueError(
                        f"key_padding_mask shape {tuple(key_padding_mask.shape)} does not match "
                        f"{(batch, total_key_length)}"
                    )
                attention_mask.masked_fill_(~key_padding_mask[:, None, None, :], -torch.inf)
        attended = F.scaled_dot_product_attention(
            query,
            key,
            value,
            attn_mask=attention_mask,
            dropout_p=self.dropout if self.training else 0.0,
            is_causal=is_causal,
        )
        attended = attended.transpose(1, 2).contiguous().view(batch, sequence, dimension)
        present = (key, value) if use_cache else None
        return self.output(attended), present


class SwiGLU(nn.Module):
    def __init__(self, dimension: int, multiplier: float, dropout: float) -> None:
        super().__init__()
        hidden = int((dimension * multiplier * 2 / 3 + 63) // 64 * 64)
        self.input = nn.Linear(dimension, hidden * 2, bias=False)
        self.output = nn.Linear(hidden, dimension, bias=False)
        self.dropout = nn.Dropout(dropout)

    def forward(self, values: Tensor) -> Tensor:
        gate, content = self.input(values).chunk(2, dim=-1)
        return self.output(self.dropout(F.silu(gate) * content))


class TransformerBlock(nn.Module):
    def __init__(self, genome: ModelGenome) -> None:
        super().__init__()
        self.attention_norm = RMSNorm(genome.d_model)
        self.attention = CausalSelfAttention(genome)
        self.feed_forward_norm = RMSNorm(genome.d_model)
        self.feed_forward = SwiGLU(genome.d_model, genome.ff_multiplier, genome.dropout)

    def forward(
        self,
        values: Tensor,
        *,
        key_padding_mask: Tensor | None,
        past_key_value: tuple[Tensor, Tensor] | None,
        use_cache: bool,
    ) -> tuple[Tensor, tuple[Tensor, Tensor] | None]:
        attended, present = self.attention(
            self.attention_norm(values),
            key_padding_mask=key_padding_mask,
            past_key_value=past_key_value,
            use_cache=use_cache,
        )
        values = values + attended
        values = values + self.feed_forward(self.feed_forward_norm(values))
        return values, present


class GenesisNetwork(nn.Module):
    """Recurrent multimodal workspace with language policy and probabilistic world heads."""

    def __init__(self, genome: ModelGenome) -> None:
        super().__init__()
        self.genome = genome
        self.token_embedding = nn.Embedding(genome.vocab_size, genome.d_model)
        self.position_embedding = nn.Embedding(
            genome.max_sequence_length + genome.memory_slots + genome.max_modality_tokens,
            genome.d_model,
        )
        self.memory_slot_embedding = nn.Parameter(
            torch.randn(genome.memory_slots, genome.d_model) / math.sqrt(genome.d_model)
        )
        self.modality_type_embedding = nn.Embedding(4, genome.d_model)
        self.modalities = ModalityEncoderBank(genome)
        self.blocks = nn.ModuleList(TransformerBlock(genome) for _ in range(genome.n_layers))
        self.final_norm = RMSNorm(genome.d_model)
        self.lm_head = nn.Linear(genome.d_model, genome.vocab_size, bias=False)
        if genome.tie_embeddings:
            self.lm_head.weight = self.token_embedding.weight
        self.memory_update = nn.GRUCell(genome.d_model, genome.d_model)
        self.memory_gate = nn.Sequential(
            nn.Linear(genome.d_model, genome.memory_slots), nn.Sigmoid()
        )

        world_input = genome.d_model + genome.world_latent_dim
        self.world_state_encoder = nn.Linear(genome.d_model, genome.world_latent_dim)
        self.world_transition = nn.Sequential(
            nn.Linear(world_input, genome.d_model),
            nn.SiLU(),
            nn.Linear(genome.d_model, genome.world_latent_dim * 2),
        )
        self.value_head = nn.Sequential(
            nn.Linear(genome.d_model, genome.d_model // 2),
            nn.SiLU(),
            nn.Linear(genome.d_model // 2, 1),
        )
        self.uncertainty_head = nn.Sequential(
            nn.Linear(genome.d_model, genome.d_model // 2),
            nn.SiLU(),
            nn.Linear(genome.d_model // 2, 1),
            nn.Softplus(),
        )
        self.self_state_head = nn.Linear(genome.d_model, genome.world_latent_dim)
        self.user_state_head = nn.Linear(genome.d_model, genome.world_latent_dim)
        self.apply(self._initialize)

    @staticmethod
    def _initialize(module: nn.Module) -> None:
        if isinstance(module, nn.Linear):
            nn.init.normal_(module.weight, mean=0.0, std=0.02)
            if module.bias is not None:
                nn.init.zeros_(module.bias)
        elif isinstance(module, nn.Embedding):
            nn.init.normal_(module.weight, mean=0.0, std=0.02)

    def initial_memory(self, batch_size: int, *, device: torch.device | str) -> Tensor:
        return torch.zeros(
            batch_size,
            self.genome.memory_slots,
            self.genome.d_model,
            device=device,
        )

    def _prefix(
        self,
        batch_size: int,
        device: torch.device,
        dtype: torch.dtype,
        memory_state: Tensor | None,
        modalities: MultimodalInputs | None,
    ) -> tuple[Tensor, Tensor, Tensor | None]:
        if memory_state is None:
            memory_state = self.initial_memory(batch_size, device=device)
        if memory_state.shape != (
            batch_size,
            self.genome.memory_slots,
            self.genome.d_model,
        ):
            raise ValueError(f"Invalid memory state shape: {tuple(memory_state.shape)}")
        memory = memory_state.to(dtype=dtype) + self.memory_slot_embedding.unsqueeze(0).to(dtype)
        parts = [memory]
        masks = [torch.ones(memory.shape[:2], dtype=torch.bool, device=device)]
        private_state: Tensor | None = None
        encoding = self.modalities(modalities)
        if encoding is not None:
            modality = encoding.shared + self.modality_type_embedding(encoding.type_ids)
            parts.append(modality.to(dtype=dtype))
            masks.append(encoding.mask)
            private_state = encoding.private
        return torch.cat(parts, dim=1), torch.cat(masks, dim=1), private_state

    def advance_memory(self, memory_state: Tensor, pooled: Tensor) -> Tensor:
        batch, slots, dimension = memory_state.shape
        inputs = (
            pooled[:, None, :].expand(batch, slots, dimension).reshape(batch * slots, dimension)
        )
        hidden = memory_state.reshape(batch * slots, dimension)
        candidate = self.memory_update(inputs, hidden).view(batch, slots, dimension)
        gates = self.memory_gate(pooled).unsqueeze(-1)
        return gates * candidate + (1.0 - gates) * memory_state

    def forward(
        self,
        input_ids: Tensor,
        *,
        attention_mask: Tensor | None = None,
        memory_state: Tensor | None = None,
        modalities: MultimodalInputs | None = None,
        past_key_values: list[tuple[Tensor, Tensor]] | None = None,
        use_cache: bool = False,
        world_state: Tensor | None = None,
    ) -> NetworkOutput:
        if input_ids.ndim != 2:
            raise ValueError("input_ids must have shape [batch, sequence]")
        batch, token_count = input_ids.shape
        if token_count < 1:
            raise ValueError("input_ids must contain at least one token")
        device = input_ids.device
        token_values = self.token_embedding(input_ids)
        private_state: Tensor | None = None
        prefix_length = 0
        if past_key_values is None:
            prefix, prefix_mask, private_state = self._prefix(
                batch, device, token_values.dtype, memory_state, modalities
            )
            values = torch.cat((prefix, token_values), dim=1)
            prefix_length = prefix.shape[1]
            if attention_mask is None:
                attention_mask = torch.ones((batch, token_count), dtype=torch.bool, device=device)
            key_padding_mask = torch.cat((prefix_mask, attention_mask.bool()), dim=1)
            position_offset = 0
        else:
            if len(past_key_values) != len(self.blocks):
                raise ValueError("past_key_values does not match layer count")
            values = token_values
            position_offset = past_key_values[0][0].shape[2]
            key_padding_mask = None
        total_positions = position_offset + values.shape[1]
        if total_positions > self.position_embedding.num_embeddings:
            raise ValueError(
                f"Sequence requires {total_positions} positions, maximum is "
                f"{self.position_embedding.num_embeddings}"
            )
        positions = torch.arange(position_offset, total_positions, device=device)
        values = values + self.position_embedding(positions).unsqueeze(0)
        presents: list[tuple[Tensor, Tensor]] = []
        for index, block in enumerate(self.blocks):
            past = None if past_key_values is None else past_key_values[index]
            values, present = block(
                values,
                key_padding_mask=key_padding_mask,
                past_key_value=past,
                use_cache=use_cache,
            )
            if present is not None:
                presents.append(present)
        values = self.final_norm(values)
        text_values = values[:, prefix_length:, :]
        logits = self.lm_head(text_values)
        if attention_mask is not None and past_key_values is None:
            indices = attention_mask.long().sum(dim=1).clamp_min(1) - 1
            pooled = text_values[torch.arange(batch, device=device), indices]
        else:
            pooled = text_values[:, -1]
        if memory_state is None:
            memory_state = self.initial_memory(batch, device=device)
        next_memory = self.advance_memory(memory_state, pooled)
        if world_state is None:
            world_state = torch.zeros(
                batch, self.genome.world_latent_dim, device=device, dtype=pooled.dtype
            )
        transition = self.world_transition(torch.cat((pooled, world_state), dim=-1))
        world_mean, world_log_variance = transition.chunk(2, dim=-1)
        world_log_variance = world_log_variance.clamp(-10.0, 5.0)
        return NetworkOutput(
            logits=logits,
            pooled=pooled,
            next_memory=next_memory,
            world_mean=world_mean,
            world_log_variance=world_log_variance,
            value=self.value_head(pooled).squeeze(-1),
            uncertainty=self.uncertainty_head(pooled).squeeze(-1),
            self_state=self.self_state_head(pooled),
            user_state=self.user_state_head(pooled),
            past_key_values=presents if use_cache else None,
            private_modality_state=private_state,
        )

    def encode_world_target(self, pooled: Tensor) -> Tensor:
        return self.world_state_encoder(pooled)
