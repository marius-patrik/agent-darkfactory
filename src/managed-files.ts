import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const AGENTS_GLOBAL_VERSION_PATH = ".agents/.global/VERSION";
export const AGENTS_ENTRYPOINT_PATH = "AGENTS.md";
export const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";
export const GITHUB_BOOTSTRAP_WORKFLOW_PATH = ".github/workflows/dark-factory-bootstrap.yml";
export const DARK_FACTORY_AUTOUPDATE_WORKFLOW_PATH = ".github/workflows/dark-factory-autoupdate.yml";
export const DARK_FACTORY_RELEASE_WORKFLOW_PATH = ".github/workflows/dark-factory-release.yml";
export const DARK_FACTORY_PLAN_WORKFLOW_PATH = ".github/workflows/df-plan.yml";
export const DARK_FACTORY_FOLLOW_THROUGH_WORKFLOW_PATH = ".github/workflows/df-follow-through.yml";
export const DARK_FACTORY_ORCHESTRATE_WORKFLOW_PATH = ".github/workflows/df-orchestrate.yml";
export const DARK_FACTORY_WORKFLOW_PATH = ".github/workflows/df-work.yml";
export const CODEX_REVIEW_WORKFLOW_PATH = ".github/workflows/codex-review.yml";
export const CODEX_REVIEW_DOCKERFILE_PATH = ".github/codex-review.Dockerfile";
export const CODEX_REVIEW_SCHEMA_PATH = ".github/codex-review.schema.json";
export const CODEX_REVIEW_SCRIPT_PATH = ".github/scripts/run-codex-review.sh";
export const DARK_FACTORY_RELEASE_CHECK_SCRIPT_PATH = ".github/scripts/dark-factory-release-check.mjs";
export const DARK_FACTORY_SCRIPT_LIB_PATH = ".github/scripts/df-lib.mjs";
export const DARK_FACTORY_PLAN_SCRIPT_PATH = ".github/scripts/df-plan.mjs";
export const DARK_FACTORY_ORCHESTRATE_SCRIPT_PATH = ".github/scripts/df-orchestrate.mjs";
export const DARK_FACTORY_SWEEP_SCRIPT_PATH = ".github/scripts/df-sweep.mjs";
export const DARK_FACTORY_WORK_SCRIPT_PATH = ".github/scripts/df-work.mjs";
export const DARK_FACTORY_MANAGED_CONFIG_PATH = ".darkfactory/managed-repository.json";
export const DARK_FACTORY_INSTALLER_POLICY_PATH = ".darkfactory/installer-policy.json";
export const DARK_FACTORY_RELEASE_POLICY_PATH = ".darkfactory/release-policy.json";
export const DARK_FACTORY_BRANCHING_POLICY_PATH = ".darkfactory/branching-policy.md";
export const DARK_FACTORY_LABELS_PATH = ".darkfactory/labels.json";
export const DARK_FACTORY_RELEASE_CONVENTIONS_PATH = ".darkfactory/release-conventions.md";

export interface ManagedFile {
  path: string;
  content: string;
}

export interface ManagedRepositoryRef {
  owner: string;
  repo: string;
}

const MANAGED_COMMON_DIRS = [".agents/.global", ".github", ".darkfactory"] as const;
const MANAGED_COMMON_FILES = [AGENTS_ENTRYPOINT_PATH] as const;
const PACKAGE_MANAGED_FILES = [
  DARK_FACTORY_PLAN_WORKFLOW_PATH,
  DARK_FACTORY_FOLLOW_THROUGH_WORKFLOW_PATH,
  DARK_FACTORY_ORCHESTRATE_WORKFLOW_PATH,
  DARK_FACTORY_WORKFLOW_PATH,
  DARK_FACTORY_SCRIPT_LIB_PATH,
  DARK_FACTORY_PLAN_SCRIPT_PATH,
  DARK_FACTORY_ORCHESTRATE_SCRIPT_PATH,
  DARK_FACTORY_SWEEP_SCRIPT_PATH,
  DARK_FACTORY_WORK_SCRIPT_PATH
] as const;
const DATA_REPO_PATH_SEGMENTS = ["data", "data-agentos"] as const;
const WORKSPACE_PATH_SEGMENTS = ["workspaces", "workspace-darkfactory"] as const;

