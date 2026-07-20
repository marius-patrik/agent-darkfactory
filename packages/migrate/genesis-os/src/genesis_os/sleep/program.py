from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from genesis_os.config import WorkspacePaths
from genesis_os.evaluation import EvaluationSuite, evaluate_model
from genesis_os.model.checkpoint import CheckpointManager
from genesis_os.security.authority import AuthorityPurpose, TrainingAuthorityIssuer
from genesis_os.sleep.compiler import ExperienceCompiler
from genesis_os.sleep.promotion import PromotionGate
from genesis_os.sleep.spec import SleepSpec
from genesis_os.storage import ExperienceLedger, LineageStore
from genesis_os.training.dataset import CausalExampleDataset, read_examples, write_examples
from genesis_os.training.trainer import Trainer
from genesis_os.types import Actor, CheckpointRef, EventDraft, EventKind, new_id


class SleepResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sleep_id: str
    lineage_id: str
    parent: CheckpointRef
    candidate: CheckpointRef | None = None
    promoted: bool
    reasons: list[str] = Field(default_factory=list)
    metrics: dict[str, float] = Field(default_factory=dict)
    experience_counts: dict[str, int] = Field(default_factory=dict)
    processed_through_sequence: int


class SleepProgram:
    """The exclusive within-life durable weight-update transaction."""

    def __init__(
        self,
        workspace: str | Path,
        *,
        issuer: TrainingAuthorityIssuer | None = None,
    ) -> None:
        self.paths = WorkspacePaths.from_root(workspace)
        self.paths.ensure()
        self.ledger = ExperienceLedger(self.paths.database)
        self.lineages = LineageStore(self.paths.lineages)
        self.issuer = issuer or TrainingAuthorityIssuer()
        self.checkpoints = CheckpointManager(self.issuer)

    def run(self, lineage_id: str, spec: SleepSpec | None = None) -> SleepResult:
        spec = spec or SleepSpec()
        sleep_id = new_id("sleep")
        parent = self.lineages.current(lineage_id)
        cursor = self._load_cursor(lineage_id)
        after_sequence = int(cursor.get("last_promoted_sequence", 0))
        latest_sequence = self.ledger.latest_sequence()
        if latest_sequence - after_sequence < spec.min_new_events:
            raise RuntimeError(
                f"Sleep requires at least {spec.min_new_events} new events; found "
                f"{latest_sequence - after_sequence}"
            )
        integrity_ok, integrity_errors = self.ledger.verify()
        self.ledger.append(
            EventDraft(
                kind=EventKind.SLEEP_STARTED,
                actor=Actor.HARNESS,
                payload={
                    "sleep_id": sleep_id,
                    "lineage_id": lineage_id,
                    "parent_release": parent.release_id,
                    "after_sequence": after_sequence,
                    "latest_sequence": latest_sequence,
                },
                session_id=sleep_id,
                importance=1.0,
                source="sleep.program",
            )
        )

        replay_paths = sorted(self.paths.datasets.glob("*-train.jsonl"))
        compiler = ExperienceCompiler(self.ledger, seed=spec.seed)
        train_examples, validation_examples, counts = compiler.compile(
            after_sequence=after_sequence,
            validation_fraction=spec.validation_fraction,
            max_examples=spec.max_experience_examples,
            replay_paths=replay_paths,
            replay_examples=spec.replay_examples,
        )
        if not train_examples or not validation_examples:
            raise RuntimeError("Sleep compiler produced insufficient train/validation experience")
        train_path = write_examples(self.paths.datasets / f"{sleep_id}-train.jsonl", train_examples)
        validation_path = write_examples(
            self.paths.datasets / f"{sleep_id}-validation.jsonl", validation_examples
        )

        parent_model, genome, _ = CheckpointManager.load(
            parent.path, device=spec.training.device if spec.training.device != "auto" else "cpu"
        )
        candidate_model, _, _ = CheckpointManager.load(
            parent.path, device=spec.training.device if spec.training.device != "auto" else "cpu"
        )
        new_suite = EvaluationSuite(
            name=f"sleep-new:{sleep_id}",
            examples=validation_examples,
            generation_samples=spec.generation_samples,
            max_generation_tokens=spec.max_generation_tokens,
            max_validation_loss=1e9,
        )
        foundation_examples = self._foundation_validation(validation_examples, limit=512)
        foundation_suite = EvaluationSuite(
            name=f"sleep-foundation:{sleep_id}",
            examples=foundation_examples,
            generation_samples=spec.generation_samples,
            max_generation_tokens=spec.max_generation_tokens,
            max_validation_loss=1e9,
        )
        parent_new = evaluate_model(parent_model, new_suite, device=spec.training.device)
        parent_foundation = evaluate_model(
            parent_model, foundation_suite, device=spec.training.device
        )

        trainer = Trainer(spec.training)
        report = trainer.train(
            candidate_model,
            CausalExampleDataset(train_examples, max_sequence_length=genome.max_sequence_length),
        )
        candidate_new = evaluate_model(candidate_model, new_suite, device=spec.training.device)
        candidate_foundation = evaluate_model(
            candidate_model, foundation_suite, device=spec.training.device
        )
        decision = PromotionGate(spec.gate).decide(
            parent_new=parent_new,
            candidate_new=candidate_new,
            parent_foundation=parent_foundation,
            candidate_foundation=candidate_foundation,
            ledger_valid=integrity_ok,
        )

        release_id, release_path = self.lineages.new_release_path(lineage_id)
        authority = self.issuer.issue(AuthorityPurpose.SLEEP)
        self.checkpoints.save(
            candidate_model,
            genome,
            release_path,
            authority=authority,
            metadata={
                "sleep_id": sleep_id,
                "parent": parent.model_dump(mode="json"),
                "training": report.as_metrics(),
                "parent_new": parent_new.model_dump(mode="json"),
                "candidate_new": candidate_new.model_dump(mode="json"),
                "parent_foundation": parent_foundation.model_dump(mode="json"),
                "candidate_foundation": candidate_foundation.model_dump(mode="json"),
                "decision": {
                    "promote": decision.promote,
                    "reasons": list(decision.reasons),
                    "metrics": decision.metrics,
                },
            },
        )
        candidate = self.lineages.finalize_release(
            lineage_id=lineage_id,
            release_id=release_id,
            parent_release_id=parent.release_id,
            metrics={
                **report.as_metrics(),
                **{f"gate.{key}": value for key, value in decision.metrics.items()},
            },
            metadata={
                "sleep_id": sleep_id,
                "status": "promoted" if decision.promote else "rejected",
                "train_dataset": str(train_path),
                "validation_dataset": str(validation_path),
                "integrity_errors": integrity_errors,
            },
        )
        if decision.promote:
            self.lineages.promote(
                candidate,
                reason={
                    "sleep_id": sleep_id,
                    "promotion_gate": decision.metrics,
                },
            )

        result = SleepResult(
            sleep_id=sleep_id,
            lineage_id=lineage_id,
            parent=parent,
            candidate=candidate,
            promoted=decision.promote,
            reasons=list(decision.reasons),
            metrics={**report.as_metrics(), **decision.metrics},
            experience_counts=counts,
            processed_through_sequence=latest_sequence,
        )
        self.ledger.append(
            EventDraft(
                kind=EventKind.SLEEP_COMPLETED,
                actor=Actor.HARNESS,
                payload=result.model_dump(mode="json"),
                session_id=sleep_id,
                importance=1.0,
                source="sleep.program",
            )
        )
        final_sequence = self.ledger.latest_sequence()
        self._save_cursor(
            lineage_id,
            {
                "last_attempt_sequence": final_sequence,
                "last_promoted_sequence": (final_sequence if decision.promote else after_sequence),
                "last_sleep_id": sleep_id,
                "last_candidate_release": candidate.release_id,
                "last_promoted": decision.promote,
            },
        )
        return result

    def _foundation_validation(self, fallback: list[Any], *, limit: int) -> list[Any]:
        candidates = sorted(self.paths.datasets.glob("*birth*-validation.jsonl"))
        if not candidates:
            candidates = [
                path
                for path in sorted(self.paths.datasets.glob("*-validation.jsonl"))
                if "sleep_" not in path.name and "sleep-" not in path.name
            ]
        pool: list[Any] = []
        for path in candidates[-3:]:
            pool.extend(read_examples(path))
        return (pool or fallback)[:limit]

    def _cursor_path(self, lineage_id: str) -> Path:
        directory = self.paths.state / "sleep"
        directory.mkdir(parents=True, exist_ok=True)
        return directory / f"{lineage_id}.json"

    def _load_cursor(self, lineage_id: str) -> dict[str, Any]:
        path = self._cursor_path(lineage_id)
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}

    def _save_cursor(self, lineage_id: str, value: dict[str, Any]) -> None:
        path = self._cursor_path(lineage_id)
        temporary = path.with_suffix(f".tmp-{os.getpid()}")
        temporary.write_text(json.dumps(value, indent=2, sort_keys=True), encoding="utf-8")
        os.replace(temporary, path)
