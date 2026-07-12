"""Smoke-check the packaged gateway app without requiring live model engines."""

from __future__ import annotations

import os

from fastapi.testclient import TestClient

from llm_gateway.main import app


def main() -> None:
    if not os.environ.get("AGENTS_HOME", "").strip():
        raise SystemExit("AGENTS_HOME must be set to an absolute Agent OS state root")
    with TestClient(app) as client:
        response = client.get("/health")
        response.raise_for_status()
        payload = response.json()
        if payload.get("models_registered", 0) < 1:
            raise SystemExit("gateway health response did not include registered models")
        print(f"health={payload['status']} models_registered={payload['models_registered']}")


if __name__ == "__main__":
    main()
