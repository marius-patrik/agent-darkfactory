# OKF Knowledge Agent

An LLM-managed knowledge base following the [Open Knowledge Format (OKF) v0.1 spec](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) — a bundle of plain markdown files with YAML frontmatter, readable by humans, diffable in git, managed by an agent.

**Three ways in, one agent:**

- **MCP server** — `kb_query` / `kb_add` / `kb_update` / `kb_status` tools over stdio or streamable HTTP. Each call drives an internal LLM agent with the OKF spec in its system prompt.
- **Web UI** — browse the bundle (tree, concept viewer, update log, conformance badge) and chat with the same agent to test it. Tool calls render inline so you can watch it work.
- **CLI** — `pnpm agent:query "..."` / `pnpm agent:mutate "..."` smoke entries.

**Design rule: conformance is enforced in code, not prompts.** The deterministic bundle layer validates frontmatter (`type` required), regenerates `index.md` files, appends `log.md` entries (newest-first, spec §7), and sandboxes all paths to the bundle root. The LLM decides *what* to change; the code guarantees the result is a conformant bundle.

## Stack

pnpm monorepo:

| Package | What |
|---|---|
| `packages/core` | OKF bundle layer (zero LLM) + agent (Vercel AI SDK tool loop: search/read/list/write/patch/delete) + provider registry |
| `packages/server` | Fastify: MCP streamable-HTTP at `/mcp`, stdio bin, REST browse API at `/api/*`, streaming chat at `/api/chat`, serves the web build |
| `packages/web` | Vite + React + TS + Tailwind: bundle browser + agent chat (`useChat`) |

Providers (env-selected, swappable per chat): **Anthropic** (default), **OpenRouter**, **llamacpp** (llama.cpp `llama-server` / llama-swap — model auto-discovered from `/v1/models`, loaded model preferred), **local** (any other OpenAI-compatible endpoint).

### llama.cpp

```bash
# on the inference box — --jinja enables OpenAI-style tool calling
llama-server -m model.gguf --jinja --host 0.0.0.0 --port 8080

# here — no model id needed, it's discovered
LLM_PROVIDER=llamacpp LLAMACPP_BASE_URL=http://inference-box:8080 \
BUNDLE_ROOT=./sample-bundle node packages/server/dist/index.js
```

Works behind llama-swap too: discovery prefers the currently **loaded** model so a query doesn't trigger a multi-minute model swap. Pin a specific model with `LLM_MODEL=`.

## Quick start

```bash
pnpm install
pnpm build
cp .env.example .env   # add your API key

BUNDLE_ROOT=./sample-bundle ANTHROPIC_API_KEY=sk-... node packages/server/dist/index.js
# → http://localhost:3800  (web UI + /api + /mcp)
```

Dev mode (server on :3800, Vite HMR on :5180 with proxy):

```bash
BUNDLE_ROOT=./sample-bundle pnpm --filter @okf-agent/server dev
pnpm --filter @okf-agent/web dev
```

## MCP registration (Claude Code / Desktop)

```bash
claude mcp add okf-kb \
  -e BUNDLE_ROOT=/path/to/your/bundle \
  -e ANTHROPIC_API_KEY=sk-... \
  -- node /path/to/okf-agent/packages/server/dist/mcp/stdio.js
```

Or point an HTTP MCP client at `http://host:3800/mcp`.

## Docker

```bash
docker compose up --build
# bundle is a volume mount — point ./sample-bundle at any OKF bundle
```

## Tests

```bash
pnpm test                                  # core: 15 tests (spec §5/§6/§7/§9, sandbox, search, concurrency)
pnpm --filter @okf-agent/server exec tsx scripts/mcp-smoke.mts   # MCP stdio round-trip (needs SMOKE_BUNDLE + an API key)
```

## Environment

See [.env.example](.env.example). `BUNDLE_ROOT` is required; `GIT_AUTOCOMMIT=true` commits every mutation.
