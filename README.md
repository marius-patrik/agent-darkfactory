# Andromeda

Andromeda is one personal agent identity and one authoritative state and memory
system across models, provider CLIs, harnesses, machines, and execution
surfaces. This repository contains the implementation, and
`agents` is its management and runtime CLI.

The accepted state contract is documented in
[Canonical State and Memory v2](docs/state-memory-v2.md). Bootstrap, doctor,
provider pinning, canonical memory, and managed sessions implement that
contract directly; retired adoption and snapshot-sync commands do not exist.
The live branch, review, managed-CI, and private-data compensating controls
are recorded in [Managed Enforcement](docs/managed-enforcement.md).
The complete component, platform, real-process, and product-smoke gate is
recorded in [CI Validation](docs/ci-validation.md).

## Authority and planning

Authority has two explicit dimensions. Current owner instruction is highest,
and the owner-facing private-data `context/TASK.md` board records work
authorization, high-level sequencing, and parked scopes; no plan, PRD, or issue
can reopen a board-gated scope. Within authorized work, the program derivation
chain recorded by [#219](https://github.com/marius-patrik/Andromeda/issues/219)
is owner instruction → private-data `context/PLAN.md` → root [PRD](PRD.md) →
GitHub issues. The plan records the consolidated program and feeds the PRD; the
PRD is the repository's system specification; issues are executable contracts
that implement it.

Root `docs/` contains supporting implementation references, accepted contracts,
runbooks, and explicitly labelled parked or retired design evidence. A document
under `docs/` cannot authorize work or override the board, PRD, program plan, or
its implementing issue. See the [documentation index](docs/README.md) for the
status of each document family.

## Installation

Requirements: Bun 1.1 or newer and Git. Provider CLIs (`codex`, `claude`,
`kimi`, and `agy`) are optional unless their adapters are being used.

```sh
curl -fsSL https://raw.githubusercontent.com/marius-patrik/Andromeda/dev/install/install.sh | bash
export PATH="$HOME/.agents/bin:$PATH"
```

The installer maintains one checkout at
`$ANDROMEDA_USER_HOME/marius-patrik/Andromeda` (or an explicit absolute
`ANDROMEDA_ROOT`), one state root at `$ANDROMEDA_USER_HOME/.agents` (or an explicit
absolute `ANDROMEDA_HOME`), and one platform-native launcher file: `agents` on
POSIX or `agents.ps1` on Windows. It does not use Bun global linking. The
Windows launcher forwards PowerShell's argument array directly, without a
second CMD parse. The
`ANDROMEDA_HOME/bin` is owned by Agent OS, installation removes every other entry
from that directory; provider executables remain under
`$ANDROMEDA_HOME/clis/<provider>/bin` and are pinned when present.

Re-running the same command performs a fast-forward-only update of the `dev`
branch, validates and content-addresses the bundled 11-skill/six-worker-role
floor, activates the one Rommie identity, and revalidates canonical state. A
checkout with a different origin or branch fails closed.

## Development setup

```sh
git clone --branch dev https://github.com/marius-patrik/Andromeda.git "$HOME/marius-patrik/Andromeda"
cd "$HOME/marius-patrik/Andromeda"
bun install --frozen-lockfile
ANDROMEDA_HOME="$HOME/.agents" ANDROMEDA_USER_HOME="$HOME" ANDROMEDA_ROOT="$PWD" \
  bun run agents -- state init
```

The repository remains source-installed until release-backed installers are
ready. Do not use an old product checkout or installer as an update source.

## Product naming

- **Andromeda** is the product, this repository, and the npm scope. The root
  package is `@marius-patrik/andromeda` and is the only public JavaScript
  package; components follow it as `andromeda-cli`, `andromeda-sdk`,
  `andromeda-web`, `andromeda-memory`, and `andromeda-bot`. The CLI surface is
  `andromeda`.
- **agents** is the CLI.
- `src/` contains one direct child for each implementation domain,
  managed product plugins, and managed product applications.
- `plugins/` remains the authored root for repository-owned plugin capabilities;
  it does not contain managed product repository gitlinks.
- `data/` contains development pins for separate state and ledger repositories.

Older product and topology names are migration evidence only. They are not
aliases, compatibility surfaces, install roots, or names for new work.
Nested JavaScript manifests are private workspace metadata for their PRD layer;
they do not publish another product or CLI.

## One state authority

`ANDROMEDA_HOME` is the only state-root locator. A personal installation uses
`/Users/user/.agents`; other installations use an equivalent absolute
`~/.agents` path. `ANDROMEDA_USER_HOME` identifies the real OS account home, and
`ANDROMEDA_ROOT` may identify the active code/distribution checkout, but neither
is another state root.

Provider-native homes are derived below `ANDROMEDA_HOME/clis/`. Legacy
product-specific root variables are not accepted as state locators. The final
installation has no `~/.agents/state`, no provider bridge, and no writable
duplicate of canonical state. On Windows, physical `.codex` and `.claude`
desktop-runtime directories may coexist only as non-authoritative `app-owned`
surfaces; standalone-only roots and every linked root still fail.

Important canonical paths include:

- `identity/` for agent identity and persona;
- `clis/<provider>/` for opaque provider-native state;
- `sessions/` and `orchestrator/` for canonical event streams and projections;
- `memory/` for provenance-backed records and generated views;
- `skills/`, `plugins/`, `hooks/`, and `templates/` for capabilities;
- `secrets/` for local secret metadata/materialization;
- `runtime/` for locks, process state, temporary data, caches, and logs;
- `sync/` for encrypted event-exchange configuration and import journals;
- `provenance/` for migration and source evidence.

Provider histories and generated memories are evidence, not Agent OS memory
authority. See the v2 specification for the complete schema, authority order,
sync classes, and migration acceptance criteria.

## Provider transcript capture

Claude and Codex JSONL transcripts produced by desktop apps, editor
integrations, or CLI/SDK entrypoints can be reconciled into deterministic local
canonical sessions:

```sh
andromeda sessions ingest --provider all --json
andromeda sessions capture install --json
andromeda sessions capture status --json
```

The Windows capture task runs hidden every five minutes and suppresses
overlapping invocations. Provider-derived canonical sessions are deliberately
local-only: encrypted event export skips each entire session and reports the
reason, while ordinary canonical sessions remain exchange-eligible. Raw
provider files remain non-authoritative evidence. See
[Provider Session Capture](docs/session-capture.md) for supported roots,
formats, lifecycle commands, and append/rewrite failure semantics.

## Common commands

```sh
agents state init
agents state doctor --json
agents state status --json

agents cli list
agents cli doctor
agents cli pin all
agents cli env codex

gh auth token | agents secrets set GITHUB_TOKEN
agents runner install --json
agents runner status --json

agents run --mode orchestrator --provider codex "Review active work"
agents tui --provider codex --mode orchestrator
agents sessions list --json

agents memory status
agents memory list
agents sync enable --generate-key
agents sync status --json
agents sync export <bundle-file> --json
agents sync import <bundle-file> --json
agents sync recover --json
agents installs --json
agents identity activate <source-directory> --replace
agents doctor
```

The persistent DarkFactory `df-local` runner reads the repository-control
credential only from the canonical `GITHUB_TOKEN` Agent OS secret. The
registration token it obtains from GitHub is short lived and is never stored;
runner install, enable, repair, and every process start remain gated on a green
`agents state doctor` result.

Cross-machine event exchange now satisfies the v2 tombstone, encrypted
transport, deterministic merge, recovery, and secret/symlink rejection
contract. The transport is disabled by default; enable it with
`agents sync enable`, exchange encrypted bundles with `agents sync export` and
`agents sync import`, and inspect it with `agents sync status`. There is no
older snapshot-sync or provider-adoption command to fall back to.

## Repository layout

### Target architecture

- `sdk/` — the core package everything is implemented through.
- `mcp/` — the protocol and orchestration layer every call passes through,
  carrying MCP in both directions and integrating standard agent harnesses.
- `server/` — per-machine deployment of the cluster system.
- `clients/cli/`, `clients/app/`, `clients/web/` — clients only, holding no
  business logic.
- `plugins/` — capabilities loaded through the sdk plugin contract.

### Carried trees

These hold former standalone repositories, folded in with their full history.
They keep their own identity and versioning, and nothing outside them may
depend on them.

  runtime, see [manager](docs/manager.md)), `core`
  ([contracts and generated clients](docs/core.md)), `harness`
  ([managed runtime](docs/harness.md)), `gateway`
  ([routing](docs/gateway-runtime.md)), `inference`
  ([agent loop](docs/inference.md)), plus the folded predecessors: the memory
  plugin, dream, experience, the developmental runtime, the retired gateway,
  the legacy manager, and the workspace substrate.
