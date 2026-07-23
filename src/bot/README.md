# DarkFactory

DarkFactory is a separate GitHub-native autonomous engineering product. It
receives GitHub webhooks, verifies signatures, synchronizes repository policy,
and runs deterministic planning and orchestration loops. Agent OS is an
integration dependency for local provider execution and shared personal state,
not DarkFactory's product or release owner.

The versioned `.darkfactory/trigger-policy.json` is the single cadence and
idempotency contract for automated development loops. It records each event,
schedule fallback, maximum detection latency, trusted source ref, stable
idempotency key, model-token policy, mutation authority, receipt gate, retry
budget, and owner escalation. Active workflow schedules are checked against the
policy, while dependency-owned future loops remain explicitly `planned` rather
than being reported as live. The orchestration dashboard projects last success,
next expected run, trusted source, stale-loop warnings, and exact retry or
escalation state from Actions evidence.

## What it does

- Exposes `POST /webhook` for GitHub App webhooks.
- Exposes `GET /healthz` for deploy and uptime checks.
- Logs GitHub App `ping` events.
- Comments on newly opened issues.
- Comments on newly opened pull requests.
- Checks pull requests in installed repositories for the current DarkFactory
  policy and workflow scaffold.
- Dispatches the orchestrator workflow immediately when the machine evaluator labels an issue `df:ready`; an owner/member/collaborator can comment `/df run` to request immediate evaluation, never to force readiness.
- Forwards merged `dev` pull-request identities to the protected control workflow;
  DarkFactory re-fetches and verifies the managed repository, exact merge commit,
  and worker provenance before closing referenced issues, with scheduled recovery.
- Installs provider-agnostic DarkFactory Autoreview through canonical Agent OS:
  bounded medium review/fix rounds followed by an independent clean high confirmation.
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

`Contents: Read and write` is required so Dark Factory can create managed setup branches. `Pull requests: Read and write` is required so it can open setup PRs. `Actions: Read and write` is required so the deployed webhook server can dispatch protected control workflows for low-latency `df:ready`, `/df run`, and trusted dev-merge closure handling.

Generate a private key for the app and install the app on the repositories where it should run.

To install the app on every repository, use the GitHub App installation UI and choose all repositories. The user token used by `gh` cannot grant GitHub App repository access by itself.

## Agent OS setup

```powershell
npm ci
npm run build
agents packages register src/darkfactory
agents state doctor
```

Store local secrets through Agent OS. Secret values are not printed by the manager:

```powershell
agents secrets set GITHUB_APP_ID
agents secrets set GITHUB_PRIVATE_KEY
agents secrets set GITHUB_WEBHOOK_SECRET
```

