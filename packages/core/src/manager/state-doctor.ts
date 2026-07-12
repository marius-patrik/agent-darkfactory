import path from "node:path";
import { lstat, readdir, readFile } from "node:fs/promises";
import type { SharedState } from "./state";
import { readCreditStore, readSessionConfig, systemDataPath } from "./state";
import { readStateManifest, stateV2Paths, type AgentStateManifest } from "./state-v2";
import { readToolStatus, toolStateSpecs, type ToolStatus } from "./state-consolidation";
import { readProviderRegistry, verifyProviderRegistration, type ProviderId } from "./provider-registry";
import { inspectMemoryIntegrity } from "./memory";
import { inspectSessionIntegrity } from "../harness/session";
import { inspectOrchestratorIntegrity } from "./orchestrator";
import { inspectCapabilityIntegrity } from "./capabilities";
import { inspectSourceInstall } from "./source-install";
import { readPackageRegistrations } from "./packages";
import { readDataRepos } from "./data-repos";
import { readPackagesAndEnvironmentsState } from "./environments";

export interface StateDoctorCheck {
  id:
    | "state_root"
    | "manifest"
    | "tool_roots"
    | "provider_registry"
    | "retired_state"
    | "memory_integrity"
    | "session_integrity"
    | "orchestrator_integrity"
    | "capability_integrity"
    | "registry_integrity"
    | "launcher"
    | "source_install"
    | "permissions"
    | "generated_env"
    | "sync_safety";
  ok: boolean;
  message: string;
  details?: Record<string, unknown>;
}

export interface StateDoctorReport {
  ok: boolean;
  stateRoot: string;
  checks: StateDoctorCheck[];
  tools: ToolStatus[];
}

interface PermissionIssue {
  path: string;
  kind: "directory" | "file" | "symlink" | "other" | "unreadable";
  mode: string | null;
}

const permissionScanLimit = 100_000;
const permissionScanDepth = 32;
const reportedPermissionIssueLimit = 50;

function modeString(mode: number): string {
  return `0o${(mode & 0o777).toString(8).padStart(3, "0")}`;
}

async function pathKind(filePath: string): Promise<"directory" | "file" | "other" | "missing"> {
  try {
    const info = await lstat(filePath);
    if (info.isDirectory()) return "directory";
    if (info.isFile()) return "file";
    return "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    return "other";
  }
}

async function inspectPrivatePath(
  filePath: string,
  stateRoot: string,
  recursive: boolean,
): Promise<{ checked: number; truncated: boolean; issues: PermissionIssue[] }> {
  let checked = 0;
  let truncated = false;
  const issues: PermissionIssue[] = [];
  const queue: Array<{ filePath: string; depth: number }> = [{ filePath, depth: 0 }];

  while (queue.length > 0) {
    if (checked >= permissionScanLimit) {
      truncated = true;
      break;
    }

    const current = queue.shift()!;
    let info;
    try {
      info = await lstat(current.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        issues.push({
          path: path.relative(stateRoot, current.filePath) || ".",
          kind: "unreadable",
          mode: null,
        });
      }
      continue;
    }

    checked += 1;
    if (info.isSymbolicLink()) {
      issues.push({ path: path.relative(stateRoot, current.filePath) || ".", kind: "symlink", mode: modeString(info.mode) });
      continue;
    }
    const kind = info.isDirectory() ? "directory" : info.isFile() ? "file" : null;
    if (!kind) {
      issues.push({ path: path.relative(stateRoot, current.filePath) || ".", kind: "other", mode: modeString(info.mode) });
      continue;
    }
    if (kind && process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      issues.push({
        path: path.relative(stateRoot, current.filePath) || ".",
        kind,
        mode: modeString(info.mode),
      });
    }

    if (!recursive || !info.isDirectory() || current.depth >= permissionScanDepth) continue;
    let names: string[];
    try {
      names = (await readdir(current.filePath)).sort((left, right) => left.localeCompare(right));
    } catch {
      issues.push({
        path: path.relative(stateRoot, current.filePath) || ".",
        kind: "unreadable",
        mode: modeString(info.mode),
      });
      continue;
    }
    for (const name of names) queue.push({ filePath: path.join(current.filePath, name), depth: current.depth + 1 });
  }

  return { checked, truncated, issues };
}

