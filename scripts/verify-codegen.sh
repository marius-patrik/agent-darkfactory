#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CORE="$ROOT/src/migrate/core"
BUF="$ROOT/node_modules/.bin/buf"
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT

[ -x "$BUF" ] || {
  echo "error: pinned Buf executable is missing; run bun install --frozen-lockfile" >&2
  exit 1
}
[ "$($BUF --version)" = "1.71.0" ] || {
  echo "error: Buf must be exactly 1.71.0" >&2
  exit 1
}

outputs=(
  "src/migrate/core/contracts-go/gen"
  "src/migrate/core/clients/shared-ts/src/gen"
  "src/migrate/inference/python-agent/agent/gen"
)

for relative in "${outputs[@]}"; do
  [ -d "$ROOT/$relative" ] || {
    echo "error: generated output is missing: $relative" >&2
    exit 1
  }
  mkdir -p "$TEMP/before/$(dirname "$relative")"
  cp -R "$ROOT/$relative" "$TEMP/before/$relative"
done

(
  cd "$CORE"
  "$BUF" format --diff --exit-code proto
  "$BUF" lint proto
  "$BUF" generate proto
  "$BUF" generate proto --template buf.gen.python.yaml
)

for relative in "${outputs[@]}"; do
  diff -ru "$TEMP/before/$relative" "$ROOT/$relative"
done

if find \
  "$CORE/proto" \
  "$CORE/contracts-go/gen" \
  "$CORE/clients/shared-ts/src/gen" \
  "$ROOT/src/migrate/inference/python-agent/agent/gen" \
  -type f -o -type d | grep -E '/rommie(/|$)' >/dev/null; then
  echo "error: retired rommie wire namespace remains in generated contracts" >&2
  exit 1
fi

echo "Agent OS code generation is current."
