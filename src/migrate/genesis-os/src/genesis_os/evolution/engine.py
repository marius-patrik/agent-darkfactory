from __future__ import annotations

import math
import random
from pathlib import Path

from pydantic import Field

from genesis_os.birth import BirthRunner, BirthSpec
from genesis_os.model.genome import ModelGenome
from genesis_os.sleep import SleepProgram, SleepSpec
from genesis_os.storage import ExperienceLedger
from genesis_os.types import Actor, EventDraft, EventKind, FrozenModel, new_id


class HarnessGenome(FrozenModel):
    birth: BirthSpec
    sleep: SleepSpec = SleepSpec()
    tool_policy: dict[str, bool] = Field(
        default_factory=lambda: {
            "allow_python_tools": False,
            "allow_process_tools": False,
            "allow_network_tools": False,
        }
    )


class EvolutionSpec(FrozenModel):
    seed: int = 2026
    generations: int = Field(default=1, ge=1, le=1000)
    population: int = Field(default=3, ge=2, le=1000)
    run_sleep_trial: bool = True
    parameter_penalty: float = Field(default=1e-9, ge=0.0)
    keep_all_workspaces: bool = True


class CandidateResult(FrozenModel):
    candidate_id: str
    generation: int
    harness: HarnessGenome
    score: float
    birth_metrics: dict[str, float] = Field(default_factory=dict)
    sleep_metrics: dict[str, float] = Field(default_factory=dict)
    workspace: str
    error: str | None = None


class EvolutionResult(FrozenModel):
    evolution_id: str
    winner: CandidateResult
    candidates: tuple[CandidateResult, ...]


