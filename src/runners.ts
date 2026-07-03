import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const RUNNER_LABEL = "df-local";
export const STATE_VERSION = 1;
export const DEFAULT_RUNNER_ROOT = "C:/Users/patrik/.darkfactory/runners";

export interface RepositoryRef {
  owner: string;
  repo: string;
}

export interface RunnerRecord extends RepositoryRef {
  directory: string;
  labels: string[];
  pid?: number;
  runnerName: string;
  url: string;
  workDirectory: string;
  configuredAt: string;
  startedAt?: string;
}

export interface RunnerState {
  version: 1;
  root: string;
  runners: Record<string, RunnerRecord>;
}

export interface RegistrationToken {
  token: string;
}

export interface RunnerRelease {
  version: string;
  downloadUrl: string;
  assetName: string;
}

export interface GitHubRunner {
  id: number;
  name: string;
  os: string;
  status: "online" | "offline" | string;
  busy: boolean;
  labels: string[];
}

export interface GitHubRunnerClient {
  createRegistrationToken(repository: RepositoryRef): Promise<RegistrationToken>;
  createRemovalToken(repository: RepositoryRef): Promise<RegistrationToken>;
  listRunners(repository: RepositoryRef): Promise<GitHubRunner[]>;
  getLatestWindowsX64RunnerRelease(): Promise<RunnerRelease>;
}

export interface CommandRunner {
  exec(file: string, args: string[], options?: { cwd?: string }): Promise<{ stdout: string; stderr: string }>;
  spawnDetached(file: string, args: string[], options?: { cwd?: string }): { pid: number };
}

export interface Downloader {
  download(url: string, destination: string): Promise<void>;
}

export interface RunnerManagerDependencies {
  github: GitHubRunnerClient;
  commands?: CommandRunner;
  downloader?: Downloader;
  now?: () => Date;
}

export interface RunnerCommandOptions {
  root?: string;
}

export type RunnerCommand =
  | { action: "setup"; repository: RepositoryRef; root?: string }
  | { action: "start"; repository?: RepositoryRef; root?: string }
  | { action: "stop"; repository?: RepositoryRef; root?: string }
  | { action: "status"; repository?: RepositoryRef; root?: string }
  | { action: "remove"; repository: RepositoryRef; root?: string };

export interface RunnerStatus {
  repository: string;
  runnerName: string;
  directory: string;
  pid?: number;
  process: "running" | "stopped" | "unknown";
  github: "online" | "offline" | "missing" | string;
  busy?: boolean;
}

export class RunnerManager {
  private readonly commands: CommandRunner;
  private readonly downloader: Downloader;
  private readonly now: () => Date;
  private readonly github: GitHubRunnerClient;

  constructor(dependencies: RunnerManagerDependencies) {
    this.github = dependencies.github;
    this.commands = dependencies.commands ?? defaultCommandRunner;
    this.downloader = dependencies.downloader ?? defaultDownloader;
    this.now = dependencies.now ?? (() => new Date());
  }

  async setup(repository: RepositoryRef, options: RunnerCommandOptions = {}): Promise<RunnerRecord> {
    const root = runnerRoot(options.root);
    const state = await readRunnerState(root);
    const directory = runnerDirectory(root, repository);
    const release = await this.github.getLatestWindowsX64RunnerRelease();
    const archivePath = join(root, "_cache", release.assetName);

    await mkdir(directory, { recursive: true });
    await mkdir(dirname(archivePath), { recursive: true });

    if (!existsSync(archivePath)) {
      await this.downloader.download(release.downloadUrl, archivePath);
    }

    if (!existsSync(join(directory, "config.cmd"))) {
      await this.commands.exec("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "& { param($archive, $destination) Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force }",
        archivePath,
        directory
      ]);
    }

    const token = await this.github.createRegistrationToken(repository);
    const runnerName = runnerNameFor(repository);
    const url = repositoryUrl(repository);

    await this.commands.exec(
      "cmd.exe",
      [
        "/d",
        "/c",
        ".\\config.cmd",
        "--unattended",
        "--url",
        url,
        "--token",
        token.token,
        "--name",
        runnerName,
        "--labels",
        RUNNER_LABEL,
        "--work",
        "_work",
        "--replace"
      ],
      { cwd: directory }
    );

