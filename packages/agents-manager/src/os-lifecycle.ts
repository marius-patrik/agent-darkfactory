#!/usr/bin/env bun
import path from "node:path";
import { mkdir, rm, stat } from "node:fs/promises";
import type { SharedState } from "./state";
import { ensureSharedState, sharedStateFromEnv } from "./state";
import type { DataRepoRegistration } from "./data-repos";
import { readDataRepos } from "./data-repos";
import type { ContainerPackageRecord, OsContainerRecord } from "./environments";
import { readPackagesAndEnvironmentsState, writePackagesAndEnvironmentsState } from "./environments";

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
  return env.AGENTS_DOCKER_BIN?.trim() || "docker";
}

export async function runDocker(
  args: string[],
  options: DockerRunnerOptions,
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (injectedDockerRunner) return injectedDockerRunner(args, options);
  const bin = dockerBin(options.env);
  const proc = Bun.spawn([bin, ...args], {
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
  const proc = Bun.spawn([bin, ...args], {
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
    AGENTS_ROOT: "/opt/agents-os",
    AGENTS_HOME: "/agents/state",
    AGENTS_DATA: "/agents/data",
    AGENTS_WORKSPACE: "/workspace/agents",
    AGENTS_DATA_REPOS: "/agents/state/data-repos.json",
    AGENTS_PACKAGES: "/agents/state/packages.json",
    AGENTS_CREDITS: "/agents/state/credits.json",
    AGENTS_SECRETS: "/agents/state/secrets",
    AGENTS_CLIS: "/agents/state/clis",
    AGENTS_HARNESSES: "/agents/state/harnesses",
    AGENTS_SKILLS: "/agents/state/skills",
    AGENTS_PLUGINS: "/agents/state/plugins",
    AGENTS_HOOKS: "/agents/state/hooks",
    AGENTS_TEMPLATES: "/agents/state/templates",
    AGENTOS_DATA_ROOT: "/agents/data/agentos-data",
  };
  for (const repo of dataRepos) {
    const key = repo.env ?? `${repo.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_ROOT`;
    env[key] = containerDataRepoPath(repo);
  }
  return env;
}

export function containerDataRepoPath(repo: DataRepoRegistration): string {
  if (repo.id === "agentos-data") return "/agents/data/agentos-data";
  if (repo.id === "darkfactory-data") return "/agents/data/darkfactory-data";
  return `/agents/data/${repo.id}`;
}

async function runtimeEmptyDir(state: SharedState): Promise<string> {
  const dir = path.join(state.root, ".agents-runtime-empty");
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
    { host: toPosixPath(state.dataDir), container: "/agents/data", mode: "rw" },
    { host: toPosixPath(state.workspaceDir), container: "/workspace/agents", mode: "rw" },
  ];
  const darkfactoryWorkspace = path.join(state.root, "workspaces", "darkfactory-workspace");
  mounts.push({ host: toPosixPath(darkfactoryWorkspace), container: "/workspace/darkfactory", mode: "rw" });
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
  args.push("--label", "io.agents.os.managed=true");
  args.push("--label", `io.agents.os.environment=${options.environment}`);
  args.push("--label", `io.agents.os.image-channel=${options.channel || "dev"}`);
  args.push("--label", `io.agents.os.root=${toPosixPath(options.hostRoot)}`);
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
  const pe = await readPackagesAndEnvironmentsState(state);
  pe.containerPackages = osState.images;
  pe.containers = osState.containers;
  await writePackagesAndEnvironmentsState(state, pe);
}

export async function findContainer(state: SharedState, name: string): Promise<OsContainerRecord | undefined> {
  const { containers } = await readOsState(state);
  return containers.find((c) => c.name === name);
}

export async function ensureContainerRecord(
  state: SharedState,
  record: Omit<OsContainerRecord, "createdAt">,
): Promise<OsContainerRecord> {
  const osState = await readOsState(state);
  const full: OsContainerRecord = { ...record, createdAt: new Date().toISOString() };
  const index = osState.containers.findIndex((c) => c.name === record.name);
  if (index === -1) osState.containers.push(full);
  else osState.containers[index] = { ...osState.containers[index], ...full };
  await writeOsState(state, osState);
  return full;
}

export async function updateContainerStatus(
  state: SharedState,
  name: string,
  status: OsContainerRecord["status"],
): Promise<void> {
  const osState = await readOsState(state);
  const container = osState.containers.find((c) => c.name === name);
  if (container) {
    container.status = status;
    await writeOsState(state, osState);
  }
}

export async function removeContainerRecord(state: SharedState, name: string): Promise<void> {
  const osState = await readOsState(state);
  osState.containers = osState.containers.filter((c) => c.name !== name);
  await writeOsState(state, osState);
}

export async function recordImage(
  state: SharedState,
  image: string,
  options: { channel?: string; digest?: string; tags?: string[]; runtime?: "docker" | "podman" },
): Promise<ContainerPackageRecord> {
  const osState = await readOsState(state);
  const record: ContainerPackageRecord = {
    id: image,
    image,
    digest: options.digest,
    tags: options.tags ?? [options.channel || "dev"],
    runtime: options.runtime ?? "docker",
  };
  const index = osState.images.findIndex((i) => i.id === image);
  if (index === -1) osState.images.push(record);
  else osState.images[index] = { ...osState.images[index], ...record };
  await writeOsState(state, osState);
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
  const runnerOptions: DockerRunnerOptions = { cwd: state.root, env: process.env };

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
  const issues: string[] = [];
  const docker = await runDocker(["--version"], { cwd: state.root, env: process.env });
  if (docker.code !== 0) issues.push("docker not available; install Docker Desktop or Docker Engine");

  for (const file of [state.envFile, state.packagesFile, state.dataReposFile, state.environmentsFile]) {
    if (!(await exists(file))) issues.push(`missing shared state file: ${file}`);
  }

  const dataRepos = await readDataRepos(state);
  for (const id of ["agentos-data", "darkfactory-data"]) {
    if (!dataRepos.find((r) => r.id === id)) issues.push(`missing data repo registration: ${id}`);
  }

  const osState = await readOsState(state);
  if (osState.images.length === 0) issues.push("no OS images configured; run agents os image build or pull");

  const report = {
    docker: docker.code === 0 ? { ok: true, version: docker.stdout.trim() } : { ok: false, error: docker.stderr.trim() || "docker not found" },
    state: issues.filter((i) => i.includes("missing")),
    images: osState.images.map((i) => ({ id: i.id, image: i.image, tags: i.tags })),
    containers: osState.containers.map((c) => ({ name: c.name, status: c.status, image: c.image })),
  };

  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    if (docker.code === 0) console.log(`ok docker ${docker.stdout.trim()}`);
    else console.error(report.docker.error);
    for (const issue of issues) console.error(`warn ${issue}`);
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

const profilePorts: Record<string, Array<{ name: string; container: number; host: number }>> = {
  harness: [],
  "inference-engine": [{ name: "http", container: 8080, host: 8080 }],
  "llm-gateway": [{ name: "http", container: 8787, host: 8787 }],
  darkfactory: [],
  "full-system": [
    { name: "http", container: 8080, host: 8080 },
    { name: "gateway", container: 8787, host: 8787 },
  ],
};

async function osDeploy(
  state: SharedState,
  profile: string,
  flags: Record<string, string | boolean>,
  options: DockerRunnerOptions,
): Promise<void> {
  if (!Object.prototype.hasOwnProperty.call(profilePorts, profile)) {
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
    ports: profilePorts[profile],
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
      ports: profilePorts[profile],
      profiles: [profile],
    });
  }
}
