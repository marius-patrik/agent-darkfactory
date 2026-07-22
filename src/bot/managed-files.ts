import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ANDROMEDA_ENTRYPOINT_PATH = "AGENTS.md";
export const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";
export const GITHUB_BOOTSTRAP_WORKFLOW_PATH = ".github/workflows/dark-factory-bootstrap.yml";
export const DARK_FACTORY_AUTOUPDATE_WORKFLOW_PATH = ".github/workflows/dark-factory-autoupdate.yml";
export const DARK_FACTORY_PLAN_WORKFLOW_PATH = ".github/workflows/df-plan.yml";
export const DARK_FACTORY_FOLLOW_THROUGH_WORKFLOW_PATH = ".github/workflows/df-follow-through.yml";
export const DARK_FACTORY_ORCHESTRATE_WORKFLOW_PATH = ".github/workflows/df-orchestrate.yml";
export const DARK_FACTORY_WORKFLOW_PATH = ".github/workflows/df-work.yml";
export const DARK_FACTORY_AUTOREVIEW_WORKFLOW_PATH = ".github/workflows/darkfactory-autoreview.yml";
export const DARK_FACTORY_AUTOREVIEW_SCHEMA_PATH = ".github/darkfactory-autoreview.schema.json";
export const DARK_FACTORY_AUTOREVIEW_PROTOCOL_PATH = ".github/scripts/df-autoreview.mjs";
export const DARK_FACTORY_AUTOREVIEW_SCRIPT_PATH = ".github/scripts/run-darkfactory-autoreview.mjs";
export const DARK_FACTORY_AUTOREVIEW_POLICY_PATH = ".darkfactory/autoreview-policy.json";
export const DARK_FACTORY_DATA_REPOSITORY_POLICY_PATH = ".darkfactory/data-repository-policy.json";
export const DARK_FACTORY_MODEL_POLICY_PATH = ".darkfactory/model-policy.json";
export const DARK_FACTORY_TRIGGER_POLICY_PATH = ".darkfactory/trigger-policy.json";
export const DARK_FACTORY_RELEASE_POLICY_PATH = ".darkfactory/release-policy.json";
export const DARK_FACTORY_SUBMODULE_POLICY_PATH = ".darkfactory/submodule-policy.json";
export const DARK_FACTORY_MANAGED_CHECK_SCRIPT_PATH = ".github/scripts/dark-factory-managed-check.mjs";
export const DARK_FACTORY_SCRIPT_LIB_PATH = ".github/scripts/df-lib.mjs";
export const DARK_FACTORY_ENFORCEMENT_SCRIPT_PATH = ".github/scripts/df-enforcement.mjs";
export const DARK_FACTORY_PLAN_SCRIPT_PATH = ".github/scripts/df-plan.mjs";
export const DARK_FACTORY_ORCHESTRATE_SCRIPT_PATH = ".github/scripts/df-orchestrate.mjs";
export const DARK_FACTORY_MODEL_POLICY_SCRIPT_PATH = ".github/scripts/df-model-policy.mjs";
export const DARK_FACTORY_TRIGGER_POLICY_SCRIPT_PATH = ".github/scripts/df-trigger-policy.mjs";
export const DARK_FACTORY_RELEASE_SCRIPT_PATH = ".github/scripts/df-release.mjs";
export const DARK_FACTORY_SUBMODULE_SCRIPT_PATH = ".github/scripts/df-submodule-autoupdate.mjs";
export const DARK_FACTORY_SUBMODULE_CHECKOUT_SCRIPT_PATH = ".github/scripts/df-submodule-checkout.mjs";
export const DARK_FACTORY_SWEEP_SCRIPT_PATH = ".github/scripts/df-sweep.mjs";
export const DARK_FACTORY_WORK_SCRIPT_PATH = ".github/scripts/df-work.mjs";
export const DARK_FACTORY_RELEASE_WORKFLOW_PATH = ".github/workflows/df-release.yml";
export const DARK_FACTORY_SUBMODULE_WORKFLOW_PATH = ".github/workflows/df-submodule-autoupdate.yml";
export const DARK_FACTORY_MANAGED_CONFIG_PATH = ".darkfactory/managed-repository.json";
export const DARK_FACTORY_INSTALLER_POLICY_PATH = ".darkfactory/installer-policy.json";
export const DARK_FACTORY_BRANCHING_POLICY_PATH = ".darkfactory/branching-policy.md";
export const DARK_FACTORY_ENFORCEMENT_RULES_PATH = ".darkfactory/enforcement-rules.json";
export const DARK_FACTORY_LABELS_PATH = ".darkfactory/labels.json";

