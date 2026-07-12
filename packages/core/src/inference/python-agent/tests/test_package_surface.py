"""Installed package identity and runnable entry-point tests."""

from importlib.metadata import entry_points, version
from importlib.util import find_spec


def test_inference_distribution_and_cli_are_installed() -> None:
    assert version("agent-os-inference") == "0.1.0"
    assert find_spec("agent.loop.cli") is not None
    scripts = {item.name: item.value for item in entry_points(group="console_scripts")}
    assert scripts["agent-os-inference"] == "agent.loop.cli:main"
