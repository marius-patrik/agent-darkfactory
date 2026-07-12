import path from "node:path";
import { chmod, mkdir } from "node:fs/promises";
import { resolveRuntimeAgentsHome, resolveUserHome, type RuntimePathEnv } from "./runtime-paths";
import { ensureStateV2, writeTextAtomic, writeTextExclusive, writeTextIfChanged } from "./state-v2";
import { withStateFileLock } from "./state-lock";

export const SYSTEM_DATA_REPO_ID = "agent-os-data";
export const SYSTEM_DATA_REPOSITORY = "marius-patrik/agents-data";
export const SYSTEM_DATA_ENV = "AGENTS_SYSTEM_DATA_ROOT";
export const SYSTEM_DATA_RELATIVE_PATH = path.join("data", "agent-os");

export function systemDataPath(root: string): string {
  return path.join(root, SYSTEM_DATA_RELATIVE_PATH);
}

export type InstallKind =
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
  sha256: string;
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
  userHome: string;
  stateDir: string;
  workspaceDir: string;
  clisDir: string;
  harnessesDir: string;
  skillsDir: string;
  pluginsDir: string;
  hooksDir: string;
  templatesDir: string;
  secretsDir: string;
  sessionsDir: string;
  orchestratorDir: string;
  creditsFile: string;
  installsFile: string;
  packagesFile: string;
  environmentsFile: string;
  dataReposFile: string;
  configFile: string;
  envFile: string;
}

export interface SessionConfig {
  schemaVersion: 1;
  defaultProvider?: string;
  defaultModel?: string;
  defaultMode?: "orchestrator" | "default";
  providerModels?: Record<string, string[]>;
}

export function sharedStateAt(root: string, stateDir: string, userHome = resolveUserHome()): SharedState {
  return {
    root,
    userHome,
    stateDir,
    workspaceDir: path.join(stateDir, "runtime", "workspaces"),
    clisDir: path.join(stateDir, "clis"),
    harnessesDir: path.join(stateDir, "harnesses"),
    skillsDir: path.join(stateDir, "skills"),
    pluginsDir: path.join(stateDir, "plugins"),
    hooksDir: path.join(stateDir, "hooks"),
    templatesDir: path.join(stateDir, "templates"),
    secretsDir: path.join(stateDir, "secrets"),
    sessionsDir: path.join(stateDir, "sessions"),
    orchestratorDir: path.join(stateDir, "orchestrator"),
    creditsFile: path.join(stateDir, "credits.json"),
    installsFile: path.join(stateDir, "installs.json"),
    packagesFile: path.join(stateDir, "packages.json"),
    environmentsFile: path.join(stateDir, "environments.json"),
    dataReposFile: path.join(stateDir, "data-repos.json"),
    configFile: path.join(stateDir, "config.json"),
    envFile: path.join(stateDir, "env"),
  };
}

export function sharedState(root: string): SharedState {
  return sharedStateAt(root, path.join(root, ".agents"));
}

export function sharedStateFromEnv(cwd: string, env: RuntimePathEnv = process.env): SharedState {
  const stateDir = resolveRuntimeAgentsHome(cwd, env);
  const root = env.AGENTS_ROOT?.trim() ? path.resolve(env.AGENTS_ROOT.trim()) : path.resolve(cwd);
  const userHome = resolveUserHome(env);
  return {
    ...sharedStateAt(root, stateDir, userHome),
    clisDir: env.AGENTS_CLIS?.trim() || path.join(stateDir, "clis"),
    harnessesDir: env.AGENTS_HARNESSES?.trim() || path.join(stateDir, "harnesses"),
    skillsDir: env.AGENTS_SKILLS?.trim() || path.join(stateDir, "skills"),
    pluginsDir: env.AGENTS_PLUGINS?.trim() || path.join(stateDir, "plugins"),
    hooksDir: env.AGENTS_HOOKS?.trim() || path.join(stateDir, "hooks"),
    templatesDir: env.AGENTS_TEMPLATES?.trim() || path.join(stateDir, "templates"),
    secretsDir: env.AGENTS_SECRETS?.trim() || path.join(stateDir, "secrets"),
    sessionsDir: env.AGENTS_SESSIONS?.trim() || path.join(stateDir, "sessions"),
    orchestratorDir: env.AGENTS_ORCHESTRATOR?.trim() || path.join(stateDir, "orchestrator"),
    creditsFile: env.AGENTS_CREDITS?.trim() || path.join(stateDir, "credits.json"),
    dataReposFile: env.AGENTS_DATA_REPOS?.trim() || path.join(stateDir, "data-repos.json"),
    environmentsFile: env.AGENTS_ENVIRONMENTS?.trim() || path.join(stateDir, "environments.json"),
    configFile: env.AGENTS_CONFIG?.trim() || path.join(stateDir, "config.json"),
  };
}

