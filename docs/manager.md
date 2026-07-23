# Agent OS manager

`andromeda-cli` implements the `andromeda` CLI: the single management and runtime
surface for Agent OS. It manages canonical state and memory, provider CLI
homes, sessions, orchestration, package checkouts, harness execution,
capabilities, data repositories, environments, secrets, and credits.

## Requirements and setup

- Bun 1.1 or newer
- Git
- GitHub CLI only for explicit GitHub-secret synchronization
- Optional provider CLIs installed below `ANDROMEDA_HOME/clis/<provider>/bin`:
  `codex`, `claude`, `kimi`, and `agy`

From the repository root:

```sh
bun install
bun run ci
ANDROMEDA_HOME="$HOME/.agents" ANDROMEDA_USER_HOME="$HOME" ANDROMEDA_ROOT="$PWD" \
  bun run agents -- state init
```

The package is currently source-installed. Old product checkouts and installers
are not supported update sources.

## State contract

`ANDROMEDA_HOME` is the only runtime state root. For the personal installation it
is `/Users/user/.agents`; otherwise it is an absolute `~/.agents` path.
`ANDROMEDA_USER_HOME` identifies the real OS user home. `ANDROMEDA_ROOT` may identify
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
`ANDROMEDA_HOME/clis/`.

The bounded provider transcript reconciler may read supported Claude and Codex
JSONL evidence from those physical app-owned roots. It creates deterministic
canonical-local sessions without promoting the roots to authority. See
[`docs/session-capture.md`](session-capture.md) for evidence formats,
append-only admission, and operator lifecycle commands.

The complete authority and migration contract is
[`docs/state-memory-v2.md`](state-memory-v2.md).

## Managed provider launch boundary

A managed session spawns the pinned provider CLI from
`ANDROMEDA_HOME/clis/<provider>/bin` with provider-native environment variables
projected into that home.

Kimi turns use the CLI's official ACP stdio server. The process argv is always
the bounded `acp` subcommand; canonical startup and the current request travel
over ACP stdin, and historical transcript content is never rendered into argv.
On resume, any canonical system instruction introduced after the last native
assistant boundary travels with the current request without replaying older
conversation content.
A fresh provider session may be created only when the canonical transcript has
no prior conversation. Every successful turn records an exact non-secret
receipt containing the provider, canonical model, `acp` transport, and opaque
native session id. A later turn must resume that id, verify the resumed native
model still matches the canonical model, and keep the same receipt. Missing,
malformed, conflicting, or model-mismatched receipts fail before launch; an
ACP resume failure never falls back to `session/new`. Read-only turns select
Kimi's `plan` mode. Workspace-write turns select `manual` mode, advertise the
ACP client filesystem boundary, and service bounded replacement operations on
existing regular files through one manager-owned anchored mutation authority.
That authority resolves component-only paths beneath a canonical physical root,
holds every ancestor, then requires a second identity-equal anchored traversal
before its first truncate/write side effect. Windows handles deny delete
sharing; POSIX traversal uses `openat` plus `O_NOFOLLOW`. New-file creation is
not exposed to Kimi, linked and multiply-linked targets are denied, and
provider-side pathname writes are never granted. Shell execution,
create/delete/move operations, linked-path escapes, hard links, and all
permission requests are denied. ACP
control requests have a 30-second deadline, prompts have a
10-minute deadline, and process exit plus stderr draining use bounded one-second
cleanup windows; an expired phase terminates the provider and records only a
sanitized timeout failure.

The Agy (`antigravity-cli`) boundary is enforced per launch:

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
- **Independent effort and receipt.** The logical `low` tier keeps the Agy
  provider route fixed while canonical effort (`low`/`medium`/`high`) selects
  the matching provider-native model variant — Agy carries effort in the model
  string, e.g. `Gemini 3.5 Flash (High)`. A configured model family without a
  native effort variant fails closed. The exact spawned model and effort are
  reconstructed from provider argv and recorded in the session and execution
  receipts.

### Agy source-and-installed-boundary repair

If the installed Agy boundary drifts from the trusted source checkout, refresh it
with these constraints:

1. Update from the trusted source checkout and use the source manager until the
   installed boundary is refreshed.