    const record: RunnerRecord = {
      owner: repository.owner,
      repo: repository.repo,
      directory,
      labels: [RUNNER_LABEL],
      runnerName,
      url,
      workDirectory: "_work",
      configuredAt: this.now().toISOString()
    };

    state.root = root;
    state.runners[stateKey(repository)] = record;
    await writeRunnerState(root, state);

    return record;
  }

  async start(repository: RepositoryRef, options: RunnerCommandOptions = {}): Promise<RunnerRecord> {
    const root = runnerRoot(options.root);
    const state = await readRunnerState(root);
    const record = getRunnerRecord(state, repository);

    if (record.pid && isProcessRunning(record.pid)) {
      return record;
    }

    const process = this.commands.spawnDetached("cmd.exe", ["/d", "/c", ".\\run.cmd"], { cwd: record.directory });
    const updated: RunnerRecord = {
      ...record,
      pid: process.pid,
      startedAt: this.now().toISOString()
    };

    state.runners[stateKey(repository)] = updated;
    await writeRunnerState(root, state);

    return updated;
  }

  async stop(repository: RepositoryRef, options: RunnerCommandOptions = {}): Promise<RunnerRecord> {
    const root = runnerRoot(options.root);
    const state = await readRunnerState(root);
    const record = getRunnerRecord(state, repository);

    await stopRunnerProcess(record.pid, this.commands);

    const updated: RunnerRecord = { ...record };
    delete updated.pid;
    delete updated.startedAt;
    state.runners[stateKey(repository)] = updated;
    await writeRunnerState(root, state);

    return updated;
  }

  async list(options: RunnerCommandOptions = {}): Promise<RunnerRecord[]> {
    const root = runnerRoot(options.root);
    const state = await readRunnerState(root);
    return Object.values(state.runners);
  }

  async status(repository: RepositoryRef | undefined, options: RunnerCommandOptions = {}): Promise<RunnerStatus[]> {
    const root = runnerRoot(options.root);
    const state = await readRunnerState(root);
    const records = repository ? [getRunnerRecord(state, repository)] : Object.values(state.runners);
    const statuses: RunnerStatus[] = [];

    for (const record of records) {
      const githubRunner = await this.findGitHubRunner(record);

      statuses.push({
        repository: `${record.owner}/${record.repo}`,
        runnerName: record.runnerName,
        directory: record.directory,
        pid: record.pid,
        process: record.pid ? (isProcessRunning(record.pid) ? "running" : "stopped") : "unknown",
        github: githubRunner?.status ?? "missing",
        busy: githubRunner?.busy
      });
    }

    return statuses;
  }

  async remove(repository: RepositoryRef, options: RunnerCommandOptions = {}): Promise<RunnerRecord> {
    const root = runnerRoot(options.root);
    const state = await readRunnerState(root);
    const record = getRunnerRecord(state, repository);

    await stopRunnerProcess(record.pid, this.commands);

    if (existsSync(join(record.directory, "config.cmd"))) {
      const token = await this.github.createRemovalToken(repository);
      await this.commands.exec(
        "cmd.exe",
        ["/d", "/c", ".\\config.cmd", "remove", "--unattended", "--token", token.token],
        { cwd: record.directory }
      );
    }

    assertWithinRoot(root, record.directory);
    await rm(record.directory, { recursive: true, force: true });
    delete state.runners[stateKey(repository)];
    await writeRunnerState(root, state);

    return record;
  }

  private async findGitHubRunner(record: RunnerRecord): Promise<GitHubRunner | null> {
    const runners = await this.github.listRunners(record);
    return runners.find((runner) => runner.name === record.runnerName) ?? null;
  }
}

export class GhCliRunnerClient implements GitHubRunnerClient {
  constructor(private readonly commands: CommandRunner = defaultCommandRunner) {}

  async createRegistrationToken(repository: RepositoryRef): Promise<RegistrationToken> {
    return parseTokenResponse(
      await this.ghJson(["api", "--method", "POST", `repos/${repository.owner}/${repository.repo}/actions/runners/registration-token`])
    );
  }

