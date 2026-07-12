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
    "$AGENTS_SMOKE_SANDBOX"/*) return 0 ;;
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

for name in AGENTS_SMOKE_SANDBOX AGENTS_HOME AGENTS_USER_HOME AGENTS_ROOT; do
  value="${!name:-}"
  [ -n "$value" ] || die "$name is required"
  require_absolute "$name" "$value"
done

AGENTS_SMOKE_SANDBOX="$(cd "$AGENTS_SMOKE_SANDBOX" && pwd -P)"
AGENTS_HOME="$(cd "$AGENTS_HOME" && pwd -P)"
AGENTS_USER_HOME="$(cd "$AGENTS_USER_HOME" && pwd -P)"
AGENTS_ROOT="$(cd "$AGENTS_ROOT" && pwd -P)"

within_sandbox "$AGENTS_HOME" || die "AGENTS_HOME escapes the disposable smoke sandbox"
within_sandbox "$AGENTS_USER_HOME" || die "AGENTS_USER_HOME escapes the disposable smoke sandbox"
within_sandbox "$AGENTS_ROOT" || die "AGENTS_ROOT escapes the disposable smoke sandbox"
[ "$AGENTS_HOME" != "/Users/user/.agents" ] || die "refusing to smoke-test against live personal state"

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) launcher="$AGENTS_HOME/bin/agents.ps1" ;;
  *) launcher="$AGENTS_HOME/bin/agents" ;;
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

entry_count="$(find "$AGENTS_HOME/bin" -mindepth 1 -maxdepth 1 -print | wc -l | tr -d '[:space:]')"
[ "$entry_count" = "1" ] || die "AGENTS_HOME/bin must contain only the agents launcher"

while IFS= read -r component_path; do
  [ -n "$component_path" ] || continue
  git -C "$AGENTS_ROOT/$component_path" rev-parse --is-inside-work-tree >/dev/null 2>&1 ||
    die "component is not initialized: $component_path"
  expected_commit="$(git -C "$AGENTS_ROOT" rev-parse "HEAD:$component_path")"
  actual_commit="$(git -C "$AGENTS_ROOT/$component_path" rev-parse HEAD)"
  [ "$actual_commit" = "$expected_commit" ] ||
    die "component does not match its pinned gitlink: $component_path ($actual_commit != $expected_commit)"
done < <(git -C "$AGENTS_ROOT" config --file .gitmodules --get-regexp path | awk '{ print $2 }')
[ -z "$(git -C "$AGENTS_ROOT" submodule status --recursive | grep -E '^[+-U]' || true)" ] ||
  die "one or more installed components drifted from their pinned gitlinks"

hostile_home="$AGENTS_SMOKE_SANDBOX/hostile-home"
wrong_state="$AGENTS_SMOKE_SANDBOX/wrong-state"
wrong_user="$AGENTS_SMOKE_SANDBOX/wrong-user"
wrong_root="$AGENTS_SMOKE_SANDBOX/wrong-root"
mkdir -p "$hostile_home"

(
  cd "$AGENTS_ROOT"
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      env HOME="$hostile_home" AGENTS_HOME="$wrong_state" AGENTS_USER_HOME="$wrong_user" AGENTS_ROOT="$wrong_root" \
        powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$(cygpath -w "$launcher")" state init
      ;;
    *)
      env HOME="$hostile_home" AGENTS_HOME="$wrong_state" AGENTS_USER_HOME="$wrong_user" AGENTS_ROOT="$wrong_root" \
        "$launcher" state init
      ;;
  esac
  invoke_launcher state doctor --json >/dev/null
  invoke_launcher list --json >/dev/null
  for provider in codex claude kimi agy; do
    if find "$AGENTS_HOME/clis/$provider/bin" -mindepth 1 -maxdepth 1 -type f -perm -u+x -print -quit 2>/dev/null | grep -q .; then
      invoke_launcher cli doctor "$provider" >/dev/null
    fi
  done
)

[ ! -e "$wrong_state" ] || die "launcher honored a conflicting AGENTS_HOME"
[ ! -e "$wrong_user" ] || die "launcher honored a conflicting AGENTS_USER_HOME"
[ ! -e "$wrong_root" ] || die "launcher honored a conflicting AGENTS_ROOT"
[ ! -e "$hostile_home/.agents" ] || die "launcher wrote state below an inherited HOME"

env_file="$AGENTS_HOME/env"
grep -Fqx "AGENTS_HOME=$(runtime_path "$AGENTS_HOME")" "$env_file"
grep -Fqx "AGENTS_USER_HOME=$(runtime_path "$AGENTS_USER_HOME")" "$env_file"
grep -Fqx "AGENTS_ROOT=$(runtime_path "$AGENTS_ROOT")" "$env_file"
grep -Fqx "AGENTS_CLIS=$(runtime_path "$AGENTS_HOME/clis")" "$env_file"
grep -Fqx "AGENTS_IDENTITY=$(runtime_path "$AGENTS_HOME/identity")" "$env_file"
grep -Fqx "AGENTS_MEMORY=$(runtime_path "$AGENTS_HOME/memory")" "$env_file"

[ "$(find "$AGENTS_HOME/skills" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d '[:space:]')" = "12" ] ||
  die "the canonical 12-skill floor is not installed"
[ -f "$AGENTS_HOME/identity/persona.md" ] || die "canonical persona is missing"
[ "$(find "$AGENTS_HOME/identity/roles" -mindepth 1 -maxdepth 1 -type f -name '*.yaml' | wc -l | tr -d '[:space:]')" = "6" ] ||
  die "the canonical six-role worker floor is not installed"
[ -f "$AGENTS_HOME/identity/capabilities.md" ] || die "canonical capability projection is missing"
[ "$(find "$AGENTS_HOME/store/sha256" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d '[:space:]')" -ge "12" ] ||
  die "content-addressed capability objects are missing"

for forbidden in .codex .claude .kimi-code .gemini; do
  [ ! -e "$AGENTS_USER_HOME/$forbidden" ] || die "standalone provider state was created: $forbidden"
done

echo "Installed Agent OS smoke test passed."