async function manifestCheck(state: SharedState): Promise<StateDoctorCheck> {
  try {
    const manifest: AgentStateManifest | null = await readStateManifest(state);
    if (!manifest) {
      return { id: "manifest", ok: false, message: "v2 manifest is missing" };
    }
    return {
      id: "manifest",
      ok: true,
      message: `v${manifest.schemaVersion} manifest is valid for ${manifest.agentId}`,
      details: {
        schemaVersion: manifest.schemaVersion,
        installId: manifest.installId,
        machineId: manifest.machineId,
        agentId: manifest.agentId,
        createdAt: manifest.createdAt,
      },
    };
  } catch (error) {
    return {
      id: "manifest",
      ok: false,
      message: `v2 manifest is invalid: ${(error as Error).message}`,
    };
  }
}

async function permissionsCheck(state: SharedState, tools: ToolStatus[], stateRoot: string): Promise<StateDoctorCheck> {
  if (process.platform === "win32") {
    return {
      id: "permissions",
      ok: true,
      message: "POSIX private-mode checks are not supported on Windows",
      details: { supported: false, checked: 0, truncatedScopes: [] },
    };
  }

  const paths = stateV2Paths(state);
  const scopes: Array<{ filePath: string; recursive: boolean }> = [
    { filePath: state.stateDir, recursive: false },
    { filePath: paths.manifestFile, recursive: false },
    { filePath: state.envFile, recursive: false },
    { filePath: state.configFile, recursive: false },
    { filePath: state.installsFile, recursive: false },
    { filePath: state.packagesFile, recursive: false },
    { filePath: state.dataReposFile, recursive: false },
    { filePath: state.environmentsFile, recursive: false },
    { filePath: state.creditsFile, recursive: false },
    { filePath: paths.providersFile, recursive: false },
    { filePath: paths.identityDir, recursive: true },
    { filePath: paths.memoryDir, recursive: true },
    { filePath: state.sessionsDir, recursive: true },
    { filePath: state.orchestratorDir, recursive: true },
    { filePath: state.skillsDir, recursive: true },
    { filePath: paths.capabilityStoreDir, recursive: true },
    { filePath: state.secretsDir, recursive: true },
    { filePath: paths.provenanceDir, recursive: true },
    { filePath: state.clisDir, recursive: false },
    // Provider homes contain executable/vendor assets with intentionally varied
    // modes. A private canonical root is the security boundary; canonical
    // Agent OS memory/session trees remain recursively strict above.
    ...tools.filter((tool) => tool.id !== "agents").map((tool) => ({ filePath: tool.canonical, recursive: false })),
  ];
  const seen = new Set<string>();
  let checked = 0;
  const truncatedScopes: string[] = [];
  const issues: PermissionIssue[] = [];

  for (const scope of scopes) {
    const normalized = path.resolve(scope.filePath);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const result = await inspectPrivatePath(normalized, stateRoot, scope.recursive);
    checked += result.checked;
    if (result.truncated) truncatedScopes.push(path.relative(stateRoot, normalized) || ".");
    issues.push(...result.issues);
  }

  const shown = issues.slice(0, reportedPermissionIssueLimit);
  return {
    id: "permissions",
    ok: issues.length === 0 && truncatedScopes.length === 0,
    message:
      issues.length === 0 && truncatedScopes.length === 0
        ? `private modes are safe across ${checked} checked path(s)`
        : truncatedScopes.length > 0
          ? `private-mode inspection was truncated in ${truncatedScopes.length} scope(s)`
          : `${issues.length} private path(s) expose group/other access, are symlinks, or are unreadable`,
    details: {
      supported: true,
      checked,
      maxEntriesPerScope: permissionScanLimit,
      maxDepth: permissionScanDepth,
      truncatedScopes,
      issues: shown,
      omittedIssues: Math.max(0, issues.length - shown.length),
    },
  };
}

