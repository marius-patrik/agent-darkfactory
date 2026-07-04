#!/usr/bin/env bash
set -euo pipefail

# Release smoke test.
# Clones the current repository into a temporary source directory on a `dev`
# branch, then runs install/install.sh against an isolated temporary install
# directory twice (fresh install + update). This exercises the full public
# source-install path that users run.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_DIR="$(mktemp -d)"
INSTALL_DIR="$(mktemp -d)"
trap 'rm -rf "$SOURCE_DIR" "$INSTALL_DIR"' EXIT

# Clone the current repo so submodule gitlinks are preserved, then create a
# `dev` branch at the current HEAD so the installer's `--branch dev` clone gets
# this exact code.
git clone --no-hardlinks "$ROOT_DIR" "$SOURCE_DIR"
CURRENT_HEAD="$(git -C "$ROOT_DIR" rev-parse HEAD)"
(
  cd "$SOURCE_DIR"
  git checkout -q -b dev "$CURRENT_HEAD"
)

export AGENTS_MONO_SOURCE="$SOURCE_DIR"

# Run once for a fresh install and again to verify the update path is idempotent.
bash "$ROOT_DIR/install/install.sh" "$INSTALL_DIR"
echo "--- Re-running installer to verify update path ---"
bash "$ROOT_DIR/install/install.sh" "$INSTALL_DIR"
