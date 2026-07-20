# agents-manager

`agents-manager` provides the `agents` CLI for local agents-mono operations. It manages package checkouts, shared `.agents` runtime state, provider CLI homes, harness execution, installs, data repositories, secrets, and credits.

## Agents OS Distro Notes

`agents` is the entry point for the `agents-os` container distribution. Inside
the distro image, the CLI is exposed on `PATH` as `agents` and consumes the
container environment contract defined in `docs/agents-os/DATA-CONTRACTS.md`:

- `AGENTS_ROOT` may point to the read-only distro root (`/opt/agents-os`) while
  `AGENTS_HOME` points to the mounted shared state (`/agents/state`).
- `sharedStateFromEnv` honors an explicit `AGENTS_ROOT` and falls back to the
  parent directory of `AGENTS_HOME` for host-native usage.
- `AGENTS_DATA` and `AGENTS_WORKSPACE` override the default `data/` and
  `os/agents-workspace` directories used by shared state.

The distro image definition and local build/smoke commands live in
`os/agents-os/`.

## Requirements

- Bun 1.1 or newer
- Git
- GitHub CLI for commands that sync GitHub secrets
- Optional provider CLIs on `PATH`: `codex`, `claude`, `kimi`, `agy` or `gemini`

## Install

For a package-local install from this repository:

```powershell
bun install
bun link
```

After linking, `agents` resolves to `src/cli.ts` through the package `bin` entry.

For the current agents-mono workspace install surface, the parent repository can also expose this CLI through its own package metadata. Use the package-local install above when working directly in this standalone repository; use the parent workspace when operating the full one-system checkout.

## Update

```powershell
git pull --ff-only
bun install
bun run ci
```

The package-local update strategy is source checkout plus Bun link. Release and autoupdate automation are separate managed-repository work and are not required for this package to validate or run locally.

## Validation

```powershell
bun run check
bun run test
bun run ci
```

The scripts run TypeScript with this repo's `tsconfig.json` and the test suite under `test/`.

## State Layout

By default, runtime state is created under `.agents` in the current working tree. Set `AGENTS_HOME` to place the shared state elsewhere.

Important paths:

- `.agents/env` stores generated environment variables.
- `.agents/clis` contains managed provider CLI homes.
- `.agents/harnesses` contains installed harness runtimes.
- `.agents/skills`, `.agents/plugins`, `.agents/hooks`, and `.agents/templates` hold installed agent assets.
- `.agents/secrets` stores local secret files.
- `.agents/credits.json` stores the shared credit ledger.
- `.agents/data-repos.json` records managed data repositories.
- `.agents/installs.json` records installed skills, plugins, hooks, templates, CLIs, and harnesses.
- `.agents/packages.json` records package registrations.
- `.agents/environments.json` records future OS/container package and environment desired state.

Harness runtime data lives under `.agents/harnesses/<id>/runtime`; this repo does not use a separate `.agents/harness-runtimes` directory.

## Command Surface

```text
agents list [--json]
agents info <name-or-path> [--json]
agents add <name> <git-url> [--kind agent|app|data|package|template|workspace|harness|cli|plugin] [--branch main] [--path path]
agents remove <name-or-path>
agents sync
agents state init
agents state env
agents cli list|doctor
agents cli env <codex|claude|kimi|agy>
agents cli materialize-creds <codex|claude|kimi|agy>
agents cli exec <codex|claude|kimi|agy> -- <args...>
agents packages register <path>
agents packages list [--json]
agents packages run <name-or-path> -- <args...>
agents packages distro <define|install|upgrade|remove> ...
agents packages container <define|pull|pin|upgrade|remove> ...
agents env list [--json]
agents env create <id> [--kind host|container|agent-workspace]
agents env switch <id>
agents env sync <id>
agents data repo list [--json]
agents data repo set <id> <owner/name> [--path data/name] [--branch main] [--managed-path path] [--env NAME]
agents data repo path <id>
agents data repo env <id>
agents harness list [--json]
agents harness doctor <name>
agents harness run <name> -- <args...>
agents install <skill|plugin|hook|template|cli|harness> <name> <source-path-or-url>
agents installs [--json]
agents secrets list [--json]
agents secrets set <NAME> [--from-file path]
agents secrets path <NAME>
agents secrets github sync <NAME> [--as SECRET_NAME] [--repo owner/name | --owner owner] [--dry-run]
agents credits [--json]
agents credits credit <provider> <consumer> <amount> [--note text] [--json]
agents credits debit <provider> <consumer> <amount> [--note text] [--json]
agents credits usage <provider> <consumer> [--amount n] [--tokens-in n] [--tokens-out n] [--note text] [--json]
agents credits provider <provider> [--balance n] [--soft-limit n] [--window-seconds n] [--window-started-at iso] [--json]
agents doctor
agents os doctor [--json]
agents os image list [--json]
agents os image build --image <image> [--channel dev] [--file path] [--context path] [--dry-run]
agents os image pull --image <image> [--channel dev] [--dry-run]
agents os create --name <name> --image <image> [--env agents-os] [--channel dev] [--dry-run]
agents os start <name> [--dry-run]
agents os stop <name> [--dry-run]
agents os status <name> [--json]
agents os logs <name> [--follow]
agents os exec <name> -- <args...>
agents os terminal <name> [--shell bash]
agents os remove <name> [--prune-data] [--dry-run]
agents os deploy <profile> [--image agents-os] [--env agents-os] [--channel dev] [--dry-run]
```

## Credits

The shared credit store is `.agents/credits.json`. It keeps provider counters, consumer balances, and an append-only ledger of credit, debit, and usage events.

Examples:

```powershell
agents credits provider codex --balance 100 --soft-limit 80 --window-seconds 3600
agents credits credit codex stream-worker 25 --note seed
agents credits debit codex stream-worker 5
agents credits usage codex stream-worker --amount 2.5 --tokens-in 100 --tokens-out 40
agents credits --json
```

Provider and consumer names must be simple identifiers made from letters, numbers, `.`, `_`, or `-`. Mutation commands never print secrets; `--json` prints only the updated credit store.

## Provider Notes

`agents cli doctor` checks whether provider binaries and credential sources are available. Missing Codex, Claude, Kimi, or Agy/Gemini binaries are environment setup issues, not package validation failures. `agents cli exec` launches the provider with shared `AGENTS_*` environment variables and the provider-specific managed home.

`agents secrets github sync` mutates GitHub repository secrets through `gh secret set`. Prefer tests and dry runs around command construction; reserve live sync for explicit operational use.

Secret sync requires an explicit target. Use `--repo owner/name` for a single repository, or `--owner owner` when intentionally syncing to that owner's non-archived repositories. Add `--dry-run` to validate the local secret and target mapping without calling `gh secret set`.

## Roadmap Mandates

The current CLI surface is intentionally local and file-backed. The next roadmap slices are:

- TUI and OS launcher work from #8: expose the same management surface through an operator-friendly launcher without creating a separate control plane.
- Single management surface from #7: keep packages, environments, secrets, providers, harnesses, and launcher operations under `agents` rather than sidecar tools.
- Real OS/container packages and environments from #10: add distro package, container image, and named environment management after the agents-mono architecture and base-image contracts land.

Until the #10 implementation lands, `agents packages` remains the local package registration and runnable manifest surface. It does not yet install OS packages, pull container images, or switch environments.

The #10 groundwork state and command skeletons are documented in `docs/packages-and-environments.md`.