async function syncSafetyCheck(state: SharedState): Promise<StateDoctorCheck> {
  const paths = stateV2Paths(state);
  const configPath = path.join(paths.syncDir, "config.json");
  const importsPath = path.join(paths.syncDir, "imports");
  const syncKeyPath = path.join(state.secretsDir, "AGENTS_SYNC_KEY.secret");
  const retiredConfigPath = path.join(state.stateDir, "state-sync.json");
  const retiredRepoPath = path.join(state.stateDir, "state-repo");
  const [configKind, retiredConfigKind, retiredRepoKind] = await Promise.all([
    pathKind(configPath),
    pathKind(retiredConfigPath),
    pathKind(retiredRepoPath),
  ]);

  let schemaVersion: number | null = null;
  let enabled: boolean | null = null;
  let transport: string | null | undefined;
  let transportValid = false;
  let parseError: string | null = null;
  if (configKind === "file") {
    try {
      const parsed = JSON.parse(await readFile(configPath, "utf8")) as { schemaVersion?: unknown; enabled?: unknown; transport?: unknown };
      schemaVersion = typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : null;
      enabled = typeof parsed.enabled === "boolean" ? parsed.enabled : null;
      if (parsed.transport === null || typeof parsed.transport === "string") {
        transport = parsed.transport;
        transportValid = true;
      }
    } catch (error) {
      parseError = (error as Error).message;
    }
  }

  const disabled =
    configKind === "file" &&
    parseError === null &&
    schemaVersion === 2 &&
    enabled === false &&
    transportValid &&
    transport === null;
  const [keyKind, importsKind] = await Promise.all([pathKind(syncKeyPath), pathKind(importsPath)]);
  let keyValid = false;
  if (keyKind === "file") {
    try {
      keyValid = /^[a-fA-F0-9]{64}$/.test((await readFile(syncKeyPath, "utf8")).trim());
    } catch {
      keyValid = false;
    }
  }
  let preparedImports = 0;
  const importJournalIssues: string[] = [];
  if (importsKind === "directory") {
    for (const entry of await readdir(importsPath, { withFileTypes: true })) {
      const match = entry.name.match(/^([a-f0-9]{64})\.json$/);
      if (!entry.isFile() || entry.isSymbolicLink() || !match) {
        importJournalIssues.push(`invalid import journal entry: ${entry.name}`);
        continue;
      }
      try {
        const journal = JSON.parse(await readFile(path.join(importsPath, entry.name), "utf8")) as {
          schemaVersion?: unknown;
          payloadHash?: unknown;
          state?: unknown;
          paths?: unknown;
        };
        if (
          journal.schemaVersion !== 1 ||
          journal.payloadHash !== match[1] ||
          (journal.state !== "prepared" && journal.state !== "committed") ||
          !Array.isArray(journal.paths)
        ) {
          importJournalIssues.push(`malformed import journal: ${entry.name}`);
          continue;
        }
        if (journal.state === "prepared") preparedImports += 1;
      } catch (error) {
        importJournalIssues.push(`unreadable import journal ${entry.name}: ${(error as Error).message}`);
      }
    }
  }
  const importsSafe =
    (importsKind === "missing" || importsKind === "directory") &&
    preparedImports === 0 &&
    importJournalIssues.length === 0;
  const enabledSafely =
    configKind === "file" &&
    parseError === null &&
    schemaVersion === 2 &&
    enabled === true &&
    transportValid &&
    transport === "encrypted-bundle" &&
    keyValid &&
    importsKind === "directory" &&
    importsSafe;
  const retiredArtifacts = [retiredConfigKind !== "missing" ? "state-sync.json" : null, retiredRepoKind !== "missing" ? "state-repo" : null].filter(
    (item): item is string => item !== null,
  );
  const ok = ((disabled && importsSafe) || enabledSafely) && retiredArtifacts.length === 0;
  return {
    id: "sync_safety",
    ok,
    message: ok
      ? enabledSafely
        ? "encrypted event exchange is enabled with local key material and no interrupted imports"
        : "event exchange is disabled and no retired sync artifacts exist"
      : retiredArtifacts.length > 0
        ? `retired sync artifacts are present: ${retiredArtifacts.join(", ")}`
        : "event exchange safety cannot be verified",
    details: {
      configPresent: configKind === "file",
      configValid: configKind === "file" && parseError === null && schemaVersion === 2 && enabled !== null,
      schemaVersion,
      enabled,
      transport,
      transportValid,
      keyPresent: keyKind === "file",
      keyValid,
      importsDirectoryPresent: importsKind === "directory",
      preparedImports,
      importJournalIssues,
      retiredConfigPresent: retiredConfigKind !== "missing",
      retiredRepoPresent: retiredRepoKind !== "missing",
      parseError,
    },
  };
}