2. Keep the direct Agy CLI, provider state, and `oauth_creds.json` only under
   the canonical `ANDROMEDA_HOME/clis/agy` home.
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

- `andromeda state doctor` is read-only.
- `andromeda state status` classifies provider roots as `forbidden`, `canonical`,
  `app-owned`, `split`, or `missing`. `app-owned` is limited to declared
  Windows desktop roots and never changes Agent OS authority.
- Retired move-and-link adoption and Git snapshot-sync commands do not exist.
- Cross-machine exchange is disabled by default. When explicitly enabled, it
  exchanges only encrypted immutable events, validates a deterministic merged
  history before publication, journals recovery, and rejects secrets,
  symlinks, path escapes, and collisions.
- Provider-derived canonical sessions are explicitly local-only. Export skips
  each such session atomically before secret scanning and reports the
  `provider-transcript` reason; ordinary canonical sessions remain eligible.

There is no compatibility mode or alternate loader to bypass.

## Command surface

```text
agents run --model-tier low|medium|high|max --effort low|medium|high --execution-policy read-only|workspace-write --tool-policy standard|none --receipt <absolute-new-path> [--mode orchestrator|default|chat|task] [--prompt-file <absolute-path> | --prompt-stdin | <prompt>]
agents run [--mode orchestrator|default] [--provider <id>] [--model <model>] [--tui] <prompt>
agents route probe [--model-tier low|medium|high|max] [--effort low|medium|high] [--json]
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
agents os create --name <name> --image <image> [--env andromeda-os] [--channel dev] [--dry-run]
agents os start <name> [--dry-run]
agents os stop <name> [--dry-run]
agents os status <name> [--json]
agents os logs <name> [--follow]
agents os exec <name> -- <args...>
agents os terminal <name> [--shell bash]
agents os remove <name> [--prune-data] [--dry-run]
agents os deploy <profile> [--image andromeda-os] [--env andromeda-os] [--channel dev] [--dry-run]
agents runner install|enable|disable|status|repair [--json]
```

`--tool-policy none` is an independent confidentiality boundary for fresh,
read-only turns. Agent OS suppresses canonical startup memory, runs the
provider from an empty disposable directory, strips personal Agent OS/home
paths from the child environment, and accepts output only when the adapter can
attest a native zero-tool surface. Kimi ACP and Claude support this boundary;
Codex and Agy fail closed before provider inspection or launch until their
native runtimes expose a complete zero-tool contract. `standard` preserves the
ordinary provider tool surface and does not imply read isolation.

### Logical-tier execution

The logical-tier form is the canonical automation boundary used by managed
DarkFactory work. Route policy `agent-os-tier-routes-v1` keeps `low` on Agy,
`high` on Codex with the Sol preset, and `max` on Claude with the Fable preset.
The ordered `medium` candidates are Kimi first and Codex/Sol second. Codex is a
higher-capability promotion, never a tier or effort downgrade: the receipt
continues to report the caller's requested `medium` tier and exact independent
effort. The concrete model and pinned provider executable come only from
canonical Agent OS state. A caller cannot override the provider, model, agent
preset, executable, registry, candidate order, fallback, or TUI.

Canonical `config.json` may bind `routePolicyVersion` to that exact version and
may set `providerRouteStatus.<provider>` to `enabled`, `disabled`,
`decommissioned`, `unavailable`, or `quota-blocked`. An omitted policy version
selects the exact bundled policy; an explicit mismatch fails closed. These are
Agent OS control-plane values, not DarkFactory request fields. A decommissioned
candidate is skipped without doctoring it, probing it, or creating/reading its
provider home. Disabled, unavailable, and preflight-quota-blocked candidates
are also skipped with their own stable reasons.

Every remaining candidate, in order, must resolve one canonical configured
model and pass provider doctor evidence for its pinned executable, exact
version/checksum, credentials, preset, and requested execution-policy
capability. The first admitted candidate is the only provider allowed to start.
If it fails after a turn begins, the request blocks; selection never retries a
different provider mid-turn. If no authorized candidate is healthy, the
reserved receipt is finalized blocked before any provider execution. Baton
transfer, takeover, continuation, quota draining, and dispatch ownership are
not part of this pre-turn policy.

