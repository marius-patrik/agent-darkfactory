#!/usr/bin/env bash
# Dev launcher: loads LLM keys from ~/Claude/.secrets and serves the bundle.
# BUNDLE_ROOT can be overridden; defaults to the repo's sample-bundle.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"

if [ -f "$HOME/Claude/.secrets/openrouter.json" ] && [ -z "${OPENROUTER_API_KEY:-}" ]; then
  export OPENROUTER_API_KEY=$(python3 -c "import json;d=json.load(open('$HOME/Claude/.secrets/openrouter.json'));print(d.get('OPENROUTER_API_KEY') or d.get('api_key') or list(d.values())[0])")
  export LLM_PROVIDER="${LLM_PROVIDER:-openrouter}"
  export LLM_MODEL="${LLM_MODEL:-anthropic/claude-sonnet-5}"
fi

# Homelab llama-server (cortex) — enables the llamacpp provider in the UI picker.
export LLAMACPP_BASE_URL="${LLAMACPP_BASE_URL:-http://192.168.1.101:8080}"

export BUNDLE_ROOT="${BUNDLE_ROOT:-$REPO/sample-bundle}"
export PORT="${PORT:-3800}"
exec node "$REPO/packages/server/dist/index.js"
