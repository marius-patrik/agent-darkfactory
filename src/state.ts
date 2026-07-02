import path from "node:path";
import { mkdir } from "node:fs/promises";

export type InstallKind = "agent" | "harness" | "cli" | "skill" | "plugin" | "hook" | "template";

export interface InstallRecord {
  name: string;
  kind: InstallKind;
  source: string;
  path: string;
  installedAt: string;
}

export interface CreditStore {
  schemaVersion: 1;
  balances: Record<string, number>;
  providers: Record<
    string,
    {
      balance?: number;
      softLimit?: number;
      requests?: number;
      tokensIn?: number;
      tokensOut?: number;
      windowStartedAt?: string;
      windowSeconds?: number;
    }
  >;
  ledger: Array<{
    provider: string;
    consumer: string;
    action: "credit" | "debit" | "usage";
    amount?: number;
    tokensIn?: number;
    tokensOut?: number;
    at: string;
    note?: string;
  }>;
  updatedAt: string;
}

export interface SharedState {
  root: string;
  stateDir: string;
  clisDir: string;
  harnessesDir: string;
  skillsDir: string;
  pluginsDir: string;
  hooksDir: string;
  templatesDir: string;
  creditsFile: string;
  installsFile: string;
  packagesFile: string;
  envFile: string;
}

export function sharedState(root: string): SharedState {
  const stateDir = path.join(root, ".agents");
  return {
    root,
    stateDir,
    clisDir: path.join(stateDir, "clis"),
    harnessesDir: path.join(stateDir, "harnesses"),
    skillsDir: path.join(stateDir, "skills"),
    pluginsDir: path.join(stateDir, "plugins"),
    hooksDir: path.join(stateDir, "hooks"),
    templatesDir: path.join(stateDir, "templates"),
    creditsFile: path.join(stateDir, "credits.json"),
    installsFile: path.join(stateDir, "installs.json"),
    packagesFile: path.join(stateDir, "packages.json"),
    envFile: path.join(stateDir, "env"),
  };
}

export async function ensureSharedState(state: SharedState): Promise<void> {
  await Promise.all([
    mkdir(state.clisDir, { recursive: true }),
    mkdir(state.harnessesDir, { recursive: true }),
    mkdir(state.skillsDir, { recursive: true }),
    mkdir(state.pluginsDir, { recursive: true }),
    mkdir(state.hooksDir, { recursive: true }),
    mkdir(state.templatesDir, { recursive: true }),
  ]);

  if (!(await Bun.file(state.installsFile).exists())) {
    await Bun.write(state.installsFile, "[]\n");
  }

  if (!(await Bun.file(state.creditsFile).exists())) {
    const credits: CreditStore = {
      schemaVersion: 1,
      balances: {},
      providers: {},
      ledger: [],
      updatedAt: new Date().toISOString(),
    };
    await Bun.write(state.creditsFile, `${JSON.stringify(credits, null, 2)}\n`);
  }

  if (!(await Bun.file(state.packagesFile).exists())) {
    await Bun.write(state.packagesFile, "[]\n");
  }

  await Bun.write(
    state.envFile,
    [
      `AGENTS_HOME=${state.stateDir}`,
      `AGENTS_CLIS=${state.clisDir}`,
      `AGENTS_HARNESSES=${state.harnessesDir}`,
      `AGENTS_SKILLS=${state.skillsDir}`,
      `AGENTS_PLUGINS=${state.pluginsDir}`,
      `AGENTS_HOOKS=${state.hooksDir}`,
      `AGENTS_TEMPLATES=${state.templatesDir}`,
      `AGENTS_CREDITS=${state.creditsFile}`,
      "",
    ].join("\n"),
  );
}

export async function readInstalls(state: SharedState): Promise<InstallRecord[]> {
  if (!(await Bun.file(state.installsFile).exists())) return [];
  return JSON.parse(await Bun.file(state.installsFile).text()) as InstallRecord[];
}

export async function writeInstalls(state: SharedState, installs: InstallRecord[]): Promise<void> {
  await Bun.write(state.installsFile, `${JSON.stringify(installs, null, 2)}\n`);
}
