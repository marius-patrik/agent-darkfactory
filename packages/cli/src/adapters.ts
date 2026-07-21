import fs from "node:fs";
import path from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { systemDataPath, type SharedState } from "./state";
import { providerBinarySafetyReason } from "./session-adapters";
import { canonicalChildEnvironment, overlayChildEnvironment } from "./runtime-paths";
import { commandInvocation } from "./process-command";
import {
  inspectProviderExecutable,
  readProviderRegistry,
  verifyProviderRegistration,
  writeProviderRegistration,
  type ProviderId,
  type ProviderRegistration,
} from "./provider-registry";

export type CliId = ProviderId;

export interface CliAdapter {
  id: CliId;
  displayName: string;
  binaries: string[];
  homeEnv: Record<string, string>;
  credentialPaths: string[];
}

export interface AdapterDoctorResult {
  id: CliId;
  home: string;
  binary: string | null;
  ok: boolean;
  pinned: boolean;
  notes: string[];
  evidence: AdapterDoctorEvidence;
}

/** Sanitized, path-free evidence that downstream route checks may consume. */
export interface AdapterDoctorEvidence {
  schemaVersion: 1;
  provider: CliId;
  pinned: boolean;
  executableVerified: boolean;
  credentialsPresent: boolean;
  /** Path-free pinned provider version; null when no canonical pin exists. */
  providerVersion?: string | null;
}

export const adapters: Record<CliId, CliAdapter> = {
  codex: {
    id: "codex",
    displayName: "Codex",
    binaries: ["codex"],
    homeEnv: { CODEX_HOME: "codex" },
    credentialPaths: ["auth.json"],
  },
  claude: {
    id: "claude",
    displayName: "Claude",
    binaries: ["claude"],
    homeEnv: { CLAUDE_CONFIG_DIR: "claude" },
    credentialPaths: [".credentials.json"],
  },
  kimi: {
    id: "kimi",
    displayName: "Kimi",
    binaries: ["kimi"],
    homeEnv: { KIMI_CODE_HOME: "kimi" },
    credentialPaths: [path.join("credentials", "kimi-code.json")],
  },
  agy: {
    id: "agy",
    displayName: "Agy",
    binaries: ["agy"],
    homeEnv: { HOME: "agy" },
    credentialPaths: [path.join(".gemini", "oauth_creds.json")],
  },
};

export function adapterIds(): CliId[] {
  return Object.keys(adapters) as CliId[];
}

export function adapter(id: string): CliAdapter {
  const found = adapters[id as CliId];
  if (!found) throw new Error(`unknown CLI adapter: ${id}`);
  return found;
}

export function adapterHome(state: SharedState, id: CliId): string {
  return path.join(state.clisDir, id);
}

const AGY_DISABLE_AUTO_UPDATE_ENV = "AGY_CLI_DISABLE_AUTO_UPDATE";

function forceAgyAutoUpdateDisabled(env: Record<string, string | undefined>, id: CliId): void {
  if (id !== "agy") return;
  for (const name of Object.keys(env)) {
    if (name.toUpperCase() === AGY_DISABLE_AUTO_UPDATE_ENV) delete env[name];
  }
  env[AGY_DISABLE_AUTO_UPDATE_ENV] = "true";
}

