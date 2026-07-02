import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chmod, copyFile, mkdir, stat } from "node:fs/promises";
import type { SharedState } from "./state";

export type CliId = "codex" | "claude" | "kimi" | "agy";

export interface CredentialMapping {
  source: string;
  target: string;
}

export interface CliAdapter {
  id: CliId;
  displayName: string;
  binaries: string[];
  homeEnv: Record<string, string>;
  credentials: CredentialMapping[];
}

export interface AdapterDoctorResult {
  id: CliId;
  home: string;
  binary: string | null;
  ok: boolean;
  notes: string[];
}

const home = os.homedir();

export const adapters: Record<CliId, CliAdapter> = {
  codex: {
    id: "codex",
    displayName: "Codex",
    binaries: ["codex"],
    homeEnv: { CODEX_HOME: "codex" },
    credentials: [{ source: path.join(home, ".codex", "auth.json"), target: "auth.json" }],
  },
  claude: {
    id: "claude",
    displayName: "Claude",
    binaries: ["claude"],
    homeEnv: { CLAUDE_CONFIG_DIR: "claude" },
    credentials: [{ source: path.join(home, ".claude", ".credentials.json"), target: ".credentials.json" }],
  },
  kimi: {
    id: "kimi",
    displayName: "Kimi",
    binaries: ["kimi", "kimi-code"],
    homeEnv: { KIMI_CODE_HOME: "kimi" },
    credentials: [
      {
        source: path.join(home, ".kimi-code", "credentials", "kimi-code.json"),
        target: path.join("credentials", "kimi-code.json"),
      },
    ],
  },
  agy: {
    id: "agy",
    displayName: "Agy",
    binaries: ["agy", "gemini"],
    homeEnv: { HOME: "agy" },
    credentials: [{ source: path.join(home, ".gemini", "oauth_creds.json"), target: path.join(".gemini", "oauth_creds.json") }],
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
    AGENTS_CLIS: state.clisDir,
    AGENTS_SKILLS: state.skillsDir,
    AGENTS_PLUGINS: state.pluginsDir,
    AGENTS_HOOKS: state.hooksDir,
    AGENTS_TEMPLATES: state.templatesDir,
    AGENTS_CREDITS: state.creditsFile,
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

async function findBinary(names: string[]): Promise<string | null> {
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const name of names) {
    for (const dir of pathDirs) {
      for (const extension of extensions) {
        const candidate = path.join(dir, process.platform === "win32" && !path.extname(name) ? `${name}${extension.toLowerCase()}` : name);
        if (fs.existsSync(candidate)) return candidate;
        const upperCandidate = path.join(
          dir,
          process.platform === "win32" && !path.extname(name) ? `${name}${extension.toUpperCase()}` : name,
        );
        if (fs.existsSync(upperCandidate)) return upperCandidate;
      }
    }
  }
  return null;
}

export async function doctorAdapter(state: SharedState, id: CliId): Promise<AdapterDoctorResult> {
  const spec = adapter(id);
  const root = adapterHome(state, id);
  await mkdir(root, { recursive: true });
  const notes: string[] = [];
  const binary = await findBinary(spec.binaries);
  if (!binary) notes.push(`missing binary: ${spec.binaries.join(" or ")}`);
  for (const cred of spec.credentials) {
    if (!(await exists(cred.source))) notes.push(`credential source not present: ${cred.source}`);
  }
  return { id, home: root, binary, ok: binary !== null, notes };
}

export async function materializeCredentials(state: SharedState, id: CliId): Promise<string[]> {
  const spec = adapter(id);
  const root = adapterHome(state, id);
  const copied: string[] = [];
  for (const cred of spec.credentials) {
    if (!(await exists(cred.source))) continue;
    const target = path.join(root, cred.target);
    await mkdir(path.dirname(target), { recursive: true });
    if (process.platform !== "win32") await chmod(path.dirname(target), 0o700);
    await copyFile(cred.source, target);
    if (process.platform !== "win32") await chmod(target, 0o600);
    copied.push(target);
  }
  return copied;
}
