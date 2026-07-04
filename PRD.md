# agents-mono / Agents Manager PRD

## Overview

`agents-mono` is a workspace for managing agent packages. Its `agents` CLI is a Bun TypeScript package manager that installs and tracks agent repos, app repos, templates, private workspace state, CLI adapters, skills, plugins, and shared runtime state so every managed CLI sees the same installed capabilities and credit store.

## Naming contract

Root docs and metadata use the following names. Legacy names are retained only
where they identify an existing repo, env var, or historical concept.

- `agents-mono` — the root aggregator repository and workspace.
- `agents` — the unified management CLI implemented in `os/agents-manager`.
- `os/agents-*` — OS/platform packages (`agents-core`, `agents-manager`, `agents-harness`).
- `agentos-data` — retained compatibility name for the default git-backed data repository and its env var (`AGENTOS_DATA_ROOT`).
- `Agentos`, `Andromeda`, `Rommie`, and similar legacy names are intentionally scoped; new docs and metadata use the current names above.

## Goals

- Manage git-backed agent packages from one workspace.
- Keep CLI-specific metadata under `.agents/clis`.
- Keep user-installed skills and plugins under `.agents/skills` and `.agents/plugins`.
- Keep harness packages under `os/agents-harness` and launch them with shared state.
- Configure git-backed data repositories such as `agentos-data`; workspace packages such as `darkfactory-workspace` can point at those data repos.
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
- Harness: a managed runtime package, such as Agents Harness, launched by `agents`.
- Data repo: a git-backed managed data package with an optional managed root and exported env var.
- CLI adapter: the shared rooting and credential contract for a vendor CLI.
- Shared state: the root `.agents` directory.
- Core package: shared contracts and generated clients under `os/agents-core`.
- Gateway package: OpenAI-format model gateway and registry routing under `os/llm-gateway`.
- Inferer package: agent loop, runtime services, engine work, and deploy assets under `os/inference-engine`.
- Manager package: the CLI implementation and tests under `os/agents-manager`.
- Managed checkout: a git-backed package under `<category>/<name>`. Agents, apps, harnesses, templates, data repositories, and workspace repositories are organized under explicit category folders.
- Distro image: a releaseable container image (`agents-os`) that packages the agents CLI, Bun/Node/Python/Go runtimes, and the shared-state mount contract.
- Global workspace: the system-wide writable working set at `os/agents-workspace`, paired with `agentos-data` as its durable data companion.
- Per-agent workspace pattern: every agent gets a data repo (`data/<agent-name>-data`) and a workspace repo (`workspaces/<agent-name>-workspace`), mirroring the reference pair `darkfactory-data` + `darkfactory-workspace`.
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
- `agents data repo list|set|path|env` manages git-backed data repositories.
- `agents harness list|doctor|run` manages harness packages.
- `agents install skill|plugin|hook|template|cli|harness` installs shared capability files into `.agents`.
- `agents installs` lists shared installs.
- `agents credits` locates or prints the shared credit store.
- `agents doctor` validates package checkouts and shared state.
- `bun run image:build` builds the local `agents-os` container image.
- `bun run image:smoke` runs a self-contained smoke test of the image.

## Workspace Layout

```text
  os/
    agents-core/
    agents-manager/
    agents-harness/
    agents-workspace/
    llm-gateway/
    inference-engine/
  data/
    data-agentos/
  agents/
    darkfactory-agent/
    life-support/
    skyblock-agent/
  apps/
    fabrica/
    singularity/
  templates/
    darkfactory-templates/
  workspaces/
    darkfactory-workspace/
    # future per-agent workspaces follow workspaces/<agent-name>-workspace
  plugins/
    plugin-rommie/
    dream/
```

## State Layout

```text
.agents/
  clis/
  harness-runtimes/
  skills/
  plugins/
  hooks/
  templates/
  secrets/
  credits.json
  data-repos.json
  installs.json
  packages.json
  env
```

