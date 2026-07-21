"""Installed package identity and runnable entry-point tests."""

from importlib.metadata import entry_points, version
from importlib.util import find_spec


def test_inference_distribution_and_cli_are_installed() -> None:
    # Inference ships as part of the single product, so its version tracks the
    # product version rather than a literal pinned here. version() still raises
    # if the distribution is not installed, which is what this asserts.
    assert version("agent-os-inference")
    assert find_spec("agent.loop.cli") is not None
    scripts = {item.name: item.value for item in entry_points(group="console_scripts")}
    assert scripts["agent-os-inference"] == "agent.loop.cli:main"
