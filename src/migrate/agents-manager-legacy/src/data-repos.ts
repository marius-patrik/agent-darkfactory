import path from "node:path";
import { stat } from "node:fs/promises";
import type { SharedState } from "./state";

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

export async function readDataRepos(state: SharedState): Promise<DataRepoRegistration[]> {
  if (!(await exists(state.dataReposFile))) return [];
  return JSON.parse(await Bun.file(state.dataReposFile).text()) as DataRepoRegistration[];
}

export async function writeDataRepos(state: SharedState, repos: DataRepoRegistration[]): Promise<void> {
  await Bun.write(state.dataReposFile, `${JSON.stringify(repos, null, 2)}\n`);
}

export async function upsertDataRepo(
  state: SharedState,
  registration: Omit<DataRepoRegistration, "configuredAt">,
): Promise<DataRepoRegistration> {
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
  await writeDataRepos(state, repos);
  return next;
}

export function dataRepoManagedRoot(repo: DataRepoRegistration): string {
  return repo.managedPath ? path.join(repo.path, repo.managedPath) : repo.path;
}
