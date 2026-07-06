# template-bot

TypeScript GitHub App bot template for webhook-driven repository automation.

## What it includes

- `POST /webhook` for GitHub App webhooks.
- `GET /healthz` for deploy and uptime checks.
- Signature verification through `@octokit/app`.
- Example handlers for `ping`, newly opened issues, and newly opened pull requests.
- Tests, CI, Docker config, and production-oriented setup docs.

## Use this template

After creating a bot from this template, replace:

- package name in `package.json`
- README title and behavior summary
- placeholder webhook handlers in `src/bot.ts`
- GitHub App permissions and subscribed events as your bot needs change

## Requirements

- Node.js 22 or newer.
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
  - Issues: Read and write
  - Pull requests: Read-only
  - Metadata: Read-only, granted by GitHub automatically

Generate a private key for the app and install the app on the repositories where it should run.

## Local setup

```powershell
npm ci
Copy-Item .env.example .env
```

Fill in `.env`:

```dotenv
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
GITHUB_WEBHOOK_SECRET=change-me
PORT=3000
```

Start the development server:

```powershell
npm run dev
```

The bot listens on `http://localhost:3000/webhook`. Point the GitHub App webhook URL at your tunnel URL, for example `https://example.ngrok.app/webhook`.

## Scripts

```powershell
npm run typecheck
npm test
npm run build
npm start
```

## Deployment

Build and run with Docker:

```powershell
docker build -t template-bot .
docker run --rm -p 3000:3000 --env-file .env template-bot
```

Production hosts must provide these environment variables:

- `GITHUB_APP_ID`
- `GITHUB_PRIVATE_KEY`
- `GITHUB_WEBHOOK_SECRET`
- `PORT`, optional and defaults to `3000`

Use `GET /healthz` as the health check endpoint.

## Development notes

- Keep webhook handlers registered in `src/bot.ts`.
- Keep HTTP routing and signature handoff behavior in `src/server.ts`.
- Keep environment parsing in `src/config.ts`.
- Add tests under `tests/` for any new route, config branch, or webhook behavior.
