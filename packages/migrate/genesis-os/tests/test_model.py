from __future__ import annotations

import torch

from genesis_os.model import GenesisNetwork, ModelGenome
from genesis_os.model.multimodal import MultimodalInputs
from genesis_os.training import CausalExampleDataset, Trainer, TrainingConfig
from genesis_os.types import TrainingExample


def tiny_genome() -> ModelGenome:
    return ModelGenome(
        d_model=32,
        n_layers=1,
        n_heads=4,
        max_sequence_length=128,
        memory_slots=2,
        world_latent_dim=16,
        max_modality_tokens=8,
        structured_feature_dim=5,
        image_patch_size=4,
        audio_kernel_size=16,
        audio_stride=8,
    )


def test_multimodal_workspace_and_cache_shapes():
    genome = tiny_genome()
    model = GenesisNetwork(genome)
    ids = torch.randint(0, genome.vocab_size, (2, 20))
    inputs = MultimodalInputs(
        images=torch.randn(2, 3, 8, 8),
        audio=torch.randn(2, 32),
        structured=torch.randn(2, 5),
    )
    output = model(ids, modalities=inputs, use_cache=True)
    assert output.logits.shape == (2, 20, genome.vocab_size)
    assert output.next_memory.shape == (2, genome.memory_slots, genome.d_model)
    assert output.world_mean.shape == (2, genome.world_latent_dim)
    assert output.past_key_values is not None

    step = model(
        torch.randint(0, genome.vocab_size, (2, 1)),
        memory_state=model.initial_memory(2, device="cpu"),
        world_state=torch.zeros(2, genome.world_latent_dim),
        past_key_values=output.past_key_values,
        use_cache=True,
    )
    assert step.logits.shape == (2, 1, genome.vocab_size)


def test_training_reduces_loss_on_verified_example():
    genome = tiny_genome()
    model = GenesisNetwork(genome)
    examples = [
        TrainingExample(
            prompt="Q: say hello\nA:",
            target='{"tool":"communication.respond","arguments":{"text":"hello"}}',
            task="tool",
        )
        for _ in range(16)
    ]
    dataset = CausalExampleDataset(examples, max_sequence_length=genome.max_sequence_length)
    trainer = Trainer(
        TrainingConfig(
            epochs=20,
            max_steps=20,
            batch_size=4,
            learning_rate=0.002,
            warmup_steps=2,
            world_loss_weight=0.0,
            value_loss_weight=0.0,
            uncertainty_loss_weight=0.0,
            device="cpu",
            cpu_threads=2,
        )
    )
    before = trainer.evaluate_loss(model, dataset)
    trainer.train(model, dataset)
    after = trainer.evaluate_loss(model, dataset)
    assert after < before
