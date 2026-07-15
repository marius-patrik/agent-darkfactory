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
- `sync/` — encrypted bundle exchange configuration and import journals;
- `provenance/` — source and migration evidence;
- `harnesses/<id>/runtime/` — harness-local runtime data;
- top-level canonical registries such as `installs.json`, `packages.json`,
  `data-repos.json`, `environments.json`, and `providers.json`.

No `~/.agents/state` tree, provider bridge, or standalone-only provider root is
supported. Physical Windows `.codex` and `.claude` desktop-runtime directories
may coexist only as non-authoritative `app-owned` surfaces when their canonical
CLI homes also exist. Legacy product-specific root variables are not state
locators. Provider-native environment variables are derived projections into
`AGENTS_HOME/clis/`.

The complete authority and migration contract is
[`docs/state-memory-v2.md`](state-memory-v2.md).

## Managed provider launch boundary

A managed session spawns the pinned provider CLI from
`AGENTS_HOME/clis/<provider>/bin` with provider-native environment variables
projected into that home. The Agy (`antigravity-cli`) boundary is enforced per
launch:

- **Argv.** `--print` consumes the immediately-following token as the prompt, so
  flags must precede it: `--model <concrete> --print <prompt>`. A flag placed
  after `--print` is swallowed as user input and the model silently falls back
  to the default.
- **Home isolation.** Agy binds an absolute `GEMINI_DIR` to `clis/agy/.gemini`
  and isolates `HOME`/`USERPROFILE` into the provider home, so its config root
  cannot fall back to the user-profile `.gemini` directory on Windows.
- **Updater isolation.** Every managed Agy session spawn and Agy pin/version
  probe receives `AGY_CLI_DISABLE_AUTO_UPDATE=true`. After the final environment
  merge, the manager removes every case-insensitive alias and reasserts the one
  uppercase key, so ambient variables and adapter options cannot override it;
  other providers are unchanged. This suppresses Agy's cooperative startup
  updater but is not the sole security control: immutable preflight attestation
  and postflight checksum verification still reject an executable replacement
  or self-update that ignores the flag. Upgrades remain available only through
  the trusted Agent OS pin/upgrade control plane.
- **Fail-closed verification, before and after launch.** Before canonical
  prompt, argv, and environment preparation, the launch verifies the current
  trusted registry pin and captures immutable per-run authority S0: the
  configured executable path, its realpath and sha256, and the exact physical
  `clis`, provider-home, bin, `.gemini`, and `oauth_creds.json` paths. Those
  paths must be physically contained with no symlink, junction, or
  reparse-point escape, and the credential must be a readable regular file
  (opened only to prove readability; contents are never read, copied, or
  logged). After all launch material is prepared — and as the final awaited
  filesystem check immediately before `Bun.spawn` — the manager re-verifies
  executable metadata, realpath, containment, and sha256 plus the physical
  boundary and credential readability against S0. It never rereads the
  mutable registry, so a later registry+binary rewrite cannot replace S0 with
  a poisoned authority. After the provider exits — and before its output is
  parsed, returned, or recorded — postflight performs the same
  registry-independent checks against S0. No successful assistant content or
  receipt is accepted from persistent drift. Upgrades occur only through
  `agents cli pin`. A malicious swap in the unavoidable synchronous window
  after final verification and before or during spawn, or a transient mid-run
  swap fully restored before postflight, is not eliminated; this boundary does
  not claim the executed bytes remain immutable for the whole process lifetime.
- **Tier resolution and receipt.** Canonical reasoning tiers
  (`low`/`medium`/`high`) resolve to the concrete authenticated model — Agy
  carries the tier in the model string, e.g. `Gemini 3.5 Flash (Low)` — and are
  recorded in the session receipt as the resolved concrete model, provider,
  effort, and agent preset.

### Agy source-and-installed-boundary repair

If the installed Agy boundary drifts from the trusted source checkout, refresh it
with these constraints:

1. Update from the trusted source checkout and use the source manager until the
   installed boundary is refreshed.
2. Keep the direct Agy CLI, provider state, and `oauth_creds.json` only under
   the canonical `AGENTS_HOME/clis/agy` home.
3. Run Agy's own authentication only with the absolute `GEMINI_DIR`, `HOME`,
   and `USERPROFILE` values exposed by `agents cli env agy`, never by copying
   another provider's credentials or using standalone user-home `.gemini`
   state.
4. Before any managed task, confirm the active manager's `agents cli env agy`
   projection reports `AGY_CLI_DISABLE_AUTO_UPDATE=true`. If the installed
   launcher does not expose that boundary, use the trusted source manager until
   the installed boundary is refreshed; do not prove it by launching Agy.
5. Record upgrades only through `agents cli pin agy`.
6. Verify `agents cli doctor` plus `agents state status --json` and
   `agents state doctor --json` before a managed Agy session.

These commands do not delete files or mutate personal provider credentials. The
fail-closed boundary captures S0 before launch preparation, re-verifies it
immediately before spawn without rereading the registry, and checks the same S0
again after exit. Process and output settlement cannot bypass that postflight
check; output-read failures propagate only after S0 is re-verified. Each
re-verification checks the physical provider boundary first, then finishes with
the executable realpath and checksum so byte attestation is the final awaited
filesystem operation before spawn. The synchronous final-check-to-spawn window
and a transient mid-run swap fully restored before postflight remain residual
limitations.

## Root and exchange safety

- `agents state doctor` is read-only.
- `agents state status` classifies provider roots as `forbidden`, `canonical`,
  `app-owned`, `split`, or `missing`. `app-owned` is limited to declared
  Windows desktop roots and never changes Agent OS authority.
- Retired move-and-link adoption and Git snapshot-sync commands do not exist.
- Cross-machine exchange is disabled by default. When explicitly enabled, it
  exchanges only encrypted immutable events, validates a deterministic merged
  history before publication, journals recovery, and rejects secrets,
  symlinks, path escapes, and collisions.

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
agents sync [source]
agents sync enable [--generate-key]
agents sync disable
agents sync status [--json]
agents sync export <bundle-file> [--json]
agents sync import <bundle-file> [--json]
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
authentication still requires explicit integration proofs at its real
boundary; cross-machine exchange is covered by encrypted convergence,
interruption recovery, idempotence, collision, tamper, and secret-rejection
tests.
