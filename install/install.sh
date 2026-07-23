#!/usr/bin/env bash
set -euo pipefail

umask 077

readonly REPO_URL="https://github.com/marius-patrik/Andromeda.git"
readonly SOURCE_URL="${ANDROMEDA_SOURCE:-$REPO_URL}"
# main is the only branch. dev was deleted 2026-07-21 when the repository went
# trunk-based, so defaulting to it made every source install fail closed.
readonly SOURCE_BRANCH="${ANDROMEDA_BRANCH:-main}"
readonly DATA_REPO_URL="https://github.com/marius-patrik/private-data.git"
readonly DATA_SOURCE_URL="${ANDROMEDA_DATA_SOURCE:-$DATA_REPO_URL}"
readonly DATA_BRANCH="main"

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
  local candidate="${ANDROMEDA_USER_HOME:-}"
  if [ -z "$candidate" ] && command -v getent >/dev/null 2>&1; then
    candidate="$(getent passwd "$(id -u)" 2>/dev/null | awk -F: 'NR == 1 { print $6 }')"
  fi
  if [ -z "$candidate" ] && command -v dscl >/dev/null 2>&1; then
    candidate="$(dscl . -read "/Users/$(id -un)" NFSHomeDirectory 2>/dev/null | awk 'NR == 1 { print $2 }')"
  fi
  if [ -z "$candidate" ]; then
    candidate="${HOME:-}"
  fi
  [ -n "$candidate" ] || die "could not resolve the real OS user home; set ANDROMEDA_USER_HOME"
  require_absolute "ANDROMEDA_USER_HOME" "$candidate"
  [ -d "$candidate" ] || die "ANDROMEDA_USER_HOME is not a directory: $candidate"
  (cd "$candidate" && pwd -P)
}

check_dependencies() {
  command -v git >/dev/null 2>&1 || die "git is required"
  command -v bun >/dev/null 2>&1 || die "bun 1.1 or newer is required"
}

prepare_paths() {
  ANDROMEDA_USER_HOME="$(real_user_home)"
  ANDROMEDA_HOME="${ANDROMEDA_HOME:-$ANDROMEDA_USER_HOME/.agents}"
  ANDROMEDA_ROOT="${ANDROMEDA_ROOT:-$ANDROMEDA_USER_HOME/marius-patrik/Andromeda}"

  require_absolute "ANDROMEDA_HOME" "$ANDROMEDA_HOME"
  require_absolute "ANDROMEDA_ROOT" "$ANDROMEDA_ROOT"
  [ ! -L "$ANDROMEDA_HOME" ] || die "ANDROMEDA_HOME must be a physical directory, not a symlink: $ANDROMEDA_HOME"
  [ ! -L "$ANDROMEDA_ROOT" ] || die "ANDROMEDA_ROOT must be a physical checkout, not a symlink: $ANDROMEDA_ROOT"

  mkdir -p "$ANDROMEDA_HOME"
  chmod 700 "$ANDROMEDA_HOME"
  ANDROMEDA_HOME="$(cd "$ANDROMEDA_HOME" && pwd -P)"

  mkdir -p "$(dirname "$ANDROMEDA_ROOT")"
  ANDROMEDA_ROOT="$(cd "$(dirname "$ANDROMEDA_ROOT")" && pwd -P)/$(basename "$ANDROMEDA_ROOT")"

  export ANDROMEDA_HOME ANDROMEDA_USER_HOME ANDROMEDA_ROOT
}