Provider authentication is owned and verified by canonical Agent OS state; it
is never copied into DarkFactory secrets or repository configuration.

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
df serve
df install-url
df baseline sync owner/repo
df doctor [owner/repo | --all] [--json]
df doctor [owner/repo | --all] --write-issues [--json]
df setup [owner/repo | --all] [--watch] [--json] [--local PATH] [--agents-home PATH]
df clean [plan] [owner/repo] [--local PATH] [--json]
df clean apply <plan-id> [--local PATH] [--watch] [--json]
df clean verify [owner/repo] [--local PATH] [--json]
df release [status|plan|reconcile|run|verify] [owner/repo] [--watch] [--json]
df help issue draft
```

`df` is the canonical human executable. `darkfactory` is a compatibility binary
backed by the same parser, command registry, help, and implementation. Every
orchestration command that exposes `--json` uses the same versioned envelope;
dedicated help covers defaults, model tier versus effort, permissions,
mutations, trust boundaries, examples, and non-zero failure semantics.

## Human development CLI

The command surface follows the complete software-development lane:

- `df doctor|setup|clean` with explicit plan/apply/verify cleanup stages;
- `df repo init|doctor|sync|status` and `df baseline status|sync|verify`; `repo init`
  is the exact-target alias of the full `setup` convergence engine, while
  `repo sync` remains the narrower reviewed managed-baseline operation;
- `df issue draft|review|fix|ready|ask` and `df lane pause|resume`;
- `df plan|streams|dashboard`, `df work|resume|verify`, and
  `df pr review|fix|status|merge`;
- `df release status|plan|reconcile|run|verify` and
  `df submodules status|update|verify`;
- `df explain` (`df why`), `df runs list|show|watch|retry`,
  `df receipts list|show|verify`, `df runners status`, and `df logs`.

Release and submodule verbs are thin CLI adapters to their single
purpose-specific convergence engines; the CLI does not duplicate those state
machines.

Safe defaults are binding: `df doctor` is read-only unless
`--write-issues` is explicit, `df clean` means `df clean plan`, and bare
`df release` means `df release status`. Deterministic commands consume zero
model tokens and reject model-selection flags. There is no user-facing force,
prune, target-guessing review, or bypass command.

`df issue draft [owner/repo]` gathers goal, evidence, scope, non-goals,
acceptance, dependencies, trust and failure boundaries, validation, rollout,
and owner decisions. The versioned prompt composer fixes model tier to `high`;
`--effort` is an independent input. The result is written atomically under the
canonical Agent OS runtime (or an explicit `--draft` path), reviewed and
autofixed by the same bounded issue Autoreview engine used by Actions, and kept
local until the human types or supplies the exact reviewed SHA-256 digest.
If the drafter needs an owner decision, it records the current questions and a
SHA-256 conversation version instead of flattening the exchange into a failed
questionnaire. Continue that exact state interactively with
`df issue draft --draft <local-draft> --continue <conversation-version>`, or
provide `--answers <file>` containing schema-versioned exact question/answer
pairs for JSON automation. A continuation is serialized against publication,
rejects stale, mismatched, or concurrently changed questions, appends the full
turn and owner-answer history, reruns the fixed high drafting tier, and clears
all prior review evidence. Publication therefore still requires a fresh
medium-to-clean review and independent high confirmation of the replacement
draft.
Publication has a durable admission receipt, is idempotent by draft ID, and
creates one issue only when the clean high confirmation and current digest
still agree. Policy `1.0.0` reminds the owner after 72 hours and expires review
evidence after 168 hours. The trusted-main `df-local` hygiene workflow scans
only the bounded canonical `$ANDROMEDA_HOME/runtime/darkfactory/drafts` inventory,
writes immutable local lifecycle receipts, and publishes a sanitized Actions
summary/artifact with zero model tokens; it never drafts, deletes, or publishes
content. An expired draft is publication-ineligible until the owner explicitly
runs `df issue draft --draft <local-draft> --resume`, which preserves the draft
content, discards stale review evidence, and requires a fresh high confirmation.
Explicit draft paths outside the canonical inventory still expire at
publication admission but do not receive scheduled reminders. Unresolved owner
questions, provider or receipt failure, malformed output, stale state, or a
concurrent edit leaves the draft unpublished.

Existing issue review uses the exact target version:

```powershell
df issue review marius-patrik/DarkFactory#39 --version <issue-sha256>
df issue ready marius-patrik/DarkFactory#39 --version <issue-sha256>
```

`issue review` and `issue fix` invoke the shared medium-to-clean then independent
high-confirmation protocol through canonical Agent OS. `issue ready` is a
read-only machine evaluation and never writes `df:ready`; the evaluator owns
that label.

## Repository doctor

`darkfactory doctor` reconstructs branch/release state, protections and gates,
open PR health, issue dependencies, managed-file drift, product layout,
submodule pointers, trusted launcher/runner prerequisites, and explicitly
supplied local checkout state. It also checks recent canonical Agent OS worker
sessions for task-clone cwd isolation when `$ANDROMEDA_HOME` is observable.
Machine-local absolute paths, Git stderr, and canonical session IDs are never
serialized into JSON, public findings, or repair issues; those surfaces report
only aggregate violation classes and counts.
Managed `Validate` and `DarkFactory Autoreview` gates
must use their exact context names and the GitHub Actions producer App ID
`15368`; a same-name check from any other App is critical drift.
Only the exact canonical `marius-patrik/Andromeda-data` and
`marius-patrik/darkfactory-data` repositories use the main-only data policy.
They are exempt from `dev`, release-lane, and product gate expectations, but
their `main` branch must still expose protection with administrator bypass,
force-push, and deletion disabled. For these two private repositories only,
GitHub's exact plan-upgrade HTTP 403 is retained as structured
`accepted_residue`, never as healthy protection. The compensating admission
control is [Andromeda PR #190](https://github.com/marius-patrik/Andromeda/pull/190):
encrypted bundles are admitted and plaintext state is rejected. A generic 403,
404, public visibility, wrong repository or branch, malformed policy, or
observable unsafe protection remains a fail-closed doctor finding. Repository
names that merely end in `-data` receive no exemption.

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
success. `--watch` re-observes the exact evidence-bound plan and suppresses
duplicate dispatches while asynchronous reviewed setup, planning, and release
lanes settle; unchanged synchronous evidence stops boundedly, while admitted
asynchronous work remains observable through the configured pass limit.
The canonical Agent OS state doctor itself must be clean; a successful checkout
probe cannot mask other state-integrity failures. Repairable package binding and
runner lifecycle findings execute only through the exact `$ANDROMEDA_HOME`
launcher, then re-prove the installed command, registration, online state,
persistence, and launcher binding. Unsafe state-root, launcher, route, or data
authority findings remain blocked. An observable unregistered repository is
added only through one reviewed Andromeda-data source-policy PR; parked or
archived entries are immutable brakes, and an absent App installation becomes
an explicit owner finding with the exact `df install-url` action.
Because private main-only Andromeda-data has the documented plan-upgrade 403
instead of enforceable branch protection and repository auto-merge, setup
completes its exact App-owned registration PR through an application-enforced
gate: the current provenance-bound head must have no red or pending latest
checks, and both `Validate` and `DarkFactory Autoreview` must be green from the
GitHub Actions App (`15368`); `Codex Review` is never an admissible substitute.
Setup then performs an
SHA-bound squash merge and re-proves the App merge actor, ancestry, and exact
active registry entry before dispatching managed sync; it has no bypass path.

For a fresh repository, setup first creates only an empty `main` foundation.
The managed baseline then lands through a same-repository setup PR protected by
the temporary exact Actions-app `Managed setup` gate and GitHub auto-merge.
Only after that reviewed bootstrap lands does setup create `dev`, replace the
temporary gate with exact `Validate` plus `DarkFactory Autoreview`, scaffold the
PRD on `dev`, cut the issue lane, and delegate dev-to-main convergence to the
trusted release engine. No direct protected-branch write or bypass is used.

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
canonical `$ANDROMEDA_HOME`. It enumerates every local ref and worktree, always
preserves the supplied root and detached worktrees, and admits branch deletion
only for exact independently preserved heads. Non-branch refs are deletable
only in the dedicated `refs/df`, `refs/archive`, or `refs/subtree` cleanup
namespaces. Tags, remote-tracking
refs, policy branches, active PR heads, dirty/untracked worktrees, unpublished
commits, and ambiguous work are preserved. `apply` re-collects the full evidence
and aborts on drift; each mutation requires a durable admission before it runs
and a completion receipt afterward. There is no force, bypass, or prune mode.
Remote branch deletion additionally requires `--local` and uses an atomic Git
transport lease bound to the exact admitted head, followed by absence
confirmation. A concurrent branch advance rejects the lease and preserves the
branch; the GitHub check-then-delete REST race is never used.

`df release` is status-only by default. `plan` classifies exact `main`/`dev`
ancestry and declared release policy without writing. `reconcile` creates one
marker-owned reviewed lane for diverged state; conflicts that GitHub cannot
merge are escalated with bounded exact diff hunks instead of a guessed
resolution. The selected invariant is PR-only convergence: different merge
commit identities are converged only when their Git trees are exactly equal and
trusted, gated release or reconciliation PR ancestry proves how each protected
branch arrived there. Main-ahead state therefore reconciles through a normal PR
to `dev`; missing `dev` alone fails closed with an App-owned `df:ask-owner`
issue because GitHub cannot open a PR against a nonexistent base branch. `run`
creates or resumes `release/<dev-sha>` and arms
automerge only after current app-bound Validate and clean high-confirmed
DarkFactory Autoreview gates. `verify` proves green main CI, release-PR evidence,
linked issue closure, exact main/dev tree identity, branch protections, and declared
tag/artifact/publication policy, then emits the receipt consumed by submodule
autoupdate. GitHub's configured atomic delete-on-merge owns automation-branch
cleanup; DarkFactory verifies trusted release and reconciliation branches are
absent and never sends a branch-deletion request. `--watch`
re-observes the same marker-owned lane and adds no force, bypass, or merge power.

`df-work.yml` runs only on a trusted self-hosted runner labeled `df-local`. It
requires `$ANDROMEDA_HOME` to be an absolute path containing `bin\agents.ps1`,
invokes that exact launcher for `state doctor --json`, then delegates the worker
turn through the same launcher without provider or model flags. It never falls
back to an ambient `agents` command. Provider selection, identity, memory, and
session state therefore come exclusively from `$ANDROMEDA_HOME`.

Every worker turn is assembled by the versioned `prompts/` composer from the
logical worker profile, independently authorized tier and effort, immutable
policy, verified live state, repository-type overlay, delimited issue data,
validation lane, and output contract. The hand-built task-brief and summary
scratch files are retired. A malformed result or missing/stale input blocks
before DarkFactory publishes a branch.

`darkfactory-autoreview.yml` is base-trusted and runs only on the trusted
`df-local` runner. The base-trusted workflow checks out protected
`marius-patrik/DarkFactory@main` as its control runtime and records the resolved
commit before composing a turn; it never loads the composer, prompts, or runner
from the pull-request head. It invokes `$ANDROMEDA_HOME\bin\agents.ps1`; repository
workflows never select providers, models, homes, or credentials. Pull-request
and issue content is serialized as bounded untrusted prompt data into an empty
turn workspace. Review turns are read-only and never checkout or execute target
hooks, scripts, builds, tests, or image inputs. Autofix turns return strict
hash-bound whole-file proposals; the trusted runner applies them only after a
fresh same-repository/provenance/base/head check and a normal non-force push.
Existing tests and `.agents`, `.darkfactory`, `.github`, `AGENTS.md`, and package
control files are protected from autofix. Validation remains a separate gate.

The protocol records the exact control revision, prompt manifest and contract
version/checksum, composed prompt and input checksums, role, skills, tier,
effort, overlays, output schema, resolved provider/model/preset, complete
finding set, usage, and fix version in
`marius-patrik/darkfactory-data`. Missing/malformed verdicts, stale targets,
provider failures, receipt failures, and exhausted medium/high budgets block
closed. Issue mutation preserves an owner-text/history section and re-fetches
the selected issue immediately before writing. Only an exact owner-authored
`/df autoreview override` comment can supply the separate auditable override.

## Self-hosted runner ownership

The `df-local` runner is provisioned and supervised by Agent OS, outside this
component. Its service environment must expose the canonical `$ANDROMEDA_HOME`;
DarkFactory binds the worker to `$ANDROMEDA_HOME\bin\agents.ps1` instead of PATH
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

Canonical policy/state authority is the root `$ANDROMEDA_HOME` checkout of
`marius-patrik/Andromeda-data`; DarkFactory reads only its
`managed-repository` child. The managed-sync adapter requires exactly one
`agent-os-data` registry authority at `$ANDROMEDA_HOME`, bound to
`marius-patrik/Andromeda-data`; unrelated data-repository registrations remain
valid and the separate `marius-patrik/darkfactory-data` checkout remains the
operational ledger authority.

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

- `.agents/project/**`, only when `$ANDROMEDA_HOME/managed-repository/repositories/<owner>/<repo>/.agents/project/**` exists
- `.darkfactory/managed-repository.json`
- `.darkfactory/installer-policy.json`
- `.github/workflows/dark-factory-bootstrap.yml`
- `.github/workflows/dark-factory-autoupdate.yml`
- `.github/workflows/df-plan.yml`
- `.github/workflows/df-follow-through.yml`
- `.github/workflows/df-orchestrate.yml`
- `.github/workflows/df-work.yml`
- `.github/workflows/darkfactory-autoreview.yml`
- `.github/darkfactory-autoreview.schema.json`
- `.github/scripts/df-autoreview.mjs`
- `.github/scripts/run-darkfactory-autoreview.mjs`
- `.darkfactory/autoreview-policy.json`
- `.github/scripts/dark-factory-managed-check.mjs`

Managed setup does not ship `.github/workflows/df-event-forward.yml`. That workflow uses control-repository app secrets and is kept only in `marius-patrik/DarkFactory`.

When the DarkFactory webhook server is deployed, machine-applied `df:ready` labels and trusted `/df run` evaluation requests in any installed repository are dispatched immediately to the orchestrator workflow, eliminating the wait for the next scheduled tick. `/df run` performs the deterministic contract evaluation and reports actionable findings; it never writes `df:ready` directly. Dispatch recomputes readiness, so a stale label cannot authorize work. If the webhook server is not deployed or the dispatch fails, the schedule and workflow-run chaining still pick up the issue.

Managed publication has path-level ownership: this package owns executable
DarkFactory workflows and scripts, while canonical Andromeda-data owns
shared repository policy and context. Duplicate paths fail closed. Keep reusable
repository policy in `managed-repository/.darkfactory/` and
per-repository context in
`managed-repository/repositories/<owner>/<repo>/.agents/project/`. Shared Agent
OS state remains under `$ANDROMEDA_HOME` and is never copied by DarkFactory.

Managed sync runs automatically when:

- the GitHub App is installed on repositories
- repositories are added to an existing GitHub App installation
- the scheduled `Sync Managed Repositories` workflow runs

Managed sync can also be run manually from the `Sync Managed Repositories` workflow.

GitHub Actions still consumes repository secrets, but those secrets should be written by Agent OS:

```powershell
agents secrets github sync GITHUB_APP_ID --repo marius-patrik/DarkFactory --as DARK_FACTORY_APP_ID
agents secrets github sync GITHUB_PRIVATE_KEY --repo marius-patrik/DarkFactory --as DARK_FACTORY_PRIVATE_KEY
```

The workflow requires these repository secrets in `marius-patrik/DarkFactory`:

- `DARK_FACTORY_APP_ID`
- `DARK_FACTORY_PRIVATE_KEY`

Managed repositories do not receive provider credentials. Autoreview submits
only logical tier and effort requests through canonical Agent OS state on
`df-local`; Agent OS exclusively resolves provider, model, authentication, and
any policy-authorized pre-turn fallback. Only the DarkFactory App installation
credentials are repository-managed.

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
- Keep managed file templates in canonical `$ANDROMEDA_HOME/managed-repository/`; keep runtime ledgers in darkfactory-data.
- Keep managed sync logic in `src/managed-sync.ts`.
- Keep installed-repository setup enforcement in `src/repository-setup.ts`.
- Keep HTTP routing and signature handoff behavior in `src/server.ts`.
- Keep environment parsing in `src/config.ts`.
- Add tests under `tests/` for any new route, config branch, or webhook behavior.
