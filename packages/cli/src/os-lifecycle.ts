#!/usr/bin/env bun
import path from "node:path";
import { commandInvocation } from "./process-command";
import crypto from "node:crypto";
import { createServer } from "node:net";
import { mkdir, rm, stat } from "node:fs/promises";
import type { SharedState } from "./state";
import { ensureSharedState, sharedStateFromEnv } from "./state";
import type { DataRepoRegistration } from "./data-repos";
import { readDataRepos } from "./data-repos";
import type { ContainerPackageRecord, OsContainerRecord } from "./environments";
import { readPackagesAndEnvironmentsState, updatePackagesAndEnvironmentsState } from "./environments";
import { listSecrets } from "./secrets";
import { canonicalChildEnvironment } from "./runtime-paths";

export interface DockerMount {
  host: string;
  container: string;
  mode: "rw" | "ro";
}

export interface DockerPlan {
  command: string;
  args: string[];
  description: string;
}

export interface DockerRunnerOptions {
  cwd: string;
  env: Record<string, string | undefined>;
}

export type DockerRunner = (args: string[], options: DockerRunnerOptions) => Promise<{ code: number; stdout: string; stderr: string }>;

let injectedDockerRunner: DockerRunner | null = null;

export function setDockerRunner(runner: DockerRunner | null): void {
  injectedDockerRunner = runner;
}

export function resetDockerRunner(): void {
  injectedDockerRunner = null;
}

export function dockerBin(env: Record<string, string | undefined>): string {
  return env.ANDROMEDA_DOCKER_BIN?.trim() || "docker";
}