The caller's invocation directory is physically resolved before prompt
admission and remains the provider cwd and receipt boundary. `ANDROMEDA_ROOT`
identifies the Agent OS distribution only; pointing it at a separate checkout
cannot rebind logical-tier execution away from the caller worktree.

Claude's max route currently admits `read-only` only. Its pinned native CLI has
no completed-turn or manager-owned physical-worktree containment proof for
Edit/Write, so `max` plus `workspace-write` fails before provider spawn instead
of claiming unsupported write authority.

Agy's low route also admits `read-only` only. Its native `accept-edits` flag is
a request, not completed evidence of the effective cwd, sandbox, or writable
roots, so low-tier `workspace-write` likewise fails before provider spawn.

Model tier and model effort are independent axes. Every invocation must also
declare either `read-only` or `workspace-write`; the provider adapter must attest
that exact effective policy before a successful result is accepted. Exactly one
prompt source is allowed: one positional value, one absolute `--prompt-file`, or
`--prompt-stdin`. A prompt file is admitted only when the final entry and every
parent component are physical and equal their own realpath; linked parents,
Windows junction/reparse aliases, and mid-read path drift fail before provider
work. File and stdin input stay out of downstream process argv.

Codex resolves the matching built-in `:read-only` or `:workspace` permission
profile through an ephemeral, zero-token app-server thread before provider work.
That receipt must bind the canonical model, provider home, worktree, approval
policy, effort, and sole runtime workspace root. Workspace-write preflight also
requires explicit network denial, both temporary-directory exclusions, and an
empty extra writable-root list. A completed native rollout then
re-attests the exact CLI sandbox and native managed permission profile. The
profile must explicitly report restricted network access and prove that no
writable path exists for `read-only`, or that the sole writable path is the
canonical worktree for `workspace-write`; the latter also requires explicit
temporary-directory exclusions and an empty extra `writable_roots` list.

`--receipt` must name an absolute, nonexistent file inside the physical
worktree. The manager first durably stages the complete blocked
`execution_pending` receipt in canonical manager state, which must be on the
same volume and physically disjoint from the provider-writable worktree, then
atomically admits that new file before provider work begins. Final publication
must reproduce the physical worktree root, pending receipt identity, and exact
prior-content hash, durably stage the complete final receipt under the same
manager-only authority, then atomically replace the pending path. The staged
file's new identity becomes the final proof, so an observer can see only a
complete pending or complete final route, provider version, attempt, usage,
outcome, and sanitized block reason. Execution receipt schema 2 adds a
`routing` object containing `policyVersion`, the full primary candidate, and
every pre-turn skipped candidate with its stable reason. The existing
`resolved` object identifies only the one admitted provider/model/preset/version
and remains `unresolved` when no candidate was admitted. Parent, ancestor,
overlapping-authority, and cross-volume publication drift fail closed. Provider
errors and prompt content never enter receipts or blocked CLI output; a route,
doctor, policy, usage, or provider failure remains blocked.

`agents route probe` is the read-only, zero-token readiness check for the same
canonical route boundary. With no flags it checks DarkFactory's default
`medium` tier at `medium` effort; explicit model tier and effort remain
independent. Route-probe schema 2 evaluates the same ordered candidate policy
as execution, records every skipped candidate and stable reason, and selects
Codex/Sol when the preferred medium Kimi route is explicitly unavailable. An
explicitly disabled or decommissioned candidate is skipped from canonical
configuration before its doctor or provider home can be touched. JSON output
exits nonzero when no policy-authorized candidate has a valid provider version
and is ready for the command's fixed read-only, positional probe admission.
The CLI never invokes a provider and deliberately exposes no reachability flag
until a production executor can satisfy the bounded disposable-state contract.

Memory mutations require `--source`, `--hash`, `--source-class`, and
`--confidence`. Secret commands never print secret values. A live
`agents secrets github sync` is an external mutation and requires an explicit
repository or owner target; use `--dry-run` to validate command construction.

