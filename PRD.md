# Agentos / Agentos Manager PRD

## Overview

`agentos` is a workspace for managing agent packages. Its `agents` CLI is a Bun TypeScript package manager that installs and tracks agent repos, app repos, templates, private workspace state, CLI adapters, skills, plugins, and shared runtime state so every managed CLI sees the same installed capabilities and credit store.

## Goals

- Manage git-backed agent packages from one workspace.
- Keep CLI-specific metadata under `.agents/clis`.
- Keep user-installed skills and plugins under `.agents/skills` and `.agents/plugins`.
- Keep harness packages under `.agents/harnesses` and launch them with shared state.
- Expose one shared state root to every CLI through `.agents/env`.
- Maintain a shared credit store at `.agents/credits.json`.
- Provide one adapter abstraction for Codex, Claude, Kimi, and Agy.
- Support CI for typecheck and tests.

## Non-Goals

- Replace package managers like npm, Bun, or uv.
- Implement billing provider integrations in the first version.
- Solve cross-machine state sync beyond git-backed packages and exportable state files.

## Users

- Agent developers who maintain several local agent repos.
- CLI users who want all agent CLIs to share skills, plugins, memory hooks, and credits.
- Automation that needs deterministic installation and environment discovery.

## Core Concepts

- Package: a git submodule or local package managed by `agents`.
- Harness: a managed runtime package, such as Agentos Harness, launched by `agents`.
- CLI adapter: the shared rooting and credential contract for a vendor CLI.
- Shared state: the root `.agents` directory.
- Core package: the CLI implementation and tests under `packages/agentos-manager`.
- Managed checkout: a git-backed package under `packages/<name>`, agent under `agents/<name>`, app under `apps/<name>`, template under `templates/<name>`, or private workspace under `workspace`.
- CLI metadata: per-CLI data under `.agents/clis/<name>`.
- Skill install: files installed under `.agents/skills/<name>`.
- Plugin install: files installed under `.agents/plugins/<name>`.
- Credit store: shared JSON ledger under `.agents/credits.json`.

## Functional Requirements

- `agents list` lists registered git submodule packages.
- `agents add` adds a git-backed package.
- `agents remove` removes a package submodule.
- `agents sync` syncs and initializes submodules.
- `agents state init` creates shared directories and state files.
- `agents state env` prints environment variables every CLI should consume.
- `agents cli list|doctor|env|exec|materialize-creds` manages shared CLI adapters.
- `agents packages register|list` manages local package registrations.
- `agents harness list|doctor|run` manages harness packages.
- `agents install skill|plugin|hook|template|cli|harness` installs shared capability files into `.agents`.
- `agents installs` lists shared installs.
- `agents credits` locates or prints the shared credit store.
- `agents doctor` validates package checkouts and shared state.

## Workspace Layout

```text
packages/
  agentos-manager/
    src/
    test/
  agentos-harness/
agents/
  agi/
  dark-factory/
  rommie/
  skyblock-agent/
apps/
  singularity/
templates/
  template-bot/
  template-cli/
  template-mono/
  template-repo/
  template-web/
workspace/
```

## State Layout

```text
.agents/
  clis/
  harnesses/
  skills/
  plugins/
  hooks/
  templates/
  credits.json
  installs.json
  packages.json
  env
```

Every managed CLI must read `AGENTS_HOME`, `AGENTS_CLIS`, `AGENTS_SKILLS`, `AGENTS_PLUGINS`, `AGENTS_HOOKS`, `AGENTS_TEMPLATES`, and `AGENTS_CREDITS` from `.agents/env` or equivalent environment exports.

## Harness Contract

Harnesses declare an `agent.package.json` manifest:

```json
{
  "schemaVersion": 1,
  "id": "agentos-harness",
  "kind": "harness",
  "entry": "go run ./cmd/rommie",
  "workingDirectory": "services/cli",
  "requires": {
    "clis": ["codex", "claude", "kimi", "agy"],
    "state": ["skills", "plugins", "hooks", "credits"]
  }
}
```

`agents harness run <id>` launches the harness with `AGENTS_HOME` and shared state paths. Harness-specific runtime data may remain isolated under `.agents/harnesses/<id>/runtime`.

## CLI Adapter Contract

Built-in adapters:

- Codex: `CODEX_HOME=.agents/clis/codex`, credential source `~/.codex/auth.json`.
- Claude: `CLAUDE_CONFIG_DIR=.agents/clis/claude`, credential source `~/.claude/.credentials.json`.
- Kimi: `KIMI_CODE_HOME=.agents/clis/kimi`, credential source `~/.kimi-code/credentials/kimi-code.json`.
- Agy: `HOME=.agents/clis/agy`, credential source `~/.gemini/oauth_creds.json`.

Credential materialization is explicit, non-destructive, and must not print secret values.

## CI

CI runs on pushes and pull requests to `main`:

- install Bun
- `bun install --frozen-lockfile`
- `bun run check`
- `bun test`

## Milestones

1. Bun TypeScript CLI scaffold.
2. Shared state bootstrap and diagnostics.
3. Skill/plugin/CLI install tracking.
4. Credit store schema and update commands.
5. Per-CLI adapter contracts for consuming shared state.
6. Harness package install, doctor, and run commands.
7. Agent Harness bridge through `AGENTS_HOME`.
