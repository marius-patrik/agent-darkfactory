"""Package identity tests for the Agent OS gateway."""

from importlib.metadata import version
from importlib.util import find_spec

from typer.testing import CliRunner

from llm_gateway.cli import app


def test_gateway_distribution_and_import_namespace_are_installed():
    # The gateway ships as part of the single product, so its own version
    # tracks the product version rather than a literal pinned here. version()
    # still raises if the distribution is not installed, which is what this
    # asserts. protobuf-py is a real dependency pin and stays exact.
    assert version("agent-os-gateway")
    assert version("protobuf-py") == "0.1.1"
    assert find_spec("llm_gateway") is not None
    assert find_spec("agent_os.v1.registry_connect") is not None


def test_serve_defaults_to_canonical_native_endpoint(monkeypatch):
    invocation: dict[str, object] = {}

    def capture_run(app_path: str, **kwargs: object) -> None:
        invocation.update({"app": app_path, **kwargs})

    monkeypatch.setattr("uvicorn.run", capture_run)
    result = CliRunner().invoke(app, ["serve"])

    assert result.exit_code == 0
    assert invocation == {
        "app": "llm_gateway.main:app",
        "host": "127.0.0.1",
        "port": 8787,
        "reload": False,
    }