  async createRemovalToken(repository: RepositoryRef): Promise<RegistrationToken> {
    return parseTokenResponse(
      await this.ghJson(["api", "--method", "POST", `repos/${repository.owner}/${repository.repo}/actions/runners/remove-token`])
    );
  }

  async listRunners(repository: RepositoryRef): Promise<GitHubRunner[]> {
    return mapRunnerListResponse(
      await this.ghJson(["api", `repos/${repository.owner}/${repository.repo}/actions/runners`, "--paginate"])
    );
  }

  async getLatestWindowsX64RunnerRelease(): Promise<RunnerRelease> {
    return selectWindowsX64Asset(await this.ghJson(["api", "repos/actions/runner/releases/latest"]));
  }

  private async ghJson(args: string[]): Promise<unknown> {
    const result = await this.commands.exec("gh", args);
    try {
      return JSON.parse(result.stdout) as unknown;
    } catch (error) {
      throw new Error(`gh returned non-JSON output: ${String(error)}`);
    }
  }
}

export function parseRunnerCommand(args: string[]): RunnerCommand {
  const [action, ...rest] = args;
  const parsed = parseOptions(rest);

  if (!action || action === "help" || action === "--help" || action === "-h") {
    throw new Error("missing runners action");
  }

  if (action === "setup" || action === "remove") {
    const repository = parsed.positionals[0];
    if (!repository) throw new Error(`runners ${action} requires <owner/repo>`);
    if (parsed.positionals.length > 1) throw new Error(`unexpected argument: ${parsed.positionals[1]}`);
    return { action, repository: parseRepositoryRef(repository), root: parsed.root };
  }

  if (action === "start" || action === "stop" || action === "status") {
    if (parsed.positionals.length > 1) throw new Error(`unexpected argument: ${parsed.positionals[1]}`);
    return {
      action,
      repository: parsed.positionals[0] ? parseRepositoryRef(parsed.positionals[0]) : undefined,
      root: parsed.root
    };
  }

  throw new Error(`unknown runners action: ${action}`);
}

export function runnerRoot(root?: string): string {
  return resolve(root ?? process.env.DF_RUNNER_ROOT ?? DEFAULT_RUNNER_ROOT);
}

export function parseRepositoryRef(value: string): RepositoryRef {
  const parts = value.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("repository must be in owner/repo form");
  }

  return { owner: parts[0], repo: parts[1] };
}

export function runnerNameFor(repository: RepositoryRef): string {
  return `df-${sanitizeName(repository.repo)}`;
}

export function runnerDirectory(root: string, repository: RepositoryRef): string {
  return join(root, sanitizeName(repository.repo));
}

export async function readRunnerState(root: string): Promise<RunnerState> {
  const statePath = runnerStatePath(root);

  if (!existsSync(statePath)) {
    return { version: STATE_VERSION, root, runners: {} };
  }

  const parsed = JSON.parse(await readFile(statePath, "utf8")) as unknown;

  if (!isRecord(parsed) || parsed.version !== STATE_VERSION || !isRecord(parsed.runners)) {
    throw new Error(`invalid runner state file: ${statePath}`);
  }

  return {
    version: STATE_VERSION,
    root: typeof parsed.root === "string" ? parsed.root : root,
    runners: parsed.runners as Record<string, RunnerRecord>
  };
}

