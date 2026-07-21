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
ANDROMEDA_USER_HOME="$SANDBOX/home"
ANDROMEDA_HOME="$ANDROMEDA_USER_HOME/.agents"
ANDROMEDA_ROOT="$ANDROMEDA_USER_HOME/marius-patrik/Andromeda"
FAKE_BIN="$SANDBOX/bin"
REAL_BUN="$(command -v bun)"
REAL_GIT="$(command -v git)"

mkdir -p "$ANDROMEDA_USER_HOME" "$FAKE_BIN"

# Snapshot the current checkout, including tracked edits and untracked source
# files, into a local main branch without changing the caller's repository.
git clone --no-hardlinks "$ROOT_DIR" "$SOURCE_DIR" >/dev/null
git -C "$SOURCE_DIR" checkout -q -B main

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
git -C "$SOURCE_DIR" add -A
STUB_ROOT="$SANDBOX/component-stubs"
mkdir -p "$STUB_ROOT"
# The state repository is cloned into ANDROMEDA_HOME below whether or not it is a
# submodule of this repository, so its fixture is built unconditionally. As of
# the migrate consolidation no submodules remain, and the loop that follows is
# a no-op until one is declared again.
data_stub="$STUB_ROOT/data"
mkdir -p "$data_stub"
git -C "$data_stub" init -q -b main
git -C "$data_stub" config user.name "Andromeda smoke"
git -C "$data_stub" config user.email "andromeda-smoke@invalid"
printf '%s\n' '/bin/' '/clis/' '/memory/' '/runtime/' '/secrets/' '/sessions/' '/sync/' >"$data_stub/.gitignore"
printf '%s\n' '{"schemaVersion":1,"id":"andromeda-data","kind":"data"}' >"$data_stub/agent.package.json"
printf '%s\n' '# Andromeda Data smoke fixture' >"$data_stub/README.md"
mkdir -p "$data_stub/scripts"
printf '%s\n' '// smoke fixture' >"$data_stub/scripts/validate.mjs"
git -C "$data_stub" add .
git -C "$data_stub" commit -q -m "stub data"

while read -r _key component_name; do
  [ "$component_name" = "data" ] && continue
  component_path="$(git -C "$SOURCE_DIR" config --file .gitmodules --get "submodule.$component_name.path")"
  stub_repo="$STUB_ROOT/$component_name"
  mkdir -p "$stub_repo"
  git -C "$stub_repo" init -q -b main
  git -C "$stub_repo" config user.name "Andromeda smoke"
  git -C "$stub_repo" config user.email "andromeda-smoke@invalid"
  printf '%s\n' "$component_path" >"$stub_repo/COMPONENT"
  git -C "$stub_repo" add .
  git -C "$stub_repo" commit -q -m "stub $component_name"
  stub_commit="$(git -C "$stub_repo" rev-parse HEAD)"
  git -C "$SOURCE_DIR" config --file .gitmodules "submodule.$component_name.url" "$stub_repo"
  git -C "$SOURCE_DIR" update-index --add --cacheinfo "160000,$stub_commit,$component_path"
done < <(git -C "$SOURCE_DIR" config --file .gitmodules --name-only --get-regexp '^submodule\..*\.path$' 2>/dev/null | sed -E 's/^submodule\.([^.]*)\.path$/path \1/')

git -C "$SOURCE_DIR" config user.name "Andromeda smoke"
git -C "$SOURCE_DIR" config user.email "andromeda-smoke@invalid"
git -C "$SOURCE_DIR" add .gitmodules
git -C "$SOURCE_DIR" commit -q --allow-empty -m "smoke source snapshot"

# Seed the primary state checkout before planting existing provider/runtime
# contents. This models an already-converged ANDROMEDA_HOME while the edge fixture
# below still exercises a fresh private-data clone.
git clone --quiet --branch main "$STUB_ROOT/data" "$ANDROMEDA_HOME"
git -C "$ANDROMEDA_HOME" remote set-url origin https://github.com/marius-patrik/private-data.git

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
mkdir -p "$ANDROMEDA_HOME/bin"
touch "$ANDROMEDA_HOME/bin/claude" "$ANDROMEDA_HOME/bin/codex" "$ANDROMEDA_HOME/bin/kimi"

