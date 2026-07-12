import os from "node:os";
import path from "node:path";

export type RuntimePathEnv = Record<string, string | undefined>;

const projectedPathVariables = new Set(["AGENTS_DATA", "AGENTS_WORKSPACE", "AGENTS_SYSTEM_DATA_ROOT"]);

/** Build a child-process environment without retired or manager-projected path variables. */
export function canonicalChildEnvironment(env: RuntimePathEnv = process.env): RuntimePathEnv {
  const output: RuntimePathEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith("ROMMIE_") || name.startsWith("AGENTOS_") || projectedPathVariables.has(name)) continue;
    output[name] = value;
  }
  return output;
}

function resolved(value: string): string {
  return path.resolve(value.trim());
}

function userHomeFromAgentsHome(agentsHome: string): string | null {
  const normalized = path.normalize(agentsHome);
  return path.basename(normalized) === ".agents" ? path.dirname(normalized) : null;
}

function accountHome(): string {
  try {
    return os.userInfo().homedir;
  } catch {
    return os.homedir();
  }
}

/**
 * Recover the real OS user home even when a provider wrapper has isolated
 * HOME under ~/.agents/clis/<provider>.
 */
export function resolveUserHome(
  env: RuntimePathEnv = process.env,
  platformHome = accountHome(),
): string {
  if (env.AGENTS_USER_HOME?.trim()) return resolved(env.AGENTS_USER_HOME);

  if (env.AGENTS_HOME?.trim()) {
    const inferred = userHomeFromAgentsHome(resolved(env.AGENTS_HOME));
    if (inferred) return inferred;
  }

  const normalized = path.normalize(platformHome);
  const parts = normalized.split(path.sep);
  const agentsIndex = parts.lastIndexOf(".agents");
  if (agentsIndex >= 0 && parts[agentsIndex + 1] === "clis" && parts[agentsIndex + 2]) {
    const prefix = parts.slice(0, agentsIndex).join(path.sep);
    return prefix || path.parse(normalized).root;
  }

  return path.resolve(platformHome);
}

/** Resolve the one personal Agent OS root. */
export function resolvePersonalAgentsHome(
  env: RuntimePathEnv = process.env,
  platformHome = accountHome(),
): string {
  if (env.AGENTS_HOME?.trim()) return resolved(env.AGENTS_HOME);
  return path.join(resolveUserHome(env, platformHome), ".agents");
}

/**
 * Resolve state for a manager invocation. Source checkouts remain repo-local
 * when no state environment is present; installed/rooted harnesses use their
 * explicit AGENTS_HOME.
 */
export function resolveRuntimeAgentsHome(
  cwd: string,
  env: RuntimePathEnv = process.env,
  platformHome = accountHome(),
): string {
  if (env.AGENTS_HOME?.trim()) return resolved(env.AGENTS_HOME);
  return path.join(resolveUserHome(env, platformHome), ".agents");
}
