import type { SharedState } from "./state";
import { writeTextAtomic } from "./state-v2";
import { withStateFileLock } from "./state-lock";

export type PackageTargetKind = "host" | "container";
export type EnvironmentKind = "host" | "container" | "agent-workspace";

export interface DistroPackageRecord {
  id: string;
  target: PackageTargetKind;
  manager: "apt" | "apk" | "pacman" | "winget" | "brew" | "custom";
  name: string;
  version?: string;
  source?: string;
}

export interface ContainerPackageRecord {
  id: string;
  image: string;
  digest?: string;
  tags?: string[];
  runtime?: "docker" | "podman";
}

export interface EnvironmentRecord {
  id: string;
  kind: EnvironmentKind;
  packages: string[];
  secretsScope?: string;
  containerPackage?: string;
  workspacePath?: string;
  createdAt: string;
}

export interface OsContainerRecord {
  id: string;
  name: string;
  environment: string;
  image: string;
  channel?: string;
  createdAt: string;
  status: "created" | "running" | "stopped" | "removed";
  ports?: Array<{ name: string; container: number; host: number }>;
  profiles?: string[];
}

export interface PackagesAndEnvironmentsState {
  schemaVersion: 1;
  activeEnvironmentId?: string;
  distroPackages: DistroPackageRecord[];
  containerPackages: ContainerPackageRecord[];
  environments: EnvironmentRecord[];
  containers: OsContainerRecord[];
}