- `src/bot/` — the GitHub control-plane agent project.
- `templates/` — the folded template repositories: `bot`, `cli`, `repo`,
  `web`, and `darkfactory-templates`.

### Authored roots

- `skills/`, `hooks/`, `roles/`, and `commands/` — authored capability roots;
  `persona.md` is the authored identity persona.
- `docs/` — the documentation root, including component, protocol,
  architecture, and specification material.
- `scripts/` — repository automation and validators, including the DarkFactory
  managed scripts.

State is not a submodule: the live private-data checkout is `$ANDROMEDA_HOME`,
which is also `ANDROMEDA_SYSTEM_DATA_ROOT`. This repository declares no
submodules.

## Shared capability contract

The repository authors its capability floor directly at `skills/`, `plugins/`,
`hooks/`, `roles/`, and `commands/`. The installer validates and publishes that
source into the canonical `ANDROMEDA_HOME` state tree; provider-specific copies are
not another authority. Managed product plugins and authored plugin capabilities
have separate `src/` and `plugins/` roots, so moving the managed repositories
does not change the authored capability-source contract.

## Validation

```sh
bun run check
bun run test
bun run ci
```

`bun run ci` is the authoritative whole-repository gate. It runs every active
component, the real gateway and inferctl-routing legs, installer and encrypted
sync smokes, and review regressions. GitHub runs the same suite contract as
parallel Ubuntu and Windows legs and reports one required `Validate` result.

## License

Andromeda is licensed under Apache-2.0. See [LICENSE](LICENSE), [NOTICE](NOTICE),
and the [source provenance index](docs/provenance/README.md). Imported
third-party code, assets, and model artifacts retain their own notices and
path-specific licenses.