async function providerRegistryCheck(state: SharedState, tools: ToolStatus[]): Promise<StateDoctorCheck> {
  try {
    const registry = await readProviderRegistry(state);
    const installed = tools.filter(
      (tool): tool is ToolStatus & { id: ProviderId } =>
        tool.id !== "agents" && (tool.location === "canonical" || tool.location === "app-owned" || tool.location === "split"),
    );
    const failures: Array<{ id: ProviderId; issues: string[] }> = [];
    const verified: Array<{ id: ProviderId; version: string; executable: string }> = [];
    for (const tool of installed) {
      const registration = registry.providers[tool.id];
      if (!registration) {
        failures.push({ id: tool.id, issues: ["provider executable is not pinned"] });
        continue;
      }
      const result = await verifyProviderRegistration(registration);
      if (!result.ok) failures.push({ id: tool.id, issues: result.issues });
      else verified.push({ id: tool.id, version: registration.version, executable: registration.executable });
    }
    return {
      id: "provider_registry",
      ok: failures.length === 0,
      message:
        failures.length === 0
          ? `${verified.length} installed provider executable(s) are pinned and checksum-verified`
          : `provider executable drift: ${failures.map((failure) => failure.id).join(", ")}`,
      details: { verified, failures },
    };
  } catch (error) {
    return { id: "provider_registry", ok: false, message: `provider registry is invalid: ${(error as Error).message}` };
  }
}

async function memoryIntegrityCheck(state: SharedState): Promise<StateDoctorCheck> {
  try {
    const inspection = await inspectMemoryIntegrity(state);
    return {
      id: "memory_integrity",
      ok: inspection.ok,
      message: inspection.ok
        ? `${inspection.events} immutable event(s) replay to ${inspection.records} verified projection record(s)`
        : inspection.eventIntegrity
          ? "canonical memory events replay, but generated projections do not match"
          : "canonical memory event integrity or replay failed",
      details: { ...inspection },
    };
  } catch (error) {
    return {
      id: "memory_integrity",
      ok: false,
      message: `canonical memory integrity inspection failed: ${(error as Error).message}`,
    };
  }
}

async function sessionIntegrityCheck(state: SharedState): Promise<StateDoctorCheck> {
  try {
    const inspection = await inspectSessionIntegrity(state);
    return {
      id: "session_integrity",
      ok: inspection.ok,
      message: inspection.ok
        ? `${inspection.sessions} session(s) and ${inspection.events} immutable event(s) are internally consistent`
        : inspection.eventIntegrity
          ? "canonical session events replay, but generated projections do not match"
          : "canonical session event integrity or replay failed",
      details: { ...inspection },
    };
  } catch (error) {
    return { id: "session_integrity", ok: false, message: `session integrity inspection failed: ${(error as Error).message}` };
  }
}