export function emptyPackagesAndEnvironmentsState(): PackagesAndEnvironmentsState {
  return {
    schemaVersion: 1,
    distroPackages: [],
    containerPackages: [],
    environments: [],
    containers: [],
  };
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DISTRO_MANAGERS = new Set<DistroPackageRecord["manager"]>(["apt", "apk", "pacman", "winget", "brew", "custom"]);
const ENVIRONMENT_KINDS = new Set<EnvironmentKind>(["host", "container", "agent-workspace"]);
const CONTAINER_STATUSES = new Set<OsContainerRecord["status"]>(["created", "running", "stopped", "removed"]);

function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requiredText(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error(`${field} must be a non-empty string`);
}

function safeId(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error(`${field} is invalid`);
}

function optionalText(value: unknown, field: string): void {
  if (value !== undefined) requiredText(value, field);
}

function normalizedIso(value: unknown, field: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${field} must be a normalized ISO timestamp`);
  }
}

function uniqueStrings(value: unknown, field: string, validate: (item: unknown, field: string) => void = requiredText): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    validate(item, `${field}[${index}]`);
    if (seen.has(item as string)) throw new Error(`${field} contains a duplicate: ${item}`);
    seen.add(item as string);
  }
  return value as string[];
}

function validatePackagesAndEnvironmentsState(value: unknown, source: string): PackagesAndEnvironmentsState {
  if (!plainObject(value)) throw new Error(`invalid packages and environments registry: ${source}`);
  const raw = value as Partial<PackagesAndEnvironmentsState>;
  if (
    raw.schemaVersion !== 1 ||
    !Array.isArray(raw.distroPackages) ||
    !Array.isArray(raw.containerPackages) ||
    !Array.isArray(raw.environments) ||
    !Array.isArray(raw.containers)
  ) {
    throw new Error(`invalid packages and environments registry: ${source}`);
  }

  const validateUniqueCollection = <T extends { id: string }>(collection: unknown[], label: string, validate: (record: unknown, index: number) => T): T[] => {
    const seen = new Set<string>();
    return collection.map((record, index) => {
      const result = validate(record, index);
      if (seen.has(result.id)) throw new Error(`duplicate ${label} id: ${result.id}`);
      seen.add(result.id);
      return result;
    });
  };

  const distroPackages = validateUniqueCollection(raw.distroPackages, "distro package", (value, index) => {
    if (!plainObject(value)) throw new Error(`invalid distro package ${index}: ${source}`);
    const record = value as Partial<DistroPackageRecord>;
    safeId(record.id, `distroPackages[${index}].id`);
    if (record.target !== "host" && record.target !== "container") throw new Error(`invalid distro package target: ${record.id}`);
    if (!record.manager || !DISTRO_MANAGERS.has(record.manager)) throw new Error(`invalid distro package manager: ${record.id}`);
    requiredText(record.name, `distroPackages[${index}].name`);
    optionalText(record.version, `distroPackages[${index}].version`);
    optionalText(record.source, `distroPackages[${index}].source`);
    return record as DistroPackageRecord;
  });

  const containerPackages = validateUniqueCollection(raw.containerPackages, "container package", (value, index) => {
    if (!plainObject(value)) throw new Error(`invalid container package ${index}: ${source}`);
    const record = value as Partial<ContainerPackageRecord>;
    requiredText(record.id, `containerPackages[${index}].id`);
    requiredText(record.image, `containerPackages[${index}].image`);
    optionalText(record.digest, `containerPackages[${index}].digest`);
    if (record.tags !== undefined) uniqueStrings(record.tags, `containerPackages[${index}].tags`);
    if (record.runtime !== undefined && record.runtime !== "docker" && record.runtime !== "podman") {
      throw new Error(`invalid container runtime: ${record.id}`);
    }
    return record as ContainerPackageRecord;
  });

  const environments = validateUniqueCollection(raw.environments, "environment", (value, index) => {
    if (!plainObject(value)) throw new Error(`invalid environment ${index}: ${source}`);
    const record = value as Partial<EnvironmentRecord>;
    safeId(record.id, `environments[${index}].id`);
    if (!record.kind || !ENVIRONMENT_KINDS.has(record.kind)) throw new Error(`invalid environment kind: ${record.id}`);
    uniqueStrings(record.packages, `environments[${index}].packages`, safeId);
    optionalText(record.secretsScope, `environments[${index}].secretsScope`);
    optionalText(record.containerPackage, `environments[${index}].containerPackage`);
    optionalText(record.workspacePath, `environments[${index}].workspacePath`);
    normalizedIso(record.createdAt, `environments[${index}].createdAt`);
    return record as EnvironmentRecord;
  });

  const containers = validateUniqueCollection(raw.containers, "container", (value, index) => {
    if (!plainObject(value)) throw new Error(`invalid container ${index}: ${source}`);
    const record = value as Partial<OsContainerRecord>;
    safeId(record.id, `containers[${index}].id`);
    safeId(record.name, `containers[${index}].name`);
    requiredText(record.environment, `containers[${index}].environment`);
    requiredText(record.image, `containers[${index}].image`);
    optionalText(record.channel, `containers[${index}].channel`);
    normalizedIso(record.createdAt, `containers[${index}].createdAt`);
    if (!record.status || !CONTAINER_STATUSES.has(record.status)) throw new Error(`invalid container status: ${record.id}`);
    if (record.profiles !== undefined) uniqueStrings(record.profiles, `containers[${index}].profiles`, safeId);
    if (record.ports !== undefined) {
      if (!Array.isArray(record.ports)) throw new Error(`containers[${index}].ports must be an array`);
      const names = new Set<string>();
      const hostPorts = new Set<number>();
      for (const [portIndex, port] of record.ports.entries()) {
        if (!plainObject(port)) throw new Error(`invalid container port ${record.id}/${portIndex}`);
        safeId(port.name, `containers[${index}].ports[${portIndex}].name`);
        if (
          !Number.isSafeInteger(port.container) ||
          port.container < 1 ||
          port.container > 65_535 ||
          !Number.isSafeInteger(port.host) ||
          port.host < 1 ||
          port.host > 65_535 ||
          names.has(port.name) ||
          hostPorts.has(port.host)
        ) {
          throw new Error(`invalid or duplicate container port: ${record.id}/${port.name}`);
        }
        names.add(port.name);
        hostPorts.add(port.host);
      }
    }
    return record as OsContainerRecord;
  });

  if (raw.activeEnvironmentId !== undefined) {
    safeId(raw.activeEnvironmentId, "activeEnvironmentId");
    if (!environments.some((record) => record.id === raw.activeEnvironmentId)) {
      throw new Error(`active environment does not exist: ${raw.activeEnvironmentId}`);
    }
  }

  return structuredClone({
    schemaVersion: 1,
    activeEnvironmentId: raw.activeEnvironmentId,
    distroPackages,
    containerPackages,
    environments,
    containers,
  });
}

export async function readPackagesAndEnvironmentsState(state: SharedState): Promise<PackagesAndEnvironmentsState> {
  if (!(await Bun.file(state.environmentsFile).exists())) return emptyPackagesAndEnvironmentsState();
  return validatePackagesAndEnvironmentsState(JSON.parse(await Bun.file(state.environmentsFile).text()), state.environmentsFile);
}

export async function writePackagesAndEnvironmentsState(state: SharedState, value: PackagesAndEnvironmentsState): Promise<void> {
  const validated = validatePackagesAndEnvironmentsState(value, state.environmentsFile);
  await withStateFileLock(state, "environments", () =>
    writeTextAtomic(state.environmentsFile, `${JSON.stringify(validated, null, 2)}\n`),
  );
}

export async function updatePackagesAndEnvironmentsState<T>(
  state: SharedState,
  update: (value: PackagesAndEnvironmentsState) => T | Promise<T>,
): Promise<T> {
  return withStateFileLock(state, "environments", async () => {
    const current = await readPackagesAndEnvironmentsState(state);
    const result = await update(current);
    const validated = validatePackagesAndEnvironmentsState(current, state.environmentsFile);
    await writeTextAtomic(state.environmentsFile, `${JSON.stringify(validated, null, 2)}\n`);
    return result;
  });
}

export function notImplementedPackagesAndEnvironments(feature: string): Error {
  return new Error(
    `${feature} is not yet implemented; real OS/container package and environment plumbing requires the Agent OS image and release contracts`,
  );
}
