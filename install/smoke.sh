#!/usr/bin/env bash
set -euo pipefail

# Internal installed-boundary smoke test. The caller must provide a disposable
# sandbox and all three roots explicitly; this script refuses personal state.

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

within_sandbox() {
  local value="$1"
  case "$value/" in
    "$ANDROMEDA_SMOKE_SANDBOX"/*) return 0 ;;
    *) return 1 ;;
  esac
}

runtime_path() {
  local value="$1"
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) cygpath -w "$value" ;;
    *) printf '%s\n' "$value" ;;
  esac
}

for name in ANDROMEDA_SMOKE_SANDBOX ANDROMEDA_HOME ANDROMEDA_USER_HOME ANDROMEDA_ROOT; do
  value="${!name:-}"
  [ -n "$value" ] || die "$name is required"
  require_absolute "$name" "$value"
done

ANDROMEDA_SMOKE_SANDBOX="$(cd "$ANDROMEDA_SMOKE_SANDBOX" && pwd -P)"
ANDROMEDA_HOME="$(cd "$ANDROMEDA_HOME" && pwd -P)"
ANDROMEDA_USER_HOME="$(cd "$ANDROMEDA_USER_HOME" && pwd -P)"
ANDROMEDA_ROOT="$(cd "$ANDROMEDA_ROOT" && pwd -P)"

within_sandbox "$ANDROMEDA_HOME" || die "ANDROMEDA_HOME escapes the disposable smoke sandbox"
within_sandbox "$ANDROMEDA_USER_HOME" || die "ANDROMEDA_USER_HOME escapes the disposable smoke sandbox"
within_sandbox "$ANDROMEDA_ROOT" || die "ANDROMEDA_ROOT escapes the disposable smoke sandbox"
[ "$ANDROMEDA_HOME" != "/Users/user/.andromeda" ] || die "refusing to smoke-test against live personal state"

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) launcher="$ANDROMEDA_HOME/bin/agents.ps1" ;;
  *) launcher="$ANDROMEDA_HOME/bin/agents" ;;
esac

invoke_launcher() {
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$(cygpath -w "$launcher")" "$@" ;;
    *) "$launcher" "$@" ;;
  esac
}
[ -f "$launcher" ] || die "agents launcher is missing: $launcher"
[ ! -L "$launcher" ] || die "agents launcher must be a regular file, not a symlink"
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) ;;
  *) [ -x "$launcher" ] || die "agents launcher is not executable" ;;
esac

entry_count="$(find "$ANDROMEDA_HOME/bin" -mindepth 1 -maxdepth 1 -print | wc -l | tr -d '[:space:]')"
[ "$entry_count" = "1" ] || die "ANDROMEDA_HOME/bin must contain only the agents launcher"

while IFS= read -r component_path; do
  [ -n "$component_path" ] || continue
  git -C "$ANDROMEDA_ROOT/$component_path" rev-parse --is-inside-work-tree >/dev/null 2>&1 ||
    die "component is not initialized: $component_path"
  expected_commit="$(git -C "$ANDROMEDA_ROOT" rev-parse "HEAD:$component_path")"
  actual_commit="$(git -C "$ANDROMEDA_ROOT/$component_path" rev-parse HEAD)"
  [ "$actual_commit" = "$expected_commit" ] ||
    die "component does not match its pinned gitlink: $component_path ($actual_commit != $expected_commit)"
done < <(git -C "$ANDROMEDA_ROOT" config --file .gitmodules --get-regexp path | awk '{ print $2 }')
[ -z "$(git -C "$ANDROMEDA_ROOT" submodule status --recursive | grep -E '^[+-U]' || true)" ] ||
  die "one or more installed components drifted from their pinned gitlinks"

hostile_home="$ANDROMEDA_SMOKE_SANDBOX/hostile-home"
wrong_state="$ANDROMEDA_SMOKE_SANDBOX/wrong-state"
wrong_user="$ANDROMEDA_SMOKE_SANDBOX/wrong-user"
wrong_root="$ANDROMEDA_SMOKE_SANDBOX/wrong-root"
mkdir -p "$hostile_home"

(
  cd "$ANDROMEDA_ROOT"
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      env HOME="$hostile_home" ANDROMEDA_HOME="$wrong_state" ANDROMEDA_USER_HOME="$wrong_user" ANDROMEDA_ROOT="$wrong_root" \
        powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$(cygpath -w "$launcher")" state init
      ;;
    *)
      env HOME="$hostile_home" ANDROMEDA_HOME="$wrong_state" ANDROMEDA_USER_HOME="$wrong_user" ANDROMEDA_ROOT="$wrong_root" \
        "$launcher" state init
      ;;
  esac
  invoke_launcher state doctor --json >/dev/null
  invoke_launcher list --json >/dev/null
  for provider in codex claude kimi agy; do
    if find "$ANDROMEDA_HOME/clis/$provider/bin" -mindepth 1 -maxdepth 1 -type f -perm -u+x -print -quit 2>/dev/null | grep -q .; then
      invoke_launcher cli doctor "$provider" >/dev/null
    fi
  done
)

[ ! -e "$wrong_state" ] || die "launcher honored a conflicting ANDROMEDA_HOME"
[ ! -e "$wrong_user" ] || die "launcher honored a conflicting ANDROMEDA_USER_HOME"
[ ! -e "$wrong_root" ] || die "launcher honored a conflicting ANDROMEDA_ROOT"
[ ! -e "$hostile_home/.andromeda" ] || die "launcher wrote state below an inherited HOME"

env_file="$ANDROMEDA_HOME/env"
grep -Fqx "ANDROMEDA_HOME=$(runtime_path "$ANDROMEDA_HOME")" "$env_file"
grep -Fqx "ANDROMEDA_USER_HOME=$(runtime_path "$ANDROMEDA_USER_HOME")" "$env_file"
grep -Fqx "ANDROMEDA_ROOT=$(runtime_path "$ANDROMEDA_ROOT")" "$env_file"
grep -Fqx "ANDROMEDA_CLIS=$(runtime_path "$ANDROMEDA_HOME/clis")" "$env_file"
grep -Fqx "ANDROMEDA_IDENTITY=$(runtime_path "$ANDROMEDA_HOME/identity")" "$env_file"
grep -Fqx "ANDROMEDA_MEMORY=$(runtime_path "$ANDROMEDA_HOME/memory")" "$env_file"

[ "$(find "$ANDROMEDA_HOME/skills" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d '[:space:]')" -ge "12" ] ||
  die "the canonical 12-skill floor is not installed"
[ -f "$ANDROMEDA_HOME/identity/persona.md" ] || die "canonical persona is missing"
[ "$(find "$ANDROMEDA_HOME/identity/roles" -mindepth 1 -maxdepth 1 -type f -name '*.yaml' | wc -l | tr -d '[:space:]')" = "6" ] ||
  die "the canonical six-role worker floor is not installed"
[ -f "$ANDROMEDA_HOME/identity/capabilities.md" ] || die "canonical capability projection is missing"
[ "$(find "$ANDROMEDA_HOME/store/sha256" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d '[:space:]')" -ge "12" ] ||
  die "content-addressed capability objects are missing"

for forbidden in .codex .claude .kimi-code .gemini; do
  [ ! -e "$ANDROMEDA_USER_HOME/$forbidden" ] || die "standalone provider state was created: $forbidden"
done

echo "Installed Agent OS smoke test passed."