export async function runDocker(
  args: string[],
  options: DockerRunnerOptions,
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (injectedDockerRunner) return injectedDockerRunner(args, options);
  const bin = dockerBin(options.env);
  const proc = Bun.spawn(commandInvocation(bin, args, options.env), {
    cwd: options.cwd,
    env: options.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

export async function runDockerRaw(
  args: string[],
  options: DockerRunnerOptions,
): Promise<number> {
  if (injectedDockerRunner) {
    const result = await injectedDockerRunner(args, options);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return result.code;
  }
  const bin = dockerBin(options.env);
  const proc = Bun.spawn(commandInvocation(bin, args, options.env), {
    cwd: options.cwd,
    env: options.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return proc.exited;
}

export function toPosixPath(input: string): string {
  let normalized = input.replace(/\\/g, "/");
  normalized = normalized.replace(/^([A-Za-z]):\//, (_, drive) => `/${drive.toLowerCase()}/`);
  return normalized;
}

export function containerEnv(dataRepos: DataRepoRegistration[]): Record<string, string> {
  const env: Record<string, string> = {
    ANDROMEDA_ROOT: "/opt/agents-os",
    ANDROMEDA_HOME: "/agents/state",
    ANDROMEDA_WORKSPACE: "/workspace/agents",
    ANDROMEDA_DATA_REPOS: "/agents/state/data-repos.json",
    ANDROMEDA_PACKAGES: "/agents/state/packages.json",
    ANDROMEDA_CREDITS: "/agents/state/credits.json",
    ANDROMEDA_SECRETS: "/agents/state/secrets",
    ANDROMEDA_CLIS: "/agents/state/clis",
    ANDROMEDA_HARNESSES: "/agents/state/harnesses",
    ANDROMEDA_IDENTITY: "/agents/state/identity",
    ANDROMEDA_MEMORY: "/agents/state/memory",
    ANDROMEDA_SESSIONS: "/agents/state/sessions",
    ANDROMEDA_ORCHESTRATOR: "/agents/state/orchestrator",
    ANDROMEDA_SKILLS: "/agents/state/skills",
    ANDROMEDA_PLUGINS: "/agents/state/plugins",
    ANDROMEDA_HOOKS: "/agents/state/hooks",
    ANDROMEDA_TEMPLATES: "/agents/state/templates",
  };
  for (const repo of dataRepos) {
    const key = repo.env ?? `${repo.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_ROOT`;
    env[key] = containerDataRepoPath(repo);
  }
  return env;
}

export function containerDataRepoPath(repo: DataRepoRegistration): string {
  if (repo.id === "andromeda-data") return "/agents/state";
  return `/agents/data/${repo.id}`;
}

async function runtimeEmptyDir(state: SharedState): Promise<string> {
  const dir = path.join(state.stateDir, "runtime", "empty-secrets");
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function containerMounts(
  state: SharedState,
  dataRepos: DataRepoRegistration[],
  options?: { includeSecrets?: boolean; trusted?: boolean },
): Promise<DockerMount[]> {
  const trusted = options?.trusted ?? false;
  const includeSecrets = trusted || (options?.includeSecrets ?? false);

  const mounts: DockerMount[] = [
    { host: toPosixPath(state.stateDir), container: "/agents/state", mode: trusted ? "rw" : "ro" },
    { host: toPosixPath(state.workspaceDir), container: "/workspace/agents", mode: "rw" },
  ];
  for (const repo of dataRepos) {
    const containerPath = containerDataRepoPath(repo);
    if (mounts.some((m) => m.container === containerPath)) continue;
    mounts.push({ host: toPosixPath(repo.path), container: containerPath, mode: "rw" });
  }

  if (!trusted) {
    for (const [host, container] of [
      [state.clisDir, "/agents/state/clis"],
      [state.harnessesDir, "/agents/state/harnesses"],
      [state.skillsDir, "/agents/state/skills"],
      [state.pluginsDir, "/agents/state/plugins"],
      [state.hooksDir, "/agents/state/hooks"],
      [state.templatesDir, "/agents/state/templates"],
      [state.creditsFile, "/agents/state/credits.json"],
      [state.packagesFile, "/agents/state/packages.json"],
      [state.dataReposFile, "/agents/state/data-repos.json"],
      [state.environmentsFile, "/agents/state/environments.json"],
    ] as const) {
      mounts.push({ host: toPosixPath(host), container, mode: "rw" });
    }
  }

  const secretsHost = includeSecrets ? state.secretsDir : await runtimeEmptyDir(state);
  mounts.push({ host: toPosixPath(secretsHost), container: "/agents/state/secrets", mode: trusted ? "rw" : "ro" });
  return mounts;
}

export function defaultContainerName(environment: string): string {
  return `agents-os-${environment}`;
}

export function dockerCreateArgs(options: {
  name: string;
  image: string;
  environment: string;
  channel?: string;
  hostRoot: string;
  mounts: DockerMount[];
  env: Record<string, string>;
  ports?: Array<{ name: string; container: number; host: number }>;
  network?: string;
  restart?: string;
}): string[] {
  const args = ["container", "create", "--name", options.name];
  args.push("--label", "io.andromeda.os.managed=true");
  args.push("--label", `io.andromeda.os.environment=${options.environment}`);
  args.push("--label", `io.andromeda.os.image-channel=${options.channel || "dev"}`);
  args.push("--label", `io.andromeda.os.root=${toPosixPath(options.hostRoot)}`);
  for (const [key, value] of Object.entries(options.env)) args.push("-e", `${key}=${value}`);
  for (const mount of options.mounts) {
    args.push("-v", `${mount.host}:${mount.container}:${mount.mode === "ro" ? "ro" : "rw"}`);
  }
  if (options.ports) {
    for (const port of options.ports) args.push("-p", `${port.host}:${port.container}`);
  }
  if (options.network) args.push("--network", options.network);
  if (options.restart) args.push("--restart", options.restart);
  args.push(options.image);
  return args;
}

export async function buildCreatePlan(state: SharedState, options: {
  name: string;
  image: string;
  environment: string;
  channel?: string;
  ports?: Array<{ name: string; container: number; host: number }>;
  network?: string;
  restart?: string;
  includeSecrets?: boolean;
  trusted?: boolean;
}): Promise<DockerPlan> {
  const dataRepos = await readDataRepos(state);
  const env = containerEnv(dataRepos);
  const mounts = await containerMounts(state, dataRepos, { includeSecrets: options.includeSecrets, trusted: options.trusted });
  const args = dockerCreateArgs({ ...options, hostRoot: state.root, mounts, env });
  return { command: "docker", args, description: `create container ${options.name} from ${options.image}` };
}

export async function readOsState(state: SharedState): Promise<{ images: ContainerPackageRecord[]; containers: OsContainerRecord[] }> {
  const pe = await readPackagesAndEnvironmentsState(state);
  return { images: pe.containerPackages ?? [], containers: pe.containers ?? [] };
}

export async function writeOsState(
  state: SharedState,
  osState: { images: ContainerPackageRecord[]; containers: OsContainerRecord[] },
): Promise<void> {
  await updatePackagesAndEnvironmentsState(state, (current) => {
    current.containerPackages = osState.images;
    current.containers = osState.containers;
  });
}

export async function findContainer(state: SharedState, name: string): Promise<OsContainerRecord | undefined> {
  const { containers } = await readOsState(state);
  return containers.find((c) => c.name === name);
}

export async function ensureContainerRecord(
  state: SharedState,
  record: Omit<OsContainerRecord, "createdAt">,
): Promise<OsContainerRecord> {
  const full: OsContainerRecord = { ...record, createdAt: new Date().toISOString() };
  await updatePackagesAndEnvironmentsState(state, (current) => {
    const index = current.containers.findIndex((item) => item.name === record.name);
    if (index === -1) current.containers.push(full);
    else current.containers[index] = { ...current.containers[index], ...full };
  });
  return full;
}

export async function updateContainerStatus(
  state: SharedState,
  name: string,
  status: OsContainerRecord["status"],
): Promise<void> {
  await updatePackagesAndEnvironmentsState(state, (current) => {
    const container = current.containers.find((item) => item.name === name);
    if (container) container.status = status;
  });
}

export async function removeContainerRecord(state: SharedState, name: string): Promise<void> {
  await updatePackagesAndEnvironmentsState(state, (current) => {
    current.containers = current.containers.filter((item) => item.name !== name);
  });
}

export async function recordImage(
  state: SharedState,
  image: string,
  options: { channel?: string; digest?: string; tags?: string[]; runtime?: "docker" | "podman" },
): Promise<ContainerPackageRecord> {
  const record: ContainerPackageRecord = {
    id: image,
    image,
    digest: options.digest,
    tags: options.tags ?? [options.channel || "dev"],
    runtime: options.runtime ?? "docker",
  };
  await updatePackagesAndEnvironmentsState(state, (current) => {
    const index = current.containerPackages.findIndex((item) => item.id === image);
    if (index === -1) current.containerPackages.push(record);
    else current.containerPackages[index] = { ...current.containerPackages[index], ...record };
  });
  return record;
}

function parseOsArgs(args: string[]): { values: string[]; flags: Record<string, string | boolean> } {
  const values: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      values.push(arg, ...args.slice(index + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      values.push(arg);
      continue;
    }
    const [key, inline] = arg.slice(2).split("=", 2);
    if (inline !== undefined) flags[key] = inline;
    else if (args[index + 1] && !args[index + 1].startsWith("--")) flags[key] = args[++index];
    else flags[key] = true;
  }
  return { values, flags };
}

function requireFlag(name: string, value: string | boolean | undefined): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`--${name} is required`);
  return value;
}

const containerNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

function validateContainerName(name: string): string {
  if (!containerNamePattern.test(name)) throw new Error(`invalid container name: ${name}`);
  return name;
}

export function resolveImageRef(image: string, channel: string): string {
  if (image.includes("@")) return image;
  const colonIndex = image.lastIndexOf(":");
  if (colonIndex !== -1) {
    const afterColon = image.slice(colonIndex + 1);
    if (!afterColon.includes("/")) return image;
  }
  return `${image}:${channel}`;
}

export interface PathSharingResult {
  ok: boolean;
  issues: string[];
  details: Array<{ host: string; container: string; ok: boolean }>;
}

async function isDirectory(file: string): Promise<boolean> {
  try {
    const info = await stat(file);
    return info.isDirectory();
  } catch {
    return false;
  }
}

async function collectPathSharingPaths(state: SharedState): Promise<Array<{ host: string; container: string }>> {
  const paths: Array<{ host: string; container: string }> = [
    { host: state.stateDir, container: "/agents/state" },
    { host: state.workspaceDir, container: "/workspace/agents" },
  ];
  for (const repo of await readDataRepos(state)) {
    const containerPath = containerDataRepoPath(repo);
    if (paths.some((p) => p.container === containerPath)) continue;
    paths.push({ host: repo.path, container: containerPath });
  }
  return paths;
}

export async function checkPathSharing(
  state: SharedState,
  options?: { image?: string; runner?: DockerRunner },
): Promise<PathSharingResult> {
  const runner = options?.runner ?? runDocker;
  const osImages = (await readOsState(state)).images;
  const firstImage = osImages[0];
  const image = options?.image ?? (firstImage ? resolveImageRef(firstImage.image, firstImage.tags?.[0] || "dev") : undefined);
  if (!image) {
    return { ok: true, issues: [], details: [] };
  }

  const paths = await collectPathSharingPaths(state);
  const details: Array<{ host: string; container: string; ok: boolean }> = [];
  const issues: string[] = [];

  for (const [index, { host, container }] of paths.entries()) {
    if (!(await isDirectory(host))) {
      details.push({ host, container, ok: false });
      issues.push(`Configured host path does not exist: ${host}`);
      continue;
    }
    const pathSentinel = `.andromeda-pathcheck-${crypto.randomUUID()}-${index}`;
    try {
      await Bun.write(path.join(host, pathSentinel), "ok");
      const sentinelContainerPath = `${container}/${pathSentinel}`;
      const args = ["run", "--rm", "--entrypoint", "cat", "-v", `${toPosixPath(host)}:${container}:ro`, image, sentinelContainerPath];
      const result = await runner(args, { cwd: state.root, env: canonicalChildEnvironment() });
      const ok = result.code === 0;
      details.push({ host, container, ok });
      if (!ok) {
        issues.push(`Docker cannot access host path ${host}; verify Docker Desktop path sharing or permissions`);
      }
    } catch {
      details.push({ host, container, ok: false });
      issues.push(`Cannot write sentinel to host path ${host}; check permissions`);
    } finally {
      try {
        await rm(path.join(host, pathSentinel));
      } catch {
        // best-effort cleanup
      }
    }
  }

  return { ok: issues.length === 0, issues, details };
}

export async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

export interface ProfilePreflightResult {
  ok: boolean;
  issues: string[];
}

async function readSharedEnv(state: SharedState): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(canonicalChildEnvironment())) {
    if (value !== undefined) env[key] = value;
  }
  try {
    const text = await Bun.file(state.envFile).text();
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
  } catch {
    // env file may not exist yet
  }
  return env;
}

export async function configuredProfiles(state: SharedState): Promise<string[]> {
  const { containers } = await readOsState(state);
  const set = new Set<string>();
  for (const container of containers) {
    for (const profile of container.profiles ?? []) {
      set.add(profile);
    }
  }
  return [...set];
}

function expectedPortsForProfiles(containers: OsContainerRecord[], profiles: string[]): Set<number> {
  const expected = new Set<number>();
  for (const container of containers) {
    if (container.status !== "running") continue;
    for (const profile of container.profiles ?? []) {
      if (!profiles.includes(profile)) continue;
      for (const port of container.ports ?? []) {
        expected.add(port.host);
      }
    }
  }
  return expected;
}

export async function preflightProfile(
  state: SharedState,
  profile: string,
  options?: { checkPorts?: boolean; expectedPorts?: Set<number>; portChecker?: (port: number) => Promise<boolean> },
): Promise<ProfilePreflightResult> {
  const issues: string[] = [];
  const config = profileConfigs[profile];
  if (!config) {
    return { ok: false, issues: [`unknown profile: ${profile}`] };
  }

  const dataRepos = await readDataRepos(state);
  const secrets = await listSecrets(state);
  const env = await readSharedEnv(state);
  const expectedPorts = options?.expectedPorts ?? new Set<number>();
  const portChecker = options?.portChecker ?? isPortAvailable;

  for (const key of config.requires?.env ?? []) {
    if (!(key in env) || env[key] === "") issues.push(`profile ${profile} requires env ${key}`);
  }
  for (const id of config.requires?.dataRepos ?? []) {
    if (!dataRepos.find((repo) => repo.id === id)) issues.push(`profile ${profile} requires data repo: ${id}`);
  }
  const secretSet = new Set(secrets.map((name) => name.toLowerCase()));
  for (const name of config.requires?.secrets ?? []) {
    if (!secretSet.has(name.toLowerCase())) issues.push(`profile ${profile} requires secret: ${name}`);
  }
  if (options?.checkPorts !== false) {
    for (const port of config.ports ?? []) {
      if (expectedPorts.has(port.host)) continue;
      if (!(await portChecker(port.host))) issues.push(`profile ${profile} host port ${port.host} is in use`);
    }
  }

  return { ok: issues.length === 0, issues };
}

export async function preflightProfiles(
  state: SharedState,
  profiles: string[],
  options?: { checkPorts?: boolean; expectedPorts?: Set<number> },
): Promise<ProfilePreflightResult> {
  const issues: string[] = [];
  for (const profile of profiles) {
    const result = await preflightProfile(state, profile, options);
    issues.push(...result.issues);
  }
  return { ok: issues.length === 0, issues };
}

function requireName(values: string[], index: number): string {
  const name = values[index];
  if (!name) throw new Error("name is required");
  return name;
}

function requireContainerName(values: string[], index: number): string {
  const name = values[index];
  if (!name) throw new Error("container name is required");
  if (!containerNamePattern.test(name)) throw new Error(`invalid container name: ${name}`);
  return name;
}

function safeContainerDataPath(state: SharedState, name: string): string {
  const containersDir = path.join(state.stateDir, "containers");
  const resolved = path.resolve(containersDir, name);
  const rel = path.relative(containersDir, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`invalid container name: ${name}`);
  return resolved;
}

function printPlan(plan: DockerPlan): void {
  console.log(`# ${plan.description}`);
  console.log(`${plan.command} ${plan.args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`);
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function runPlan(plan: DockerPlan, options: DockerRunnerOptions): Promise<boolean> {
  printPlan(plan);
  const result = await runDocker(plan.args, options);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.code !== 0) {
    console.error(result.stderr.trim() || `docker exited ${result.code}`);
    process.exitCode = result.code;
    return false;
  }
  return true;
}

export async function osCommand(rawArgs: string[]): Promise<void> {
  const { values, flags } = parseOsArgs(rawArgs);
  const [subcommand, action] = values;
  const state = sharedStateFromEnv(process.cwd());
  await ensureSharedState(state);
  const runnerOptions: DockerRunnerOptions = { cwd: state.root, env: canonicalChildEnvironment() };

  if (!subcommand || subcommand === "doctor") {
    return osDoctor(state, flags);
  }

  if (subcommand === "image") {
    if (!action || action === "list") return osImageList(state, flags);
    if (action === "build") return osImageBuild(state, flags, runnerOptions);
    if (action === "pull") return osImagePull(state, flags, runnerOptions);
    throw new Error(`unknown image action: ${action}`);
  }

  if (subcommand === "create") return osCreate(state, flags, runnerOptions);
  if (subcommand === "start") return osStart(state, requireContainerName(values, 1), flags, runnerOptions);
  if (subcommand === "stop") return osStop(state, requireContainerName(values, 1), flags, runnerOptions);
  if (subcommand === "status") return osStatus(state, requireContainerName(values, 1), flags);
  if (subcommand === "logs") return osLogs(requireContainerName(values, 1), flags, runnerOptions);
  if (subcommand === "exec") return osExec(requireContainerName(values, 1), values.slice(2), flags, runnerOptions);
  if (subcommand === "terminal") return osTerminal(requireContainerName(values, 1), flags, runnerOptions);
  if (subcommand === "remove") return osRemove(state, requireContainerName(values, 1), flags, runnerOptions);
  if (subcommand === "deploy") return osDeploy(state, requireName(values, 1), flags, runnerOptions);

  throw new Error(`unknown os subcommand: ${subcommand}`);
}

async function osDoctor(state: SharedState, flags: Record<string, string | boolean>): Promise<void> {
  const stateIssues: string[] = [];
  const docker = await runDocker(["--version"], { cwd: state.root, env: canonicalChildEnvironment() });
  if (docker.code !== 0) stateIssues.push("docker not available; install Docker Desktop or Docker Engine");

  for (const file of [state.envFile, state.packagesFile, state.dataReposFile, state.environmentsFile]) {
    if (!(await exists(file))) stateIssues.push(`missing shared state file: ${file}`);
  }

  const dataRepos = await readDataRepos(state);
  for (const repo of dataRepos) {
    if (!(await exists(repo.path))) stateIssues.push(`missing data repo checkout: ${repo.id} at ${repo.path}`);
  }

  const osState = await readOsState(state);
  if (osState.images.length === 0) stateIssues.push("no OS images configured; run agents os image build or pull");

  const pathSharing = docker.code === 0 ? await checkPathSharing(state) : undefined;
  const profiles = await configuredProfiles(state);
  const expectedPorts = expectedPortsForProfiles(osState.containers, profiles);
  const profilePreflight =
    profiles.length > 0
      ? await preflightProfiles(state, profiles, { checkPorts: true, expectedPorts })
      : { ok: true, issues: [] as string[] };

  const issues: string[] = [...stateIssues];
  if (pathSharing && !pathSharing.ok) issues.push(...pathSharing.issues);
  if (!profilePreflight.ok) issues.push(...profilePreflight.issues);

  const report = {
    docker: docker.code === 0 ? { ok: true, version: docker.stdout.trim() } : { ok: false, error: docker.stderr.trim() || "docker not found" },
    pathSharing: pathSharing ? { ok: pathSharing.ok, paths: pathSharing.details } : undefined,
    profiles: { configured: profiles, ok: profilePreflight.ok, issues: profilePreflight.issues },
    state: stateIssues.filter((i) => i.includes("missing")),
    images: osState.images.map((i) => ({ id: i.id, image: i.image, tags: i.tags })),
    containers: osState.containers.map((c) => ({ name: c.name, status: c.status, image: c.image })),
  };

  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    if (docker.code === 0) console.log(`ok docker ${docker.stdout.trim()}`);
    else console.error(report.docker.error);
    if (pathSharing) {
      if (pathSharing.ok) console.log("ok path-sharing");
      else for (const issue of pathSharing.issues) console.error(`warn ${issue}`);
    }
    if (profiles.length > 0) {
      if (profilePreflight.ok) console.log("ok profiles");
      else for (const issue of profilePreflight.issues) console.error(`warn ${issue}`);
    }
    for (const issue of stateIssues) console.error(`warn ${issue}`);
  }

  if (issues.length > 0 || docker.code !== 0) process.exitCode = 1;
}

async function osImageList(state: SharedState, flags: Record<string, string | boolean>): Promise<void> {
  const { images } = await readOsState(state);
  if (flags.json) {
    console.log(JSON.stringify(images, null, 2));
    return;
  }
  if (images.length === 0) {
    console.log("no images configured");
    return;
  }
  for (const image of images) console.log(`${image.id.padEnd(32)} ${(image.tags ?? []).join(", ")}`);
}

async function osImageBuild(
  state: SharedState,
  flags: Record<string, string | boolean>,
  options: DockerRunnerOptions,
): Promise<void> {
  const image = requireFlag("image", flags.image);
  const channel = String(flags.channel || "dev");
  const tag = resolveImageRef(image, channel);
  const dockerfile = String(flags.file || "os/agents-os/Dockerfile");
  const context = String(flags.context || ".");
  const dryRun = Boolean(flags["dry-run"]);

  const plan: DockerPlan = {
    command: "docker",
    args: ["image", "build", "-t", tag, "-f", dockerfile, context],
    description: `build image ${tag}`,
  };

  if (dryRun) {
    printPlan(plan);
    return;
  }

  if (!(await exists(path.resolve(state.root, dockerfile)))) {
    console.error(`dockerfile not found: ${dockerfile}`);
    process.exitCode = 1;
    return;
  }

  if (await runPlan(plan, options)) {
    await recordImage(state, image, { channel, tags: [channel] });
  }
}

async function osImagePull(
  state: SharedState,
  flags: Record<string, string | boolean>,
  options: DockerRunnerOptions,
): Promise<void> {
  const image = requireFlag("image", flags.image);
  const channel = String(flags.channel || "dev");
  const tag = resolveImageRef(image, channel);
  const dryRun = Boolean(flags["dry-run"]);

  const plan: DockerPlan = {
    command: "docker",
    args: ["image", "pull", tag],
    description: `pull image ${tag}`,
  };

  if (dryRun) {
    printPlan(plan);
    return;
  }

  if (await runPlan(plan, options)) {
    await recordImage(state, image, { channel, tags: [channel] });
  }
}

async function osCreate(
  state: SharedState,
  flags: Record<string, string | boolean>,
  options: DockerRunnerOptions,
): Promise<void> {
  const name = validateContainerName(requireFlag("name", flags.name));
  const image = requireFlag("image", flags.image);
  const environment = String(flags.env || "agents-os");
  const channel = String(flags.channel || "dev");
  const dryRun = Boolean(flags["dry-run"]);

  const plan = await buildCreatePlan(state, {
    name,
    image: resolveImageRef(image, channel),
    environment,
    channel,
    ports: [],
    network: typeof flags.network === "string" ? flags.network : undefined,
    restart: typeof flags.restart === "string" ? flags.restart : "no",
    includeSecrets: Boolean(flags["with-secrets"]),
    trusted: Boolean(flags.trusted),
  });

  if (dryRun) {
    printPlan(plan);
    return;
  }

  if (await runPlan(plan, options)) {
    await recordImage(state, image, { channel, tags: [channel] });
    await ensureContainerRecord(state, {
      id: name,
      name,
      environment,
      image: resolveImageRef(image, channel),
      channel,
      status: "created",
    });
  }
}

async function osStart(
  state: SharedState,
  name: string,
  flags: Record<string, string | boolean>,
  options: DockerRunnerOptions,
): Promise<void> {
  const dryRun = Boolean(flags["dry-run"]);
  const plan: DockerPlan = { command: "docker", args: ["container", "start", name], description: `start container ${name}` };
  if (dryRun) return printPlan(plan);
  if (await runPlan(plan, options)) {
    await updateContainerStatus(state, name, "running");
  }
}

async function osStop(
  state: SharedState,
  name: string,
  flags: Record<string, string | boolean>,
  options: DockerRunnerOptions,
): Promise<void> {
  const dryRun = Boolean(flags["dry-run"]);
  const plan: DockerPlan = { command: "docker", args: ["container", "stop", name], description: `stop container ${name}` };
  if (dryRun) return printPlan(plan);
  if (await runPlan(plan, options)) {
    await updateContainerStatus(state, name, "stopped");
  }
}

async function osStatus(
  state: SharedState,
  name: string,
  flags: Record<string, string | boolean>,
): Promise<void> {
  const container = await findContainer(state, name);
  if (!container) throw new Error(`container not found: ${name}`);
  if (flags.json) {
    console.log(JSON.stringify(container, null, 2));
    return;
  }
  console.log(`name:       ${container.name}`);
  console.log(`status:     ${container.status}`);
  console.log(`image:      ${container.image}`);
  console.log(`environment:${container.environment}`);
}

async function osLogs(
  name: string,
  flags: Record<string, string | boolean>,
  options: DockerRunnerOptions,
): Promise<void> {
  const args = ["container", "logs"];
  if (flags.follow) args.push("--follow");
  args.push(name);
  const plan: DockerPlan = { command: "docker", args, description: `logs for container ${name}` };
  if (flags["dry-run"]) return printPlan(plan);
  await runPlan(plan, options);
}

async function osExec(
  name: string,
  rest: string[],
  flags: Record<string, string | boolean>,
  options: DockerRunnerOptions,
): Promise<void> {
  const separator = rest.indexOf("--");
  const execArgs = separator === -1 ? rest : rest.slice(separator + 1);
  if (execArgs.length === 0) throw new Error("exec requires a command after --");
  const plan: DockerPlan = { command: "docker", args: ["container", "exec", name, ...execArgs], description: `exec in container ${name}` };
  if (flags["dry-run"]) return printPlan(plan);
  await runPlan(plan, options);
}

async function osTerminal(
  name: string,
  flags: Record<string, string | boolean>,
  options: DockerRunnerOptions,
): Promise<void> {
  const shell = String(flags.shell || "bash");
  const plan: DockerPlan = { command: "docker", args: ["container", "exec", "-it", name, shell], description: `terminal in container ${name}` };
  if (flags["dry-run"]) return printPlan(plan);
  const code = await runDockerRaw(["container", "exec", "-it", name, shell], options);
  if (code !== 0) process.exitCode = code;
}

async function osRemove(
  state: SharedState,
  name: string,
  flags: Record<string, string | boolean>,
  options: DockerRunnerOptions,
): Promise<void> {
  const pruneData = Boolean(flags["prune-data"]);
  const dryRun = Boolean(flags["dry-run"]);
  const containerDataHost = safeContainerDataPath(state, name);
  const containerDataContainer = `/agents/state/containers/${name}`;
  const rmPlan: DockerPlan = {
    command: "docker",
    args: ["container", "rm", name],
    description: `remove container ${name}`,
  };
  const prunePlan: DockerPlan = {
    command: "rm",
    args: ["-rf", toPosixPath(containerDataHost)],
    description: `prune container-owned data at ${containerDataContainer}`,
  };

  if (dryRun) {
    printPlan(rmPlan);
    if (pruneData) printPlan(prunePlan);
    return;
  }

  if (await runPlan(rmPlan, options)) {
    if (pruneData) {
      console.log(`# pruning ${containerDataHost}`);
      await rm(containerDataHost, { recursive: true, force: true });
    }
    await removeContainerRecord(state, name);
  }
}

export interface ProfileConfig {
  ports?: Array<{ name: string; container: number; host: number }>;
  requires?: {
    env?: string[];
    dataRepos?: string[];
    secrets?: string[];
  };
}

const profileConfigs: Record<string, ProfileConfig> = {
  harness: { ports: [], requires: { env: ["ANDROMEDA_HOME", "ANDROMEDA_WORKSPACE", "ANDROMEDA_SYSTEM_DATA_ROOT"], dataRepos: ["andromeda-data"] } },
  "agent-os-inference": {
    ports: [{ name: "http", container: 8080, host: 8080 }],
    requires: { env: ["ANDROMEDA_HOME", "ANDROMEDA_WORKSPACE", "ANDROMEDA_SYSTEM_DATA_ROOT"], dataRepos: ["andromeda-data"] },
  },
  "agent-os-gateway": {
    ports: [{ name: "http", container: 8787, host: 8787 }],
    requires: {
      env: ["ANDROMEDA_HOME", "ANDROMEDA_WORKSPACE", "ANDROMEDA_SYSTEM_DATA_ROOT", "ANDROMEDA_CREDITS"],
      dataRepos: ["andromeda-data"],
      secrets: ["openai", "github"],
    },
  },
  darkfactory: {
    ports: [],
    requires: { env: ["ANDROMEDA_HOME", "ANDROMEDA_WORKSPACE", "ANDROMEDA_SYSTEM_DATA_ROOT"], dataRepos: ["andromeda-data"], secrets: ["github"] },
  },
  "full-system": {
    ports: [
      { name: "http", container: 8080, host: 8080 },
      { name: "gateway", container: 8787, host: 8787 },
    ],
    requires: {
      env: ["ANDROMEDA_HOME", "ANDROMEDA_WORKSPACE", "ANDROMEDA_SYSTEM_DATA_ROOT", "ANDROMEDA_CREDITS"],
      dataRepos: ["andromeda-data"],
      secrets: ["openai", "github"],
    },
  },
};

async function osDeploy(
  state: SharedState,
  profile: string,
  flags: Record<string, string | boolean>,
  options: DockerRunnerOptions,
): Promise<void> {
  if (!Object.prototype.hasOwnProperty.call(profileConfigs, profile)) {
    throw new Error(`unknown profile: ${profile}`);
  }
  const environment = String(flags.env || "agents-os");
  const image = String(flags.image || "agents-os");
  const channel = String(flags.channel || "dev");
  const name = validateContainerName(String(flags.name || defaultContainerName(environment)));
  const dryRun = Boolean(flags["dry-run"]);

  const plan = await buildCreatePlan(state, {
    name,
    image: resolveImageRef(image, channel),
    environment,
    channel,
    ports: profileConfigs[profile].ports ?? [],
    network: typeof flags.network === "string" ? flags.network : undefined,
    restart: typeof flags.restart === "string" ? flags.restart : "no",
    includeSecrets: Boolean(flags["with-secrets"]),
    trusted: Boolean(flags.trusted),
  });

  const deployPlan: DockerPlan[] = [plan];
  deployPlan.push({
    command: "docker",
    args: ["container", "start", name],
    description: `start deployed container ${name}`,
  });

  if (dryRun) {
    for (const p of deployPlan) printPlan(p);
    return;
  }

  let created = false;
  let started = false;
  for (const p of deployPlan) {
    if (p.description.includes("start") && !created) {
      console.log("# skipping start because create did not succeed");
      continue;
    }
    if (await runPlan(p, options)) {
      if (p.description.includes("create")) created = true;
      if (p.description.includes("start")) started = true;
    }
  }
  if (created || started) {
    await recordImage(state, image, { channel, tags: [channel] });
    await ensureContainerRecord(state, {
      id: name,
      name,
      environment,
      image: resolveImageRef(image, channel),
      channel,
      status: started ? "running" : "created",
      ports: profileConfigs[profile].ports ?? [],
      profiles: [profile],
    });
  }
}
