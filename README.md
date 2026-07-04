# agent-darkfactory

TypeScript GitHub App bot that receives GitHub webhooks, verifies signatures, and responds to basic repository activity.

## What it does

- Exposes `POST /webhook` for GitHub App webhooks.
- Exposes `GET /healthz` for deploy and uptime checks.
- Logs GitHub App `ping` events.
- Comments on newly opened issues.
- Comments on newly opened pull requests.
- Checks pull requests in installed repositories for shared repository setup:
  - `.agents/.global/VERSION` must match the current Dark Factory version.
  - DarkFactory installer, auto-update, release, and review workflows should exist as the baseline GitHub Actions scaffold.
- Installs the managed Codex Review workflow, Dockerfile, runner script, and output schema used to run `codex exec` in a container for pull request review.
- Reads managed `.agents`, `.darkfactory`, and `.github` files from the `agentos-data` repository.
- Opens managed setup PRs when the app is installed on a repository or when repositories are added to an installation.
- Can sync all installed repositories from the `Sync Managed Repositories` workflow.

## Requirements

- Node.js 22 or newer.
- Agentos shared state for managed secrets and workspace paths.
- A GitHub App installed on the target repositories.
- A public HTTPS URL for local webhook testing, such as an ngrok or Cloudflare Tunnel URL.

## GitHub App setup

Create a GitHub App and configure:

- Webhook URL: `https://<your-public-host>/webhook`
- Webhook secret: any high-entropy random value, also used as `GITHUB_WEBHOOK_SECRET`
- Subscribe to events:
  - `Issues`
  - `Pull requests`
  - `Ping`
- Repository permissions:
  - Contents: Read and write
  - Issues: Read and write
  - Pull requests: Read and write
  - Metadata: Read-only, granted by GitHub automatically

`Contents: Read and write` is required so Dark Factory can create managed setup branches. `Pull requests: Read and write` is required so it can open setup PRs.

Generate a private key for the app and install the app on the repositories where it should run.

To install the app on every repository, use the GitHub App installation UI and choose all repositories. The user token used by `gh` cannot grant GitHub App repository access by itself.

## Agentos setup

```powershell
npm ci
npm run build
agents packages register workspaces/workspace-darkfactory
agents packages register agents/agent-darkfactory
agents data repo path workspace-darkfactory
```

Store local secrets through Agentos. Secret values are not printed by the manager:

```powershell
agents secrets set GITHUB_APP_ID
agents secrets set GITHUB_PRIVATE_KEY
agents secrets set GITHUB_WEBHOOK_SECRET
agents secrets set CODEX_AUTH_JSON --from-file "$env:USERPROFILE\.codex\auth.json"
```

Run DarkFactory through Agentos so it receives `AGENTS_SECRETS` and the other shared state paths:

```powershell
agents packages run agent-darkfactory -- serve
```

The bot listens on `http://localhost:3000/webhook`. Point the GitHub App webhook URL at your tunnel URL, for example `https://example.ngrok.app/webhook`.

## Scripts

```powershell
npm run typecheck
npm test
npm run build
df runners status
darkfactory serve
darkfactory install-url
darkfactory sync-managed
```

## Self-hosted runner manager

DarkFactory can install and supervise per-repository GitHub Actions runners on the local Windows host. The manager uses per-repo runners because personal GitHub accounts cannot attach one runner to every repository. Each runner is named `df-<repo>`, receives the `df-local` label, and is configured without `--runasservice` so it does not require elevation.

The default root is:

```text
C:/Users/patrik/.darkfactory/runners
```

Override it per command with `--root <path>` or by setting `DF_RUNNER_ROOT`. Runtime state is stored in `state.json` under that root. Registration and removal tokens are fetched from GitHub when needed and are not written to state.

```powershell
df runners setup marius-patrik/agent-darkfactory
df runners setup marius-patrik/dream
df runners status
df runners stop marius-patrik/dream
df runners start marius-patrik/dream
df runners remove marius-patrik/dream
```

`setup` downloads the latest Windows x64 `actions/runner` package into the shared `_cache` directory, extracts it to the per-repo runner directory, runs `config.cmd` unattended with `--labels df-local`, starts `run.cmd` as a detached background process, and records the PID. `status` combines local PID state with `gh api repos/<owner>/<repo>/actions/runners` so online/offline evidence comes from GitHub.

