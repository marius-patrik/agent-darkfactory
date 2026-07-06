# Agents Manager Project

`agents-manager` is the standalone Bun TypeScript package for the `agents` CLI. It manages agents-mono package registrations, shared `.agents` runtime state, provider CLI adapters, harness execution, installs, data repositories, secrets, and credits.

This repo must remain independently runnable with Bun and must not depend on parent monorepo package metadata for package-local validation.