export interface ManagedFile {
  path: string;
  content: string;
}

export interface ManagedRepositoryRef {
  owner: string;
  repo: string;
}

const MANAGED_COMMON_DIRS = [".github", ".darkfactory"] as const;
const MANAGED_COMMON_FILES = [ANDROMEDA_ENTRYPOINT_PATH] as const;
const EXCLUDED_MANAGED_FILE_PATHS = new Set([".github/workflows/df-event-forward.yml"]);
export function readManagedFiles(repository?: ManagedRepositoryRef): ManagedFile[] {
  const managedRoot = resolveManagedContentRoot();
  const files = new Map<string, ManagedFile>();

  for (const dir of MANAGED_COMMON_DIRS) {
    for (const file of readManagedTree(managedRoot, dir)) {
      files.set(file.path, file);
    }
  }

  for (const filePath of MANAGED_COMMON_FILES) {
    const file = readManagedFile(managedRoot, filePath);
    if (file) {
      files.set(file.path, file);
    }
  }

  const managedConfig = readManagedConfig([...files.values()]);
  for (const filePath of managedConfig.packageFiles) {
    if (files.has(filePath)) {
      throw new Error(`Managed data duplicates package-owned payload: ${filePath}`);
    }
    const file = readManagedFile(resolveProjectRoot(), filePath);
    if (!file) throw new Error(`Package-owned managed payload is missing: ${filePath}`);
    files.set(file.path, file);
  }

  if (repository) {
    const overlayPrefix = `repositories/${repository.owner}/${repository.repo}/`;
    const overlayRoot = resolve(managedRoot, overlayPrefix, ".agents", ".project");

    if (existsSync(overlayRoot)) {
      for (const file of readManagedTree(managedRoot, `${overlayPrefix}.agents/.project`)) {
        files.set(file.path.slice(overlayPrefix.length), {
          ...file,
          path: file.path.slice(overlayPrefix.length)
        });
      }
    }
  }

  for (const filePath of EXCLUDED_MANAGED_FILE_PATHS) {
    files.delete(filePath);
  }
  for (const filePath of removedManagedFilePaths([...files.values()])) {
    files.delete(filePath);
  }

  const requiredPaths = managedConfig.requiredFiles;
  const missingRequired = requiredPaths.filter((filePath) => !files.has(filePath));
  if (missingRequired.length > 0) {
    throw new Error(`Managed file source is missing required payloads: ${missingRequired.join(", ")}`);
  }

  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function removedManagedFilePaths(files: readonly ManagedFile[]): Set<string> {
  return new Set(readManagedConfig(files).removedFiles);
}

export function requiredManagedFilePaths(files?: readonly ManagedFile[]): string[] {
  return readManagedConfig(files).requiredFiles;
}

function readManagedConfig(files?: readonly ManagedFile[]): {
  packageFiles: string[];
  requiredFiles: string[];
  removedFiles: string[];
} {
  const config = files?.find((file) => file.path === DARK_FACTORY_MANAGED_CONFIG_PATH)
    ?? readManagedFile(resolveProjectRoot(), DARK_FACTORY_MANAGED_CONFIG_PATH);
  if (!config) throw new Error(`Managed file source is missing ${DARK_FACTORY_MANAGED_CONFIG_PATH}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(config.content);
  } catch (error) {
    throw new Error(`Invalid JSON in ${DARK_FACTORY_MANAGED_CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== 1 ||
    parsed.dataRepo !== "marius-patrik/Andromeda-data" ||
    parsed.ledgerRepo !== "marius-patrik/darkfactory-data" ||
    !isPathArray(parsed.packageFiles) ||
    !isPathArray(parsed.requiredFiles) ||
    !isPathArray(parsed.removedFiles)
  ) {
    throw new Error(
      `${DARK_FACTORY_MANAGED_CONFIG_PATH} must define schemaVersion 1, canonical Andromeda-data source and darkfactory-data ledger authorities, and packageFiles, requiredFiles, and removedFiles path arrays`
    );
  }
  const packageFiles = [...new Set(parsed.packageFiles)];
  const requiredFiles = [...new Set(parsed.requiredFiles)];
  const undeclaredPackagePayloads = packageFiles.filter((filePath) => !requiredFiles.includes(filePath));
  if (undeclaredPackagePayloads.length > 0) {
    throw new Error(`Managed config packageFiles must also be requiredFiles: ${undeclaredPackagePayloads.join(", ")}`);
  }
  return {
    packageFiles,
    requiredFiles,
    removedFiles: [...new Set(parsed.removedFiles)]
  };
}

function isPathArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0);
}

