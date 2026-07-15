# DarkFactory

DarkFactory is a separate GitHub-native autonomous engineering product. It
receives GitHub webhooks, verifies signatures, synchronizes repository policy,
and runs deterministic planning and orchestration loops. Agent OS is an
integration dependency for local provider execution and shared personal state,
not DarkFactory's product or release owner.

## What it does

- Exposes `POST /webhook` for GitHub App webhooks.
- Exposes `GET /healthz` for deploy and uptime checks.
- Logs GitHub App `ping` events.
- Comments on newly opened issues.
- Comments on newly opened pull requests.
- Checks pull requests in installed repositories for the current DarkFactory
  policy and workflow scaffold.
- Dispatches the orchestrator workflow immediately when the machine evaluator labels an issue `df:ready`; an owner/member/collaborator can comment `/df run` to request immediate evaluation, never to force readiness.
- Installs the current managed Codex Review migration gate. Issue #36 replaces
  it with provider-agnostic DarkFactory Autoreview through canonical Agent OS.
- Reads repository-local agent context, `.darkfactory`, and `.github` policy
  from the `managed-repository` child of canonical Andromeda-data authority.
- Opens managed setup PRs when the app is installed on a repository or when repositories are added to an installation.
- Can sync all installed repositories from the `Sync Managed Repositories` workflow.

## Requirements

- Node.js 22 or newer.
- A healthy Agent OS installation for local secrets, managed data, and worker
  execution.
- A GitHub App installed on the target repositories.
- For label-to-merged dogfood runs, target repositories with protected worker branches must have GitHub repository auto-merge enabled before `df:ready` dispatch.
- A public HTTPS URL for local webhook testing, such as an ngrok or Cloudflare Tunnel URL.

## GitHub App setup

Create a GitHub App and configure:

- Webhook URL: `https://<your-public-host>/webhook`
- Webhook secret: any high-entropy random value, also used as `GITHUB_WEBHOOK_SECRET`
- Subscribe to events:
  - `Issues`
  - `Issue comments`
  - `Pull requests`
  - `Ping`
- Repository permissions:
  - Administration: Read-only
  - Actions: Read and write
  - Checks: Read-only
  - Commit statuses: Read-only
  - Contents: Read and write
  - Issues: Read and write
  - Pull requests: Read and write
  - Secrets: Read-only
  - Metadata: Read-only, granted by GitHub automatically

`Contents: Read and write` is required so Dark Factory can create managed setup branches. `Pull requests: Read and write` is required so it can open setup PRs. `Actions: Read and write` is required so the deployed webhook server can dispatch the orchestrator workflow for low-latency `df:ready` and `/df run` handling.

Generate a private key for the app and install the app on the repositories where it should run.

To install the app on every repository, use the GitHub App installation UI and choose all repositories. The user token used by `gh` cannot grant GitHub App repository access by itself.

## Agent OS setup

```powershell
npm ci
npm run build
agents packages register packages/darkfactory
agents state doctor
```

Store local secrets through Agent OS. Secret values are not printed by the manager:

```powershell
agents secrets set GITHUB_APP_ID
agents secrets set GITHUB_PRIVATE_KEY
agents secrets set GITHUB_WEBHOOK_SECRET
agents secrets set CODEX_AUTH_JSON --from-file "$env:USERPROFILE\.codex\auth.json"
```

Run DarkFactory through Agent OS so it receives the canonical state paths:

```powershell
agents packages run darkfactory -- serve
```

The bot listens on `http://localhost:3000/webhook`. Point the GitHub App webhook URL at your tunnel URL, for example `https://example.ngrok.app/webhook`.

## Scripts

```powershell
npm run typecheck
npm test
npm run build
darkfactory serve
darkfactory install-url
darkfactory sync-managed
darkfactory doctor [owner/repo | --all] [--json]
darkfactory doctor [owner/repo | --all] --write-issues [--json]
df setup [owner/repo | --all] [--watch] [--json] [--local PATH] [--agents-home PATH]
df clean [plan] [owner/repo] [--local PATH] [--json]
df clean apply <plan-id> [--local PATH] [--watch] [--json]
df clean verify [owner/repo] [--local PATH] [--json]
```

