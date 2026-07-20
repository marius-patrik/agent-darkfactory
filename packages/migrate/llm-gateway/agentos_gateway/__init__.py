"""Rommie LLM gateway (VS1-minimal).

Salvaged + adapted from the v3 ``legacy/src-packages-gateway`` package (FastAPI +
httpx + litellm). The single client-facing edge: OpenAI-format
``/v1/chat/completions``, role aliases with replica round-robin, context
fallback, ``<think>``-strip, trace metadata, and a config-driven model
registry.

VS1-minimal scope (the rest lands VS2, see ``docs/gateway.md``):
- LOCAL engines only — generic-HTTP backends routing to OpenAI-compatible
  ``api_base``s. Cloud entries are removed / ``enabled: false`` and
  ``allow_cloud`` defaults to ``False``.
- The never-meter guardrail (``allow_cloud`` gating in :mod:`agentos_gateway.router`)
  STAYS enforced regardless of fabric.
- Re-namespaced from the v3 ``agents`` package namespace → ``agentos_gateway``.
"""

__version__ = "0.1.0"
