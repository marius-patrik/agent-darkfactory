# agentos

Agentos workspace with the `agents` CLI for managing agent packages, apps,
templates, private workspace state, shared skills/plugins, CLI data, and a
common credit store.

## Usage

```sh
bun install
bun link
agents list
agents state init
agents state env
agents cli doctor
agents packages register packages/andromeda-harness
agents harness doctor andromeda-harness
agents data repo list
agents doctor
```

## Layout

- `packages/agentos-core` contains shared proto contracts, generated clients, schemas, and contract docs.
- `packages/agentos-gateway` contains the OpenAI-format LLM gateway, model registry routing, fallback, switchers, quota, OAuth seams, and tests.
- `packages/agentos-inferer` contains the Python agent loop, Go runtime services, engine work, deploy assets, and inference architecture.
- `packages/agentos-manager` contains the `agents` CLI source and tests.
- `packages/andromeda-harness` contains the managed Rommie runtime harness.
- `packages/darkfactory-agent`, `packages/life-support`, `packages/rommie-agent`, and
  `packages/skyblock-agent` are managed agent submodules.
- `packages/singularity` contains the managed Singularity app.
- `packages/fabrica` contains the managed Fabrica app workspace.
- `packages/darkfactory-templates` contains the Bun templates monorepo and nested template submodules.
- `packages/agentos-data` contains the private AgentOS managed data repository and migrated non-code material.
- `packages/darkfactory-workspace` contains the lightweight DarkFactory workspace package that points at `agentos-data`.

## Commands

- `agents list [--json]` lists registered packages from `.gitmodules`.
- `agents info <name-or-path> [--json]` shows package metadata.
- `agents add <name> <git-url> [--kind agent|app|data|package|template|workspace|harness|cli] [--branch main]` adds a git-backed package.
- `agents remove <name-or-path>` removes a package submodule.
- `agents sync` syncs and initializes submodules.
- `agents state init` initializes shared runtime state.
- `agents cli list|doctor|env|exec|materialize-creds` manages Codex, Claude, Kimi, and Agy through one adapter layer.
- `agents packages register <path>` registers a local package manifest.
- `agents data repo list|set|path|env` manages git-backed data repository mappings.
- `agents harness list|doctor|run` manages runtime harnesses such as Andromeda Harness.
- `agents install <skill|plugin|hook|template|cli|harness> <name> <source-path-or-url>` installs shared capabilities.
- `agents credits` shows the shared credit store.
- `agents doctor` checks package registration and shared state.

## Shared State

All managed CLIs must use the root `.agents` directory as the single source of
runtime state:

- `.agents/clis/` stores CLI-specific data and adapter metadata.
- `.agents/harnesses/` stores harness runtime roots.
- `.agents/skills/` stores user-installed shared skills.
- `.agents/plugins/` stores user-installed shared plugins.
- `.agents/hooks/` stores user-installed shared hooks.
- `.agents/templates/` stores templates.
- `.agents/secrets/` stores local secret values managed by `agents secrets`.
- `.agents/credits.json` stores the shared credit ledger.
- `.agents/data-repos.json` stores managed data repository mappings.
- `.agents/packages.json` stores registered package manifests.
- `.agents/env` exports the paths every CLI should consume.

See [PRD.md](PRD.md).