async function orchestratorIntegrityCheck(state: SharedState): Promise<StateDoctorCheck> {
  try {
    const inspection = await inspectOrchestratorIntegrity(state);
    return {
      id: "orchestrator_integrity",
      ok: inspection.ok,
      message: inspection.ok
        ? inspection.authority === "none"
          ? "orchestrator has no active authority"
          : `${inspection.events} orchestrator event(s) project a ${inspection.authority} baton for ${inspection.holder}`
        : inspection.authority === "expired"
          ? `active orchestrator authority expired for ${inspection.holder}`
          : "canonical orchestrator integrity or projection validation failed",
      details: { ...inspection },
    };
  } catch (error) {
    return { id: "orchestrator_integrity", ok: false, message: `orchestrator integrity inspection failed: ${(error as Error).message}` };
  }
}

async function capabilityIntegrityCheck(state: SharedState): Promise<StateDoctorCheck> {
  try {
    const inspection = await inspectCapabilityIntegrity(state);
    return {
      id: "capability_integrity",
      ok: inspection.ok,
      message: inspection.ok
        ? `${inspection.installs} capability install(s), ${inspection.storeObjects} store object(s), and canonical identity are verified`
        : "capability, identity, store, registry, or transaction integrity failed",
      details: { ...inspection },
    };
  } catch (error) {
    return { id: "capability_integrity", ok: false, message: `capability integrity inspection failed: ${(error as Error).message}` };
  }
}

async function registryIntegrityCheck(state: SharedState): Promise<StateDoctorCheck> {
  try {
    const [config, credits, packages, dataRepos, environments] = await Promise.all([
      readSessionConfig(state),
      readCreditStore(state),
      readPackageRegistrations(state),
      readDataRepos(state),
      readPackagesAndEnvironmentsState(state),
    ]);
    if (
      credits.schemaVersion !== 1 ||
      !credits.balances ||
      typeof credits.balances !== "object" ||
      !credits.providers ||
      typeof credits.providers !== "object" ||
      !Array.isArray(credits.ledger) ||
      typeof credits.updatedAt !== "string" ||
      new Date(credits.updatedAt).toISOString() !== credits.updatedAt
    ) {
      throw new Error("credits.json has an invalid schema");
    }
    if (environments.schemaVersion !== 1) throw new Error("environments.json has an invalid schema");
    return {
      id: "registry_integrity",
      ok: true,
      message: "canonical config, credit, package, data-repository, and environment registries are valid",
      details: {
        configSchemaVersion: config.schemaVersion,
        packages: packages.length,
        dataRepos: dataRepos.length,
        environments: environments.environments.length,
        containers: environments.containers.length,
        creditEntries: credits.ledger.length,
      },
    };
  } catch (error) {
    return { id: "registry_integrity", ok: false, message: `canonical registry validation failed: ${(error as Error).message}` };
  }
}

export function launcherNameForPlatform(platform: NodeJS.Platform): string {
  return platform === "win32" ? "agents.ps1" : "agents";
}

