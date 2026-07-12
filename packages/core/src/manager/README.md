# Agent OS manager

`agents-manager` implements the `agents` CLI: the single management and runtime
surface for Agent OS. It manages canonical state and memory, provider CLI
homes, sessions, orchestration, package checkouts, harness execution,
capabilities, data repositories, environments, secrets, and credits.

## Requirements and setup

- Bun 1.1 or newer
- Git
- GitHub CLI only for explicit GitHub-secret synchronization
- Optional provider CLIs installed below `AGENTS_HOME/clis/<provider>/bin`:
  `codex`, `claude`, `kimi`, and `agy`

From the repository root:

```sh
bun install
bun run ci
AGENTS_HOME="$HOME/.agents" AGENTS_USER_HOME="$HOME" AGENTS_ROOT="$PWD" \
  bun run agents -- state init
```

The package is currently source-installed. Old product checkouts and installers
are not supported update sources.

## State contract

`AGENTS_HOME` is the only runtime state root. For the personal installation it
is `/Users/user/.agents`; otherwise it is an absolute `~/.agents` path.
`AGENTS_USER_HOME` identifies the real OS user home. `AGENTS_ROOT` may identify
the active code/distribution checkout, but it is not state.

The canonical layout includes:

- `identity/` — agent identity, persona, and user model;
- `clis/<provider>/` — opaque provider-native runtime state;
- `sessions/` — canonical session events, provider handles, and projections;
- `memory/` — provenance-backed records, events, indexes, and generated views;
- `orchestrator/` — orchestrator events, lease, and projected state;
- `skills/`, `plugins/`, `hooks/`, and `templates/` — shared capabilities;
- `secrets/` — local secret registry and explicit materializations;
- `runtime/` — locks, process state, temporary data, caches, and logs;
- `sync/` — future v2 event exchange;
- `provenance/` — source and migration evidence;
- `harnesses/<id>/runtime/` — harness-local runtime data;
- top-level canonical registries such as `installs.json`, `packages.json`,
  `data-repos.json`, `environments.json`, and `providers.json`.

No `~/.agents/state` tree exists in the final layout. No physical directory or
link at `~/.codex`, `~/.claude`, `~/.kimi-code`, or `~/.gemini` is supported.
Legacy product-specific root variables are not state locators. Provider-native
environment variables are derived projections into `AGENTS_HOME/clis/`.

The complete authority and migration contract is
[`docs/state-memory-v2.md`](../../../../docs/state-memory-v2.md).

## Root and exchange safety

- `agents state doctor` is read-only.
- `agents state status` classifies provider roots as `forbidden`, `canonical`,
  `split`, or `missing`.
- Retired move-and-link adoption and Git snapshot-sync commands do not exist.
- Cross-machine exchange stays disabled until tombstones, encrypted transport,
  deterministic merge, recovery, and secret/symlink rejection are proven.

There is no compatibility mode or alternate loader to bypass.

## Command surface

```text
agents run [--mode orchestrator|default] [--provider <id>] [--model <model>] [--tui] <prompt>
agents tui [--provider <id>] [--model <model>] [--mode <mode>]
agents sessions list [--json]
agents sessions resume <id> <prompt>
agents list [--json]
agents info <name-or-path> [--json]
agents add <name> <git-url> [--kind app|data|package|template|workspace|harness|cli|plugin] [--branch main] [--path path]
agents remove <name-or-path>
agents sync
agents state init
agents state env
agents state doctor [--json]
agents state status [--json]
agents memory <remember|list|status|supersede|retract|render> [options]
agents identity activate <source-directory> [--replace]
agents cli list|doctor
agents cli pin [codex|claude|kimi|agy|all]
agents cli env <codex|claude|kimi|agy>
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
agents session run --provider <id> --model <model> [--mode chat|task] [--session <id>] [--stream] <prompt>
agents session list [--json]
agents session show <id> [--json]
agents install <skill|plugin|hook|template|cli|harness> <name> <source-path-or-git-url> [--replace]
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

Memory mutations require `--source`, `--hash`, `--source-class`, and
`--confidence`. Secret commands never print secret values. A live
`agents secrets github sync` is an external mutation and requires an explicit
repository or owner target; use `--dry-run` to validate command construction.

## Validation

```sh
bun run check
bun run test
bun run ci
```

These scripts typecheck the repository and run the manager tests. Provider
authentication and future two-machine exchange still require explicit
integration proofs at their real boundaries.