for provider_binary in codex/codex claude/claude kimi/kimi agy/agy; do
  provider="${provider_binary%%/*}"
  binary="${provider_binary#*/}"
  mkdir -p "$ANDROMEDA_HOME/clis/$provider/bin"
  chmod 700 "$ANDROMEDA_HOME/clis/$provider" "$ANDROMEDA_HOME/clis/$provider/bin"
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      cp "$REAL_GIT" "$ANDROMEDA_HOME/clis/$provider/bin/$binary.exe"
      ;;
    *)
      cat >"$ANDROMEDA_HOME/clis/$provider/bin/$binary" <<EOF
#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then
  echo "$binary smoke-0.0.0"
  exit 0
fi
exit 64
EOF
      chmod 700 "$ANDROMEDA_HOME/clis/$provider/bin/$binary"
      ;;
  esac
done

run_installer() {
  env \
    PATH="$FAKE_BIN:$PATH" \
    HOME="$ANDROMEDA_USER_HOME" \
    ANDROMEDA_SOURCE="$SOURCE_DIR" \
    ANDROMEDA_DATA_SOURCE="$STUB_ROOT/data" \
    ANDROMEDA_BRANCH=main \
    ANDROMEDA_HOME="$ANDROMEDA_HOME" \
    ANDROMEDA_USER_HOME="$ANDROMEDA_USER_HOME" \
    ANDROMEDA_ROOT="$ANDROMEDA_ROOT" \
    GIT_ALLOW_PROTOCOL=file \
    bash "$SOURCE_DIR/install/install.sh"
}

run_installer
run_installer

# A submodule or linked worktree stores .git as a file. It is still a valid
# canonical checkout when its origin and branch agree with the installer.
EDGE_USER_HOME="$SANDBOX/edge-home"
EDGE_ANDROMEDA_HOME="$EDGE_USER_HOME/.agents"
EDGE_ROOT="$EDGE_USER_HOME/marius-patrik/Andromeda"
mkdir -p "$(dirname "$EDGE_ROOT")" "$SANDBOX/edge-git"
git clone --quiet --branch main --separate-git-dir="$SANDBOX/edge-git/repository" "$SOURCE_DIR" "$EDGE_ROOT"
test -f "$EDGE_ROOT/.git"
env \
  PATH="$FAKE_BIN:$PATH" \
  HOME="$EDGE_USER_HOME" \
  ANDROMEDA_SOURCE="$SOURCE_DIR" \
  ANDROMEDA_DATA_SOURCE="$STUB_ROOT/data" \
  ANDROMEDA_BRANCH=main \
  ANDROMEDA_HOME="$EDGE_ANDROMEDA_HOME" \
  ANDROMEDA_USER_HOME="$EDGE_USER_HOME" \
  ANDROMEDA_ROOT="$EDGE_ROOT" \
  GIT_ALLOW_PROTOCOL=file \
  bash "$SOURCE_DIR/install/install.sh"

# A populated pre-checkout state root is migrated by staging, overlaying, and
# atomically swapping while retaining a sibling rollback tree.
LEGACY_USER_HOME="$SANDBOX/legacy-home"
LEGACY_ANDROMEDA_HOME="$LEGACY_USER_HOME/.agents"
LEGACY_ROOT="$LEGACY_USER_HOME/marius-patrik/Andromeda"
mkdir -p "$LEGACY_ANDROMEDA_HOME/memory" "$(dirname "$LEGACY_ROOT")"
printf '%s\n' 'preserve-me' >"$LEGACY_ANDROMEDA_HOME/memory/legacy-marker"
env \
  PATH="$FAKE_BIN:$PATH" \
  HOME="$LEGACY_USER_HOME" \
  ANDROMEDA_SOURCE="$SOURCE_DIR" \
  ANDROMEDA_DATA_SOURCE="$STUB_ROOT/data" \
  ANDROMEDA_BRANCH=main \
  ANDROMEDA_HOME="$LEGACY_ANDROMEDA_HOME" \
  ANDROMEDA_USER_HOME="$LEGACY_USER_HOME" \
  ANDROMEDA_ROOT="$LEGACY_ROOT" \
  GIT_ALLOW_PROTOCOL=file \
  bash "$SOURCE_DIR/install/install.sh"
