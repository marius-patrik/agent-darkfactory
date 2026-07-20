from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

from genesis_os.types import CheckpointRef, new_id, utc_now


def _sha256_file(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            hasher.update(chunk)
    return hasher.hexdigest()


class LineageStore:
    """Versioned model lineage storage with atomic promotion and rollback."""

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def lineage_path(self, lineage_id: str) -> Path:
        return self.root / lineage_id

    def create(self, lineage_id: str | None = None, metadata: dict[str, Any] | None = None) -> str:
        lineage = lineage_id or new_id("lineage")
        path = self.lineage_path(lineage)
        (path / "releases").mkdir(parents=True, exist_ok=False)
        self._atomic_json(
            path / "lineage.json",
            {
                "lineage_id": lineage,
                "created_at": utc_now().isoformat(),
                "metadata": metadata or {},
            },
        )
        return lineage

    def exists(self, lineage_id: str) -> bool:
        return (self.lineage_path(lineage_id) / "lineage.json").exists()

    def list_lineages(self) -> list[dict[str, Any]]:
        values: list[dict[str, Any]] = []
        for path in sorted(item for item in self.root.iterdir() if item.is_dir()):
            metadata_path = path / "lineage.json"
            if not metadata_path.exists():
                continue
            value = json.loads(metadata_path.read_text(encoding="utf-8"))
            current_path = path / "current.json"
            if current_path.exists():
                current = json.loads(current_path.read_text(encoding="utf-8"))
                value["current_release_id"] = current["reference"]["release_id"]
                value["promoted_at"] = current.get("promoted_at")
            else:
                value["current_release_id"] = None
            values.append(value)
        return values

    def new_release_path(self, lineage_id: str, release_id: str | None = None) -> tuple[str, Path]:
        if not self.exists(lineage_id):
            raise KeyError(f"Unknown lineage: {lineage_id}")
        release = release_id or new_id("release")
        path = self.lineage_path(lineage_id) / "releases" / release
        path.mkdir(parents=False, exist_ok=False)
        return release, path

    def finalize_release(
        self,
        *,
        lineage_id: str,
        release_id: str,
        parent_release_id: str | None,
        metrics: dict[str, float],
        metadata: dict[str, Any] | None = None,
    ) -> CheckpointRef:
        release_path = self.lineage_path(lineage_id) / "releases" / release_id
        model_path = release_path / "model.safetensors"
        genome_path = release_path / "genome.json"
        if not model_path.exists() or not genome_path.exists():
            raise FileNotFoundError("Release requires model.safetensors and genome.json")
        reference = CheckpointRef(
            lineage_id=lineage_id,
            release_id=release_id,
            path=str(release_path),
            model_hash=_sha256_file(model_path),
            genome_hash=_sha256_file(genome_path),
            parent_release_id=parent_release_id,
        )
        self._atomic_json(
            release_path / "release.json",
            {
                **reference.model_dump(mode="json"),
                "created_at": utc_now().isoformat(),
                "metrics": metrics,
                "metadata": metadata or {},
            },
        )
        return reference

    def promote(self, reference: CheckpointRef, reason: dict[str, Any]) -> None:
        if not Path(reference.path, "release.json").exists():
            raise FileNotFoundError(f"Release is not finalized: {reference.release_id}")
        self.verify_release(reference)
        lineage_path = self.lineage_path(reference.lineage_id)
        current = {
            "reference": reference.model_dump(mode="json"),
            "promoted_at": utc_now().isoformat(),
            "reason": reason,
        }
        current_path = lineage_path / "current.json"
        if current_path.exists():
            previous = json.loads(current_path.read_text(encoding="utf-8"))
            history_path = lineage_path / "promotion_history.jsonl"
            with history_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(previous, sort_keys=True) + "\n")
        self._atomic_json(current_path, current)

    def promote_release(
        self,
        lineage_id: str,
        release_id: str,
        *,
        reason: dict[str, Any],
    ) -> CheckpointRef:
        metadata = self.release_metadata(lineage_id, release_id)
        reference = CheckpointRef.model_validate(
            {key: metadata[key] for key in CheckpointRef.model_fields}
        )
        self.promote(reference, reason)
        return reference

    @staticmethod
    def verify_release(reference: CheckpointRef) -> None:
        release_path = Path(reference.path)
        model_path = release_path / "model.safetensors"
        genome_path = release_path / "genome.json"
        if not model_path.exists() or not genome_path.exists():
            raise FileNotFoundError(f"Incomplete release: {reference.release_id}")
        actual_model_hash = _sha256_file(model_path)
        actual_genome_hash = _sha256_file(genome_path)
        if actual_model_hash != reference.model_hash:
            raise ValueError(
                f"Model hash mismatch for {reference.release_id}: "
                f"expected {reference.model_hash}, got {actual_model_hash}"
            )
        if actual_genome_hash != reference.genome_hash:
            raise ValueError(
                f"Genome hash mismatch for {reference.release_id}: "
                f"expected {reference.genome_hash}, got {actual_genome_hash}"
            )

    def current(self, lineage_id: str) -> CheckpointRef:
        path = self.lineage_path(lineage_id) / "current.json"
        if not path.exists():
            raise FileNotFoundError(f"Lineage has no promoted release: {lineage_id}")
        data = json.loads(path.read_text(encoding="utf-8"))
        return CheckpointRef.model_validate(data["reference"])

    def release_metadata(self, lineage_id: str, release_id: str) -> dict[str, Any]:
        path = self.lineage_path(lineage_id) / "releases" / release_id / "release.json"
        return json.loads(path.read_text(encoding="utf-8"))

    def list_releases(self, lineage_id: str) -> list[dict[str, Any]]:
        releases_path = self.lineage_path(lineage_id) / "releases"
        values: list[dict[str, Any]] = []
        for release_path in sorted(releases_path.iterdir()):
            metadata = release_path / "release.json"
            if metadata.exists():
                values.append(json.loads(metadata.read_text(encoding="utf-8")))
        return values

    @staticmethod
    def _atomic_json(path: Path, value: Any) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(f"{path.suffix}.tmp-{os.getpid()}")
        temporary.write_text(
            json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False), encoding="utf-8"
        )
        os.replace(temporary, path)