## Repository doctor

`darkfactory doctor` reconstructs branch/release state, protections and gates,
open PR health, issue dependencies, managed-file drift, product layout,
submodule pointers, trusted launcher/runner prerequisites, and explicitly
supplied local checkout state. It also checks recent canonical Agent OS worker
sessions for task-clone cwd isolation when `$AGENTS_HOME` is observable.
Machine-local absolute paths, Git stderr, and canonical session IDs are never
serialized into JSON, public findings, or repair issues; those surfaces report
only aggregate violation classes and counts.
Managed `Validate`, `Codex Review`, and future `DarkFactory Autoreview` gates
must use their exact context names and the GitHub Actions producer App ID
`15368`; a same-name check from any other App is critical drift.
Only the exact canonical `marius-patrik/Andromeda-data` and
`marius-patrik/darkfactory-data` repositories use the main-only data policy.
They are exempt from `dev`, release-lane, and product gate expectations, but
their `main` branch must still expose protection with administrator bypass,
force-push, and deletion disabled. Repository names that merely end in
`-data` receive no exemption.

The doctor target token requests only read access to administration, actions,
checks, contents, pull requests, secrets, and statuses; issue access becomes
write only in explicit report mode. Report mode mints a second token restricted
to `darkfactory-data` with contents write for the ledger. The target token is
never a ledger fallback, diagnosis mints no write token, and report mode never
creates or patches repository labels. Missing required labels fail preflight so
the managed taxonomy must be provisioned separately. If Administration: Read is
not granted to the GitHub App, token minting or protection inspection fails
visibly; protection is never inferred from an ambient user token.
Report publication is two-phase: a ledger admission containing the complete
planned issue-action scope must succeed before the first issue mutation, then a
completion ledger records every applied action, including legacy aggregate
retirement. A failed admission makes no issue writes; a failed completion is
surfaced after the durable admission record and is never reported as success.
Only exact DarkFactory App actors (`darkfactory-agent[bot]` and the retained
`mp-agents[bot]` identity) can own reconciled `df-doctor:` issues; generic
`github-actions[bot]` issue text is always treated as untrusted data.

Diagnosis is the default and makes no GitHub writes or repairs. The explicit
`--write-issues` mode reconciles one issue per stable `df-doctor:` finding and
writes a zero-model-token ledger to `marius-patrik/darkfactory-data`. Repair is
intentionally a separate reviewed work item; `--repair` is rejected. The
trusted `DarkFactory Repository Doctor` workflow runs the same engine, uploads
its JSON evidence, and uses report authority only on the schedule or when the
manual `write_issues` input is selected.

## Operator convergence and hygiene

