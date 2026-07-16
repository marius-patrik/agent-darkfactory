import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { StateDoctorReport } from "../src/state-doctor";
import { ensureSharedState, sharedState, type SharedState } from "../src/state";
import { canonicalChildEnvironment } from "../src/runtime-paths";
import { validateSecretName } from "../src/secrets";
import {
  buildRunnerTaskSpec,
  createGitHubControlPlane,
  createWindowsRunnerHost,
  createWindowsScheduler,
  currentWindowsPrincipal,
  disableRunner,
  enableRunner,
  installRunner,
  readRunnerRecord,
  repairRunner,
  resetRunnerDeps,
  runRunner,
  runnerCommand,
  runnerInstallDir,
  runnerLauncherPath,
  runnerStatus,
  RUNNER_GITHUB_CREDENTIAL,
  RUNNER_LABELS,
  RUNNER_NAME,
  RUNNER_REPOSITORY,
  RUNNER_SCHEDULED_TASK,
  RUNNER_SCHEDULED_TASK_PATH,
  RUNNER_SOFTWARE,
  setRunnerDeps,
  taskHasCanonicalPersistence,
  taskMatchesSpec,
  windowsPowerShellExecutable,
  type RunnerDeps,
  type RunnerGitHub,
  type RunnerHost,
  type RunnerProcess,
  type RunnerRunHandle,
  type RunnerReadiness,
  type RunnerRecord,
  type RunnerRegistration,
  type RunnerScheduler,
  type ScheduledTaskIdentity,
  type ScheduledTaskInfo,
  type ScheduledTaskSpec,
} from "../src/runner-lifecycle";

const REGISTRATION_TOKEN = "ghr_FAKE_REGISTRATION_TOKEN_0123456789";
const UNRELATED_TASK = "ContosoBackupNightly";
const TEST_PRINCIPAL = "FABRIKAM\\runner-user";

test("runner GitHub credential is provisionable through the canonical secret-name contract", () => {
  expect(RUNNER_GITHUB_CREDENTIAL).toBe("GITHUB_TOKEN");
  expect(validateSecretName(RUNNER_GITHUB_CREDENTIAL)).toBe("GITHUB_TOKEN");
  expect(() => validateSecretName("github")).toThrow("invalid secret name");
});

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type DoctorCheckId = StateDoctorReport["checks"][number]["id"];

function makeDoctor(overrides: { ok?: boolean; launcherOk?: boolean; failId?: DoctorCheckId } = {}): StateDoctorReport {
  const launcherOk = overrides.launcherOk ?? overrides.ok ?? true;
  const checks: StateDoctorReport["checks"] = [
    { id: "state_root", ok: true, message: "canonical root is healthy" },
    { id: "launcher", ok: launcherOk, message: launcherOk ? "launcher bound" : "agents launcher is missing" },
  ];
  if (overrides.failId) checks.push({ id: overrides.failId, ok: false, message: `${overrides.failId} failed` });
  const everyOk = checks.every((check) => check.ok);
  return { ok: overrides.ok ?? everyOk, stateRoot: "C:\\fake\\.agents", checks, tools: [] };
}

interface HostState {
  provisioned: boolean;
  configured: boolean;
  instances: RunnerProcess[];
  version: string | null;
  configureError?: string;
  stopError?: string;
}

interface Kit {
  deps: RunnerDeps;
  tasks: Map<string, ScheduledTaskInfo>;
  serverRunners: RunnerRegistration[];
  hostState: HostState;
  schedulerCalls: string[];
  hostCalls: string[];
  githubCalls: string[];
  schedulerQueries: ScheduledTaskIdentity[];
  hostQueries: Array<{ operation: string; dir: string }>;
  githubQueries: string[];
  createdSpecs: ScheduledTaskSpec[];
  principalCalls: string[];
}

function taskInfo(overrides: Partial<ScheduledTaskInfo> & Pick<ScheduledTaskInfo, "name">): ScheduledTaskInfo {
  const { name, ...rest } = overrides;
  return {
    name,
    path: RUNNER_SCHEDULED_TASK_PATH,
    enabled: true,
    state: "Ready",
    actionCount: 1,
    actionExecutable: windowsPowerShellExecutable(),
    actionArguments: "",
    triggerCount: 1,
    triggerKind: "AtLogOn",
    triggerUser: TEST_PRINCIPAL,
    principalUser: TEST_PRINCIPAL,
    principalLogonType: "Interactive",
    principalRunLevel: "Limited",
    multipleInstances: "IgnoreNew",
    allowStartIfOnBatteries: true,
    dontStopIfGoingOnBatteries: true,
    restartCount: 3,
    restartInterval: "PT1M",
    executionTimeLimit: "PT0S",
    ...rest,
  };
}

function runnerProcess(pid: number, overrides: Partial<RunnerProcess> = {}): RunnerProcess {
  return {
    pid,
    executablePath: "C:\\fake\\.agents\\runner\\bin\\Runner.Listener.exe",
    startedAt: new Date(Date.UTC(2026, 6, 14, 10, 0, 0, pid)).toISOString(),
    ...overrides,
  };
}

function makeKit(options: {
  platform?: NodeJS.Platform;
  doctor?: StateDoctorReport;
  listRunnersError?: string;
  principal?: () => string;
} = {}): Kit {
  const tasks = new Map<string, ScheduledTaskInfo>();
  tasks.set(UNRELATED_TASK, taskInfo({
    name: UNRELATED_TASK,
    actionExecutable: "powershell.exe",
    actionArguments: `-File "C:\\Tools\\backup.ps1"`,
  }));
  const serverRunners: RunnerRegistration[] = [];
  const hostState: HostState = { provisioned: false, configured: false, instances: [], version: "2.335.1" };
  const schedulerCalls: string[] = [];
  const hostCalls: string[] = [];
  const githubCalls: string[] = [];
  const schedulerQueries: ScheduledTaskIdentity[] = [];
  const hostQueries: Array<{ operation: string; dir: string }> = [];
  const githubQueries: string[] = [];
  const createdSpecs: ScheduledTaskSpec[] = [];
  const principalCalls: string[] = [];
  let nextRunnerId = 500;

  const scheduler: RunnerScheduler = {
    async query(identity) {
      schedulerQueries.push({ name: identity.name, path: identity.path });
      const task = tasks.get(identity.name) ?? null;
      if (task && task.path !== identity.path) throw new Error("scheduled task query returned ambiguous identity");
      return task ? { ...task } : null;
    },
    async create(spec) {
      schedulerCalls.push(`create:${spec.name}`);
      createdSpecs.push({ ...spec });
      tasks.set(spec.name, taskInfo({
        name: spec.name,
        path: spec.path,
        actionExecutable: spec.executable,
        actionArguments: spec.arguments,
        triggerUser: spec.principalUser,
        principalUser: spec.principalUser,
      }));
    },
    async setEnabled(identity, enabled) {
      schedulerCalls.push(`setEnabled:${identity.name}:${enabled}`);
      const task = tasks.get(identity.name);
      if (task) {
        task.enabled = enabled;
        task.state = enabled ? "Ready" : "Disabled";
      }
    },
    async start(identity) {
      schedulerCalls.push(`start:${identity.name}`);
      const task = tasks.get(identity.name);
      if (task) task.state = "Running";
      if (task && hostState.instances.length === 0) hostState.instances.push(runnerProcess(6000));
    },
  };

  const github: RunnerGitHub = {
    async createRegistrationToken() {
      githubCalls.push("createRegistrationToken");
      return { token: REGISTRATION_TOKEN, expiresAt: new Date(Date.now() + 3600_000).toISOString() };
    },
    async listRunners(repo) {
      githubCalls.push("listRunners");
      githubQueries.push(repo);
      if (options.listRunnersError) throw new Error(options.listRunnersError);
      return serverRunners.map((runner) => ({ ...runner }));
    },
    async removeRunner(_repo, id) {
      githubCalls.push(`removeRunner:${id}`);
      const index = serverRunners.findIndex((runner) => runner.id === id);
      if (index >= 0) serverRunners.splice(index, 1);
    },
  };

  const host: RunnerHost = {
    async isProvisioned(dir) {
      hostQueries.push({ operation: "isProvisioned", dir });
      return hostState.provisioned;
    },
    async provision() {
      hostCalls.push("provision");
      hostState.provisioned = true;
    },
    async isConfigured(dir) {
      hostQueries.push({ operation: "isConfigured", dir });
      return hostState.configured;
    },
    async resetLocalConfiguration(dir) {
      hostCalls.push("resetLocalConfiguration");
      await rm(path.join(dir, ".runner"), { force: true });
      await rm(path.join(dir, ".credentials"), { force: true });
      hostState.configured = false;
    },
    async configure(dir, configureOptions) {
      hostCalls.push("configure");
      if (hostState.configureError) throw new Error(hostState.configureError.replace("{token}", configureOptions.token));
      const runnerId = nextRunnerId++;
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, ".runner"),
        `${JSON.stringify({
          agentId: runnerId,
          agentName: configureOptions.name,
          gitHubUrl: configureOptions.url,
          disableUpdate: true,
        })}\n`,
      );
      await writeFile(path.join(dir, ".credentials"), "fake credentials\n");
      hostState.configured = true;
      serverRunners.push({
        id: runnerId,
        name: configureOptions.name,
        os: "windows",
        status: "online",
        busy: false,
        labels: [...configureOptions.labels],
      });
    },
    async runnerVersion(dir) {
      hostQueries.push({ operation: "runnerVersion", dir });
      return hostState.version;
    },
    async runningInstances(dir) {
      hostQueries.push({ operation: "runningInstances", dir });
      return hostState.instances.map((instance) => ({ ...instance }));
    },
    async stopInstances(instances) {
      hostCalls.push(`stopInstances:${instances.map((instance) => instance.pid).join(",")}`);
      if (hostState.stopError) throw new Error(hostState.stopError);
      for (const instance of instances) {
        const index = hostState.instances.findIndex((candidate) => candidate.pid === instance.pid);
        if (index >= 0) hostState.instances.splice(index, 1);
      }
    },
    async run() {
      hostCalls.push("run");
      if (hostState.instances.length === 0) hostState.instances.push(runnerProcess(6000));
      const process = hostState.instances[0]!;
      return {
        process: { ...process },
        exited: Promise.resolve(0),
        async terminate() {
          hostCalls.push(`terminate:${process.pid}`);
          const index = hostState.instances.findIndex(
            (candidate) =>
              candidate.pid === process.pid &&
              candidate.executablePath.toLowerCase() === process.executablePath.toLowerCase() &&
              candidate.startedAt === process.startedAt,
          );
          if (index >= 0) hostState.instances.splice(index, 1);
        },
      };
    },
  };

  const doctorReport = options.doctor ?? makeDoctor();
  const deps: RunnerDeps = {
    platform: options.platform ?? "win32",
    now: () => new Date("2026-07-14T10:00:00.000Z"),
    doctor: async () => doctorReport,
    scheduler,
    github,
    host,
    principal: () => {
      principalCalls.push("principal");
      return (options.principal ?? (() => TEST_PRINCIPAL))();
    },
  };
  return {
    deps,
    tasks,
    serverRunners,
    hostState,
    schedulerCalls,
    hostCalls,
    githubCalls,
    schedulerQueries,
    hostQueries,
    githubQueries,
    createdSpecs,
    principalCalls,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const roots: string[] = [];

async function freshState(): Promise<{ root: string; state: SharedState }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agents-runner-"));
  roots.push(root);
  const state = sharedState(root);
  await ensureSharedState(state);
  return { root, state };
}

async function readAllText(dir: string): Promise<string> {
  let output = "";
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) output += await readAllText(full);
    else if (entry.isFile()) output += `\n${await readFile(full, "utf8").catch(() => "")}`;
  }
  return output;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch {
    return false;
  }
}

const TINY_RUNNER_ARCHIVE = Buffer.from("tiny-runner-archive");
const TINY_RUNNER_SOFTWARE = {
  version: "0.0.1-test",
  asset: "tiny-runner.zip",
  sha256: createHash("sha256").update(TINY_RUNNER_ARCHIVE).digest("hex"),
  sizeBytes: TINY_RUNNER_ARCHIVE.byteLength,
  url: "https://example.invalid/tiny-runner.zip",
};

