# vibe-bot

TypeScript GitHub App bot template.

## Setup

1. Create a GitHub App and subscribe it to `issues`, `pull_request`, and `ping` events.
2. Copy `.env.example` to `.env`.
3. Fill in the app ID, private key, and webhook secret.
4. Install dependencies and start the webhook server.

```powershell
npm install
npm run dev
```

The server listens on `POST /webhook`.

