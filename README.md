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
- Dispatches the orchestrator workflow immediately when an issue is labeled `df:ready` or when an owner/member/collaborator comments `/df run`, providing a low-latency path for managed repositories.
- Installs the managed Codex Review workflow, Dockerfile, runner script, and output schema used to run `codex exec` in a container for pull request review.
- Reads repository-local agent context, `.darkfactory`, and `.github` policy
  files from `marius-patrik/agents-data`.
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
  - Actions: Read and write
  - Contents: Read and write
  - Issues: Read and write
  - Pull requests: Read and write
  - Metadata: Read-only, granted by GitHub automatically

`Contents: Read and write` is required so Dark Factory can create managed setup branches. `Pull requests: Read and write` is required so it can open setup PRs. `Actions: Read and write` is required so the deployed webhook server can dispatch the orchestrator workflow for low-latency `df:ready` and `/df run` handling.

Generate a private key for the app and install the app on the repositories where it should run.

To install the app on every repository, use the GitHub App installation UI and choose all repositories. The user token used by `gh` cannot grant GitHub App repository access by itself.

## Agent OS setup

```powershell
npm ci
npm run build
agents packages register packages/darkfactory
agents data repo path agent-os-data
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
```

`df-work.yml` runs only on a trusted self-hosted runner labeled `df-local`. It
requires `agents state doctor --json` to pass, then delegates the worker turn to
`agents run` without provider or model flags. Provider selection, identity,
memory, and session state therefore come exclusively from `$AGENTS_HOME`.

`codex-review.yml` is the one external CI execution boundary. It uses an
ephemeral Codex container and repository secret because GitHub-hosted CI cannot
access personal Agent OS state. It does not define a repository model or serve
as local provider authority.

## Self-hosted runner ownership

The `df-local` runner is provisioned and supervised by Agent OS, outside this
component. Its service environment must expose the canonical `agents` launcher
and `$AGENTS_HOME`. DarkFactory intentionally carries no host runner installer,
PID registry, alternate state root, or platform-specific process manager.

## Service operation

Run the webhook service through Agent OS when using the local managed runtime.
DarkFactory keeps operational run ledgers in the separate
`marius-patrik/darkfactory-data` repository; personal memory, sessions,
identity, provider state, and secrets remain under Agent OS `.agents`:

```powershell
agents state doctor
agents packages run darkfactory -- serve
```

The service uses the sole `agent-os-data` registration from
`$AGENTS_HOME/data-repos.json`, verifies that it points to
`$AGENTS_ROOT/data/agent-os`, and reads managed policy from its
`managed-repository` child. There is no DarkFactory-specific data root or path
override.

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

- `.agents/.project/**`, only when `$AGENTS_ROOT/data/agent-os/managed-repository/repositories/<owner>/<repo>/.agents/.project/**` exists
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

When the DarkFactory webhook server is deployed, `df:ready` labels and `/df run` comments in any installed repository are dispatched immediately to the orchestrator workflow, eliminating the wait for the next scheduled tick. If the webhook server is not deployed or the dispatch fails, the schedule and workflow-run chaining still pick up the issue.

Managed publication has path-level ownership: this package owns executable
DarkFactory workflows and scripts, while the sole `agent-os-data` checkout owns
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
- Keep managed file templates in `$AGENTS_ROOT/data/agent-os/managed-repository/`.
- Keep managed sync logic in `src/managed-sync.ts`.
- Keep installed-repository setup enforcement in `src/repository-setup.ts`.
- Keep HTTP routing and signature handoff behavior in `src/server.ts`.
- Keep environment parsing in `src/config.ts`.
- Add tests under `tests/` for any new route, config branch, or webhook behavior.
