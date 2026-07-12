import path from "node:path";
import { lstat, stat } from "node:fs/promises";
import type { InstallKind, SharedState } from "./state";
import { writeTextAtomic } from "./state-v2";
import { withStateFileLock } from "./state-lock";

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

const manifestName = "agent.package.json";
const retiredManifestNames = ["agents.package.json", "agent.json", "package.agent.json"];
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

function validateKind(kind: string): PackageKind {
  const allowed = new Set(["app", "data", "package", "workspace", "harness", "cli", "skill", "plugin", "hook", "template"]);
  if (!allowed.has(kind)) throw new Error(`unsupported package kind: ${kind}`);
  return kind as PackageKind;
}

export async function findManifest(packageDir: string): Promise<string | null> {
  for (const retiredName of retiredManifestNames) {
    const retiredPath = path.join(packageDir, retiredName);
    if (await exists(retiredPath)) throw new Error(`retired package manifest is forbidden: ${retiredPath}`);
  }
  const file = path.join(packageDir, manifestName);
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`package manifest must be a physical file: ${file}`);
    return file;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function readPackageManifest(packageDir: string): Promise<AgentsPackageManifest | null> {
  const file = await findManifest(packageDir);
  if (!file) return null;
  const parsed = JSON.parse(await Bun.file(file).text()) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${file}: manifest must be an object`);
  const raw = parsed as Partial<AgentsPackageManifest>;
  if (raw.schemaVersion !== 1) throw new Error(`${file}: schemaVersion must be 1`);
  if (!raw.id || typeof raw.id !== "string" || !SAFE_ID.test(raw.id)) throw new Error(`${file}: id is invalid`);
  if (!raw.kind || typeof raw.kind !== "string") throw new Error(`${file}: kind is required`);
  for (const [field, value] of [
    ["name", raw.name],
    ["description", raw.description],
    ["entry", raw.entry],
  ] as const) {
    if (value !== undefined && (typeof value !== "string" || !value.trim() || value.includes("\0"))) {
      throw new Error(`${file}: ${field} must be a non-empty string`);
    }
  }
  if (raw.workingDirectory !== undefined) assertRelativePath(raw.workingDirectory, `${file}: workingDirectory`);
  const requires = parseRequires(raw.requires, file);
  const provides = stringList(raw.provides ?? [], `${file}: provides`);
  return {
    schemaVersion: 1,
    id: raw.id,
    name: raw.name,
    kind: validateKind(raw.kind),
    description: raw.description,
    entry: raw.entry,
    workingDirectory: raw.workingDirectory,
    requires,
    dataRepo: parseDataRepo(raw.dataRepo),
    provides,
  };
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !item.trim() || item.includes("\0") || seen.has(item)) {
      throw new Error(`${field} contains an invalid or duplicate value`);
    }
    seen.add(item);
  }
  return value;
}

function assertRelativePath(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value || path.isAbsolute(value) || value.split(/[\\/]/).includes("..") || value.includes("\0")) {
    throw new Error(`${field} must be a safe relative path`);
  }
}

function parseRequires(value: unknown, file: string): AgentsPackageManifest["requires"] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${file}: requires must be an object`);
  const record = value as Record<string, unknown>;
  return {
    clis: record.clis === undefined ? undefined : stringList(record.clis, `${file}: requires.clis`),
    state: record.state === undefined ? undefined : stringList(record.state, `${file}: requires.state`),
  };
}

function parseDataRepo(value: unknown): AgentsPackageManifest["dataRepo"] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("dataRepo must be an object");
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !SAFE_ID.test(record.id)) throw new Error("dataRepo.id is invalid");
  if (typeof record.repo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(record.repo)) throw new Error("dataRepo.repo is invalid");
  assertRelativePath(record.path, "dataRepo.path");
  if (record.managedPath !== undefined) assertRelativePath(record.managedPath, "dataRepo.managedPath");
  if (record.branch !== undefined && (typeof record.branch !== "string" || !record.branch.trim() || record.branch.includes("\0"))) {
    throw new Error("dataRepo.branch is invalid");
  }
  if (record.env !== undefined && (typeof record.env !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(record.env))) {
    throw new Error("dataRepo.env is invalid");
  }
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
  const parsed = JSON.parse(await Bun.file(state.packagesFile).text()) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`invalid package registry: ${state.packagesFile}`);
  const ids = new Set<string>();
  for (const record of parsed) {
    if (
      !record ||
      typeof record !== "object" ||
      Array.isArray(record) ||
      typeof record.id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(record.id) ||
      typeof record.kind !== "string" ||
      typeof record.path !== "string" ||
      !path.isAbsolute(record.path) ||
      typeof record.registeredAt !== "string" ||
      new Date(record.registeredAt).toISOString() !== record.registeredAt ||
      ids.has(record.id)
    ) {
      throw new Error(`invalid package registry record: ${state.packagesFile}`);
    }
    validateKind(record.kind);
    if (record.source !== undefined && typeof record.source !== "string") throw new Error(`invalid package source: ${record.id}`);
    if (record.manifestPath !== undefined && (typeof record.manifestPath !== "string" || !path.isAbsolute(record.manifestPath))) {
      throw new Error(`invalid package manifest path: ${record.id}`);
    }
    ids.add(record.id);
  }
  return parsed as PackageRegistration[];
}

export async function writePackageRegistrations(state: SharedState, registrations: PackageRegistration[]): Promise<void> {
  await withStateFileLock(state, "packages", () =>
    writeTextAtomic(state.packagesFile, `${JSON.stringify(registrations, null, 2)}\n`),
  );
}

export async function upsertPackageRegistration(state: SharedState, registration: Omit<PackageRegistration, "registeredAt">): Promise<void> {
  await withStateFileLock(state, "packages", async () => {
    const registrations = await readPackageRegistrations(state);
    const next: PackageRegistration = { ...registration, registeredAt: new Date().toISOString() };
    const index = registrations.findIndex((item) => item.id === registration.id);
    if (index === -1) registrations.push(next);
    else registrations[index] = { ...registrations[index], ...next };
    await writeTextAtomic(state.packagesFile, `${JSON.stringify(registrations, null, 2)}\n`);
  });
}
