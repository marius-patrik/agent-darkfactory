"""Agent OS model gateway.

The gateway exposes OpenAI-format chat and model APIs, task-class routing,
health, quotas, and trace metadata for local inference engines.
"""

from importlib.metadata import version

__version__ = version("agent-os-gateway")
