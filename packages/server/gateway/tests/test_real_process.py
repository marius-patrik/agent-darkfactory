"""Real-socket gateway and inferctl-routing acceptance tests."""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import threading
import time
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterator

import httpx
import pytest
import yaml

GATEWAY_ROOT = Path(__file__).resolve().parents[1]
MODEL_ID = "qwen3-8b"
MAX_REQUEST_BYTES = 1024 * 1024


class EchoServer(ThreadingHTTPServer):
    requests: list[dict[str, Any]]


class EchoHandler(BaseHTTPRequestHandler):
    server: EchoServer

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/v1/models":
            self.send_error(404)
            return
        self._json(200, {"object": "list", "data": [{"id": MODEL_ID, "object": "model"}]})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/v1/chat/completions":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("content-length", "0"))
        except ValueError:
            self.send_error(400)
            return
        if length <= 0 or length > MAX_REQUEST_BYTES:
            self.send_error(413)
            return
        try:
            payload = json.loads(self.rfile.read(length))
            messages = payload["messages"]
            content = str(messages[-1]["content"])
        except (KeyError, IndexError, TypeError, json.JSONDecodeError):
            self.send_error(400)
            return
        if not isinstance(payload, dict) or not isinstance(messages, list):
            self.send_error(400)
            return
        self.server.requests.append(payload)
        if content == "malformed-backend-payload":
            body = b"{not-json"
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if payload.get("stream") is True:
            chunks = ["echo: ", content]
            body = "".join(
                f"data: {json.dumps({'id': 'echo-stream', 'object': 'chat.completion.chunk', 'model': MODEL_ID, 'choices': [{'index': 0, 'delta': {'content': chunk}, 'finish_reason': None}]})}\n\n"
                for chunk in chunks
            ) + "data: [DONE]\n\n"
            encoded = body.encode()
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.send_header("content-length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)
            return
        self._json(200, {
            "id": "echo-completion",
            "object": "chat.completion",
            "model": MODEL_ID,
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": f"echo: {content}"},
                "finish_reason": "stop",
            }],
            "usage": {"prompt_tokens": 1, "completion_tokens": 2, "total_tokens": 3},
        })

    def _json(self, status: int, payload: dict[str, Any]) -> None:
        encoded = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


@contextmanager
def echo_backend() -> Iterator[EchoServer]:
    server = EchoServer(("127.0.0.1", 0), EchoHandler)
    server.requests = []
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


@pytest.fixture(scope="module")
def real_gateway(tmp_path_factory: pytest.TempPathFactory) -> Iterator[dict[str, Any]]:
    root = tmp_path_factory.mktemp("real-gateway")
    status_path = root / "inferctl-local-engines.yaml"
    log_path = root / "gateway.log"
    gateway_port = free_port()
    with echo_backend() as backend:
        backend_port = int(backend.server_address[1])
        status_path.write_text(yaml.safe_dump({
            "schema_version": "inferctl-local-engines-v1",
            "engines": {
                MODEL_ID: {
                    "status": "healthy",
                    "api_base": f"http://127.0.0.1:{backend_port}/v1",
                },
            },
        }))
        env = {
            **os.environ,
            "ANDROMEDA_HOME": str(root / ".agents"),
            "ANDROMEDA_USER_HOME": str(root / "user"),
            "ANDROMEDA_ROOT": str(GATEWAY_ROOT.parents[1]),
            "GATEWAY_INFERCTL_STATUS_PATH": str(status_path),
            "PYTHONUNBUFFERED": "1",
        }
        with log_path.open("w", encoding="utf8") as log:
            process = subprocess.Popen(
                [sys.executable, "-m", "uvicorn", "llm_gateway.main:app", "--host", "127.0.0.1", "--port", str(gateway_port)],
                cwd=GATEWAY_ROOT,
                env=env,
                stdout=log,
                stderr=subprocess.STDOUT,
                text=True,
            )
            base_url = f"http://127.0.0.1:{gateway_port}"
            try:
                deadline = time.monotonic() + 20
                while True:
                    if process.poll() is not None:
                        raise AssertionError(f"gateway exited during startup ({process.returncode})\n{log_path.read_text()}")
                    try:
                        if httpx.get(f"{base_url}/v1/models", timeout=0.5).status_code == 200:
                            break
                    except httpx.HTTPError:
                        pass
                    if time.monotonic() >= deadline:
                        raise AssertionError(f"gateway did not become ready\n{log_path.read_text()}")
                    time.sleep(0.1)
                yield {"base_url": base_url, "backend": backend, "model": MODEL_ID}
            finally:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)


@pytest.mark.gateway_process
def test_real_gateway_plain_completion_preserves_openai_wire_shape(real_gateway: dict[str, Any]) -> None:
    response = httpx.post(
        f"{real_gateway['base_url']}/v1/chat/completions",
        json={"model": real_gateway["model"], "messages": [{"role": "user", "content": "plain"}]},
        timeout=10,
    )
    response.raise_for_status()
    body = response.json()
    assert body["object"] == "chat.completion"
    assert body["choices"][0]["message"] == {"role": "assistant", "content": "echo: plain"}
    assert body["choices"][0]["finish_reason"] == "stop"
    assert body["llm_gateway"]["served_model"] == MODEL_ID


@pytest.mark.gateway_process
def test_real_gateway_streaming_completion_preserves_sse_wire_shape(real_gateway: dict[str, Any]) -> None:
    with httpx.stream(
        "POST",
        f"{real_gateway['base_url']}/v1/chat/completions",
        json={"model": real_gateway["model"], "messages": [{"role": "user", "content": "stream"}], "stream": True},
        timeout=10,
    ) as response:
        response.raise_for_status()
        data = [line[6:] for line in response.iter_lines() if line.startswith("data: ")]
    assert data[-1] == "[DONE]"
    chunks = [json.loads(item) for item in data[:-1]]
    assert all(chunk["object"] == "chat.completion.chunk" for chunk in chunks)
    assert "".join(chunk["choices"][0]["delta"].get("content", "") for chunk in chunks) == "echo: stream"


@pytest.mark.gateway_process
def test_real_gateway_fails_closed_on_malformed_backend_payload(real_gateway: dict[str, Any]) -> None:
    response = httpx.post(
        f"{real_gateway['base_url']}/v1/chat/completions",
        json={"model": real_gateway["model"], "messages": [{"role": "user", "content": "malformed-backend-payload"}]},
        timeout=10,
    )
    assert response.status_code == 502
    assert response.json()["detail"].startswith("Backend error:")


@pytest.mark.engine_routing
def test_inferctl_discovery_registers_and_routes_the_echo_engine(real_gateway: dict[str, Any]) -> None:
    models = httpx.get(f"{real_gateway['base_url']}/v1/models", timeout=10).json()["data"]
    assert [model["id"] for model in models] == [MODEL_ID]
    route = httpx.get(f"{real_gateway['base_url']}/route/standard-impl", timeout=10)
    route.raise_for_status()
    assert route.json()["model_id"] == MODEL_ID
    before = len(real_gateway["backend"].requests)
    completion = httpx.post(
        f"{real_gateway['base_url']}/v1/chat/completions",
        json={"model": route.json()["model_id"], "messages": [{"role": "user", "content": "routed"}]},
        timeout=10,
    )
    completion.raise_for_status()
    assert completion.json()["choices"][0]["message"]["content"] == "echo: routed"
    assert len(real_gateway["backend"].requests) == before + 1
    assert real_gateway["backend"].requests[-1]["model"] == MODEL_ID
