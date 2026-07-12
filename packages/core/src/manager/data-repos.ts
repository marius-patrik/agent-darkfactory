import path from "node:path";
import { stat } from "node:fs/promises";
import {
  SYSTEM_DATA_ENV,
  SYSTEM_DATA_REPOSITORY,
  SYSTEM_DATA_REPO_ID,
  systemDataPath,
  type SharedState,
} from "./state";
import { writeTextAtomic } from "./state-v2";
import { withStateFileLock } from "./state-lock";

export interface DataRepoRegistration {
  id: string;
  repo: string;
  path: string;
  branch?: string;
  managedPath?: string;
  env?: string;
  configuredAt: string;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_ENV = /^[A-Z][A-Z0-9_]*$/;

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isSafeRelativePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !path.isAbsolute(value) &&
    !value.includes("\0") &&
    !value.split(/[\\/]/).includes("..")
  );
}

function validateDataRepos(state: SharedState, value: unknown, source: string): DataRepoRegistration[] {
  if (!Array.isArray(value)) throw new Error(`invalid data repository registry: ${source}`);
  const ids = new Set<string>();
  const paths = new Set<string>();
  const envs = new Set<string>();
  let hasSystemData = false;
  const canonicalPath = systemDataPath(state.root);

  for (const record of value) {
    if (
      !record ||
      typeof record !== "object" ||
      Array.isArray(record) ||
      typeof record.id !== "string" ||
      !SAFE_ID.test(record.id) ||
      typeof record.repo !== "string" ||
      !SAFE_REPOSITORY.test(record.repo) ||
      typeof record.path !== "string" ||
      !path.isAbsolute(record.path) ||
      record.path.includes("\0") ||
      path.resolve(record.path) !== record.path ||
      !isIsoTimestamp(record.configuredAt) ||
      ids.has(record.id) ||
      paths.has(record.path)
    ) {
      throw new Error(`invalid data repository record: ${source}`);
    }
    if (record.branch !== undefined && (typeof record.branch !== "string" || !record.branch.trim() || record.branch.includes("\0"))) {
      throw new Error(`invalid data repository branch: ${record.id}`);
    }
    if (record.managedPath !== undefined && !isSafeRelativePath(record.managedPath)) {
      throw new Error(`invalid data repository managedPath: ${record.id}`);
    }
    if (record.env !== undefined && (typeof record.env !== "string" || !SAFE_ENV.test(record.env) || envs.has(record.env))) {
      throw new Error(`invalid data repository env: ${record.id}`);
    }

    if (record.id === SYSTEM_DATA_REPO_ID) {
      if (
        record.repo !== SYSTEM_DATA_REPOSITORY ||
        record.path !== canonicalPath ||
        record.branch !== "main" ||
        record.managedPath !== undefined ||
        record.env !== SYSTEM_DATA_ENV
      ) {
        throw new Error(`canonical ${SYSTEM_DATA_REPO_ID} record disagrees with the Agent OS product contract`);
      }
      hasSystemData = true;
    } else if (record.repo === SYSTEM_DATA_REPOSITORY || record.path === canonicalPath || record.env === SYSTEM_DATA_ENV) {
      throw new Error(`data repository ${record.id} aliases the canonical ${SYSTEM_DATA_REPO_ID} authority`);
    }

    ids.add(record.id);
    paths.add(record.path);
    if (record.env !== undefined) envs.add(record.env);
  }

  if (!hasSystemData) throw new Error(`canonical data repository is missing: ${SYSTEM_DATA_REPO_ID}`);
  return structuredClone(value) as DataRepoRegistration[];
}

export async function readDataRepos(state: SharedState): Promise<DataRepoRegistration[]> {
  if (!(await exists(state.dataReposFile))) throw new Error(`canonical data repository registry is missing: ${state.dataReposFile}`);
  return validateDataRepos(state, JSON.parse(await Bun.file(state.dataReposFile).text()), state.dataReposFile);
}

export async function writeDataRepos(state: SharedState, repos: DataRepoRegistration[]): Promise<void> {
  const validated = validateDataRepos(state, repos, state.dataReposFile);
  await withStateFileLock(state, "data-repos", () =>
    writeTextAtomic(state.dataReposFile, `${JSON.stringify(validated, null, 2)}\n`),
  );
}

export async function upsertDataRepo(
  state: SharedState,
  registration: Omit<DataRepoRegistration, "configuredAt">,
): Promise<DataRepoRegistration> {
  return withStateFileLock(state, "data-repos", async () => {
    const repos = await readDataRepos(state);
    const fullPath = path.resolve(state.root, registration.path);
    const next: DataRepoRegistration = {
      ...registration,
      path: fullPath,
      configuredAt: new Date().toISOString(),
    };
    const index = repos.findIndex((item) => item.id === registration.id);
    if (index === -1) repos.push(next);
    else repos[index] = { ...repos[index], ...next };
    const validated = validateDataRepos(state, repos, state.dataReposFile);
    await writeTextAtomic(state.dataReposFile, `${JSON.stringify(validated, null, 2)}\n`);
    return next;
  });
}

export function dataRepoManagedRoot(repo: DataRepoRegistration): string {
  return repo.managedPath ? path.join(repo.path, repo.managedPath) : repo.path;
}
