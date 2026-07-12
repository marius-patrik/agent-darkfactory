#!/usr/bin/env bash
set -euo pipefail

umask 077

readonly REPO_URL="https://github.com/marius-patrik/Andromeda.git"
readonly SOURCE_URL="${ANDROMEDA_SOURCE:-$REPO_URL}"
readonly SOURCE_BRANCH="${ANDROMEDA_BRANCH:-dev}"

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
  AGENTS_ROOT="${AGENTS_ROOT:-$AGENTS_USER_HOME/marius-patrik/Andromeda}"

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
  if git -C "$AGENTS_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    local current_source current_branch worktree_root
    worktree_root="$(git -C "$AGENTS_ROOT" rev-parse --show-toplevel)"
    [ "$(source_identity "$worktree_root")" = "$(source_identity "$AGENTS_ROOT")" ] ||
      die "AGENTS_ROOT is inside another Git worktree instead of being its root: $AGENTS_ROOT (top-level $worktree_root)"
    current_source="$(git -C "$AGENTS_ROOT" remote get-url origin 2>/dev/null || true)"
    [ "$(source_identity "$current_source")" = "$(source_identity "$SOURCE_URL")" ] ||
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
  local escaped="${value//\'/\'\\\'\'}"
  printf "export %s='%s'\n" "$name" "$escaped"
}

is_windows() {
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) return 0 ;;
    *) return 1 ;;
  esac
}

launcher_path() {
  if is_windows; then
    printf '%s/bin/agents.ps1\n' "$AGENTS_HOME"
  else
    printf '%s/bin/agents\n' "$AGENTS_HOME"
  fi
}

write_ps_env() {
  local name="$1"
  local value="$2"
  local escaped="${value//\'/\'\'}"
  printf '$env:%s = '\''%s'\''\n' "$name" "$escaped"
}

run_launcher() {
  local launcher
  launcher="$(launcher_path)"
  if is_windows; then
    powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$(native_path "$launcher")" "$@"
  else
    "$launcher" "$@"
  fi
}

native_path() {
  local value="$1"
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) cygpath -w "$value" ;;
    *) printf '%s\n' "$value" ;;
  esac
}