class HarnessMutator:
    def __init__(self, rng: random.Random) -> None:
        self.rng = rng

    def mutate(self, harness: HarnessGenome, *, generation: int, candidate: int) -> HarnessGenome:
        birth = harness.birth
        genome = birth.genome
        d_candidates = sorted(
            {
                max(32, genome.d_model // 2),
                genome.d_model,
                genome.d_model + max(32, genome.d_model // 2),
            }
        )
        d_model = self.rng.choice(d_candidates)
        divisors = [head for head in range(1, min(16, d_model) + 1) if d_model % head == 0]
        n_heads = min(divisors, key=lambda value: abs(value - genome.n_heads))
        if self.rng.random() < 0.5:
            n_heads = self.rng.choice(divisors)
        mutated_genome = genome.model_copy(
            update={
                "d_model": d_model,
                "n_heads": n_heads,
                "n_layers": max(1, genome.n_layers + self.rng.choice([-1, 0, 1])),
                "memory_slots": max(1, genome.memory_slots + self.rng.choice([-4, 0, 4])),
                "world_latent_dim": max(
                    16, genome.world_latent_dim + self.rng.choice([-32, 0, 32])
                ),
            }
        )
        training = birth.training.model_copy(
            update={
                "learning_rate": birth.training.learning_rate
                * math.exp(self.rng.uniform(-0.5, 0.5)),
                "world_loss_weight": max(
                    0.0, birth.training.world_loss_weight + self.rng.uniform(-0.1, 0.1)
                ),
            }
        )
        stages = []
        for stage in birth.curriculum.stages:
            stages.append(
                stage.model_copy(
                    update={
                        "weight": max(0.1, stage.weight * math.exp(self.rng.uniform(-0.2, 0.2)))
                    }
                )
            )
        curriculum = birth.curriculum.model_copy(update={"stages": tuple(stages)})
        mutated_birth = birth.model_copy(
            update={
                "name": f"{birth.name}-g{generation}-c{candidate}",
                "lineage_id": None,
                "seed": birth.seed + generation * 1000 + candidate,
                "genome": mutated_genome,
                "training": training,
                "curriculum": curriculum,
            }
        )
        sleep_training = harness.sleep.training.model_copy(
            update={
                "learning_rate": harness.sleep.training.learning_rate
                * math.exp(self.rng.uniform(-0.4, 0.4)),
                "world_loss_weight": max(
                    0.0,
                    harness.sleep.training.world_loss_weight + self.rng.uniform(-0.05, 0.05),
                ),
            }
        )
        mutated_sleep = harness.sleep.model_copy(
            update={
                "replay_examples": max(
                    0, harness.sleep.replay_examples + self.rng.choice([-128, 0, 128])
                ),
                "training": sleep_training,
            }
        )
        return harness.model_copy(update={"birth": mutated_birth, "sleep": mutated_sleep})


class EvolutionEngine:
    """Runs isolated, reproducible births and optional sleep trials to evolve the harness itself."""

    def __init__(self, workspace: str | Path) -> None:
        self.workspace = Path(workspace).expanduser().resolve()
        self.workspace.mkdir(parents=True, exist_ok=True)

    def run(
        self, seed_harness: HarnessGenome, spec: EvolutionSpec | None = None
    ) -> EvolutionResult:
        spec = spec or EvolutionSpec()
        evolution_id = new_id("evolution")
        root = self.workspace / "evolution" / evolution_id
        root.mkdir(parents=True, exist_ok=False)
        rng = random.Random(spec.seed)
        mutator = HarnessMutator(rng)
        parent = seed_harness
        all_results: list[CandidateResult] = []
        for generation in range(spec.generations):
            population: list[HarnessGenome] = [parent]
            while len(population) < spec.population:
                population.append(
                    mutator.mutate(parent, generation=generation, candidate=len(population))
                )
            generation_results: list[CandidateResult] = []
            for index, harness in enumerate(population):
                candidate_id = f"g{generation}-c{index}"
                candidate_workspace = root / candidate_id
                try:
                    certificate = BirthRunner(candidate_workspace).run(harness.birth)
                    birth_metrics = certificate.metrics
                    sleep_metrics: dict[str, float] = {}
                    sleep_bonus = 0.0
                    if spec.run_sleep_trial:
                        ledger = ExperienceLedger(candidate_workspace / "genesis.sqlite3")
                        ledger.append(
                            EventDraft(
                                kind=EventKind.MEMORY,
                                actor=Actor.USER,
                                payload={
                                    "content": f"Evolution trial token {candidate_id}-OMEGA",
                                    "namespace": "evolution_trial",
                                },
                                session_id=f"trial-{candidate_id}",
                                importance=1.0,
                                source="evolution.engine",
                            )
                        )
                        sleep_result = SleepProgram(candidate_workspace).run(
                            certificate.lineage_id, harness.sleep
                        )
                        sleep_metrics = sleep_result.metrics
                        sleep_bonus = 0.25 if sleep_result.promoted else -0.25
                    parameter_estimate = self._parameter_estimate(harness.birth.genome)
                    score = (
                        -birth_metrics.get("validation_loss", 100.0)
                        + birth_metrics.get("tool_name_accuracy", 0.0)
                        + sleep_bonus
                        - spec.parameter_penalty * parameter_estimate
                    )
                    result = CandidateResult(
                        candidate_id=candidate_id,
                        generation=generation,
                        harness=harness,
                        score=score,
                        birth_metrics=birth_metrics,
                        sleep_metrics=sleep_metrics,
                        workspace=str(candidate_workspace),
                    )
                except Exception as error:
                    result = CandidateResult(
                        candidate_id=candidate_id,
                        generation=generation,
                        harness=harness,
                        score=-1e9,
                        workspace=str(candidate_workspace),
                        error=f"{type(error).__name__}: {error}",
                    )
                generation_results.append(result)
                all_results.append(result)
            winner = max(generation_results, key=lambda value: value.score)
            parent = winner.harness
        final_winner = max(all_results, key=lambda value: value.score)
        result = EvolutionResult(
            evolution_id=evolution_id,
            winner=final_winner,
            candidates=tuple(all_results),
        )
        (root / "result.json").write_text(result.model_dump_json(indent=2), encoding="utf-8")
        return result

    @staticmethod
    def _parameter_estimate(genome: ModelGenome) -> int:
        d = genome.d_model
        per_layer = 4 * d * d + int(3 * d * d * genome.ff_multiplier)
        return (
            genome.vocab_size * d
            + genome.n_layers * per_layer
            + genome.memory_slots * d
            + 4 * d * genome.world_latent_dim
        )