`df setup` runs the same doctor engine, orders the observed delta by lifecycle
stage, and executes only repairs with a narrow trusted implementation. Protected
content stays in reviewed managed-setup or PRD reconciliation workflows;
repository settings are re-read after mutation before a receipt can claim
success. `--watch` re-observes the exact evidence-bound plan, but stops after
two unchanged re-observations instead of repeating writes or polling forever.
The canonical Agent OS state doctor itself must be clean; a successful checkout
probe cannot mask other state-integrity failures. Machine runner lifecycle,
provider-route probing, and canonical data-registry
mutation remain explicit blocked residue until their Agent OS owners (#245,
#260, and #255) expose trusted executors. Setup never improvises those stages.

Readiness is derived from one current managed snapshot: doctor has no findings,
gates are healthy, dependencies and categorical brakes are clear, the issue
contract is executable, and configured capacity is available. `df:ready` is a
machine-owned cache of that result. Setup requests a repository-scoped
evaluation; it never dispatches fleet work itself, and worker dispatch
recomputes the predicate before claiming an issue. Only an exact machine-owned
merge-policy brake may be cleared, and only after the repository is re-proven
healthy. The GitHub-hosted orchestrator cannot infer owner-machine state: it
requires a fresh (at most 26 hours old), identity-bound completion receipt from
the self-hosted repository doctor. Missing, stale, malformed, or unhealthy
machine evidence blocks readiness fleet-wide.

`df clean` is plan-first. The default command reads GitHub plus an explicitly
supplied, origin-verified local checkout and writes a durable plan under
canonical `$AGENTS_HOME`. It enumerates every local ref and worktree, always
preserves the supplied root and detached worktrees, and admits branch deletion
only for exact independently preserved heads. Non-branch refs are deletable
only in the dedicated `refs/df`, `refs/archive`, or `refs/subtree` cleanup
namespaces. Tags, remote-tracking
refs, policy branches, active PR heads, dirty/untracked worktrees, unpublished
commits, and ambiguous work are preserved. `apply` re-collects the full evidence
and aborts on drift; each mutation requires a durable admission before it runs
and a completion receipt afterward. There is no force, bypass, or prune mode.

`df-work.yml` runs only on a trusted self-hosted runner labeled `df-local`. It
requires `$AGENTS_HOME` to be an absolute path containing `bin\agents.ps1`,
invokes that exact launcher for `state doctor --json`, then delegates the worker
turn through the same launcher without provider or model flags. It never falls
back to an ambient `agents` command. Provider selection, identity, memory, and
session state therefore come exclusively from `$AGENTS_HOME`.

`codex-review.yml` is the current external CI execution boundary. It uses an
ephemeral Codex container and repository secret because GitHub-hosted CI cannot
access personal Agent OS state. It does not define a repository model or serve
as local provider authority. This provider-specific gate remains current only
until #36 lands DarkFactory Autoreview; active specs distinguish the current
migration gate from that target.

The review command keeps `--sandbox read-only`. Inside GitHub-hosted Docker it
selects Codex's legacy Landlock backend because the default bubblewrap backend
requires unprivileged user namespaces that the nested container boundary does
not provide. This compatibility switch does not grant Docker capabilities,
disable seccomp, or run a privileged container. The container runs as the host
runner UID/GID so its mode-600 verdict can be copied by the host; the ephemeral
Codex home remains mode 700 and `auth.json` remains mode 600, so neither is
exposed to other users.

## Self-hosted runner ownership

The `df-local` runner is provisioned and supervised by Agent OS, outside this
component. Its service environment must expose the canonical `$AGENTS_HOME`;
DarkFactory binds the worker to `$AGENTS_HOME\bin\agents.ps1` instead of PATH
resolution. DarkFactory intentionally carries no host runner installer, PID
registry, alternate state root, or platform-specific process manager.

## Service operation

Run the webhook service through Agent OS when using the local managed runtime.
DarkFactory keeps operational run ledgers in the separate
`marius-patrik/darkfactory-data` repository; personal memory, sessions,
identity, provider state, and secrets remain under Agent OS `.agents`:

```powershell
agents state doctor
agents packages run darkfactory -- serve
```

Canonical policy/state authority is the root `$AGENTS_HOME` checkout of
`marius-patrik/Andromeda-data`; DarkFactory reads only its
`managed-repository` child. The current managed-sync adapter still accepts the
pre-Andromeda redirected repository and nested checkout contract. That is a
tracked implementation gap, not current policy; #255 migrates the adapter,
workflow, manifest, and documentation together.

The service requires these settings or Agent OS-managed secrets:

- `GITHUB_APP_ID`
- `GITHUB_PRIVATE_KEY`
- `GITHUB_WEBHOOK_SECRET`
- `DARK_FACTORY_CONTROL_REPO`, optional and defaults to `marius-patrik/DarkFactory`
- `PORT`, optional and defaults to `3000`

Use `GET /healthz` as the health check endpoint.

## Managed repository setup

Dark Factory manages shared setup through pull requests. It does not write directly to default branches.

Managed files:

- `.agents/.project/**`, only when `$AGENTS_HOME/managed-repository/repositories/<owner>/<repo>/.agents/.project/**` exists
- `.darkfactory/managed-repository.json`
- `.darkfactory/installer-policy.json`
- `.github/workflows/dark-factory-bootstrap.yml`
- `.github/workflows/dark-factory-autoupdate.yml`
- `.github/workflows/df-plan.yml`
- `.github/workflows/df-follow-through.yml`
- `.github/workflows/df-orchestrate.yml`
- `.github/workflows/df-work.yml`
- `.github/workflows/codex-review.yml`
- `.github/codex-review.Dockerfile`
- `.github/codex-review.schema.json`
- `.github/scripts/run-codex-review.sh`
- `.github/scripts/dark-factory-managed-check.mjs`

Managed setup does not ship `.github/workflows/df-event-forward.yml`. That workflow uses control-repository app secrets and is kept only in `marius-patrik/DarkFactory`.

When the DarkFactory webhook server is deployed, machine-applied `df:ready` labels and trusted `/df run` evaluation requests in any installed repository are dispatched immediately to the orchestrator workflow, eliminating the wait for the next scheduled tick. `/df run` performs the deterministic contract evaluation and reports actionable findings; it never writes `df:ready` directly. Dispatch recomputes readiness, so a stale label cannot authorize work. If the webhook server is not deployed or the dispatch fails, the schedule and workflow-run chaining still pick up the issue.

Managed publication has path-level ownership: this package owns executable
DarkFactory workflows and scripts, while canonical Andromeda-data owns
shared repository policy and context. Duplicate paths fail closed. Keep reusable
repository policy in `managed-repository/.darkfactory/` and
per-repository context in
`managed-repository/repositories/<owner>/<repo>/.agents/.project/`. Shared Agent
OS state remains under `$AGENTS_HOME` and is never copied by DarkFactory.

Managed sync runs automatically when:

- the GitHub App is installed on repositories
- repositories are added to an existing GitHub App installation
- the scheduled `Sync Managed Repositories` workflow runs

Managed sync can also be run manually from the `Sync Managed Repositories` workflow.

GitHub Actions still consumes repository secrets, but those secrets should be written by Agent OS:

```powershell
agents secrets github sync GITHUB_APP_ID --repo marius-patrik/DarkFactory --as DARK_FACTORY_APP_ID
agents secrets github sync GITHUB_PRIVATE_KEY --repo marius-patrik/DarkFactory --as DARK_FACTORY_PRIVATE_KEY
agents secrets github sync CODEX_AUTH_JSON --owner marius-patrik
```

The workflow requires these repository secrets in `marius-patrik/DarkFactory`:

- `DARK_FACTORY_APP_ID`
- `DARK_FACTORY_PRIVATE_KEY`

Every managed repository that should enforce Codex Review also needs this repository secret:

- `CODEX_AUTH_JSON`, containing a Codex OAuth `auth.json`

The local equivalent is:

```powershell
agents packages run darkfactory -- sync-managed
```

To print the GitHub App installation URL from local credentials:

```powershell
npm run install:url
```

## Product and version ownership

DarkFactory owns its repository history, issues, versioning, and releases.
Andromeda may consume a pinned DarkFactory revision as a submodule, and Agent OS
may launch it as an integration, but neither integration transfers product or
release authority away from this repository.

## Development notes

- Keep webhook handlers registered in `src/bot.ts`.
- Keep managed file templates in `$AGENTS_HOME/managed-repository/` (migration tracked by #255).
- Keep managed sync logic in `src/managed-sync.ts`.
- Keep installed-repository setup enforcement in `src/repository-setup.ts`.
- Keep HTTP routing and signature handoff behavior in `src/server.ts`.
- Keep environment parsing in `src/config.ts`.
- Add tests under `tests/` for any new route, config branch, or webhook behavior.