install_or_update_checkout() {
  if git -C "$ANDROMEDA_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    local current_source current_branch worktree_root
    worktree_root="$(git -C "$ANDROMEDA_ROOT" rev-parse --show-toplevel)"
    [ "$(source_identity "$worktree_root")" = "$(source_identity "$ANDROMEDA_ROOT")" ] ||
      die "ANDROMEDA_ROOT is inside another Git worktree instead of being its root: $ANDROMEDA_ROOT (top-level $worktree_root)"
    current_source="$(git -C "$ANDROMEDA_ROOT" remote get-url origin 2>/dev/null || true)"
    [ "$(source_identity "$current_source")" = "$(source_identity "$SOURCE_URL")" ] ||
      die "canonical checkout origin is $current_source, expected $SOURCE_URL"
    current_branch="$(git -C "$ANDROMEDA_ROOT" branch --show-current)"
    [ "$current_branch" = "$SOURCE_BRANCH" ] ||
      die "canonical checkout is on $current_branch, expected $SOURCE_BRANCH"
    [ -z "$(git -C "$ANDROMEDA_ROOT" status --porcelain)" ] ||
      die "canonical checkout has uncommitted changes: $ANDROMEDA_ROOT"
    echo "Updating Agent OS in $ANDROMEDA_ROOT ..."
    git -C "$ANDROMEDA_ROOT" pull --ff-only origin "$SOURCE_BRANCH"
  elif [ -e "$ANDROMEDA_ROOT" ]; then
    die "ANDROMEDA_ROOT exists but is not the canonical Git checkout: $ANDROMEDA_ROOT"
  else
    echo "Installing Agent OS into $ANDROMEDA_ROOT ..."
    git clone --branch "$SOURCE_BRANCH" --single-branch "$SOURCE_URL" "$ANDROMEDA_ROOT"
  fi

  echo "Initializing pinned Agent OS components ..."
  git -C "$ANDROMEDA_ROOT" submodule sync --recursive
  git -C "$ANDROMEDA_ROOT" submodule update --init --recursive
  if git -C "$ANDROMEDA_ROOT" submodule status --recursive | grep -Eq '^[+-U]'; then
    git -C "$ANDROMEDA_ROOT" submodule status --recursive >&2
    die "one or more Agent OS components do not match their pinned gitlinks"
  fi

  echo "Installing dependencies ..."
  (
    cd "$ANDROMEDA_ROOT"
    bun install --frozen-lockfile
  )
}