export function adapterEnv(state: SharedState, id: CliId): Record<string, string> {
  const spec = adapter(id);
  const env: Record<string, string> = {
    ANDROMEDA_HOME: state.stateDir,
    ANDROMEDA_USER_HOME: state.userHome,
    ANDROMEDA_ROOT: state.root,
    HOME: state.userHome,
    ANDROMEDA_WORKSPACE: state.workspaceDir,
    ANDROMEDA_CLIS: state.clisDir,
    ANDROMEDA_HARNESSES: state.harnessesDir,
    ANDROMEDA_SKILLS: state.skillsDir,
    ANDROMEDA_PLUGINS: state.pluginsDir,
    ANDROMEDA_HOOKS: state.hooksDir,
    ANDROMEDA_TEMPLATES: state.templatesDir,
    ANDROMEDA_SECRETS: state.secretsDir,
    ANDROMEDA_ORCHESTRATOR: state.orchestratorDir,
    ANDROMEDA_MEMORY: path.join(state.stateDir, "memory"),
    ANDROMEDA_CREDITS: state.creditsFile,
    ANDROMEDA_DATA_REPOS: state.dataReposFile,
    ANDROMEDA_SYSTEM_DATA_ROOT: systemDataPath(state),
  };
  for (const [name, dir] of Object.entries(spec.homeEnv)) env[name] = path.join(state.clisDir, dir);
  if (id === "kimi") {
    // Kimi normally honors KIMI_CODE_HOME, but its platform fallback resolves
    // beneath HOME/USERPROFILE. Isolate both as well so a fallback cannot
    // recreate the forbidden standalone ~/.kimi-code root.
    const providerHome = path.join(state.clisDir, "kimi");
    env.HOME = providerHome;
    env.USERPROFILE = providerHome;
  }
  if (id === "agy") {
    // Agy (antigravity-cli) resolves its config root from the OS user profile
    // and ignores HOME on Windows. Bind the explicit absolute canonical config
    // root and isolate both home variables into the provider home so no
    // resolution path can fall back to the forbidden standalone ~/.gemini.
    const providerHome = path.join(state.clisDir, "agy");
    env.GEMINI_DIR = path.join(providerHome, ".gemini");
    env.HOME = providerHome;
    env.USERPROFILE = providerHome;
    env[AGY_DISABLE_AUTO_UPDATE_ENV] = "true";
  }
  return env;
}

/**
 * Verify a credential as a physical regular file beneath the canonical
 * provider home. The doctor owns provider-home inspection; downstream route
 * consumers receive only the sanitized evidence above.
 */
function containsPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function credentialAuthorityBoundary(state: SharedState, providerRoot: string): string {
  const controlledRoot = path.resolve(providerRoot);
  const candidates = [state.userHome, state.root, state.stateDir]
    .map((candidate) => path.resolve(candidate))
    .filter((candidate) => containsPath(candidate, controlledRoot));
  // Prefer the outermost declared authority. Platform aliases above this
  // boundary are outside Agent OS ownership; every component inside remains
  // link-free and physically contained.
  candidates.sort((left, right) => {
    const leftDepth = path.relative(left, controlledRoot).split(path.sep).filter(Boolean).length;
    const rightDepth = path.relative(right, controlledRoot).split(path.sep).filter(Boolean).length;
    return rightDepth - leftDepth;
  });
  return candidates[0] ?? controlledRoot;
}

