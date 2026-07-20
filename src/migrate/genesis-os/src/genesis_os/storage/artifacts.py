from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any, BinaryIO


class ArtifactStore:
    """Content-addressed immutable artifact storage."""

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def digest(data: bytes) -> str:
        return hashlib.sha256(data).hexdigest()

    def path_for(self, digest: str) -> Path:
        return self.root / digest[:2] / digest[2:4] / digest

    def put_bytes(self, data: bytes) -> str:
        digest = self.digest(data)
        target = self.path_for(digest)
        if target.exists():
            return digest
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(f".tmp-{os.getpid()}")
        temporary.write_bytes(data)
        os.replace(temporary, target)
        return digest

    def put_json(self, value: Any) -> str:
        encoded = json.dumps(
            value, sort_keys=True, separators=(",", ":"), ensure_ascii=False
        ).encode("utf-8")
        return self.put_bytes(encoded)

    def put_stream(self, stream: BinaryIO, chunk_size: int = 1024 * 1024) -> str:
        hasher = hashlib.sha256()
        temporary = self.root / f".upload-{os.getpid()}"
        with temporary.open("wb") as destination:
            while chunk := stream.read(chunk_size):
                hasher.update(chunk)
                destination.write(chunk)
        digest = hasher.hexdigest()
        target = self.path_for(digest)
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            temporary.unlink(missing_ok=True)
        else:
            os.replace(temporary, target)
        return digest

    def get_bytes(self, digest: str) -> bytes:
        path = self.path_for(digest)
        if not path.exists():
            raise FileNotFoundError(f"Unknown artifact: {digest}")
        data = path.read_bytes()
        if self.digest(data) != digest:
            raise OSError(f"Artifact integrity failure: {digest}")
        return data

    def verify(self, digest: str) -> bool:
        try:
            return self.digest(self.path_for(digest).read_bytes()) == digest
        except FileNotFoundError:
            return False