export async function ensureSharedState(state: SharedState): Promise<void> {
  const privateDirectories = [
    state.stateDir,
    state.clisDir,
    state.harnessesDir,
    state.skillsDir,
    state.pluginsDir,
    state.hooksDir,
    state.templatesDir,
    state.secretsDir,
    state.sessionsDir,
    state.orchestratorDir,
    state.workspaceDir,
  ];
  await Promise.all(privateDirectories.map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
  if (process.platform !== "win32") {
    await Promise.all(privateDirectories.map((directory) => chmod(directory, 0o700)));
  }

  await ensureStateV2(state);

  await writeTextExclusive(state.installsFile, "[]\n");

  const credits: CreditStore = {
    schemaVersion: 1,
    balances: {},
    providers: {},
    ledger: [],
    updatedAt: new Date().toISOString(),
  };
  await writeTextExclusive(state.creditsFile, `${JSON.stringify(credits, null, 2)}\n`);

  await writeTextExclusive(state.packagesFile, "[]\n");

  await writeTextExclusive(
    state.environmentsFile,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        distroPackages: [],
        containerPackages: [],
        environments: [],
        containers: [],
      },
      null,
      2,
    )}\n`,
  );

  await writeTextExclusive(
    state.dataReposFile,
    `${JSON.stringify(
      [
        {
          id: SYSTEM_DATA_REPO_ID,
          repo: SYSTEM_DATA_REPOSITORY,
          path: systemDataPath(state.root),
          branch: "main",
          env: SYSTEM_DATA_ENV,
          configuredAt: new Date().toISOString(),
        },
      ],
      null,
      2,
    )}\n`,
  );

  await writeTextExclusive(state.configFile, `${JSON.stringify({ schemaVersion: 1 }, null, 2)}\n`);

  await writeTextIfChanged(
    state.envFile,
    [
      `AGENTS_HOME=${state.stateDir}`,
      `AGENTS_USER_HOME=${state.userHome}`,
      `AGENTS_ROOT=${state.root}`,
      `AGENTS_WORKSPACE=${state.workspaceDir}`,
      `AGENTS_CLIS=${state.clisDir}`,
      `AGENTS_HARNESSES=${state.harnessesDir}`,
      `AGENTS_SKILLS=${state.skillsDir}`,
      `AGENTS_PLUGINS=${state.pluginsDir}`,
      `AGENTS_HOOKS=${state.hooksDir}`,
      `AGENTS_TEMPLATES=${state.templatesDir}`,
      `AGENTS_SECRETS=${state.secretsDir}`,
      `AGENTS_SESSIONS=${state.sessionsDir}`,
      `AGENTS_IDENTITY=${path.join(state.stateDir, "identity")}`,
      `AGENTS_MEMORY=${path.join(state.stateDir, "memory")}`,
      `AGENTS_ORCHESTRATOR=${state.orchestratorDir}`,
      `AGENTS_CREDITS=${state.creditsFile}`,
      `AGENTS_DATA_REPOS=${state.dataReposFile}`,
      `AGENTS_ENVIRONMENTS=${state.environmentsFile}`,
      `AGENTS_CONFIG=${state.configFile}`,
      `${SYSTEM_DATA_ENV}=${systemDataPath(state.root)}`,
      "",
    ].join("\n"),
  );

  if (process.platform !== "win32") {
    const privateFiles = [
      state.installsFile,
      state.creditsFile,
      state.packagesFile,
      state.environmentsFile,
      state.dataReposFile,
      state.configFile,
      state.envFile,
    ];
    await Promise.all(privateFiles.map((file) => chmod(file, 0o600)));
  }
}

export async function readInstalls(state: SharedState): Promise<InstallRecord[]> {
  if (!(await Bun.file(state.installsFile).exists())) return [];
  const parsed = JSON.parse(await Bun.file(state.installsFile).text()) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`invalid install registry: ${state.installsFile}`);
  const kinds = new Set<InstallKind>([
    "app", "data", "package", "workspace", "harness", "cli", "skill", "plugin", "hook", "template",
  ]);
  const keys = new Set<string>();
  for (const record of parsed) {
    const key = `${record?.kind}/${record?.name}`;
    if (
      !record ||
      typeof record !== "object" ||
      typeof record.name !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(record.name) ||
      typeof record.kind !== "string" ||
      !kinds.has(record.kind as InstallKind) ||
      typeof record.source !== "string" ||
      !record.source ||
      typeof record.path !== "string" ||
      !path.isAbsolute(record.path) ||
      typeof record.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(record.sha256) ||
      typeof record.installedAt !== "string" ||
      new Date(record.installedAt).toISOString() !== record.installedAt ||
      keys.has(key)
    ) {
      throw new Error(`invalid install registry record: ${state.installsFile}`);
    }
    keys.add(key);
  }
  return parsed as InstallRecord[];
}

export async function writeInstalls(state: SharedState, installs: InstallRecord[]): Promise<void> {
  await withStateFileLock(state, "installs", () =>
    writeTextAtomic(state.installsFile, `${JSON.stringify(installs, null, 2)}\n`),
  );
}

const SAFE_REGISTRY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizedIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validateCreditStore(value: unknown, source: string): CreditStore {
  if (!plainObject(value)) throw new Error(`invalid credit store: ${source}`);
  const store = value as Partial<CreditStore>;
  if (
    store.schemaVersion !== 1 ||
    !plainObject(store.balances) ||
    !plainObject(store.providers) ||
    !Array.isArray(store.ledger) ||
    !normalizedIso(store.updatedAt)
  ) {
    throw new Error(`invalid credit store schema: ${source}`);
  }

  for (const [consumer, balance] of Object.entries(store.balances)) {
    if (!SAFE_REGISTRY_ID.test(consumer) || !finiteNumber(balance)) {
      throw new Error(`invalid credit balance for ${consumer || "<empty>"}: ${source}`);
    }
  }
  for (const [provider, rawRecord] of Object.entries(store.providers)) {
    if (!SAFE_REGISTRY_ID.test(provider) || !plainObject(rawRecord)) {
      throw new Error(`invalid credit provider ${provider || "<empty>"}: ${source}`);
    }
    const record = rawRecord as NonNullable<CreditStore["providers"][string]>;
    if (record.balance !== undefined && !finiteNumber(record.balance)) throw new Error(`invalid provider balance: ${provider}`);
    if (record.softLimit !== undefined && (!finiteNumber(record.softLimit) || record.softLimit < 0)) {
      throw new Error(`invalid provider soft limit: ${provider}`);
    }
    for (const field of ["requests", "tokensIn", "tokensOut", "windowSeconds"] as const) {
      if (record[field] !== undefined && !nonNegativeInteger(record[field])) {
        throw new Error(`invalid provider ${field}: ${provider}`);
      }
    }
    if (record.windowStartedAt !== undefined && !normalizedIso(record.windowStartedAt)) {
      throw new Error(`invalid provider windowStartedAt: ${provider}`);
    }
  }

  for (const [index, rawEntry] of store.ledger.entries()) {
    if (!plainObject(rawEntry)) throw new Error(`invalid credit ledger entry ${index}: ${source}`);
    const entry = rawEntry as Partial<CreditLedgerEntry>;
    if (
      typeof entry.provider !== "string" ||
      !SAFE_REGISTRY_ID.test(entry.provider) ||
      typeof entry.consumer !== "string" ||
      !SAFE_REGISTRY_ID.test(entry.consumer) ||
      !entry.action ||
      !new Set(["credit", "debit", "usage"]).has(entry.action) ||
      !normalizedIso(entry.at)
    ) {
      throw new Error(`invalid credit ledger entry ${index}: ${source}`);
    }
    if (entry.amount !== undefined && (!finiteNumber(entry.amount) || entry.amount <= 0)) {
      throw new Error(`invalid credit ledger amount ${index}: ${source}`);
    }
    for (const field of ["tokensIn", "tokensOut"] as const) {
      if (entry[field] !== undefined && !nonNegativeInteger(entry[field])) {
        throw new Error(`invalid credit ledger ${field} ${index}: ${source}`);
      }
    }
    if (entry.action !== "usage" && entry.amount === undefined) {
      throw new Error(`credit or debit ledger entry requires amount ${index}: ${source}`);
    }
    if (entry.action === "usage" && entry.amount === undefined && entry.tokensIn === undefined && entry.tokensOut === undefined) {
      throw new Error(`usage ledger entry has no usage ${index}: ${source}`);
    }
    if (entry.note !== undefined && (typeof entry.note !== "string" || !entry.note.trim() || entry.note.includes("\0"))) {
      throw new Error(`invalid credit ledger note ${index}: ${source}`);
    }
  }
  return structuredClone(value) as unknown as CreditStore;
}

export async function readCreditStore(state: SharedState): Promise<CreditStore> {
  return validateCreditStore(JSON.parse(await Bun.file(state.creditsFile).text()), state.creditsFile);
}

export async function writeCreditStore(state: SharedState, store: CreditStore): Promise<void> {
  const validated = validateCreditStore(store, state.creditsFile);
  await withStateFileLock(state, "credits", () =>
    writeTextAtomic(state.creditsFile, `${JSON.stringify(validated, null, 2)}\n`),
  );
}

export async function updateCreditStore<T>(
  state: SharedState,
  update: (store: CreditStore) => T | Promise<T>,
): Promise<T> {
  return withStateFileLock(state, "credits", async () => {
    const store = await readCreditStore(state);
    const result = await update(store);
    const validated = validateCreditStore(store, state.creditsFile);
    await writeTextAtomic(state.creditsFile, `${JSON.stringify(validated, null, 2)}\n`);
    return result;
  });
}

function validateSessionConfig(config: Partial<SessionConfig>, source: string): SessionConfig {
  if (config.schemaVersion !== 1) throw new Error(`canonical config has an invalid schema: ${source}`);
  if ((config.defaultProvider === undefined) !== (config.defaultModel === undefined)) {
    throw new Error("canonical config must set defaultProvider and defaultModel together");
  }
  for (const [field, value] of [
    ["defaultProvider", config.defaultProvider],
    ["defaultModel", config.defaultModel],
  ] as const) {
    if (value !== undefined && (!value.trim() || value.includes("\0"))) {
      throw new Error(`canonical config ${field} must be a non-empty string`);
    }
  }
  if (config.defaultModel === "default") throw new Error("canonical config uses the retired default model sentinel");
  if (config.defaultMode !== undefined && config.defaultMode !== "default" && config.defaultMode !== "orchestrator") {
    throw new Error("canonical config defaultMode is invalid");
  }
  if (config.providerModels !== undefined) {
    if (!config.providerModels || typeof config.providerModels !== "object" || Array.isArray(config.providerModels)) {
      throw new Error("canonical config providerModels must be an object");
    }
    for (const [provider, models] of Object.entries(config.providerModels)) {
      if (!provider.trim() || !Array.isArray(models) || models.length === 0) {
        throw new Error(`canonical config providerModels.${provider || "<empty>"} must be a non-empty array`);
      }
      if (
        new Set(models).size !== models.length ||
        models.some((model) => typeof model !== "string" || !model.trim() || model === "default")
      ) {
        throw new Error(`canonical config providerModels.${provider} contains an invalid or duplicate model`);
      }
    }
  }
  if (config.defaultProvider && config.defaultModel) {
    const configured = config.providerModels?.[config.defaultProvider];
    if (configured && !configured.includes(config.defaultModel)) {
      throw new Error("canonical config defaultModel is not registered for defaultProvider");
    }
  }
  return structuredClone(config) as SessionConfig;
}

export async function readSessionConfig(state: SharedState): Promise<SessionConfig> {
  if (!(await Bun.file(state.configFile).exists())) throw new Error(`canonical config is missing: ${state.configFile}`);
  const config = JSON.parse(await Bun.file(state.configFile).text()) as Partial<SessionConfig>;
  return validateSessionConfig(config, state.configFile);
}

export async function writeSessionConfig(state: SharedState, config: SessionConfig): Promise<void> {
  const validated = validateSessionConfig(config, state.configFile);
  await withStateFileLock(state, "config", () =>
    writeTextAtomic(state.configFile, `${JSON.stringify(validated, null, 2)}\n`),
  );
}

export async function updateSessionConfig(
  state: SharedState,
  update: (config: SessionConfig) => SessionConfig,
): Promise<SessionConfig> {
  return withStateFileLock(state, "config", async () => {
    const next = validateSessionConfig(update(await readSessionConfig(state)), state.configFile);
    await writeTextAtomic(state.configFile, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}
