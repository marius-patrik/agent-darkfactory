import path from "node:path";
import { lstat, readFile, rm } from "node:fs/promises";
import type { SharedState } from "./state";
import { launcherNameForPlatform } from "./state-doctor";
import { currentWindowsPrincipal } from "./runner-lifecycle";
import { withStateFileLock } from "./state-lock";
import { writeTextAtomic } from "./state-v2";

export const SESSION_CAPTURE_TASK_NAME = "Andromeda-Session-Capture";
export const SESSION_CAPTURE_TASK_PATH = "\\";
export const SESSION_CAPTURE_INTERVAL = "PT5M";
export const SESSION_CAPTURE_EXECUTION_LIMIT = "PT4M";

export interface SessionCaptureTaskSpec {
  name: string;
  path: string;
  executable: string;
  arguments: string;
  principalUser: string;
  interval: string;
  executionLimit: string;
}

export interface SessionCaptureTaskInfo {
  name: string;
  path: string;
  enabled: boolean;
  actionCount: number;
  executable: string | null;
  arguments: string | null;
  triggerCount: number;
  interval: string | null;
  hidden: boolean;
  multipleInstances: string;
  principalUser: string;
  logonType: string;
  runLevel: string;
  executionLimit: string;
}

export interface SessionCaptureScheduler {
  query(): Promise<SessionCaptureTaskInfo | null>;
  install(spec: SessionCaptureTaskSpec): Promise<void>;
  uninstall(spec: SessionCaptureTaskSpec): Promise<void>;
}

export interface SessionCaptureLifecycleStatus {
  supported: boolean;
  installed: boolean;
  enabled: boolean;
  healthy: boolean;
  taskName: string;
  wrapperPath: string;
  interval: string;
  executionLimit: string;
  issues: string[];
}

export interface SessionCaptureLifecycleOptions {
  platform?: NodeJS.Platform;
  scheduler?: SessionCaptureScheduler;
  principal?: () => string;
  systemRoot?: string;
}

interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

function powerShellQuote(value: string): string {
  if (value.includes("\0")) throw new Error("scheduled session capture value contains NUL");
  return `'${value.replaceAll("'", "''")}'`;
}

function vbsQuote(value: string): string {
  if (value.includes("\0") || value.includes("\r") || value.includes("\n")) {
    throw new Error("scheduled session capture path is invalid");
  }
  return `"${value.replaceAll('"', '""')}"`;
}

function windowsSystemRoot(value = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows"): string {
  const resolved = path.win32.resolve(value);
  if (!path.win32.isAbsolute(resolved) || resolved.includes('"') || resolved.includes("\0")) {
    throw new Error("Windows SystemRoot is invalid");
  }
  return resolved;
}

export function sessionCaptureWrapperPath(state: SharedState): string {
  return path.join(state.stateDir, "runtime", "session-capture", "session-capture.vbs");
}

function sessionCaptureLauncherPath(state: SharedState): string {
  return path.join(state.stateDir, "bin", launcherNameForPlatform("win32"));
}

export function sessionCaptureWrapper(
  state: SharedState,
  systemRoot = windowsSystemRoot(),
): string {
  const powershell = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const launcher = sessionCaptureLauncherPath(state);
  const command = [
    `"${powershell}"`,
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-WindowStyle",
    "Hidden",
    "-File",
    `"${launcher}"`,
    "sessions",
    "ingest",
    "--json",
  ].join(" ");
  return [
    "Option Explicit",
    "Dim shell, command, exitCode",
    'Set shell = CreateObject("WScript.Shell")',
    `command = ${vbsQuote(command)}`,
    "exitCode = shell.Run(command, 0, True)",
    "WScript.Quit exitCode",
    "",
  ].join("\r\n");
}

export function buildSessionCaptureTaskSpec(
  state: SharedState,
  principalUser: string,
  systemRoot = windowsSystemRoot(),
): SessionCaptureTaskSpec {
  const wscript = path.win32.join(systemRoot, "System32", "wscript.exe");
  return {
    name: SESSION_CAPTURE_TASK_NAME,
    path: SESSION_CAPTURE_TASK_PATH,
    executable: wscript,
    arguments: `//B //Nologo "${sessionCaptureWrapperPath(state)}"`,
    principalUser,
    interval: SESSION_CAPTURE_INTERVAL,
    executionLimit: SESSION_CAPTURE_EXECUTION_LIMIT,
  };
}

