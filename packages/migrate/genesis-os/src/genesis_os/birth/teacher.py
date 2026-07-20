from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path
from typing import Any

import httpx
from pydantic import Field

from genesis_os.types import FrozenModel


class TeacherSpec(FrozenModel):
    """OpenAI-compatible teacher endpoint used only during Birth/curriculum compilation."""

    base_url: str
    model: str
    api_key_env: str | None = None
    timeout_seconds: float = Field(default=120.0, gt=0.0, le=3600.0)
    max_retries: int = Field(default=3, ge=0, le=20)
    temperature: float = Field(default=0.0, ge=0.0, le=2.0)
    max_tokens: int = Field(default=1024, ge=16, le=65536)
    required: bool = False


class TeacherClient:
    """Cached synchronous client; teacher output becomes data, never a Wake dependency."""

    def __init__(self, spec: TeacherSpec, *, cache_dir: str | Path) -> None:
        self.spec = spec
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    def complete(self, *, system: str, user: str) -> str:
        request = {
            "model": self.spec.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": self.spec.temperature,
            "max_tokens": self.spec.max_tokens,
        }
        digest = hashlib.sha256(
            json.dumps(request, sort_keys=True, ensure_ascii=False).encode("utf-8")
        ).hexdigest()
        cache_path = self.cache_dir / f"{digest}.json"
        if cache_path.exists():
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
            return str(cached["content"])
        headers = {"content-type": "application/json"}
        if self.spec.api_key_env:
            api_key = os.getenv(self.spec.api_key_env)
            if not api_key:
                raise RuntimeError(
                    f"Teacher API key environment variable is unset: {self.spec.api_key_env}"
                )
            headers["authorization"] = f"Bearer {api_key}"
        endpoint = self.spec.base_url.rstrip("/") + "/chat/completions"
        last_error: Exception | None = None
        for attempt in range(self.spec.max_retries + 1):
            try:
                with httpx.Client(timeout=self.spec.timeout_seconds) as client:
                    response = client.post(endpoint, headers=headers, json=request)
                    response.raise_for_status()
                    payload = response.json()
                content = payload["choices"][0]["message"]["content"]
                if isinstance(content, list):
                    content = "".join(
                        str(part.get("text", "")) if isinstance(part, dict) else str(part)
                        for part in content
                    )
                if not isinstance(content, str) or not content.strip():
                    raise ValueError("Teacher returned empty content")
                cache_path.write_text(
                    json.dumps(
                        {"request_hash": digest, "content": content},
                        ensure_ascii=False,
                        indent=2,
                    ),
                    encoding="utf-8",
                )
                return content
            except Exception as error:  # bounded retry; surfaced after final attempt
                last_error = error
                if attempt < self.spec.max_retries:
                    time.sleep(min(2**attempt, 8))
        assert last_error is not None
        raise RuntimeError(f"Teacher request failed after retries: {last_error}") from last_error


def extract_json_object(text: str) -> dict[str, Any]:
    decoder = json.JSONDecoder()
    for index, character in enumerate(text):
        if character != "{":
            continue
        try:
            value, _ = decoder.raw_decode(text[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    raise ValueError(f"Teacher did not return a JSON object: {text[:500]!r}")
