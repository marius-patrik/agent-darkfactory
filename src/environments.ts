import type { SharedState } from "./state";

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

export async function readPackagesAndEnvironmentsState(state: SharedState): Promise<PackagesAndEnvironmentsState> {
  if (!(await Bun.file(state.environmentsFile).exists())) return emptyPackagesAndEnvironmentsState();
  const raw = JSON.parse(await Bun.file(state.environmentsFile).text()) as Partial<PackagesAndEnvironmentsState>;
  return {
    schemaVersion: 1,
    activeEnvironmentId: raw.activeEnvironmentId,
    distroPackages: raw.distroPackages ?? [],
    containerPackages: raw.containerPackages ?? [],
    environments: raw.environments ?? [],
    containers: raw.containers ?? [],
  };
}

export async function writePackagesAndEnvironmentsState(state: SharedState, value: PackagesAndEnvironmentsState): Promise<void> {
  await Bun.write(state.environmentsFile, `${JSON.stringify(value, null, 2)}\n`);
}

export function notImplementedPackagesAndEnvironments(feature: string): Error {
  return new Error(
    `${feature} is not yet implemented; real OS/container package and environment plumbing depends on agents-mono#8 and agents-mono#9`,
  );
}