`agents runner ...` manages the persistent lifecycle of the trusted DarkFactory
`df-local` GitHub Actions runner (`df-darkfactory-agent`): it provisions and
registers the runner with the `self-hosted, Windows, X64, df-local` labels,
persists it across reboot/logon through a least-privilege per-user scheduled
task bound through an absolute inbox Windows PowerShell path to the canonical
`bin\agents.ps1` launcher, starts only after a healthy `agents state doctor`,
never persists a registration token, reconciles stale/duplicate registrations
and processes, and reports redacted health via `status --json`. The
checksum-verified runner build is version-pinned with its upstream self-updater
disabled, so local version truth remains Agent OS-owned.
Runner mutations are Windows-only and fail closed on other platforms; `status`
is read-only everywhere.

Runner registration reads the canonical uppercase `GITHUB` secret only. Admit
an already authorized owner credential through `agents secrets set GITHUB`
(stdin by default, or `--from-file` for a verified local source); registration
tokens remain short-lived and are never persisted.

### Runner status contract

The authoritative readiness result is the seven-field `readiness` block:
`installed`, `registered`, `enabled`, `persistent`, `process`, `online`, and
`launcherBinding`. Each field is tri-state: `true` means the condition was
proven healthy, `false` means it was proven absent, drifted, or unhealthy, and
`null` means the observation boundary was inaccessible, rejected, malformed,
or ambiguous. Human status prints `unknown` for `null`; JSON preserves `null`.
Consumers must not reinterpret unknown as false, zero, an empty list, offline,
missing, disabled, or healthy.

The top-level `installed`, `registered`, and `enabled` fields are compatibility
booleans only. Each is true exactly when its matching readiness field is
`true`, so these projections fail closed and cannot distinguish false from
unknown. New consumers, including DarkFactory #263, must use `readiness`
together with the detailed evidence and issues. Detailed process, task,
registration, and doctor fields are also `null` when their observation is
uncertain; counts and lists are zero or empty only after a positive
observation.

Runner `ok` requires Windows, all seven readiness fields to be true, the
complete state doctor to be healthy, and no remaining runner issue. A busy
runner is still online; capacity is a separate concern.

`readiness.persistent` is deliberately limited to one uniquely identified task
at the exact Task Scheduler root, exactly one `AtLogOn` trigger for the current
principal, Interactive logon, and Limited run level. Task enabled state is
reported separately by `readiness.enabled`. Canonical constants and state paths
are always the observation targets; a persisted runner record is comparison
evidence and never redirects status.

`readiness.launcherBinding` exclusively owns the canonical `bin\agents.ps1`
launcher and the scheduled-task action's correctness and cardinality. It does
not prove that the DarkFactory package build, `dist/cli.js`, global `df`
command, or TUI is runnable; DarkFactory #263 must test those surfaces
separately.

Status is read-only and performs no live repair. Install, enable, disable, and
repair remain the mutation commands, and each fails closed when required
evidence is uncertain. A Task Scheduler state of `Running` is never accepted as
process health: a successful start must observe one exact
`Runner.Listener.exe` identity from the canonical install. Direct supervised
starts retain that PID, executable path, and creation time and terminate only
that identity if startup times out or fails.

All mutations serialize through one renewable runner-lifecycle lock. Local
ownership comes from the physical `.runner` file's exact positive runner ID;
the canonical `runner.json` ID is only a recovery fallback when `.runner` is
absent. Same-name rows never authorize deletion or takeover without that exact
ID, and every retained or removed row must also match the canonical Windows OS
and exact label set. Runner enumeration consumes every GitHub API page before
reconciliation. A stale local configuration is cleared by invoking the
upstream `Runner.Listener.exe remove --local` operation directly before a fresh
short-lived registration token is used; neither a removal nor registration
token is persisted. Configure and run use that same exact Listener executable,
so lifecycle code never relies on ambient batch-command parsing.

The scheduled-task definition also fixes duplicate and durability behavior:
`IgnoreNew`, battery-safe start/continuation, three one-minute restart attempts,
and no execution time limit. Drift in any of those settings is unhealthy and
repair recreates the exact task. Failed actions report `changed: true` with
`details.partialMutation: true` once an external mutation may have occurred.
Status never creates shared state, and reports provider version/heartbeat plus
the observed registration OS and labels when the GitHub API exposes them.

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