source_identity() {
  local value="$1"
  case "$(uname -s):$value" in
    MINGW*:/*|MSYS*:/*|CYGWIN*:/*) cygpath -m "$value" ;;
    *) printf '%s\n' "$value" ;;
  esac
}

install_launcher() {
  local bin_dir="$AGENTS_HOME/bin"
  local launcher
  local temporary bun_bin entry

  launcher="$(launcher_path)"

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

  if is_windows; then
    command -v bun.exe >/dev/null 2>&1 || die "a native bun.exe is required for the Windows launcher"
    bun_bin="$(command -v bun.exe)"
    temporary="$(mktemp "$bin_dir/.agents-launcher.XXXXXX.ps1")"
    {
      printf '$ErrorActionPreference = '\''Stop'\''\n'
      printf 'Get-ChildItem Env: | Where-Object { $_.Name -like '\''ROMMIE_*'\'' -or $_.Name -like '\''AGENTOS_*'\'' } | ForEach-Object { Remove-Item "Env:$($_.Name)" }\n'
      write_ps_env HOME "$(native_path "$AGENTS_USER_HOME")"
      write_ps_env AGENTS_HOME "$(native_path "$AGENTS_HOME")"
      write_ps_env AGENTS_USER_HOME "$(native_path "$AGENTS_USER_HOME")"
      write_ps_env AGENTS_ROOT "$(native_path "$AGENTS_ROOT")"
      write_ps_env AGENTS_WORKSPACE "$(native_path "$AGENTS_HOME/runtime/workspaces")"
      write_ps_env AGENTS_CLIS "$(native_path "$AGENTS_HOME/clis")"
      write_ps_env AGENTS_HARNESSES "$(native_path "$AGENTS_HOME/harnesses")"
      write_ps_env AGENTS_SKILLS "$(native_path "$AGENTS_HOME/skills")"
      write_ps_env AGENTS_PLUGINS "$(native_path "$AGENTS_HOME/plugins")"
      write_ps_env AGENTS_HOOKS "$(native_path "$AGENTS_HOME/hooks")"
      write_ps_env AGENTS_TEMPLATES "$(native_path "$AGENTS_HOME/templates")"
      write_ps_env AGENTS_SECRETS "$(native_path "$AGENTS_HOME/secrets")"
      write_ps_env AGENTS_SESSIONS "$(native_path "$AGENTS_HOME/sessions")"
      write_ps_env AGENTS_IDENTITY "$(native_path "$AGENTS_HOME/identity")"
      write_ps_env AGENTS_MEMORY "$(native_path "$AGENTS_HOME/memory")"
      write_ps_env AGENTS_ORCHESTRATOR "$(native_path "$AGENTS_HOME/orchestrator")"
      write_ps_env AGENTS_CREDITS "$(native_path "$AGENTS_HOME/credits.json")"
      write_ps_env AGENTS_DATA_REPOS "$(native_path "$AGENTS_HOME/data-repos.json")"
      write_ps_env AGENTS_ENVIRONMENTS "$(native_path "$AGENTS_HOME/environments.json")"
      write_ps_env AGENTS_CONFIG "$(native_path "$AGENTS_HOME/config.json")"
      write_ps_env AGENTS_SYSTEM_DATA_ROOT "$(native_path "$AGENTS_ROOT/data/agent-os")"
      write_ps_env AGENTS_BUN "$(native_path "$bun_bin")"
      write_ps_env AGENTS_ENTRYPOINT "$(native_path "$AGENTS_ROOT/packages/core/src/manager/cli.ts")"
      printf '& $env:AGENTS_BUN $env:AGENTS_ENTRYPOINT @args\n'
      printf 'exit $LASTEXITCODE\n'
    } >"$temporary"
  else
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
      write_export AGENTS_BUN "$bun_bin"
      write_export AGENTS_ENTRYPOINT "$AGENTS_ROOT/packages/core/src/manager/cli.ts"
      echo 'exec "$AGENTS_BUN" "$AGENTS_ENTRYPOINT" "$@"'
    } >"$temporary"
  fi
  chmod 700 "$temporary"
  mv -f "$temporary" "$launcher"
}

install_default_capabilities() {
  local skill_root="$AGENTS_ROOT/packages/core/capabilities/skills"
  local identity_root="$AGENTS_ROOT/packages/core/capabilities/identity"
  local skill_path name

  [ -d "$skill_root" ] || die "bundled skill floor is missing: $skill_root"
  [ -d "$identity_root" ] || die "bundled identity is missing: $identity_root"
  for skill_path in "$skill_root"/*; do
    [ -d "$skill_path" ] || continue
    name="$(basename "$skill_path")"
    run_launcher install skill "$name" "$skill_path" --replace
  done
  run_launcher identity activate "$identity_root" --replace
}

pin_installed_providers() {
  local provider candidate
  for provider in codex claude kimi agy; do
    for candidate in "$AGENTS_HOME/clis/$provider/bin"/*; do
      [ -x "$candidate" ] || continue
      case "$provider:$(basename "$candidate")" in
        codex:codex|codex:codex.exe|codex:codex.ps1|claude:claude|claude:claude.exe|claude:claude.ps1|kimi:kimi|kimi:kimi.exe|kimi:kimi.ps1|agy:agy|agy:agy.exe|agy:agy.ps1)
          run_launcher cli pin "$provider"
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

  run_launcher state init
  run_launcher state record-install
  install_default_capabilities
  pin_installed_providers
  run_launcher state doctor

  echo "Agent OS is ready: $(launcher_path)"
  echo "Add $AGENTS_HOME/bin to PATH to invoke agents by name."
}

main "$@"