Every managed CLI must read `AGENTS_HOME`, `AGENTS_ROOT`, `AGENTS_DATA`, `AGENTS_WORKSPACE`, `AGENTS_CLIS`, `AGENTS_SKILLS`, `AGENTS_PLUGINS`, `AGENTS_HOOKS`, `AGENTS_TEMPLATES`, `AGENTS_SECRETS`, `AGENTS_CREDITS`, and `AGENTS_DATA_REPOS` from `.agents/env` or equivalent environment exports. Package and harness execution also exports configured data repo env vars such as `AGENTOS_DATA_ROOT` and `DARK_FACTORY_WORKSPACE_ROOT`.

## Skills contract

The root `skills/` directory is obsolete. It previously appeared in the layout as
a placeholder and must not be repopulated.

Skills live in exactly one of these places:

- **User-installed shared skills** — `.agents/skills/<name>`, installed by
  `agents install skill <name> <source>` and shared across every managed CLI.
- **Installed plugin assets** — `.agents/plugins/<name>/` (a plugin may bundle
  plugin-specific skills, prompts, or hooks with its install).
- **Project-level managed skills** — `.agents/.global/skills/<name>/`, part of
  the DarkFactory baseline and tracked in this repo as managed files.
- **Package-authored skills** — skills that ship with an agent, app, or template
  live inside that package's own submodule or registered path.

Do not add a top-level `skills/` source directory; doing so would collide with
`.agents/skills` and break the shared-state contract.

## Harness Contract

Harnesses declare an `agent.package.json` manifest. The exact `entry` and
`workingDirectory` are package-defined; the example below shows a current
agents-harness shape rather than the legacy Andromeda command path:

```json
{
  "schemaVersion": 1,
  "id": "agents-harness",
  "kind": "harness",
  "entry": "go run ./cmd/agents-harness",
  "workingDirectory": ".",
  "requires": {
    "clis": ["codex", "claude", "kimi", "agy"],
    "state": ["skills", "plugins", "hooks", "credits"]
  }
}
```

`agents harness run <id>` launches the harness with `AGENTS_HOME` and shared state paths. Harness-specific runtime data may remain isolated under `.agents/harnesses/<id>/runtime`.

## Data Repo Contract

`agents state init` seeds `agentos-data` as the default managed data repo:

```json
{
  "id": "agentos-data",
  "repo": "marius-patrik/agentos-data",
  "path": "data/data-agentos",
  "branch": "main",
  "env": "AGENTOS_DATA_ROOT"
}
```

Packages may declare an additional `dataRepo` mapping in `agent.package.json`.
When registered, `agents packages register` stores that mapping in
`.agents/data-repos.json`, and `agents packages run` / `agents harness run`
export its configured env var to the process.

## CLI Adapter Contract

Built-in adapters:

- Codex: `CODEX_HOME=.agents/clis/codex`, credential source `~/.codex/auth.json`.
- Claude: `CLAUDE_CONFIG_DIR=.agents/clis/claude`, credential source `~/.claude/.credentials.json`.
- Kimi: `KIMI_CODE_HOME=.agents/clis/kimi`, credential source `~/.kimi-code/credentials/kimi-code.json`.
- Agy: `HOME=.agents/clis/agy`, credential source `~/.gemini/oauth_creds.json`.

Credential materialization is explicit, non-destructive, and must not print secret values.

## Installation and updater

Supported install paths:

- **Local development** — clone the repo, run `bun install` and `bun link`, then
  verify with `agents doctor`.
- **Source install** — this root remains developer/source-install only until
  release-backed binaries are available. `install/install.sh` clones the repo
  into `~/.agents-mono`, initializes the required `os/agents-manager` submodule,
  installs dependencies, links the CLI, and smoke-tests with fast commands
  (`agents state init` and `agents list`).

Update path for source installs:

```sh
cd ~/.agents-mono
git pull
bun install --frozen-lockfile
bun link
agents list
```

Run `agents sync` before `agents doctor` when you want to initialize and
validate all submodule packages.

Release automation runs `bun run smoke:release` during the DarkFactory release
workflow. The release smoke test performs an isolated source install into a
temporary directory and then verifies that the linked `agents` command resolves
to `os/agents-manager/src/cli.ts` (on symlink platforms) and that fast commands
(`agents state init` and `agents list`) succeed.

Release-backed binary installers, a Windows PowerShell installer, and an
automatic updater are out of scope for this slice and tracked in #24.

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
7. Agents Harness bridge through `AGENTS_HOME`.







