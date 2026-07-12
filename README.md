# Andromeda

Andromeda is one personal agent identity and one authoritative state and memory
system across models, provider CLIs, harnesses, machines, and execution
surfaces. This repository contains the implementation, and
`agents` is its management and runtime CLI.

The accepted state contract is documented in
[Canonical State and Memory v2](docs/state-memory-v2.md). Bootstrap, doctor,
provider pinning, canonical memory, and managed sessions implement that
contract directly; retired adoption and snapshot-sync commands do not exist.

## Installation

Requirements: Bun 1.1 or newer and Git. Provider CLIs (`codex`, `claude`,
`kimi`, and `agy`) are optional unless their adapters are being used.

```sh
curl -fsSL https://raw.githubusercontent.com/marius-patrik/Andromeda/dev/install/install.sh | bash
export PATH="$HOME/.agents/bin:$PATH"
```

The installer maintains one checkout at
`$AGENTS_USER_HOME/marius-patrik/Andromeda` (or an explicit absolute
`AGENTS_ROOT`), one state root at `$AGENTS_USER_HOME/.agents` (or an explicit
absolute `AGENTS_HOME`), and one platform-native launcher file: `agents` on
POSIX or `agents.ps1` on Windows. It does not use Bun global linking. The
Windows launcher forwards PowerShell's argument array directly, without a
second CMD parse. The
`AGENTS_HOME/bin` is owned by Agent OS, installation removes every other entry
from that directory; provider executables remain under
`$AGENTS_HOME/clis/<provider>/bin` and are pinned when present.

Re-running the same command performs a fast-forward-only update of the `dev`
branch, validates and content-addresses the bundled 11-skill/six-worker-role
floor, activates the one Rommie identity, and revalidates canonical state. A
checkout with a different origin or branch fails closed.

## Development setup

```sh
git clone --branch dev https://github.com/marius-patrik/Andromeda.git "$HOME/marius-patrik/Andromeda"
cd "$HOME/marius-patrik/Andromeda"
bun install --frozen-lockfile
AGENTS_HOME="$HOME/.agents" AGENTS_USER_HOME="$HOME" AGENTS_ROOT="$PWD" \
  bun run agents -- state init
```

The repository remains source-installed until release-backed installers are
ready. Do not use an old product checkout or installer as an update source.

## Product naming

- **Agent OS** is the final product.
- **Andromeda** is this repository. The npm package surface remains `@marius-patrik/agents-manager` as a recorded exception until a package rename is scheduled.
- **agents** is the CLI.
- `packages/core` is the consolidated implementation package containing the
  manager, contracts, harness, gateway, inference, and plugin domains.

Older product and topology names are migration evidence only. They are not
aliases, compatibility surfaces, install roots, or names for new work.

## One state authority

`AGENTS_HOME` is the only state-root locator. A personal installation uses
`/Users/user/.agents`; other installations use an equivalent absolute
`~/.agents` path. `AGENTS_USER_HOME` identifies the real OS account home, and
`AGENTS_ROOT` may identify the active code/distribution checkout, but neither
is another state root.

Provider-native homes are derived below `AGENTS_HOME/clis/`. Legacy
product-specific root variables are not accepted as state locators. The final
installation has no `~/.agents/state`, no top-level `~/.codex`, `~/.claude`,
`~/.kimi-code`, or `~/.gemini` directory or link, and no writable duplicate of
canonical state.

Important canonical paths include:

- `identity/` for agent identity and persona;
- `clis/<provider>/` for opaque provider-native state;
- `sessions/` and `orchestrator/` for canonical event streams and projections;
- `memory/` for provenance-backed records and generated views;
- `skills/`, `plugins/`, `hooks/`, and `templates/` for capabilities;
- `secrets/` for local secret metadata/materialization;
- `runtime/` for locks, process state, temporary data, caches, and logs;
- `sync/` for the future event-exchange implementation;
- `provenance/` for migration and source evidence.

Provider histories and generated memories are evidence, not Agent OS memory
authority. See the v2 specification for the complete schema, authority order,
sync classes, and migration acceptance criteria.

## Common commands

```sh
agents state init
agents state doctor --json
agents state status --json

agents cli list
agents cli doctor
agents cli pin all
agents cli env codex

agents run --mode orchestrator --provider codex "Review active work"
agents tui --provider codex --mode orchestrator
agents sessions list --json

agents memory status
agents memory list
agents installs --json
agents identity activate <source-directory> --replace
agents doctor
```

Cross-machine event exchange remains disabled until tombstones, encrypted
transport, deterministic merge, and secret/symlink rejection satisfy the v2
contract. There is no older snapshot-sync or provider-adoption command to fall
back to.

## Repository layout

- `packages/core/src/manager/` — `agents` CLI and Agent OS state/runtime logic.
- `packages/core/src/core/` — shared contracts, schemas, and generated clients.
- `packages/core/src/harness/` — managed runtime harness.
- `packages/core/src/gateway/` — model gateway and provider routing.
- `packages/core/src/inference/` — agent loop and inference runtime.
- `packages/darkfactory/`, `packages/life-support/`,
  `packages/skyblock-agent/`, and `packages/singularity/` — managed packages.
- `data/agent-os/` — the sole managed Agent OS data checkout, not an alternate runtime-state root.

## Shared capability contract

User-installed capabilities live only under their canonical paths in
`AGENTS_HOME`: `skills/<name>/`, `plugins/<name>/`, `hooks/<name>/`, and
`templates/<name>/`. Package-owned capabilities remain inside their package.
Do not recreate an obsolete root-level `skills/` directory or provider-specific
copies that can drift from the canonical installation.

## Validation

```sh
bun run check
bun run test
bun run ci
```

Root validation covers the TypeScript manager surface under
`packages/core/src/manager` and its tests under `packages/core/test/manager`.