function arrayBufferOf(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

function errno(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

function withHostOverrides(kit: Kit, overrides: Partial<RunnerHost>): RunnerDeps {
  return { ...kit.deps, host: { ...kit.deps.host!, ...overrides } };
}

function runnerStagingDir(installDir: string): string {
  return path.join(path.dirname(installDir), `.${path.basename(installDir)}.provisioning`);
}

async function writeExtractedRunner(stagingDir: string, missing?: string): Promise<void> {
  for (const relativePath of ["bin/Runner.Listener.exe", "bin/Runner.Worker.exe", "config.cmd", "run.cmd"]) {
    if (relativePath === missing) continue;
    const filePath = path.join(stagingDir, ...relativePath.split("/"));
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${relativePath}\n`);
  }
}

async function runPowerShellText(script: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(
    ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

beforeEach(() => {
  resetRunnerDeps();
});

afterEach(async () => {
  resetRunnerDeps();
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

test("runner status requests the canonical provisionable credential name exactly", async () => {
  const { state } = await freshState();
  const kit = makeKit();
  const requested: string[] = [];
  const report = await runnerStatus(state, {
    ...kit.deps,
    github: undefined,
    readCredential: async (_state, name) => {
      requested.push(name);
      throw new Error("credential unavailable");
    },
  });

  expect(requested).toEqual([RUNNER_GITHUB_CREDENTIAL]);
  expect(report.issues).toContain("GitHub runner observation failed");
});

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

describe("runner install", () => {
  test("fresh install provisions, registers, persists, and writes a canonical record", async () => {
    const { root, state } = await freshState();
    const kit = makeKit();

    const result = await installRunner(state, kit.deps);

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(kit.hostCalls).toContain("provision");
    expect(kit.hostCalls).toContain("configure");
    expect(kit.githubCalls).toContain("createRegistrationToken");
    expect(kit.schedulerCalls).toContain(`create:${RUNNER_SCHEDULED_TASK}`);

    const record = await readRunnerRecord(state);
    expect(record).not.toBeNull();
    expect(record!.name).toBe(RUNNER_NAME);
    expect(record!.repo).toBe(RUNNER_REPOSITORY);
    expect(record!.labels).toEqual([...RUNNER_LABELS]);
    expect(record!.registered).toBe(true);
    expect(record!.enabled).toBe(true);
    expect(record!.runnerId).toBe(kit.serverRunners[0]!.id);
    expect(record!.launcherPath).toBe(runnerLauncherPath(state, "win32"));

    const task = kit.tasks.get(RUNNER_SCHEDULED_TASK)!;
    const spec = buildRunnerTaskSpec(state, TEST_PRINCIPAL);
    expect(task.enabled).toBe(true);
    expect(task.actionExecutable).toBe(spec.executable);
    expect(task.actionArguments).toBe(spec.arguments);
    expect(task.state).toBe("Running");
    expect(kit.hostState.instances).toEqual([runnerProcess(6000)]);
    expect(root.length).toBeGreaterThan(0);
  });

  test("already healthy install is an idempotent no-op", async () => {
    const { state } = await freshState();
    const kit = makeKit();

    const first = await installRunner(state, kit.deps);
    expect(first.changed).toBe(true);
    const provisionCalls = kit.hostCalls.filter((call) => call === "provision").length;
    const tokenCalls = kit.githubCalls.filter((call) => call === "createRegistrationToken").length;

    const second = await installRunner(state, kit.deps);
    expect(second.ok).toBe(true);
    expect(second.changed).toBe(false);
    expect(kit.hostCalls.filter((call) => call === "provision").length).toBe(provisionCalls);
    expect(kit.githubCalls.filter((call) => call === "createRegistrationToken").length).toBe(tokenCalls);
    expect(kit.serverRunners.filter((runner) => runner.name === RUNNER_NAME)).toHaveLength(1);
  });

  test("install never mistakes duplicate local processes for a healthy no-op", async () => {
    const { state } = await freshState();
    const kit = makeKit();
    expect((await installRunner(state, kit.deps)).ok).toBe(true);
    kit.hostState.instances = [
      runnerProcess(12, { startedAt: "2026-07-14T10:00:00.000Z" }),
      runnerProcess(3, { startedAt: "2026-07-14T11:00:00.000Z" }),
    ];
    kit.hostCalls.length = 0;

    const result = await installRunner(state, kit.deps);

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(kit.hostCalls).toContain("stopInstances:3");
    expect(kit.hostState.instances.map((instance) => instance.pid)).toEqual([12]);
  });

  test("unhealthy canonical state doctor fails closed without mutating", async () => {
    const { state } = await freshState();
    const kit = makeKit({ doctor: makeDoctor({ ok: false, failId: "memory_integrity" }) });

    const result = await installRunner(state, kit.deps);

    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toMatch(/doctor is unhealthy/);
    expect(kit.hostCalls).not.toContain("provision");
    expect(kit.schedulerCalls).toHaveLength(0);
    expect(await readRunnerRecord(state)).toBeNull();
  });

  test("missing canonical launcher fails closed", async () => {
    const { state } = await freshState();
    const kit = makeKit({ doctor: makeDoctor({ ok: false, launcherOk: false }) });

    const result = await installRunner(state, kit.deps);

    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toMatch(/launcher/i);
    expect(kit.hostCalls).not.toContain("configure");
    expect(await readRunnerRecord(state)).toBeNull();
  });

  test("a malformed, inconsistent, or missing-launcher doctor can never authorize mutation", async () => {
    const cases: Array<[string, StateDoctorReport]> = [
      ["inconsistent aggregate", { ...makeDoctor(), ok: false }],
      ["missing launcher", {
        ...makeDoctor(),
        checks: [{ id: "state_root", ok: true, message: "canonical root is healthy" }],
      }],
      ["false launcher under a forged aggregate", { ...makeDoctor({ launcherOk: false }), ok: true }],
    ];

    for (const [label, doctor] of cases) {
      const { state } = await freshState();
      const kit = makeKit({ doctor });

      const result = await installRunner(state, kit.deps);

      expect(result.ok, label).toBe(false);
      expect(result.changed, label).toBe(false);
      expect(kit.hostCalls, label).toEqual([]);
      expect(kit.schedulerCalls, label).toEqual([]);
      expect(kit.githubCalls, label).toEqual([]);
    }
  });

  test("the complete install preflight must still have a healthy doctor", async () => {
    const { state } = await freshState();
    const kit = makeKit();
    let doctorCalls = 0;
    const deps: RunnerDeps = {
      ...kit.deps,
      doctor: async () => {
        doctorCalls += 1;
        return doctorCalls === 1 ? makeDoctor() : makeDoctor({ ok: false, failId: "memory_integrity" });
      },
    };

    const result = await installRunner(state, deps);

    expect(result.ok).toBe(false);
    expect(result.changed).toBe(false);
    expect(doctorCalls).toBe(2);
    expect(kit.hostCalls).toEqual([]);
    expect(kit.schedulerCalls).toEqual([]);
    expect(kit.githubCalls).toEqual(["listRunners"]);
  });

  test("unsupported platform fails closed with an actionable message", async () => {
    const { state } = await freshState();
    const kit = makeKit({ platform: "linux" });

    const result = await installRunner(state, kit.deps);

    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toMatch(/require Windows/);
    expect(kit.schedulerCalls).toHaveLength(0);
  });

  test("ambiguous ownership of an existing record fails closed", async () => {
    const { state } = await freshState();
    const kit = makeKit();
    const first = await installRunner(state, kit.deps);
    expect(first.ok).toBe(true);
    // Rewrite the record to point at a different repository (ambiguous ownership).
    const record = (await readRunnerRecord(state))!;
    await writeFile(path.join(state.stateDir, "runner.json"), `${JSON.stringify({ ...record, repo: "marius-patrik/other" }, null, 2)}\n`);

    const second = await installRunner(state, kit.deps);
    expect(second.ok).toBe(false);
    expect(second.issues.join(" ")).toMatch(/record is not canonical/);
  });

  test("concurrent installs serialize into one provision, registration, task, and record", async () => {
    const { state } = await freshState();
    const kit = makeKit();

    const [left, right] = await Promise.all([
      installRunner(state, kit.deps),
      installRunner(state, kit.deps),
    ]);

    expect(left.ok).toBe(true);
    expect(right.ok).toBe(true);
    expect([left.changed, right.changed].sort()).toEqual([false, true]);
    expect(kit.hostCalls.filter((call) => call === "provision")).toHaveLength(1);
    expect(kit.hostCalls.filter((call) => call === "configure")).toHaveLength(1);
    expect(kit.githubCalls.filter((call) => call === "createRegistrationToken")).toHaveLength(1);
    expect(kit.schedulerCalls.filter((call) => call === `create:${RUNNER_SCHEDULED_TASK}`)).toHaveLength(1);
    expect(kit.serverRunners).toHaveLength(1);
    expect((await readRunnerRecord(state))?.runnerId).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Enable / disable
// ---------------------------------------------------------------------------

describe("runner enable and disable", () => {
  test("enable starts the scheduled task and disable stops it, both idempotent", async () => {
    const { state } = await freshState();
    const kit = makeKit();
    await installRunner(state, kit.deps);

    const firstEnable = await enableRunner(state, kit.deps);
    expect(firstEnable.ok).toBe(true);
    expect(firstEnable.changed).toBe(false);
    expect(kit.tasks.get(RUNNER_SCHEDULED_TASK)!.state).toBe("Running");

    const secondEnable = await enableRunner(state, kit.deps);
    expect(secondEnable.ok).toBe(true);
    expect(secondEnable.changed).toBe(false);

    kit.hostState.instances = [runnerProcess(4242, { commandLine: "Runner.Listener.exe" })];
    const firstDisable = await disableRunner(state, kit.deps);
    expect(firstDisable.ok).toBe(true);
    expect(firstDisable.changed).toBe(true);
    expect(kit.tasks.get(RUNNER_SCHEDULED_TASK)!.enabled).toBe(false);
    expect(kit.hostState.instances).toHaveLength(0);
    expect((await readRunnerRecord(state))!.enabled).toBe(false);

    const secondDisable = await disableRunner(state, kit.deps);
    expect(secondDisable.ok).toBe(true);
    expect(secondDisable.changed).toBe(false);
  });

  test("enable fails closed when the runner was never installed", async () => {
    const { state } = await freshState();
    const kit = makeKit();

    const result = await enableRunner(state, kit.deps);

    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toMatch(/not installed/);
  });

  test("disable with no runner installed is a safe no-op", async () => {
    const { state } = await freshState();
    const kit = makeKit();

    const result = await disableRunner(state, kit.deps);

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(false);
  });

  test("enable removes stale registration rows, keeps the exact local ID, and collapses processes by creation time", async () => {
    const { state } = await freshState();
    const kit = makeKit();
    expect((await installRunner(state, kit.deps)).ok).toBe(true);
    expect((await disableRunner(state, kit.deps)).ok).toBe(true);
    kit.serverRunners.push({
      id: 900,
      name: RUNNER_NAME,
      os: "Windows",
      status: "offline",
      busy: false,
      labels: [...RUNNER_LABELS],
    });
    kit.hostState.instances = [
      runnerProcess(900, { startedAt: "2026-07-14T09:00:00.000Z" }),
      runnerProcess(1, { startedAt: "2026-07-14T10:00:00.000Z" }),
    ];
    kit.githubCalls.length = 0;
    kit.hostCalls.length = 0;
    kit.schedulerCalls.length = 0;

    const result = await enableRunner(state, kit.deps);

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(kit.githubCalls).toEqual(["listRunners", "removeRunner:900", "listRunners"]);
    expect(kit.hostCalls).toEqual(["stopInstances:1"]);
    expect(kit.hostState.instances.map((instance) => instance.pid)).toEqual([900]);
    expect(kit.schedulerCalls).toEqual([`setEnabled:${RUNNER_SCHEDULED_TASK}:true`]);
    expect((await readRunnerRecord(state))?.runnerId).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Repair
// ---------------------------------------------------------------------------

describe("runner repair", () => {
  test("repair collapses duplicate registrations and duplicate processes, and recreates a missing task", async () => {
    const { state } = await freshState();
    const kit = makeKit();
    await installRunner(state, kit.deps);

    // Introduce a duplicate server registration and a duplicate process; drop the task.
    kit.serverRunners.push({
      id: 900,
      name: RUNNER_NAME,
      os: "Windows",
      status: "offline",
      busy: false,
      labels: [...RUNNER_LABELS],
    });
    kit.hostState.instances = [
      runnerProcess(100, { commandLine: "Runner.Listener.exe" }),
      runnerProcess(200, { commandLine: "Runner.Listener.exe" }),
    ];
    kit.tasks.delete(RUNNER_SCHEDULED_TASK);

    const result = await repairRunner(state, kit.deps);

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    const repairs = JSON.stringify(result.details.repairs);
    expect(repairs).toMatch(/duplicate processes/);
    expect(repairs).toMatch(/duplicate registrations/);
    expect(repairs).toMatch(/created scheduled task/);
    expect(kit.hostState.instances).toHaveLength(1);
    expect(kit.serverRunners.filter((runner) => runner.name === RUNNER_NAME)).toHaveLength(1);
    const repairedTask = kit.tasks.get(RUNNER_SCHEDULED_TASK)!;
    const spec = buildRunnerTaskSpec(state, TEST_PRINCIPAL);
    expect(repairedTask.enabled).toBe(true);
    expect(repairedTask.actionExecutable).toBe(spec.executable);
    expect(repairedTask.actionArguments).toBe(spec.arguments);
  });

  test("repair re-registers when the local configuration is stale", async () => {
    const { state } = await freshState();
    const kit = makeKit();
    await installRunner(state, kit.deps);
    // Drop the local configuration but keep a server registration (stale local state).
    kit.hostState.configured = false;
    const configureCallsBefore = kit.hostCalls.filter((call) => call === "configure").length;
    const githubCallsBefore = kit.githubCalls.length;

    const result = await repairRunner(state, kit.deps);

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(kit.hostCalls).toContain("resetLocalConfiguration");
    expect(kit.hostCalls.filter((call) => call === "configure").length).toBeGreaterThan(configureCallsBefore);
    expect(kit.githubCalls.slice(githubCallsBefore)).toEqual([
      "listRunners",
      "createRegistrationToken",
      "listRunners",
      "removeRunner:500",
      "listRunners",
    ]);
    expect((await readRunnerRecord(state))!.registered).toBe(true);
    expect((await readRunnerRecord(state))!.runnerId).toBe(501);
  });

  test("repair reconverges a legacy runner whose upstream self-updater is enabled", async () => {
    const { state } = await freshState();
    const kit = makeKit();
    expect((await installRunner(state, kit.deps)).ok).toBe(true);
    const configPath = path.join(runnerInstallDir(state), ".runner");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    await writeFile(configPath, `${JSON.stringify({ ...config, disableUpdate: false })}\n`);
    kit.hostCalls.length = 0;

    const result = await repairRunner(state, kit.deps);

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(kit.hostCalls).toContain("resetLocalConfiguration");
    expect(kit.hostCalls).toContain("configure");
    expect(JSON.parse(await readFile(configPath, "utf8")).disableUpdate).toBe(true);
  });

  test("repair uses preflight rows for mutation but final readiness rejects a later control-plane identity change", async () => {
    const { state } = await freshState();
    const kit = makeKit();
    expect((await installRunner(state, kit.deps)).ok).toBe(true);
    kit.serverRunners.push({
      id: 900,
      name: RUNNER_NAME,
      os: "windows",
      status: "offline",
      busy: false,
      labels: [...RUNNER_LABELS],
    });
    kit.hostState.instances = [runnerProcess(100), runnerProcess(200)];
    kit.githubCalls.length = 0;
    kit.hostCalls.length = 0;
    kit.schedulerCalls.length = 0;
    const baseHost = kit.deps.host!;
    const deps = withHostOverrides(kit, {
      stopInstances: async (instances) => {
        await baseHost.stopInstances(instances);
        kit.serverRunners.splice(0, kit.serverRunners.length, {
          id: 999,
          name: RUNNER_NAME,
          os: "windows",
          status: "online",
          busy: false,
          labels: [...RUNNER_LABELS],
        });
      },
    });

    const result = await repairRunner(state, deps);

    expect(result.ok).toBe(false);
    expect(result.changed).toBe(true);
    expect(result.issues).toEqual(["GitHub runner registration changed during startup observation"]);
    expect(kit.githubCalls).toEqual(["listRunners", "removeRunner:900", "listRunners"]);
    expect(kit.hostCalls).toEqual(["stopInstances:200"]);
    expect(kit.serverRunners.map((runner) => runner.id)).toEqual([999]);
    expect((await readRunnerRecord(state))!.runnerId).toBe(500);
  });

  test("repair rebinds a scheduled task that drifted from the canonical launcher", async () => {
    const { state } = await freshState();
    const kit = makeKit();
    await installRunner(state, kit.deps);
    const drifted = kit.tasks.get(RUNNER_SCHEDULED_TASK)!;
    drifted.actionArguments = `-File "C:\\Not\\Canonical\\agents.ps1" runner run`;

    const result = await repairRunner(state, kit.deps);

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.details.repairs)).toMatch(/launcher/);
    const rebound = kit.tasks.get(RUNNER_SCHEDULED_TASK)!;
    const spec = buildRunnerTaskSpec(state, TEST_PRINCIPAL);
    expect(rebound.actionExecutable).toBe(spec.executable);
    expect(rebound.actionArguments).toBe(spec.arguments);
  });

  test("repair recreates a task whose duplicate-prevention or durability settings drifted", async () => {
    const { state } = await freshState();
    const kit = makeKit();
    expect((await installRunner(state, kit.deps)).ok).toBe(true);
    const task = kit.tasks.get(RUNNER_SCHEDULED_TASK)!;
    task.multipleInstances = "Parallel";
    task.restartCount = 0;
    kit.schedulerCalls.length = 0;

    const result = await repairRunner(state, kit.deps);

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(kit.schedulerCalls).toContain(`create:${RUNNER_SCHEDULED_TASK}`);
    expect(kit.tasks.get(RUNNER_SCHEDULED_TASK)).toMatchObject({
      multipleInstances: "IgnoreNew",
      restartCount: 3,
      restartInterval: "PT1M",
      executionTimeLimit: "PT0S",
    });
  });

  test("repair on a healthy runner is an idempotent no-op", async () => {
    const { state } = await freshState();
    const kit = makeKit();
    await installRunner(state, kit.deps);
    // Bring the task to a converged state.
    await enableRunner(state, kit.deps);
    const configureCalls = kit.hostCalls.filter((call) => call === "configure").length;

    const result = await repairRunner(state, kit.deps);

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(false);
    expect(kit.hostCalls.filter((call) => call === "configure").length).toBe(configureCalls);
  });

  test("repair keeps the exact configured ID instead of selecting a newer same-name row", async () => {
    const { state } = await freshState();
    const kit = makeKit();
    expect((await installRunner(state, kit.deps)).ok).toBe(true);
    kit.serverRunners[0]!.os = "Windows";
    kit.serverRunners.push({
      id: 999,
      name: RUNNER_NAME,
      os: "windows",
      status: "offline",
      busy: false,
      labels: [...RUNNER_LABELS],
    });
    await rewriteRunnerRecord(state, (record) => ({ ...record, runnerId: 998 }));
    kit.githubCalls.length = 0;

    const result = await repairRunner(state, kit.deps);

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(kit.githubCalls).toEqual(["listRunners", "removeRunner:999", "listRunners"]);
    expect(kit.serverRunners.map((registration) => registration.id)).toEqual([500]);
    expect((await readRunnerRecord(state))?.runnerId).toBe(500);
  });

  test("same-name noncanonical rows are ambiguous and never deleted", async () => {
    const { state } = await freshState();
    const kit = makeKit();
    expect((await installRunner(state, kit.deps)).ok).toBe(true);
    kit.serverRunners.push({
      id: 999,
      name: RUNNER_NAME,
      os: "Linux",
      status: "offline",
      busy: false,
      labels: [...RUNNER_LABELS],
    });
    kit.githubCalls.length = 0;

    const result = await repairRunner(state, kit.deps);

    expect(result.ok).toBe(false);
    expect(result.changed).toBe(false);
    expect(result.issues).toEqual(["same-name GitHub runner registration has an ambiguous noncanonical identity"]);
    expect(kit.githubCalls).toEqual(["listRunners"]);
    expect(kit.serverRunners.map((registration) => registration.id)).toEqual([500, 999]);
  });

  test("a same-name row cannot substitute for a missing exact local ID", async () => {
    const { state } = await freshState();
    const kit = makeKit();
    expect((await installRunner(state, kit.deps)).ok).toBe(true);
    kit.serverRunners.splice(0, kit.serverRunners.length, {
      id: 999,
      name: RUNNER_NAME,
      os: "Windows",
      status: "offline",
      busy: false,
      labels: [...RUNNER_LABELS],
    });
    kit.githubCalls.length = 0;
    kit.hostCalls.length = 0;

    const result = await repairRunner(state, kit.deps);

    expect(result.ok).toBe(false);
    expect(result.changed).toBe(false);
    expect(result.issues).toEqual([
      "same-name GitHub runner registration cannot be reconciled without the exact local ID",
    ]);
    expect(kit.githubCalls).toEqual(["listRunners"]);
    expect(kit.hostCalls).toEqual([]);
    expect(kit.serverRunners.map((registration) => registration.id)).toEqual([999]);
  });
});

describe("runner lifecycle start postconditions", () => {
  test("install, enable, and repair never trust stale Task Scheduler Running state without a Listener", async () => {
    for (const action of ["install", "enable", "repair"] as const) {
      const { state } = await freshState();
      const kit = makeKit();
      expect((await installRunner(state, kit.deps)).ok, action).toBe(true);
      kit.hostState.instances = [];
      kit.tasks.get(RUNNER_SCHEDULED_TASK)!.state = "Running";
      kit.schedulerCalls.length = 0;
      const baseScheduler = kit.deps.scheduler!;
      const scheduler: RunnerScheduler = {
        ...baseScheduler,
        async start(identity) {
          kit.schedulerCalls.push(`start:${identity.name}`);
          const task = kit.tasks.get(identity.name);
          if (task) task.state = "Running";
          // Deliberately never materialize Runner.Listener.exe.
        },
      };
      const deps: RunnerDeps = {
        ...kit.deps,
        scheduler,
        startObservationTimeoutMs: 20,
        startObservationIntervalMs: 2,
      };

      const result = action === "install"
        ? await installRunner(state, deps)
        : action === "enable"
          ? await enableRunner(state, deps)
          : await repairRunner(state, deps);

      expect(result.ok, action).toBe(false);
      expect(result.changed, action).toBe(true);
      expect(result.details.partialMutation, action).toBe(true);
      expect(result.issues, action).toEqual([
        "runner readiness postcondition timed out before one exact Listener and its sole registration were online",
      ]);
      expect(kit.schedulerCalls, action).toEqual([`start:${RUNNER_SCHEDULED_TASK}`]);
      expect(kit.hostState.instances, action).toEqual([]);
    }
  });

  test("install never reports success while an observed Listener registration remains offline", async () => {
    const { state } = await freshState();
    const kit = makeKit();
    expect((await installRunner(state, kit.deps)).ok).toBe(true);
    kit.serverRunners[0]!.status = "offline";

    const result = await installRunner(state, {
      ...kit.deps,
      startObservationTimeoutMs: 20,
      startObservationIntervalMs: 2,
    });

    expect(result.ok).toBe(false);
    expect(result.changed).toBe(true);
    expect(result.issues).toEqual([
      "runner readiness postcondition timed out before one exact Listener and its sole registration were online",
    ]);
  });

  test("an initially online registration that flips offline during start cannot satisfy the final conjunction", async () => {
    const { state } = await freshState();
    const kit = makeKit();
    expect((await installRunner(state, kit.deps)).ok).toBe(true);
    kit.hostState.instances = [];
    const scheduler: RunnerScheduler = {
      ...kit.deps.scheduler!,
      async start(identity) {
        const task = kit.tasks.get(identity.name);
        if (task) task.state = "Running";
        kit.hostState.instances.push(runnerProcess(6100));
        kit.serverRunners[0]!.status = "offline";
      },
    };

    const result = await installRunner(state, {
      ...kit.deps,
      scheduler,
      startObservationTimeoutMs: 25,
      startObservationIntervalMs: 2,
    });

    expect(result.ok).toBe(false);
    expect(result.changed).toBe(true);
    expect(result.issues).toEqual([
      "runner readiness postcondition timed out before one exact Listener and its sole registration were online",
    ]);
  });

  test("a Listener that exits while an offline registration becomes online cannot satisfy readiness", async () => {
    const { state } = await freshState();
    const kit = makeKit();
    expect((await installRunner(state, kit.deps)).ok).toBe(true);
    kit.hostState.instances = [];
    kit.serverRunners[0]!.status = "offline";
    const scheduler: RunnerScheduler = {
      ...kit.deps.scheduler!,
      async start(identity) {
        const task = kit.tasks.get(identity.name);
        if (task) task.state = "Running";
        kit.hostState.instances.push(runnerProcess(6200));
        setTimeout(() => { kit.hostState.instances = []; }, 5);
        setTimeout(() => { kit.serverRunners[0]!.status = "online"; }, 10);
      },
    };

    const result = await enableRunner(state, {
      ...kit.deps,
      scheduler,
      startObservationTimeoutMs: 30,
      startObservationIntervalMs: 2,
    });

    expect(result.ok).toBe(false);
    expect(result.changed).toBe(true);
    expect(result.issues).toEqual([
      "runner readiness postcondition timed out before one exact Listener and its sole registration were online",
    ]);
  });

  test("post-lock readiness is read-only when a second Listener appears after the locked preflight", async () => {
    const { state } = await freshState();
    const kit = makeKit();
    expect((await installRunner(state, kit.deps)).ok).toBe(true);
    const first = runnerProcess(6000);
    const second = runnerProcess(6001);
    let reads = 0;
    let stopCalls = 0;
    const deps = withHostOverrides(kit, {
      async runningInstances() {
        reads += 1;
        return reads === 1 ? [{ ...first }] : [{ ...first }, { ...second }];
      },
      async stopInstances() {
        stopCalls += 1;
      },
    });

    const result = await installRunner(state, {
      ...deps,
      startObservationTimeoutMs: 20,
      startObservationIntervalMs: 2,
    });

    expect(result.ok).toBe(false);
    expect(result.changed).toBe(false);
    expect(result.issues).toEqual([
      "runner readiness postcondition timed out before one exact Listener and its sole registration were online",
    ]);
    expect(stopCalls).toBe(0);
  });

  test("enable releases the lifecycle lock after committing enabled truth so its scheduled child can boot", async () => {
    const { state } = await freshState();
    const kit = makeKit();
    expect((await installRunner(state, kit.deps)).ok).toBe(true);
    expect((await disableRunner(state, kit.deps)).ok).toBe(true);
    let childPromise: Promise<Awaited<ReturnType<typeof runRunner>>> | null = null;
    let deps!: RunnerDeps;
    const scheduler: RunnerScheduler = {
      ...kit.deps.scheduler!,
      async start(identity) {
        const task = kit.tasks.get(identity.name);
        if (task) task.state = "Running";
        setTimeout(() => { childPromise = runRunner(state, deps); }, 0);
      },
    };
    deps = {
      ...kit.deps,
      scheduler,
      startObservationTimeoutMs: 500,
      startObservationIntervalMs: 2,
    };

    const enabled = await enableRunner(state, deps);
    for (let attempt = 0; attempt < 100 && childPromise === null; attempt += 1) await Bun.sleep(2);
    const child = childPromise === null ? null : await childPromise;

    expect(enabled.ok).toBe(true);
    expect((await readRunnerRecord(state))?.enabled).toBe(true);
    expect(child).toMatchObject({ ok: true, action: "run", details: { exitCode: 0 } });
    expect(kit.hostState.instances).toEqual([runnerProcess(6000)]);
  });
});

describe("local runner repository binding", () => {
  test("uses canonical gitHubUrl even when serverUrl is misleading and remains idempotent", async () => {
    const { state } = await freshState();
    const kit = makeKit();
    expect((await installRunner(state, kit.deps)).ok).toBe(true);
    await writeFile(
      path.join(state.stateDir, "runner", ".runner"),
      `${JSON.stringify({
        agentId: 500,
        agentName: RUNNER_NAME,
        gitHubUrl: `https://github.com/${RUNNER_REPOSITORY}`,
        disableUpdate: true,
        serverUrl: "https://github.com/marius-patrik/not-darkfactory",
      })}\n`,
    );

    const result = await installRunner(state, kit.deps);

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.details.note).toBe("runner already installed and healthy");
  });

  test("accepts the official Windows runner's single leading UTF-8 BOM", async () => {
    const { state } = await freshState();
    const kit = makeKit();
    expect((await installRunner(state, kit.deps)).ok).toBe(true);
    const configPath = path.join(state.stateDir, "runner", ".runner");
    const config = await readFile(configPath, "utf8");
    await writeFile(configPath, `\uFEFF${config}`);

    const result = await installRunner(state, kit.deps);

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.details.note).toBe("runner already installed and healthy");
  });

  test("treats a missing .runner as genuinely unconfigured and repairs it", async () => {
    const { state } = await freshState();
    const kit = makeKit();
    expect((await installRunner(state, kit.deps)).ok).toBe(true);
    const installDir = path.join(state.stateDir, "runner");
    await rm(path.join(installDir, ".runner"), { force: true });
    await rm(path.join(installDir, ".credentials"), { force: true });
    kit.hostState.configured = false;

    const result = await repairRunner(state, kit.deps);

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(await pathExists(path.join(installDir, ".runner"))).toBe(true);
  });

  const invalidRunnerConfigs: Array<[string, string]> = [
    ["malformed JSON", "{"],
    ["double leading BOM", `\uFEFF\uFEFF${JSON.stringify({ agentId: 500, agentName: RUNNER_NAME, gitHubUrl: `https://github.com/${RUNNER_REPOSITORY}` })}`],
    ["non-leading BOM", ` \uFEFF${JSON.stringify({ agentId: 500, agentName: RUNNER_NAME, gitHubUrl: `https://github.com/${RUNNER_REPOSITORY}` })}`],
    ["top-level null", "null"],
    ["top-level array", "[]"],
    ["top-level scalar", '"value"'],
    ["missing gitHubUrl", "{}"],
    ["serverUrl only", JSON.stringify({ serverUrl: `https://github.com/${RUNNER_REPOSITORY}` })],
    ["null gitHubUrl", JSON.stringify({ gitHubUrl: null })],
    ["empty gitHubUrl", JSON.stringify({ gitHubUrl: "" })],
    ["whitespace gitHubUrl", JSON.stringify({ gitHubUrl: "   " })],
    ["wrong-type gitHubUrl", JSON.stringify({ gitHubUrl: 42 })],
    [
      "wrong-type disableUpdate",
      JSON.stringify({
        agentId: 500,
        agentName: RUNNER_NAME,
        gitHubUrl: `https://github.com/${RUNNER_REPOSITORY}`,
        disableUpdate: "false",
      }),
    ],
    [
      "missing agentId",
      JSON.stringify({ agentName: RUNNER_NAME, gitHubUrl: `https://github.com/${RUNNER_REPOSITORY}` }),
    ],
    [
      "invalid agentId",
      JSON.stringify({ agentId: -1, agentName: RUNNER_NAME, gitHubUrl: `https://github.com/${RUNNER_REPOSITORY}` }),
    ],
    [
      "missing agentName",
      JSON.stringify({ agentId: 500, gitHubUrl: `https://github.com/${RUNNER_REPOSITORY}` }),
    ],
    [
      "empty agentName",
      JSON.stringify({ agentId: 500, agentName: "", gitHubUrl: `https://github.com/${RUNNER_REPOSITORY}` }),
    ],
  ];

  for (const [label, contents] of invalidRunnerConfigs) {
    test(`fails closed on malformed .runner: ${label}`, async () => {
      const { state } = await freshState();
      const kit = makeKit();
      expect((await installRunner(state, kit.deps)).ok).toBe(true);
      await writeFile(path.join(state.stateDir, "runner", ".runner"), contents);

      const result = await installRunner(state, kit.deps);

      expect(result.ok).toBe(false);
      expect(result.changed).toBe(false);
      expect(result.issues).toEqual(["runner configuration is malformed"]);
    });
  }

  test("maps non-ENOENT .runner read failures to a stable local error", async () => {
    const { state } = await freshState();
    const kit = makeKit();
    expect((await installRunner(state, kit.deps)).ok).toBe(true);
    const configPath = path.join(state.stateDir, "runner", ".runner");
    await rm(configPath, { force: true });
    await mkdir(configPath);

    const result = await installRunner(state, kit.deps);

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(["runner configuration read failed"]);
  });

  test("wrong-repository binding blocks install and repair before mutation", async () => {
    const { state } = await freshState();
    const kit = makeKit();
    expect((await installRunner(state, kit.deps)).ok).toBe(true);
    await writeFile(
      path.join(state.stateDir, "runner", ".runner"),
      `${JSON.stringify({
        agentId: 500,
        agentName: RUNNER_NAME,
        gitHubUrl: "https://github.com/marius-patrik/not-darkfactory",
        disableUpdate: true,
      })}\n`,
    );
    kit.hostState.provisioned = false;
    kit.hostState.instances = [runnerProcess(10), runnerProcess(20)];
    kit.serverRunners.push({
      id: 900,
      name: RUNNER_NAME,
      os: "windows",
      status: "offline",
      busy: false,
      labels: [...RUNNER_LABELS],
    });
    const task = kit.tasks.get(RUNNER_SCHEDULED_TASK)!;
    task.enabled = false;
    task.state = "Disabled";
    task.actionArguments = `${task.actionArguments} --drifted`;

    const recordBefore = await readRunnerRecord(state);
    const hostCallsBefore = [...kit.hostCalls];
    const schedulerCallsBefore = [...kit.schedulerCalls];
    const githubMutationsBefore = kit.githubCalls.filter((call) => call !== "listRunners");
    const processesBefore = kit.hostState.instances.map((instance) => ({ ...instance }));
    const registrationsBefore = kit.serverRunners.map((runner) => ({ ...runner, labels: [...runner.labels] }));
    const taskBefore = { ...task };

    const install = await installRunner(state, kit.deps);
    const repair = await repairRunner(state, kit.deps);

    expect(install.ok).toBe(false);
    expect(repair.ok).toBe(false);
    expect(install.issues.join(" ")).toMatch(/ambiguous ownership/);
    expect(repair.issues.join(" ")).toMatch(/ambiguous ownership/);
    expect(kit.hostCalls).toEqual(hostCallsBefore);
    expect(kit.schedulerCalls).toEqual(schedulerCallsBefore);
    expect(kit.githubCalls.filter((call) => call !== "listRunners")).toEqual(githubMutationsBefore);
    expect(kit.hostState.instances).toEqual(processesBefore);
    expect(kit.serverRunners).toEqual(registrationsBefore);
    expect(kit.tasks.get(RUNNER_SCHEDULED_TASK)).toEqual(taskBefore);
    expect(await readRunnerRecord(state)).toEqual(recordBefore);
  });

  test("record-owned paths, names, labels, repository, launcher, and task never redirect lifecycle actions", async () => {
    const cases: Array<{
      label: string;
      action: "install" | "enable" | "disable" | "repair" | "run";
      mutate: (record: RunnerRecord, alternate: string) => RunnerRecord;
    }> = [
      { label: "installDir", action: "install", mutate: (record, alternate) => ({ ...record, installDir: alternate }) },
      { label: "name", action: "enable", mutate: (record) => ({ ...record, name: "attacker-runner" }) },
      { label: "labels", action: "repair", mutate: (record) => ({ ...record, labels: ["self-hosted", "attacker"] }) },
      { label: "launcherPath", action: "disable", mutate: (record, alternate) => ({ ...record, launcherPath: alternate }) },
      { label: "scheduledTask", action: "run", mutate: (record) => ({ ...record, scheduledTask: "AttackerTask" }) },
      { label: "repo", action: "install", mutate: (record) => ({ ...record, repo: "attacker/repository" }) },
    ];

    for (const entry of cases) {
      const { root, state } = await freshState();
      const kit = makeKit();
      expect((await installRunner(state, kit.deps)).ok, entry.label).toBe(true);
      const alternate = path.join(root, "attacker-owned");
      await mkdir(alternate, { recursive: true });
      const marker = path.join(alternate, "must-survive.txt");
      await writeFile(marker, "preserve\n");
      const recordFile = path.join(state.stateDir, "runner.json");
      const record = JSON.parse(await readFile(recordFile, "utf8")) as RunnerRecord;
      await writeFile(recordFile, `${JSON.stringify(entry.mutate(record, alternate), null, 2)}\n`);
      kit.hostCalls.length = 0;
      kit.schedulerCalls.length = 0;
      kit.githubCalls.length = 0;
      kit.hostQueries.length = 0;

      const result = entry.action === "install"
        ? await installRunner(state, kit.deps)
        : entry.action === "enable"
          ? await enableRunner(state, kit.deps)
          : entry.action === "disable"
            ? await disableRunner(state, kit.deps)
            : entry.action === "repair"
              ? await repairRunner(state, kit.deps)
              : await runRunner(state, kit.deps);

      expect(result.ok, entry.label).toBe(false);
      expect(result.changed, entry.label).toBe(false);
      expect(result.issues, entry.label).toEqual([
        "runner record is not canonical; refusing to use record-owned paths or identity",
      ]);
      expect(kit.hostQueries.some((query) => query.dir === alternate), entry.label).toBe(false);
      expect(kit.hostCalls, entry.label).toEqual([]);
      expect(kit.schedulerCalls, entry.label).toEqual([]);
      expect(kit.githubCalls.filter((call) => call !== "listRunners"), entry.label).toEqual([]);
      expect(await readFile(marker, "utf8"), entry.label).toBe("preserve\n");
    }
  });
});

describe("Windows runner provisioning boundary", () => {
  test("keeps the production archive size pinned", () => {
    expect(RUNNER_SOFTWARE.sizeBytes).toBe(99_986_249);
  });

  test("configures an interactive runner without accidentally enabling the upstream Windows service flag", async () => {
    const calls: Array<{ argv: string[]; cwd?: string }> = [];
    const host = createWindowsRunnerHost({
      runProcess: async (argv, options) => {
        calls.push({ argv: [...argv], cwd: options?.cwd });
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const installDir = "C:\\canonical\\runner";

    await host.configure(installDir, {
      url: `https://github.com/${RUNNER_REPOSITORY}`,
      token: REGISTRATION_TOKEN,
      name: RUNNER_NAME,
      labels: [...RUNNER_LABELS],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.argv.slice(0, 2)).toEqual([
      path.join(installDir, "bin", "Runner.Listener.exe"),
      "configure",
    ]);
    expect(calls[0]!.argv).toContain("--unattended");
    expect(calls[0]!.argv).toContain("--replace");
    expect(calls[0]!.argv).toContain("--disableupdate");
    expect(calls[0]!.argv).not.toContain("--runasservice");
    expect(calls[0]!.cwd).toBe(installDir);
  });

  test("resets only local upstream configuration before stale-runner reconfiguration", async () => {
    const calls: Array<{ argv: string[]; cwd?: string; env?: Record<string, string | undefined> }> = [];
    const host = createWindowsRunnerHost({
      configurationLstat: async () => ({ isFile: () => true, isSymbolicLink: () => false }),
      runProcess: async (argv, options) => {
        calls.push({ argv: [...argv], cwd: options?.cwd, env: options?.env });
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const installDir = "C:\\canonical\\runner";

    await host.resetLocalConfiguration(installDir);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.argv).toEqual([
      path.join(installDir, "bin", "Runner.Listener.exe"),
      "remove",
      "--local",
    ]);
    expect(calls[0]!.argv).not.toContain("--token");
    expect(calls[0]!.cwd).toBe(installDir);
    expect(calls[0]!.env).toEqual(canonicalChildEnvironment());
  });

  test("fresh extracted runner skips local removal and proceeds directly to Listener configure", async () => {
    const calls: string[][] = [];
    const host = createWindowsRunnerHost({
      configurationLstat: async () => { throw errno("ENOENT", "not configured"); },
      runProcess: async (argv) => {
        calls.push([...argv]);
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const installDir = "C:\\canonical\\fresh-runner";

    await host.resetLocalConfiguration(installDir);
    await host.configure(installDir, {
      url: `https://github.com/${RUNNER_REPOSITORY}`,
      token: REGISTRATION_TOKEN,
      name: RUNNER_NAME,
      labels: [...RUNNER_LABELS],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 2)).toEqual([
      path.join(installDir, "bin", "Runner.Listener.exe"),
      "configure",
    ]);
    expect(calls[0]).not.toContain("remove");
  });

  test("partial, symlinked, or inaccessible local artifacts fail before Listener removal", async () => {
    const scenarios = [
      {
        label: "runner only",
        inspect: async (filePath: string) => {
          if (filePath.endsWith(".runner")) return { isFile: () => true, isSymbolicLink: () => false };
          throw errno("ENOENT", "missing credentials");
        },
        issue: "runner local configuration artifacts are partial or ambiguous",
      },
      {
        label: "credentials only",
        inspect: async (filePath: string) => {
          if (filePath.endsWith(".credentials")) return { isFile: () => true, isSymbolicLink: () => false };
          throw errno("ENOENT", "missing runner");
        },
        issue: "runner local configuration artifacts are partial or ambiguous",
      },
      {
        label: "symlinked runner",
        inspect: async (filePath: string) => ({
          isFile: () => true,
          isSymbolicLink: () => filePath.endsWith(".runner"),
        }),
        issue: "runner local configuration artifacts are partial or ambiguous",
      },
      {
        label: "inaccessible credentials",
        inspect: async (filePath: string) => {
          if (filePath.endsWith(".credentials")) throw errno("EACCES", "localized provider output");
          return { isFile: () => true, isSymbolicLink: () => false };
        },
        issue: "runner configuration inspection failed",
      },
    ];

    for (const scenario of scenarios) {
      const calls: string[][] = [];
      const host = createWindowsRunnerHost({
        configurationLstat: scenario.inspect,
        runProcess: async (argv) => {
          calls.push([...argv]);
          return { code: 0, stdout: "", stderr: "" };
        },
      });

      await expect(host.resetLocalConfiguration("C:\\canonical\\runner"), scenario.label).rejects.toThrow(
        scenario.issue,
      );
      expect(calls, scenario.label).toEqual([]);
    }
  });

  test("spawns the exact Listener and terminates only its PID plus executable plus creation identity", async () => {
    const installDir = "C:\\canonical\\runner";
    const executablePath = path.win32.join(installDir, "bin", "Runner.Listener.exe");
    const startedAt = "2026-07-15T12:34:56.789Z";
    const spawnCalls: Array<{ argv: string[]; cwd: string; env: Record<string, string | undefined> }> = [];
    const powerShellCalls: string[] = [];
    let terminated = false;
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
    const host = createWindowsRunnerHost({
      spawnRunner(argv, options) {
        spawnCalls.push({ argv: [...argv], cwd: options.cwd, env: { ...options.env } });
        return { pid: 8123, exited, kill: () => resolveExit(143) };
      },
      async runPowerShell(script) {
        powerShellCalls.push(script);
        if (script.includes("Where-Object")) {
          return {
            code: 0,
            stdout: terminated
              ? "[]"
              : JSON.stringify({
                  ProcessId: 8123,
                  ExecutablePath: executablePath,
                  CreationTime: startedAt,
                  CommandLine: `\"${executablePath}\" run`,
                }),
            stderr: "",
          };
        }
        terminated = true;
        resolveExit(143);
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const env = { AGENTS_HOME: "C:\\canonical\\.agents" };

    const handle = await host.run(installDir, env);
    await Promise.all([handle.terminate(), handle.terminate()]);

    expect(spawnCalls).toEqual([{ argv: [executablePath, "run"], cwd: installDir, env }]);
    expect(handle.process).toEqual({ pid: 8123, executablePath, startedAt, commandLine: `\"${executablePath}\" run` });
    const stopScripts = powerShellCalls.filter((script) => script.includes("Invoke-CimMethod"));
    expect(stopScripts).toHaveLength(1);
    expect(stopScripts[0]).toContain("ProcessId = 8123");
    expect(stopScripts[0]).toContain(executablePath.replace(/'/g, "''"));
    expect(stopScripts[0]).toContain(startedAt);
  });

  test("default host cleans a late Listener after ownership timeout even when child.exited never settles", async () => {
    const installDir = "C:\\canonical\\runner";
    const executablePath = path.win32.join(installDir, "bin", "Runner.Listener.exe");
    const startedAt = "2026-07-15T12:35:56.789Z";
    let visible = false;
    let stopped = false;
    let killCalls = 0;
    let stopCalls = 0;
    const lateVisibility = setTimeout(() => { visible = true; }, 15);
    const host = createWindowsRunnerHost({
      ownershipObservationTimeoutMs: 8,
      ownershipObservationIntervalMs: 2,
      terminationGraceMs: 80,
      spawnRunner() {
        return {
          pid: 8124,
          exited: new Promise<number>(() => undefined),
          kill: () => { killCalls += 1; },
        };
      },
      async runPowerShell(script) {
        if (script.includes("Where-Object")) {
          return {
            code: 0,
            stdout: visible && !stopped
              ? JSON.stringify({
                  ProcessId: 8124,
                  ExecutablePath: executablePath,
                  CreationTime: startedAt,
                  CommandLine: `\"${executablePath}\" run`,
                })
              : "[]",
            stderr: "",
          };
        }
        stopCalls += 1;
        stopped = true;
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    await expect(host.run(installDir, {})).rejects.toThrow(
      "runner host process ownership could not be established",
    );
    clearTimeout(lateVisibility);

    expect(killCalls).toBe(1);
    expect(stopCalls).toBe(1);
    expect(await host.runningInstances(installDir)).toEqual([]);
  });

  test("default host surfaces cleanup failure when neither child exit nor CIM absence can prove termination", async () => {
    let killCalls = 0;
    const host = createWindowsRunnerHost({
      ownershipObservationTimeoutMs: 4,
      ownershipObservationIntervalMs: 1,
      terminationGraceMs: 6,
      spawnRunner() {
        return {
          pid: 8125,
          exited: new Promise<number>(() => undefined),
          kill: () => { killCalls += 1; },
        };
      },
      runPowerShell: async () => { throw new Error("CIM unavailable"); },
    });

    await expect(host.run("C:\\canonical\\runner", {})).rejects.toThrow(
      "runner host ownership establishment failed and child cleanup did not complete",
    );
    expect(killCalls).toBe(1);
  });

  test("publishes only a complete verified runner and removes archive/staging leftovers", async () => {
    const { root } = await freshState();
    const installDir = path.join(root, "runner-host");
    const stagingDir = runnerStagingDir(installDir);
    const host = createWindowsRunnerHost({
      software: TINY_RUNNER_SOFTWARE,
      fetchAsset: async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => arrayBufferOf(TINY_RUNNER_ARCHIVE),
      }),
      runPowerShell: async () => {
        await writeExtractedRunner(stagingDir);
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    await host.provision(installDir);

    expect(await host.isProvisioned(installDir)).toBe(true);
    expect(await readFile(path.join(installDir, ".agents-runner-version"), "utf8")).toBe(
      `${TINY_RUNNER_SOFTWARE.version}\n`,
    );
    expect(await pathExists(path.join(installDir, TINY_RUNNER_SOFTWARE.asset))).toBe(false);
    expect(await pathExists(stagingDir)).toBe(false);
  });

  const failureScenarios = [
    { label: "fetch rejection", kind: "fetch", message: "runner download failed" },
    { label: "HTTP failure", kind: "http", message: "runner download failed with HTTP 503" },
    { label: "size mismatch", kind: "size", message: "runner archive size mismatch" },
    { label: "digest mismatch", kind: "digest", message: "runner archive sha256 mismatch" },
    { label: "extraction failure", kind: "extract", message: "runner extraction failed" },
    { label: "missing required file", kind: "missing", message: "runner extraction missing required file" },
  ] as const;

  for (const scenario of failureScenarios) {
    test(`cleans unpublished payload after ${scenario.label}`, async () => {
      const { root } = await freshState();
      const installDir = path.join(root, `runner-${scenario.kind}`);
      const stagingDir = runnerStagingDir(installDir);
      let extractionCalls = 0;
      const payload =
        scenario.kind === "size"
          ? Buffer.from("wrong-size")
          : scenario.kind === "digest"
            ? Buffer.alloc(TINY_RUNNER_ARCHIVE.byteLength, 120)
            : TINY_RUNNER_ARCHIVE;
      const host = createWindowsRunnerHost({
        software: TINY_RUNNER_SOFTWARE,
        fetchAsset: async () => {
          if (scenario.kind === "fetch") throw new Error("FETCH_SECRET_SENTINEL");
          return {
            ok: scenario.kind !== "http",
            status: scenario.kind === "http" ? 503 : 200,
            arrayBuffer: async () => arrayBufferOf(payload),
          };
        },
        runPowerShell: async () => {
          extractionCalls += 1;
          if (scenario.kind === "extract") return { code: 1, stdout: "", stderr: "EXTRACT_SECRET_SENTINEL" };
          await writeExtractedRunner(stagingDir, scenario.kind === "missing" ? "bin/Runner.Worker.exe" : undefined);
          return { code: 0, stdout: "", stderr: "" };
        },
      });

      const error = (await host.provision(installDir).catch((caught) => caught)) as Error;

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain(scenario.message);
      expect(error.message).not.toContain("SECRET_SENTINEL");
      expect(await pathExists(installDir)).toBe(false);
      expect(await pathExists(stagingDir)).toBe(false);
      if (["fetch", "http", "size", "digest"].includes(scenario.kind)) expect(extractionCalls).toBe(0);
    });
  }

  test("requires a trim-equivalent pinned marker and every physical runner file", async () => {
    const { root } = await freshState();
    const installDir = path.join(root, "runner-marker");
    const stagingDir = runnerStagingDir(installDir);
    const host = createWindowsRunnerHost({
      software: TINY_RUNNER_SOFTWARE,
      fetchAsset: async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => arrayBufferOf(TINY_RUNNER_ARCHIVE),
      }),
      runPowerShell: async () => {
        await writeExtractedRunner(stagingDir);
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await host.provision(installDir);

    const validMarkers = [
      TINY_RUNNER_SOFTWARE.version,
      `${TINY_RUNNER_SOFTWARE.version}\n`,
      `${TINY_RUNNER_SOFTWARE.version}\r\n`,
      ` \t${TINY_RUNNER_SOFTWARE.version}\r\n `,
    ];
    for (const marker of validMarkers) {
      await writeFile(path.join(installDir, ".agents-runner-version"), marker);
      expect(await host.isProvisioned(installDir)).toBe(true);
    }

    await writeFile(path.join(installDir, ".agents-runner-version"), "wrong-version\n");
    expect(await host.isProvisioned(installDir)).toBe(false);
    await rm(path.join(installDir, ".agents-runner-version"));
    expect(await host.isProvisioned(installDir)).toBe(false);

    await writeFile(path.join(installDir, ".agents-runner-version"), `${TINY_RUNNER_SOFTWARE.version}\n`);
    await rm(path.join(installDir, "bin", "Runner.Worker.exe"));
    expect(await host.isProvisioned(installDir)).toBe(false);
    await mkdir(path.join(installDir, "bin", "Runner.Worker.exe"));
    expect(await host.isProvisioned(installDir)).toBe(false);
    await rm(path.join(installDir, "bin", "Runner.Worker.exe"), { recursive: true });
    await writeFile(path.join(installDir, "bin", "Runner.Worker.exe"), "worker\n");
    await rm(path.join(installDir, ".agents-runner-version"));
    expect(await host.isProvisioned(installDir)).toBe(false);
  });

  test("distinguishes missing, non-file, and symlink software from an inaccessible inspection", async () => {
    const { root } = await freshState();
    const installDir = path.join(root, "runner-software-observation");
    await writeExtractedRunner(installDir);
    await writeFile(path.join(installDir, ".agents-runner-version"), `${TINY_RUNNER_SOFTWARE.version}\n`);
    const host = createWindowsRunnerHost({ software: TINY_RUNNER_SOFTWARE });
    expect(await host.isProvisioned(path.join(root, "positively-missing"))).toBe(false);
    expect(await host.isProvisioned(installDir)).toBe(true);

    const worker = path.join(installDir, "bin", "Runner.Worker.exe");
    const symlinkHost = createWindowsRunnerHost({
      software: TINY_RUNNER_SOFTWARE,
      lstat: async (filePath) =>
        filePath === worker
          ? { isFile: () => true, isSymbolicLink: () => true }
          : lstat(filePath),
    });
    expect(await symlinkHost.isProvisioned(installDir)).toBe(false);

    const sentinel = "EACCES_SOFTWARE_SENTINEL";
    const deniedHost = createWindowsRunnerHost({
      software: TINY_RUNNER_SOFTWARE,
      lstat: async (filePath) => {
        if (filePath === worker) throw errno("EACCES", sentinel);
        return lstat(filePath);
      },
    });
    const error = (await deniedHost.isProvisioned(installDir).catch((caught) => caught)) as Error;
    expect(error.message).toBe("runner software inspection failed");
    expect(error.message).not.toContain(sentinel);
    expect(error.message).not.toContain(installDir);
  });

  test("distinguishes missing and non-file configuration from an inaccessible inspection", async () => {
    const { root } = await freshState();
    const installDir = path.join(root, "runner-configuration-observation");
    const host = createWindowsRunnerHost();
    expect(await host.isConfigured(installDir)).toBe(false);
    await mkdir(installDir, { recursive: true });
    await writeFile(path.join(installDir, ".runner"), "{}\n");
    await mkdir(path.join(installDir, ".credentials"));
    expect(await host.isConfigured(installDir)).toBe(false);
    await rm(path.join(installDir, ".credentials"), { recursive: true });
    await writeFile(path.join(installDir, ".credentials"), "credentials\n");
    expect(await host.isConfigured(installDir)).toBe(true);

    const linkedConfigHost = createWindowsRunnerHost({
      configurationLstat: async (filePath) =>
        filePath.endsWith(".runner")
          ? { isFile: () => true, isSymbolicLink: () => true }
          : lstat(filePath),
    });
    expect(await linkedConfigHost.isConfigured(installDir)).toBe(false);

    const sentinel = "EACCES_CONFIGURATION_SENTINEL";
    const deniedHost = createWindowsRunnerHost({
      configurationLstat: async (filePath) => {
        if (filePath.endsWith(".credentials")) throw errno("EACCES", sentinel);
        return lstat(filePath);
      },
    });
    const error = (await deniedHost.isConfigured(installDir).catch((caught) => caught)) as Error;
    expect(error.message).toBe("runner configuration inspection failed");
    expect(error.message).not.toContain(sentinel);
    expect(error.message).not.toContain(installDir);
  });

  test("keeps version absence and empty content known while surfacing inaccessible reads", async () => {
    const { root } = await freshState();
    const installDir = path.join(root, "runner-version-observation");
    await writeExtractedRunner(installDir);
    const host = createWindowsRunnerHost({ software: TINY_RUNNER_SOFTWARE });
    expect(await host.runnerVersion(installDir)).toBeNull();
    await writeFile(path.join(installDir, ".agents-runner-version"), "  \r\n");
    expect(await host.runnerVersion(installDir)).toBeNull();
    expect(await host.isProvisioned(installDir)).toBe(false);
    await writeFile(path.join(installDir, ".agents-runner-version"), "older-version\n");
    expect(await host.runnerVersion(installDir)).toBe("older-version");
    expect(await host.isProvisioned(installDir)).toBe(false);

    const sentinel = "EACCES_VERSION_SENTINEL";
    const deniedHost = createWindowsRunnerHost({
      software: TINY_RUNNER_SOFTWARE,
      readFile: async (filePath, encoding) => {
        if (filePath.endsWith(".agents-runner-version")) throw errno("EACCES", sentinel);
        return readFile(filePath, encoding);
      },
    });
    for (const operation of [
      () => deniedHost.runnerVersion(installDir),
      () => deniedHost.isProvisioned(installDir),
    ]) {
      const error = (await operation().catch((caught) => caught)) as Error;
      expect(error.message).toBe("runner version inspection failed");
      expect(error.message).not.toContain(sentinel);
      expect(error.message).not.toContain(installDir);
    }
  });

  test("cleans staging when post-extraction software inspection is inaccessible", async () => {
    const { root } = await freshState();
    const installDir = path.join(root, "runner-inspection-cleanup");
    const stagingDir = runnerStagingDir(installDir);
    const sentinel = "EACCES_STAGING_SENTINEL";
    const host = createWindowsRunnerHost({
      software: TINY_RUNNER_SOFTWARE,
      fetchAsset: async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => arrayBufferOf(TINY_RUNNER_ARCHIVE),
      }),
      runPowerShell: async () => {
        await writeExtractedRunner(stagingDir);
        return { code: 0, stdout: "", stderr: "" };
      },
      lstat: async (filePath) => {
        if (filePath === path.join(stagingDir, "bin", "Runner.Worker.exe")) throw errno("EACCES", sentinel);
        return lstat(filePath);
      },
    });

    const error = (await host.provision(installDir).catch((caught) => caught)) as Error;

    expect(error.message).toBe("runner software inspection failed");
    expect(error.message).not.toContain(sentinel);
    expect(await pathExists(stagingDir)).toBe(false);
    expect(await pathExists(installDir)).toBe(false);
  });

  test("an extraction failure leaves the same location clean for a successful retry", async () => {
    const { root } = await freshState();
    const installDir = path.join(root, "runner-retry");
    const stagingDir = runnerStagingDir(installDir);
    let attempts = 0;
    const host = createWindowsRunnerHost({
      software: TINY_RUNNER_SOFTWARE,
      fetchAsset: async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => arrayBufferOf(TINY_RUNNER_ARCHIVE),
      }),
      runPowerShell: async () => {
        attempts += 1;
        if (attempts === 1) return { code: 1, stdout: "", stderr: "first extraction failed" };
        await writeExtractedRunner(stagingDir);
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    await mkdir(stagingDir, { recursive: true });
    await writeFile(path.join(stagingDir, "stale-stage.txt"), "stale\n");
    await mkdir(installDir, { recursive: true });
    await writeFile(path.join(installDir, TINY_RUNNER_SOFTWARE.asset), "stale archive\n");

    await expect(host.provision(installDir)).rejects.toThrow("runner extraction failed");
    expect(await pathExists(stagingDir)).toBe(false);
    expect(await pathExists(path.join(installDir, TINY_RUNNER_SOFTWARE.asset))).toBe(false);
    await host.provision(installDir);

    expect(attempts).toBe(2);
    expect(await host.isProvisioned(installDir)).toBe(true);
    expect(await pathExists(stagingDir)).toBe(false);
  });
});

describe("runner process query boundary", () => {
  test("normalizes blank, empty-array, singleton, and ordered multi-row successes without coercion", async () => {
    const listenerPath = "C:\\canonical\\runner\\bin\\Runner.Listener.exe";
    const firstStartedAt = "2026-07-14T10:00:00.009Z";
    const secondStartedAt = "2026-07-14T10:00:00.003Z";
    const cases: Array<{ label: string; stdout: string; expected: RunnerProcess[] }> = [
      { label: "blank", stdout: "  \r\n", expected: [] },
      { label: "empty array", stdout: "[]", expected: [] },
      {
        label: "singleton null command",
        stdout: JSON.stringify({
          ProcessId: 42,
          ExecutablePath: listenerPath,
          CreationTime: firstStartedAt,
          CommandLine: null,
        }),
        expected: [{ pid: 42, executablePath: listenerPath, startedAt: firstStartedAt }],
      },
      {
        label: "multiple rows",
        stdout: JSON.stringify([
          {
            ProcessId: 9,
            ExecutablePath: listenerPath,
            CreationTime: firstStartedAt,
            CommandLine: "Runner.Listener.exe --startuptype service",
          },
          { ProcessId: 3, ExecutablePath: listenerPath, CreationTime: secondStartedAt, CommandLine: "" },
        ]),
        expected: [
          {
            pid: 9,
            executablePath: listenerPath,
            startedAt: firstStartedAt,
            commandLine: "Runner.Listener.exe --startuptype service",
          },
          { pid: 3, executablePath: listenerPath, startedAt: secondStartedAt, commandLine: "" },
        ],
      },
    ];

    for (const entry of cases) {
      const scripts: string[] = [];
      const host = createWindowsRunnerHost({
        runPowerShell: async (script) => {
          scripts.push(script);
          return { code: 0, stdout: entry.stdout, stderr: "" };
        },
      });

      expect(await host.runningInstances("C:\\canonical\\runner"), entry.label).toEqual(entry.expected);
      expect(scripts, entry.label).toHaveLength(1);
      expect(scripts[0], entry.label).toContain("$ErrorActionPreference = 'Stop'");
      expect(scripts[0], entry.label).toContain("Runner.Listener.exe");
      expect(scripts[0], entry.label).not.toContain("-like");
    }
  });

  test("rejects every malformed root, row, field, mixed array, and duplicate PID as one fixed error", async () => {
    const malformed: Array<[string, string]> = [
      ["invalid JSON", "not-json RAW_PROCESS_PAYLOAD_SENTINEL"],
      ["null root", "null"],
      ["string root", '"row"'],
      ["number root", "1"],
      ["boolean root", "true"],
      ["array row", JSON.stringify([[1, null]])],
      ["null row", JSON.stringify([null])],
      ["missing ProcessId", JSON.stringify({ CommandLine: null })],
      ["string ProcessId", JSON.stringify({ ProcessId: "7", CommandLine: null })],
      ["fractional ProcessId", JSON.stringify({ ProcessId: 1.5, CommandLine: null })],
      ["zero ProcessId", JSON.stringify({ ProcessId: 0, CommandLine: null })],
      ["negative ProcessId", JSON.stringify({ ProcessId: -1, CommandLine: null })],
      ["unsafe ProcessId", JSON.stringify({ ProcessId: Number.MAX_SAFE_INTEGER + 1, CommandLine: null })],
      ["missing CommandLine", JSON.stringify({ ProcessId: 7 })],
      ["object CommandLine", JSON.stringify({ ProcessId: 7, CommandLine: {} })],
      ["array CommandLine", JSON.stringify({ ProcessId: 7, CommandLine: [] })],
      ["mixed valid and invalid", JSON.stringify([{ ProcessId: 7, CommandLine: null }, { ProcessId: "8", CommandLine: null }])],
      ["duplicate PIDs", JSON.stringify([{ ProcessId: 7, CommandLine: null }, { ProcessId: 7, CommandLine: "runner" }])],
    ];

    for (const [label, stdout] of malformed) {
      const host = createWindowsRunnerHost({
        runPowerShell: async () => ({ code: 0, stdout, stderr: "RAW_PROCESS_STDERR_SENTINEL" }),
      });
      const error = (await host.runningInstances("C:\\secret\\runner").catch((caught) => caught)) as Error;
      expect(error.message, label).toBe("runner process query returned malformed output");
      expect(error.message, label).not.toContain("SENTINEL");
      expect(error.message, label).not.toContain("C:\\secret\\runner");
    }
  });

  test("ignores a positively different listener path but fails closed when executable identity is inaccessible", async () => {
    const target = "C:\\canonical\\runner\\bin\\Runner.Listener.exe";
    const startedAt = "2026-07-14T10:00:00.000Z";
    const other = {
      ProcessId: 11,
      ExecutablePath: "C:\\other\\runner\\bin\\Runner.Listener.exe",
      CreationTime: startedAt,
      CommandLine: null,
    };
    const exact = { ProcessId: 12, ExecutablePath: target, CreationTime: startedAt, CommandLine: null };
    const host = createWindowsRunnerHost({
      runPowerShell: async () => ({ code: 0, stdout: JSON.stringify([other, exact]), stderr: "" }),
    });

    expect(await host.runningInstances("C:\\canonical\\runner")).toEqual([
      { pid: 12, executablePath: target, startedAt },
    ]);

    const uncertain = createWindowsRunnerHost({
      runPowerShell: async () => ({
        code: 0,
        stdout: JSON.stringify({ ...exact, ExecutablePath: null }),
        stderr: "",
      }),
    });
    await expect(uncertain.runningInstances("C:\\canonical\\runner")).rejects.toThrow(
      "runner process query returned malformed output",
    );
  });

  test("maps rejected and nonzero provider execution to one fixed query error", async () => {
    const sentinel = "RAW_PROCESS_PROVIDER_SENTINEL";
    const hosts = [
      createWindowsRunnerHost({
        runPowerShell: async () => {
          throw new Error(sentinel);
        },
      }),
      createWindowsRunnerHost({
        runPowerShell: async () => ({ code: 1, stdout: sentinel, stderr: sentinel }),
      }),
    ];

    for (const host of hosts) {
      const error = (await host.runningInstances("C:\\secret\\runner").catch((caught) => caught)) as Error;
      expect(error.message).toBe("runner process query failed");
      expect(error.message).not.toContain(sentinel);
      expect(error.message).not.toContain("C:\\secret\\runner");
    }
  });
});

describe("runner process stop boundary", () => {
  test("pins executable and creation identity before termination so PID reuse cannot kill another process", async () => {
    const scripts: string[] = [];
    const instance = runnerProcess(404, {
      executablePath: "C:\\canonical\\runner\\bin\\Runner.Listener.exe",
      startedAt: "2026-07-14T10:04:04.000Z",
    });
    const host = createWindowsRunnerHost({
      runPowerShell: async (script) => {
        scripts.push(script);
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    await host.stopInstances([instance]);

    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain(instance.executablePath);
    expect(scripts[0]).toContain(instance.startedAt);
    expect(scripts[0]).toContain("Invoke-CimMethod -InputObject $before[0] -MethodName Terminate");
    expect(scripts[0]).not.toContain("Stop-Process");
    expect(scripts[0]).not.toContain("return $null");
    expect(scripts[0]).toContain("if ($found.Count -eq 0) { return }");
  });

  test("captures nonterminating stop errors, verifies the postcondition, and stops serially", async () => {
    const scripts: string[] = [];
    const host = createWindowsRunnerHost({
      runPowerShell: async (script) => {
        scripts.push(script);
        return { code: 1, stdout: "RAW_STDOUT_SENTINEL", stderr: "RAW_STDERR_SENTINEL" };
      },
    });

    const error = (await host.stopInstances([runnerProcess(101), runnerProcess(202)]).catch((caught) => caught)) as Error;

    expect(error.message).toBe("failed to stop runner process 101");
    expect(error.message).not.toContain("SENTINEL");
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain("-ErrorVariable stopErr");
    expect(scripts[0]).toContain("$before = @(Get-RunnerProcess)");
    expect(scripts[0]).toContain("$after = @(Get-RunnerProcess)");
  });

  test("maps a rejected PowerShell stop to the stable process error without raw output", async () => {
    const sentinel = "RAW_REJECTION_SENTINEL_2b";
    let calls = 0;
    const host = createWindowsRunnerHost({
      runPowerShell: async () => {
        calls += 1;
        throw new Error(sentinel);
      },
    });

    const error = (await host.stopInstances([runnerProcess(303), runnerProcess(404)]).catch((caught) => caught)) as Error;

    expect(error.message).toBe("failed to stop runner process 303");
    expect(error.message).not.toContain(sentinel);
    expect(calls).toBe(1);
  });

  test.skipIf(process.platform !== "win32")(
    "success: real PowerShell observes exact termination and then no process output",
    async () => {
      const instance = runnerProcess(31337);
      const host = createWindowsRunnerHost({
        runPowerShell: async (script) => {
          const getProcess =
            `$script:runnerQueries = 0; ` +
            `function Get-CimInstance { [CmdletBinding()] param([string]$ClassName, [string]$Filter) ` +
            `$script:runnerQueries += 1; if ($script:runnerQueries -eq 1) { ` +
            `[pscustomobject]@{ ProcessId = 31337; ExecutablePath = ${psQuote(instance.executablePath)}; ` +
            `CreationDate = [datetime]::Parse(${psQuote(instance.startedAt)}) } } }`;
          const stopProcess =
            `function Invoke-CimMethod { [CmdletBinding()] param($InputObject, [string]$MethodName) ` +
            `[pscustomobject]@{ ReturnValue = 0 } }`;
          return runPowerShellText(`${getProcess}; ${stopProcess}; ${script}`);
        },
      });

      await expect(host.stopInstances([instance])).resolves.toBeUndefined();
    },
  );

  test.skipIf(process.platform !== "win32")(
    "edge-input: real PowerShell treats an already absent exact process as idempotent success",
    async () => {
      const host = createWindowsRunnerHost({
        runPowerShell: async (script) => {
          const getProcess =
            `function Get-CimInstance { [CmdletBinding()] param([string]$ClassName, [string]$Filter) return }`;
          const stopProcess =
            `function Invoke-CimMethod { throw 'termination must not be attempted for an absent process' }`;
          return runPowerShellText(`${getProcess}; ${stopProcess}; ${script}`);
        },
      });

      await expect(host.stopInstances([runnerProcess(31337)])).resolves.toBeUndefined();
    },
  );

  test.skipIf(process.platform !== "win32")(
    "denied-failure: real PowerShell maps a nonterminating stop denial to a stable redacted error",
    async () => {
      const instance = runnerProcess(31337);
      const sentinel = "STOP_ACCESS_DENIED_SENTINEL_2b";
      const host = createWindowsRunnerHost({
        runPowerShell: async (script) => {
          const getProcess =
            `function Get-CimInstance { [CmdletBinding()] param([string]$ClassName, [string]$Filter) ` +
            `[pscustomobject]@{ ProcessId = 31337; ExecutablePath = ${psQuote(instance.executablePath)}; ` +
            `CreationDate = [datetime]::Parse(${psQuote(instance.startedAt)}) } }`;
          const stopProcess =
            `function Invoke-CimMethod { [CmdletBinding()] param($InputObject, [string]$MethodName) ` +
            `Write-Error ${psQuote(sentinel)} -ErrorId AccessDenied -Category PermissionDenied -ErrorAction Continue }`;
          return runPowerShellText(`${getProcess}; ${stopProcess}; ${script}`);
        },
      });

      const error = (await host.stopInstances([instance]).catch((caught) => caught)) as Error;

      expect(error.message).toBe("failed to stop runner process 31337");
      expect(error.message).not.toContain(sentinel);
    },
  );

  test("disable and repair preserve process and record truth when stopping fails", async () => {
    const { state } = await freshState();
    const kit = makeKit();
    expect((await installRunner(state, kit.deps)).ok).toBe(true);
    const recordBefore = await readRunnerRecord(state);
    kit.hostState.instances = [runnerProcess(10), runnerProcess(20)];
    kit.hostState.stopError = "fake stop failure";

    const disable = await disableRunner(state, kit.deps);
    const repair = await repairRunner(state, kit.deps);

    expect(disable.ok).toBe(false);
    expect(disable.changed).toBe(true);
    expect(repair.ok).toBe(false);
    expect(repair.changed).toBe(true);
    expect(kit.hostState.instances).toEqual([runnerProcess(10), runnerProcess(20)]);
    expect(await readRunnerRecord(state)).toEqual(recordBefore);
  });
});

describe("mutation preflight observation barriers", () => {
  test("install performs zero mutation when software, configuration, or process observation is uncertain", async () => {
    const cases: Array<{ label: string; issue: string; overrides: Partial<RunnerHost> }> = [
      {
        label: "software",
        issue: "runner software inspection failed",
        overrides: { isProvisioned: async () => { throw new Error("runner software inspection failed"); } },
      },
      {
        label: "configuration",
        issue: "runner configuration inspection failed",
        overrides: { isConfigured: async () => { throw new Error("runner configuration inspection failed"); } },
      },
      {
        label: "process",
        issue: "runner process query failed",
        overrides: { runningInstances: async () => { throw new Error("runner process query failed"); } },
      },
    ];

    for (const entry of cases) {
      const { state } = await freshState();
      const kit = makeKit();
      const tasksBefore = [...kit.tasks.entries()].map(
        ([name, task]) => [name, { ...task }] as [string, ScheduledTaskInfo],
      );
      const result = await installRunner(state, withHostOverrides(kit, entry.overrides));

      expect(result.ok, entry.label).toBe(false);
      expect(result.changed, entry.label).toBe(false);
      expect(result.issues, entry.label).toEqual([entry.issue]);
      expect(kit.hostCalls, entry.label).toEqual([]);
      expect(kit.schedulerCalls, entry.label).toEqual([]);
      expect(kit.githubCalls.filter((call) => call !== "listRunners"), entry.label).toEqual([]);
      expect(kit.serverRunners, entry.label).toEqual([]);
      expect([...kit.tasks.entries()], entry.label).toEqual(tasksBefore);
      expect(await readRunnerRecord(state), entry.label).toBeNull();
    }
  });

  test("repair preserves record, tasks, registrations, and processes when any host preflight read is uncertain", async () => {
    const cases: Array<{ label: string; issue: string; overrides: Partial<RunnerHost> }> = [
      {
        label: "software",
        issue: "runner software inspection failed",
        overrides: { isProvisioned: async () => { throw new Error("runner software inspection failed"); } },
      },
      {
        label: "configuration",
        issue: "runner configuration inspection failed",
        overrides: { isConfigured: async () => { throw new Error("runner configuration inspection failed"); } },
      },
      {
        label: "process",
        issue: "runner process query failed",
        overrides: { runningInstances: async () => { throw new Error("runner process query failed"); } },
      },
    ];

    for (const entry of cases) {
      const { state } = await freshState();
      const kit = makeKit();
      expect((await installRunner(state, kit.deps)).ok).toBe(true);
      kit.serverRunners.push({ id: 900, name: RUNNER_NAME, os: "windows", status: "offline", busy: false, labels: [] });
      kit.hostState.instances = [runnerProcess(100), runnerProcess(200)];
      kit.tasks.delete(RUNNER_SCHEDULED_TASK);
      const recordFile = path.join(state.stateDir, "runner.json");
      const recordBefore = await readFile(recordFile, "utf8");
      const tasksBefore = [...kit.tasks.entries()].map(
        ([name, task]) => [name, { ...task }] as [string, ScheduledTaskInfo],
      );
      const registrationsBefore = kit.serverRunners.map((runner) => ({ ...runner, labels: [...runner.labels] }));
      const processesBefore = kit.hostState.instances.map((instance) => ({ ...instance }));
      const hostCallsBefore = [...kit.hostCalls];
      const schedulerCallsBefore = [...kit.schedulerCalls];
      const githubMutationsBefore = kit.githubCalls.filter((call) => call !== "listRunners");

      const result = await repairRunner(state, withHostOverrides(kit, entry.overrides));

      expect(result.ok, entry.label).toBe(false);
      expect(result.changed, entry.label).toBe(false);
      expect(result.issues, entry.label).toEqual([entry.issue]);
      expect(await readFile(recordFile, "utf8"), entry.label).toBe(recordBefore);
      expect([...kit.tasks.entries()], entry.label).toEqual(tasksBefore);
      expect(kit.serverRunners, entry.label).toEqual(registrationsBefore);
      expect(kit.hostState.instances, entry.label).toEqual(processesBefore);
      expect(kit.hostCalls, entry.label).toEqual(hostCallsBefore);
      expect(kit.schedulerCalls, entry.label).toEqual(schedulerCallsBefore);
      expect(kit.githubCalls.filter((call) => call !== "listRunners"), entry.label).toEqual(githubMutationsBefore);
    }
  });

  test("disable settles task and process reads before mutating either state or the record", async () => {
    for (const failure of ["task", "process"] as const) {
      const { state } = await freshState();
      const kit = makeKit();
      expect((await installRunner(state, kit.deps)).ok).toBe(true);
      kit.hostState.instances = [runnerProcess(77)];
      const taskBefore = { ...kit.tasks.get(RUNNER_SCHEDULED_TASK)! };
      const recordFile = path.join(state.stateDir, "runner.json");
      const recordBefore = await readFile(recordFile, "utf8");
      const hostCallsBefore = [...kit.hostCalls];
      const schedulerCallsBefore = [...kit.schedulerCalls];
      const deps: RunnerDeps =
        failure === "process"
          ? withHostOverrides(kit, { runningInstances: async () => { throw new Error("runner process query failed"); } })
          : {
              ...kit.deps,
              scheduler: {
                ...kit.deps.scheduler!,
                query: async () => { throw new Error("scheduled task query failed"); },
              },
            };

      const result = await disableRunner(state, deps);

      expect(result.ok, failure).toBe(false);
      expect(result.changed, failure).toBe(false);
      expect(kit.tasks.get(RUNNER_SCHEDULED_TASK), failure).toEqual(taskBefore);
      expect(kit.hostState.instances, failure).toEqual([runnerProcess(77)]);
      expect(await readFile(recordFile, "utf8"), failure).toBe(recordBefore);
      expect(kit.hostCalls, failure).toEqual(hostCallsBefore);
      expect(kit.schedulerCalls, failure).toEqual(schedulerCallsBefore);
    }
  });

  test("disable validates every observed process identity before disabling the task", async () => {
    const { state } = await freshState();
    const kit = makeKit();
    expect((await installRunner(state, kit.deps)).ok).toBe(true);
    kit.schedulerCalls.length = 0;
    const malformed = { ...runnerProcess(77), startedAt: "not-an-iso-time" };

    const result = await disableRunner(
      state,
      withHostOverrides(kit, { runningInstances: async () => [malformed] }),
    );

    expect(result.ok).toBe(false);
    expect(result.changed).toBe(false);
    expect(result.issues).toEqual(["runner process observation returned an invalid identity"]);
    expect(kit.schedulerCalls).toEqual([]);
    expect(kit.tasks.get(RUNNER_SCHEDULED_TASK)?.enabled).toBe(true);
  });

  test("run never starts the host when its process observation is uncertain", async () => {
    const { state } = await freshState();
    const kit = makeKit();
    expect((await installRunner(state, kit.deps)).ok).toBe(true);
    const hostCallsBefore = [...kit.hostCalls];

    const result = await runRunner(
      state,
      withHostOverrides(kit, { runningInstances: async () => { throw new Error("runner process query failed"); } }),
    );

    expect(result.ok).toBe(false);
    expect(result.changed).toBe(false);
    expect(result.issues).toEqual(["runner process query failed"]);
    expect(kit.hostCalls).toEqual(hostCallsBefore);
    expect(kit.hostCalls).not.toContain("run");
  });
});

describe("scheduled task mutation barriers", () => {
  test("install refuses an existing extra-cardinality task before host, GitHub, scheduler, or record mutation", async () => {
    const { state } = await freshState();
    const kit = makeKit();
    const spec = buildRunnerTaskSpec(state, TEST_PRINCIPAL);
    kit.tasks.set(RUNNER_SCHEDULED_TASK, taskInfo({
      name: RUNNER_SCHEDULED_TASK,
      actionCount: 2,
      actionExecutable: null,
      actionArguments: null,
      triggerCount: 1,
      triggerKind: "AtLogOn",
      triggerUser: TEST_PRINCIPAL,
      principalUser: TEST_PRINCIPAL,
    }));

    const result = await installRunner(state, kit.deps);

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      "scheduled task has extra actions or triggers; refusing automatic install replacement",
    ]);
    expect(kit.principalCalls).toEqual(["principal"]);
    expect(kit.hostCalls).toEqual([]);
    expect(kit.schedulerCalls).toEqual([]);
    expect(kit.githubCalls.filter((call) => call !== "listRunners")).toEqual([]);
    expect(await readRunnerRecord(state)).toBeNull();
    expect(spec.name).toBe(RUNNER_SCHEDULED_TASK);
  });

  test("enable resolves the principal once and accepts case-only provider identity differences", async () => {
    let phase: "install" | "enable" = "install";
    let enableResolutions = 0;
    const resolved = "CONTOSO\\RunnerUser";
    const kit = makeKit({
      principal: () => {
        if (phase === "install") return TEST_PRINCIPAL;
        enableResolutions += 1;
        return enableResolutions === 1 ? resolved : "CONTOSO\\UnexpectedSecondResolution";
      },
    });
    const { state } = await freshState();
    expect((await installRunner(state, kit.deps)).ok).toBe(true);
    const task = kit.tasks.get(RUNNER_SCHEDULED_TASK)!;
    task.triggerUser = resolved.toLowerCase();
    task.principalUser = resolved.toUpperCase();
    task.state = "Ready";
    phase = "enable";
    kit.principalCalls.length = 0;
    kit.schedulerCalls.length = 0;

    const result = await enableRunner(state, kit.deps);

    expect(result.ok).toBe(true);
    expect(enableResolutions).toBe(1);
    expect(kit.principalCalls).toEqual(["principal"]);
    expect(kit.schedulerCalls).toEqual([]);
  });

  test("enable performs zero mutation for missing, drifted, extra, ambiguous, uncertain, or unresolved task evidence", async () => {
    const scenarios: Array<{
      label: string;
      expectedIssue: string;
      mutateTask?: (task: ScheduledTaskInfo) => void;
      query?: "missing" | "duplicate" | "provider" | "malformed";
      principalFailure?: boolean;
    }> = [
      { label: "missing", expectedIssue: `scheduled task ${RUNNER_SCHEDULED_TASK} is missing; run \`agents runner repair\``, query: "missing" },
      {
        label: "drifted action",
        expectedIssue: `scheduled task ${RUNNER_SCHEDULED_TASK} does not have the canonical definition; run \`agents runner repair\``,
        mutateTask: (task) => { task.actionExecutable = "cmd.exe"; },
      },
      {
        label: "extra action",
        expectedIssue: `scheduled task ${RUNNER_SCHEDULED_TASK} does not have the canonical definition; run \`agents runner repair\``,
        mutateTask: (task) => { task.actionCount = 2; task.actionExecutable = null; task.actionArguments = null; },
      },
      {
        label: "extra trigger",
        expectedIssue: `scheduled task ${RUNNER_SCHEDULED_TASK} does not have the canonical definition; run \`agents runner repair\``,
        mutateTask: (task) => { task.triggerCount = 2; task.triggerKind = null; task.triggerUser = null; },
      },
      {
        label: "duplicate identity",
        expectedIssue: "scheduled task query returned ambiguous identity",
        query: "duplicate",
      },
      {
        label: "wrong path",
        expectedIssue: "scheduled task query returned ambiguous identity",
        mutateTask: (task) => { task.path = "\\Vendor\\"; },
      },
      { label: "provider failure", expectedIssue: "scheduled task query failed", query: "provider" },
      { label: "malformed provider", expectedIssue: "scheduled task query returned malformed output", query: "malformed" },
      {
        label: "principal failure",
        expectedIssue: "unable to determine current Windows principal from runtime environment",
        principalFailure: true,
      },
    ];

    for (const scenario of scenarios) {
      const { state } = await freshState();
      const kit = makeKit();
      expect((await installRunner(state, kit.deps)).ok, scenario.label).toBe(true);
      const task = kit.tasks.get(RUNNER_SCHEDULED_TASK)!;
      scenario.mutateTask?.(task);
      const recordFile = path.join(state.stateDir, "runner.json");
      const recordBefore = await readFile(recordFile, "utf8");
      const tasksBefore = [...kit.tasks.entries()].map(
        ([name, value]) => [name, { ...value }] as [string, ScheduledTaskInfo],
      );
      kit.schedulerCalls.length = 0;
      const scheduler = kit.deps.scheduler!;
      const deps: RunnerDeps = {
        ...kit.deps,
        principal: scenario.principalFailure
          ? () => { throw new Error("RAW_PRINCIPAL_SENTINEL"); }
          : kit.deps.principal,
        scheduler: scenario.query
          ? {
              ...scheduler,
              query: async () => {
                if (scenario.query === "missing") return null;
                if (scenario.query === "duplicate") throw new Error("scheduled task query returned ambiguous identity");
                if (scenario.query === "provider") throw new Error("scheduled task query failed");
                throw new Error("scheduled task query returned malformed output");
              },
            }
          : scheduler,
      };

      const result = await enableRunner(state, deps);

      expect(result.ok, scenario.label).toBe(false);
      expect(result.changed, scenario.label).toBe(false);
      expect(result.issues, scenario.label).toEqual([scenario.expectedIssue]);
      expect(result.issues.join(" "), scenario.label).not.toContain("RAW_PRINCIPAL_SENTINEL");
      expect(kit.schedulerCalls, scenario.label).toEqual([]);
      expect([...kit.tasks.entries()], scenario.label).toEqual(tasksBefore);
      expect(await readFile(recordFile, "utf8"), scenario.label).toBe(recordBefore);
    }
  });

  test("repair blocks extra cardinality and ambiguous or uncertain identity before every mutation", async () => {
    const scenarios: Array<{
      label: string;
      expectedIssue: string;
      mutateTask?: (task: ScheduledTaskInfo) => void;
      queryError?: string;
      principalFailure?: boolean;
    }> = [
      {
        label: "extra actions",
        expectedIssue: "scheduled task has extra actions or triggers; refusing automatic repair",
        mutateTask: (task) => { task.actionCount = 2; task.actionExecutable = null; task.actionArguments = null; },
      },
      {
        label: "extra triggers",
        expectedIssue: "scheduled task has extra actions or triggers; refusing automatic repair",
        mutateTask: (task) => { task.triggerCount = 2; task.triggerKind = null; task.triggerUser = null; },
      },
      { label: "duplicate identity", expectedIssue: "scheduled task query returned ambiguous identity", queryError: "scheduled task query returned ambiguous identity" },
      {
        label: "wrong path",
        expectedIssue: "scheduled task query returned ambiguous identity",
        mutateTask: (task) => { task.path = "\\Vendor\\"; },
      },
      { label: "provider failure", expectedIssue: "scheduled task query failed", queryError: "scheduled task query failed" },
      {
        label: "malformed provider",
        expectedIssue: "scheduled task query returned malformed output",
        queryError: "scheduled task query returned malformed output",
      },
      {
        label: "principal failure",
        expectedIssue: "unable to determine current Windows principal from runtime environment",
        principalFailure: true,
      },
    ];

    for (const scenario of scenarios) {
      const { state } = await freshState();
      const kit = makeKit();
      expect((await installRunner(state, kit.deps)).ok, scenario.label).toBe(true);
      scenario.mutateTask?.(kit.tasks.get(RUNNER_SCHEDULED_TASK)!);
      kit.serverRunners.push({ id: 900, name: RUNNER_NAME, os: "windows", status: "offline", busy: false, labels: [] });
      kit.hostState.instances = [runnerProcess(100), runnerProcess(200)];
      const recordFile = path.join(state.stateDir, "runner.json");
      const recordBefore = await readFile(recordFile, "utf8");
      const tasksBefore = [...kit.tasks.entries()].map(
        ([name, value]) => [name, { ...value }] as [string, ScheduledTaskInfo],
      );
      const registrationsBefore = kit.serverRunners.map((runner) => ({ ...runner, labels: [...runner.labels] }));
      const processesBefore = kit.hostState.instances.map((instance) => ({ ...instance }));
      const schedulerCallsBefore = [...kit.schedulerCalls];
      const hostCallsBefore = [...kit.hostCalls];
      const githubMutationsBefore = kit.githubCalls.filter((call) => call !== "listRunners");
      const scheduler = kit.deps.scheduler!;
      const deps: RunnerDeps = {
        ...kit.deps,
        principal: scenario.principalFailure
          ? () => { throw new Error("RAW_PRINCIPAL_SENTINEL"); }
          : kit.deps.principal,
        scheduler: scenario.queryError
          ? { ...scheduler, query: async () => { throw new Error(scenario.queryError!); } }
          : scheduler,
      };

      const result = await repairRunner(state, deps);

      expect(result.ok, scenario.label).toBe(false);
      expect(result.changed, scenario.label).toBe(false);
      expect(result.issues, scenario.label).toEqual([scenario.expectedIssue]);
      expect(result.issues.join(" "), scenario.label).not.toContain("RAW_PRINCIPAL_SENTINEL");
      expect(await readFile(recordFile, "utf8"), scenario.label).toBe(recordBefore);
      expect([...kit.tasks.entries()], scenario.label).toEqual(tasksBefore);
      expect(kit.serverRunners, scenario.label).toEqual(registrationsBefore);
      expect(kit.hostState.instances, scenario.label).toEqual(processesBefore);
      expect(kit.schedulerCalls, scenario.label).toEqual(schedulerCallsBefore);
      expect(kit.hostCalls, scenario.label).toEqual(hostCallsBefore);
      expect(kit.githubCalls.filter((call) => call !== "listRunners"), scenario.label).toEqual(githubMutationsBefore);
      if (scenario.label === "extra actions" || scenario.label === "extra triggers") {
        expect(result.issues.join(" "), scenario.label).not.toContain("ambiguous identity");
      }
    }
  });

  test("repair safely replaces zero-cardinality drift and carries one principal through create and postcondition", async () => {
    let phase: "install" | "repair" = "install";
    let repairResolutions = 0;
    const propagatedPrincipal = "CONTOSO\\ExactUser";
    const kit = makeKit({
      principal: () => {
        if (phase === "install") return TEST_PRINCIPAL;
        repairResolutions += 1;
        return repairResolutions === 1 ? propagatedPrincipal : "CONTOSO\\UnexpectedSecondResolution";
      },
    });
    const { state } = await freshState();
    expect((await installRunner(state, kit.deps)).ok).toBe(true);
    const task = kit.tasks.get(RUNNER_SCHEDULED_TASK)!;
    task.actionCount = 0;
    task.actionExecutable = null;
    task.actionArguments = null;
    task.triggerCount = 0;
    task.triggerKind = null;
    task.triggerUser = null;
    phase = "repair";
    kit.principalCalls.length = 0;
    kit.createdSpecs.length = 0;
    kit.schedulerQueries.length = 0;

    const result = await repairRunner(state, kit.deps);

    expect(result.ok).toBe(true);
    expect(repairResolutions).toBe(1);
    expect(kit.principalCalls).toEqual(["principal"]);
    expect(kit.createdSpecs).toHaveLength(1);
    expect(kit.createdSpecs[0]!.principalUser).toBe(propagatedPrincipal);
    expect(kit.schedulerQueries).toEqual([TASK_IDENTITY, TASK_IDENTITY, TASK_IDENTITY]);
    expect(kit.tasks.get(RUNNER_SCHEDULED_TASK)).toMatchObject({
      actionCount: 1,
      triggerCount: 1,
      triggerUser: propagatedPrincipal,
      principalUser: propagatedPrincipal,
    });
  });

  test("repair postcondition failure blocks enable and record writes without resolving the principal again", async () => {
    const { state } = await freshState();
    const kit = makeKit();
    expect((await installRunner(state, kit.deps)).ok).toBe(true);
    kit.tasks.get(RUNNER_SCHEDULED_TASK)!.actionExecutable = "cmd.exe";
    const recordFile = path.join(state.stateDir, "runner.json");
    const recordBefore = await readFile(recordFile, "utf8");
    kit.schedulerCalls.length = 0;
    kit.principalCalls.length = 0;
    const scheduler = kit.deps.scheduler!;
    const deps: RunnerDeps = {
      ...kit.deps,
      scheduler: {
        ...scheduler,
        create: async (spec) => {
          kit.schedulerCalls.push(`create:${spec.name}`);
        },
      },
    };

    const result = await repairRunner(state, deps);

    expect(result.ok).toBe(false);
    expect(result.changed).toBe(true);
    expect(result.issues).toEqual(["scheduled task postcondition failed"]);
    expect(kit.schedulerCalls).toEqual([`create:${RUNNER_SCHEDULED_TASK}`]);
    expect(kit.principalCalls).toEqual(["principal"]);
    expect(await readFile(recordFile, "utf8")).toBe(recordBefore);
  });

  test("alternate task or launcher records never become scheduler mutation targets", async () => {
    for (const field of ["scheduledTask", "launcherPath"] as const) {
      for (const action of ["enable", "repair"] as const) {
        const { state } = await freshState();
        const kit = makeKit();
        expect((await installRunner(state, kit.deps)).ok, `${field}/${action}`).toBe(true);
        const recordFile = path.join(state.stateDir, "runner.json");
        const record = JSON.parse(await readFile(recordFile, "utf8")) as RunnerRecord;
        record[field] = field === "scheduledTask"
          ? "Other-owned-task"
          : path.resolve(path.dirname(record.launcherPath), "other-owned", "launcher.ps1");
        await writeFile(recordFile, `${JSON.stringify(record, null, 2)}\n`);
        const recordBefore = await readFile(recordFile, "utf8");
        kit.schedulerCalls.length = 0;

        const result = action === "enable" ? await enableRunner(state, kit.deps) : await repairRunner(state, kit.deps);

        expect(result.ok, `${field}/${action}`).toBe(false);
        expect(result.issues, `${field}/${action}`).toEqual([
          "runner record is not canonical; refusing to use record-owned paths or identity",
        ]);
        expect(kit.schedulerCalls, `${field}/${action}`).toEqual([]);
        expect(await readFile(recordFile, "utf8"), `${field}/${action}`).toBe(recordBefore);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Token handling and redaction
// ---------------------------------------------------------------------------

describe("registration token handling", () => {
  test("the short-lived registration token is never persisted to canonical state", async () => {
    const { root, state } = await freshState();
    const kit = makeKit();

    const result = await installRunner(state, kit.deps);
    expect(result.ok).toBe(true);

    const corpus = await readAllText(root);
    expect(corpus).not.toContain(REGISTRATION_TOKEN);
    const record = await readFile(path.join(state.stateDir, "runner.json"), "utf8");
    expect(record).not.toContain(REGISTRATION_TOKEN);
  });

  test("token-bearing failures are redacted in diagnostics", async () => {
    const { state } = await freshState();
    const kit = makeKit();
    kit.hostState.configureError = `configuration rejected token {token}`;

    const result = await installRunner(state, kit.deps);

    expect(result.ok).toBe(false);
    expect(result.changed).toBe(true);
    expect(result.issues.join(" ")).not.toContain(REGISTRATION_TOKEN);
    expect(result.issues.join(" ")).toContain("<redacted>");
  });
});

describe("GitHub registration-token boundary", () => {
  const now = new Date("2026-07-14T10:00:00.000Z");
  const future = new Date(now.getTime() + 60_000).toISOString();
  const credentialSentinel = "ghp_CREDENTIAL_SENTINEL_2A1";
  const payloadSentinel = "PAYLOAD_SENTINEL_2A1";
  const argumentSentinel = "ARGV_SENTINEL_2A1";
  const stdoutSentinel = "STDOUT_SENTINEL_2A1";
  const stderrSentinel = "STDERR_SENTINEL_2A1";

  type BoundaryOptions = {
    credential?: string;
    readCredential?: () => Promise<string>;
    result?: { code: number; stdout: string; stderr: string };
    runError?: Error;
  };

  function makeRegistrationTokenBoundary(options: BoundaryOptions = {}) {
    const calls: Array<{ argv: string[]; env: Record<string, string | undefined> }> = [];
    let credentialReads = 0;
    const github = createGitHubControlPlane({
      now: () => now,
      async readCredential() {
        credentialReads += 1;
        if (options.readCredential) return options.readCredential();
        return options.credential ?? credentialSentinel;
      },
      async runCommand(argv, env) {
        calls.push({ argv: [...argv], env: { ...env } });
        if (options.runError) throw options.runError;
        return (
          options.result ?? {
            code: 0,
            stdout: JSON.stringify({ token: REGISTRATION_TOKEN, expires_at: future, provider_extra: "ignored" }),
            stderr: "",
          }
        );
      },
    });
    return { github, calls, credentialReads: () => credentialReads };
  }

  async function registrationTokenFailure(github: RunnerGitHub, repo = "owner/repo"): Promise<string> {
    try {
      await github.createRegistrationToken(repo);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error("expected registration-token request to fail");
  }

  test("normalizes a valid future token through the production boundary and canonical environment", async () => {
    const boundary = makeRegistrationTokenBoundary();

    const result = await boundary.github.createRegistrationToken("owner/repo");

    expect(result).toEqual({ token: REGISTRATION_TOKEN, expiresAt: future });
    expect(boundary.credentialReads()).toBe(1);
    expect(boundary.calls).toHaveLength(1);
    expect(boundary.calls[0]!.argv).toEqual([
      "gh",
      "api",
      "--method",
      "POST",
      "repos/owner/repo/actions/runners/registration-token",
    ]);
    expect(boundary.calls[0]!.env).toEqual({ ...canonicalChildEnvironment(), GH_TOKEN: credentialSentinel });
    expect(boundary.calls[0]!.argv.join(" ")).not.toContain(credentialSentinel);
  });

  test("maps a missing credential read to one stable secret-safe error", async () => {
    const readSentinel = "CREDENTIAL_READ_SENTINEL_2A1";
    const boundary = makeRegistrationTokenBoundary({
      readCredential: async () => {
        throw new Error(readSentinel);
      },
    });

    const message = await registrationTokenFailure(boundary.github);

    expect(message).toBe("github credential read failed");
    expect(message).not.toContain(readSentinel);
    expect(boundary.credentialReads()).toBe(1);
    expect(boundary.calls).toHaveLength(0);
  });

  for (const [label, credential] of [
    ["empty", ""],
    ["whitespace-only", "   "],
  ] as const) {
    test(`rejects a ${label} credential before invoking gh`, async () => {
      const boundary = makeRegistrationTokenBoundary({ credential });

      const message = await registrationTokenFailure(boundary.github);

      expect(message).toBe("github credential is empty");
      expect(boundary.credentialReads()).toBe(1);
      expect(boundary.calls).toHaveLength(0);
    });
  }

  test("does not cache a rejected whitespace credential", async () => {
    const boundary = makeRegistrationTokenBoundary({ credential: "   " });

    const first = await registrationTokenFailure(boundary.github);
    const second = await registrationTokenFailure(boundary.github);

    expect([first, second]).toEqual(["github credential is empty", "github credential is empty"]);
    expect(boundary.credentialReads()).toBe(2);
    expect(boundary.calls).toHaveLength(0);
  });

  const requestFailures: Array<[string, BoundaryOptions, string[]]> = [
    [
      "command rejection",
      { runError: new Error(`network failure ${stderrSentinel}`) },
      [stderrSentinel, argumentSentinel, credentialSentinel],
    ],
    [
      "nonzero exit",
      { result: { code: 1, stdout: `${stdoutSentinel} ${REGISTRATION_TOKEN}`, stderr: stderrSentinel } },
      [stdoutSentinel, stderrSentinel, REGISTRATION_TOKEN, argumentSentinel, credentialSentinel],
    ],
  ];

  for (const [label, options, sentinels] of requestFailures) {
    test(`maps token ${label} to a stable secret-safe request error`, async () => {
      const boundary = makeRegistrationTokenBoundary(options);

      const message = await registrationTokenFailure(boundary.github, `owner/${argumentSentinel}`);

      expect(message).toBe("github registration token request failed");
      for (const sentinel of sentinels) expect(message).not.toContain(sentinel);
    });
  }

  test("maps malformed token stdout to a stable secret-safe response error", async () => {
    const boundary = makeRegistrationTokenBoundary({
      result: { code: 0, stdout: `not-json ${payloadSentinel} ${REGISTRATION_TOKEN}`, stderr: stderrSentinel },
    });

    const message = await registrationTokenFailure(boundary.github, `owner/${argumentSentinel}`);

    expect(message).toBe("github registration token response was malformed");
    for (const sentinel of [payloadSentinel, REGISTRATION_TOKEN, stderrSentinel, argumentSentinel, credentialSentinel]) {
      expect(message).not.toContain(sentinel);
    }
  });

  const invalidTokenPayloads: Array<[string, unknown]> = [
    ["top-level null", null],
    ["top-level array", []],
    ["top-level string", payloadSentinel],
    ["top-level number", 7],
    ["top-level boolean", false],
    ["empty object", {}],
    ["missing token", { expires_at: future }],
    ["null token", { token: null, expires_at: future }],
    ["empty token", { token: "", expires_at: future }],
    ["whitespace token", { token: "   ", expires_at: future }],
    ["wrong-type token", { token: { marker: payloadSentinel }, expires_at: future }],
    ["missing expiry", { token: REGISTRATION_TOKEN }],
    ["null expiry", { token: REGISTRATION_TOKEN, expires_at: null }],
    ["empty expiry", { token: REGISTRATION_TOKEN, expires_at: "" }],
    ["whitespace expiry", { token: REGISTRATION_TOKEN, expires_at: "   " }],
    ["wrong-type expiry", { token: REGISTRATION_TOKEN, expires_at: 7 }],
    ["invalid-date expiry", { token: REGISTRATION_TOKEN, expires_at: payloadSentinel }],
    ["expiry exactly now", { token: REGISTRATION_TOKEN, expires_at: now.toISOString() }],
    ["expired timestamp", { token: REGISTRATION_TOKEN, expires_at: new Date(now.getTime() - 1).toISOString() }],
  ];

  for (const [label, payload] of invalidTokenPayloads) {
    test(`rejects invalid registration-token payload: ${label}`, async () => {
      const boundary = makeRegistrationTokenBoundary({
        result: { code: 0, stdout: JSON.stringify(payload) ?? "", stderr: "" },
      });

      const message = await registrationTokenFailure(boundary.github);

      expect(message).toBe("github registration token response was invalid");
      for (const sentinel of [credentialSentinel, REGISTRATION_TOKEN, payloadSentinel]) {
        expect(message).not.toContain(sentinel);
      }
    });
  }
});

describe("GitHub runner control boundary", () => {
  const credentialSentinel = "ghp_RUNNER_CREDENTIAL_SENTINEL_2A2";
  const payloadSentinel = "RUNNER_PAYLOAD_SENTINEL_2A2";
  const argumentSentinel = "RUNNER_ARGV_SENTINEL_2A2";
  const stdoutSentinel = "RUNNER_STDOUT_SENTINEL_2A2";
  const stderrSentinel = "RUNNER_STDERR_SENTINEL_2A2";
  const networkSentinel = "RUNNER_NETWORK_SENTINEL_2A2";

  type RunnerControlOptions = {
    result?: { code: number; stdout: string; stderr: string };
    runError?: Error;
  };

  function validRunner(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 501,
      name: RUNNER_NAME,
      os: "Windows",
      status: "online",
      busy: false,
      labels: [
        { id: 1, name: "self-hosted", type: "read-only" },
        { id: 2, name: "df-local", type: "custom" },
      ],
      provider_extra: payloadSentinel,
      ...overrides,
    };
  }

  function makeRunnerControlBoundary(options: RunnerControlOptions = {}) {
    const calls: Array<{ argv: string[]; env: Record<string, string | undefined> }> = [];
    const github = createGitHubControlPlane({
      now: () => new Date("2026-07-14T10:00:00.000Z"),
      readCredential: async () => credentialSentinel,
      async runCommand(argv, env) {
        calls.push({ argv: [...argv], env: { ...env } });
        if (options.runError) throw options.runError;
        return (
          options.result ?? {
            code: 0,
            stdout: JSON.stringify({ total_count: 1, runners: [validRunner()] }),
            stderr: "",
          }
        );
      },
    });
    return { github, calls };
  }

  async function runnerListFailure(github: RunnerGitHub, repo = "owner/repo"): Promise<string> {
    try {
      await github.listRunners(repo);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error("expected runner-list request to fail");
  }

  async function runnerRemovalFailure(github: RunnerGitHub, repo = "owner/repo"): Promise<string> {
    try {
      await github.removeRunner(repo, 17);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error("expected runner-removal request to fail");
  }

  test("normalizes valid online and offline runners into exact domain objects", async () => {
    const boundary = makeRunnerControlBoundary({
      result: {
        code: 0,
        stdout: JSON.stringify({
          total_count: 2,
          provider_page: payloadSentinel,
          runners: [validRunner(), validRunner({ id: 502, name: "df-darkfactory-agent-2", status: "offline", busy: true })],
        }),
        stderr: "",
      },
    });

    const result = await boundary.github.listRunners("owner/repo");

    expect(result).toEqual([
      {
        id: 501,
        name: RUNNER_NAME,
        os: "Windows",
        status: "online",
        busy: false,
        labels: ["self-hosted", "df-local"],
      },
      {
        id: 502,
        name: "df-darkfactory-agent-2",
        os: "Windows",
        status: "offline",
        busy: true,
        labels: ["self-hosted", "df-local"],
      },
    ]);
    expect(boundary.calls).toHaveLength(1);
    expect(boundary.calls[0]!.argv).toEqual([
      "gh",
      "api",
      "--method",
      "GET",
      "repos/owner/repo/actions/runners",
      "--paginate",
      "--slurp",
      "-f",
      "per_page=100",
    ]);
    expect(boundary.calls[0]!.env.GH_TOKEN).toBe(credentialSentinel);
    expect(boundary.calls[0]!.argv.join(" ")).not.toContain(credentialSentinel);
  });

  test("collects every paginated runner and preserves provider version and heartbeat metadata", async () => {
    const heartbeat = "2026-07-14T09:59:00.000Z";
    const boundary = makeRunnerControlBoundary({
      result: {
        code: 0,
        stdout: JSON.stringify([
          {
            total_count: 2,
            runners: [validRunner({ runner_version: "2.335.1", last_heartbeat_at: heartbeat })],
          },
          {
            total_count: 2,
            runners: [validRunner({ id: 502, name: "second-runner", version: "2.334.0" })],
          },
        ]),
        stderr: "",
      },
    });

    const result = await boundary.github.listRunners("owner/repo");

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: 501, os: "Windows", version: "2.335.1", lastHeartbeat: heartbeat });
    expect(result[1]).toMatchObject({ id: 502, version: "2.334.0" });
  });

  test("rejects incomplete or duplicate paginated evidence instead of silently dropping rows", async () => {
    const payloads = [
      [
        { total_count: 2, runners: [validRunner()] },
        { total_count: 2, runners: [validRunner()] },
      ],
      [
        { total_count: 3, runners: [validRunner()] },
        { total_count: 3, runners: [validRunner({ id: 502 })] },
      ],
    ];

    for (const payload of payloads) {
      const boundary = makeRunnerControlBoundary({
        result: { code: 0, stdout: JSON.stringify(payload), stderr: "" },
      });
      expect(await runnerListFailure(boundary.github)).toBe("github runner list response was invalid");
    }
  });

  const listRequestFailures: Array<[string, RunnerControlOptions, string[]]> = [
    [
      "network rejection",
      { runError: new Error(`transport failed ${networkSentinel}`) },
      [networkSentinel, argumentSentinel, credentialSentinel],
    ],
    [
      "auth/nonzero exit",
      { result: { code: 1, stdout: `${stdoutSentinel} ${payloadSentinel}`, stderr: `HTTP 401 ${stderrSentinel}` } },
      [stdoutSentinel, stderrSentinel, payloadSentinel, argumentSentinel, credentialSentinel],
    ],
  ];

  for (const [label, options, sentinels] of listRequestFailures) {
    test(`maps runner-list ${label} to a stable secret-safe request error`, async () => {
      const boundary = makeRunnerControlBoundary(options);

      const message = await runnerListFailure(boundary.github, `owner/${argumentSentinel}`);

      expect(message).toBe("github runner list request failed");
      expect(boundary.calls).toHaveLength(1);
      for (const sentinel of sentinels) expect(message).not.toContain(sentinel);
    });
  }

  test("maps malformed runner-list stdout to a stable secret-safe response error", async () => {
    const boundary = makeRunnerControlBoundary({
      result: { code: 0, stdout: `not-json ${stdoutSentinel} ${payloadSentinel}`, stderr: stderrSentinel },
    });

    const message = await runnerListFailure(boundary.github, `owner/${argumentSentinel}`);

    expect(message).toBe("github runner list response was malformed");
    expect(boundary.calls).toHaveLength(1);
    for (const sentinel of [stdoutSentinel, payloadSentinel, stderrSentinel, argumentSentinel, credentialSentinel]) {
      expect(message).not.toContain(sentinel);
    }
  });

  const removalFailures: Array<[string, RunnerControlOptions, string[]]> = [
    [
      "network rejection",
      { runError: new Error(`transport failed ${networkSentinel}`) },
      [networkSentinel, argumentSentinel, credentialSentinel],
    ],
    [
      "nonzero exit",
      { result: { code: 1, stdout: stdoutSentinel, stderr: stderrSentinel } },
      [stdoutSentinel, stderrSentinel, argumentSentinel, credentialSentinel],
    ],
  ];

  for (const [label, options, sentinels] of removalFailures) {
    test(`maps runner-removal ${label} to a stable secret-safe request error`, async () => {
      const boundary = makeRunnerControlBoundary(options);

      const message = await runnerRemovalFailure(boundary.github, `owner/${argumentSentinel}`);

      expect(message).toBe("github runner removal request failed");
      expect(boundary.calls).toHaveLength(1);
      expect(boundary.calls[0]!.argv).toEqual([
        "gh",
        "api",
        "--method",
        "DELETE",
        `repos/owner/${argumentSentinel}/actions/runners/17`,
      ]);
      for (const sentinel of sentinels) expect(message).not.toContain(sentinel);
    });
  }

  const invalidRunnerPayloads: Array<[string, unknown]> = [
    ["top-level null", null],
    ["top-level array", []],
    ["top-level string", payloadSentinel],
    ["top-level number", 7],
    ["top-level boolean", false],
    ["missing runners", {}],
    ["null runners", { runners: null }],
    ["object runners", { runners: {} }],
    ["null entry", { runners: [null] }],
    ["array entry", { runners: [[]] }],
    ["scalar entry", { runners: [payloadSentinel] }],
    ["partial entry", { runners: [{}] }],
    ["missing id", { runners: [validRunner({ id: undefined })] }],
    ["zero id", { runners: [validRunner({ id: 0 })] }],
    ["negative id", { runners: [validRunner({ id: -1 })] }],
    ["fractional id", { runners: [validRunner({ id: 1.5 })] }],
    ["unsafe id", { runners: [validRunner({ id: Number.MAX_SAFE_INTEGER + 1 })] }],
    ["wrong-type id", { runners: [validRunner({ id: "501" })] }],
    ["missing name", { runners: [validRunner({ name: undefined })] }],
    ["null name", { runners: [validRunner({ name: null })] }],
    ["empty name", { runners: [validRunner({ name: "" })] }],
    ["whitespace name", { runners: [validRunner({ name: "   " })] }],
    ["wrong-type name", { runners: [validRunner({ name: 7 })] }],
    ["missing os", { runners: [validRunner({ os: undefined })] }],
    ["null os", { runners: [validRunner({ os: null })] }],
    ["empty os", { runners: [validRunner({ os: "" })] }],
    ["whitespace os", { runners: [validRunner({ os: "   " })] }],
    ["wrong-type os", { runners: [validRunner({ os: 7 })] }],
    ["missing status", { runners: [validRunner({ status: undefined })] }],
    ["null status", { runners: [validRunner({ status: null })] }],
    ["case-drifted status", { runners: [validRunner({ status: "ONLINE" })] }],
    ["unknown status", { runners: [validRunner({ status: "busy" })] }],
    ["wrong-type status", { runners: [validRunner({ status: 7 })] }],
    ["missing busy", { runners: [validRunner({ busy: undefined })] }],
    ["null busy", { runners: [validRunner({ busy: null })] }],
    ["string busy", { runners: [validRunner({ busy: "false" })] }],
    ["numeric busy", { runners: [validRunner({ busy: 0 })] }],
    ["missing labels", { runners: [validRunner({ labels: undefined })] }],
    ["null labels", { runners: [validRunner({ labels: null })] }],
    ["empty labels", { runners: [validRunner({ labels: [] })] }],
    ["object labels", { runners: [validRunner({ labels: {} })] }],
    ["null label", { runners: [validRunner({ labels: [null] })] }],
    ["array label", { runners: [validRunner({ labels: [[]] })] }],
    ["scalar label", { runners: [validRunner({ labels: [payloadSentinel] })] }],
    ["partial label", { runners: [validRunner({ labels: [{}] })] }],
    ["empty label name", { runners: [validRunner({ labels: [{ name: "" }] })] }],
    ["whitespace label name", { runners: [validRunner({ labels: [{ name: "   " }] })] }],
    ["wrong-type label name", { runners: [validRunner({ labels: [{ name: 7 }] })] }],
    ["one invalid entry", { runners: [validRunner(), validRunner({ id: 502, busy: "false" })] }],
  ];

  for (const [label, payload] of invalidRunnerPayloads) {
    test(`rejects invalid runner-list payload: ${label}`, async () => {
      const boundary = makeRunnerControlBoundary({
        result: { code: 0, stdout: JSON.stringify(payload) ?? "", stderr: "" },
      });

      const message = await runnerListFailure(boundary.github, `owner/${argumentSentinel}`);

      expect(message).toBe("github runner list response was invalid");
      for (const sentinel of [credentialSentinel, payloadSentinel, argumentSentinel]) {
        expect(message).not.toContain(sentinel);
      }
    });
  }
});

describe("GitHub runner-list uncertainty", () => {
  const listFailure = "github runner list request failed";

  test("status returns structured unhealthy evidence when runner listing fails", async () => {
    const { state } = await freshState();
    const kit = makeKit({ listRunnersError: listFailure });

    const report = await runnerStatus(state, kit.deps);

    expect(report.ok).toBe(false);
    expect(report.registered).toBe(false);
    expect(report.readiness.registered).toBe(false);
    expect(report.readiness.online).toBeNull();
    expect(report.registration.status).toBe("unknown");
    expect(report.registration.duplicates).toBeNull();
    expect(report.issues).toContain("GitHub runner observation failed");
    expect(JSON.stringify(report)).not.toContain(listFailure);
    expect(kit.githubCalls).toEqual(["listRunners"]);
    expect(kit.hostCalls).toHaveLength(0);
    expect(kit.schedulerCalls).toHaveLength(0);
  });

  test("install fails before any mutation when runner listing is uncertain", async () => {
    const { state } = await freshState();
    const kit = makeKit({ listRunnersError: listFailure });

    const result = await installRunner(state, kit.deps);

    expect(result.ok).toBe(false);
    expect(result.changed).toBe(false);
    expect(result.issues).toContain(listFailure);
    expect(kit.githubCalls).toEqual(["listRunners"]);
    expect(kit.hostCalls).toHaveLength(0);
    expect(kit.schedulerCalls).toHaveLength(0);
    expect(await readRunnerRecord(state)).toBeNull();
  });

  test("repair preserves local state and processes when runner listing is uncertain", async () => {
    const { state } = await freshState();
    const healthy = makeKit();
    expect((await installRunner(state, healthy.deps)).ok).toBe(true);
    const recordBefore = await readRunnerRecord(state);
    const kit = makeKit({ listRunnersError: listFailure });
    kit.hostState.instances = [
      runnerProcess(100, { commandLine: "Runner.Listener.exe" }),
      runnerProcess(200, { commandLine: "Runner.Listener.exe" }),
    ];

    const result = await repairRunner(state, kit.deps);

    expect(result.ok).toBe(false);
    expect(result.changed).toBe(false);
    expect(result.issues).toContain(listFailure);
    expect(kit.githubCalls).toEqual(["listRunners"]);
    expect(kit.hostCalls).toHaveLength(0);
    expect(kit.schedulerCalls).toHaveLength(0);
    expect(kit.hostState.instances.map((instance) => instance.pid)).toEqual([100, 200]);
    expect(await readRunnerRecord(state)).toEqual(recordBefore);
  });
});

// ---------------------------------------------------------------------------
// Unrelated task/service preservation
// ---------------------------------------------------------------------------

describe("unrelated scheduled task preservation", () => {
  test("lifecycle actions never touch unrelated scheduled tasks", async () => {
    const { state } = await freshState();
    const kit = makeKit();
    const before = { ...kit.tasks.get(UNRELATED_TASK)! };

    await installRunner(state, kit.deps);
    await enableRunner(state, kit.deps);
    kit.hostState.instances = [runnerProcess(7, { commandLine: "Runner.Listener.exe" })];
    await disableRunner(state, kit.deps);
    await repairRunner(state, kit.deps);

    expect(kit.tasks.get(UNRELATED_TASK)).toEqual(before);
    const touchedUnrelated = kit.schedulerCalls.some((call) => call.includes(UNRELATED_TASK));
    expect(touchedUnrelated).toBe(false);
    const touchedNames = new Set(kit.schedulerCalls.map((call) => call.split(":")[1]));
    for (const name of touchedNames) expect(name).toBe(RUNNER_SCHEDULED_TASK);
  });
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

const ALL_READY: RunnerReadiness = {
  installed: true,
  registered: true,
  enabled: true,
  persistent: true,
  process: true,
  online: true,
  launcherBinding: true,
};

function readiness(overrides: Partial<RunnerReadiness> = {}): RunnerReadiness {
  return { ...ALL_READY, ...overrides };
}

interface StatusFixture {
  root: string;
  state: SharedState;
  kit: Kit;
}

async function canonicalStatusFixture(): Promise<StatusFixture> {
  const { root, state } = await freshState();
  const kit = makeKit();
  expect((await installRunner(state, kit.deps)).ok).toBe(true);
  kit.hostState.instances = [runnerProcess(5150, { commandLine: "Runner.Listener.exe" })];
  return { root, state, kit };
}

async function rewriteRunnerRecord(
  state: SharedState,
  update: (record: RunnerRecord) => RunnerRecord,
): Promise<void> {
  const record = (await readRunnerRecord(state))!;
  await writeFile(path.join(state.stateDir, "runner.json"), `${JSON.stringify(update(record), null, 2)}\n`);
}

async function statusMutationSnapshot(state: SharedState, kit: Kit): Promise<unknown> {
  return {
    files: await readAllText(state.stateDir),
    tasks: [...kit.tasks.entries()].map(([name, task]) => [name, { ...task }]),
    processes: kit.hostState.instances.map((process) => ({ ...process })),
    registrations: kit.serverRunners.map((registration) => ({ ...registration, labels: [...registration.labels] })),
    schedulerMutations: [...kit.schedulerCalls],
    hostMutations: [...kit.hostCalls],
    githubMutations: kit.githubCalls.filter((call) => call !== "listRunners"),
  };
}

describe("runner status", () => {
  interface StatusScenario {
    label: string;
    expected: RunnerReadiness;
    ok: boolean;
    issue?: string;
    prepare?: (fixture: StatusFixture) => RunnerDeps | void | Promise<RunnerDeps | void>;
    assertDetails?: (report: Awaited<ReturnType<typeof runnerStatus>>) => void;
  }

  const healthyDoctor = (): StateDoctorReport => makeDoctor();
  const doctorWithoutLauncher = (): StateDoctorReport => {
    const doctor = healthyDoctor();
    return { ...doctor, checks: doctor.checks.filter((check) => check.id !== "launcher") };
  };
  const duplicateLauncherDoctor = (): StateDoctorReport => {
    const doctor = healthyDoctor();
    const launcher = doctor.checks.find((check) => check.id === "launcher")!;
    return { ...doctor, checks: [...doctor.checks, { ...launcher }] };
  };
  const malformedDoctor = (): StateDoctorReport => ({
    ...healthyDoctor(),
    checks: [...healthyDoctor().checks, { id: "unused", message: 42, ok: true }],
  }) as unknown as StateDoctorReport;

  const scenarios: StatusScenario[] = [
    {
      label: "canonical online singleton",
      expected: readiness(),
      ok: true,
      assertDetails: (report) => {
        expect(report.record).toEqual({ present: true, canonical: true });
        expect(report.installation).toEqual({
          provisioned: true,
          configured: true,
          repositoryBinding: true,
          updateDisabled: true,
          version: "2.335.1",
        });
        expect(report.persistence).toMatchObject({
          mechanism: "scheduled-task",
          name: RUNNER_SCHEDULED_TASK,
          path: RUNNER_SCHEDULED_TASK_PATH,
          present: true,
          enabled: true,
          actionCount: 1,
          triggerCount: 1,
          triggerKind: "AtLogOn",
          triggerUser: TEST_PRINCIPAL,
          principalUser: TEST_PRINCIPAL,
          principalLogonType: "Interactive",
          principalRunLevel: "Limited",
          multipleInstances: "IgnoreNew",
          allowStartIfOnBatteries: true,
          dontStopIfGoingOnBatteries: true,
          restartCount: 3,
          restartInterval: "PT1M",
          executionTimeLimit: "PT0S",
          boundToLauncher: true,
        });
        expect(report.process).toEqual({ running: true, instances: 1, pids: [5150] });
        expect(report.registration).toEqual({
          id: 500,
          os: "windows",
          labels: [...RUNNER_LABELS],
          status: "online",
          busy: false,
          version: "2.335.1",
          lastHeartbeat: null,
          duplicates: 0,
        });
        for (const forbidden of ["persistent", "processRunning", "online", "launcherBinding"]) {
          expect(forbidden in report).toBe(false);
        }
      },
    },
    {
      label: "canonical busy singleton",
      expected: readiness(),
      ok: true,
      prepare: ({ kit }) => { kit.serverRunners[0]!.busy = true; },
      assertDetails: (report) => expect(report.registration.status).toBe("busy"),
    },
    {
      label: "known non-launcher doctor unhealthy",
      expected: readiness(),
      ok: false,
      issue: "canonical state doctor is unhealthy",
      prepare: ({ kit }) => ({ ...kit.deps, doctor: async () => makeDoctor({ failId: "memory_integrity" }) }),
      assertDetails: (report) => {
        expect(report.doctor.ok).toBe(false);
        expect(report.binding.ok).toBe(true);
      },
    },
    {
      label: "launcher check missing",
      expected: readiness({ launcherBinding: false }),
      ok: false,
      issue: "canonical launcher check is missing",
      prepare: ({ kit }) => ({ ...kit.deps, doctor: async () => doctorWithoutLauncher() }),
    },
    {
      label: "unique launcher check unhealthy",
      expected: readiness({ launcherBinding: false }),
      ok: false,
      issue: "canonical launcher binding is invalid",
      prepare: ({ kit }) => ({ ...kit.deps, doctor: async () => makeDoctor({ launcherOk: false }) }),
    },
    {
      label: "duplicate launcher checks",
      expected: readiness({ launcherBinding: null }),
      ok: false,
      issue: "canonical state doctor observation failed",
      prepare: ({ kit }) => ({ ...kit.deps, doctor: async () => duplicateLauncherDoctor() }),
      assertDetails: (report) => expect(report.doctor.ok).toBeNull(),
    },
    {
      label: "doctor top-level/check inconsistency",
      expected: readiness({ launcherBinding: null }),
      ok: false,
      issue: "canonical state doctor observation failed",
      prepare: ({ kit }) => ({ ...kit.deps, doctor: async () => ({ ...healthyDoctor(), ok: false }) }),
    },
    {
      label: "doctor contains malformed unused row",
      expected: readiness({ launcherBinding: null }),
      ok: false,
      issue: "canonical state doctor observation failed",
      prepare: ({ kit }) => ({ ...kit.deps, doctor: async () => malformedDoctor() }),
    },
    {
      label: "doctor rejects",
      expected: readiness({ launcherBinding: null }),
      ok: false,
      issue: "canonical state doctor observation failed",
      prepare: ({ kit }) => ({ ...kit.deps, doctor: async () => { throw new Error("RAW_DOCTOR_FAILURE"); } }),
    },
    {
      label: "record absent",
      expected: readiness({ installed: false, registered: false, enabled: false, launcherBinding: false }),
      ok: false,
      issue: "runner record is missing",
      prepare: async ({ state }) => { await rm(path.join(state.stateDir, "runner.json")); },
      assertDetails: (report) => expect(report.record).toEqual({ present: false, canonical: false }),
    },
    {
      label: "record read failure",
      expected: readiness({ installed: null, registered: null, enabled: null, launcherBinding: null }),
      ok: false,
      issue: "runner record observation failed",
      prepare: async ({ state }) => { await writeFile(path.join(state.stateDir, "runner.json"), "{not-json\n"); },
      assertDetails: (report) => expect(report.record).toEqual({ present: null, canonical: null }),
    },
    {
      label: "record ownership drift",
      expected: readiness({ installed: false, registered: false, enabled: false, launcherBinding: false }),
      ok: false,
      issue: "runner record is not canonical",
      prepare: async ({ root, state }) => rewriteRunnerRecord(state, (record) => ({
        ...record,
        name: "alternate-runner",
        repo: "alternate-owner/alternate-repo",
        labels: ["alternate-label"],
        installDir: path.join(root, "alternate-runner"),
        launcherPath: path.join(root, "alternate-agents.ps1"),
        scheduledTask: "AlternateTask",
      })),
    },
    {
      label: "current-principal resolution failure",
      expected: readiness({ persistent: null }),
      ok: false,
      issue: "Windows principal observation failed",
      prepare: ({ kit }) => ({
        ...kit.deps,
        principal: () => {
          kit.principalCalls.push("principal");
          throw new Error("RAW_PRINCIPAL_FAILURE");
        },
      }),
      assertDetails: (report) => {
        expect(report.persistence.present).toBe(true);
        expect(report.persistence.boundToLauncher).toBe(true);
      },
    },
    {
      label: "unique registration offline",
      expected: readiness({ online: false }),
      ok: false,
      issue: "canonical GitHub runner is offline",
      prepare: ({ kit }) => { kit.serverRunners[0]!.status = "offline"; },
    },
    {
      label: "no registration",
      expected: readiness({ registered: false, online: false }),
      ok: false,
      issue: "canonical GitHub runner registration is missing",
      prepare: ({ kit }) => { kit.serverRunners.length = 0; },
    },
    {
      label: "duplicate canonical registrations",
      expected: readiness({ registered: false, online: null }),
      ok: false,
      issue: "duplicate canonical GitHub runner registrations: 2",
      prepare: ({ kit }) => {
        kit.serverRunners.push({
          id: 901,
          name: RUNNER_NAME,
          os: "windows",
          status: "online",
          busy: false,
          labels: [...RUNNER_LABELS],
        });
      },
      assertDetails: (report) => {
        expect(report.registration).toMatchObject({ id: null, status: "unknown", busy: null, duplicates: 1 });
      },
    },
    {
      label: "unique registration ID OS or label drift while online",
      expected: readiness({ registered: false }),
      ok: false,
      issue: "canonical GitHub runner registration does not match the runner record",
      prepare: ({ kit }) => {
        kit.serverRunners[0]!.id = 999;
        kit.serverRunners[0]!.os = "linux";
        kit.serverRunners[0]!.labels = ["self-hosted"];
      },
    },
    {
      label: "task disabled but definition canonical",
      expected: readiness({ enabled: false }),
      ok: false,
      issue: `scheduled task ${RUNNER_SCHEDULED_TASK} is disabled`,
      prepare: ({ kit }) => { kit.tasks.get(RUNNER_SCHEDULED_TASK)!.enabled = false; },
    },
    {
      label: "task missing",
      expected: readiness({ enabled: false, persistent: false, launcherBinding: false }),
      ok: false,
      issue: `scheduled task ${RUNNER_SCHEDULED_TASK} is missing`,
      prepare: ({ kit }) => { kit.tasks.delete(RUNNER_SCHEDULED_TASK); },
      assertDetails: (report) => expect(report.persistence).toMatchObject({
        present: false,
        state: null,
        enabled: false,
        actionCount: null,
        triggerCount: null,
        boundToLauncher: false,
      }),
    },
    {
      label: "one task action drift",
      expected: readiness({ launcherBinding: false }),
      ok: false,
      issue: "scheduled task is not bound to the canonical launcher",
      prepare: ({ kit }) => { kit.tasks.get(RUNNER_SCHEDULED_TASK)!.actionExecutable = "cmd.exe"; },
    },
    {
      label: "trigger principal or run-level drift",
      expected: readiness({ persistent: false }),
      ok: false,
      issue: "scheduled task does not have canonical logon persistence",
      prepare: ({ kit }) => { kit.tasks.get(RUNNER_SCHEDULED_TASK)!.triggerUser = "OTHER\\user"; },
    },
    {
      label: "task duplicate-prevention or durability settings drift",
      expected: readiness({ persistent: false }),
      ok: false,
      issue: "scheduled task does not have canonical logon persistence",
      prepare: ({ kit }) => {
        const task = kit.tasks.get(RUNNER_SCHEDULED_TASK)!;
        task.multipleInstances = "Parallel";
        task.restartInterval = "PT5M";
      },
      assertDetails: (report) => expect(report.persistence).toMatchObject({
        multipleInstances: "Parallel",
        restartInterval: "PT5M",
      }),
    },
    {
      label: "unique exact-root task with extra actions",
      expected: readiness({ launcherBinding: false }),
      ok: false,
      issue: "scheduled task is not bound to the canonical launcher",
      prepare: ({ kit }) => {
        const task = kit.tasks.get(RUNNER_SCHEDULED_TASK)!;
        task.actionCount = 2;
        task.actionExecutable = null;
        task.actionArguments = null;
      },
      assertDetails: (report) => expect(report.persistence.actionCount).toBe(2),
    },
    {
      label: "unique exact-root task with extra triggers",
      expected: readiness({ persistent: false }),
      ok: false,
      issue: "scheduled task does not have canonical logon persistence",
      prepare: ({ kit }) => {
        const task = kit.tasks.get(RUNNER_SCHEDULED_TASK)!;
        task.triggerCount = 2;
        task.triggerKind = null;
        task.triggerUser = null;
      },
      assertDetails: (report) => expect(report.persistence.triggerCount).toBe(2),
    },
    {
      label: "unique exact-root task with extra actions and triggers",
      expected: readiness({ persistent: false, launcherBinding: false }),
      ok: false,
      issue: "scheduled task is not bound to the canonical launcher",
      prepare: ({ kit }) => {
        const task = kit.tasks.get(RUNNER_SCHEDULED_TASK)!;
        task.actionCount = 2;
        task.actionExecutable = null;
        task.actionArguments = null;
        task.triggerCount = 2;
        task.triggerKind = null;
        task.triggerUser = null;
      },
    },
    {
      label: "duplicate exact-name tasks",
      expected: readiness({ enabled: null, persistent: null, launcherBinding: null }),
      ok: false,
      issue: "scheduled task observation failed",
      prepare: ({ kit }) => ({
        ...kit.deps,
        scheduler: {
          ...kit.deps.scheduler!,
          query: async (identity) => {
            kit.schedulerQueries.push({ ...identity });
            throw new Error("scheduled task query returned ambiguous identity");
          },
        },
      }),
      assertDetails: (report) => expect(report.persistence).toMatchObject({
        present: null,
        state: null,
        enabled: null,
        actionCount: null,
        triggerCount: null,
        boundToLauncher: null,
      }),
    },
    {
      label: "single wrong-path or provider identity ambiguity",
      expected: readiness({ enabled: null, persistent: null, launcherBinding: null }),
      ok: false,
      issue: "scheduled task observation failed",
      prepare: ({ kit }) => ({
        ...kit.deps,
        scheduler: {
          ...kit.deps.scheduler!,
          query: async (identity) => {
            kit.schedulerQueries.push({ ...identity });
            return { ...kit.tasks.get(RUNNER_SCHEDULED_TASK)!, path: "\\Other\\" };
          },
        },
      }),
    },
    {
      label: "zero local processes",
      expected: readiness({ process: false }),
      ok: false,
      issue: "canonical runner process is not running",
      prepare: ({ kit }) => { kit.hostState.instances = []; },
    },
    {
      label: "duplicate local processes",
      expected: readiness({ process: false }),
      ok: false,
      issue: "duplicate runner processes: 2",
      prepare: ({ kit }) => { kit.hostState.instances = [runnerProcess(1), runnerProcess(2)]; },
    },
    {
      label: "software config or repository binding known absent",
      expected: readiness({ installed: false }),
      ok: false,
      issue: "runner software is not provisioned",
      prepare: ({ kit }) => { kit.hostState.provisioned = false; },
    },
    {
      label: "host inspection failure",
      expected: readiness({ installed: null }),
      ok: false,
      issue: "runner software observation failed",
      prepare: ({ kit }) => ({
        ...kit.deps,
        host: {
          ...kit.deps.host!,
          isProvisioned: async (dir) => {
            kit.hostQueries.push({ operation: "isProvisioned", dir });
            throw new Error("RAW_HOST_FAILURE");
          },
        },
      }),
    },
    {
      label: "GitHub list failure",
      expected: readiness({ registered: null, online: null }),
      ok: false,
      issue: "GitHub runner observation failed",
      prepare: ({ kit }) => ({
        ...kit.deps,
        github: {
          ...kit.deps.github!,
          listRunners: async (repo) => {
            kit.githubQueries.push(repo);
            throw new Error("RAW_GITHUB_FAILURE");
          },
        },
      }),
      assertDetails: (report) => expect(report.registration).toMatchObject({
        id: null,
        status: "unknown",
        busy: null,
        version: "2.335.1",
        duplicates: null,
      }),
    },
    {
      label: "scheduler query failure",
      expected: readiness({ enabled: null, persistent: null, launcherBinding: null }),
      ok: false,
      issue: "scheduled task observation failed",
      prepare: ({ kit }) => ({
        ...kit.deps,
        scheduler: {
          ...kit.deps.scheduler!,
          query: async (identity) => {
            kit.schedulerQueries.push({ ...identity });
            throw new Error("RAW_SCHEDULER_FAILURE");
          },
        },
      }),
    },
    {
      label: "process query failure",
      expected: readiness({ process: null }),
      ok: false,
      issue: "runner process observation failed",
      prepare: ({ kit }) => ({
        ...kit.deps,
        host: {
          ...kit.deps.host!,
          runningInstances: async (dir) => {
            kit.hostQueries.push({ operation: "runningInstances", dir });
            throw new Error("RAW_PROCESS_FAILURE");
          },
        },
      }),
      assertDetails: (report) => expect(report.process).toEqual({ running: null, instances: null, pids: null }),
    },
    {
      label: "unsupported platform",
      expected: readiness({
        installed: null,
        registered: null,
        enabled: null,
        persistent: null,
        process: null,
        online: null,
        launcherBinding: null,
      }),
      ok: false,
      issue: "runner lifecycle status is unsupported on platform darwin",
      prepare: ({ kit }) => ({ ...kit.deps, platform: "darwin" }),
      assertDetails: (report) => {
        expect(report.record).toEqual({ present: null, canonical: null });
        expect(report.process).toEqual({ running: null, instances: null, pids: null });
        expect(report.registration.duplicates).toBeNull();
      },
    },
  ];

  test("derives the complete required T F U truth matrix from one canonical read-only snapshot", async () => {
    for (const scenario of scenarios) {
      const fixture = await canonicalStatusFixture();
      const { state, kit } = fixture;
      const prepared = await scenario.prepare?.(fixture);
      const deps = prepared ?? kit.deps;
      kit.schedulerQueries.length = 0;
      kit.hostQueries.length = 0;
      kit.githubQueries.length = 0;
      kit.principalCalls.length = 0;
      const before = await statusMutationSnapshot(state, kit);

      const report = await runnerStatus(state, deps);

      expect(report.readiness, scenario.label).toEqual(scenario.expected);
      expect(report.ok, scenario.label).toBe(scenario.ok);
      expect(report.installed, scenario.label).toBe(scenario.expected.installed === true);
      expect(report.registered, scenario.label).toBe(scenario.expected.registered === true);
      expect(report.enabled, scenario.label).toBe(scenario.expected.enabled === true);
      expect(report.name, scenario.label).toBe(RUNNER_NAME);
      expect(report.repo, scenario.label).toBe(RUNNER_REPOSITORY);
      expect(report.labels, scenario.label).toEqual([...RUNNER_LABELS]);
      expect(report.persistence.name, scenario.label).toBe(RUNNER_SCHEDULED_TASK);
      expect(report.persistence.path, scenario.label).toBe(RUNNER_SCHEDULED_TASK_PATH);
      expect(report.binding.launcher, scenario.label).toBe(
        runnerLauncherPath(state, scenario.label === "unsupported platform" ? "darwin" : "win32"),
      );
      if (scenario.issue) expect(report.issues, scenario.label).toContain(scenario.issue);
      else expect(report.issues, scenario.label).toEqual([]);
      scenario.assertDetails?.(report);

      if (scenario.label === "unsupported platform") {
        expect(kit.schedulerQueries, scenario.label).toEqual([]);
        expect(kit.hostQueries, scenario.label).toEqual([]);
        expect(kit.githubQueries, scenario.label).toEqual([]);
        expect(kit.principalCalls, scenario.label).toEqual([]);
      } else {
        expect(kit.schedulerQueries, scenario.label).toEqual([
          { name: RUNNER_SCHEDULED_TASK, path: RUNNER_SCHEDULED_TASK_PATH },
        ]);
        expect(kit.hostQueries, scenario.label).toEqual([
          { operation: "isProvisioned", dir: runnerInstallDir(state) },
          { operation: "isConfigured", dir: runnerInstallDir(state) },
          { operation: "runnerVersion", dir: runnerInstallDir(state) },
          { operation: "runningInstances", dir: runnerInstallDir(state) },
        ]);
        expect(kit.githubQueries, scenario.label).toEqual([RUNNER_REPOSITORY]);
        expect(kit.principalCalls, scenario.label).toEqual(["principal"]);
      }
      expect(await statusMutationSnapshot(state, kit), scenario.label).toEqual(before);
    }
  });

  test("status preserves provider-owned version and heartbeat when the runner API supplies them", async () => {
    const { state, kit } = await canonicalStatusFixture();
    const heartbeat = "2026-07-14T09:59:00.000Z";
    kit.serverRunners[0]!.version = "provider-2.335.1";
    kit.serverRunners[0]!.lastHeartbeat = heartbeat;

    const report = await runnerStatus(state, kit.deps);

    expect(report.registration.version).toBe("provider-2.335.1");
    expect(report.registration.lastHeartbeat).toBe(heartbeat);
  });

  test("strictly normalizes every doctor row, aggregate, and launcher cardinality", async () => {
    const fixture = await canonicalStatusFixture();
    const { state, kit } = fixture;
    const malformedTopLevels = [
      null,
      [],
      {},
      { ok: "true", checks: [] },
      { ok: true, checks: {} },
    ];
    const doctorCases: Array<{
      label: string;
      run: () => Promise<unknown>;
      doctor: boolean | null;
      launcher: boolean | null;
    }> = [
      { label: "healthy", run: async () => healthyDoctor(), doctor: true, launcher: true },
      {
        label: "non-launcher unhealthy",
        run: async () => makeDoctor({ failId: "memory_integrity" }),
        doctor: false,
        launcher: true,
      },
      { label: "launcher missing", run: async () => doctorWithoutLauncher(), doctor: true, launcher: false },
      {
        label: "launcher unhealthy",
        run: async () => makeDoctor({ launcherOk: false }),
        doctor: false,
        launcher: false,
      },
      { label: "duplicate launcher", run: async () => duplicateLauncherDoctor(), doctor: null, launcher: null },
      { label: "malformed unused row", run: async () => malformedDoctor(), doctor: null, launcher: null },
      {
        label: "false aggregate with healthy rows",
        run: async () => ({ ...healthyDoctor(), ok: false }),
        doctor: null,
        launcher: null,
      },
      {
        label: "true aggregate with failed row",
        run: async () => ({ ...makeDoctor({ failId: "memory_integrity" }), ok: true }),
        doctor: null,
        launcher: null,
      },
      {
        label: "rejected doctor",
        run: async () => { throw new Error("RAW_REJECTED_DOCTOR"); },
        doctor: null,
        launcher: null,
      },
      ...malformedTopLevels.map((value, index) => ({
        label: `malformed top-level ${index}`,
        run: async () => value,
        doctor: null,
        launcher: null,
      })),
    ];

    for (const doctorCase of doctorCases) {
      const report = await runnerStatus(state, {
        ...kit.deps,
        doctor: doctorCase.run as () => Promise<StateDoctorReport>,
      });
      expect(report.doctor.ok, doctorCase.label).toBe(doctorCase.doctor);
      expect(report.readiness.launcherBinding, doctorCase.label).toBe(doctorCase.launcher);
      if (doctorCase.doctor === null) {
        expect(report.issues, doctorCase.label).toContain("canonical state doctor observation failed");
      }
    }
  });

  test("separates known installation negatives from host config and version uncertainty", async () => {
    const cases: Array<{
      label: string;
      expectedInstalled: boolean | null;
      issue: string;
      prepare: (fixture: StatusFixture) => RunnerDeps | void | Promise<RunnerDeps | void>;
      assertDetails: (report: Awaited<ReturnType<typeof runnerStatus>>) => void;
    }> = [
      {
        label: "configured false",
        expectedInstalled: false,
        issue: "runner is not configured",
        prepare: ({ kit }) => { kit.hostState.configured = false; },
        assertDetails: (report) => expect(report.installation.configured).toBe(false),
      },
      {
        label: "repository binding false",
        expectedInstalled: false,
        issue: "runner configuration is not bound to the canonical repository",
        prepare: async ({ state }) => {
          await writeFile(
            path.join(runnerInstallDir(state), ".runner"),
            `${JSON.stringify({
              agentId: 500,
              agentName: RUNNER_NAME,
              gitHubUrl: "https://github.com/alternate/repository",
              disableUpdate: true,
            })}\n`,
          );
        },
        assertDetails: (report) => expect(report.installation.repositoryBinding).toBe(false),
      },
      {
        label: "upstream self-update enabled",
        expectedInstalled: false,
        issue: "runner self-update is not disabled for the pinned build",
        prepare: async ({ state }) => {
          await writeFile(
            path.join(runnerInstallDir(state), ".runner"),
            `${JSON.stringify({
              agentId: 500,
              agentName: RUNNER_NAME,
              gitHubUrl: `https://github.com/${RUNNER_REPOSITORY}`,
              disableUpdate: false,
            })}\n`,
          );
        },
        assertDetails: (report) => expect(report.installation.updateDisabled).toBe(false),
      },
      {
        label: "configured observation failure",
        expectedInstalled: null,
        issue: "runner configuration observation failed",
        prepare: ({ kit }) => ({
          ...kit.deps,
          host: {
            ...kit.deps.host!,
            isConfigured: async () => { throw new Error("RAW_CONFIGURED_FAILURE"); },
          },
        }),
        assertDetails: (report) => expect(report.installation.configured).toBeNull(),
      },
      {
        label: "config URL observation failure",
        expectedInstalled: null,
        issue: "runner repository binding observation failed",
        prepare: async ({ state }) => {
          const config = path.join(runnerInstallDir(state), ".runner");
          await rm(config);
          await mkdir(config);
        },
        assertDetails: (report) => expect(report.installation.repositoryBinding).toBeNull(),
      },
      {
        label: "version observation failure",
        expectedInstalled: true,
        issue: "runner version observation failed",
        prepare: ({ kit }) => ({
          ...kit.deps,
          host: {
            ...kit.deps.host!,
            runnerVersion: async () => { throw new Error("RAW_VERSION_FAILURE"); },
          },
        }),
        assertDetails: (report) => {
          expect(report.installation.version).toBeNull();
          expect(report.registration.version).toBeNull();
        },
      },
    ];

    for (const installCase of cases) {
      const fixture = await canonicalStatusFixture();
      const prepared = await installCase.prepare(fixture);
      const report = await runnerStatus(fixture.state, prepared ?? fixture.kit.deps);

      expect(report.readiness.installed, installCase.label).toBe(installCase.expectedInstalled);
      expect(report.readiness, installCase.label).toEqual(
        readiness({
          installed: installCase.expectedInstalled,
          ...(installCase.label === "config URL observation failure" ? { registered: null } : {}),
        }),
      );
      expect(report.ok, installCase.label).toBe(false);
      expect(report.issues, installCase.label).toContain(installCase.issue);
      installCase.assertDetails(report);
      expect(JSON.stringify(report), installCase.label).not.toMatch(/RAW_[A-Z_]+_FAILURE/);
    }
  });

  test("malicious record values never redirect canonical status observations", async () => {
    const fixture = await canonicalStatusFixture();
    const { root, state, kit } = fixture;
    const alternateInstall = path.join(root, "alternate-install");
    await mkdir(alternateInstall, { recursive: true });
    await writeFile(path.join(alternateInstall, ".runner"), `${JSON.stringify({ gitHubUrl: "https://github.com/evil/repo" })}\n`);
    await rewriteRunnerRecord(state, (record) => ({
      ...record,
      name: "evil-runner",
      repo: "evil-owner/evil-repo",
      labels: ["evil-label"],
      installDir: alternateInstall,
      launcherPath: path.join(root, "evil-launcher.ps1"),
      scheduledTask: "EvilTask",
    }));
    kit.schedulerQueries.length = 0;
    kit.hostQueries.length = 0;
    kit.githubQueries.length = 0;
    kit.principalCalls.length = 0;

    const report = await runnerStatus(state, kit.deps);

    expect(report.name).toBe(RUNNER_NAME);
    expect(report.repo).toBe(RUNNER_REPOSITORY);
    expect(report.labels).toEqual([...RUNNER_LABELS]);
    expect(report.binding.launcher).toBe(runnerLauncherPath(state, "win32"));
    expect(report.persistence).toMatchObject({ name: RUNNER_SCHEDULED_TASK, path: RUNNER_SCHEDULED_TASK_PATH });
    expect(report.installation.repositoryBinding).toBe(true);
    expect(kit.hostQueries.every((query) => query.dir === runnerInstallDir(state))).toBe(true);
    expect(kit.schedulerQueries).toEqual([{ name: RUNNER_SCHEDULED_TASK, path: RUNNER_SCHEDULED_TASK_PATH }]);
    expect(kit.githubQueries).toEqual([RUNNER_REPOSITORY]);
    expect(kit.principalCalls).toEqual(["principal"]);
    expect(JSON.stringify(report)).not.toContain("evil-owner");
    expect(JSON.stringify(report)).not.toContain("evil-runner");
  });

  test("raw status recursively redacts launcher issues while preserving nullable detail shape", async () => {
    const { state, kit } = await canonicalStatusFixture();
    const tokenValue = "RAW_RESULT_SECRET_0123456789";
    const sentinel = `github_pat_${tokenValue}`;
    const doctor = makeDoctor({ launcherOk: false });
    doctor.checks.find((check) => check.id === "launcher")!.details = {
      issues: [`keep-${sentinel}-tail`, "plain issue"],
    };
    const deps = withHostOverrides(kit, {
      async runningInstances() {
        throw new Error("RAW_PROCESS_FAILURE");
      },
    });

    const report = await runnerStatus(state, { ...deps, doctor: async () => doctor });

    expect(report.process).toEqual({ running: null, instances: null, pids: null });
    expect(report.binding.issues).toEqual(["keep-<redacted>-tail", "plain issue"]);
    expect(report.readiness.process).toBeNull();
    expect(report.doctor.ok).toBe(false);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain(tokenValue);
    expect(serialized).toContain('"instances":null');
  });
});

// ---------------------------------------------------------------------------
// Supervised host entrypoint
// ---------------------------------------------------------------------------

describe("runner run (supervised host)", () => {
  test("run refuses to start when the canonical doctor is unhealthy", async () => {
    const { state } = await freshState();
    const healthy = makeKit();
    await installRunner(state, healthy.deps);
    const unhealthy = makeKit({ doctor: makeDoctor({ ok: false, failId: "session_integrity" }) });

    const result = await runRunner(state, unhealthy.deps);

    expect(result.ok).toBe(false);
    expect(unhealthy.hostCalls).not.toContain("run");
  });

  test("run refuses a missing, disabled, or drifted scheduled-task authority", async () => {
    for (const mode of ["missing", "disabled", "drifted"] as const) {
      const { state } = await freshState();
      const kit = makeKit();
      expect((await installRunner(state, kit.deps)).ok, mode).toBe(true);
      const task = kit.tasks.get(RUNNER_SCHEDULED_TASK)!;
      if (mode === "missing") kit.tasks.delete(RUNNER_SCHEDULED_TASK);
      if (mode === "disabled") task.enabled = false;
      if (mode === "drifted") task.actionArguments = `${task.actionArguments} --ambient`;
      kit.hostCalls.length = 0;
      kit.githubCalls.length = 0;

      const result = await runRunner(state, kit.deps);

      expect(result.ok, mode).toBe(false);
      expect(result.changed, mode).toBe(false);
      expect(result.issues, mode).toEqual([
        "scheduled task is not enabled with the canonical definition; run `agents runner repair`",
      ]);
      expect(kit.hostCalls, mode).toEqual([]);
      expect(kit.githubCalls, mode).toEqual(["listRunners"]);
    }
  });

  test("run does not start a duplicate host process", async () => {
    const { state } = await freshState();
    const kit = makeKit();
    await installRunner(state, kit.deps);
    kit.hostState.instances = [runnerProcess(99, { commandLine: "Runner.Listener.exe" })];

    const result = await runRunner(state, kit.deps);

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(false);
    expect(kit.hostCalls).not.toContain("run");
  });

  test("run starts one exact Listener and returns its exit result", async () => {
    const { state } = await freshState();
    const kit = makeKit();
    expect((await installRunner(state, kit.deps)).ok).toBe(true);
    kit.hostState.instances = [];
    kit.hostCalls.length = 0;

    const result = await runRunner(state, kit.deps);

    expect(result).toMatchObject({ ok: true, action: "run", changed: true, details: { exitCode: 0 } });
    expect(kit.hostCalls).toEqual(["run"]);
    expect(kit.hostState.instances).toEqual([runnerProcess(6000)]);
  });

  test("run timeout cancels a late spawn and cleans only the owned process identity", async () => {
    const { state } = await freshState();
    const kit = makeKit();
    expect((await installRunner(state, kit.deps)).ok).toBe(true);
    kit.hostState.instances = [];
    const process = runnerProcess(7331);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let terminateCalls = 0;
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
    const deps = withHostOverrides(kit, {
      async run(): Promise<RunnerRunHandle> {
        timer = setTimeout(() => {
          kit.hostState.instances.push({ ...process });
        }, 60);
        return {
          process: { ...process },
          exited,
          async terminate() {
            terminateCalls += 1;
            if (timer !== null) clearTimeout(timer);
            timer = null;
            kit.hostState.instances = kit.hostState.instances.filter(
              (candidate) =>
                candidate.pid !== process.pid ||
                candidate.executablePath.toLowerCase() !== process.executablePath.toLowerCase() ||
                candidate.startedAt !== process.startedAt,
            );
            resolveExit(143);
          },
        };
      },
    });

    const result = await runRunner(state, {
      ...deps,
      startObservationTimeoutMs: 20,
      startObservationIntervalMs: 2,
    });
    await Bun.sleep(80);

    expect(result.ok).toBe(false);
    expect(result.changed).toBe(true);
    expect(result.details.partialMutation).toBe(true);
    expect(result.issues).toEqual([
      "runner host start postcondition timed out before its process became observable",
    ]);
    expect(terminateCalls).toBe(1);
    expect(kit.hostState.instances).toEqual([]);
  });

  test("run cleans its exact Listener when the registration never comes online", async () => {
    const { state } = await freshState();
    const kit = makeKit();
    expect((await installRunner(state, kit.deps)).ok).toBe(true);
    kit.hostState.instances = [];
    kit.serverRunners[0]!.status = "offline";
    kit.hostCalls.length = 0;

    const result = await runRunner(state, {
      ...kit.deps,
      startObservationTimeoutMs: 20,
      startObservationIntervalMs: 2,
    });

    expect(result.ok).toBe(false);
    expect(result.changed).toBe(true);
    expect(result.issues).toEqual([
      "runner readiness postcondition timed out before one exact Listener and its sole registration were online",
    ]);
    expect(kit.hostCalls).toEqual(["run", "terminate:6000"]);
    expect(kit.hostState.instances).toEqual([]);
  });

  test("run does not accept an already-running Listener whose sole registration is offline", async () => {
    const { state } = await freshState();
    const kit = makeKit();
    expect((await installRunner(state, kit.deps)).ok).toBe(true);
    kit.serverRunners[0]!.status = "offline";
    kit.hostCalls.length = 0;

    const result = await runRunner(state, {
      ...kit.deps,
      startObservationTimeoutMs: 20,
      startObservationIntervalMs: 2,
    });

    expect(result.ok).toBe(false);
    expect(result.changed).toBe(false);
    expect(result.issues).toEqual([
      "runner readiness postcondition timed out before one exact Listener and its sole registration were online",
    ]);
    expect(kit.hostCalls).toEqual([]);
    expect(kit.hostState.instances).toEqual([runnerProcess(6000)]);
  });

  test("run reconciles stale registrations and duplicate process identities before refusing another start", async () => {
    const { state } = await freshState();
    const kit = makeKit();
    expect((await installRunner(state, kit.deps)).ok).toBe(true);
    kit.serverRunners.push({
      id: 900,
      name: RUNNER_NAME,
      os: "Windows",
      status: "offline",
      busy: false,
      labels: [...RUNNER_LABELS],
    });
    kit.hostState.instances = [
      runnerProcess(800, { startedAt: "2026-07-14T08:00:00.000Z" }),
      runnerProcess(2, { startedAt: "2026-07-14T11:00:00.000Z" }),
    ];
    kit.githubCalls.length = 0;
    kit.hostCalls.length = 0;

    const result = await runRunner(state, kit.deps);

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(kit.githubCalls).toEqual(["listRunners", "removeRunner:900", "listRunners"]);
    expect(kit.hostCalls).toEqual(["stopInstances:2"]);
    expect(kit.hostState.instances.map((instance) => instance.pid)).toEqual([800]);
    expect(result.details.pids).toEqual([800]);
  });

  test("concurrent run commands serialize the start boundary and launch exactly one host", async () => {
    const { state } = await freshState();
    const kit = makeKit();
    expect((await installRunner(state, kit.deps)).ok).toBe(true);
    kit.hostState.instances = [];
    let runCalls = 0;
    let releaseRun!: () => void;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const deps = withHostOverrides(kit, {
      run: async (): Promise<RunnerRunHandle> => {
        runCalls += 1;
        const process = runnerProcess(7000 + runCalls);
        // Model the Listener becoming observable shortly after spawn. The
        // lifecycle lock must remain held until that exact identity is seen.
        await Bun.sleep(30);
        kit.hostState.instances.push(process);
        return {
          process,
          exited: runGate.then(() => {
            kit.hostState.instances = kit.hostState.instances.filter(
              (candidate) =>
                candidate.pid !== process.pid ||
                candidate.executablePath.toLowerCase() !== process.executablePath.toLowerCase() ||
                candidate.startedAt !== process.startedAt,
            );
            return 0;
          }),
          async terminate() {
            kit.hostState.instances = kit.hostState.instances.filter(
              (candidate) =>
                candidate.pid !== process.pid ||
                candidate.executablePath.toLowerCase() !== process.executablePath.toLowerCase() ||
                candidate.startedAt !== process.startedAt,
            );
          },
        };
      },
    });

    const firstPromise = runRunner(state, deps);
    for (let attempt = 0; attempt < 100 && runCalls === 0; attempt += 1) await Bun.sleep(5);
    expect(runCalls).toBe(1);
    const second = await runRunner(state, deps);
    releaseRun();
    const first = await firstPromise;

    expect(first).toMatchObject({ ok: true, action: "run", changed: true, details: { exitCode: 0 } });
    expect(second).toMatchObject({ ok: true, action: "run", changed: false });
    expect(second.details.note).toBe("runner host already running");
    expect(runCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// CLI wiring
// ---------------------------------------------------------------------------

describe("agents runner CLI", () => {
  const envBackup: Record<string, string | undefined> = {};

  function setAgentsEnv(root: string): void {
    for (const key of ["AGENTS_HOME", "AGENTS_ROOT", "AGENTS_USER_HOME"]) envBackup[key] = process.env[key];
    process.env.AGENTS_HOME = path.join(root, ".agents");
    process.env.AGENTS_ROOT = root;
    process.env.AGENTS_USER_HOME = root;
  }

  function restoreEnv(): void {
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  async function captureConsole(run: () => Promise<void>): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    const originalExitCode = process.exitCode;
    console.log = (...args: unknown[]) => stdout.push(args.map(String).join(" "));
    console.error = (...args: unknown[]) => stderr.push(args.map(String).join(" "));
    process.exitCode = 0;
    try {
      await run();
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
    const exitCode = process.exitCode ?? 0;
    process.exitCode = originalExitCode;
    return { stdout: stdout.join("\n"), stderr: stderr.join("\n"), exitCode };
  }

  test("runner status --json prints a parseable report through the CLI", async () => {
    const { root, state } = await freshState();
    const kit = makeKit();
    await installRunner(state, kit.deps);
    kit.hostState.instances = [runnerProcess(5150, { commandLine: "Runner.Listener.exe" })];
    setRunnerDeps(kit.deps);
    setAgentsEnv(root);

    const output = await captureConsole(() => runnerCommand(["status", "--json"]));
    restoreEnv();

    expect(output.exitCode).toBe(0);
    const parsed = JSON.parse(output.stdout);
    expect(parsed.name).toBe(RUNNER_NAME);
    expect(parsed.persistence.mechanism).toBe("scheduled-task");
    expect(parsed.registered).toBe(true);
  });

  test("runner status never bootstraps an absent shared-state tree", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-runner-readonly-"));
    roots.push(root);
    const stateDir = path.join(root, ".agents");
    const kit = makeKit({ platform: "darwin" });
    setRunnerDeps(kit.deps);
    setAgentsEnv(root);

    try {
      const output = await captureConsole(() => runnerCommand(["status", "--json"]));

      expect(output.exitCode).toBe(1);
      expect(JSON.parse(output.stdout).supported).toBe(false);
      expect(await pathExists(stateDir)).toBe(false);
    } finally {
      restoreEnv();
    }
  });

  test("runner status --json settles one failing Windows principal without losing the report", async () => {
    const { root, state } = await freshState();
    const kit = makeKit();
    await installRunner(state, kit.deps);
    kit.hostState.instances = [runnerProcess(5150, { commandLine: "Runner.Listener.exe" })];
    let principalCalls = 0;
    setRunnerDeps({
      ...kit.deps,
      principal: () => {
        principalCalls += 1;
        throw new Error("RAW_STATUS_PRINCIPAL_SENTINEL");
      },
    });
    setAgentsEnv(root);

    try {
      const output = await captureConsole(() => runnerCommand(["status", "--json"]));

      expect(output.exitCode).toBe(1);
      const parsed = JSON.parse(output.stdout);
      expect(parsed.name).toBe(RUNNER_NAME);
      expect(parsed.persistence.mechanism).toBe("scheduled-task");
      expect(parsed.registered).toBe(true);
      expect(parsed.readiness).toEqual({ ...ALL_READY, persistent: null });
      expect(parsed.persistence.present).toBe(true);
      expect(parsed.persistence.boundToLauncher).toBe(true);
      expect(principalCalls).toBe(1);
      expect(`${output.stdout}\n${output.stderr}`).not.toContain("RAW_STATUS_PRINCIPAL_SENTINEL");
    } finally {
      restoreEnv();
    }
  });

  test("runner install --json reports a structured result through the CLI", async () => {
    const { root } = await freshState();
    const kit = makeKit();
    setRunnerDeps(kit.deps);
    setAgentsEnv(root);

    const output = await captureConsole(() => runnerCommand(["install", "--json"]));
    restoreEnv();

    expect(output.exitCode).toBe(0);
    const parsed = JSON.parse(output.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.action).toBe("install");
    expect(parsed.changed).toBe(true);
  });

  test("status --json recursively redacts nested launcher issues without changing shape", async () => {
    const { root } = await freshState();
    const tokenValue = "NESTED_JSON_SECRET_0123456789";
    const sentinel = `github_pat_${tokenValue}`;
    const doctor = makeDoctor({ launcherOk: false });
    const launcher = doctor.checks.find((check) => check.id === "launcher")!;
    launcher.details = { issues: [`keep-${sentinel}-tail`, "second issue"] };
    const kit = makeKit({ doctor });
    setRunnerDeps(kit.deps);
    setAgentsEnv(root);

    try {
      const output = await captureConsole(() => runnerCommand(["status", "--json"]));

      expect(output.exitCode).toBe(1);
      const parsed = JSON.parse(output.stdout);
      expect(parsed.binding.issues).toEqual(["keep-<redacted>-tail", "second issue"]);
      expect(parsed.binding.ok).toBe(false);
      expect(parsed.doctor).toEqual({ ok: false });
      expect(parsed.process).toEqual({ running: false, instances: 0, pids: [] });
      const corpus = `${output.stdout}\n${output.stderr}`;
      expect(corpus).not.toContain(sentinel);
      expect(corpus).not.toContain(tokenValue);
    } finally {
      restoreEnv();
    }
  });

  test("human status renders every unknown truth count and list as unknown", async () => {
    const { root } = await freshState();
    const kit = makeKit({ platform: "darwin" });
    setRunnerDeps(kit.deps);
    setAgentsEnv(root);

    try {
      const output = await captureConsole(() => runnerCommand(["status"]));

      expect(output.exitCode).toBe(1);
      for (const field of [
        "installed",
        "registered",
        "enabled",
        "persistent",
        "process",
        "online",
        "launcherBinding",
      ]) {
        expect(output.stdout).toMatch(new RegExp(`${field}:\\s+unknown`));
      }
      expect(output.stdout).toContain("[unknown]");
      expect(output.stdout).toContain("present=unknown enabled=unknown actions=unknown triggers=unknown bound=unknown");
      expect(output.stdout).toContain("running=unknown instances=unknown pids=unknown");
      expect(output.stdout).toContain("duplicates=unknown");
      expect(output.stdout).toMatch(/doctor:\s+unknown/);
      expect(output.stdout).toMatch(/binding:\s+unknown/);
      expect(output.stdout).not.toMatch(/installed:\s+false/);
      expect(output.stdout).not.toMatch(/instances=0|pids=none|\[missing\]|doctor:\s+unhealthy/);
    } finally {
      restoreEnv();
    }
  });

  test("unknown runner actions redact token-shaped values in the human error", async () => {
    const tokenValue = "HUMAN_ERROR_SECRET_0123456789";
    const sentinel = `github_pat_${tokenValue}`;

    const error = (await runnerCommand([`keep-${sentinel}-tail`]).catch((caught) => caught)) as Error;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("unknown runner action: keep-<redacted>-tail");
    expect(error.message).not.toContain(sentinel);
    expect(error.message).not.toContain(tokenValue);
  });

  test("unknown runner action throws", async () => {
    await expect(runnerCommand(["bogus"])).rejects.toThrow(/unknown runner action/);
  });
});

// ---------------------------------------------------------------------------
// Scheduled task live contract (slice 1)
// ---------------------------------------------------------------------------

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function makePartialRecord(state: SharedState): { scheduledTask: string; launcherPath: string } {
  return { scheduledTask: RUNNER_SCHEDULED_TASK, launcherPath: runnerLauncherPath(state, "win32") };
}

const TASK_IDENTITY: ScheduledTaskIdentity = {
  name: RUNNER_SCHEDULED_TASK,
  path: RUNNER_SCHEDULED_TASK_PATH,
};

function taskQueryPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    TaskName: RUNNER_SCHEDULED_TASK,
    TaskPath: RUNNER_SCHEDULED_TASK_PATH,
    Enabled: true,
    State: "Ready",
    ActionCount: 1,
    Actions: [{ Execute: windowsPowerShellExecutable(), Arguments: "" }],
    TriggerCount: 1,
    Triggers: [{ Kind: "MSFT_TaskLogonTrigger", User: TEST_PRINCIPAL }],
    Principal: { UserId: TEST_PRINCIPAL, LogonType: "Interactive", RunLevel: "Limited" },
    Settings: {
      MultipleInstances: "IgnoreNew",
      AllowStartIfOnBatteries: true,
      DontStopIfGoingOnBatteries: true,
      RestartCount: 3,
      RestartInterval: "PT1M",
      ExecutionTimeLimit: "PT0S",
    },
    ...overrides,
  };
}

function windowsMockScheduledTask(
  spec: ScheduledTaskSpec,
  options: {
    triggerUser: string;
    principalUser: string;
    disallowStartIfOnBatteries?: string;
    stopIfGoingOnBatteries?: string;
  },
): RunnerScheduler {
  const disallowStartIfOnBatteries = options.disallowStartIfOnBatteries ?? "$false";
  const stopIfGoingOnBatteries = options.stopIfGoingOnBatteries ?? "$false";
  const provider =
    `function Get-ScheduledTask { ` +
    `[CmdletBinding()] ` +
    `param([Parameter(ValueFromPipeline=$true)][string]$TaskName); ` +
    `[pscustomobject]@{ ` +
    `TaskName = ${psQuote(spec.name)}; TaskPath = ${psQuote(spec.path)}; State = 'Ready'; ` +
    `Actions = @([pscustomobject]@{ Execute = ${psQuote(spec.executable)}; Arguments = ${psQuote(spec.arguments)} }); ` +
    `Triggers = @([pscustomobject]@{ ` +
    `UserId = ${psQuote(options.triggerUser)}; ` +
    `CimClass = [pscustomobject]@{ CimClassName = 'MSFT_TaskLogonTrigger' } ` +
    `}); ` +
    `Principal = [pscustomobject]@{ ` +
    `UserId = ${psQuote(options.principalUser)}; LogonType = 'Interactive'; RunLevel = 'Limited' ` +
    `}; ` +
    `Settings = [pscustomobject]@{ ` +
    `Enabled = $true; MultipleInstances = 'IgnoreNew'; ` +
    `DisallowStartIfOnBatteries = ${disallowStartIfOnBatteries}; ` +
    `StopIfGoingOnBatteries = ${stopIfGoingOnBatteries}; ` +
    `RestartCount = 3; RestartInterval = 'PT1M'; ExecutionTimeLimit = 'PT0S' ` +
    `} ` +
    `} ` +
    `}`;
  return createWindowsScheduler((script) => runPowerShellText(`${provider}; ${script}`));
}

describe("scheduled task contract", () => {
  test("task plan uses the exact executable and argument string", async () => {
    const { state } = await freshState();
    const record = makePartialRecord(state);
    const spec = buildRunnerTaskSpec(state, TEST_PRINCIPAL);

    expect(RUNNER_SCHEDULED_TASK).toBe("AgentOS-df-local-runner");
    expect(spec.name).toBe(RUNNER_SCHEDULED_TASK);
    expect(spec.path).toBe(RUNNER_SCHEDULED_TASK_PATH);
    expect(spec.principalUser).toBe(TEST_PRINCIPAL);
    expect(spec.executable).toBe(windowsPowerShellExecutable());
    expect(path.win32.isAbsolute(spec.executable)).toBe(true);
    expect(spec.arguments).toBe(
      `-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${record.launcherPath}" runner run`,
    );
  });

  test("PowerShell resolution is absolute and rejects an untrusted relative SystemRoot", () => {
    expect(windowsPowerShellExecutable({ SystemRoot: "D:\\Windows" } as NodeJS.ProcessEnv)).toBe(
      "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(() => windowsPowerShellExecutable({ SystemRoot: "relative-root" } as NodeJS.ProcessEnv)).toThrow(
      "Windows SystemRoot is not an absolute trusted path",
    );
    expect(() => windowsPowerShellExecutable({ SystemRoot: 'C:\\Windows\" -Command evil' } as NodeJS.ProcessEnv)).toThrow(
      "Windows SystemRoot is not an absolute trusted path",
    );
  });

  test("current Windows principal is built from evaluated runtime values, not a literal env string", () => {
    const originalDomain = process.env.USERDOMAIN;
    const originalUsername = process.env.USERNAME;
    try {
      process.env.USERDOMAIN = "FABRIKAM";
      process.env.USERNAME = "tester";
      expect(currentWindowsPrincipal()).toBe("FABRIKAM\\tester");
      expect(currentWindowsPrincipal()).not.toBe("$env:USERDOMAIN\\$env:USERNAME");
    } finally {
      if (originalDomain === undefined) delete process.env.USERDOMAIN;
      else process.env.USERDOMAIN = originalDomain;
      if (originalUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = originalUsername;
    }
  });

  test("current Windows principal fails closed when domain or user evidence is missing", () => {
    const names = ["USERDOMAIN", "COMPUTERNAME", "USERNAME", "USER"] as const;
    const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      for (const name of names) delete process.env[name];
      expect(() => currentWindowsPrincipal()).toThrow(
        "unable to determine current Windows principal from runtime environment",
      );
    } finally {
      for (const name of names) {
        if (original[name] === undefined) delete process.env[name];
        else process.env[name] = original[name];
      }
    }
  });

  test("task creation script uses RunLevel Limited and an AtLogOn trigger scoped to the current user", async () => {
    const originalDomain = process.env.USERDOMAIN;
    const originalUsername = process.env.USERNAME;
    try {
      process.env.USERDOMAIN = "ACME";
      process.env.USERNAME = "wile";
      const { state } = await freshState();
      const record = makePartialRecord(state);
      const spec = buildRunnerTaskSpec(state, "ACME\\wile");

      let capturedScript = "";
      const scheduler = createWindowsScheduler(async (script) => {
        capturedScript = script;
        return { code: 0, stdout: "", stderr: "" };
      });

      await scheduler.create(spec);

      expect(capturedScript).toContain("-RunLevel Limited");
      expect(capturedScript).toContain("-LogonType Interactive");
      expect(capturedScript).toContain("-AtLogOn -User 'ACME\\wile'");
      expect(capturedScript).toContain(`-TaskName ${psQuote(RUNNER_SCHEDULED_TASK)}`);
      expect(capturedScript).toContain(`-TaskPath ${psQuote(RUNNER_SCHEDULED_TASK_PATH)}`);
      expect(capturedScript).toContain(`-Execute ${psQuote(spec.executable)}`);
      expect(capturedScript).toContain(`-Argument ${psQuote(spec.arguments)}`);
    } finally {
      if (originalDomain === undefined) delete process.env.USERDOMAIN;
      else process.env.USERDOMAIN = originalDomain;
      if (originalUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = originalUsername;
    }
  });

  test("task query returns null only for a positively missing task", async () => {
    const scheduler = createWindowsScheduler(async () => ({ code: 0, stdout: "__MISSING__", stderr: "" }));
    const result = await scheduler.query(TASK_IDENTITY);
    expect(result).toBeNull();
  });

  test("task query fails closed on nonzero exit", async () => {
    const scheduler = createWindowsScheduler(async () => ({
      code: 1,
      stdout: "",
      stderr: "Access is denied.",
    }));
    await expect(scheduler.query(TASK_IDENTITY)).rejects.toThrow(/scheduled task query failed/);
  });

  test("task query fails closed on malformed output", async () => {
    const scheduler = createWindowsScheduler(async () => ({ code: 0, stdout: "not-json", stderr: "" }));
    await expect(scheduler.query(TASK_IDENTITY)).rejects.toThrow(/malformed output/);
  });

  test("task binding requires exact executable and argument match", async () => {
    const { state } = await freshState();
    const record = makePartialRecord(state);
    const spec = buildRunnerTaskSpec(state, TEST_PRINCIPAL);
    const task = taskInfo({
      name: RUNNER_SCHEDULED_TASK,
      actionExecutable: spec.executable,
      actionArguments: spec.arguments,
    });

    expect(taskMatchesSpec(task, spec)).toBe(true);
    expect(taskMatchesSpec({ ...task, actionExecutable: "cmd.exe" }, spec)).toBe(false);
    expect(taskMatchesSpec({ ...task, actionArguments: `${spec.arguments} --extra` }, spec)).toBe(false);
    expect(taskMatchesSpec(null, spec)).toBe(false);
  });
  test("task query accepts a strictly valid task object, including empty action strings", async () => {
    const scheduler = createWindowsScheduler(async () => ({
      code: 0,
      stdout: JSON.stringify({
        ...taskQueryPayload(),
        Actions: [{ Execute: "", Arguments: "" }],
      }),
      stderr: "",
    }));

    const result = await scheduler.query(TASK_IDENTITY);

    expect(result).toEqual({
      name: RUNNER_SCHEDULED_TASK,
      path: RUNNER_SCHEDULED_TASK_PATH,
      enabled: true,
      state: "Ready",
      actionCount: 1,
      actionExecutable: "",
      actionArguments: "",
      triggerCount: 1,
      triggerKind: "AtLogOn",
      triggerUser: TEST_PRINCIPAL,
      principalUser: TEST_PRINCIPAL,
      principalLogonType: "Interactive",
      principalRunLevel: "Limited",
      multipleInstances: "IgnoreNew",
      allowStartIfOnBatteries: true,
      dontStopIfGoingOnBatteries: true,
      restartCount: 3,
      restartInterval: "PT1M",
      executionTimeLimit: "PT0S",
    });
  });

  const invalidPayloads: Array<[string, unknown]> = [
    ["empty object", {}],
    ["wrong TaskName", { TaskName: "OtherTask", Enabled: true, State: "Ready", Execute: "a", Arguments: "b" }],
    ["Enabled string false", { TaskName: RUNNER_SCHEDULED_TASK, Enabled: "false", State: "Ready", Execute: "a", Arguments: "b" }],
    ["State number", { TaskName: RUNNER_SCHEDULED_TASK, Enabled: true, State: 1, Execute: "a", Arguments: "b" }],
    ["State unknown string", { TaskName: RUNNER_SCHEDULED_TASK, Enabled: true, State: "Offline", Execute: "a", Arguments: "b" }],
    ["Execute object", { TaskName: RUNNER_SCHEDULED_TASK, Enabled: true, State: "Ready", Execute: { cmd: "a" }, Arguments: "b" }],
    ["Arguments array", { TaskName: RUNNER_SCHEDULED_TASK, Enabled: true, State: "Ready", Execute: "a", Arguments: ["b"] }],
    ["top-level null", null],
    ["top-level array", []],
  ];

  for (const [label, payload] of invalidPayloads) {
    test(`task query rejects invalid payload: ${label}`, async () => {
      const scheduler = createWindowsScheduler(async () => ({
        code: 0,
        stdout: JSON.stringify(payload),
        stderr: "",
      }));
      await expect(scheduler.query(TASK_IDENTITY)).rejects.toThrow(/malformed output/);
    });
  }

  test("task query enumerates the exact accepted name across every path before normalization", async () => {
    let capturedScript = "";
    const scheduler = createWindowsScheduler(async (script) => {
      capturedScript = script;
      return { code: 0, stdout: JSON.stringify(taskQueryPayload()), stderr: "" };
    });

    await expect(scheduler.query(TASK_IDENTITY)).resolves.toMatchObject(TASK_IDENTITY);

    expect(capturedScript).toContain(`Get-ScheduledTask -TaskName ${psQuote(RUNNER_SCHEDULED_TASK)}`);
    expect(capturedScript).not.toContain("Get-ScheduledTaskInfo");
    expect(capturedScript).not.toContain("-TaskPath");
    expect(capturedScript).toContain("$tasks.Count -ne 1");
    expect(capturedScript).toContain("__AMBIGUOUS__");
    expect(capturedScript).toContain("$account.Translate([System.Security.Principal.SecurityIdentifier])");
    expect(capturedScript).toContain("$sid.Translate([System.Security.Principal.NTAccount])");
    expect(capturedScript).toContain("$task.Settings.PSObject.Properties['DisallowStartIfOnBatteries']");
    expect(capturedScript).toContain("$task.Settings.PSObject.Properties['StopIfGoingOnBatteries']");
    expect(capturedScript).not.toContain(".EndsWith(");
    expect(capturedScript).not.toContain("$task.Settings.AllowStartIfOnBatteries");
    expect(capturedScript).not.toContain("$task.Settings.DontStopIfGoingOnBatteries");
  });

  test.skipIf(process.platform !== "win32")(
    "success: native task query round-trips qualified accounts through their SID",
    async () => {
      const { state } = await freshState();
      const principal = currentWindowsPrincipal();
      const spec = buildRunnerTaskSpec(state, principal);
      const scheduler = windowsMockScheduledTask(spec, {
        triggerUser: principal,
        principalUser: principal,
      });

      const observed = await scheduler.query(TASK_IDENTITY);

      expect(observed).not.toBeNull();
      expect(observed!.triggerUser?.toLowerCase()).toBe(principal.toLowerCase());
      expect(observed!.principalUser.toLowerCase()).toBe(principal.toLowerCase());
      expect(observed!.allowStartIfOnBatteries).toBe(true);
      expect(observed!.dontStopIfGoingOnBatteries).toBe(true);
      expect(taskHasCanonicalPersistence(observed, spec)).toBe(true);
    },
  );

  test.skipIf(process.platform !== "win32")(
    "edge-input: native task query canonicalizes an unqualified local principal",
    async () => {
      const { state } = await freshState();
      const principal = currentWindowsPrincipal();
      const unqualified = principal.slice(principal.indexOf("\\") + 1);
      const spec = buildRunnerTaskSpec(state, principal);
      const scheduler = windowsMockScheduledTask(spec, {
        triggerUser: principal,
        principalUser: unqualified,
      });

      const observed = await scheduler.query(TASK_IDENTITY);

      expect(observed).not.toBeNull();
      expect(observed!.triggerUser?.toLowerCase()).toBe(principal.toLowerCase());
      expect(observed!.principalUser.toLowerCase()).toBe(principal.toLowerCase());
      expect(taskHasCanonicalPersistence(observed, spec)).toBe(true);
    },
  );

  test.skipIf(process.platform !== "win32")(
    "denied-failure: native task query fails closed when an account cannot translate to a SID",
    async () => {
      const { state } = await freshState();
      const principal = currentWindowsPrincipal();
      const invalid = "NO_SUCH_DOMAIN_7A3F\\NO_SUCH_USER_7A3F";
      const spec = buildRunnerTaskSpec(state, principal);
      const scheduler = windowsMockScheduledTask(spec, {
        triggerUser: principal,
        principalUser: invalid,
      });

      const error = (await scheduler.query(TASK_IDENTITY).catch((caught) => caught)) as Error;

      expect(error.message).toBe("scheduled task query failed");
      expect(error.message).not.toContain(invalid);
    },
  );

  test.skipIf(process.platform !== "win32")(
    "denied-failure: native task query rejects nonboolean inverse battery settings",
    async () => {
      const { state } = await freshState();
      const principal = currentWindowsPrincipal();
      const spec = buildRunnerTaskSpec(state, principal);
      const scheduler = windowsMockScheduledTask(spec, {
        triggerUser: principal,
        principalUser: principal,
        disallowStartIfOnBatteries: "'false'",
      });

      await expect(scheduler.query(TASK_IDENTITY)).rejects.toThrow("scheduled task query failed");
    },
  );

  test("task query maps rejected and nonzero providers to one stable secret-safe error", async () => {
    const sentinel = "RAW_SCHEDULER_PROVIDER_SENTINEL";
    const schedulers = [
      createWindowsScheduler(async () => {
        throw new Error(sentinel);
      }),
      createWindowsScheduler(async () => ({ code: 1, stdout: sentinel, stderr: sentinel })),
    ];

    for (const scheduler of schedulers) {
      const error = (await scheduler.query(TASK_IDENTITY).catch((caught) => caught)) as Error;
      expect(error.message).toBe("scheduled task query failed");
      expect(error.message).not.toContain(sentinel);
    }
  });

  test("task query distinguishes duplicate and wrong-path identity from malformed payloads", async () => {
    const cases: Array<[string, string]> = [
      ["duplicate", "__AMBIGUOUS__"],
      ["wrong path", JSON.stringify(taskQueryPayload({ TaskPath: "\\Vendor\\" }))],
      ["wrong name", JSON.stringify(taskQueryPayload({ TaskName: `${RUNNER_SCHEDULED_TASK}-collision` }))],
    ];

    for (const [label, stdout] of cases) {
      const scheduler = createWindowsScheduler(async () => ({ code: 0, stdout, stderr: "" }));
      const error = (await scheduler.query(TASK_IDENTITY).catch((caught) => caught)) as Error;
      expect(error.message, label).toBe("scheduled task query returned ambiguous identity");
      expect(error.message, label).not.toContain("Vendor");
    }
  });

  test("task query preserves total action and trigger cardinality with singular fields only for one", async () => {
    const secondAction = { Execute: "cmd.exe", Arguments: "/c exit 0" };
    const secondTrigger = { Kind: "MSFT_TaskBootTrigger", User: null };
    const cases: Array<[string, Record<string, unknown>, Partial<ScheduledTaskInfo>]> = [
      [
        "zero actions",
        { ActionCount: 0, Actions: [] },
        { actionCount: 0, actionExecutable: null, actionArguments: null },
      ],
      [
        "one action",
        { ActionCount: 1, Actions: [{ Execute: "", Arguments: "" }] },
        { actionCount: 1, actionExecutable: "", actionArguments: "" },
      ],
      [
        "extra actions",
        { ActionCount: 2, Actions: [{ Execute: "powershell.exe", Arguments: "" }, secondAction] },
        { actionCount: 2, actionExecutable: null, actionArguments: null },
      ],
      [
        "zero triggers",
        { TriggerCount: 0, Triggers: [] },
        { triggerCount: 0, triggerKind: null, triggerUser: null },
      ],
      [
        "extra triggers",
        {
          TriggerCount: 2,
          Triggers: [{ Kind: "MSFT_TaskLogonTrigger", User: TEST_PRINCIPAL }, secondTrigger],
        },
        { triggerCount: 2, triggerKind: null, triggerUser: null },
      ],
    ];

    for (const [label, overrides, expected] of cases) {
      const scheduler = createWindowsScheduler(async () => ({
        code: 0,
        stdout: JSON.stringify(taskQueryPayload(overrides)),
        stderr: "",
      }));
      expect(await scheduler.query(TASK_IDENTITY), label).toMatchObject(expected);
    }
  });

  test("task query rejects malformed members and inconsistent provider counts without filtering", async () => {
    const malformed: Array<[string, Record<string, unknown>]> = [
      ["action count type", { ActionCount: "1" }],
      ["action count mismatch", { ActionCount: 2 }],
      ["action row null", { Actions: [null] }],
      [
        "second action malformed",
        { ActionCount: 2, Actions: [{ Execute: "powershell.exe", Arguments: "" }, null] },
      ],
      ["action execute null", { Actions: [{ Execute: null, Arguments: "" }] }],
      ["action arguments object", { Actions: [{ Execute: "powershell.exe", Arguments: {} }] }],
      ["trigger count mismatch", { TriggerCount: 2 }],
      ["trigger row scalar", { Triggers: ["AtLogOn"] }],
      [
        "second trigger malformed",
        {
          TriggerCount: 2,
          Triggers: [{ Kind: "MSFT_TaskLogonTrigger", User: TEST_PRINCIPAL }, { Kind: [], User: null }],
        },
      ],
      ["trigger kind empty", { Triggers: [{ Kind: "", User: TEST_PRINCIPAL }] }],
      ["trigger user object", { Triggers: [{ Kind: "MSFT_TaskLogonTrigger", User: {} }] }],
      ["principal null", { Principal: null }],
      ["principal user type", { Principal: { UserId: 7, LogonType: "Interactive", RunLevel: "Limited" } }],
      ["settings null", { Settings: null }],
      [
        "settings multiple-instances type",
        { Settings: { ...taskQueryPayload().Settings as object, MultipleInstances: 7 } },
      ],
      [
        "settings battery type",
        { Settings: { ...taskQueryPayload().Settings as object, AllowStartIfOnBatteries: "true" } },
      ],
      [
        "settings restart count negative",
        { Settings: { ...taskQueryPayload().Settings as object, RestartCount: -1 } },
      ],
      [
        "settings interval type",
        { Settings: { ...taskQueryPayload().Settings as object, RestartInterval: null } },
      ],
    ];

    for (const [label, overrides] of malformed) {
      const scheduler = createWindowsScheduler(async () => ({
        code: 0,
        stdout: JSON.stringify(taskQueryPayload(overrides)),
        stderr: "RAW_MALFORMED_TASK_SENTINEL",
      }));
      const error = (await scheduler.query(TASK_IDENTITY).catch((caught) => caught)) as Error;
      expect(error.message, label).toBe("scheduled task query returned malformed output");
      expect(error.message, label).not.toContain("SENTINEL");
    }
  });

  test("task predicates require exact identity, action cardinality, and persistence while accepting principal case", async () => {
    const { state } = await freshState();
    const spec = buildRunnerTaskSpec(state, TEST_PRINCIPAL);
    const canonical = taskInfo({
      name: RUNNER_SCHEDULED_TASK,
      actionExecutable: spec.executable,
      actionArguments: spec.arguments,
      triggerUser: TEST_PRINCIPAL.toLowerCase(),
      principalUser: TEST_PRINCIPAL.toUpperCase(),
    });

    expect(taskMatchesSpec(canonical, spec)).toBe(true);
    expect(taskHasCanonicalPersistence(canonical, spec)).toBe(true);
    expect(taskHasCanonicalPersistence({ ...canonical, enabled: false }, spec)).toBe(true);
    expect(taskMatchesSpec({ ...canonical, path: "\\Other\\" }, spec)).toBe(false);
    expect(taskMatchesSpec({ ...canonical, actionCount: 0 }, spec)).toBe(false);
    expect(taskMatchesSpec({ ...canonical, actionCount: 2 }, spec)).toBe(false);
    expect(taskMatchesSpec({ ...canonical, actionExecutable: "cmd.exe" }, spec)).toBe(false);
    expect(taskMatchesSpec({ ...canonical, actionArguments: `${spec.arguments} --drift` }, spec)).toBe(false);
    expect(taskHasCanonicalPersistence({ ...canonical, triggerCount: 0 }, spec)).toBe(false);
    expect(taskHasCanonicalPersistence({ ...canonical, triggerCount: 2 }, spec)).toBe(false);
    expect(taskHasCanonicalPersistence({ ...canonical, triggerKind: "AtStartup" }, spec)).toBe(false);
    expect(taskHasCanonicalPersistence({ ...canonical, triggerUser: "OTHER\\user" }, spec)).toBe(false);
    expect(taskHasCanonicalPersistence({ ...canonical, principalUser: "OTHER\\user" }, spec)).toBe(false);
    expect(taskHasCanonicalPersistence({ ...canonical, principalLogonType: "Password" }, spec)).toBe(false);
    expect(taskHasCanonicalPersistence({ ...canonical, principalRunLevel: "Highest" }, spec)).toBe(false);
    expect(taskHasCanonicalPersistence({ ...canonical, multipleInstances: "Parallel" }, spec)).toBe(false);
    expect(taskHasCanonicalPersistence({ ...canonical, allowStartIfOnBatteries: false }, spec)).toBe(false);
    expect(taskHasCanonicalPersistence({ ...canonical, dontStopIfGoingOnBatteries: false }, spec)).toBe(false);
    expect(taskHasCanonicalPersistence({ ...canonical, restartCount: 0 }, spec)).toBe(false);
    expect(taskHasCanonicalPersistence({ ...canonical, restartInterval: "PT5M" }, spec)).toBe(false);
    expect(taskHasCanonicalPersistence({ ...canonical, executionTimeLimit: "PT72H" }, spec)).toBe(false);
  });

  test("every scheduler mutation targets the accepted name and root path", async () => {
    const { state } = await freshState();
    const spec = buildRunnerTaskSpec(state, TEST_PRINCIPAL);
    const scripts: string[] = [];
    const scheduler = createWindowsScheduler(async (script) => {
      scripts.push(script);
      return { code: 0, stdout: "", stderr: "" };
    });

    await scheduler.create(spec);
    await scheduler.setEnabled(spec, true);
    await scheduler.start(spec);

    expect(scripts).toHaveLength(3);
    for (const script of scripts) {
      expect(script).toContain(`-TaskName ${psQuote(RUNNER_SCHEDULED_TASK)}`);
      expect(script).toContain(`-TaskPath ${psQuote(RUNNER_SCHEDULED_TASK_PATH)}`);
      expect(script).not.toContain("rename");
      expect(script).not.toContain("migrate");
    }
    expect(scripts[0]).toContain(`-AtLogOn -User ${psQuote(TEST_PRINCIPAL)}`);
    expect(scripts[0]).toContain(`-UserId ${psQuote(TEST_PRINCIPAL)} -LogonType Interactive -RunLevel Limited`);
  });

  test.skipIf(process.platform !== "win32")(
    "query fails closed when Get-ScheduledTask emits a task and a nonterminating provider error",
    async () => {
      const name = RUNNER_SCHEDULED_TASK;
      const sentinelProvider = "PROVIDER_ACCESS_DENIED_SENTINEL_7a3f";
      const sentinelTaskExecute = "powershell.exe";
      const sentinelTaskArguments = '-File "C:\\\\sentinel\\\\launcher.ps1" runner run';
      let capturedScript = "";
      let childExitCode: number | null = null;

      const scheduler = createWindowsScheduler(async (script) => {
        capturedScript = script;
        const mockFunction =
          `function Get-ScheduledTask { ` +
          `[CmdletBinding()] ` +
          `param([Parameter(ValueFromPipeline=$true)][string]$TaskName) ` +
          `[pscustomobject]@{ ` +
          `TaskName = ${psQuote(name)}; ` +
          `State = 'Ready'; ` +
          `Settings = [pscustomobject]@{ Enabled = $true }; ` +
          `Actions = @([pscustomobject]@{ Execute = ${psQuote(sentinelTaskExecute)}; Arguments = ${psQuote(sentinelTaskArguments)} }) ` +
          `}; ` +
          `Write-Error ${psQuote(`Provider failure: ${sentinelProvider}`)} -ErrorAction Continue ` +
          `}`;
        const wrapped = `${mockFunction}; ${script}`;
        const child = Bun.spawn(
          ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", wrapped],
          { stdout: "pipe", stderr: "pipe" },
        );
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        childExitCode = code;
        return { code, stdout, stderr };
      });

      const error = (await scheduler.query(TASK_IDENTITY).catch((e) => e)) as Error;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toMatch(/scheduled task query failed/);
      expect(childExitCode).not.toBe(0);
      expect(capturedScript).not.toContain("Get-ScheduledTaskInfo");
      expect(capturedScript).toContain("-ErrorVariable queryErr");
      expect(error.message).not.toContain(sentinelProvider);
      expect(error.message).not.toContain(sentinelTaskExecute);
      expect(error.message).not.toContain(sentinelTaskArguments);
    },
  );
});

describe("Windows scheduled task in-memory definition", () => {
  test.skipIf(process.platform !== "win32")(
    "constructs action, user trigger, Limited principal, settings, and definition without registering",
    async () => {
      const { state } = await freshState();
      const record = makePartialRecord(state);
      const spec = buildRunnerTaskSpec(state, currentWindowsPrincipal());
      const principal = currentWindowsPrincipal();

      const script =
        `$ErrorActionPreference = 'Stop'; ` +
        `$action = New-ScheduledTaskAction -Execute ${psQuote(spec.executable)} -Argument ${psQuote(spec.arguments)}; ` +
        `$trigger = New-ScheduledTaskTrigger -AtLogOn -User ${psQuote(principal)}; ` +
        `$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries ` +
        `-DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) ` +
        `-ExecutionTimeLimit ([TimeSpan]::Zero); ` +
        `$principal = New-ScheduledTaskPrincipal -UserId ${psQuote(principal)} -LogonType Interactive -RunLevel Limited; ` +
        `$definition = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal; ` +
        `[pscustomobject]@{ ` +
        `Execute = [string]$definition.Actions[0].Execute; ` +
        `Arguments = [string]$definition.Actions[0].Arguments; ` +
        `TriggerUser = [string]$definition.Triggers[0].UserId; ` +
        `RunLevel = [string]$definition.Principal.RunLevel ` +
        `} | ConvertTo-Json -Compress`;

      const child = Bun.spawn(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).toBe(0);
      expect(stderr).toBe("");
      const parsed = JSON.parse(stdout.trim()) as {
        Execute: string;
        Arguments: string;
        TriggerUser: string;
        RunLevel: string;
      };
      expect(parsed.Execute).toBe(spec.executable);
      expect(parsed.Arguments).toBe(spec.arguments);
      expect(parsed.TriggerUser.toLowerCase()).toBe(principal.toLowerCase());
      expect(parsed.RunLevel).toBe("Limited");
    },
  );

  test.skipIf(process.platform === "win32")("is skipped off Windows", () => {
    expect(true).toBe(true);
  });
});
