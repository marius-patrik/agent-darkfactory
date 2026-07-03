import path from "node:path";
import { mkdir } from "node:fs/promises";

const defaultDataPath = path.join("data", "data-agentos");
const defaultDataRepoPath = (root: string) => path.join(root, defaultDataPath);

export type InstallKind =
  | "agent"
  | "app"
  | "data"
  | "package"
  | "workspace"
  | "harness"
  | "cli"
  | "skill"
  | "plugin"
  | "hook"
  | "template";

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

export interface CreditLedgerEntry {
  provider: string;
  consumer: string;
  action: "credit" | "debit" | "usage";
  amount?: number;
  tokensIn?: number;
  tokensOut?: number;
  at: string;
  note?: string;
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
  secretsDir: string;
  creditsFile: string;
  installsFile: string;
  packagesFile: string;
  dataReposFile: string;
  envFile: string;
}

export function sharedStateAt(root: string, stateDir: string): SharedState {
  return {
    root,
    stateDir,
    clisDir: path.join(stateDir, "clis"),
    harnessesDir: path.join(stateDir, "harnesses"),
    skillsDir: path.join(stateDir, "skills"),
    pluginsDir: path.join(stateDir, "plugins"),
    hooksDir: path.join(stateDir, "hooks"),
    templatesDir: path.join(stateDir, "templates"),
    secretsDir: path.join(stateDir, "secrets"),
    creditsFile: path.join(stateDir, "credits.json"),
    installsFile: path.join(stateDir, "installs.json"),
    packagesFile: path.join(stateDir, "packages.json"),
    dataReposFile: path.join(stateDir, "data-repos.json"),
    envFile: path.join(stateDir, "env"),
  };
}

export function sharedState(root: string): SharedState {
  return sharedStateAt(root, path.join(root, ".agents"));
}

export function sharedStateFromEnv(cwd: string): SharedState {
  const envHome = process.env.AGENTS_HOME?.trim();
  if (!envHome) return sharedState(cwd);
  const stateDir = path.resolve(envHome);
  const root = path.dirname(stateDir);
  return {
    ...sharedStateAt(root, stateDir),
    clisDir: process.env.AGENTS_CLIS?.trim() || path.join(stateDir, "clis"),
    harnessesDir: process.env.AGENTS_HARNESSES?.trim() || path.join(stateDir, "harnesses"),
    skillsDir: process.env.AGENTS_SKILLS?.trim() || path.join(stateDir, "skills"),
    pluginsDir: process.env.AGENTS_PLUGINS?.trim() || path.join(stateDir, "plugins"),
    hooksDir: process.env.AGENTS_HOOKS?.trim() || path.join(stateDir, "hooks"),
    templatesDir: process.env.AGENTS_TEMPLATES?.trim() || path.join(stateDir, "templates"),
    secretsDir: process.env.AGENTS_SECRETS?.trim() || path.join(stateDir, "secrets"),
    creditsFile: process.env.AGENTS_CREDITS?.trim() || path.join(stateDir, "credits.json"),
    dataReposFile: process.env.AGENTS_DATA_REPOS?.trim() || path.join(stateDir, "data-repos.json"),
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
    mkdir(state.secretsDir, { recursive: true }),
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

  if (!(await Bun.file(state.dataReposFile).exists())) {
    await Bun.write(
      state.dataReposFile,
      `${JSON.stringify(
        [
          {
            id: "agentos-data",
            repo: "marius-patrik/agentos-data",
            path: defaultDataRepoPath(state.root),
            branch: "main",
            env: "AGENTOS_DATA_ROOT",
            configuredAt: new Date().toISOString(),
          },
        ],
        null,
        2,
      )}\n`,
    );
  }

  await Bun.write(
    state.envFile,
    [
      `AGENTS_HOME=${state.stateDir}`,
      `AGENTS_ROOT=${state.root}`,
      `AGENTS_CLIS=${state.clisDir}`,
      `AGENTS_HARNESSES=${state.harnessesDir}`,
      `AGENTS_SKILLS=${state.skillsDir}`,
      `AGENTS_PLUGINS=${state.pluginsDir}`,
      `AGENTS_HOOKS=${state.hooksDir}`,
      `AGENTS_TEMPLATES=${state.templatesDir}`,
      `AGENTS_SECRETS=${state.secretsDir}`,
      `AGENTS_CREDITS=${state.creditsFile}`,
      `AGENTS_DATA_REPOS=${state.dataReposFile}`,
      `AGENTOS_DATA_ROOT=${defaultDataRepoPath(state.root)}`,
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

export async function readCreditStore(state: SharedState): Promise<CreditStore> {
  return JSON.parse(await Bun.file(state.creditsFile).text()) as CreditStore;
}

export async function writeCreditStore(state: SharedState, store: CreditStore): Promise<void> {
  await Bun.write(state.creditsFile, `${JSON.stringify(store, null, 2)}\n`);
}