install_or_update_state_checkout() {
  if git -C "$ANDROMEDA_HOME" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    local current_source current_branch worktree_root
    worktree_root="$(git -C "$ANDROMEDA_HOME" rev-parse --show-toplevel)"
    [ "$(source_identity "$worktree_root")" = "$(source_identity "$ANDROMEDA_HOME")" ] ||
      die "ANDROMEDA_HOME is inside another Git worktree instead of being its root: $ANDROMEDA_HOME (top-level $worktree_root)"
    current_source="$(git -C "$ANDROMEDA_HOME" remote get-url origin 2>/dev/null || true)"
    [ "$(source_identity "$current_source")" = "$(source_identity "$DATA_REPO_URL")" ] ||
      die "ANDROMEDA_HOME origin is $current_source, expected $DATA_REPO_URL"
    current_branch="$(git -C "$ANDROMEDA_HOME" branch --show-current)"
    [ "$current_branch" = "$DATA_BRANCH" ] ||
      die "ANDROMEDA_HOME is on $current_branch, expected $DATA_BRANCH"
    [ -z "$(git -C "$ANDROMEDA_HOME" status --porcelain --untracked-files=no)" ] ||
      die "ANDROMEDA_HOME has tracked changes: $ANDROMEDA_HOME"
    echo "Updating private-data state checkout in $ANDROMEDA_HOME ..."
    git -C "$ANDROMEDA_HOME" pull --rebase "$DATA_SOURCE_URL" "$DATA_BRANCH"
  elif [ -z "$(find "$ANDROMEDA_HOME" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    echo "Installing private-data state checkout into $ANDROMEDA_HOME ..."
    git clone --branch "$DATA_BRANCH" --single-branch "$DATA_SOURCE_URL" "$ANDROMEDA_HOME"
    git -C "$ANDROMEDA_HOME" remote set-url origin "$DATA_REPO_URL"
  else
    migrate_legacy_state_checkout
  fi
}

migrate_legacy_state_checkout() {
  local parent stage backup stamp
  parent="$(dirname "$ANDROMEDA_HOME")"
  stage="${ANDROMEDA_HOME}.agents-data-stage-$$"
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup="${ANDROMEDA_HOME}.pre-andromeda-data-${stamp}"
  [ ! -e "$stage" ] || die "state migration staging path already exists: $stage"
  [ ! -e "$backup" ] || die "state migration rollback path already exists: $backup"
  [ ! -e "$ANDROMEDA_HOME/.git" ] || die "legacy ANDROMEDA_HOME contains a broken Git marker: $ANDROMEDA_HOME/.git"
  [ "$(dirname "$stage")" = "$parent" ] || die "state migration staging path escaped the user home"
  [ "$(dirname "$backup")" = "$parent" ] || die "state migration rollback path escaped the user home"
  if find "$ANDROMEDA_HOME" -type l -print -quit | grep -q .; then
    die "legacy ANDROMEDA_HOME contains a symbolic link; refusing state migration"
  fi

  echo "Migrating existing Agent OS state into an private-data checkout ..."
  if ! git clone --branch "$DATA_BRANCH" --single-branch "$DATA_SOURCE_URL" "$stage"; then
    rm -rf -- "$stage"
    die "could not stage the private-data checkout"
  fi
  git -C "$stage" remote set-url origin "$DATA_REPO_URL"
  if ! cp -a "$ANDROMEDA_HOME/." "$stage/"; then
    rm -rf -- "$stage"
    die "could not overlay legacy Agent OS state into the staged checkout"
  fi
  chmod -R go-rwx -- "$stage"
  [ -z "$(git -C "$stage" status --porcelain --untracked-files=no)" ] || {
    rm -rf -- "$stage"
    die "legacy Agent OS state conflicts with tracked private-data content"
  }

  mv -- "$ANDROMEDA_HOME" "$backup"
  if ! mv -- "$stage" "$ANDROMEDA_HOME"; then
    mv -- "$backup" "$ANDROMEDA_HOME" || true
    die "could not activate the staged state checkout; rollback was attempted"
  fi
  chmod 700 "$ANDROMEDA_HOME"
  echo "Legacy state preserved at $backup"
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
    printf '%s/bin/andromeda.ps1\n' "$ANDROMEDA_HOME"
  else
    printf '%s/bin/andromeda\n' "$ANDROMEDA_HOME"
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
  local bin_dir="$ANDROMEDA_HOME/bin"
  local launcher
  local temporary bun_bin entry alias suffix

  launcher="$(launcher_path)"

  mkdir -p "$bin_dir"
  chmod 700 "$bin_dir"

  # ANDROMEDA_HOME/bin is owned by Andromeda. Provider executables remain
  # opaque under clis/<provider>/bin; these three files are exact aliases for
  # the same command router.
  shopt -s nullglob dotglob
  for entry in "$bin_dir"/*; do
    rm -rf -- "$entry"
  done
  shopt -u nullglob dotglob

  if is_windows; then
    command -v bun.exe >/dev/null 2>&1 || die "a native bun.exe is required for the Windows launcher"
    bun_bin="$(command -v bun.exe)"
    temporary="$(mktemp "$bin_dir/.agents-launcher.XXXXXX.ps1")"
    {
      printf '$ErrorActionPreference = '\''Stop'\''\n'
      printf 'Get-ChildItem Env: | Where-Object { $_.Name -like '\''ROMMIE_*'\'' -or $_.Name -like '\''AGENTOS_*'\'' } | ForEach-Object { Remove-Item "Env:$($_.Name)" }\n'
      write_ps_env HOME "$(native_path "$ANDROMEDA_USER_HOME")"
      write_ps_env ANDROMEDA_HOME "$(native_path "$ANDROMEDA_HOME")"
      write_ps_env ANDROMEDA_USER_HOME "$(native_path "$ANDROMEDA_USER_HOME")"
      write_ps_env ANDROMEDA_ROOT "$(native_path "$ANDROMEDA_ROOT")"
      write_ps_env ANDROMEDA_WORKSPACE "$(native_path "$ANDROMEDA_HOME/runtime/workspaces")"
      write_ps_env ANDROMEDA_CLIS "$(native_path "$ANDROMEDA_HOME/clis")"
      write_ps_env ANDROMEDA_HARNESSES "$(native_path "$ANDROMEDA_HOME/harnesses")"
      write_ps_env ANDROMEDA_SKILLS "$(native_path "$ANDROMEDA_HOME/skills")"
      write_ps_env ANDROMEDA_PLUGINS "$(native_path "$ANDROMEDA_HOME/plugins")"
      write_ps_env ANDROMEDA_HOOKS "$(native_path "$ANDROMEDA_HOME/hooks")"
      write_ps_env ANDROMEDA_TEMPLATES "$(native_path "$ANDROMEDA_HOME/templates")"
      write_ps_env ANDROMEDA_SECRETS "$(native_path "$ANDROMEDA_HOME/secrets")"
      write_ps_env ANDROMEDA_SESSIONS "$(native_path "$ANDROMEDA_HOME/sessions")"
      write_ps_env ANDROMEDA_IDENTITY "$(native_path "$ANDROMEDA_HOME/identity")"
      write_ps_env ANDROMEDA_MEMORY "$(native_path "$ANDROMEDA_HOME/memory")"
      write_ps_env ANDROMEDA_ORCHESTRATOR "$(native_path "$ANDROMEDA_HOME/orchestrator")"
      write_ps_env ANDROMEDA_CREDITS "$(native_path "$ANDROMEDA_HOME/credits.json")"
      write_ps_env ANDROMEDA_DATA_REPOS "$(native_path "$ANDROMEDA_HOME/data-repos.json")"
      write_ps_env ANDROMEDA_ENVIRONMENTS "$(native_path "$ANDROMEDA_HOME/environments.json")"
      write_ps_env ANDROMEDA_CONFIG "$(native_path "$ANDROMEDA_HOME/config.json")"
      write_ps_env ANDROMEDA_SYSTEM_DATA_ROOT "$(native_path "$ANDROMEDA_HOME")"
      write_ps_env ANDROMEDA_BUN "$(native_path "$bun_bin")"
      write_ps_env ANDROMEDA_ENTRYPOINT "$(native_path "$ANDROMEDA_ROOT/src/cli/cli.ts")"
      printf '& $env:ANDROMEDA_BUN $env:ANDROMEDA_ENTRYPOINT @args\n'
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
      write_export HOME "$ANDROMEDA_USER_HOME"
      write_export ANDROMEDA_HOME "$ANDROMEDA_HOME"
      write_export ANDROMEDA_USER_HOME "$ANDROMEDA_USER_HOME"
      write_export ANDROMEDA_ROOT "$ANDROMEDA_ROOT"
      write_export ANDROMEDA_WORKSPACE "$ANDROMEDA_HOME/runtime/workspaces"
      write_export ANDROMEDA_CLIS "$ANDROMEDA_HOME/clis"
      write_export ANDROMEDA_HARNESSES "$ANDROMEDA_HOME/harnesses"
      write_export ANDROMEDA_SKILLS "$ANDROMEDA_HOME/skills"
      write_export ANDROMEDA_PLUGINS "$ANDROMEDA_HOME/plugins"
      write_export ANDROMEDA_HOOKS "$ANDROMEDA_HOME/hooks"
      write_export ANDROMEDA_TEMPLATES "$ANDROMEDA_HOME/templates"
      write_export ANDROMEDA_SECRETS "$ANDROMEDA_HOME/secrets"
      write_export ANDROMEDA_SESSIONS "$ANDROMEDA_HOME/sessions"
      write_export ANDROMEDA_IDENTITY "$ANDROMEDA_HOME/identity"
      write_export ANDROMEDA_MEMORY "$ANDROMEDA_HOME/memory"
      write_export ANDROMEDA_ORCHESTRATOR "$ANDROMEDA_HOME/orchestrator"
      write_export ANDROMEDA_CREDITS "$ANDROMEDA_HOME/credits.json"
      write_export ANDROMEDA_DATA_REPOS "$ANDROMEDA_HOME/data-repos.json"
      write_export ANDROMEDA_ENVIRONMENTS "$ANDROMEDA_HOME/environments.json"
      write_export ANDROMEDA_CONFIG "$ANDROMEDA_HOME/config.json"
      write_export ANDROMEDA_SYSTEM_DATA_ROOT "$ANDROMEDA_HOME"
      write_export ANDROMEDA_BUN "$bun_bin"
      write_export ANDROMEDA_ENTRYPOINT "$ANDROMEDA_ROOT/src/cli/cli.ts"
      echo 'exec "$ANDROMEDA_BUN" "$ANDROMEDA_ENTRYPOINT" "$@"'
    } >"$temporary"
  fi
  chmod 700 "$temporary"
  mv -f "$temporary" "$launcher"
  if is_windows; then
    suffix=".ps1"
  else
    suffix=""
  fi
  for alias in agent agents; do
    cp -- "$launcher" "$bin_dir/$alias$suffix"
    chmod 700 "$bin_dir/$alias$suffix"
  done
}

install_default_capabilities() {
  local skill_root="$ANDROMEDA_ROOT/.agents/global/skills"
  local role_root="$ANDROMEDA_ROOT/.agents/global/roles"
  local command_root="$ANDROMEDA_ROOT/.agents/global/commands"
  local persona="$ANDROMEDA_ROOT/.agents/global/persona.md"
  local identity_bundle skill_path name

  [ -d "$skill_root" ] || die "bundled skill floor is missing: $skill_root"
  [ -d "$role_root" ] || die "bundled role floor is missing: $role_root"
  [ -d "$command_root" ] || die "bundled command floor is missing: $command_root"
  [ -f "$persona" ] || die "bundled persona is missing: $persona"
  for skill_path in "$skill_root"/*; do
    [ -d "$skill_path" ] || continue
    name="$(basename "$skill_path")"
    run_launcher install skill "$name" "$skill_path" --replace --internal-bundled
  done

  identity_bundle="$ANDROMEDA_HOME/runtime/tmp/bundled-identity-source"
  rm -rf "$identity_bundle"
  mkdir -p "$identity_bundle/roles" "$identity_bundle/prompts"
  cp "$persona" "$identity_bundle/persona.md"
  cp "$role_root"/*.yaml "$identity_bundle/roles/"
  cp "$command_root"/*.md "$identity_bundle/prompts/"
  if ! run_launcher identity activate "$identity_bundle" --replace; then
    rm -rf "$identity_bundle"
    return 1
  fi
  rm -rf "$identity_bundle"
}

pin_installed_providers() {
  local provider candidate
  for provider in codex claude kimi agy; do
    for candidate in "$ANDROMEDA_HOME/clis/$provider/bin"/*; do
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
  [ "$#" -eq 0 ] || die "install.sh does not accept positional install roots; set ANDROMEDA_HOME and ANDROMEDA_ROOT explicitly"
  check_dependencies
  prepare_paths
  install_or_update_checkout
  install_or_update_state_checkout
  install_launcher

  run_launcher state init
  if [ ! -f "$ANDROMEDA_HOME/secrets/ANDROMEDA_SYNC_KEY.secret" ]; then
    if [ -n "$(git -C "$ANDROMEDA_HOME" ls-files -- 'backups/events')" ]; then
      die "private-data contains encrypted backups; install the existing ANDROMEDA_SYNC_KEY before continuing"
    fi
    run_launcher sync enable --generate-key
  else
    run_launcher sync enable
  fi
  run_launcher state record-install
  install_default_capabilities
  pin_installed_providers
  run_launcher state doctor

  echo "Agent OS is ready: $(launcher_path)"
  echo "Add $ANDROMEDA_HOME/bin to PATH to invoke andromeda, agent, or agents."
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