async function launcherCheck(state: SharedState): Promise<StateDoctorCheck> {
  const binDirectory = path.join(state.stateDir, "bin");
  const launcherName = launcherNameForPlatform(process.platform);
  const launcher = path.join(binDirectory, launcherName);
  const windows = process.platform === "win32";
  const issues: string[] = [];
  try {
    const directoryInfo = await lstat(binDirectory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) issues.push("bin must be a physical directory");
    if (process.platform !== "win32" && (directoryInfo.mode & 0o777) !== 0o700) {
      issues.push(`bin mode is ${modeString(directoryInfo.mode)}, expected 0o700`);
    }
    const entries = await readdir(binDirectory, { withFileTypes: true });
    if (entries.length !== 1 || entries[0]?.name !== launcherName) {
      issues.push(`bin must contain exactly one ${launcherName} launcher`);
    }
    const launcherInfo = await lstat(launcher);
    if (!launcherInfo.isFile() || launcherInfo.isSymbolicLink()) issues.push("agents launcher must be a physical file");
    if (process.platform !== "win32" && (launcherInfo.mode & 0o777) !== 0o700) {
      issues.push(`agents launcher mode is ${modeString(launcherInfo.mode)}, expected 0o700`);
    }
    const content = await readFile(launcher, "utf8");
    const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
    const powerShellQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
    for (const [name, value] of [
      ["AGENTS_HOME", state.stateDir],
      ["AGENTS_USER_HOME", state.userHome],
      ["AGENTS_ROOT", state.root],
      ["AGENTS_WORKSPACE", state.workspaceDir],
      ["AGENTS_SYSTEM_DATA_ROOT", systemDataPath(state.root)],
    ] as const) {
      const binding = windows ? `$env:${name} = ${powerShellQuote(value)}` : `export ${name}=${shellQuote(value)}`;
      if (!content.includes(binding)) {
        issues.push(`agents launcher is missing canonical binding: ${name}=${value}`);
      }
    }
    const cliPath = path.join(state.root, "packages", "core", "src", "manager", "cli.ts");
    const entrypointBinding = windows
      ? `$env:AGENTS_ENTRYPOINT = ${powerShellQuote(cliPath)}`
      : `export AGENTS_ENTRYPOINT=${shellQuote(cliPath)}`;
    if (!content.includes(entrypointBinding)) {
      issues.push(`agents launcher is missing canonical binding: ${cliPath}`);
    }
    if (content.includes("export AGENTS_DATA=")) issues.push("agents launcher exports the removed AGENTS_DATA parent path");
  } catch (error) {
    issues.push((error as Error).message);
  }
  return {
    id: "launcher",
    ok: issues.length === 0,
    message: issues.length === 0 ? "one private launcher is bound to the canonical source and state roots" : "launcher layout or binding is invalid",
    details: { launcher, issues },
  };
}

async function sourceInstallCheck(state: SharedState): Promise<StateDoctorCheck> {
  const inspection = await inspectSourceInstall(state);
  return {
    id: "source_install",
    ok: inspection.ok,
    message: inspection.ok
      ? `clean source ${inspection.record?.branch}@${inspection.record?.commit.slice(0, 12)} and pinned components match the install record`
      : "canonical source checkout is unrecorded, dirty, or version-drifted",
    details: { record: inspection.record, issues: inspection.issues },
  };
}

