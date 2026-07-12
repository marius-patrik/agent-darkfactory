#!/usr/bin/env bash
set -euo pipefail

# Exercise fresh install and idempotent update from a local Git source. Every
# writable root is below one disposable sandbox, and Bun dependency installation
# is stubbed so this test has no network dependency.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT

SOURCE_DIR="$SANDBOX/source"
AGENTS_USER_HOME="$SANDBOX/home"
AGENTS_HOME="$AGENTS_USER_HOME/.agents"
AGENTS_ROOT="$AGENTS_USER_HOME/Projects/agents-manager"
FAKE_BIN="$SANDBOX/bin"
REAL_BUN="$(command -v bun)"

mkdir -p "$AGENTS_USER_HOME" "$FAKE_BIN"

# Snapshot the current checkout, including tracked edits and untracked source
# files, into a local dev branch without changing the caller's repository.
git clone --no-hardlinks "$ROOT_DIR" "$SOURCE_DIR" >/dev/null
git -C "$SOURCE_DIR" checkout -q -B dev

exclude_args=()
while IFS= read -r submodule_path; do
  [ -n "$submodule_path" ] && exclude_args+=(":(exclude)$submodule_path")
done < <(git -C "$ROOT_DIR" config --file .gitmodules --get-regexp path 2>/dev/null | awk '{ print $2 }')

patch_file="$SANDBOX/worktree.patch"
git -C "$ROOT_DIR" diff --binary HEAD -- . "${exclude_args[@]}" >"$patch_file"
if [ -s "$patch_file" ]; then
  git -C "$SOURCE_DIR" apply "$patch_file"
fi

while IFS= read -r -d '' file; do
  [ -f "$ROOT_DIR/$file" ] || continue
  mkdir -p "$SOURCE_DIR/$(dirname "$file")"
  cp -p "$ROOT_DIR/$file" "$SOURCE_DIR/$file"
done < <(git -C "$ROOT_DIR" ls-files --others --exclude-standard -z)

# Replace the real component remotes and multi-gigabyte gitlinks with tiny local
# repositories. The installer still has to initialize every submodule and prove
# its exact gitlink; this keeps the boundary test deterministic and networkless.
STUB_ROOT="$SANDBOX/component-stubs"
mkdir -p "$STUB_ROOT"
while read -r _key component_name; do
  component_path="$(git -C "$SOURCE_DIR" config --file .gitmodules --get "submodule.$component_name.path")"
  stub_repo="$STUB_ROOT/$component_name"
  mkdir -p "$stub_repo"
  git -C "$stub_repo" init -q
  git -C "$stub_repo" config user.name "Agent OS smoke"
  git -C "$stub_repo" config user.email "agent-os-smoke@invalid"
  printf '%s\n' "$component_path" >"$stub_repo/COMPONENT"
  git -C "$stub_repo" add COMPONENT
  git -C "$stub_repo" commit -q -m "stub $component_name"
  stub_commit="$(git -C "$stub_repo" rev-parse HEAD)"
  git -C "$SOURCE_DIR" config --file .gitmodules "submodule.$component_name.url" "$stub_repo"
  git -C "$SOURCE_DIR" update-index --add --cacheinfo "160000,$stub_commit,$component_path"
done < <(git -C "$SOURCE_DIR" config --file .gitmodules --name-only --get-regexp '^submodule\..*\.path$' | sed -E 's/^submodule\.([^.]*)\.path$/path \1/')

git -C "$SOURCE_DIR" config user.name "Agent OS smoke"
git -C "$SOURCE_DIR" config user.email "agent-os-smoke@invalid"
git -C "$SOURCE_DIR" add -A
git -C "$SOURCE_DIR" commit -q --allow-empty -m "smoke source snapshot"

# The manager runtime does not need installed third-party packages for this
# boundary. Skip only the install subcommand; every CLI execution uses real Bun.
cat >"$FAKE_BIN/bun" <<EOF
#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "install" ]; then
  test -f package.json
  test -f bun.lock
  exit 0
fi
exec $(printf '%q' "$REAL_BUN") "\$@"
EOF
chmod 700 "$FAKE_BIN/bun"

# Plant obsolete launchers to prove that installation converges bin/ to the one
# supported command rather than preserving wrapper drift.
mkdir -p "$AGENTS_HOME/bin"
touch "$AGENTS_HOME/bin/claude" "$AGENTS_HOME/bin/codex" "$AGENTS_HOME/bin/kimi"

for provider_binary in codex/codex claude/claude kimi/kimi agy/agy; do
  provider="${provider_binary%%/*}"
  binary="${provider_binary#*/}"
  mkdir -p "$AGENTS_HOME/clis/$provider/bin"
  chmod 700 "$AGENTS_HOME/clis/$provider" "$AGENTS_HOME/clis/$provider/bin"
  cat >"$AGENTS_HOME/clis/$provider/bin/$binary" <<EOF
#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then
  echo "$binary smoke-0.0.0"
  exit 0
fi
exit 64
EOF
  chmod 700 "$AGENTS_HOME/clis/$provider/bin/$binary"
done

run_installer() {
  env \
    PATH="$FAKE_BIN:$PATH" \
    HOME="$AGENTS_USER_HOME" \
    AGENTS_MANAGER_SOURCE="$SOURCE_DIR" \
    AGENTS_MANAGER_BRANCH=dev \
    AGENTS_HOME="$AGENTS_HOME" \
    AGENTS_USER_HOME="$AGENTS_USER_HOME" \
    AGENTS_ROOT="$AGENTS_ROOT" \
    GIT_ALLOW_PROTOCOL=file \
    bash "$SOURCE_DIR/install/install.sh"
}

run_installer
run_installer

env \
  PATH="$FAKE_BIN:$PATH" \
  AGENTS_SMOKE_SANDBOX="$SANDBOX" \
  AGENTS_HOME="$AGENTS_HOME" \
  AGENTS_USER_HOME="$AGENTS_USER_HOME" \
  AGENTS_ROOT="$AGENTS_ROOT" \
  bash "$SOURCE_DIR/install/smoke.sh"

echo "Release install smoke test passed."
