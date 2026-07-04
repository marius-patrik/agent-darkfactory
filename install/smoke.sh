#!/usr/bin/env bash
set -euo pipefail

# Smoke test for the agents CLI installer.
# Verifies that the linked `agents` command is on PATH and resolves to this
# checkout's `os/agents-manager/src/cli.ts`, then runs fast CLI commands
# (`agents state init` and `agents list`).

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EXPECTED_SCRIPT="$ROOT_DIR/os/agents-manager/src/cli.ts"

if ! command -v agents >/dev/null 2>&1; then
  echo "error: agents command not found on PATH" >&2
  exit 1
fi

AGENTS_PATH="$(command -v agents)"
RESOLVED=""

# Portable symlink resolution for Linux/macOS.
resolve_link() {
  local path="$1"
  while [ -L "$path" ]; do
    local target
    target="$(readlink "$path")"
    if [ "${target:0:1}" = "/" ]; then
      path="$target"
    else
      path="$(dirname "$path")/$target"
    fi
  done
  # Return an absolute, normalized path.
  (cd "$(dirname "$path")" && pwd -P)/$(basename "$path")
}

# On platforms where bun link creates a symlink, resolve it directly.
if [ -L "$AGENTS_PATH" ]; then
  RESOLVED="$(resolve_link "$AGENTS_PATH")"
else
  # On Windows, bun link produces a wrapper executable that reads a sibling
  # .bunx metadata file. The metadata points into the global linked package
  # directory, which is itself a symlink to the install directory. Resolve that
  # global symlink to verify it points to this checkout.
  GLOBAL_PKG="$(dirname "$AGENTS_PATH")/../install/global/node_modules/@marius-patrik/agents-mono"
  GLOBAL_PKG="$(cd "$GLOBAL_PKG" 2>/dev/null && pwd -P)" || GLOBAL_PKG=""
  if [ -n "$GLOBAL_PKG" ]; then
    RESOLVED="$GLOBAL_PKG/os/agents-manager/src/cli.ts"
  fi
fi

if [ -z "$RESOLVED" ]; then
  echo "error: could not resolve the agents command target" >&2
  exit 1
fi

if [ "$RESOLVED" != "$EXPECTED_SCRIPT" ]; then
  echo "error: agents command does not resolve to the expected entry script" >&2
  echo "  expected: $EXPECTED_SCRIPT" >&2
  echo "  actual:   $RESOLVED" >&2
  exit 1
fi

echo "agents resolves to: $RESOLVED"

# Isolate shared state so the smoke test does not mutate the caller's .agents.
STATE_DIR="$(mktemp -d)"
trap 'rm -rf "$STATE_DIR"' EXIT
export AGENTS_HOME="$STATE_DIR"

echo "Running agents state init ..."
agents state init
echo "Running agents list ..."
agents list
echo "Smoke test passed."
