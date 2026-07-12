# Agent OS Manager Project

This directory implements the `agents` CLI and the one-root Agent OS manager.
It owns v2 bootstrap/doctor, canonical memory, provider pinning and managed
sessions, registries, orchestration, package/capability surfaces, and lifecycle
planning. It has no compatibility state root, credential copier, raw provider
execution, or mutable snapshot-sync engine.

Package-local work remains Bun/TypeScript and is validated from the repository
root.