async function isPhysicalCredentialFile(
  state: SharedState,
  root: string,
  candidate: string,
): Promise<boolean> {
  const controlledRoot = path.resolve(root);
  const target = path.resolve(candidate);
  const relative = path.relative(controlledRoot, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  try {
    const authority = credentialAuthorityBoundary(state, controlledRoot);
    const [physicalAuthority, physicalRoot, physicalTarget] = await Promise.all([
      realpath(authority),
      realpath(controlledRoot),
      realpath(target),
    ]);
    if (!containsPath(physicalAuthority, physicalRoot) || !containsPath(physicalRoot, physicalTarget)) {
      return false;
    }
    const authorityInfo = await lstat(authority);
    if (!authorityInfo.isDirectory() || authorityInfo.isSymbolicLink()) return false;
    const segments = path.relative(authority, target).split(path.sep);
    let current = authority;
    for (let index = 0; index < segments.length; index += 1) {
      current = path.join(current, segments[index]!);
      const info = await lstat(current);
      if (info.isSymbolicLink()) return false;
      const leaf = index === segments.length - 1;
      if (leaf ? !info.isFile() : !info.isDirectory()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function findBinary(state: SharedState, id: CliId, names: string[]): Promise<string | null> {
  const canonicalBin = path.join(adapterHome(state, id), "bin");
  // Windows spawning requires the real extension; extensionless PE files are not runnable.
  const candidates = names.flatMap((name) =>
    process.platform === "win32" ? [`${name}.exe`, `${name}.ps1`, name] : [name],
  );
  for (const name of candidates) {
    const candidate = path.join(canonicalBin, name);
    if (fs.existsSync(candidate) && !providerBinarySafetyReason(candidate)) return candidate;
  }
  return null;
}

export async function doctorAdapter(state: SharedState, id: CliId): Promise<AdapterDoctorResult> {
  const spec = adapter(id);
  const root = adapterHome(state, id);
  const notes: string[] = [];
  const registry = await readProviderRegistry(state);
  const registration = registry.providers[id];
  let binary: string | null;
  if (registration) {
    const verification = await verifyProviderRegistration(registration).catch(() => ({
      ok: false,
      issues: ["pinned provider executable verification failed"],
    }));
    notes.push(...verification.issues);
    binary = verification.ok ? registration.executable : null;
  } else {
    const discovered = await findBinary(state, id, spec.binaries);
    binary = null;
    notes.push(
      discovered
        ? `canonical executable is present but not pinned: ${discovered}`
        : "provider executable is not pinned",
    );
  }
  if (!binary) notes.push(`no verified pinned binary: ${spec.binaries.join(" or ")}`);
  let credentialsPresent = true;
  for (const credentialPath of spec.credentialPaths) {
    const target = path.join(root, credentialPath);
    if (!(await isPhysicalCredentialFile(state, root, target))) {
      credentialsPresent = false;
      notes.push(`credential not present in canonical provider home: ${credentialPath}`);
    }
  }
  const evidence: AdapterDoctorEvidence = {
    schemaVersion: 1,
    provider: id,
    pinned: Boolean(registration),
    executableVerified: binary !== null,
    credentialsPresent,
    providerVersion: registration?.version ?? null,
  };
  return { id, home: root, binary, ok: binary !== null, pinned: Boolean(registration), notes, evidence };
}

export async function pinAdapter(
  state: SharedState,
  id: CliId,
  binaryOverride?: string,
): Promise<ProviderRegistration> {
  const spec = adapter(id);
  const binary = binaryOverride ? path.resolve(binaryOverride) : await findBinary(state, id, spec.binaries);
  if (!binary) throw new Error(`cannot pin ${id}: provider binary not found`);
  const unsafeReason = providerBinarySafetyReason(binary);
  if (unsafeReason) throw new Error(`cannot pin ${id}: ${unsafeReason}`);

  const env = overlayChildEnvironment(canonicalChildEnvironment(), adapterEnv(state, id));
  forceAgyAutoUpdateDisabled(env, id);
  const child = Bun.spawn(commandInvocation(binary, ["--version"], env), {
    cwd: state.root,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`cannot pin ${id}: --version failed: ${stderr.trim() || `exit ${code}`}`);
  const version = stdout.trim().split(/\r?\n/, 1)[0]?.trim();
  if (!version) throw new Error(`cannot pin ${id}: --version returned no version`);

  const registration = await inspectProviderExecutable(id, binary, version);
  await writeProviderRegistration(state, registration);
  await writeGlobalWrapper(state, id, binary);
  return registration;
}

async function writeGlobalWrapper(state: SharedState, id: CliId, binary: string) {
  // The launcher contract reserves state bin/ for the agents launcher alone;
  // pinned-CLI wrappers live under runtime/. Exposing them on PATH is the
  // #217 global-entrypoint lane's decision.
  const binDir = path.join(state.stateDir, "bin");
  const wrapperDir = path.join(state.stateDir, "runtime", "wrappers");
  if (!fs.existsSync(wrapperDir)) {
    await fs.promises.mkdir(wrapperDir, { recursive: true });
  }

  if (process.platform === "win32") {
    const agentsScript = path.join(binDir, "agents.ps1");
    const wrapperPath = path.join(wrapperDir, `${id}.ps1`);
    const wrapperContent = [
      `$ErrorActionPreference = 'Stop'`,
      `$envOutput = & "${agentsScript}" cli env ${id}`,
      `foreach ($line in $envOutput) {`,
      `    if ($line -match '^([^=]+)=(.*)$') {`,
      `        [Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process")`,
      `    }`,
      `}`,
      `$binary = "${binary}"`,
      `if (Test-Path $binary) {`,
      `    & $binary @args`,
      `    exit $LASTEXITCODE`,
      `} else {`,
      `    Write-Error "Pinned executable not found: $binary"`,
      `    exit 1`,
      `}`,
    ].join("\r\n");
    await fs.promises.writeFile(wrapperPath, wrapperContent, "utf8");
  } else {
    const agentsScript = path.join(binDir, "agents");
    const wrapperPath = path.join(wrapperDir, id);
    const wrapperContent = [
      `#!/usr/bin/env bash`,
      `set -e`,
      `eval "$("${agentsScript}" cli env ${id} | while read line; do echo "export $line"; done)"`,
      `exec "${binary}" "$@"`,
    ].join("\n");
    await fs.promises.writeFile(wrapperPath, wrapperContent, { encoding: "utf8", mode: 0o755 });
  }
}
