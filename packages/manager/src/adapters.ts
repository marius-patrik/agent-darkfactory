import fs from "node:fs";
import path from "node:path";
import { stat } from "node:fs/promises";
import { systemDataPath, type SharedState } from "./state";
import { providerBinarySafetyReason } from "./session-adapters";
import { canonicalChildEnvironment } from "./runtime-paths";
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

export function adapterEnv(state: SharedState, id: CliId): Record<string, string> {
  const spec = adapter(id);
  const env: Record<string, string> = {
    AGENTS_HOME: state.stateDir,
    AGENTS_USER_HOME: state.userHome,
    AGENTS_ROOT: state.root,
    HOME: state.userHome,
    AGENTS_WORKSPACE: state.workspaceDir,
    AGENTS_CLIS: state.clisDir,
    AGENTS_HARNESSES: state.harnessesDir,
    AGENTS_SKILLS: state.skillsDir,
    AGENTS_PLUGINS: state.pluginsDir,
    AGENTS_HOOKS: state.hooksDir,
    AGENTS_TEMPLATES: state.templatesDir,
    AGENTS_SECRETS: state.secretsDir,
    AGENTS_ORCHESTRATOR: state.orchestratorDir,
    AGENTS_MEMORY: path.join(state.stateDir, "memory"),
    AGENTS_CREDITS: state.creditsFile,
    AGENTS_DATA_REPOS: state.dataReposFile,
    AGENTS_SYSTEM_DATA_ROOT: systemDataPath(state.root),
  };
  for (const [name, dir] of Object.entries(spec.homeEnv)) env[name] = path.join(state.clisDir, dir);
  return env;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
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
    const verification = await verifyProviderRegistration(registration);
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
  for (const credentialPath of spec.credentialPaths) {
    const target = path.join(root, credentialPath);
    if (!(await exists(target))) {
      notes.push(`credential not present in canonical provider home: ${credentialPath}`);
    }
  }
  return { id, home: root, binary, ok: binary !== null, pinned: Boolean(registration), notes };
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

  const env = { ...canonicalChildEnvironment(), ...adapterEnv(state, id) };
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
  return registration;
}
