from __future__ import annotations

import hashlib
import json
from dataclasses import asdict
from pathlib import Path

from genesis_os.birth.curriculum import CurriculumProgram
from genesis_os.birth.ingest import PersonalDataIngestor
from genesis_os.birth.spec import BirthSpec, InitializationMode
from genesis_os.birth.teacher import TeacherClient
from genesis_os.config import WorkspacePaths
from genesis_os.evaluation import EvaluationSuite, evaluate_model
from genesis_os.model.checkpoint import CheckpointManager
from genesis_os.model.network import GenesisNetwork
from genesis_os.security.authority import AuthorityPurpose, TrainingAuthorityIssuer
from genesis_os.storage import ArtifactStore, ExperienceLedger, LineageStore
from genesis_os.training.dataset import CausalExampleDataset, write_examples
from genesis_os.training.trainer import Trainer, set_seed
from genesis_os.types import Actor, BirthCertificate, EventDraft, EventKind, new_id, utc_now


def _digest_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class BirthRunner:
    def __init__(
        self,
        workspace: str | Path,
        *,
        issuer: TrainingAuthorityIssuer | None = None,
    ) -> None:
        self.paths = WorkspacePaths.from_root(workspace)
        self.paths.ensure()
        self.ledger = ExperienceLedger(self.paths.database)
        self.artifacts = ArtifactStore(self.paths.artifacts)
        self.lineages = LineageStore(self.paths.lineages)
        self.issuer = issuer or TrainingAuthorityIssuer()
        self.checkpoints = CheckpointManager(self.issuer)

    def run(self, spec: BirthSpec) -> BirthCertificate:
        started = utc_now()
        birth_id = new_id("birth")
        lineage_id = spec.lineage_id
        if lineage_id is None:
            lineage_id = self.lineages.create(
                metadata={"name": spec.name, "birth_id": birth_id, **spec.metadata}
            )
        elif not self.lineages.exists(lineage_id):
            lineage_id = self.lineages.create(lineage_id, metadata={"name": spec.name})

        personal_records = []
        if spec.curriculum.personal.sources:
            personal_records = PersonalDataIngestor(
                artifacts=self.artifacts,
                redact_secrets=spec.curriculum.personal.redact_secrets,
                max_record_characters=spec.curriculum.personal.max_record_characters,
            ).ingest(spec.curriculum.personal.sources)
            manifest_path = self.paths.datasets / f"{birth_id}-personal-manifest.jsonl"
            with manifest_path.open("w", encoding="utf-8") as handle:
                for record in personal_records:
                    handle.write(json.dumps(asdict(record), sort_keys=True, default=str) + "\n")

        teacher = None
        if spec.curriculum.teacher is not None:
            teacher = TeacherClient(
                spec.curriculum.teacher,
                cache_dir=self.paths.datasets / "teacher-cache",
            )
        program = CurriculumProgram(spec.curriculum, teacher=teacher)
        compiled = program.compile(personal_records)
        train_path = write_examples(self.paths.datasets / f"{birth_id}-train.jsonl", compiled.train)
        validation_path = write_examples(
            self.paths.datasets / f"{birth_id}-validation.jsonl", compiled.validation
        )
        curriculum_hash = hashlib.sha256(
            train_path.read_bytes() + validation_path.read_bytes()
        ).hexdigest()

        if spec.initialization.mode == InitializationMode.RANDOM:
            # Parameter initialization is part of Birth and must obey the Birth seed,
            # not whatever global RNG state happened to precede this call.
            set_seed(spec.seed, deterministic=spec.training.deterministic)
            model = GenesisNetwork(spec.genome)
            parent_release_id = None
        else:
            if spec.initialization.checkpoint is None:
                raise ValueError("inherit initialization requires checkpoint")
            model, inherited_genome, _ = CheckpointManager.load(spec.initialization.checkpoint)
            if spec.initialization.strict and inherited_genome != spec.genome:
                raise ValueError("Inherited checkpoint genome does not match BirthSpec genome")
            parent_release_id = Path(spec.initialization.checkpoint).name

        dataset = CausalExampleDataset(
            compiled.train, max_sequence_length=spec.genome.max_sequence_length
        )
        trainer = Trainer(spec.training)
        report = trainer.train(model, dataset)

        suite = EvaluationSuite(
            name=f"birth:{birth_id}",
            examples=compiled.validation,
            generation_samples=spec.viability.generation_samples,
            max_generation_tokens=spec.viability.max_generation_tokens,
            max_validation_loss=spec.viability.max_validation_loss,
            min_tool_name_accuracy=spec.viability.min_tool_name_accuracy,
        )
        evaluation = evaluate_model(model, suite, device=spec.training.device)

        # Adaptive textbook remediation: add fresh examples for weak generated-task accuracy.
        remediation_reports: list[dict[str, float]] = []
        for round_index in range(spec.curriculum.remediation_rounds):
            failing_tasks = {
                key.split(".")[1]
                for key, value in evaluation.metrics.items()
                if key.startswith("task.") and value < spec.curriculum.mastery_threshold
            }
            if not failing_tasks:
                break
            remedial_examples = program.remediation(failing_tasks, seed_offset=round_index + 1)
            if not remedial_examples:
                break
            remedial_dataset = CausalExampleDataset(
                remedial_examples, max_sequence_length=spec.genome.max_sequence_length
            )
            remedial_report = trainer.train(model, remedial_dataset)
            remediation_reports.append(remedial_report.as_metrics())
            evaluation = evaluate_model(model, suite, device=spec.training.device)

        if not evaluation.passed:
            failure_path = self.paths.logs / f"{birth_id}-failed-evaluation.json"
            failure_path.write_text(evaluation.model_dump_json(indent=2), encoding="utf-8")
            raise RuntimeError(
                f"Birth failed viability evaluation; details written to {failure_path}: "
                f"{evaluation.failures[:3]}"
            )

        release_id, release_path = self.lineages.new_release_path(lineage_id)
        authority = self.issuer.issue(AuthorityPurpose.BIRTH)
        self.checkpoints.save(
            model,
            spec.genome,
            release_path,
            authority=authority,
            metadata={
                "birth_id": birth_id,
                "training": report.as_metrics(),
                "evaluation": evaluation.model_dump(mode="json"),
                "curriculum": compiled.concept_counts,
            },
        )
        reference = self.lineages.finalize_release(
            lineage_id=lineage_id,
            release_id=release_id,
            parent_release_id=parent_release_id,
            metrics={**report.as_metrics(), **evaluation.metrics},
            metadata={
                "birth_id": birth_id,
                "train_dataset": str(train_path),
                "validation_dataset": str(validation_path),
                "remediation": remediation_reports,
            },
        )
        self.lineages.promote(reference, reason={"birth_viability": evaluation.metrics})
        certificate = BirthCertificate(
            birth_id=birth_id,
            lineage_id=lineage_id,
            release=reference,
            started_at=started,
            completed_at=utc_now(),
            spec_hash=hashlib.sha256(spec.model_dump_json().encode()).hexdigest(),
            curriculum_hash=curriculum_hash,
            seed=spec.seed,
            metrics={**report.as_metrics(), **evaluation.metrics},
            provenance={
                "personal_records": len(personal_records),
                "concept_counts": compiled.concept_counts,
                "train_dataset_hash": _digest_file(train_path),
                "validation_dataset_hash": _digest_file(validation_path),
            },
        )
        certificate_path = release_path / "birth_certificate.json"
        certificate_path.write_text(certificate.model_dump_json(indent=2), encoding="utf-8")
        self.ledger.append(
            EventDraft(
                kind=EventKind.BIRTH,
                actor=Actor.HARNESS,
                payload=certificate.model_dump(mode="json"),
                session_id=birth_id,
                importance=1.0,
                source="birth.runner",
            )
        )
        return certificate