export function readManagedFiles(repository?: ManagedRepositoryRef, root = resolveManagedWorkspaceRoot()): ManagedFile[] {
  const files = new Map<string, ManagedFile>();

  for (const dir of MANAGED_COMMON_DIRS) {
    for (const file of readManagedTree(root, dir)) {
      files.set(file.path, file);
    }
  }

  for (const filePath of MANAGED_COMMON_FILES) {
    const file = readManagedFile(root, filePath);
    if (file) {
      files.set(file.path, file);
    }
  }

  for (const filePath of PACKAGE_MANAGED_FILES) {
    if (files.has(filePath)) continue;
    const file = readManagedFile(resolveProjectRoot(), filePath);
    if (file) {
      files.set(file.path, file);
    }
  }

  if (repository) {
    const overlayPrefix = `repositories/${repository.owner}/${repository.repo}/`;
    const overlayRoot = resolve(root, overlayPrefix, ".agents", ".project");

    if (existsSync(overlayRoot)) {
      for (const file of readManagedTree(root, `${overlayPrefix}.agents/.project`)) {
        files.set(file.path.slice(overlayPrefix.length), {
          ...file,
          path: file.path.slice(overlayPrefix.length)
        });
      }
    }
  }

  const missingRequired = requiredManagedFilePaths(root).filter((filePath) => !files.has(filePath));
  if (missingRequired.length > 0) {
    throw new Error(`Managed file source is missing required payloads: ${missingRequired.join(", ")}`);
  }

  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function requiredManagedFilePaths(_root = resolveManagedWorkspaceRoot()): string[] {
  // Package-managed workflow/script payloads are required unconditionally.
  // readManagedFiles() falls back to the package root when a workspace overlay
  // does not provide them, and throws if neither source exists. This keeps CI
  // from silently omitting generated payloads when a source generator is missing.
  return [
    AGENTS_ENTRYPOINT_PATH,
    AGENTS_GLOBAL_VERSION_PATH,
    CI_WORKFLOW_PATH,
    GITHUB_BOOTSTRAP_WORKFLOW_PATH,
    DARK_FACTORY_AUTOUPDATE_WORKFLOW_PATH,
    DARK_FACTORY_RELEASE_WORKFLOW_PATH,
    ...PACKAGE_MANAGED_FILES,
    CODEX_REVIEW_WORKFLOW_PATH,
    CODEX_REVIEW_DOCKERFILE_PATH,
    CODEX_REVIEW_SCHEMA_PATH,
    CODEX_REVIEW_SCRIPT_PATH,
    DARK_FACTORY_RELEASE_CHECK_SCRIPT_PATH,
    DARK_FACTORY_BRANCHING_POLICY_PATH,
    DARK_FACTORY_LABELS_PATH,
    DARK_FACTORY_MANAGED_CONFIG_PATH,
    DARK_FACTORY_INSTALLER_POLICY_PATH,
    DARK_FACTORY_RELEASE_CONVENTIONS_PATH,
    DARK_FACTORY_RELEASE_POLICY_PATH
  ];
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

function resolveManagedWorkspaceRoot(): string {
  const configured = process.env.DARK_FACTORY_WORKSPACE_ROOT?.trim();
  if (configured) {
    return resolveManagedRepositoryRoot(configured);
  }

  const dataRepoRoot = resolveAgentosDataRepoRoot();
  if (dataRepoRoot) {
    return dataRepoRoot;
  }

  const projectRoot = resolveProjectRoot();
  const siblingDataRepo = resolve(projectRoot, "..", ...DATA_REPO_PATH_SEGMENTS, "managed-repository");
  if (existsSync(siblingDataRepo)) {
    return siblingDataRepo;
  }

  const legacySiblingDataRepo = resolve(projectRoot, "..", "agentos-data", "managed-repository");
  if (existsSync(legacySiblingDataRepo)) {
    return legacySiblingDataRepo;
  }

  const siblingWorkspace = resolve(projectRoot, "..", ...WORKSPACE_PATH_SEGMENTS, "managed-repository");
  if (existsSync(siblingWorkspace)) {
    return siblingWorkspace;
  }

  const legacySiblingWorkspace = resolve(projectRoot, "..", "workspace-darkfactory", "managed-repository");
  if (existsSync(legacySiblingWorkspace)) {
    return legacySiblingWorkspace;
  }

  const bundledDataRepo = resolve(projectRoot, ...DATA_REPO_PATH_SEGMENTS, "managed-repository");
  if (existsSync(bundledDataRepo)) {
    return bundledDataRepo;
  }

  const legacyBundledDataRepo = resolve(projectRoot, "agentos-data", "managed-repository");
  if (existsSync(legacyBundledDataRepo)) {
    return legacyBundledDataRepo;
  }

  const bundledWorkspace = resolve(projectRoot, ...WORKSPACE_PATH_SEGMENTS, "managed-repository");
  if (existsSync(bundledWorkspace)) {
    return bundledWorkspace;
  }

  const legacyBundledWorkspace = resolve(projectRoot, "workspace-darkfactory", "managed-repository");
  if (existsSync(legacyBundledWorkspace)) {
    return legacyBundledWorkspace;
  }

  return resolve(projectRoot, "managed-repository");
}

function resolveProjectRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function resolveAgentosDataRepoRoot(): string | null {
  const dataReposFile = process.env.AGENTS_DATA_REPOS?.trim();
  if (!dataReposFile || !existsSync(dataReposFile)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(dataReposFile, "utf8")) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }

    const agentosRoot = process.env.AGENTS_ROOT?.trim() ?? resolve(dirname(dataReposFile), "..");
    const dataRepo = parsed.find((item) => {
      return isRecord(item) && (item.id === "workspace-darkfactory" || item.repo === "marius-patrik/data-agentos");
    });
    if (!isRecord(dataRepo) || typeof dataRepo.path !== "string") {
      return null;
    }

    const managedPath = typeof dataRepo.managedPath === "string" ? dataRepo.managedPath : "managed-repository";
    return resolveManagedRepositoryRoot(resolve(agentosRoot, dataRepo.path, managedPath));
  } catch {
    return null;
  }
}

function resolveManagedRepositoryRoot(candidate: string): string {
  const root = resolve(candidate);
  if (existsSync(resolve(root, ".agents")) || existsSync(resolve(root, ".github")) || existsSync(resolve(root, ".darkfactory"))) {
    return root;
  }

  const nested = resolve(root, "managed-repository");
  if (existsSync(nested)) {
    return nested;
  }

  return root;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