async function runPowerShell(script: string, systemRoot = windowsSystemRoot()): Promise<ProcessResult> {
  const child = Bun.spawn(
    [
      path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-Command",
      script,
    ],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

function parseTaskInfo(value: unknown): SessionCaptureTaskInfo {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("scheduled session capture query returned malformed output");
  }
  const task = value as Record<string, unknown>;
  if (
    task.name !== SESSION_CAPTURE_TASK_NAME ||
    task.path !== SESSION_CAPTURE_TASK_PATH ||
    typeof task.enabled !== "boolean" ||
    !Number.isSafeInteger(task.actionCount) ||
    !Number.isSafeInteger(task.triggerCount) ||
    !(typeof task.executable === "string" || task.executable === null) ||
    !(typeof task.arguments === "string" || task.arguments === null) ||
    !(typeof task.interval === "string" || task.interval === null) ||
    typeof task.hidden !== "boolean" ||
    typeof task.multipleInstances !== "string" ||
    typeof task.principalUser !== "string" ||
    typeof task.logonType !== "string" ||
    typeof task.runLevel !== "string" ||
    typeof task.executionLimit !== "string"
  ) {
    throw new Error("scheduled session capture query returned malformed output");
  }
  return task as unknown as SessionCaptureTaskInfo;
}

export function createWindowsSessionCaptureScheduler(
  run: (script: string) => Promise<ProcessResult>,
): SessionCaptureScheduler {
  return {
    async query() {
      const script =
        `$ErrorActionPreference = 'Stop'; ` +
        `$tasks = @(Get-ScheduledTask -TaskName ${powerShellQuote(SESSION_CAPTURE_TASK_NAME)} ` +
        `-TaskPath ${powerShellQuote(SESSION_CAPTURE_TASK_PATH)} -ErrorAction SilentlyContinue); ` +
        `if ($tasks.Count -eq 0) { Write-Output '__MISSING__'; exit 0 }; ` +
        `if ($tasks.Count -ne 1) { throw 'scheduled session capture identity is ambiguous' }; ` +
        `$task = $tasks[0]; $actions = @($task.Actions); $triggers = @($task.Triggers); ` +
        `[pscustomobject]@{ name = [string]$task.TaskName; path = [string]$task.TaskPath; ` +
        `enabled = [bool]$task.Settings.Enabled; actionCount = [int]$actions.Count; ` +
        `executable = $(if ($actions.Count -eq 1) { [string]$actions[0].Execute } else { $null }); ` +
        `arguments = $(if ($actions.Count -eq 1) { [string]$actions[0].Arguments } else { $null }); ` +
        `triggerCount = [int]$triggers.Count; ` +
        `interval = $(if ($triggers.Count -eq 1) { [string]$triggers[0].Repetition.Interval } else { $null }); ` +
        `hidden = [bool]$task.Settings.Hidden; multipleInstances = [string]$task.Settings.MultipleInstances ` +
        `; principalUser = [string]$task.Principal.UserId; logonType = [string]$task.Principal.LogonType ` +
        `; runLevel = [string]$task.Principal.RunLevel ` +
        `; executionLimit = [string]$task.Settings.ExecutionTimeLimit ` +
        `} | ConvertTo-Json -Compress`;
      const result = await run(script);
      if (result.code !== 0) throw new Error(`scheduled session capture query failed: ${result.stderr.trim()}`);
      if (result.stdout.trim() === "__MISSING__") return null;
      try {
        return parseTaskInfo(JSON.parse(result.stdout));
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error("scheduled session capture query returned malformed output");
        throw error;
      }
    },
    async install(spec) {
      if (
        spec.name !== SESSION_CAPTURE_TASK_NAME ||
        spec.path !== SESSION_CAPTURE_TASK_PATH ||
        spec.interval !== SESSION_CAPTURE_INTERVAL ||
        spec.executionLimit !== SESSION_CAPTURE_EXECUTION_LIMIT
      ) {
        throw new Error("scheduled session capture identity is not canonical");
      }
      const script =
        `$ErrorActionPreference = 'Stop'; ` +
        `$action = New-ScheduledTaskAction -Execute ${powerShellQuote(spec.executable)} ` +
        `-Argument ${powerShellQuote(spec.arguments)}; ` +
        `$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) ` +
        `-RepetitionInterval (New-TimeSpan -Minutes 5); ` +
        `$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -Hidden ` +
        `-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable ` +
        `-ExecutionTimeLimit (New-TimeSpan -Minutes 4); ` +
        `$principal = New-ScheduledTaskPrincipal -UserId ${powerShellQuote(spec.principalUser)} ` +
        `-LogonType Interactive -RunLevel Limited; ` +
        `Register-ScheduledTask -TaskName ${powerShellQuote(spec.name)} -TaskPath ${powerShellQuote(spec.path)} ` +
        `-Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null`;
      const result = await run(script);
      if (result.code !== 0) throw new Error(`scheduled session capture install failed: ${result.stderr.trim()}`);
    },
    async uninstall(spec) {
      if (
        spec.name !== SESSION_CAPTURE_TASK_NAME ||
        spec.path !== SESSION_CAPTURE_TASK_PATH ||
        spec.interval !== SESSION_CAPTURE_INTERVAL ||
        spec.executionLimit !== SESSION_CAPTURE_EXECUTION_LIMIT
      ) {
        throw new Error("scheduled session capture identity is not canonical");
      }
      const script =
        `$ErrorActionPreference = 'Stop'; ` +
        `$tasks = @(Get-ScheduledTask -TaskName ${powerShellQuote(SESSION_CAPTURE_TASK_NAME)} ` +
        `-TaskPath ${powerShellQuote(SESSION_CAPTURE_TASK_PATH)} -ErrorAction SilentlyContinue); ` +
        `if ($tasks.Count -gt 1) { throw 'scheduled session capture identity is ambiguous' }; ` +
        `if ($tasks.Count -eq 1) { ` +
        `$task = $tasks[0]; $actions = @($task.Actions); $triggers = @($task.Triggers); ` +
        `if ($actions.Count -ne 1 -or -not ([string]$actions[0].Execute).Equals(` +
        `${powerShellQuote(spec.executable)}, [System.StringComparison]::OrdinalIgnoreCase)) ` +
        `{ throw 'scheduled session capture action ownership drifted' }; ` +
        `if ([string]$actions[0].Arguments -cne ${powerShellQuote(spec.arguments)}) ` +
        `{ throw 'scheduled session capture argument ownership drifted' }; ` +
        `if ($triggers.Count -ne 1 -or [string]$triggers[0].Repetition.Interval -cne ` +
        `${powerShellQuote(spec.interval)}) { throw 'scheduled session capture trigger ownership drifted' }; ` +
        `if (-not [bool]$task.Settings.Hidden -or [string]$task.Settings.MultipleInstances -cne 'IgnoreNew') ` +
        `{ throw 'scheduled session capture settings ownership drifted' }; ` +
        `if (-not ([string]$task.Principal.UserId).Equals(${powerShellQuote(spec.principalUser)}, ` +
        `[System.StringComparison]::OrdinalIgnoreCase) -or [string]$task.Principal.LogonType -cne 'Interactive' ` +
        `-or [string]$task.Principal.RunLevel -cne 'Limited') ` +
        `{ throw 'scheduled session capture principal ownership drifted' }; ` +
        `if ([string]$task.Settings.ExecutionTimeLimit -cne ${powerShellQuote(spec.executionLimit)}) ` +
        `{ throw 'scheduled session capture execution-limit ownership drifted' }; ` +
        `Unregister-ScheduledTask -TaskName ${powerShellQuote(SESSION_CAPTURE_TASK_NAME)} ` +
        `-TaskPath ${powerShellQuote(SESSION_CAPTURE_TASK_PATH)} -Confirm:$false }`;
      const result = await run(script);
      if (result.code !== 0) throw new Error(`scheduled session capture uninstall failed: ${result.stderr.trim()}`);
    },
  };
}

function windowsScheduler(systemRoot: string): SessionCaptureScheduler {
  return createWindowsSessionCaptureScheduler((script) => runPowerShell(script, systemRoot));
}

function sameWindowsPath(left: string | null, right: string): boolean {
  return left !== null && path.win32.resolve(left).toLowerCase() === path.win32.resolve(right).toLowerCase();
}

async function wrapperMatches(state: SharedState, systemRoot: string): Promise<boolean> {
  const wrapperPath = sessionCaptureWrapperPath(state);
  try {
    const info = await lstat(wrapperPath);
    if (!info.isFile() || info.isSymbolicLink()) return false;
    return (await readFile(wrapperPath, "utf8")) === sessionCaptureWrapper(state, systemRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function taskIssues(task: SessionCaptureTaskInfo | null, spec: SessionCaptureTaskSpec): string[] {
  if (!task) return ["scheduled capture task is not installed"];
  const issues: string[] = [];
  if (!task.enabled) issues.push("scheduled capture task is disabled");
  if (task.actionCount !== 1) issues.push("scheduled capture task must have exactly one action");
  if (!sameWindowsPath(task.executable, spec.executable)) issues.push("scheduled capture task is not bound to WScript");
  if (task.arguments !== spec.arguments) issues.push("scheduled capture task arguments drifted");
  if (task.triggerCount !== 1 || task.interval !== spec.interval) issues.push("scheduled capture interval drifted");
  if (!task.hidden) issues.push("scheduled capture task is not hidden");
  if (task.multipleInstances !== "IgnoreNew") issues.push("scheduled capture task permits overlapping instances");
  if (task.principalUser.toLowerCase() !== spec.principalUser.toLowerCase()) {
    issues.push("scheduled capture principal drifted");
  }
  if (task.logonType !== "Interactive") issues.push("scheduled capture task logon type drifted");
  if (task.runLevel !== "Limited") issues.push("scheduled capture task run level drifted");
  if (task.executionLimit !== spec.executionLimit) issues.push("scheduled capture execution limit drifted");
  return issues;
}

function taskOwnershipIssues(task: SessionCaptureTaskInfo, spec: SessionCaptureTaskSpec): string[] {
  return taskIssues(task, spec).filter((issue) => issue !== "scheduled capture task is disabled");
}

interface WrapperSnapshot {
  exists: boolean;
  content: string | null;
}

async function readWrapperSnapshot(state: SharedState): Promise<WrapperSnapshot> {
  const wrapperPath = sessionCaptureWrapperPath(state);
  try {
    const info = await lstat(wrapperPath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`hidden capture wrapper must be a physical regular file: ${wrapperPath}`);
    }
    return { exists: true, content: await readFile(wrapperPath, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, content: null };
    throw error;
  }
}

async function restoreWrapperAfterFailedInstall(
  state: SharedState,
  expectedContent: string,
  snapshot: WrapperSnapshot,
): Promise<void> {
  const wrapperPath = sessionCaptureWrapperPath(state);
  let current: string;
  try {
    const info = await lstat(wrapperPath);
    if (!info.isFile() || info.isSymbolicLink()) return;
    current = await readFile(wrapperPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  // Do not overwrite or remove a wrapper changed by another actor after this
  // invocation published its expected content.
  if (current !== expectedContent) return;
  if (snapshot.exists) {
    await writeTextAtomic(wrapperPath, snapshot.content!, 0o600);
  } else {
    await rm(wrapperPath, { force: true });
  }
}

export async function sessionCaptureStatus(
  state: SharedState,
  options: SessionCaptureLifecycleOptions = {},
): Promise<SessionCaptureLifecycleStatus> {
  const platform = options.platform ?? process.platform;
  const wrapperPath = sessionCaptureWrapperPath(state);
  if (platform !== "win32") {
    return {
      supported: false,
      installed: false,
      enabled: false,
      healthy: false,
      taskName: SESSION_CAPTURE_TASK_NAME,
      wrapperPath,
      interval: SESSION_CAPTURE_INTERVAL,
      executionLimit: SESSION_CAPTURE_EXECUTION_LIMIT,
      issues: ["automatic desktop session capture is supported only on Windows"],
    };
  }
  const systemRoot = options.systemRoot ?? windowsSystemRoot();
  const scheduler = options.scheduler ?? windowsScheduler(systemRoot);
  const principal = options.principal ?? currentWindowsPrincipal;
  const spec = buildSessionCaptureTaskSpec(state, principal(), systemRoot);
  const task = await scheduler.query();
  const issues = taskIssues(task, spec);
  if (!(await wrapperMatches(state, systemRoot))) issues.push("hidden capture wrapper is missing or drifted");
  return {
    supported: true,
    installed: task !== null,
    enabled: task?.enabled ?? false,
    healthy: issues.length === 0,
    taskName: SESSION_CAPTURE_TASK_NAME,
    wrapperPath,
    interval: SESSION_CAPTURE_INTERVAL,
    executionLimit: SESSION_CAPTURE_EXECUTION_LIMIT,
    issues,
  };
}

export async function installSessionCapture(
  state: SharedState,
  options: SessionCaptureLifecycleOptions = {},
): Promise<SessionCaptureLifecycleStatus> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") throw new Error("automatic desktop session capture is supported only on Windows");
  return withStateFileLock(state, "session-capture-lifecycle", async () => {
    const systemRoot = options.systemRoot ?? windowsSystemRoot();
    const launcher = sessionCaptureLauncherPath(state);
    const launcherInfo = await lstat(launcher);
    if (!launcherInfo.isFile() || launcherInfo.isSymbolicLink()) {
      throw new Error(`canonical Andromeda launcher must be a physical file: ${launcher}`);
    }
    const scheduler = options.scheduler ?? windowsScheduler(systemRoot);
    const principal = options.principal ?? currentWindowsPrincipal;
    const spec = buildSessionCaptureTaskSpec(state, principal(), systemRoot);
    const existing = await scheduler.query();
    if (existing) {
      const ownershipIssues = taskOwnershipIssues(existing, spec);
      if (ownershipIssues.length > 0) {
        throw new Error(
          `refusing to overwrite noncanonical scheduled session capture task: ${ownershipIssues.join("; ")}`,
        );
      }
      const existingIssues = taskIssues(existing, spec);
      if (existingIssues.length > 0) {
        throw new Error(
          `scheduled session capture task is owned but drifted; uninstall it before reinstalling: ${existingIssues.join("; ")}`,
        );
      }
    }

    const expectedWrapper = sessionCaptureWrapper(state, systemRoot);
    const wrapperSnapshot = await readWrapperSnapshot(state);
    let createdTask = false;
    try {
      await writeTextAtomic(sessionCaptureWrapperPath(state), expectedWrapper, 0o600);
      if (!existing) {
        await scheduler.install(spec);
        createdTask = true;
      }
      const status = await sessionCaptureStatus(state, { ...options, scheduler, principal, systemRoot });
      if (!status.healthy) throw new Error(`scheduled session capture postcondition failed: ${status.issues.join("; ")}`);
      return status;
    } catch (error) {
      const rollbackIssues: string[] = [];
      if (createdTask) {
        try {
          const installed = await scheduler.query();
          if (installed) {
            const ownershipIssues = taskOwnershipIssues(installed, spec);
            if (ownershipIssues.length === 0) await scheduler.uninstall(spec);
            else rollbackIssues.push(`created task drifted before rollback: ${ownershipIssues.join("; ")}`);
          }
        } catch (rollbackError) {
          rollbackIssues.push(`task rollback failed: ${(rollbackError as Error).message}`);
        }
      }
      try {
        await restoreWrapperAfterFailedInstall(state, expectedWrapper, wrapperSnapshot);
      } catch (rollbackError) {
        rollbackIssues.push(`wrapper rollback failed: ${(rollbackError as Error).message}`);
      }
      if (rollbackIssues.length > 0) {
        throw new Error(`${(error as Error).message}; rollback incomplete: ${rollbackIssues.join("; ")}`);
      }
      throw error;
    }
  });
}

export async function uninstallSessionCapture(
  state: SharedState,
  options: SessionCaptureLifecycleOptions = {},
): Promise<SessionCaptureLifecycleStatus> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") throw new Error("automatic desktop session capture is supported only on Windows");
  return withStateFileLock(state, "session-capture-lifecycle", async () => {
    const systemRoot = options.systemRoot ?? windowsSystemRoot();
    const scheduler = options.scheduler ?? windowsScheduler(systemRoot);
    const principal = options.principal ?? currentWindowsPrincipal;
    const spec = buildSessionCaptureTaskSpec(state, principal(), systemRoot);
    const task = await scheduler.query();
    if (task) {
      const ownershipIssues = taskOwnershipIssues(task, spec);
      if (ownershipIssues.length > 0) {
        throw new Error(
          `refusing to uninstall noncanonical scheduled session capture task: ${ownershipIssues.join("; ")}`,
        );
      }
      await scheduler.uninstall(spec);
    }
    const remaining = await scheduler.query();
    if (remaining !== null) throw new Error("scheduled session capture uninstall postcondition failed");
    await rm(sessionCaptureWrapperPath(state), { force: true });
    return {
      supported: true,
      installed: false,
      enabled: false,
      healthy: true,
      taskName: SESSION_CAPTURE_TASK_NAME,
      wrapperPath: sessionCaptureWrapperPath(state),
      interval: SESSION_CAPTURE_INTERVAL,
      executionLimit: SESSION_CAPTURE_EXECUTION_LIMIT,
      issues: [],
    };
  });
}