export async function writeRunnerState(root: string, state: RunnerState): Promise<void> {
  const statePath = runnerStatePath(root);
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify({ ...state, root }, null, 2)}\n`, "utf8");
}

export function runnerStatePath(root: string): string {
  return join(root, "state.json");
}

export function stateKey(repository: RepositoryRef): string {
  return `${repository.owner}/${repository.repo}`.toLowerCase();
}

export function mapRunnerListResponse(data: unknown): GitHubRunner[] {
  if (!isRecord(data) || !Array.isArray(data.runners)) {
    throw new Error("GitHub returned an invalid runners list response");
  }

  return data.runners.map((runner) => {
    if (!isRecord(runner) || typeof runner.id !== "number" || typeof runner.name !== "string") {
      throw new Error("GitHub returned an invalid runner record");
    }

    return {
      id: runner.id,
      name: runner.name,
      os: typeof runner.os === "string" ? runner.os : "unknown",
      status: typeof runner.status === "string" ? runner.status : "unknown",
      busy: typeof runner.busy === "boolean" ? runner.busy : false,
      labels: Array.isArray(runner.labels)
        ? runner.labels.flatMap((label) => (isRecord(label) && typeof label.name === "string" ? [label.name] : []))
        : []
    };
  });
}

export function selectWindowsX64Asset(data: unknown): RunnerRelease {
  if (!isRecord(data) || typeof data.tag_name !== "string" || !Array.isArray(data.assets)) {
    throw new Error("GitHub returned an invalid actions-runner release response");
  }

  const asset = data.assets.find(
    (candidate) =>
      isRecord(candidate) &&
      typeof candidate.name === "string" &&
      /^actions-runner-win-x64-\d+\.\d+\.\d+\.zip$/.test(candidate.name) &&
      typeof candidate.browser_download_url === "string"
  );

  if (!isRecord(asset) || typeof asset.name !== "string" || typeof asset.browser_download_url !== "string") {
    throw new Error("latest actions-runner release does not include a Windows x64 zip");
  }

  return {
    version: data.tag_name,
    assetName: asset.name,
    downloadUrl: asset.browser_download_url
  };
}

function parseOptions(args: string[]): { root?: string; positionals: string[] } {
  const positionals: string[] = [];
  let root: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--root") {
      root = args[index + 1];
      if (!root) throw new Error("--root requires a path");
      index += 1;
      continue;
    }

    if (arg.startsWith("--root=")) {
      root = arg.slice("--root=".length);
      if (!root) throw new Error("--root requires a path");
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`unknown option: ${arg}`);
    }

    positionals.push(arg);
  }

  return { root, positionals };
}

function getRunnerRecord(state: RunnerState, repository: RepositoryRef): RunnerRecord {
  const record = state.runners[stateKey(repository)];
  if (!record) {
    throw new Error(`runner is not set up for ${repository.owner}/${repository.repo}`);
  }

  return record;
}

async function stopRunnerProcess(pid: number | undefined, commands: CommandRunner): Promise<void> {
  if (!pid || !isProcessRunning(pid)) return;
  await commands.exec("taskkill.exe", ["/PID", String(pid), "/T", "/F"]);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function repositoryUrl(repository: RepositoryRef): string {
  return `https://github.com/${repository.owner}/${repository.repo}`;
}

function sanitizeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "-");
}

function assertWithinRoot(root: string, target: string): void {
  const resolvedRoot = resolve(root).toLowerCase();
  const resolvedTarget = resolve(target).toLowerCase();

  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}\\`)) {
    throw new Error(`refusing to remove runner directory outside root: ${target}`);
  }
}

function parseTokenResponse(data: unknown): RegistrationToken {
  if (!isRecord(data) || typeof data.token !== "string" || data.token.length === 0) {
    throw new Error("GitHub returned an invalid runner token response");
  }

  return { token: data.token };
}

const defaultCommandRunner: CommandRunner = {
  async exec(file, args, options) {
    try {
      const result = await execFileAsync(file, args, {
        cwd: options?.cwd,
        maxBuffer: 1024 * 1024 * 20,
        windowsHide: true
      });

      return {
        stdout: result.stdout,
        stderr: result.stderr
      };
    } catch (error) {
      if (isRecord(error)) {
        const code = typeof error.code === "number" || typeof error.code === "string" ? ` exit ${error.code}` : "";
        const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
        const stdout = typeof error.stdout === "string" ? error.stdout.trim() : "";
        const detail = stderr || stdout || "child process failed";
        throw new Error(`${file} failed${code}: ${detail}`);
      }

      throw error;
    }
  },
  spawnDetached(file, args, options) {
    const child = spawn(file, args, {
      cwd: options?.cwd,
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();

    if (!child.pid) {
      throw new Error(`failed to start ${file}`);
    }

    return { pid: child.pid };
  }
};

const defaultDownloader: Downloader = {
  async download(url, destination) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`failed to download ${url}: HTTP ${response.status}`);
    }

    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, Buffer.from(await response.arrayBuffer()));
  }
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
