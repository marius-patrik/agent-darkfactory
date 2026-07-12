#!/usr/bin/env bash
set -euo pipefail

umask 077

readonly REPO_URL="https://github.com/marius-patrik/agents-manager.git"
readonly SOURCE_URL="${AGENTS_MANAGER_SOURCE:-$REPO_URL}"
readonly SOURCE_BRANCH="${AGENTS_MANAGER_BRANCH:-dev}"

die() {
  echo "error: $*" >&2
  exit 1
}

require_absolute() {
  local name="$1"
  local value="$2"
  case "$value" in
    /*) ;;
    *) die "$name must be an absolute path: $value" ;;
  esac
}

real_user_home() {
  local candidate="${AGENTS_USER_HOME:-}"
  if [ -z "$candidate" ] && command -v getent >/dev/null 2>&1; then
    candidate="$(getent passwd "$(id -u)" 2>/dev/null | awk -F: 'NR == 1 { print $6 }')"
  fi
  if [ -z "$candidate" ] && command -v dscl >/dev/null 2>&1; then
    candidate="$(dscl . -read "/Users/$(id -un)" NFSHomeDirectory 2>/dev/null | awk 'NR == 1 { print $2 }')"
  fi
  if [ -z "$candidate" ]; then
    candidate="${HOME:-}"
  fi
  [ -n "$candidate" ] || die "could not resolve the real OS user home; set AGENTS_USER_HOME"
  require_absolute "AGENTS_USER_HOME" "$candidate"
  [ -d "$candidate" ] || die "AGENTS_USER_HOME is not a directory: $candidate"
  (cd "$candidate" && pwd -P)
}

check_dependencies() {
  command -v git >/dev/null 2>&1 || die "git is required"
  command -v bun >/dev/null 2>&1 || die "bun 1.1 or newer is required"
}

prepare_paths() {
  AGENTS_USER_HOME="$(real_user_home)"
  AGENTS_HOME="${AGENTS_HOME:-$AGENTS_USER_HOME/.agents}"
  AGENTS_ROOT="${AGENTS_ROOT:-$AGENTS_USER_HOME/Projects/agents-manager}"

  require_absolute "AGENTS_HOME" "$AGENTS_HOME"
  require_absolute "AGENTS_ROOT" "$AGENTS_ROOT"
  [ ! -L "$AGENTS_HOME" ] || die "AGENTS_HOME must be a physical directory, not a symlink: $AGENTS_HOME"
  [ ! -L "$AGENTS_ROOT" ] || die "AGENTS_ROOT must be a physical checkout, not a symlink: $AGENTS_ROOT"

  mkdir -p "$AGENTS_HOME"
  chmod 700 "$AGENTS_HOME"
  AGENTS_HOME="$(cd "$AGENTS_HOME" && pwd -P)"

  mkdir -p "$(dirname "$AGENTS_ROOT")"
  AGENTS_ROOT="$(cd "$(dirname "$AGENTS_ROOT")" && pwd -P)/$(basename "$AGENTS_ROOT")"

  export AGENTS_HOME AGENTS_USER_HOME AGENTS_ROOT
}

install_or_update_checkout() {
  if [ -d "$AGENTS_ROOT/.git" ]; then
    local current_source current_branch
    current_source="$(git -C "$AGENTS_ROOT" remote get-url origin 2>/dev/null || true)"
    [ "$current_source" = "$SOURCE_URL" ] ||
      die "canonical checkout origin is $current_source, expected $SOURCE_URL"
    current_branch="$(git -C "$AGENTS_ROOT" branch --show-current)"
    [ "$current_branch" = "$SOURCE_BRANCH" ] ||
      die "canonical checkout is on $current_branch, expected $SOURCE_BRANCH"
    [ -z "$(git -C "$AGENTS_ROOT" status --porcelain)" ] ||
      die "canonical checkout has uncommitted changes: $AGENTS_ROOT"
    echo "Updating Agent OS in $AGENTS_ROOT ..."
    git -C "$AGENTS_ROOT" pull --ff-only origin "$SOURCE_BRANCH"
  elif [ -e "$AGENTS_ROOT" ]; then
    die "AGENTS_ROOT exists but is not the canonical Git checkout: $AGENTS_ROOT"
  else
    echo "Installing Agent OS into $AGENTS_ROOT ..."
    git clone --branch "$SOURCE_BRANCH" --single-branch "$SOURCE_URL" "$AGENTS_ROOT"
  fi

  echo "Initializing pinned Agent OS components ..."
  git -C "$AGENTS_ROOT" submodule sync --recursive
  git -C "$AGENTS_ROOT" submodule update --init --recursive
  if git -C "$AGENTS_ROOT" submodule status --recursive | grep -Eq '^[+-U]'; then
    git -C "$AGENTS_ROOT" submodule status --recursive >&2
    die "one or more Agent OS components do not match their pinned gitlinks"
  fi

  echo "Installing dependencies ..."
  (
    cd "$AGENTS_ROOT"
    bun install --frozen-lockfile
  )
}

write_export() {
  local name="$1"
  local value="$2"
  printf 'export %s=%q\n' "$name" "$value"
}

install_launcher() {
  local bin_dir="$AGENTS_HOME/bin"
  local launcher="$bin_dir/agents"
  local temporary bun_bin entry

  mkdir -p "$bin_dir"
  chmod 700 "$bin_dir"

  # AGENTS_HOME/bin is owned by Agent OS. The final product exposes one command
  # here; provider executables remain opaque under clis/<provider>/bin.
  shopt -s nullglob dotglob
  for entry in "$bin_dir"/*; do
    [ "$entry" = "$launcher" ] && continue
    rm -rf -- "$entry"
  done
  shopt -u nullglob dotglob
  if [ -e "$launcher" ] || [ -L "$launcher" ]; then
    rm -rf -- "$launcher"
  fi

  bun_bin="$(command -v bun)"
  temporary="$(mktemp "$bin_dir/.agents-launcher.XXXXXX")"
  {
    echo '#!/usr/bin/env bash'
    echo 'set -euo pipefail'
    echo 'for name in $(compgen -e); do'
    echo '  case "$name" in ROMMIE_*|AGENTOS_*) unset "$name" ;; esac'
    echo 'done'
    write_export HOME "$AGENTS_USER_HOME"
    write_export AGENTS_HOME "$AGENTS_HOME"
    write_export AGENTS_USER_HOME "$AGENTS_USER_HOME"
    write_export AGENTS_ROOT "$AGENTS_ROOT"
    write_export AGENTS_WORKSPACE "$AGENTS_HOME/runtime/workspaces"
    write_export AGENTS_CLIS "$AGENTS_HOME/clis"
    write_export AGENTS_HARNESSES "$AGENTS_HOME/harnesses"
    write_export AGENTS_SKILLS "$AGENTS_HOME/skills"
    write_export AGENTS_PLUGINS "$AGENTS_HOME/plugins"
    write_export AGENTS_HOOKS "$AGENTS_HOME/hooks"
    write_export AGENTS_TEMPLATES "$AGENTS_HOME/templates"
    write_export AGENTS_SECRETS "$AGENTS_HOME/secrets"
    write_export AGENTS_SESSIONS "$AGENTS_HOME/sessions"
    write_export AGENTS_IDENTITY "$AGENTS_HOME/identity"
    write_export AGENTS_MEMORY "$AGENTS_HOME/memory"
    write_export AGENTS_ORCHESTRATOR "$AGENTS_HOME/orchestrator"
    write_export AGENTS_CREDITS "$AGENTS_HOME/credits.json"
    write_export AGENTS_DATA_REPOS "$AGENTS_HOME/data-repos.json"
    write_export AGENTS_ENVIRONMENTS "$AGENTS_HOME/environments.json"
    write_export AGENTS_CONFIG "$AGENTS_HOME/config.json"
    write_export AGENTS_SYSTEM_DATA_ROOT "$AGENTS_ROOT/data/agent-os"
    printf 'exec %q %q "$@"\n' "$bun_bin" "$AGENTS_ROOT/packages/core/src/manager/cli.ts"
  } >"$temporary"
  chmod 700 "$temporary"
  mv -f "$temporary" "$launcher"
}

install_default_capabilities() {
  local launcher="$AGENTS_HOME/bin/agents"
  local skill_root="$AGENTS_ROOT/packages/core/capabilities/skills"
  local identity_root="$AGENTS_ROOT/packages/core/capabilities/identity"
  local skill_path name

  [ -d "$skill_root" ] || die "bundled skill floor is missing: $skill_root"
  [ -d "$identity_root" ] || die "bundled identity is missing: $identity_root"
  for skill_path in "$skill_root"/*; do
    [ -d "$skill_path" ] || continue
    name="$(basename "$skill_path")"
    "$launcher" install skill "$name" "$skill_path" --replace
  done
  "$launcher" identity activate "$identity_root" --replace
}

pin_installed_providers() {
  local launcher="$AGENTS_HOME/bin/agents"
  local provider candidate
  for provider in codex claude kimi agy; do
    for candidate in "$AGENTS_HOME/clis/$provider/bin"/*; do
      [ -x "$candidate" ] || continue
      case "$provider:$(basename "$candidate")" in
        codex:codex|claude:claude|kimi:kimi|agy:agy)
          "$launcher" cli pin "$provider"
          break
          ;;
      esac
    done
  done
}

main() {
  [ "$#" -eq 0 ] || die "install.sh does not accept positional install roots; set AGENTS_HOME and AGENTS_ROOT explicitly"
  check_dependencies
  prepare_paths
  install_or_update_checkout
  install_launcher

  "$AGENTS_HOME/bin/agents" state init
  "$AGENTS_HOME/bin/agents" state record-install
  install_default_capabilities
  pin_installed_providers
  "$AGENTS_HOME/bin/agents" state doctor

  echo "Agent OS is ready: $AGENTS_HOME/bin/agents"
  echo "Add $AGENTS_HOME/bin to PATH to invoke agents by name."
}

main "$@"