test -d "$LEGACY_ANDROMEDA_HOME/.git"
grep -F 'preserve-me' "$LEGACY_ANDROMEDA_HOME/memory/legacy-marker"
legacy_backups=("$LEGACY_USER_HOME"/.agents.pre-andromeda-data-*)
[ "${#legacy_backups[@]}" -eq 1 ]
grep -F 'preserve-me' "${legacy_backups[0]}/memory/legacy-marker"
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) ;;
  *) [ "$(stat -c '%a' "$LEGACY_ANDROMEDA_HOME/memory/legacy-marker")" = "600" ] || {
    echo "error: migrated legacy state is not private" >&2
    exit 1
  } ;;
esac

# An existing worktree with the wrong origin must remain a hard failure.
DENIED_USER_HOME="$SANDBOX/denied-home"
DENIED_ROOT="$DENIED_USER_HOME/marius-patrik/Andromeda"
mkdir -p "$(dirname "$DENIED_ROOT")"
git clone --quiet --branch main "$SOURCE_DIR" "$DENIED_ROOT"
git -C "$DENIED_ROOT" remote set-url origin https://example.invalid/not-andromeda.git
if env \
  PATH="$FAKE_BIN:$PATH" \
  HOME="$DENIED_USER_HOME" \
  ANDROMEDA_SOURCE="$SOURCE_DIR" \
  ANDROMEDA_DATA_SOURCE="$STUB_ROOT/data" \
  ANDROMEDA_BRANCH=main \
  ANDROMEDA_HOME="$DENIED_USER_HOME/.agents" \
  ANDROMEDA_USER_HOME="$DENIED_USER_HOME" \
  ANDROMEDA_ROOT="$DENIED_ROOT" \
  GIT_ALLOW_PROTOCOL=file \
  bash "$SOURCE_DIR/install/install.sh" >"$SANDBOX/denied.log" 2>&1; then
  echo "error: installer accepted a checkout with the wrong origin" >&2
  exit 1
fi
grep -F "canonical checkout origin is https://example.invalid/not-andromeda.git, expected $SOURCE_DIR" "$SANDBOX/denied.log"

# A nested directory must not inherit the enclosing repository's identity.
NESTED_USER_HOME="$SANDBOX/nested-home"
NESTED_PARENT="$NESTED_USER_HOME/marius-patrik"
NESTED_ROOT="$NESTED_PARENT/nested/Andromeda"
git clone --quiet --branch main "$SOURCE_DIR" "$NESTED_PARENT"
mkdir -p "$NESTED_ROOT"
if env \
  PATH="$FAKE_BIN:$PATH" \
  HOME="$NESTED_USER_HOME" \
  ANDROMEDA_SOURCE="$SOURCE_DIR" \
  ANDROMEDA_DATA_SOURCE="$STUB_ROOT/data" \
  ANDROMEDA_BRANCH=main \
  ANDROMEDA_HOME="$NESTED_USER_HOME/.agents" \
  ANDROMEDA_USER_HOME="$NESTED_USER_HOME" \
  ANDROMEDA_ROOT="$NESTED_ROOT" \
  GIT_ALLOW_PROTOCOL=file \
  bash "$SOURCE_DIR/install/install.sh" >"$SANDBOX/nested.log" 2>&1; then
  echo "error: installer accepted a nested directory as the canonical worktree" >&2
  exit 1
fi
grep -F "ANDROMEDA_ROOT is inside another Git worktree instead of being its root" "$SANDBOX/nested.log"

env \
  PATH="$FAKE_BIN:$PATH" \
  ANDROMEDA_SMOKE_SANDBOX="$SANDBOX" \
  ANDROMEDA_HOME="$ANDROMEDA_HOME" \
  ANDROMEDA_USER_HOME="$ANDROMEDA_USER_HOME" \
  ANDROMEDA_ROOT="$ANDROMEDA_ROOT" \
  bash "$SOURCE_DIR/install/smoke.sh"

echo "Release install smoke test passed."