Do not run the manager from an elevated prompt and do not add `--runasservice`; service installation requires UAC and is intentionally out of scope for the local pilot.

## Deployment

Build and run with Docker:

```powershell
git clone https://github.com/marius-patrik/data-agentos.git agentos-data
docker build -t agent-darkfactory .
docker run --rm -p 3000:3000 --env-file .env agent-darkfactory
```

Production hosts must provide these environment variables:

- `GITHUB_APP_ID`
- `GITHUB_PRIVATE_KEY`
- `GITHUB_WEBHOOK_SECRET`
- `DARK_FACTORY_WORKSPACE_ROOT`, optional when the image bundles `agentos-data/managed-repository`
- `PORT`, optional and defaults to `3000`

Use `GET /healthz` as the health check endpoint.

## Managed repository setup

Dark Factory manages shared setup through pull requests. It does not write directly to default branches.

Managed files:

- `.agents/.global/**`
- `.agents/.project/**`, only when `agentos-data/managed-repository/repositories/<owner>/<repo>/.agents/.project/**` exists
- `.darkfactory/managed-repository.json`
- `.darkfactory/installer-policy.json`
- `.darkfactory/release-policy.json`
- `.github/workflows/dark-factory-bootstrap.yml`
- `.github/workflows/dark-factory-autoupdate.yml`
- `.github/workflows/dark-factory-release.yml`
- `.github/workflows/codex-review.yml`
- `.github/codex-review.Dockerfile`
- `.github/codex-review.schema.json`
- `.github/scripts/run-codex-review.sh`
- `.github/scripts/dark-factory-release-check.mjs`

The `agentos-data` repository is the single source of truth for managed setup. Keep reusable policy in `managed-repository/.agents/.global/` and `managed-repository/.darkfactory/`, and per-repository context in `managed-repository/repositories/<owner>/<repo>/.agents/.project/`.

Managed sync runs automatically when:

- the GitHub App is installed on repositories
- repositories are added to an existing GitHub App installation
- the scheduled `Sync Managed Repositories` workflow runs
- a DarkFactory release is published

Managed sync can also be run manually from the `Sync Managed Repositories` workflow.

GitHub Actions still consumes repository secrets, but those secrets should be written by Agentos Manager:

```powershell
agents secrets github sync GITHUB_APP_ID --repo marius-patrik/agent-darkfactory --as DARK_FACTORY_APP_ID
agents secrets github sync GITHUB_PRIVATE_KEY --repo marius-patrik/agent-darkfactory --as DARK_FACTORY_PRIVATE_KEY
agents secrets github sync CODEX_AUTH_JSON --owner marius-patrik
```

The workflow requires these repository secrets in `marius-patrik/agent-darkfactory`:

- `DARK_FACTORY_APP_ID`
- `DARK_FACTORY_PRIVATE_KEY`

Every managed repository that should enforce Codex Review also needs this repository secret:

- `CODEX_AUTH_JSON`, containing a Codex OAuth `auth.json`

The local equivalent is:

```powershell
agents packages run agent-darkfactory -- sync-managed
```

To print the GitHub App installation URL from local credentials:

```powershell
npm run install:url
```

## Release

Releases are tag-driven. To publish a release:

```powershell
npm version patch
git push origin main --follow-tags
```

Pushing a `v*.*.*` tag runs the release workflow. It validates the repo, builds the Docker image, publishes it to GitHub Container Registry, and creates a GitHub release.

Image tags are published under:

```text
ghcr.io/marius-patrik/agent-darkfactory
```

## Development notes

- Keep webhook handlers registered in `src/bot.ts`.
- Keep managed file templates in `agentos-data/managed-repository/`.
- Keep managed sync logic in `src/managed-sync.ts`.
- Keep installed-repository setup enforcement in `src/repository-setup.ts`.
- Keep HTTP routing and signature handoff behavior in `src/server.ts`.
- Keep environment parsing in `src/config.ts`.
- Add tests under `tests/` for any new route, config branch, or webhook behavior.

