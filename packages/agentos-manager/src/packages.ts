import path from "node:path";
import { stat } from "node:fs/promises";
import type { InstallKind, SharedState } from "./state";

export type PackageKind = InstallKind;

export interface AgentsPackageManifest {
  schemaVersion: 1;
  id: string;
  name?: string;
  kind: PackageKind;
  description?: string;
  entry?: string;
  workingDirectory?: string;
  requires?: {
    clis?: string[];
    state?: string[];
  };
  dataRepo?: {
    id: string;
    repo: string;
    path: string;
    branch?: string;
    managedPath?: string;
    env?: string;
  };
  provides?: string[];
}

export interface PackageRegistration {
  id: string;
  kind: PackageKind;
  path: string;
  source?: string;
  manifestPath?: string;
  registeredAt: string;
}

const manifestNames = ["agent.package.json", "agents.package.json", "agent.json"];

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

function validateKind(kind: string): PackageKind {
  const allowed = new Set(["agent", "app", "data", "package", "workspace", "harness", "cli", "skill", "plugin", "hook", "template"]);
  if (!allowed.has(kind)) throw new Error(`unsupported package kind: ${kind}`);
  return kind as PackageKind;
}

export async function findManifest(packageDir: string): Promise<string | null> {
  for (const name of manifestNames) {
    const file = path.join(packageDir, name);
    if (await exists(file)) return file;
  }
  return null;
}

export async function readPackageManifest(packageDir: string): Promise<AgentsPackageManifest | null> {
  const file = await findManifest(packageDir);
  if (!file) return null;
  const raw = JSON.parse(await Bun.file(file).text()) as Partial<AgentsPackageManifest>;
  if (raw.schemaVersion !== 1) throw new Error(`${file}: schemaVersion must be 1`);
  if (!raw.id || typeof raw.id !== "string") throw new Error(`${file}: id is required`);
  if (!raw.kind || typeof raw.kind !== "string") throw new Error(`${file}: kind is required`);
  return {
    schemaVersion: 1,
    id: raw.id,
    name: raw.name,
    kind: validateKind(raw.kind),
    description: raw.description,
    entry: raw.entry,
    workingDirectory: raw.workingDirectory,
    requires: raw.requires,
    dataRepo: parseDataRepo(raw.dataRepo),
    provides: raw.provides ?? [],
  };
}

function parseDataRepo(value: unknown): AgentsPackageManifest["dataRepo"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string") throw new Error("dataRepo.id is required");
  if (typeof record.repo !== "string") throw new Error("dataRepo.repo is required");
  if (typeof record.path !== "string") throw new Error("dataRepo.path is required");
  return {
    id: record.id,
    repo: record.repo,
    path: record.path,
    branch: typeof record.branch === "string" ? record.branch : undefined,
    managedPath: typeof record.managedPath === "string" ? record.managedPath : undefined,
    env: typeof record.env === "string" ? record.env : undefined,
  };
}

export async function readPackageRegistrations(state: SharedState): Promise<PackageRegistration[]> {
  if (!(await exists(state.packagesFile))) return [];
  return JSON.parse(await Bun.file(state.packagesFile).text()) as PackageRegistration[];
}

export async function writePackageRegistrations(state: SharedState, registrations: PackageRegistration[]): Promise<void> {
  await Bun.write(state.packagesFile, `${JSON.stringify(registrations, null, 2)}\n`);
}

export async function upsertPackageRegistration(state: SharedState, registration: Omit<PackageRegistration, "registeredAt">): Promise<void> {
  const registrations = await readPackageRegistrations(state);
  const next: PackageRegistration = { ...registration, registeredAt: new Date().toISOString() };
  const index = registrations.findIndex((item) => item.id === registration.id);
  if (index === -1) registrations.push(next);
  else registrations[index] = { ...registrations[index], ...next };
  await writePackageRegistrations(state, registrations);
}
