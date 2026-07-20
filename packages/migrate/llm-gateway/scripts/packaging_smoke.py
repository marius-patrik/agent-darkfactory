"""Smoke-check the packaged gateway app without requiring live model engines."""

from __future__ import annotations

from fastapi.testclient import TestClient

from agentos_gateway.main import app


def main() -> None:
    with TestClient(app) as client:
        response = client.get("/healthz")
        response.raise_for_status()
        payload = response.json()
        if payload.get("models_registered", 0) < 1:
            raise SystemExit("gateway health response did not include registered models")
        print(f"healthz={payload['status']} models_registered={payload['models_registered']}")


if __name__ == "__main__":
    main()
