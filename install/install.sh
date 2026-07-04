#!/usr/bin/env bash
set -euo pipefail

# Install or update the agents CLI for the agents-mono workspace.
# Usage: install.sh [install-dir]
# Default install directory: $HOME/.agents-mono

REPO_URL="https://github.com/marius-patrik/agents-mono.git"
INSTALL_DIR="${1:-$HOME/.agents-mono}"
# Allow smoke tests and mirrors to override the source repository.
SOURCE_URL="${AGENTS_MONO_SOURCE:-$REPO_URL}"

check_bun() {
  if ! command -v bun >/dev/null 2>&1; then
    echo "error: bun is required but not installed." >&2
    echo "Install Bun: https://bun.sh/docs/installation" >&2
    exit 1
  fi
}

install_or_update() {
  if [ -d "$INSTALL_DIR/.git" ]; then
    echo "Updating agents-mono in $INSTALL_DIR ..."
    git -C "$INSTALL_DIR" pull --ff-only
  else
    echo "Installing agents-mono into $INSTALL_DIR ..."
    mkdir -p "$(dirname "$INSTALL_DIR")"
    # Try to clone the dev branch directly; fall back to a default clone + checkout
    # so local source repositories used in smoke tests also work.
    git clone --branch dev "$SOURCE_URL" "$INSTALL_DIR" 2>/dev/null || {
      git clone "$SOURCE_URL" "$INSTALL_DIR"
      git -C "$INSTALL_DIR" checkout -q dev
    }
  fi

  (
    cd "$INSTALL_DIR"

    echo "Initializing required submodule ..."
    git submodule update --init --checkout os/agents-manager

    echo "Installing dependencies ..."
    bun install --frozen-lockfile

    echo "Linking agents CLI ..."
    bun link

    echo "Running smoke check ..."
    bash install/smoke.sh
  )
}

main() {
  check_bun
  install_or_update
  echo "agents CLI is ready: $(command -v agents)"
}

main "$@"