function readManagedFile(root: string, relativePath: string): ManagedFile | null {
  const fullPath = resolve(root, relativePath);

  if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
    return null;
  }

  return {
    path: relativePath,
    content: readFileSync(fullPath, "utf8").replace(/\r\n/g, "\n")
  };
}

function readManagedTree(root: string, relativeDir: string): ManagedFile[] {
  const fullDir = resolve(root, relativeDir);

  if (!existsSync(fullDir)) {
    return [];
  }

  return walk(fullDir)
    .filter((path) => statSync(path).isFile())
    .map((fullPath) => {
      const relativePath = toPosix(fullPath.slice(root.length + 1));
      return {
        path: relativePath,
        content: readFileSync(fullPath, "utf8").replace(/\r\n/g, "\n")
      };
    });
}

function walk(dir: string): string[] {
  const out: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(fullPath));
    else out.push(fullPath);
  }

  return out;
}

function toPosix(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function resolveManagedContentRoot(): string {
  const dataRepoRoot = resolveCanonicalDataRepoRoot();
  return resolve(dataRepoRoot, "managed-repository");
}

function resolveProjectRoot(): string {
  return dirname(fileURLToPath(import.meta.url));
}

function resolveCanonicalDataRepoRoot(): string {
  const dataReposFile = process.env.ANDROMEDA_DATA_REPOS?.trim();
  if (!dataReposFile) throw new Error("DarkFactory requires ANDROMEDA_DATA_REPOS from Agent OS");
  if (!existsSync(dataReposFile)) throw new Error(`Agent OS data repository registry does not exist: ${dataReposFile}`);

  const agentsHome = process.env.ANDROMEDA_HOME?.trim();
  if (!agentsHome) throw new Error("DarkFactory requires ANDROMEDA_HOME from Agent OS");
  const expectedPath = resolve(agentsHome);

  try {
    const parsed = JSON.parse(readFileSync(dataReposFile, "utf8")) as unknown;
    if (!Array.isArray(parsed)) throw new Error(`Invalid Agent OS data repository registry: ${dataReposFile}`);

    const records = parsed.filter(isRecord);
    if (records.length !== parsed.length) {
      throw new Error(`Invalid Agent OS data repository registry record in ${dataReposFile}`);
    }
    const authorities = records.filter((record) => record.id === "agent-os-data");
    if (authorities.length !== 1) {
      throw new Error(`Agent OS data repository registry must contain exactly one agent-os-data authority record: ${dataReposFile}`);
    }
    const dataRepo = authorities[0];
    if (dataRepo.repo !== "marius-patrik/Andromeda-data") {
      throw new Error(`agent-os-data must use repository marius-patrik/Andromeda-data in ${dataReposFile}`);
    }
    if (typeof dataRepo.path !== "string" || !dataRepo.path.trim()) {
      throw new Error(`Invalid agent-os-data path in ${dataReposFile}`);
    }
    const registeredPath = resolve(dataRepo.path);
    if (registeredPath !== expectedPath) {
      throw new Error(`agent-os-data path must be ${expectedPath}, received ${registeredPath}`);
    }
    if (dataRepo.managedPath !== undefined) {
      throw new Error(`agent-os-data must register its checkout root without managedPath in ${dataReposFile}`);
    }
    const conflicts = parsed.filter((entry) => isRecord(entry) && entry !== dataRepo && (
      String(entry.repo || "").toLowerCase() === "marius-patrik/andromeda-data"
      || (typeof entry.path === "string" && entry.path.trim() && resolve(entry.path) === expectedPath)
    ));
    if (conflicts.length > 0) {
      throw new Error(`Agent OS data repository registry contains a conflicting Andromeda-data authority: ${dataReposFile}`);
    }
    return registeredPath;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in Agent OS data repository registry: ${dataReposFile}`);
    }
    throw error;
  }
}

function resolveManagedRepositoryRoot(candidate: string): string {
  return resolve(candidate);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