export async function doctorState(state: SharedState): Promise<StateDoctorReport> {
  const stateRoot = path.resolve(state.stateDir);
  const paths = stateV2Paths(state);
  const retiredNames = ["state", "global", "shared", "agents"];
  const requiredFiles = [
    state.configFile,
    state.envFile,
    state.installsFile,
    state.packagesFile,
    state.dataReposFile,
    state.environmentsFile,
    state.creditsFile,
    paths.providersFile,
  ];
  const [rootKind, tools, manifest, retiredKinds, requiredKinds] = await Promise.all([
    pathKind(state.stateDir),
    Promise.all(toolStateSpecs.map((spec) => readToolStatus(spec.id, state.userHome, state.stateDir))),
    manifestCheck(state),
    Promise.all(retiredNames.map((name) => pathKind(path.join(state.stateDir, name)))),
    Promise.all(requiredFiles.map((file) => pathKind(file))),
  ]);
  const retiredArtifacts = retiredNames.filter((_, index) => retiredKinds[index] !== "missing");
  const missingRequiredFiles = requiredFiles.filter((_, index) => requiredKinds[index] !== "file");
  let generatedEnvIssues: string[] = [];
  if (requiredKinds[1] === "file") {
    const generatedEnv = await readFile(state.envFile, "utf8");
    const expected = [
      `AGENTS_HOME=${state.stateDir}`,
      `AGENTS_USER_HOME=${state.userHome}`,
      `AGENTS_ROOT=${state.root}`,
      `AGENTS_WORKSPACE=${state.workspaceDir}`,
      `AGENTS_IDENTITY=${path.join(state.stateDir, "identity")}`,
      `AGENTS_MEMORY=${path.join(state.stateDir, "memory")}`,
      `AGENTS_SYSTEM_DATA_ROOT=${systemDataPath(state.root)}`,
    ];
    generatedEnvIssues = expected.filter((line) => !generatedEnv.split("\n").includes(line));
    if (/^AGENTS_DATA=/m.test(generatedEnv)) generatedEnvIssues.push("duplicate AGENTS_DATA parent path is present");
    if (/^(?:ROMMIE_|AGENTOS_)/m.test(generatedEnv)) generatedEnvIssues.push("retired variable present");
  }

  const invalidToolRoots = tools.filter((tool) => tool.location === "split" || tool.location === "forbidden");
  const appOwnedToolRoots = tools.filter((tool) => tool.location === "app-owned");
  const checks: StateDoctorCheck[] = [
    {
      id: "state_root",
      ok: rootKind === "directory" && path.isAbsolute(state.stateDir),
      message:
        rootKind === "directory" && path.isAbsolute(state.stateDir)
          ? "canonical state root exists"
          : rootKind === "missing"
            ? "canonical state root is not initialized"
            : "canonical state root is not an absolute directory",
      details: { exists: rootKind !== "missing", kind: rootKind },
    },
    manifest,
    {
      id: "tool_roots",
      ok: invalidToolRoots.length === 0,
      message:
        invalidToolRoots.length === 0
          ? appOwnedToolRoots.length > 0
            ? `provider authority is canonical; app-owned desktop roots coexist for ${appOwnedToolRoots.map((tool) => tool.id).join(", ")}`
            : "provider state exists only under the canonical root"
          : `forbidden standalone or split provider state: ${invalidToolRoots.map((tool) => tool.id).join(", ")}`,
      details: {
        failures: invalidToolRoots.map((tool) => tool.id),
        appOwned: appOwnedToolRoots.map((tool) => tool.id),
      },
    },
    await providerRegistryCheck(state, tools),
    {
      id: "retired_state",
      ok: retiredArtifacts.length === 0,
      message:
        retiredArtifacts.length === 0
          ? "retired state, global, shared, and multi-agent roots are absent"
          : `retired live roots are present: ${retiredArtifacts.join(", ")}`,
      details: { present: retiredArtifacts },
    },
    await memoryIntegrityCheck(state),
    await sessionIntegrityCheck(state),
    await orchestratorIntegrityCheck(state),
    await capabilityIntegrityCheck(state),
    await registryIntegrityCheck(state),
    await launcherCheck(state),
    await sourceInstallCheck(state),
    await permissionsCheck(state, tools, stateRoot),
    {
      id: "generated_env",
      ok: missingRequiredFiles.length === 0 && generatedEnvIssues.length === 0,
      message:
        missingRequiredFiles.length === 0 && generatedEnvIssues.length === 0
          ? "generated environment and canonical registries are present"
          : "generated environment or canonical registry set is incomplete",
      details: { missingFiles: missingRequiredFiles, envIssues: generatedEnvIssues },
    },
    await syncSafetyCheck(state),
  ];

  return {
    ok: checks.every((check) => check.ok),
    stateRoot,
    checks,
    tools,
  };
}

export function formatStateDoctor(report: StateDoctorReport): string {
  const lines = [`Agent OS state ${report.ok ? "ok" : "FAILED"}`, `root ${report.stateRoot}`];
  for (const check of report.checks) lines.push(`${check.ok ? "ok" : "fail"} ${check.id} ${check.message}`);
  lines.push("tools " + report.tools.map((tool) => `${tool.id}=${tool.location}`).join(" "));
  return lines.join("\n");
}
