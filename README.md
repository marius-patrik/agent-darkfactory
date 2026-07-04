# agents-mono

agents-mono is the root aggregator workspace for the agents-mono topology. It
exposes the `agents` CLI for managing agent packages, apps, templates, private
workspace state, shared skills/plugins, CLI data, and a common credit store.

## Installation

### Local development

```sh
bun install
bun link
agents doctor
```

### Source install (current supported path)

This root is intentionally developer/source-install only until release-backed
binaries are available. The supported install path is:

```sh
curl -fsSL https://raw.githubusercontent.com/marius-patrik/agents-mono/dev/install/install.sh | bash
```

The install script clones the repo into `~/.agents-mono`, initializes the
required `os/agents-manager` submodule, installs dependencies, links the
`agents` CLI, and smoke-tests with fast commands (`agents state init` and
`agents list`). It does not initialize every git submodule, so `agents doctor`
may report missing checkouts until you run `agents sync`.

### Updating

```sh
cd ~/.agents-mono
git pull
bun install --frozen-lockfile
bun link
agents list
```

Run `agents sync` and then `agents doctor` when you want to initialize and
validate all submodule packages.

Release-backed binary installers, a Windows PowerShell installer, and an
automatic updater are out of scope for this slice and tracked in the follow-up
issue.

## Usage

```sh
agents list
agents state init
agents state env
agents cli doctor
agents packages register os/agents-harness
agents harness doctor agents-harness
agents data repo list
agents doctor
```

## Layout

- `os/agents-core` is a submodule containing shared proto contracts, generated clients, schemas, and contract docs.
- `os/agents-manager` is a submodule containing the `agents` CLI source and tests.
- `os/agents-harness` is a submodule containing the managed Agents runtime harness.
- `os/agents-workspace` is the global system workspace submodule, paired with `agentos-data`.
- `os/llm-gateway` is a submodule containing the OpenAI-format LLM gateway, model registry routing, fallback, switchers, quota, OAuth seams, and tests.
- `os/inference-engine` is a submodule containing the Python agent loop, Go runtime services, engine work, deploy assets, and inference architecture.
- `plugins/plugin-rommie` is the Rommie Codex plugin submodule.
- `plugins/dream` is the Dream plugin submodule.
- `agents/darkfactory-agent`, `agents/life-support`, and `agents/skyblock-agent` are managed agent submodules.
- `apps/singularity` contains the managed Singularity app.
- `apps/fabrica` contains the managed Fabrica app workspace.
- `templates/darkfactory-templates` contains the Bun templates monorepo and nested template submodules.
- `data/data-agentos` contains the private AgentOS managed data repository and migrated non-code material.
- `workspaces/darkfactory-workspace` contains the DarkFactory workspace package, paired with `darkfactory-data`.
- `os/agents-workspace` contains the global system workspace package, paired with `agentos-data`.
- Future agents follow the per-agent pattern: `data/<agent-name>-data` + `workspaces/<agent-name>-workspace`.

## Naming contract

This repository uses the following names consistently. Legacy names are retained
only where they identify an existing repo, env var, or historical concept.

- `agents-mono` — the root aggregator repository and workspace (this repo).
- `agents` — the unified management CLI implemented in `os/agents-manager`.
- `os/agents-*` — OS/platform packages (`agents-core`, `agents-manager`, `agents-harness`).
- `agentos-data` — retained compatibility name for the default git-backed data repository and its env var (`AGENTOS_DATA_ROOT`).
- `Agentos`, `Andromeda`, `Rommie`, and similar legacy names are intentionally scoped; new docs and metadata use the current names above.

## Commands

- `agents list [--json]` lists registered packages from `.gitmodules`.
- `agents info <name-or-path> [--json]` shows package metadata.
- `agents add <name> <git-url> [--kind agent|app|data|package|template|workspace|harness|cli|plugin] [--branch main]` adds a git-backed package.
- `agents remove <name-or-path>` removes a package submodule.
- `agents sync` syncs and initializes submodules.
- `agents state init` initializes shared runtime state.
- `agents cli list|doctor|env|exec|materialize-creds` manages Codex, Claude, Kimi, and Agy through one adapter layer.
- `agents packages register <path>` registers a local package manifest.
- `agents data repo list|set|path|env` manages git-backed data repositories.
- `agents harness list|doctor|run` manages runtime harnesses such as Agents Harness.
- `agents install <skill|plugin|hook|template|cli|harness> <name> <source-path-or-url>` installs shared capabilities.
- `agents credits` shows the shared credit store.
- `agents doctor` checks package registration and shared state.

## Agents OS Container Distribution

The `agents-os` image packages the agents CLI and runtime toolchains into a
local Docker container. See `docs/agents-os/ARCHITECTURE.md` and
`docs/agents-os/DATA-CONTRACTS.md` for the full design contract.

Local image commands:

- `bun run image:build` — build the `agents-os:dev` image.
- `bun run image:smoke` — run a self-contained smoke test in a throwaway
  container.

## Shared State

All managed CLIs must use the root `.agents` directory as the single source of
runtime state. The `.agents/env` export also surfaces `AGENTS_ROOT`,
`AGENTS_DATA`, and `AGENTS_WORKSPACE` so every CLI sees the same package root,
data parent, and global workspace paths:

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

## Skills contract

The root `skills/` directory is obsolete and has been removed. Do not repopulate
it; a top-level `skills/` source directory would collide with the shared-state
contract.

Skills belong in one of these places:

- `.agents/skills/<name>/` — user-installed shared skills (`agents install skill ...`).
- `.agents/plugins/<name>/` — installed plugins, which may bundle plugin-specific skills or hooks.
- `.agents/.global/skills/<name>/` — project-level managed skills that are part of the DarkFactory baseline.
- Package-owned skills inside the agent, app, or template submodule they ship with.
