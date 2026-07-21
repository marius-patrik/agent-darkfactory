import path from "node:path";
import { lstat, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { SharedState } from "./state";
import { sharedStateFromEnv } from "./state";
import { writeTextAtomic } from "./state-v2";
import { withStateFileLock } from "./state-lock";
import { doctorState, launcherNameForPlatform, type StateDoctorReport } from "./state-doctor";
import { readSecret } from "./secrets";
import { canonicalChildEnvironment } from "./runtime-paths";
import { commandInvocation } from "./process-command";

/**
 * Agent OS-owned lifecycle for the trusted DarkFactory `df-local` GitHub Actions
 * runner (issue #245). The manager provisions and registers the runner, persists
 * it across reboot/logon with a least-privilege per-user scheduled task, binds
 * execution to the canonical `bin\agents.ps1` launcher, gates every start on a
 * healthy `andromeda state doctor`, never persists a registration token, reconciles
 * stale/duplicate registrations and processes, and reports redacted health for
 * DarkFactory doctor/dispatcher consumption.
 *
 * Every host, scheduler, and GitHub boundary is injectable so tests never touch
 * the live runner, Task Scheduler, services, or personal state.
 */

export const RUNNER_NAME = "df-darkfactory-agent";
export const RUNNER_REPOSITORY = "marius-patrik/DarkFactory";
export const RUNNER_LABELS = ["self-hosted", "Windows", "X64", "df-local"] as const;
export const RUNNER_SCHEDULED_TASK = "AgentOS-df-local-runner";
export const RUNNER_SCHEDULED_TASK_PATH = "\\";
// Agent OS secret names use the same uppercase identifier contract as every
// other canonical secret. Keep the runner credential inside that public CLI
// surface so `andromeda secrets set` can actually provision the live control
// plane instead of referring to an impossible lowercase filename.
export const RUNNER_GITHUB_CREDENTIAL = "GITHUB_TOKEN";

/**
 * Resolve the inbox Windows PowerShell host from the OS-owned SystemRoot
 * contract. Never let Task Scheduler or a manager subprocess search ambient
 * PATH for a same-named executable.
 */
export function windowsPowerShellExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = (env.SystemRoot || env.SYSTEMROOT || "C:\\Windows").trim();
  if (!path.win32.isAbsolute(systemRoot) || systemRoot.includes('"')) {
    throw new Error("Windows SystemRoot is not an absolute trusted path");
  }
  return path.win32.join(
    path.win32.normalize(systemRoot),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

/** Pinned upstream GitHub Actions runner used to provision the host software. */
export const RUNNER_SOFTWARE = {
  version: "2.335.1",
  asset: "actions-runner-win-x64-2.335.1.zip",
  sha256: "eb65c95277af42bcf3778a799c41359d224ba2a67b4de26b7cea1729b09c803d",
  sizeBytes: 99986249,
  url: "https://github.com/actions/runner/releases/download/v2.335.1/actions-runner-win-x64-2.335.1.zip",
} as const;

const REDACTED = "<redacted>";
const RUNNER_RECORD_KEY = "runner";
const RUNNER_START_OBSERVATION_TIMEOUT_MS = 15_000;
const RUNNER_START_OBSERVATION_INTERVAL_MS = 100;
// Pinned runner v2.335.1 retries a retained server-session conflict every
// 30 seconds for up to four minutes. Keep remote readiness separate from the
// fast local ownership proof and leave bounded transport/observation margin.
const RUNNER_READINESS_OBSERVATION_TIMEOUT_MS = 5 * 60_000;
const RUNNER_READINESS_OBSERVATION_INTERVAL_MS = 5_000;
const RUNNER_TERMINATION_GRACE_MS = 2_500;

export interface RunnerRecord {
  schemaVersion: 1;
  name: string;
  repo: string;
  labels: string[];
  installDir: string;
  launcherPath: string;
  scheduledTask: string;
  runnerId: number | null;
  registered: boolean;
  enabled: boolean;
  provisionedAt: string | null;
  registeredAt: string | null;
  lastRepairedAt: string | null;
}

export interface ScheduledTaskIdentity {
  name: string;
  path: string;
}

export interface ScheduledTaskSpec extends ScheduledTaskIdentity {
  /** Absolute inbox Windows PowerShell executable used by the task. */
  executable: string;
  /** Full argument string bound to the canonical launcher. */
  arguments: string;
  /** Exact preflight-resolved Windows principal used by trigger and principal creation. */
  principalUser: string;
}

export interface ScheduledTaskInfo extends ScheduledTaskIdentity {
  enabled: boolean;
  state: string;
  actionCount: number;
  actionExecutable: string | null;
  actionArguments: string | null;
  triggerCount: number;
  triggerKind: string | null;
  triggerUser: string | null;
  principalUser: string;
  principalLogonType: string;
  principalRunLevel: string;
  multipleInstances: string;
  allowStartIfOnBatteries: boolean;
  dontStopIfGoingOnBatteries: boolean;
  restartCount: number;
  restartInterval: string;
  executionTimeLimit: string;
}

export interface RunnerRegistration {
  id: number;
  name: string;
  os: string;
  status: string;
  busy: boolean;
  labels: string[];
  /** Provider-owned metadata, when exposed by the control plane. */
  version?: string | null;
  lastHeartbeat?: string | null;
}

export interface RunnerProcess {
  pid: number;
  executablePath: string;
  startedAt: string;
  commandLine?: string;
}

/** Exact process ownership returned by the host start boundary. */
export interface RunnerRunHandle {
  process: RunnerProcess;
  exited: Promise<number>;
  /** Terminate only the PID + executable + creation-time identity above. */
  terminate(): Promise<void>;
}

interface RunnerConfiguration {
  agentId: number;
  agentName: string;
  gitHubUrl: string;
  disableUpdate: boolean;
}

export interface RunnerConfigureOptions {
  url: string;
  token: string;
  name: string;
  labels: string[];
}

/** Persistence boundary (Windows per-user scheduled task). Only ever targets the exact task name. */
export interface RunnerScheduler {
  query(identity: ScheduledTaskIdentity): Promise<ScheduledTaskInfo | null>;
  create(spec: ScheduledTaskSpec): Promise<void>;
  setEnabled(identity: ScheduledTaskIdentity, enabled: boolean): Promise<void>;
  start(identity: ScheduledTaskIdentity): Promise<void>;
}

/** GitHub control-plane boundary for short-lived registration credentials and reconciliation. */
export interface RunnerGitHub {
  createRegistrationToken(repo: string): Promise<{ token: string; expiresAt: string }>;
  listRunners(repo: string): Promise<RunnerRegistration[]>;
  removeRunner(repo: string, id: number): Promise<void>;
}

/** Host runner-software and process boundary. */
export interface RunnerHost {
  isProvisioned(dir: string): Promise<boolean>;
  provision(dir: string): Promise<void>;
  isConfigured(dir: string): Promise<boolean>;
  /** Delete only this install's local configuration; never touch its server registration. */
  resetLocalConfiguration(dir: string): Promise<void>;
  configure(dir: string, options: RunnerConfigureOptions): Promise<void>;
  runnerVersion(dir: string): Promise<string | null>;
  runningInstances(dir: string): Promise<RunnerProcess[]>;
  stopInstances(instances: RunnerProcess[]): Promise<void>;
  run(dir: string, env: Record<string, string | undefined>): Promise<RunnerRunHandle>;
}

interface RunnerSoftwareDescriptor {
  version: string;
  asset: string;
  sha256: string;
  sizeBytes: number;
  url: string;
}

interface RunnerAssetResponse {
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface WindowsRunnerHostOptions {
  software?: RunnerSoftwareDescriptor;
  fetchAsset?: (url: string) => Promise<RunnerAssetResponse>;
  runPowerShell?: (script: string) => Promise<ProcessResult>;
  runProcess?: (
    argv: string[],
    options?: { cwd?: string; env?: Record<string, string | undefined>; input?: string },
  ) => Promise<ProcessResult>;
  lstat?: (filePath: string) => Promise<{ isFile(): boolean; isSymbolicLink(): boolean }>;
  configurationLstat?: (filePath: string) => Promise<{ isFile(): boolean; isSymbolicLink(): boolean }>;
  readFile?: (filePath: string, encoding: "utf8") => Promise<string>;
  spawnRunner?: (
    argv: string[],
    options: { cwd: string; env: Record<string, string | undefined> },
  ) => { pid: number; exited: Promise<number>; kill(): void };
  /** Test-only host ownership timings; production shares the lifecycle start contract. */
  ownershipObservationTimeoutMs?: number;
  ownershipObservationIntervalMs?: number;
  terminationGraceMs?: number;
}

export interface RunnerDeps {
  platform?: NodeJS.Platform;
  now?: () => Date;
  doctor?: (state: SharedState) => Promise<StateDoctorReport>;
  scheduler?: RunnerScheduler;
  github?: RunnerGitHub;
  host?: RunnerHost;
  /** Resolve the current Windows principal; injectable for deterministic preflight tests. */
  principal?: () => string;
  /** Read the canonical GitHub credential; injectable so tests never read personal secrets. */
  readCredential?: (state: SharedState, name: string) => Promise<string>;
  /** Test-only bounded observation controls; production uses the constants below. */
  startObservationTimeoutMs?: number;
  startObservationIntervalMs?: number;
  /** Test-only remote readiness controls; start overrides remain a compatibility fallback. */
  readinessObservationTimeoutMs?: number;
  readinessObservationIntervalMs?: number;
}

let injectedDeps: RunnerDeps | null = null;

export function setRunnerDeps(deps: RunnerDeps | null): void {
  injectedDeps = deps;
}

export function resetRunnerDeps(): void {
  injectedDeps = null;
}

interface ResolvedDeps {
  platform: NodeJS.Platform;
  now: () => Date;
  doctor: (state: SharedState) => Promise<StateDoctorReport>;
  scheduler: RunnerScheduler;
  host: RunnerHost;
  principal: () => string;
  readCredential: (state: SharedState, name: string) => Promise<string>;
  startObservationTimeoutMs: number;
  startObservationIntervalMs: number;
  readinessObservationTimeoutMs: number;
  readinessObservationIntervalMs: number;
}

function resolveDeps(overrides: RunnerDeps = {}): ResolvedDeps {
  const merged = { ...injectedDeps, ...overrides };
  return {
    platform: merged.platform ?? process.platform,
    now: merged.now ?? (() => new Date()),
    doctor: merged.doctor ?? doctorState,
    scheduler: merged.scheduler ?? windowsScheduler(),
    host: merged.host ?? windowsRunnerHost(),
    principal: merged.principal ?? currentWindowsPrincipal,
    readCredential: merged.readCredential ?? ((state, name) => readSecret(state, name)),
    startObservationTimeoutMs: merged.startObservationTimeoutMs ?? RUNNER_START_OBSERVATION_TIMEOUT_MS,
    startObservationIntervalMs: merged.startObservationIntervalMs ?? RUNNER_START_OBSERVATION_INTERVAL_MS,
    readinessObservationTimeoutMs:
      merged.readinessObservationTimeoutMs ??
      merged.startObservationTimeoutMs ??
      RUNNER_READINESS_OBSERVATION_TIMEOUT_MS,
    readinessObservationIntervalMs:
      merged.readinessObservationIntervalMs ??
      merged.startObservationIntervalMs ??
      RUNNER_READINESS_OBSERVATION_INTERVAL_MS,
  };
}

/** Resolve the GitHub control plane, binding the live default to state for credential reads. */
function resolveGitHub(state: SharedState, deps: ResolvedDeps, overrides: RunnerDeps): RunnerGitHub {
  return overrides.github ?? injectedDeps?.github ?? githubControlPlane(state, deps.readCredential, deps.now);
}

// ---------------------------------------------------------------------------
// Paths and canonical record
// ---------------------------------------------------------------------------

export function runnerInstallDir(state: SharedState): string {
  return path.join(state.stateDir, "runner");
}

export function runnerLauncherPath(state: SharedState, platform: NodeJS.Platform): string {
  return path.join(state.stateDir, "bin", launcherNameForPlatform(platform));
}

function runnerRecordFile(state: SharedState): string {
  return path.join(state.stateDir, "runner.json");
}

function runnerRepositoryUrl(repo: string): string {
  return `https://github.com/${repo}`;
}

function isoOrNull(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
    ? value
    : null;
}

function validateRunnerRecord(value: unknown, source: string): RunnerRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid runner record: ${source}`);
  }
  const record = value as Partial<RunnerRecord>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.name !== "string" ||
    !record.name ||
    typeof record.repo !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(record.repo) ||
    !Array.isArray(record.labels) ||
    record.labels.some((label) => typeof label !== "string" || !label) ||
    typeof record.installDir !== "string" ||
    !path.isAbsolute(record.installDir) ||
    typeof record.launcherPath !== "string" ||
    !path.isAbsolute(record.launcherPath) ||
    typeof record.scheduledTask !== "string" ||
    !record.scheduledTask ||
    !(record.runnerId === null || (Number.isSafeInteger(record.runnerId) && (record.runnerId as number) > 0)) ||
    typeof record.registered !== "boolean" ||
    typeof record.enabled !== "boolean" ||
    !(record.provisionedAt === null || isoOrNull(record.provisionedAt)) ||
    !(record.registeredAt === null || isoOrNull(record.registeredAt)) ||
    !(record.lastRepairedAt === null || isoOrNull(record.lastRepairedAt))
  ) {
    throw new Error(`invalid runner record: ${source}`);
  }
  return record as RunnerRecord;
}

export async function readRunnerRecord(state: SharedState): Promise<RunnerRecord | null> {
  const filePath = runnerRecordFile(state);
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`runner record must be a physical file: ${filePath}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(filePath, "utf8"));
    } catch {
      throw new Error(`invalid runner record: ${filePath}`);
    }
    return validateRunnerRecord(parsed, filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeRunnerRecord(state: SharedState, record: RunnerRecord): Promise<void> {
  const validated = validateRunnerRecord(record, runnerRecordFile(state));
  await withStateFileLock(state, RUNNER_RECORD_KEY, () =>
    writeTextAtomic(runnerRecordFile(state), `${JSON.stringify(validated, null, 2)}\n`),
  );
}

function defaultRunnerRecord(state: SharedState, platform: NodeJS.Platform): RunnerRecord {
  return {
    schemaVersion: 1,
    name: RUNNER_NAME,
    repo: RUNNER_REPOSITORY,
    labels: [...RUNNER_LABELS],
    installDir: runnerInstallDir(state),
    launcherPath: runnerLauncherPath(state, platform),
    scheduledTask: RUNNER_SCHEDULED_TASK,
    runnerId: null,
    registered: false,
    enabled: false,
    provisionedAt: null,
    registeredAt: null,
    lastRepairedAt: null,
  };
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Build a redactor that scrubs secret values and common token shapes. The
 * secrets array is read at call time, so values pushed after the redactor is
 * created (for example a freshly acquired registration token) are still scrubbed.
 */
function makeRedactor(secrets: Array<string | null | undefined>): (text: string) => string {
  return (text: string): string => {
    let output = text;
    for (const value of secrets) {
      if (value && value.length >= 6) output = output.split(value).join(REDACTED);
    }
    return output
      .replace(/ghp_[A-Za-z0-9_]{12,}/g, REDACTED)
      .replace(/gho_[A-Za-z0-9_]{12,}/g, REDACTED)
      .replace(/ghu_[A-Za-z0-9_]{12,}/g, REDACTED)
      .replace(/ghs_[A-Za-z0-9_]{12,}/g, REDACTED)
      .replace(/ghr_[A-Za-z0-9_]{12,}/g, REDACTED)
      .replace(/github_pat_[A-Za-z0-9_]{12,}/g, REDACTED)
      .replace(/[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, REDACTED);
  };
}

function redactError(error: unknown, redact: (text: string) => string): string {
  return redact(error instanceof Error ? error.message : String(error));
}

/**
 * Shared redaction invariant for runner domain output: recursively scrub exact
 * secrets and conservative token shapes from every string at any depth while
 * preserving keys, container shape, non-string primitives, and nonsecret text.
 * Applied once at the common boundary that feeds raw domain results, JSON
 * serialization, and human projection.
 */
function redactRunnerOutput<T>(value: T, redact: (text: string) => string): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactRunnerOutput(item, redact)) as T;
  if (value && typeof value === "object") {
    const scrubbed: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      scrubbed[key] = redactRunnerOutput(item, redact);
    }
    return scrubbed as T;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Process helper for live boundaries
// ---------------------------------------------------------------------------

interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runProcess(
  argv: string[],
  options: { cwd?: string; env?: Record<string, string | undefined>; input?: string } = {},
): Promise<ProcessResult> {
  const child = Bun.spawn(commandInvocation(argv[0], argv.slice(1), options.env ?? process.env), {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdin: options.input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (options.input !== undefined && child.stdin) {
    child.stdin.write(options.input);
    child.stdin.end();
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

async function runPowerShell(script: string): Promise<ProcessResult> {
  return runProcess([
    windowsPowerShellExecutable(),
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ]);
}

function powerShellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

// ---------------------------------------------------------------------------
// Live boundaries (Windows)
// ---------------------------------------------------------------------------

function requireCanonicalTaskIdentity(identity: ScheduledTaskIdentity): void {
  if (identity.name !== RUNNER_SCHEDULED_TASK || identity.path !== RUNNER_SCHEDULED_TASK_PATH) {
    throw new Error("scheduled task identity is not canonical");
  }
}

function normalizeTriggerKind(kind: string): string {
  return kind === "MSFT_TaskLogonTrigger" ? "AtLogOn" : kind;
}

export function createWindowsScheduler(
  runPowerShellImpl: (script: string) => Promise<ProcessResult>,
): RunnerScheduler {
  return {
    async query(identity) {
      requireCanonicalTaskIdentity(identity);
      // Task Scheduler may serialize the same local account as either
      // `user` or `MACHINE\user`. Resolve every observed account through the
      // Windows SID authority before it leaves this trusted provider boundary;
      // downstream persistence checks remain exact apart from case.
      const script =
        `$ErrorActionPreference = 'Continue'; ` +
        `function Resolve-CanonicalTaskAccount { ` +
        `param([object]$Identity); ` +
        `$raw = [string]$Identity; ` +
        `if ([string]::IsNullOrWhiteSpace($raw)) { ` +
        `throw 'scheduled task account identity translation failed' ` +
        `}; ` +
        `try { ` +
        `$account = [System.Security.Principal.NTAccount]::new($raw); ` +
        `$sid = $account.Translate([System.Security.Principal.SecurityIdentifier]); ` +
        `$canonical = $sid.Translate([System.Security.Principal.NTAccount]) ` +
        `} catch { ` +
        `throw 'scheduled task account identity translation failed' ` +
        `}; ` +
        `if ([string]::IsNullOrWhiteSpace([string]$sid.Value) -or ` +
        `[string]::IsNullOrWhiteSpace([string]$canonical.Value)) { ` +
        `throw 'scheduled task account identity translation failed' ` +
        `}; ` +
        `return ([string]$canonical.Value) ` +
        `}; ` +
        `$queryErr = @(); ` +
        `$tasks = @(Get-ScheduledTask -TaskName ${powerShellQuote(identity.name)} ` +
        `-ErrorAction SilentlyContinue -ErrorVariable queryErr); ` +
        `$queryErr = @($queryErr); ` +
        `if ($queryErr.Count -gt 0) { ` +
        `$isNotFound = ($tasks.Count -eq 0) -and ($queryErr.Count -eq 1) -and (` +
        `($queryErr[0].FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound*') -or ` +
        `($queryErr[0].Exception.Message -match 'No MSFT_ScheduledTask objects found')); ` +
        `if ($isNotFound) { Write-Output '__MISSING__'; exit 0 }; ` +
        `throw $queryErr[0] ` +
        `}; ` +
        `if ($tasks.Count -eq 0) { Write-Output '__MISSING__'; exit 0 }; ` +
        `if ($tasks.Count -ne 1) { Write-Output '__AMBIGUOUS__'; exit 0 }; ` +
        `$task = $tasks[0]; ` +
        `$actions = @($task.Actions); ` +
        `$triggers = @($task.Triggers); ` +
        // MSFT_TaskSettings exposes inverse battery flags. Require typed
        // provider evidence before converting them to the app-owned positives.
        `$disallowStartProperty = $task.Settings.PSObject.Properties['DisallowStartIfOnBatteries']; ` +
        `$stopOnBatteryProperty = $task.Settings.PSObject.Properties['StopIfGoingOnBatteries']; ` +
        `if ($null -eq $disallowStartProperty -or $null -eq $stopOnBatteryProperty -or ` +
        `-not ($disallowStartProperty.Value -is [bool]) -or ` +
        `-not ($stopOnBatteryProperty.Value -is [bool])) { ` +
        `throw 'scheduled task battery settings observation failed' ` +
        `}; ` +
        `$allowStartIfOnBatteries = -not ([bool]$disallowStartProperty.Value); ` +
        `$dontStopIfGoingOnBatteries = -not ([bool]$stopOnBatteryProperty.Value); ` +
        `$actionRows = @($actions | ForEach-Object { ` +
        `[pscustomobject]@{ Execute = [string]$_.Execute; Arguments = [string]$_.Arguments } ` +
        `}); ` +
        `$triggerRows = @($triggers | ForEach-Object { ` +
        `$user = $null; if ($null -ne $_.UserId) { ` +
        `$user = Resolve-CanonicalTaskAccount -Identity $_.UserId ` +
        `}; ` +
        `[pscustomobject]@{ Kind = [string]$_.CimClass.CimClassName; User = $user } ` +
        `}); ` +
        `$principalUser = Resolve-CanonicalTaskAccount -Identity $task.Principal.UserId; ` +
        `[pscustomobject]@{ ` +
        `TaskName = [string]$task.TaskName; TaskPath = [string]$task.TaskPath; ` +
        `State = [string]$task.State; Enabled = [bool]$task.Settings.Enabled; ` +
        `ActionCount = [int]$actions.Count; Actions = $actionRows; ` +
        `TriggerCount = [int]$triggers.Count; Triggers = $triggerRows; ` +
        `Principal = [pscustomobject]@{ ` +
        `UserId = $principalUser; ` +
        `LogonType = [string]$task.Principal.LogonType; ` +
        `RunLevel = [string]$task.Principal.RunLevel ` +
        `}; Settings = [pscustomobject]@{ ` +
        `MultipleInstances = [string]$task.Settings.MultipleInstances; ` +
        `AllowStartIfOnBatteries = $allowStartIfOnBatteries; ` +
        `DontStopIfGoingOnBatteries = $dontStopIfGoingOnBatteries; ` +
        `RestartCount = [int]$task.Settings.RestartCount; ` +
        `RestartInterval = [string]$task.Settings.RestartInterval; ` +
        `ExecutionTimeLimit = [string]$task.Settings.ExecutionTimeLimit ` +
        `} ` +
        `} | ConvertTo-Json -Depth 6 -Compress`;
      let result: ProcessResult;
      try {
        result = await runPowerShellImpl(script);
      } catch {
        throw new Error("scheduled task query failed");
      }
      const stdout = result.stdout.trim();
      if (result.code !== 0) {
        throw new Error("scheduled task query failed");
      }
      if (stdout === "__MISSING__") return null;
      if (stdout === "__AMBIGUOUS__") throw new Error("scheduled task query returned ambiguous identity");
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        throw new Error("scheduled task query returned malformed output");
      }
      const malformed = (): never => {
        throw new Error("scheduled task query returned malformed output");
      };
      const validStates = new Set(["Unknown", "Disabled", "Queued", "Ready", "Running"]);
      if (
        parsed === null ||
        Array.isArray(parsed) ||
        typeof parsed !== "object"
      ) {
        return malformed();
      }
      const task = parsed as Record<string, unknown>;
      const principal = task.Principal;
      const settings = task.Settings;
      if (
        typeof task.TaskName !== "string" ||
        typeof task.TaskPath !== "string" ||
        typeof task.Enabled !== "boolean" ||
        typeof task.State !== "string" ||
        !validStates.has(task.State) ||
        !Number.isSafeInteger(task.ActionCount) ||
        (task.ActionCount as number) < 0 ||
        !Array.isArray(task.Actions) ||
        !Number.isSafeInteger(task.TriggerCount) ||
        (task.TriggerCount as number) < 0 ||
        !Array.isArray(task.Triggers) ||
        !principal ||
        typeof principal !== "object" ||
        Array.isArray(principal) ||
        !settings ||
        typeof settings !== "object" ||
        Array.isArray(settings)
      ) {
        return malformed();
      }
      const actions = task.Actions.map((value) => {
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          typeof (value as Record<string, unknown>).Execute !== "string" ||
          typeof (value as Record<string, unknown>).Arguments !== "string"
        ) {
          return malformed();
        }
        return {
          executable: (value as Record<string, string>).Execute,
          arguments: (value as Record<string, string>).Arguments,
        };
      });
      const triggers = task.Triggers.map((value) => {
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          typeof (value as Record<string, unknown>).Kind !== "string" ||
          !(value as Record<string, string>).Kind ||
          !(typeof (value as Record<string, unknown>).User === "string" || (value as Record<string, unknown>).User === null)
        ) {
          return malformed();
        }
        return {
          kind: normalizeTriggerKind((value as Record<string, string>).Kind),
          user: (value as Record<string, string | null>).User,
        };
      });
      const principalFields = principal as Record<string, unknown>;
      const settingsFields = settings as Record<string, unknown>;
      if (
        actions.length !== task.ActionCount ||
        triggers.length !== task.TriggerCount ||
        typeof principalFields.UserId !== "string" ||
        typeof principalFields.LogonType !== "string" ||
        typeof principalFields.RunLevel !== "string" ||
        typeof settingsFields.MultipleInstances !== "string" ||
        typeof settingsFields.AllowStartIfOnBatteries !== "boolean" ||
        typeof settingsFields.DontStopIfGoingOnBatteries !== "boolean" ||
        !Number.isSafeInteger(settingsFields.RestartCount) ||
        (settingsFields.RestartCount as number) < 0 ||
        typeof settingsFields.RestartInterval !== "string" ||
        typeof settingsFields.ExecutionTimeLimit !== "string"
      ) {
        return malformed();
      }
      if (task.TaskName !== identity.name || task.TaskPath !== identity.path) {
        throw new Error("scheduled task query returned ambiguous identity");
      }
      return {
        name: task.TaskName,
        path: task.TaskPath,
        enabled: task.Enabled,
        state: task.State,
        actionCount: task.ActionCount as number,
        actionExecutable: actions.length === 1 ? actions[0]!.executable : null,
        actionArguments: actions.length === 1 ? actions[0]!.arguments : null,
        triggerCount: task.TriggerCount as number,
        triggerKind: triggers.length === 1 ? triggers[0]!.kind : null,
        triggerUser: triggers.length === 1 ? triggers[0]!.user : null,
        principalUser: principalFields.UserId as string,
        principalLogonType: principalFields.LogonType as string,
        principalRunLevel: principalFields.RunLevel as string,
        multipleInstances: settingsFields.MultipleInstances as string,
        allowStartIfOnBatteries: settingsFields.AllowStartIfOnBatteries as boolean,
        dontStopIfGoingOnBatteries: settingsFields.DontStopIfGoingOnBatteries as boolean,
        restartCount: settingsFields.RestartCount as number,
        restartInterval: settingsFields.RestartInterval as string,
        executionTimeLimit: settingsFields.ExecutionTimeLimit as string,
      };
    },
    async create(spec) {
      requireCanonicalTaskIdentity(spec);
      const script =
        `$ErrorActionPreference = 'Stop'; ` +
        `$action = New-ScheduledTaskAction -Execute ${powerShellQuote(spec.executable)} -Argument ${powerShellQuote(spec.arguments)}; ` +
        `$trigger = New-ScheduledTaskTrigger -AtLogOn -User ${powerShellQuote(spec.principalUser)}; ` +
        `$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries ` +
        `-DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) ` +
        `-ExecutionTimeLimit ([TimeSpan]::Zero); ` +
        `$principal = New-ScheduledTaskPrincipal -UserId ${powerShellQuote(spec.principalUser)} ` +
        `-LogonType Interactive -RunLevel Limited; ` +
        `Register-ScheduledTask -TaskName ${powerShellQuote(spec.name)} -Action $action -Trigger $trigger ` +
        `-Settings $settings -Principal $principal -TaskPath ${powerShellQuote(spec.path)} -Force | Out-Null`;
      const result = await runPowerShellImpl(script);
      if (result.code !== 0) throw new Error(`scheduled task registration failed: ${result.stderr.trim()}`);
    },
    async setEnabled(identity, enabled) {
      requireCanonicalTaskIdentity(identity);
      const verb = enabled ? "Enable-ScheduledTask" : "Disable-ScheduledTask";
      const result = await runPowerShellImpl(
        `$ErrorActionPreference = 'Stop'; ${verb} -TaskName ${powerShellQuote(identity.name)} ` +
        `-TaskPath ${powerShellQuote(identity.path)} | Out-Null`,
      );
      if (result.code !== 0) throw new Error(`scheduled task ${enabled ? "enable" : "disable"} failed: ${result.stderr.trim()}`);
    },
    async start(identity) {
      requireCanonicalTaskIdentity(identity);
      const result = await runPowerShellImpl(
        `$ErrorActionPreference = 'Stop'; Start-ScheduledTask -TaskName ${powerShellQuote(identity.name)} ` +
        `-TaskPath ${powerShellQuote(identity.path)}`,
      );
      if (result.code !== 0) throw new Error(`scheduled task start failed: ${result.stderr.trim()}`);
    },
  };
}

function windowsScheduler(): RunnerScheduler {
  return createWindowsScheduler(runPowerShell);
}

// ---------------------------------------------------------------------------
// GitHub control-plane boundary (single production normalization point)
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Strict registration-token payload normalization. No coercion and no
 * defaults: any missing, null, empty, wrong-type, invalid-date, expired, or
 * partial payload is rejected with a stable sanitized error.
 */
function normalizeRegistrationTokenPayload(value: unknown, now: Date): { token: string; expiresAt: string } {
  const invalid = (): Error => new Error("github registration token response was invalid");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const payload = value as Record<string, unknown>;
  if (!isNonEmptyString(payload.token)) throw invalid();
  if (typeof payload.expires_at !== "string") throw invalid();
  const expiresAt = Date.parse(payload.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) throw invalid();
  return { token: payload.token, expiresAt: payload.expires_at };
}

/** One runner entry: exact shape and domain values, or the whole list is rejected. */
function normalizeRunnerEntry(value: unknown): RunnerRegistration {
  const invalid = (): Error => new Error("github runner list response was invalid");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const runner = value as Record<string, unknown>;
  if (!Number.isSafeInteger(runner.id) || (runner.id as number) <= 0) throw invalid();
  if (!isNonEmptyString(runner.name)) throw invalid();
  if (!isNonEmptyString(runner.os)) throw invalid();
  if (runner.status !== "online" && runner.status !== "offline") throw invalid();
  if (typeof runner.busy !== "boolean") throw invalid();
  if (!Array.isArray(runner.labels) || runner.labels.length === 0) throw invalid();
  const labels = runner.labels.map((label) => {
    if (!label || typeof label !== "object" || Array.isArray(label)) throw invalid();
    const name = (label as Record<string, unknown>).name;
    if (!isNonEmptyString(name)) throw invalid();
    return name;
  });
  const versionCandidates = [runner.runner_version, runner.version].filter(
    (candidate) => candidate !== undefined && candidate !== null,
  );
  if (versionCandidates.some((candidate) => !isNonEmptyString(candidate))) throw invalid();
  if (new Set(versionCandidates).size > 1) throw invalid();
  const providerVersion = versionCandidates[0] as string | undefined;
  const heartbeatCandidates = [runner.last_heartbeat_at, runner.lastHeartbeat].filter(
    (candidate) => candidate !== undefined && candidate !== null,
  );
  if (new Set(heartbeatCandidates).size > 1) throw invalid();
  const providerHeartbeat = heartbeatCandidates[0];
  if (!(providerHeartbeat === undefined || providerHeartbeat === null || typeof providerHeartbeat === "string")) {
    throw invalid();
  }
  if (
    typeof providerHeartbeat === "string" &&
    (!Number.isFinite(Date.parse(providerHeartbeat)) || new Date(providerHeartbeat).toISOString() !== providerHeartbeat)
  ) {
    throw invalid();
  }
  return {
    id: runner.id as number,
    name: runner.name,
    os: runner.os,
    status: runner.status,
    busy: runner.busy,
    labels,
    ...(providerVersion === undefined ? {} : { version: providerVersion }),
    ...(providerHeartbeat === undefined ? {} : { lastHeartbeat: providerHeartbeat }),
  };
}

/**
 * Strict runner-list payload normalization: a non-null, non-array top-level
 * object with a required `runners` array. The entire response is rejected on
 * any invalid entry; nothing is coerced, defaulted, filtered, or dropped.
 */
function normalizeRunnerListPayload(value: unknown): RunnerRegistration[] {
  const invalid = (): Error => new Error("github runner list response was invalid");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const runners = (value as Record<string, unknown>).runners;
  if (!Array.isArray(runners)) throw invalid();
  return runners.map((runner) => normalizeRunnerEntry(runner));
}

function normalizeRunnerPagesPayload(value: unknown): RunnerRegistration[] {
  const pages = Array.isArray(value) ? value : [value];
  if (pages.length === 0) throw new Error("github runner list response was invalid");
  const all = pages.flatMap((page) => normalizeRunnerListPayload(page));
  const ids = new Set<number>();
  for (const runner of all) {
    if (ids.has(runner.id)) throw new Error("github runner list response was invalid");
    ids.add(runner.id);
  }
  const totals = pages.map((page) =>
    page && typeof page === "object" && !Array.isArray(page)
      ? (page as Record<string, unknown>).total_count
      : undefined,
  );
  for (const total of totals) {
    if (total !== undefined && (!Number.isSafeInteger(total) || (total as number) < 0 || total !== all.length)) {
      throw new Error("github runner list response was invalid");
    }
  }
  return all;
}

/**
 * Production GitHub control-plane boundary with an injected command runner
 * and clock, so tests exercise the exact production normalization without
 * ever calling personal GitHub. Credential read failures, empty credentials,
 * transport failures, nonzero `gh` exits, malformed output, and invalid
 * payloads all fail with stable domain errors that never carry raw stdout,
 * stderr, response JSON, command arguments, the canonical credential, or
 * registration token values.
 */
export function createGitHubControlPlane(deps: {
  runCommand: (argv: string[], env: Record<string, string | undefined>) => Promise<ProcessResult>;
  readCredential: () => Promise<string>;
  now: () => Date;
}): RunnerGitHub {
  let cachedToken: string | null = null;

  async function credential(): Promise<string> {
    if (cachedToken !== null) return cachedToken;
    let read: string;
    try {
      read = await deps.readCredential();
    } catch {
      throw new Error("github credential read failed");
    }
    const token = read.trim();
    if (!token) throw new Error("github credential is empty");
    cachedToken = token;
    return token;
  }

  async function gh(args: string[], operation: string): Promise<string> {
    const token = await credential();
    let result: ProcessResult;
    try {
      result = await deps.runCommand(["gh", "api", ...args], { ...canonicalChildEnvironment(), GH_TOKEN: token });
    } catch {
      throw new Error(`github ${operation} request failed`);
    }
    if (result.code !== 0) throw new Error(`github ${operation} request failed`);
    return result.stdout;
  }

  async function ghJson(args: string[], operation: string): Promise<unknown> {
    const output = await gh(args, operation);
    try {
      return JSON.parse(output);
    } catch {
      throw new Error(`github ${operation} response was malformed`);
    }
  }

  return {
    async createRegistrationToken(repo) {
      const payload = await ghJson(["--method", "POST", `repos/${repo}/actions/runners/registration-token`], "registration token");
      return normalizeRegistrationTokenPayload(payload, deps.now());
    },
    async listRunners(repo) {
      const payload = await ghJson(
        ["--method", "GET", `repos/${repo}/actions/runners`, "--paginate", "--slurp", "-f", "per_page=100"],
        "runner list",
      );
      return normalizeRunnerPagesPayload(payload);
    },
    async removeRunner(repo, id) {
      await gh(["--method", "DELETE", `repos/${repo}/actions/runners/${id}`], "runner removal");
    },
  };
}

/** Live GitHub control plane: canonical child environment, canonical credential read, injected clock. */
function githubControlPlane(
  state: SharedState,
  readCredential: (state: SharedState, name: string) => Promise<string>,
  now: () => Date,
): RunnerGitHub {
  return createGitHubControlPlane({
    runCommand: (argv, env) => runProcess(argv, { env }),
    readCredential: () => readCredential(state, RUNNER_GITHUB_CREDENTIAL),
    now,
  });
}

const REQUIRED_RUNNER_FILES = ["bin/Runner.Listener.exe", "bin/Runner.Worker.exe", "config.cmd", "run.cmd"] as const;

export function createWindowsRunnerHost(options: WindowsRunnerHostOptions = {}): RunnerHost {
  const software = options.software ?? RUNNER_SOFTWARE;
  const fetchAsset = options.fetchAsset ?? ((url: string) => fetch(url));
  const runPowerShellImpl = options.runPowerShell ?? runPowerShell;
  const runProcessImpl = options.runProcess ?? runProcess;
  const lstatImpl = options.lstat ?? ((filePath: string) => lstat(filePath));
  const configurationLstat = options.configurationLstat ?? ((filePath: string) => lstat(filePath));
  const readFileImpl = options.readFile ?? ((filePath: string, encoding: "utf8") => readFile(filePath, encoding));
  const spawnRunner = options.spawnRunner ?? ((argv, spawnOptions) => {
    const child = Bun.spawn(argv, {
      cwd: spawnOptions.cwd,
      env: spawnOptions.env,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
    return {
      pid: child.pid,
      exited: child.exited,
      kill: () => { child.kill(); },
    };
  });
  const ownershipObservationTimeoutMs =
    options.ownershipObservationTimeoutMs ?? RUNNER_START_OBSERVATION_TIMEOUT_MS;
  const ownershipObservationIntervalMs =
    options.ownershipObservationIntervalMs ?? RUNNER_START_OBSERVATION_INTERVAL_MS;
  const terminationGraceMs = options.terminationGraceMs ?? RUNNER_TERMINATION_GRACE_MS;

  const isMissing = (error: unknown): boolean =>
    Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT");

  async function physicalRunnerFileExists(filePath: string): Promise<boolean> {
    try {
      const info = await lstatImpl(filePath);
      return info.isFile() && !info.isSymbolicLink();
    } catch (error) {
      if (isMissing(error)) return false;
      throw new Error("runner software inspection failed");
    }
  }

  async function configurationFileExists(filePath: string): Promise<boolean> {
    try {
      const info = await configurationLstat(filePath);
      return info.isFile() && !info.isSymbolicLink();
    } catch (error) {
      if (isMissing(error)) return false;
      throw new Error("runner configuration inspection failed");
    }
  }

  async function configurationArtifactState(filePath: string): Promise<"absent" | "physical"> {
    let info: { isFile(): boolean; isSymbolicLink(): boolean };
    try {
      info = await configurationLstat(filePath);
    } catch (error) {
      if (isMissing(error)) return "absent";
      throw new Error("runner configuration inspection failed");
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error("runner local configuration artifacts are partial or ambiguous");
    }
    return "physical";
  }

  async function readVersionMarker(dir: string): Promise<string | null> {
    try {
      return (await readFileImpl(path.join(dir, ".agents-runner-version"), "utf8")).trim() || null;
    } catch (error) {
      if (isMissing(error)) return null;
      throw new Error("runner version inspection failed");
    }
  }

  const host: RunnerHost = {
    async isProvisioned(dir) {
      for (const relativePath of REQUIRED_RUNNER_FILES) {
        if (!(await physicalRunnerFileExists(path.join(dir, ...relativePath.split("/"))))) return false;
      }
      return (await readVersionMarker(dir)) === software.version;
    },
    async provision(dir) {
      const stagingDir = path.join(path.dirname(dir), `.${path.basename(dir)}.provisioning`);
      const archive = path.join(stagingDir, software.asset);
      await rm(stagingDir, { recursive: true, force: true });
      await rm(path.join(dir, software.asset), { recursive: true, force: true });
      await mkdir(stagingDir, { recursive: true });
      let published = false;
      try {
        let response: RunnerAssetResponse;
        let buffer: Buffer;
        try {
          response = await fetchAsset(software.url);
        } catch {
          throw new Error("runner download failed");
        }
        if (!response.ok) throw new Error(`runner download failed with HTTP ${response.status}`);
        try {
          buffer = Buffer.from(await response.arrayBuffer());
        } catch {
          throw new Error("runner download failed");
        }
        if (buffer.byteLength !== software.sizeBytes) {
          throw new Error(`runner archive size mismatch: expected ${software.sizeBytes}, got ${buffer.byteLength}`);
        }
        const digest = createHash("sha256").update(buffer).digest("hex");
        if (digest !== software.sha256) {
          throw new Error(
            `runner archive sha256 mismatch: expected ${software.sha256}, got ${digest}; update RUNNER_SOFTWARE pin`,
          );
        }
        await Bun.write(archive, buffer);
        const result = await runPowerShellImpl(
          `Expand-Archive -LiteralPath ${powerShellQuote(archive)} -DestinationPath ${powerShellQuote(stagingDir)} -Force`,
        );
        if (result.code !== 0) throw new Error("runner extraction failed");
        await rm(archive, { force: true });
        for (const relativePath of REQUIRED_RUNNER_FILES) {
          if (!(await physicalRunnerFileExists(path.join(stagingDir, ...relativePath.split("/"))))) {
            throw new Error("runner extraction missing required file");
          }
        }
        await Bun.write(path.join(stagingDir, ".agents-runner-version"), `${software.version}\n`);
        try {
          await rm(dir, { recursive: true, force: true });
          await rename(stagingDir, dir);
          published = true;
        } catch {
          throw new Error("runner publication failed");
        }
      } finally {
        if (!published) await rm(stagingDir, { recursive: true, force: true });
      }
    },
    async isConfigured(dir) {
      return (
        (await configurationFileExists(path.join(dir, ".runner"))) &&
        (await configurationFileExists(path.join(dir, ".credentials")))
      );
    },
    async resetLocalConfiguration(dir) {
      const [runnerArtifact, credentialsArtifact] = await Promise.all([
        configurationArtifactState(path.join(dir, ".runner")),
        configurationArtifactState(path.join(dir, ".credentials")),
      ]);
      if (runnerArtifact === "absent" && credentialsArtifact === "absent") return;
      if (runnerArtifact !== "physical" || credentialsArtifact !== "physical") {
        throw new Error("runner local configuration artifacts are partial or ambiguous");
      }
      const result = await runProcessImpl([path.join(dir, "bin", "Runner.Listener.exe"), "remove", "--local"], {
        cwd: dir,
        env: canonicalChildEnvironment(),
      });
      if (result.code !== 0) throw new Error(`runner local configuration reset failed: ${result.stderr.trim()}`);
    },
    async configure(dir, options) {
      const args = [
        "--unattended",
        "--replace",
        "--disableupdate",
        "--url",
        options.url,
        "--token",
        options.token,
        "--name",
        options.name,
        "--labels",
        options.labels.join(","),
      ];
      const result = await runProcessImpl([path.join(dir, "bin", "Runner.Listener.exe"), "configure", ...args], {
        cwd: dir,
        env: canonicalChildEnvironment(),
      });
      if (result.code !== 0) throw new Error(`runner configuration failed: ${result.stderr.trim()}`);
    },
    async runnerVersion(dir) {
      return readVersionMarker(dir);
    },
    async runningInstances(dir) {
      const listenerPath = path.win32.join(dir, "bin", "Runner.Listener.exe");
      const script =
        `$ErrorActionPreference = 'Stop'; ` +
        `@(Get-CimInstance Win32_Process | Where-Object { ` +
        `$_.Name -eq 'Runner.Listener.exe' ` +
        `} | ForEach-Object { [pscustomobject]@{ ` +
        `ProcessId = [int]$_.ProcessId; ` +
        `ExecutablePath = $(if ($null -eq $_.ExecutablePath) { $null } else { [string]$_.ExecutablePath }); ` +
        `CreationTime = $(if ($null -eq $_.CreationDate) { $null } else { ` +
        `$_.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') }); ` +
        `CommandLine = $(if ($null -eq $_.CommandLine) { $null } else { [string]$_.CommandLine }) ` +
        `} }) | ConvertTo-Json -Compress`;
      let result: ProcessResult;
      try {
        result = await runPowerShellImpl(script);
      } catch {
        throw new Error("runner process query failed");
      }
      if (result.code !== 0) throw new Error("runner process query failed");
      if (!result.stdout.trim()) return [];
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        throw new Error("runner process query returned malformed output");
      }
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      const seen = new Set<number>();
      const instances: RunnerProcess[] = [];
      for (const value of rows) {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new Error("runner process query returned malformed output");
        }
        const row = value as Record<string, unknown>;
        if (!Number.isSafeInteger(row.ProcessId) || (row.ProcessId as number) <= 0) {
          throw new Error("runner process query returned malformed output");
        }
        if (!(typeof row.ExecutablePath === "string" || row.ExecutablePath === null)) {
          throw new Error("runner process query returned malformed output");
        }
        if (
          row.ExecutablePath === null ||
          typeof row.CreationTime !== "string" ||
          !Number.isFinite(Date.parse(row.CreationTime)) ||
          new Date(row.CreationTime).toISOString() !== row.CreationTime
        ) {
          throw new Error("runner process query returned malformed output");
        }
        if (!("CommandLine" in row) || !(typeof row.CommandLine === "string" || row.CommandLine === null)) {
          throw new Error("runner process query returned malformed output");
        }
        const pid = row.ProcessId as number;
        if (seen.has(pid)) throw new Error("runner process query returned malformed output");
        seen.add(pid);
        if (row.ExecutablePath.toLowerCase() !== listenerPath.toLowerCase()) continue;
        instances.push(row.CommandLine === null
          ? { pid, executablePath: row.ExecutablePath, startedAt: row.CreationTime }
          : { pid, executablePath: row.ExecutablePath, startedAt: row.CreationTime, commandLine: row.CommandLine });
      }
      return instances;
    },
    async stopInstances(instances) {
      for (const instance of instances) {
        if (
          !Number.isSafeInteger(instance.pid) ||
          instance.pid <= 0 ||
          !path.win32.isAbsolute(instance.executablePath) ||
          !Number.isFinite(Date.parse(instance.startedAt)) ||
          new Date(instance.startedAt).toISOString() !== instance.startedAt
        ) {
          throw new Error("runner process identity is invalid");
        }
        const script =
          `function Get-RunnerProcess { ` +
          `$queryErr = @(); ` +
          `$found = @(Get-CimInstance Win32_Process -Filter ${powerShellQuote(`ProcessId = ${instance.pid}`)} ` +
          `-ErrorAction SilentlyContinue -ErrorVariable queryErr); ` +
          `$queryErr = @($queryErr); ` +
          `if ($queryErr.Count -gt 0) { throw $queryErr[0] }; ` +
          `if ($found.Count -eq 0) { return }; ` +
          `if ($found.Count -ne 1) { throw 'ambiguous runner process identity' }; ` +
          `$candidate = $found[0]; ` +
          `if ($null -eq $candidate.ExecutablePath -or $null -eq $candidate.CreationDate) { ` +
          `throw 'runner process identity is inaccessible' }; ` +
          `$created = $candidate.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ'); ` +
          `if ($candidate.ExecutablePath -ine ${powerShellQuote(instance.executablePath)} -or ` +
          `$created -ne ${powerShellQuote(instance.startedAt)}) { return }; ` +
          `return $candidate ` +
          `}; ` +
          `$before = @(Get-RunnerProcess); ` +
          `if ($before.Count -eq 0) { exit 0 }; ` +
          `$stopErr = @(); ` +
          `$termination = Invoke-CimMethod -InputObject $before[0] -MethodName Terminate ` +
          `-ErrorAction SilentlyContinue -ErrorVariable stopErr; ` +
          `if (@($stopErr).Count -gt 0) { throw $stopErr[0] }; ` +
          `if ($null -eq $termination -or [int]$termination.ReturnValue -ne 0) { throw 'runner process termination failed' }; ` +
          `for ($attempt = 0; $attempt -lt 20; $attempt += 1) { ` +
          `$after = @(Get-RunnerProcess); ` +
          `if ($after.Count -eq 0) { exit 0 }; ` +
          `Start-Sleep -Milliseconds 100 ` +
          `}; ` +
          `throw 'runner process remains after stop'`;
        let result: ProcessResult;
        try {
          result = await runPowerShellImpl(script);
        } catch {
          throw new Error(`failed to stop runner process ${instance.pid}`);
        }
        if (result.code !== 0) throw new Error(`failed to stop runner process ${instance.pid}`);
      }
    },
    async run(dir, env) {
      const listenerPath = path.win32.join(dir, "bin", "Runner.Listener.exe");
      const child = spawnRunner([listenerPath, "run"], { cwd: dir, env });
      if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
        throw new Error("runner host spawn returned an invalid process identity");
      }
      const exitState: { settled: boolean; code?: number; error?: unknown } = { settled: false };
      void child.exited.then(
        (code) => { exitState.settled = true; exitState.code = code; },
        (error) => { exitState.settled = true; exitState.error = error; },
      );

      async function cleanFailedSpawn(): Promise<void> {
        try { child.kill(); } catch { /* observation below still has to prove absence */ }
        const deadline = Date.now() + terminationGraceMs;
        do {
          if (exitState.settled) return;
          try {
            const observed = await host.runningInstances(dir);
            const exact = observed.find((instance) => instance.pid === child.pid) ?? null;
            if (exact !== null) {
              await host.stopInstances([exact]);
              const after = await host.runningInstances(dir);
              if (after.every(
                (instance) =>
                  instance.pid !== exact.pid ||
                  instance.executablePath.toLowerCase() !== exact.executablePath.toLowerCase() ||
                  instance.startedAt !== exact.startedAt,
              )) return;
            }
          } catch {
            // Direct child exit remains an independent proof. Keep polling it
            // until the bounded grace expires when CIM is unavailable.
          }
          await Bun.sleep(ownershipObservationIntervalMs);
        } while (Date.now() < deadline);
        throw new Error("runner host ownership establishment failed and child cleanup did not complete");
      }

      let owned: RunnerProcess | null = null;
      try {
        const deadline = Date.now() + ownershipObservationTimeoutMs;
        do {
          const observed = await host.runningInstances(dir);
          owned = observed.find((instance) => instance.pid === child.pid) ?? null;
          if (owned) break;
          if (exitState.settled) {
            if (exitState.error !== undefined) throw exitState.error;
            throw new Error(`runner host exited with code ${exitState.code ?? -1} before ownership was established`);
          }
          await Bun.sleep(ownershipObservationIntervalMs);
        } while (Date.now() < deadline);
        if (!owned) throw new Error("runner host process ownership could not be established");
        if (owned.executablePath.toLowerCase() !== listenerPath.toLowerCase()) {
          throw new Error("runner host process ownership did not match the canonical listener");
        }
      } catch (error) {
        await cleanFailedSpawn();
        throw error;
      }

      const process = owned;
      let termination: Promise<void> | null = null;
      return {
        process,
        exited: child.exited,
        terminate() {
          termination ??= (async () => {
            await host.stopInstances([process]);
            let settled = false;
            await Promise.race([
              child.exited.then(
                () => { settled = true; },
                () => { settled = true; },
              ),
              Bun.sleep(terminationGraceMs),
            ]);
            if (!settled) {
              const after = await host.runningInstances(dir);
              const ownedRemains = after.some(
                (instance) =>
                  instance.pid === process.pid &&
                  instance.executablePath.toLowerCase() === process.executablePath.toLowerCase() &&
                  instance.startedAt === process.startedAt,
              );
              if (ownedRemains) throw new Error("runner host termination grace period expired");
            }
          })();
          return termination;
        },
      };
    },
  };
  return host;
}

function windowsRunnerHost(): RunnerHost {
  return createWindowsRunnerHost();
}

// ---------------------------------------------------------------------------
// Fail-fast observation for mutation/idempotency paths. A GitHub listing
// failure propagates and lifecycle mutations fail closed instead of acting on
// uncertain evidence. Status has its own independently settled canonical-target
// snapshot below; do not generalize this record-directed action boundary.
// ---------------------------------------------------------------------------

export interface RunnerObservation {
  record: RunnerRecord | null;
  provisioned: boolean;
  configured: boolean;
  config: RunnerConfiguration | null;
  registrations: RunnerRegistration[];
  processes: RunnerProcess[];
  task: ScheduledTaskInfo | null;
  doctor: StateDoctorReport;
}

async function observeRunner(state: SharedState, deps: ResolvedDeps, github: RunnerGitHub): Promise<RunnerObservation> {
  const record = await readRunnerRecord(state);
  const installDir = runnerInstallDir(state);
  const [provisioned, configured, config, task, processes, doctor, registrations] = await Promise.all([
    deps.host.isProvisioned(installDir),
    deps.host.isConfigured(installDir),
    readRunnerConfiguration(installDir),
    deps.scheduler.query({ name: RUNNER_SCHEDULED_TASK, path: RUNNER_SCHEDULED_TASK_PATH }),
    deps.host.runningInstances(installDir),
    deps.doctor(state),
    github.listRunners(RUNNER_REPOSITORY),
  ]);
  return { record, provisioned, configured, config, registrations, processes, task, doctor };
}

async function readRunnerConfiguration(installDir: string): Promise<RunnerConfiguration | null> {
  let contents: string;
  const configPath = path.join(installDir, ".runner");
  try {
    const info = await lstat(configPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("runner configuration must be a physical file");
    contents = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("runner configuration read failed");
  }
  let parsed: unknown;
  try {
    // The official Windows runner writes `.runner` as UTF-8 with one leading
    // BOM. Admit only that encoding marker; a second or non-leading BOM still
    // reaches JSON.parse and fails closed as malformed configuration.
    parsed = JSON.parse(contents.startsWith("\uFEFF") ? contents.slice(1) : contents);
  } catch {
    throw new Error("runner configuration is malformed");
  }
  if (
    parsed === null ||
    Array.isArray(parsed) ||
    typeof parsed !== "object" ||
    !Number.isSafeInteger((parsed as Record<string, unknown>).agentId) ||
    ((parsed as Record<string, number>).agentId <= 0) ||
    typeof (parsed as Record<string, unknown>).agentName !== "string" ||
    !(parsed as Record<string, string>).agentName.trim() ||
    typeof (parsed as Record<string, unknown>).gitHubUrl !== "string" ||
    !(parsed as Record<string, string>).gitHubUrl.trim() ||
    !(
      (parsed as Record<string, unknown>).disableUpdate === undefined ||
      typeof (parsed as Record<string, unknown>).disableUpdate === "boolean"
    )
  ) {
    throw new Error("runner configuration is malformed");
  }
  return {
    agentId: (parsed as Record<string, number>).agentId,
    agentName: (parsed as Record<string, string>).agentName,
    gitHubUrl: (parsed as Record<string, string>).gitHubUrl,
    // Older runner configurations omit the false default. Treat absence as
    // known drift so install/repair can converge it to the pinned policy.
    disableUpdate: (parsed as Record<string, unknown>).disableUpdate === true,
  };
}

function launcherCheck(report: StateDoctorReport) {
  return report.checks.find((check) => check.id === "launcher") ?? null;
}

function matchingRegistrations(observation: RunnerObservation): RunnerRegistration[] {
  return observation.registrations.filter((registration) => registration.name === RUNNER_NAME);
}

function registrationHasCanonicalIdentity(registration: RunnerRegistration): boolean {
  return (
    registration.name === RUNNER_NAME &&
    registration.os.toLowerCase() === "windows" &&
    exactStringSet(registration.labels, RUNNER_LABELS)
  );
}

/** Build the exact canonical task definition from constants and one supplied principal. */
export function buildRunnerTaskSpec(state: SharedState, principalUser: string): ScheduledTaskSpec {
  return {
    name: RUNNER_SCHEDULED_TASK,
    path: RUNNER_SCHEDULED_TASK_PATH,
    executable: windowsPowerShellExecutable(),
    arguments:
      `-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden ` +
      `-File "${runnerLauncherPath(state, "win32")}" runner run`,
    principalUser,
  };
}

/** Determine the current Windows principal from evaluated runtime values. */
export function currentWindowsPrincipal(): string {
  const domain = process.env.USERDOMAIN || process.env.COMPUTERNAME || "";
  const username = process.env.USERNAME || process.env.USER || "";
  if (!domain || !username) {
    throw new Error("unable to determine current Windows principal from runtime environment");
  }
  return `${domain}\\${username}`;
}

function resolveWindowsPrincipal(resolve: () => string): string {
  try {
    const principal = resolve();
    if (principal.trim() !== principal || !/^[^\\]+\\[^\\]+$/.test(principal)) {
      throw new Error("invalid principal");
    }
    return principal;
  } catch {
    throw new Error("unable to determine current Windows principal from runtime environment");
  }
}

function requireCanonicalRunnerPersistence(state: SharedState, record: RunnerRecord): void {
  if (!runnerRecordIsCanonical(state, "win32", record)) {
    throw new Error("runner record is not canonical; refusing to use record-owned paths or identity");
  }
}

function taskIdentityMatches(task: ScheduledTaskInfo, spec: ScheduledTaskIdentity): boolean {
  return task.name === spec.name && task.path === spec.path;
}

function windowsPrincipalMatches(left: string | null, right: string): boolean {
  return left !== null && left.toLowerCase() === right.toLowerCase();
}

/** Exact action binding: one action at the canonical identity with exact executable and arguments. */
export function taskMatchesSpec(task: ScheduledTaskInfo | null, spec: ScheduledTaskSpec): boolean {
  return Boolean(
    task &&
      taskIdentityMatches(task, spec) &&
      task.actionCount === 1 &&
      task.actionExecutable === spec.executable &&
      task.actionArguments === spec.arguments,
  );
}

/** Exact reboot/logon persistence definition, independent of enabled state. */
export function taskHasCanonicalPersistence(task: ScheduledTaskInfo | null, spec: ScheduledTaskSpec): boolean {
  return Boolean(
    task &&
      taskIdentityMatches(task, spec) &&
      task.triggerCount === 1 &&
      task.triggerKind === "AtLogOn" &&
      windowsPrincipalMatches(task.triggerUser, spec.principalUser) &&
      windowsPrincipalMatches(task.principalUser, spec.principalUser) &&
      task.principalLogonType === "Interactive" &&
      task.principalRunLevel === "Limited" &&
      taskHasCanonicalSchedulerSettings(task),
  );
}

/** Settings are part of persistence: they prevent duplicate task instances and keep the runner durable. */
export function taskHasCanonicalSchedulerSettings(task: ScheduledTaskInfo | null): boolean {
  return Boolean(
    task &&
      task.multipleInstances === "IgnoreNew" &&
      task.allowStartIfOnBatteries &&
      task.dontStopIfGoingOnBatteries &&
      task.restartCount === 3 &&
      task.restartInterval === "PT1M" &&
      task.executionTimeLimit === "PT0S",
  );
}

// ---------------------------------------------------------------------------
// Result and status report shapes
// ---------------------------------------------------------------------------

export interface RunnerActionResult {
  ok: boolean;
  action: "install" | "enable" | "disable" | "repair" | "run";
  changed: boolean;
  issues: string[];
  details: Record<string, unknown>;
}

export type RunnerTruth = boolean | null;

export interface RunnerReadiness {
  installed: RunnerTruth;
  registered: RunnerTruth;
  enabled: RunnerTruth;
  persistent: RunnerTruth;
  process: RunnerTruth;
  online: RunnerTruth;
  launcherBinding: RunnerTruth;
}

export interface RunnerStatusReport {
  ok: boolean;
  name: string;
  repo: string;
  labels: string[];
  platform: NodeJS.Platform;
  supported: boolean;
  readiness: RunnerReadiness;
  installed: boolean;
  registered: boolean;
  enabled: boolean;
  record: { present: RunnerTruth; canonical: RunnerTruth };
  installation: {
    provisioned: RunnerTruth;
    configured: RunnerTruth;
    repositoryBinding: RunnerTruth;
    updateDisabled: RunnerTruth;
    version: string | null;
  };
  persistence: {
    mechanism: "scheduled-task";
    name: string;
    path: string;
    present: RunnerTruth;
    state: string | null;
    enabled: RunnerTruth;
    actionCount: number | null;
    triggerCount: number | null;
    triggerKind: string | null;
    triggerUser: string | null;
    principalUser: string | null;
    principalLogonType: string | null;
    principalRunLevel: string | null;
    multipleInstances: string | null;
    allowStartIfOnBatteries: RunnerTruth;
    dontStopIfGoingOnBatteries: RunnerTruth;
    restartCount: number | null;
    restartInterval: string | null;
    executionTimeLimit: string | null;
    boundToLauncher: RunnerTruth;
  };
  process: { running: RunnerTruth; instances: number | null; pids: number[] | null };
  registration: {
    id: number | null;
    os: string | null;
    labels: string[] | null;
    status: "online" | "offline" | "busy" | "unknown";
    busy: boolean | null;
    version: string | null;
    lastHeartbeat: string | null;
    duplicates: number | null;
  };
  binding: { launcher: string; ok: RunnerTruth; issues: string[] };
  doctor: { ok: RunnerTruth };
  issues: string[];
}

// ---------------------------------------------------------------------------
// Gates and reconciliation
// ---------------------------------------------------------------------------

const RUNNER_LIFECYCLE_LOCK_KEY = "runner-lifecycle";

async function executeRunnerMutation(
  state: SharedState,
  action: RunnerActionResult["action"],
  redact: (text: string) => string,
  callback: (markMutationBoundary: () => void) => Promise<RunnerActionResult>,
): Promise<RunnerActionResult> {
  let mutationMayHaveOccurred = false;
  try {
    const result = await withStateFileLock(
      state,
      RUNNER_LIFECYCLE_LOCK_KEY,
      () => callback(() => {
        mutationMayHaveOccurred = true;
      }),
      { owner: `runner:${action}` },
    );
    return redactRunnerOutput(result, redact);
  } catch (error) {
    return redactRunnerOutput(
      {
        ok: false,
        action,
        changed: mutationMayHaveOccurred,
        issues: [redactError(error, redact)],
        details: mutationMayHaveOccurred ? { partialMutation: true } : {},
      },
      redact,
    );
  }
}

function requireWindows(deps: ResolvedDeps): void {
  if (deps.platform !== "win32") {
    throw new Error(
      `runner lifecycle mutations require Windows (win32); current platform is ${deps.platform}. ` +
        `Use status --json for read-only inspection on this platform.`,
    );
  }
}

function requireHealthyDoctor(doctor: StateDoctorReport, redact: (text: string) => string): void {
  let normalized: NormalizedStatusDoctor;
  try {
    normalized = normalizeStatusDoctor(doctor);
  } catch {
    throw new Error("canonical state doctor output is malformed or inconsistent; refusing to proceed");
  }
  if (!normalized.ok) {
    const failed = normalized.checks
      .filter((check) => !check.ok)
      .map((check) => `${check.id}: ${check.message}`)
      .join("; ");
    throw new Error(`canonical state doctor is unhealthy; refusing to proceed: ${redact(failed)}`);
  }
  if (normalized.launcher?.ok !== true) {
    throw new Error("canonical state doctor did not prove the launcher healthy; refusing to proceed");
  }
}

function requireRunnerBinding(
  configured: boolean,
  config: RunnerConfiguration | null,
  repo: string,
): void {
  const expected = runnerRepositoryUrl(repo);
  if (config === null) {
    if (configured) {
      throw new Error("ambiguous ownership: configured local runner is missing canonical gitHubUrl binding");
    }
    return;
  }
  if (config.gitHubUrl !== expected || config.agentName !== RUNNER_NAME) {
    throw new Error("ambiguous ownership: local runner configuration does not match the canonical repository and name");
  }
}

/**
 * Reconcile same-name registrations around the exact locally configured ID.
 * A name is never sufficient authority for a removal: all candidates are
 * validated first and no row is deleted until the exact owned ID is present.
 */
async function reconcileRegistrations(
  github: RunnerGitHub,
  repo: string,
  exactRunnerId: number | null,
  observedRegistrations: RunnerRegistration[],
  markMutationBoundary: () => void = () => undefined,
): Promise<{ kept: RunnerRegistration | null; removed: number[] }> {
  if (exactRunnerId === null) {
    if (observedRegistrations.some((registration) => registration.name === RUNNER_NAME)) {
      throw new Error("same-name GitHub runner registration cannot be reconciled without an exact local ID");
    }
    return { kept: null, removed: [] };
  }
  const kept = observedRegistrations.find((registration) => registration.id === exactRunnerId) ?? null;
  if (kept !== null && !registrationHasCanonicalIdentity(kept)) {
    throw new Error("exact GitHub runner registration does not have the canonical identity");
  }
  if (kept === null) {
    if (observedRegistrations.some((registration) => registration.name === RUNNER_NAME)) {
      throw new Error("same-name GitHub runner registration cannot be reconciled without the exact local ID");
    }
    return { kept: null, removed: [] };
  }
  const duplicates = observedRegistrations.filter(
    (registration) => registration.name === RUNNER_NAME && registration.id !== exactRunnerId,
  );
  if (duplicates.some((registration) => !registrationHasCanonicalIdentity(registration))) {
    throw new Error("same-name GitHub runner registration has an ambiguous noncanonical identity");
  }
  const removed: number[] = [];
  for (const registration of duplicates) {
    markMutationBoundary();
    await github.removeRunner(repo, registration.id);
    removed.push(registration.id);
  }
  return { kept, removed };
}

function requireValidRunnerProcesses(instances: RunnerProcess[]): void {
  const pids = new Set<number>();
  for (const instance of instances) {
    if (
      !Number.isSafeInteger(instance.pid) ||
      instance.pid <= 0 ||
      pids.has(instance.pid) ||
      !path.win32.isAbsolute(instance.executablePath) ||
      !Number.isFinite(Date.parse(instance.startedAt)) ||
      new Date(instance.startedAt).toISOString() !== instance.startedAt
    ) {
      throw new Error("runner process observation returned an invalid identity");
    }
    pids.add(instance.pid);
  }
}

function sameRunnerProcess(left: RunnerProcess, right: RunnerProcess): boolean {
  return (
    left.pid === right.pid &&
    left.executablePath.toLowerCase() === right.executablePath.toLowerCase() &&
    left.startedAt === right.startedAt
  );
}

/** Reconcile duplicate local runner processes, keeping the earliest creation identity. */
async function reconcileProcesses(
  host: RunnerHost,
  observedInstances: RunnerProcess[],
  markMutationBoundary: () => void = () => undefined,
): Promise<{ kept: RunnerProcess | null; stopped: number[] }> {
  const instances = observedInstances;
  requireValidRunnerProcesses(instances);
  if (instances.length <= 1) return { kept: instances[0] ?? null, stopped: [] };
  const sorted = [...instances].sort(
    (left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt) || left.pid - right.pid,
  );
  const extras = sorted.slice(1);
  markMutationBoundary();
  await host.stopInstances(extras);
  return { kept: sorted[0] ?? null, stopped: extras.map((instance) => instance.pid) };
}

/**
 * Keep the lifecycle lock across the spawn-to-observable transition. Releasing
 * the lock before CIM can confirm the exact spawned Listener identity would
 * leave a window where a concurrent direct `runner run` could launch a second
 * host.
 */
async function waitForStartedRunner(
  host: RunnerHost,
  installDir: string,
  handle: RunnerRunHandle,
  markMutationBoundary: () => void,
  timeoutMs: number,
  intervalMs: number,
): Promise<{ process: RunnerProcess; stopped: number[] }> {
  const exitState: { value: { code: number } | { error: unknown } | null } = { value: null };
  void handle.exited.then(
    (code) => { exitState.value = { code }; },
    (error) => { exitState.value = { error }; },
  );
  const deadline = Date.now() + timeoutMs;
  const stopped: number[] = [];
  try {
    do {
      const observed = await host.runningInstances(installDir);
      requireValidRunnerProcesses(observed);
      const owned = observed.find(
        (instance) =>
          instance.pid === handle.process.pid &&
          instance.executablePath.toLowerCase() === handle.process.executablePath.toLowerCase() &&
          instance.startedAt === handle.process.startedAt,
      ) ?? null;
      // Do not stop a process merely because the owned process has not become
      // observable yet. Once ownership is proven, every other exact-install
      // Listener is a duplicate and can be reconciled safely.
      const extras = owned === null
        ? []
        : observed.filter(
            (instance) =>
              instance.pid !== owned.pid ||
              instance.executablePath.toLowerCase() !== owned.executablePath.toLowerCase() ||
              instance.startedAt !== owned.startedAt,
          );
      if (extras.length > 0) {
        markMutationBoundary();
        await host.stopInstances(extras);
        stopped.push(...extras.map((instance) => instance.pid));
      }
      if (owned !== null) return { process: owned, stopped };
      if (exitState.value !== null) {
        if ("error" in exitState.value) throw exitState.value.error;
        throw new Error(`runner host exited with code ${exitState.value.code} before its process became observable`);
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    } while (Date.now() < deadline);
    throw new Error("runner host start postcondition timed out before its process became observable");
  } catch (error) {
    try {
      await handle.terminate();
    } catch {
      throw new Error("runner host start failed and exact-process cleanup did not complete");
    }
    throw error;
  }
}

/**
 * Establish one exact local Listener under the short startup horizon. When a
 * process was retained across preflight, its identity is already authoritative
 * and disappearance or replacement is a decisive failure rather than a reason
 * to bind readiness to a later process.
 */
async function waitForRunnerProcess(
  host: RunnerHost,
  installDir: string,
  expected: RunnerProcess | null,
  timeoutMs: number,
  intervalMs: number,
): Promise<RunnerProcess> {
  const deadline = Date.now() + timeoutMs;
  do {
    const observed = await host.runningInstances(installDir);
    requireValidRunnerProcesses(observed);
    if (expected !== null) {
      if (observed.length !== 1 || !sameRunnerProcess(observed[0]!, expected)) {
        throw new Error("runner process changed during startup observation");
      }
      return observed[0]!;
    }
    if (observed.length > 1) {
      throw new Error("runner process changed during startup observation");
    }
    if (observed.length === 1) return observed[0]!;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (Date.now() < deadline);
  throw new Error("runner host start postcondition timed out before its process became observable");
}

async function waitForRunnerReady(
  host: RunnerHost,
  github: RunnerGitHub,
  installDir: string,
  exactRunnerId: number,
  expectedProcess: RunnerProcess,
  requireFreshOnlineTransition: boolean,
  timeoutMs: number,
  intervalMs: number,
): Promise<{ process: RunnerProcess; registration: RunnerRegistration }> {
  const deadline = Date.now() + timeoutMs;
  // When no local Listener exists but GitHub still says online, that remote
  // truth can belong only to the terminated process's retained session. Do
  // not bind a newly observed PID to it; require the provider to expose the
  // stale session's offline edge before accepting the new online edge.
  let observedOffline = !requireFreshOnlineTransition;
  do {
    const [processes, registrations] = await Promise.all([
      host.runningInstances(installDir),
      github.listRunners(RUNNER_REPOSITORY),
    ]);
    requireValidRunnerProcesses(processes);
    if (processes.length !== 1 || !sameRunnerProcess(processes[0]!, expectedProcess)) {
      throw new Error("runner process changed during startup observation");
    }
    const sameName = registrations.filter((registration) => registration.name === RUNNER_NAME);
    const exact = sameName.find((registration) => registration.id === exactRunnerId) ?? null;
    if (
      sameName.length !== 1 ||
      exact === null ||
      !registrationHasCanonicalIdentity(exact)
    ) {
      throw new Error("GitHub runner registration changed during startup observation");
    }
    if (exact.status === "offline") observedOffline = true;
    if (exact.status === "online" && observedOffline) {
      // Sandwich the control-plane observation between two exact local reads.
      // A Listener that exits or is replaced while GitHub is queried cannot
      // satisfy the final conjunction.
      const after = await host.runningInstances(installDir);
      requireValidRunnerProcesses(after);
      if (after.length !== 1 || !sameRunnerProcess(after[0]!, expectedProcess)) {
        throw new Error("runner process changed during startup observation");
      }
      return { process: after[0]!, registration: exact };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (Date.now() < deadline);
  throw new Error(
    "runner readiness postcondition timed out before one exact Listener and its sole registration were online",
  );
}

async function finalizeRunnerReadiness(
  state: SharedState,
  deps: ResolvedDeps,
  github: RunnerGitHub,
  result: RunnerActionResult,
  exactRunnerId: number | null,
  expectedProcess: RunnerProcess | null,
  requireFreshOnlineTransition: boolean,
  redact: (text: string) => string,
): Promise<RunnerActionResult> {
  if (!result.ok) return result;
  if (exactRunnerId === null) {
    return redactRunnerOutput({
      ok: false,
      action: result.action,
      changed: result.changed,
      issues: ["runner readiness identity was not retained across the mutation boundary"],
      details: result.changed ? { partialMutation: true } : {},
    }, redact);
  }
  try {
    const process = await waitForRunnerProcess(
      deps.host,
      runnerInstallDir(state),
      expectedProcess,
      deps.startObservationTimeoutMs,
      deps.startObservationIntervalMs,
    );
    await waitForRunnerReady(
      deps.host,
      github,
      runnerInstallDir(state),
      exactRunnerId,
      process,
      requireFreshOnlineTransition,
      deps.readinessObservationTimeoutMs,
      deps.readinessObservationIntervalMs,
    );
    return result;
  } catch (error) {
    return redactRunnerOutput({
      ok: false,
      action: result.action,
      changed: result.changed,
      issues: [redactError(error, redact)],
      details: result.changed ? { partialMutation: true } : {},
    }, redact);
  }
}

function isInstalledAndHealthy(observation: RunnerObservation, spec: ScheduledTaskSpec): boolean {
  const launcher = launcherCheck(observation.doctor);
  const registrations = matchingRegistrations(observation);
  return (
    observation.record !== null &&
    observation.provisioned &&
    observation.configured &&
    observation.config?.gitHubUrl === runnerRepositoryUrl(RUNNER_REPOSITORY) &&
    observation.config.agentName === RUNNER_NAME &&
    observation.config.disableUpdate &&
    observation.record.runnerId === observation.config.agentId &&
    observation.doctor.ok &&
    launcher?.ok === true &&
    registrations.length === 1 &&
    registrations[0]?.id === observation.config.agentId &&
    registrations[0]?.status === "online" &&
    registrationHasCanonicalIdentity(registrations[0]!) &&
    observation.task !== null &&
    observation.task.enabled &&
    taskMatchesSpec(observation.task, spec) &&
    taskHasCanonicalPersistence(observation.task, spec) &&
    observation.processes.length === 1
  );
}

// ---------------------------------------------------------------------------
// Lifecycle actions
// ---------------------------------------------------------------------------

export async function installRunner(state: SharedState, overrides: RunnerDeps = {}): Promise<RunnerActionResult> {
  const deps = resolveDeps(overrides);
  const github = resolveGitHub(state, deps, overrides);
  const sensitive: Array<string | null> = [];
  const redact = makeRedactor(sensitive);
  let readinessRunnerId: number | null = null;
  let readinessProcess: RunnerProcess | null = null;
  let readinessRequiresFreshOnlineTransition = false;
  const mutation = await executeRunnerMutation(state, "install", redact, async (markMutationBoundary) => {
    requireWindows(deps);
    const doctor = await deps.doctor(state);
    requireHealthyDoctor(doctor, redact);

    const existing = await readRunnerRecord(state);
    const record = existing ?? defaultRunnerRecord(state, deps.platform);
    if (existing) requireCanonicalRunnerPersistence(state, record);
    const installDir = runnerInstallDir(state);
    const principalUser = resolveWindowsPrincipal(deps.principal);
    const spec = buildRunnerTaskSpec(state, principalUser);

    const observation = await observeRunner(state, deps, github);
    // Enforce the doctor result from the same complete preflight snapshot used
    // for mutation. A healthy earlier probe cannot authorize later drift.
    requireHealthyDoctor(observation.doctor, redact);
    requireRunnerBinding(observation.configured, observation.config, RUNNER_REPOSITORY);
    if (isInstalledAndHealthy(observation, spec)) {
      readinessRunnerId = observation.config!.agentId;
      readinessProcess = observation.processes[0]!;
      return {
        ok: true,
        action: "install",
        changed: false,
        issues: [],
        details: { runnerId: observation.record?.runnerId ?? null, note: "runner already installed and healthy" },
      };
    }
    if (observation.task && (observation.task.actionCount > 1 || observation.task.triggerCount > 1)) {
      throw new Error("scheduled task has extra actions or triggers; refusing automatic install replacement");
    }

    const serverBefore = await reconcileRegistrations(
      github,
      RUNNER_REPOSITORY,
      observation.config?.agentId ?? record.runnerId,
      observation.registrations,
      markMutationBoundary,
    );
    const processBefore = await reconcileProcesses(deps.host, observation.processes, markMutationBoundary);
    const changes: string[] = [];
    if (serverBefore.removed.length > 0) changes.push(`removed duplicate registrations ${serverBefore.removed.join(",")}`);
    if (processBefore.stopped.length > 0) changes.push(`stopped duplicate processes ${processBefore.stopped.join(",")}`);

    let configured = observation.configured;
    let configuration = observation.config;
    let keptProcess = processBefore.kept;
    if (!observation.provisioned) {
      if (keptProcess !== null) {
        markMutationBoundary();
        await deps.host.stopInstances([keptProcess]);
        changes.push(`stopped process ${keptProcess.pid} before provisioning`);
        keptProcess = null;
      }
      markMutationBoundary();
      await deps.host.provision(installDir);
      record.provisionedAt = deps.now().toISOString();
      configured = await deps.host.isConfigured(installDir);
      configuration = await readRunnerConfiguration(installDir);
      requireRunnerBinding(configured, configuration, RUNNER_REPOSITORY);
      changes.push("provisioned runner software");
    }

    let registration = serverBefore.kept;
    if (!configured || configuration === null || !configuration.disableUpdate || registration === null) {
      if (keptProcess !== null) {
        markMutationBoundary();
        await deps.host.stopInstances([keptProcess]);
        changes.push(`stopped process ${keptProcess.pid} before registration`);
        keptProcess = null;
      }
      const { token } = await github.createRegistrationToken(RUNNER_REPOSITORY);
      sensitive.push(token);
      markMutationBoundary();
      await deps.host.resetLocalConfiguration(installDir);
      changes.push("reset local runner configuration");
      markMutationBoundary();
      await deps.host.configure(installDir, {
        url: runnerRepositoryUrl(RUNNER_REPOSITORY),
        token,
        name: RUNNER_NAME,
        labels: [...RUNNER_LABELS],
      });
      configured = await deps.host.isConfigured(installDir);
      configuration = await readRunnerConfiguration(installDir);
      requireRunnerBinding(configured, configuration, RUNNER_REPOSITORY);
      if (!configured || configuration === null || !configuration.disableUpdate) {
        throw new Error("runner configuration postcondition failed");
      }

      const postConfigureRegistrations = await github.listRunners(RUNNER_REPOSITORY);
      const serverAfter = await reconcileRegistrations(
        github,
        RUNNER_REPOSITORY,
        configuration.agentId,
        postConfigureRegistrations,
        markMutationBoundary,
      );
      if (!serverAfter.kept) throw new Error("registration did not produce the exact locally configured repository runner");
      registration = serverAfter.kept;
      changes.push("registered runner");
      if (serverAfter.removed.length > 0) changes.push(`removed duplicate registrations ${serverAfter.removed.join(",")}`);
      record.registeredAt = deps.now().toISOString();
    }
    if (configuration === null || registration.id !== configuration.agentId) {
      throw new Error("local and GitHub runner identity postcondition failed");
    }
    record.runnerId = registration.id;
    readinessRunnerId = registration.id;
    record.registered = true;
    record.registeredAt ??= deps.now().toISOString();

    let currentTask = observation.task;
    if (!taskMatchesSpec(currentTask, spec) || !taskHasCanonicalPersistence(currentTask, spec)) {
      markMutationBoundary();
      await deps.scheduler.create(spec);
      changes.push(currentTask ? "rebound scheduled task" : "created scheduled task");
      currentTask = await deps.scheduler.query(spec);
      if (!taskMatchesSpec(currentTask, spec) || !taskHasCanonicalPersistence(currentTask, spec)) {
        throw new Error("scheduled task postcondition failed");
      }
    }
    if (!currentTask?.enabled) {
      markMutationBoundary();
      await deps.scheduler.setEnabled(spec, true);
      changes.push("enabled scheduled task");
    }
    const enabledTask = await deps.scheduler.query(spec);
    if (!enabledTask?.enabled || !taskMatchesSpec(enabledTask, spec) || !taskHasCanonicalPersistence(enabledTask, spec)) {
      throw new Error("scheduled task enable postcondition failed");
    }
    record.enabled = true;

    markMutationBoundary();
    await writeRunnerRecord(state, record);
    changes.push("wrote canonical runner record");
    readinessProcess = keptProcess;
    if (keptProcess === null) {
      readinessRequiresFreshOnlineTransition = registration.status === "online";
      markMutationBoundary();
      await deps.scheduler.start(spec);
      changes.push("started scheduled task");
    }
    return {
      ok: true,
      action: "install",
      changed: changes.length > 0,
      issues: [],
      details: {
        runnerId: record.runnerId,
        changes,
      },
    };
  });
  return finalizeRunnerReadiness(
    state,
    deps,
    github,
    mutation,
    readinessRunnerId,
    readinessProcess,
    readinessRequiresFreshOnlineTransition,
    redact,
  );
}

export async function enableRunner(state: SharedState, overrides: RunnerDeps = {}): Promise<RunnerActionResult> {
  const deps = resolveDeps(overrides);
  const github = resolveGitHub(state, deps, overrides);
  const redact = makeRedactor([]);
  let readinessRunnerId: number | null = null;
  let readinessProcess: RunnerProcess | null = null;
  let readinessRequiresFreshOnlineTransition = false;
  const mutation = await executeRunnerMutation(state, "enable", redact, async (markMutationBoundary) => {
    requireWindows(deps);
    const observation = await observeRunner(state, deps, github);
    requireHealthyDoctor(observation.doctor, redact);
    const record = observation.record;
    if (!record || !record.registered) {
      throw new Error("runner is not installed/registered; run `andromeda runner install` first");
    }
    requireCanonicalRunnerPersistence(state, record);
    requireRunnerBinding(observation.configured, observation.config, RUNNER_REPOSITORY);
    if (
      !observation.provisioned ||
      !observation.configured ||
      observation.config === null ||
      !observation.config.disableUpdate
    ) {
      throw new Error("runner software or configuration is incomplete; run `andromeda runner repair`");
    }
    if (record.runnerId !== observation.config.agentId) {
      throw new Error("runner record and local configuration identify different runners; run `andromeda runner repair`");
    }
    const principalUser = resolveWindowsPrincipal(deps.principal);
    const spec = buildRunnerTaskSpec(state, principalUser);
    const task = observation.task;
    if (!task) throw new Error(`scheduled task ${RUNNER_SCHEDULED_TASK} is missing; run \`andromeda runner repair\``);
    if (!taskMatchesSpec(task, spec) || !taskHasCanonicalPersistence(task, spec)) {
      throw new Error(`scheduled task ${RUNNER_SCHEDULED_TASK} does not have the canonical definition; run \`andromeda runner repair\``);
    }

    const registration = await reconcileRegistrations(
      github,
      RUNNER_REPOSITORY,
      observation.config.agentId,
      observation.registrations,
      markMutationBoundary,
    );
    if (!registration.kept) throw new Error("exact GitHub runner registration is missing; run `andromeda runner repair`");
    readinessRunnerId = registration.kept.id;
    const processes = await reconcileProcesses(deps.host, observation.processes, markMutationBoundary);
    readinessProcess = processes.kept;
    const changes: string[] = [];
    if (registration.removed.length > 0) changes.push(`removed duplicate registrations ${registration.removed.join(",")}`);
    if (processes.stopped.length > 0) changes.push(`stopped duplicate processes ${processes.stopped.join(",")}`);
    if (!task.enabled) {
      markMutationBoundary();
      await deps.scheduler.setEnabled(spec, true);
      changes.push("enabled scheduled task");
    }
    const enabledTask = await deps.scheduler.query(spec);
    if (!enabledTask?.enabled || !taskMatchesSpec(enabledTask, spec) || !taskHasCanonicalPersistence(enabledTask, spec)) {
      throw new Error("scheduled task enable postcondition failed");
    }
    // Commit authority before Start-ScheduledTask. Its `andromeda runner run`
    // child must see enabled truth after this lock is released.
    if (!record.enabled) {
      record.enabled = true;
      markMutationBoundary();
      await writeRunnerRecord(state, record);
      changes.push("updated runner record");
    }
    if (processes.kept === null) {
      readinessRequiresFreshOnlineTransition = registration.kept.status === "online";
      markMutationBoundary();
      await deps.scheduler.start(spec);
      changes.push("started scheduled task");
    }
    return {
      ok: true,
      action: "enable",
      changed: changes.length > 0,
      issues: [],
      details: { task: RUNNER_SCHEDULED_TASK, changes },
    };
  });
  return finalizeRunnerReadiness(
    state,
    deps,
    github,
    mutation,
    readinessRunnerId,
    readinessProcess,
    readinessRequiresFreshOnlineTransition,
    redact,
  );
}

export async function disableRunner(state: SharedState, overrides: RunnerDeps = {}): Promise<RunnerActionResult> {
  const deps = resolveDeps(overrides);
  const redact = makeRedactor([]);
  return executeRunnerMutation(state, "disable", redact, async (markMutationBoundary) => {
    requireWindows(deps);
    const record = await readRunnerRecord(state);
    if (!record) {
      return { ok: true, action: "disable", changed: false, issues: [], details: { note: "runner not installed" } };
    }
    requireCanonicalRunnerPersistence(state, record);
    const installDir = runnerInstallDir(state);
    const identity = { name: RUNNER_SCHEDULED_TASK, path: RUNNER_SCHEDULED_TASK_PATH };
    const [task, instances] = await Promise.all([
      deps.scheduler.query(identity),
      deps.host.runningInstances(installDir),
    ]);
    requireValidRunnerProcesses(instances);
    let changed = false;

    if (task && task.enabled) {
      markMutationBoundary();
      await deps.scheduler.setEnabled(identity, false);
      const disabledTask = await deps.scheduler.query(identity);
      if (disabledTask === null || disabledTask.enabled) throw new Error("scheduled task disable postcondition failed");
      changed = true;
    }
    if (instances.length > 0) {
      markMutationBoundary();
      await deps.host.stopInstances(instances);
      changed = true;
    }
    if (record.enabled) {
      record.enabled = false;
      markMutationBoundary();
      await writeRunnerRecord(state, record);
      changed = true;
    }
    return {
      ok: true,
      action: "disable",
      changed,
      issues: [],
      details: { task: RUNNER_SCHEDULED_TASK, stopped: instances.map((i) => i.pid) },
    };
  });
}

export async function repairRunner(state: SharedState, overrides: RunnerDeps = {}): Promise<RunnerActionResult> {
  const deps = resolveDeps(overrides);
  const github = resolveGitHub(state, deps, overrides);
  const sensitive: Array<string | null> = [];
  const redact = makeRedactor(sensitive);
  let readinessRunnerId: number | null = null;
  let readinessProcess: RunnerProcess | null = null;
  let readinessRequiresFreshOnlineTransition = false;
  const mutation = await executeRunnerMutation(state, "repair", redact, async (markMutationBoundary) => {
    requireWindows(deps);
    const doctor = await deps.doctor(state);
    requireHealthyDoctor(doctor, redact);

    const existing = await readRunnerRecord(state);
    const record = existing ?? defaultRunnerRecord(state, deps.platform);
    if (existing) requireCanonicalRunnerPersistence(state, record);
    const originalRecord = JSON.stringify(record);
    const installDir = runnerInstallDir(state);
    const principalUser = resolveWindowsPrincipal(deps.principal);
    const spec = buildRunnerTaskSpec(state, principalUser);

    const [observedConfigured, observedConfiguration, observedProvisioned, observedProcesses, observedRegistrations, observedTask] =
      await Promise.all([
        deps.host.isConfigured(installDir),
        readRunnerConfiguration(installDir),
        deps.host.isProvisioned(installDir),
        deps.host.runningInstances(installDir),
        github.listRunners(RUNNER_REPOSITORY),
        deps.scheduler.query(spec),
      ]);
    let configured = observedConfigured;
    let configuration = observedConfiguration;
    requireRunnerBinding(configured, configuration, RUNNER_REPOSITORY);
    if (observedTask && (observedTask.actionCount > 1 || observedTask.triggerCount > 1)) {
      throw new Error("scheduled task has extra actions or triggers; refusing automatic repair");
    }

    const changed: string[] = [];

    // Reconcile duplicate local processes first.
    const processReconcile = await reconcileProcesses(deps.host, observedProcesses, markMutationBoundary);
    if (processReconcile.stopped.length > 0) changed.push(`stopped duplicate processes ${processReconcile.stopped.join(",")}`);

    // Reconcile only the rows supplied by preflight. This deliberately does
    // not re-list after process mutation.
    const serverBefore = await reconcileRegistrations(
      github,
      RUNNER_REPOSITORY,
      configuration?.agentId ?? record.runnerId,
      observedRegistrations,
      markMutationBoundary,
    );
    if (serverBefore.removed.length > 0) changed.push(`removed duplicate registrations ${serverBefore.removed.join(",")}`);

    let keptProcess = processReconcile.kept;

    // Ensure the host software is provisioned.
    if (!observedProvisioned) {
      if (keptProcess !== null) {
        markMutationBoundary();
        await deps.host.stopInstances([keptProcess]);
        changed.push(`stopped process ${keptProcess.pid} before provisioning`);
        keptProcess = null;
      }
      markMutationBoundary();
      await deps.host.provision(installDir);
      record.provisionedAt = deps.now().toISOString();
      changed.push("provisioned runner software");
      configured = await deps.host.isConfigured(installDir);
      configuration = await readRunnerConfiguration(installDir);
      requireRunnerBinding(configured, configuration, RUNNER_REPOSITORY);
    }

    let registration = serverBefore.kept;
    if (!configured || configuration === null || !configuration.disableUpdate || registration === null) {
      if (keptProcess !== null) {
        markMutationBoundary();
        await deps.host.stopInstances([keptProcess]);
        changed.push(`stopped process ${keptProcess.pid} before registration`);
        keptProcess = null;
      }
      const { token } = await github.createRegistrationToken(RUNNER_REPOSITORY);
      sensitive.push(token);
      markMutationBoundary();
      await deps.host.resetLocalConfiguration(installDir);
      changed.push("reset local runner configuration");
      markMutationBoundary();
      await deps.host.configure(installDir, {
        url: runnerRepositoryUrl(RUNNER_REPOSITORY),
        token,
        name: RUNNER_NAME,
        labels: [...RUNNER_LABELS],
      });
      configured = await deps.host.isConfigured(installDir);
      configuration = await readRunnerConfiguration(installDir);
      requireRunnerBinding(configured, configuration, RUNNER_REPOSITORY);
      if (!configured || configuration === null || !configuration.disableUpdate) {
        throw new Error("runner configuration postcondition failed");
      }
      const postConfigureRegistrations = await github.listRunners(RUNNER_REPOSITORY);
      const after = await reconcileRegistrations(
        github,
        RUNNER_REPOSITORY,
        configuration.agentId,
        postConfigureRegistrations,
        markMutationBoundary,
      );
      if (!after.kept) throw new Error("registration did not produce the exact locally configured repository runner");
      registration = after.kept;
      record.registeredAt = deps.now().toISOString();
      changed.push("re-registered runner");
      if (after.removed.length > 0) changed.push(`removed duplicate registrations ${after.removed.join(",")}`);
    }
    if (configuration === null || registration.id !== configuration.agentId) {
      throw new Error("local and GitHub runner identity postcondition failed");
    }
    record.runnerId = registration.id;
    readinessRunnerId = registration.id;
    record.registered = true;
    record.registeredAt ??= deps.now().toISOString();

    // Replace only a positively missing task or an unambiguous exact-root task
    // whose zero/one action and trigger evidence is known drift.
    let current = observedTask;
    if (!taskMatchesSpec(current, spec) || !taskHasCanonicalPersistence(current, spec)) {
      markMutationBoundary();
      await deps.scheduler.create(spec);
      changed.push(current ? "rebound scheduled task to canonical launcher and persistence definition" : "created scheduled task");
      current = await deps.scheduler.query(spec);
      if (!taskMatchesSpec(current, spec) || !taskHasCanonicalPersistence(current, spec)) {
        throw new Error("scheduled task postcondition failed");
      }
    }
    if (!current?.enabled) {
      markMutationBoundary();
      await deps.scheduler.setEnabled(spec, true);
      changed.push("enabled scheduled task");
    }
    const enabledTask = await deps.scheduler.query(spec);
    if (!enabledTask?.enabled || !taskMatchesSpec(enabledTask, spec) || !taskHasCanonicalPersistence(enabledTask, spec)) {
      throw new Error("scheduled task enable postcondition failed");
    }
    record.enabled = true;
    const recordChanged = existing === null || JSON.stringify(record) !== originalRecord;
    const shouldStart = keptProcess === null;
    readinessProcess = keptProcess;
    if (recordChanged || changed.length > 0 || shouldStart) {
      record.lastRepairedAt = deps.now().toISOString();
      markMutationBoundary();
      await writeRunnerRecord(state, record);
      changed.push("wrote canonical runner record");
    }
    if (shouldStart) {
      readinessRequiresFreshOnlineTransition = registration.status === "online";
      markMutationBoundary();
      await deps.scheduler.start(spec);
      changed.push("started scheduled task");
    }
    return {
      ok: true,
      action: "repair",
      changed: changed.length > 0,
      issues: [],
      details: { runnerId: record.runnerId, repairs: changed },
    };
  });
  return finalizeRunnerReadiness(
    state,
    deps,
    github,
    mutation,
    readinessRunnerId,
    readinessProcess,
    readinessRequiresFreshOnlineTransition,
    redact,
  );
}

/**
 * Supervised host entrypoint launched by the scheduled task. It gates on a
 * healthy canonical state doctor, refuses to start a duplicate instance, and
 * then execs the runner host under the canonical environment. This keeps host
 * process supervision inside Agent OS rather than DarkFactory.
 */
export async function runRunner(state: SharedState, overrides: RunnerDeps = {}): Promise<RunnerActionResult> {
  const deps = resolveDeps(overrides);
  const github = resolveGitHub(state, deps, overrides);
  const redact = makeRedactor([]);
  let runHandle: RunnerRunHandle | null = null;
  let readinessRunnerId: number | null = null;
  let readinessProcess: RunnerProcess | null = null;
  let readinessRequiresFreshOnlineTransition = false;
  const preflight = await executeRunnerMutation(state, "run", redact, async (markMutationBoundary) => {
    requireWindows(deps);
    const observation = await observeRunner(state, deps, github);
    requireHealthyDoctor(observation.doctor, redact);
    const record = observation.record;
    if (!record || !record.registered || !record.enabled) {
      throw new Error("runner is not installed and enabled; refusing to start the host");
    }
    requireCanonicalRunnerPersistence(state, record);
    requireRunnerBinding(observation.configured, observation.config, RUNNER_REPOSITORY);
    if (
      !observation.provisioned ||
      !observation.configured ||
      observation.config === null ||
      !observation.config.disableUpdate
    ) {
      throw new Error("runner software or configuration is incomplete; run `andromeda runner repair`");
    }
    if (record.runnerId !== observation.config.agentId) {
      throw new Error("runner record and local configuration identify different runners; run `andromeda runner repair`");
    }
    const principalUser = resolveWindowsPrincipal(deps.principal);
    const spec = buildRunnerTaskSpec(state, principalUser);
    if (
      observation.task === null ||
      !observation.task.enabled ||
      !taskMatchesSpec(observation.task, spec) ||
      !taskHasCanonicalPersistence(observation.task, spec)
    ) {
      throw new Error("scheduled task is not enabled with the canonical definition; run `andromeda runner repair`");
    }
    const registration = await reconcileRegistrations(
      github,
      RUNNER_REPOSITORY,
      observation.config.agentId,
      observation.registrations,
      markMutationBoundary,
    );
    if (!registration.kept) throw new Error("exact GitHub runner registration is missing; run `andromeda runner repair`");
    readinessRunnerId = registration.kept.id;
    const processes = await reconcileProcesses(deps.host, observation.processes, markMutationBoundary);
    if (processes.kept !== null) {
      readinessProcess = processes.kept;
      return {
        ok: true,
        action: "run",
        changed: registration.removed.length > 0 || processes.stopped.length > 0,
        issues: [],
        details: {
          note: "runner host already running",
          pids: [processes.kept.pid],
          removedDuplicateRegistrations: registration.removed,
          stoppedDuplicateProcesses: processes.stopped,
        },
      };
    }
    readinessRequiresFreshOnlineTransition = registration.kept.status === "online";
    const env = {
      ...canonicalChildEnvironment(),
      ANDROMEDA_HOME: state.stateDir,
      ANDROMEDA_USER_HOME: state.userHome,
      ANDROMEDA_ROOT: state.root,
    };
    markMutationBoundary();
    runHandle = await deps.host.run(runnerInstallDir(state), env);
    const started = await waitForStartedRunner(
      deps.host,
      runnerInstallDir(state),
      runHandle,
      markMutationBoundary,
      deps.startObservationTimeoutMs,
      deps.startObservationIntervalMs,
    );
    readinessProcess = started.process;
    return {
      ok: true,
      action: "run",
      changed: true,
      issues: [],
      details: {
        note: "runner host started",
        pid: started.process.pid,
        stoppedDuplicateProcesses: started.stopped,
      },
    };
  });
  // The handle is assigned inside the locked callback. Capture it explicitly;
  // TypeScript cannot infer closure assignment through that async boundary.
  const completedHandle = runHandle as RunnerRunHandle | null;
  if (!preflight.ok) return preflight;
  let ready: Awaited<ReturnType<typeof waitForRunnerReady>>;
  try {
    if (readinessRunnerId === null) throw new Error("runner readiness identity was not retained across the mutation boundary");
    const process = await waitForRunnerProcess(
      deps.host,
      runnerInstallDir(state),
      readinessProcess,
      deps.startObservationTimeoutMs,
      deps.startObservationIntervalMs,
    );
    ready = await waitForRunnerReady(
      deps.host,
      github,
      runnerInstallDir(state),
      readinessRunnerId,
      process,
      readinessRequiresFreshOnlineTransition,
      deps.readinessObservationTimeoutMs,
      deps.readinessObservationIntervalMs,
    );
  } catch (error) {
    if (completedHandle !== null) {
      try {
        await completedHandle.terminate();
      } catch {
        return redactRunnerOutput({
          ok: false,
          action: "run",
          changed: preflight.changed,
          issues: ["runner registration start failed and exact-process cleanup did not complete"],
          details: preflight.changed ? { partialMutation: true } : {},
        }, redact);
      }
    }
    return redactRunnerOutput({
      ok: false,
      action: "run",
      changed: preflight.changed,
      issues: [redactError(error, redact)],
      details: preflight.changed ? { partialMutation: true } : {},
    }, redact);
  }
  if (completedHandle === null) {
    return {
      ...preflight,
      details: { ...preflight.details, pids: [ready.process.pid] },
    };
  }
  try {
    const code = await completedHandle.exited;
    return redactRunnerOutput({
      ok: code === 0,
      action: "run",
      changed: true,
      issues: code === 0 ? [] : [`runner host exited with code ${code}`],
      details: { exitCode: code },
    }, redact);
  } catch (error) {
    return redactRunnerOutput({
      ok: false,
      action: "run",
      changed: true,
      issues: [redactError(error, redact)],
      details: { partialMutation: true },
    }, redact);
  }
}

type StatusObservation<T> =
  | { known: true; value: T }
  | { known: false; issue: string };

interface NormalizedStatusDoctorCheck {
  id: string;
  ok: boolean;
  message: string;
  details?: unknown;
}

interface NormalizedStatusDoctor {
  ok: boolean;
  checks: NormalizedStatusDoctorCheck[];
  launcher: NormalizedStatusDoctorCheck | null;
}

async function settleStatusObservation<T>(issue: string, observe: () => T | Promise<T>): Promise<StatusObservation<T>> {
  try {
    return { known: true, value: await observe() };
  } catch {
    return { known: false, issue };
  }
}

function normalizeStatusDoctor(value: unknown): NormalizedStatusDoctor {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("state doctor output was malformed");
  }
  const report = value as Record<string, unknown>;
  if (typeof report.ok !== "boolean" || !Array.isArray(report.checks)) {
    throw new Error("state doctor output was malformed");
  }
  const checks = report.checks.map((value): NormalizedStatusDoctorCheck => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("state doctor output was malformed");
    }
    const check = value as Record<string, unknown>;
    if (typeof check.id !== "string" || typeof check.message !== "string" || typeof check.ok !== "boolean") {
      throw new Error("state doctor output was malformed");
    }
    return { id: check.id, message: check.message, ok: check.ok, details: check.details };
  });
  if (report.ok !== checks.every((check) => check.ok)) {
    throw new Error("state doctor output was inconsistent");
  }
  const launchers = checks.filter((check) => check.id === "launcher");
  if (launchers.length > 1) throw new Error("state doctor launcher output was ambiguous");
  return { ok: report.ok, checks, launcher: launchers[0] ?? null };
}

function triStateAnd(values: RunnerTruth[]): RunnerTruth {
  if (values.includes(false)) return false;
  if (values.includes(null)) return null;
  return true;
}

function exactStringSet(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index]);
}

function runnerRecordIsCanonical(state: SharedState, platform: NodeJS.Platform, record: RunnerRecord): boolean {
  return (
    record.name === RUNNER_NAME &&
    record.repo === RUNNER_REPOSITORY &&
    exactStringSet(record.labels, RUNNER_LABELS) &&
    record.installDir === runnerInstallDir(state) &&
    record.launcherPath === runnerLauncherPath(state, platform) &&
    record.scheduledTask === RUNNER_SCHEDULED_TASK
  );
}

function runnerRecordLauncherIsCanonical(state: SharedState, platform: NodeJS.Platform, record: RunnerRecord): boolean {
  return record.launcherPath === runnerLauncherPath(state, platform);
}

function registrationMatchesCanonicalRecord(registration: RunnerRegistration, record: RunnerRecord): boolean {
  return (
    record.runnerId !== null &&
    registration.id === record.runnerId &&
    registrationHasCanonicalIdentity(registration)
  );
}

function launcherStatusIssues(check: NormalizedStatusDoctorCheck | null): string[] {
  if (check === null) return ["canonical launcher check is missing"];
  if (check.ok) return [];
  if (check.details && typeof check.details === "object" && !Array.isArray(check.details)) {
    const issues = (check.details as Record<string, unknown>).issues;
    if (Array.isArray(issues) && issues.length > 0 && issues.every((issue) => typeof issue === "string")) {
      return [...issues] as string[];
    }
  }
  return [check.message];
}

export async function runnerStatus(state: SharedState, overrides: RunnerDeps = {}): Promise<RunnerStatusReport> {
  const deps = resolveDeps(overrides);
  const github = resolveGitHub(state, deps, overrides);
  const redact = makeRedactor([]);
  const supported = deps.platform === "win32";
  const canonicalLauncher = runnerLauncherPath(state, deps.platform);

  if (!supported) {
    const readiness: RunnerReadiness = {
      installed: null,
      registered: null,
      enabled: null,
      persistent: null,
      process: null,
      online: null,
      launcherBinding: null,
    };
    return redactRunnerOutput<RunnerStatusReport>({
      ok: false,
      name: RUNNER_NAME,
      repo: RUNNER_REPOSITORY,
      labels: [...RUNNER_LABELS],
      platform: deps.platform,
      supported,
      readiness,
      installed: false,
      registered: false,
      enabled: false,
      record: { present: null, canonical: null },
      installation: {
        provisioned: null,
        configured: null,
        repositoryBinding: null,
        updateDisabled: null,
        version: null,
      },
      persistence: {
        mechanism: "scheduled-task",
        name: RUNNER_SCHEDULED_TASK,
        path: RUNNER_SCHEDULED_TASK_PATH,
        present: null,
        state: null,
        enabled: null,
        actionCount: null,
        triggerCount: null,
        triggerKind: null,
        triggerUser: null,
        principalUser: null,
        principalLogonType: null,
        principalRunLevel: null,
        multipleInstances: null,
        allowStartIfOnBatteries: null,
        dontStopIfGoingOnBatteries: null,
        restartCount: null,
        restartInterval: null,
        executionTimeLimit: null,
        boundToLauncher: null,
      },
      process: { running: null, instances: null, pids: null },
      registration: {
        id: null,
        os: null,
        labels: null,
        status: "unknown",
        busy: null,
        version: null,
        lastHeartbeat: null,
        duplicates: null,
      },
      binding: { launcher: canonicalLauncher, ok: null, issues: [] },
      doctor: { ok: null },
      issues: [`runner lifecycle status is unsupported on platform ${deps.platform}`],
    }, redact);
  }

  const canonicalInstall = runnerInstallDir(state);
  const taskIdentity: ScheduledTaskIdentity = { name: RUNNER_SCHEDULED_TASK, path: RUNNER_SCHEDULED_TASK_PATH };
  const [
    recordObservation,
    provisionedObservation,
    configuredObservation,
    configurationObservation,
    versionObservation,
    taskObservation,
    processObservation,
    doctorObservation,
    registrationObservation,
    principalObservation,
  ] = await Promise.all([
    settleStatusObservation("runner record observation failed", () => readRunnerRecord(state)),
    settleStatusObservation("runner software observation failed", () => deps.host.isProvisioned(canonicalInstall)),
    settleStatusObservation("runner configuration observation failed", () => deps.host.isConfigured(canonicalInstall)),
    settleStatusObservation("runner repository binding observation failed", () => readRunnerConfiguration(canonicalInstall)),
    settleStatusObservation("runner version observation failed", () => deps.host.runnerVersion(canonicalInstall)),
    settleStatusObservation("scheduled task observation failed", async () => {
      const task = await deps.scheduler.query(taskIdentity);
      if (task && !taskIdentityMatches(task, taskIdentity)) throw new Error("ambiguous task identity");
      return task;
    }),
    settleStatusObservation("runner process observation failed", async () => {
      const instances = await deps.host.runningInstances(canonicalInstall);
      requireValidRunnerProcesses(instances);
      return instances;
    }),
    settleStatusObservation("canonical state doctor observation failed", async () =>
      normalizeStatusDoctor(await deps.doctor(state))),
    settleStatusObservation("GitHub runner observation failed", () => github.listRunners(RUNNER_REPOSITORY)),
    settleStatusObservation("Windows principal observation failed", () => resolveWindowsPrincipal(deps.principal)),
  ]);

  const issues: string[] = [];
  const addIssue = (issue: string): void => {
    if (!issues.includes(issue)) issues.push(issue);
  };
  for (const observation of [
    recordObservation,
    provisionedObservation,
    configuredObservation,
    configurationObservation,
    versionObservation,
    taskObservation,
    processObservation,
    doctorObservation,
    registrationObservation,
    principalObservation,
  ]) {
    if (!observation.known) addIssue(observation.issue);
  }

  const record = recordObservation.known ? recordObservation.value : null;
  const recordPresent: RunnerTruth = recordObservation.known ? record !== null : null;
  const recordCanonical: RunnerTruth = recordObservation.known
    ? record !== null && runnerRecordIsCanonical(state, deps.platform, record)
    : null;
  const recordLauncherCanonical: RunnerTruth = recordObservation.known
    ? record !== null && runnerRecordLauncherIsCanonical(state, deps.platform, record)
    : null;
  const recordRegistered: RunnerTruth = recordObservation.known ? record?.registered ?? false : null;
  const recordEnabled: RunnerTruth = recordObservation.known ? record?.enabled ?? false : null;
  const recordHasRunnerId: RunnerTruth = recordObservation.known ? record?.runnerId !== null && record !== null : null;

  const provisioned: RunnerTruth = provisionedObservation.known ? provisionedObservation.value : null;
  const configured: RunnerTruth = configuredObservation.known ? configuredObservation.value : null;
  const repositoryBinding: RunnerTruth = configurationObservation.known
    ? configurationObservation.value !== null &&
      configurationObservation.value.gitHubUrl === runnerRepositoryUrl(RUNNER_REPOSITORY) &&
      configurationObservation.value.agentName === RUNNER_NAME
    : null;
  const updateDisabled: RunnerTruth = configurationObservation.known
    ? configurationObservation.value?.disableUpdate ?? false
    : null;

  const task = taskObservation.known ? taskObservation.value : null;
  const taskPresent: RunnerTruth = taskObservation.known ? task !== null : null;
  const taskEnabled: RunnerTruth = taskObservation.known ? task?.enabled ?? false : null;
  const actionSpec = buildRunnerTaskSpec(state, "");
  const taskActionBinding: RunnerTruth = taskObservation.known ? taskMatchesSpec(task, actionSpec) : null;
  const taskPersistenceShape: RunnerTruth = taskObservation.known
    ? task === null
      ? false
      : triStateAnd([
          task.triggerCount === 1,
          task.triggerKind === "AtLogOn",
          task.principalLogonType === "Interactive",
          task.principalRunLevel === "Limited",
          taskHasCanonicalSchedulerSettings(task),
        ])
    : null;
  const taskPersistencePrincipal: RunnerTruth = taskObservation.known
    ? task === null
      ? false
      : principalObservation.known
        ? windowsPrincipalMatches(task.triggerUser, principalObservation.value) &&
          windowsPrincipalMatches(task.principalUser, principalObservation.value)
        : null
    : null;
  const persistent = triStateAnd([taskPersistenceShape, taskPersistencePrincipal]);

  const processes = processObservation.known ? processObservation.value : null;
  const processTruth: RunnerTruth = processes === null ? null : processes.length === 1;

  const registrations = registrationObservation.known
    ? registrationObservation.value.filter((registration) => registration.name === RUNNER_NAME)
    : null;
  const uniqueRegistration = registrations?.length === 1 ? registrations[0]! : null;
  const registrationSingleton: RunnerTruth = registrations === null ? null : registrations.length === 1;
  const registrationMatchesRecord: RunnerTruth = registrations === null
    ? null
    : registrations.length !== 1
      ? false
      : !recordObservation.known || !configurationObservation.known
        ? null
        : record !== null &&
          configurationObservation.value !== null &&
          registrations[0]!.id === configurationObservation.value.agentId &&
          registrationMatchesCanonicalRecord(registrations[0]!, record);
  const online: RunnerTruth = registrations === null
    ? null
    : registrations.length === 0
      ? false
      : registrations.length > 1
        ? null
        : registrations[0]!.status === "online";

  const doctorOk: RunnerTruth = doctorObservation.known ? doctorObservation.value.ok : null;
  const launcherTruth: RunnerTruth = doctorObservation.known
    ? doctorObservation.value.launcher?.ok ?? false
    : null;

  const readiness: RunnerReadiness = {
    installed: triStateAnd([recordCanonical, provisioned, configured, repositoryBinding, updateDisabled]),
    registered: triStateAnd([
      recordCanonical,
      recordRegistered,
      recordHasRunnerId,
      registrationSingleton,
      registrationMatchesRecord,
    ]),
    enabled: triStateAnd([recordCanonical, recordEnabled, taskPresent, taskEnabled]),
    persistent,
    process: processTruth,
    online,
    launcherBinding: triStateAnd([recordLauncherCanonical, taskActionBinding, launcherTruth]),
  };

  if (recordObservation.known) {
    if (record === null) addIssue("runner record is missing");
    else if (!recordCanonical) addIssue("runner record is not canonical");
    else {
      if (!record.registered) addIssue("runner record is not marked registered");
      if (!record.enabled) addIssue("runner record is not marked enabled");
    }
  }
  if (provisioned === false) addIssue("runner software is not provisioned");
  if (configured === false) addIssue("runner is not configured");
  if (repositoryBinding === false) addIssue("runner configuration is not bound to the canonical repository");
  if (updateDisabled === false) addIssue("runner self-update is not disabled for the pinned build");
  if (registrations !== null) {
    if (registrations.length === 0) addIssue("canonical GitHub runner registration is missing");
    else if (registrations.length > 1) addIssue(`duplicate canonical GitHub runner registrations: ${registrations.length}`);
    else {
      if (registrationMatchesRecord === false) addIssue("canonical GitHub runner registration does not match the runner record");
      if (online === false) addIssue("canonical GitHub runner is offline");
    }
  }
  if (taskObservation.known) {
    if (task === null) addIssue(`scheduled task ${RUNNER_SCHEDULED_TASK} is missing`);
    else {
      if (!task.enabled) addIssue(`scheduled task ${RUNNER_SCHEDULED_TASK} is disabled`);
      if (taskActionBinding === false) addIssue("scheduled task is not bound to the canonical launcher");
      if (persistent === false) addIssue("scheduled task does not have canonical logon persistence");
    }
  }
  if (processes !== null) {
    if (processes.length === 0) addIssue("canonical runner process is not running");
    else if (processes.length > 1) addIssue(`duplicate runner processes: ${processes.length}`);
  }
  if (doctorObservation.known) {
    const observedDoctor = doctorObservation.value;
    if (!observedDoctor.ok) addIssue("canonical state doctor is unhealthy");
    if (observedDoctor.launcher === null) addIssue("canonical launcher check is missing");
    else if (!observedDoctor.launcher.ok) addIssue("canonical launcher binding is invalid");
  }

  let registrationStatus: "online" | "offline" | "busy" | "unknown" = "unknown";
  if (uniqueRegistration) {
    registrationStatus = uniqueRegistration.busy
      ? "busy"
      : uniqueRegistration.status === "online"
        ? "online"
        : "offline";
  }

  const allReady = Object.values(readiness).every((truth) => truth === true);
  const report: RunnerStatusReport = {
    ok: supported && allReady && doctorOk === true && issues.length === 0,
    name: RUNNER_NAME,
    repo: RUNNER_REPOSITORY,
    labels: [...RUNNER_LABELS],
    platform: deps.platform,
    supported,
    readiness,
    installed: readiness.installed === true,
    registered: readiness.registered === true,
    enabled: readiness.enabled === true,
    record: { present: recordPresent, canonical: recordCanonical },
    installation: {
      provisioned,
      configured,
      repositoryBinding,
      updateDisabled,
      version: versionObservation.known ? versionObservation.value : null,
    },
    persistence: {
      mechanism: "scheduled-task",
      name: RUNNER_SCHEDULED_TASK,
      path: RUNNER_SCHEDULED_TASK_PATH,
      present: taskPresent,
      state: taskObservation.known ? task?.state ?? null : null,
      enabled: taskEnabled,
      actionCount: taskObservation.known ? task?.actionCount ?? null : null,
      triggerCount: taskObservation.known ? task?.triggerCount ?? null : null,
      triggerKind: taskObservation.known ? task?.triggerKind ?? null : null,
      triggerUser: taskObservation.known ? task?.triggerUser ?? null : null,
      principalUser: taskObservation.known ? task?.principalUser ?? null : null,
      principalLogonType: taskObservation.known ? task?.principalLogonType ?? null : null,
      principalRunLevel: taskObservation.known ? task?.principalRunLevel ?? null : null,
      multipleInstances: taskObservation.known ? task?.multipleInstances ?? null : null,
      allowStartIfOnBatteries: taskObservation.known ? task?.allowStartIfOnBatteries ?? false : null,
      dontStopIfGoingOnBatteries: taskObservation.known ? task?.dontStopIfGoingOnBatteries ?? false : null,
      restartCount: taskObservation.known ? task?.restartCount ?? null : null,
      restartInterval: taskObservation.known ? task?.restartInterval ?? null : null,
      executionTimeLimit: taskObservation.known ? task?.executionTimeLimit ?? null : null,
      boundToLauncher: taskActionBinding,
    },
    process: {
      running: processTruth,
      instances: processes?.length ?? null,
      pids: processes?.map((process) => process.pid) ?? null,
    },
    registration: {
      id: uniqueRegistration?.id ?? null,
      os: uniqueRegistration?.os ?? null,
      labels: uniqueRegistration ? [...uniqueRegistration.labels] : null,
      status: registrationStatus,
      busy: uniqueRegistration?.busy ?? null,
      version: uniqueRegistration?.version ?? (versionObservation.known ? versionObservation.value : null),
      lastHeartbeat: uniqueRegistration?.lastHeartbeat ?? null,
      duplicates: registrations === null ? null : Math.max(0, registrations.length - 1),
    },
    binding: {
      launcher: canonicalLauncher,
      ok: readiness.launcherBinding,
      issues: doctorObservation.known ? launcherStatusIssues(doctorObservation.value.launcher) : [],
    },
    doctor: { ok: doctorOk },
    issues,
  };
  return redactRunnerOutput(report, redact);
}

// ---------------------------------------------------------------------------
// CLI adapter
// ---------------------------------------------------------------------------

const RUNNER_ACTIONS = new Set(["install", "enable", "disable", "status", "repair", "run"]);

function printActionResult(result: RunnerActionResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const status = result.ok ? (result.changed ? "ok" : "ok (no change)") : "FAILED";
  console.log(`${status} ${result.action}`);
  for (const [key, value] of Object.entries(result.details)) {
    console.log(`  ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
  }
  for (const issue of result.issues) console.error(`  ${issue}`);
}

function formatStatusTruth(value: RunnerTruth): string {
  return value === null ? "unknown" : String(value);
}

function formatStatusValue(value: string | number | null): string {
  return value === null ? "unknown" : String(value);
}

function formatStatusPids(value: number[] | null): string {
  if (value === null) return "unknown";
  return value.length === 0 ? "none" : value.join(",");
}

function printStatusReport(report: RunnerStatusReport, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`runner ${report.name} (${report.repo}) ${report.ok ? "ok" : "NOT HEALTHY"}`);
  console.log(`  installed:         ${formatStatusTruth(report.readiness.installed)}`);
  console.log(`  registered:        ${formatStatusTruth(report.readiness.registered)}`);
  console.log(`  enabled:           ${formatStatusTruth(report.readiness.enabled)}`);
  console.log(`  persistent:        ${formatStatusTruth(report.readiness.persistent)}`);
  console.log(`  process:           ${formatStatusTruth(report.readiness.process)}`);
  console.log(`  online:            ${formatStatusTruth(report.readiness.online)}`);
  console.log(`  launcherBinding:   ${formatStatusTruth(report.readiness.launcherBinding)}`);
  console.log(
    `  persistence: ${report.persistence.mechanism} ${report.persistence.path}${report.persistence.name} ` +
      `[${formatStatusValue(report.persistence.state)}] present=${formatStatusTruth(report.persistence.present)} ` +
      `enabled=${formatStatusTruth(report.persistence.enabled)} actions=${formatStatusValue(report.persistence.actionCount)} ` +
      `triggers=${formatStatusValue(report.persistence.triggerCount)} bound=${formatStatusTruth(report.persistence.boundToLauncher)}`,
  );
  console.log(
    `  process detail: running=${formatStatusTruth(report.process.running)} ` +
      `instances=${formatStatusValue(report.process.instances)} pids=${formatStatusPids(report.process.pids)}`,
  );
  console.log(
    `  registration: ${report.registration.status} duplicates=${formatStatusValue(report.registration.duplicates)} ` +
      `os=${formatStatusValue(report.registration.os)} ` +
      `labels=${report.registration.labels === null ? "unknown" : report.registration.labels.join(",")}`,
  );
  console.log(`  labels:      ${report.labels.join(", ")}`);
  console.log(`  doctor:      ${formatStatusTruth(report.doctor.ok)}`);
  console.log(`  binding:     ${formatStatusTruth(report.binding.ok)} ${report.binding.launcher}`);
  for (const issue of report.issues) console.error(`  ${issue}`);
}

export async function runnerCommand(rawArgs: string[]): Promise<void> {
  const [action = "status", ...rest] = rawArgs;
  const json = rest.includes("--json");
  if (!RUNNER_ACTIONS.has(action)) throw new Error(`unknown runner action: ${makeRedactor([])(action)}`);

  const state = sharedStateFromEnv(process.cwd());
  if (action === "status") {
    const report = await runnerStatus(state);
    printStatusReport(report, json);
    if (!report.ok) process.exitCode = 1;
    return;
  }

  const result =
    action === "install"
      ? await installRunner(state)
      : action === "enable"
        ? await enableRunner(state)
        : action === "disable"
          ? await disableRunner(state)
          : action === "repair"
            ? await repairRunner(state)
            : await runRunner(state);
  printActionResult(result, json);
  if (!result.ok) process.exitCode = 1;
}
