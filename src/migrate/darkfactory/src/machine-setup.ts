import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import type { SetupReceipt } from "./setup.js";

export interface MachineProcessResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type MachineProcessRunner = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
) => MachineProcessResult;

export interface MachineConvergenceInput {
  agentsHome: string;
  packageRoot: string;
  findingIds: string[];
  trustedRevision?: string;
  run?: MachineProcessRunner;
  platform?: NodeJS.Platform;
}

const PACKAGE_FINDINGS = new Set([
  "darkfactory-package-unregistered",
  "darkfactory-command-unrunnable"
]);

const RUNNER_FINDINGS = new Set([
  "df-local-runner-missing",
  "df-local-runner-offline",
  "df-local-runner-persistence-unproven"
]);

export async function convergeMachineRuntime(input: MachineConvergenceInput): Promise<SetupReceipt[]> {
  const platform = input.platform ?? process.platform;
  const agentsHome = exactDirectory(input.agentsHome, "AGENTS_HOME");
  const packageRoot = exactDirectory(input.packageRoot, "DarkFactory package root");
  const launcher = path.join(agentsHome, "bin", platform === "win32" ? "agents.ps1" : "agents");
  if (!existsSync(launcher)) throw new Error(`canonical Agent OS launcher is missing at ${launcher}`);
  if (!existsSync(path.join(packageRoot, "agent.package.json")) || !existsSync(path.join(packageRoot, "package.json"))) {
    throw new Error("DarkFactory package root is missing its trusted manifests");
  }

  const run = input.run ?? defaultProcessRunner;
  const landedRevision = assertTrustedLandedPackage(packageRoot, run, input.trustedRevision);
  const invokeAgents = (args: string[], allowFailure = false): MachineProcessResult => {
    const command = platform === "win32" ? "pwsh" : launcher;
    const commandArgs = platform === "win32"
      ? ["-NoProfile", "-File", launcher, ...args]
      : args;
    const result = run(command, commandArgs, { cwd: packageRoot, env: { ...process.env, AGENTS_HOME: agentsHome } });
    if (!allowFailure && result.status !== 0) throw commandFailure(`agents ${args.join(" ")}`, result);
    return result;
  };

  const doctor = parseJson(invokeAgents(["state", "doctor", "--json"], true), "Agent OS state doctor");
  if (!isRecord(doctor) || doctor.ok !== true || !hasHealthyCheck(doctor, "state_repository") || !hasHealthyCheck(doctor, "launcher")) {
    throw new Error("canonical Agent OS state or launcher authority is unhealthy; machine setup refused every mutation");
  }

  const findings = new Set(input.findingIds);
  const receipts: SetupReceipt[] = [];
  if ([...findings].some((id) => PACKAGE_FINDINGS.has(id))) {
    const npm = platform === "win32" ? "npm.cmd" : "npm";
    const build = run(npm, ["run", "build"], { cwd: packageRoot, env: { ...process.env, AGENTS_HOME: agentsHome } });
    if (build.status !== 0) throw commandFailure("npm run build", build);
    invokeAgents(["packages", "register", packageRoot]);
    const packages = parseJson(invokeAgents(["packages", "list", "--json"]), "Agent OS package registry");
    if (!Array.isArray(packages) || !packages.some((entry) => isRecord(entry) && entry.id === "darkfactory" && path.resolve(String(entry.path || "")) === packageRoot)) {
      throw new Error("DarkFactory package registration did not converge to the exact trusted package root");
    }
    invokeAgents(["packages", "run", "darkfactory", "--", "--help"]);
    receipts.push({
      action: "machine-package-binding",
      target: "canonical-agent-os",
      status: "applied",
      detail: `Built the trusted landed DarkFactory package at ${landedRevision}, registered its exact root, and proved the package-owned CLI help runs through Agent OS.`
    });
  }

  if ([...findings].some((id) => RUNNER_FINDINGS.has(id))) {
    const before = parseJson(invokeAgents(["runner", "status", "--json"], true), "Agent OS runner status");
    const action = isRecord(before) && before.installed === true ? "repair" : "install";
    invokeAgents(["runner", action, "--json"]);
    const after = parseJson(invokeAgents(["runner", "status", "--json"], true), "Agent OS runner status after convergence");
    if (!runnerReady(after)) throw new Error("Agent OS runner convergence completed without a healthy persistent df-local registration");
    receipts.push({
      action: "machine-runner-lifecycle",
      target: "canonical-agent-os",
      status: "applied",
      detail: `Ran the bounded Agent OS runner ${action} operation and re-proved registration, online state, persistence, and launcher binding.`
    });
  }

  if (receipts.length === 0) {
    receipts.push({
      action: "machine-runtime",
      target: "canonical-agent-os",
      status: "current",
      detail: "No repairable machine-runtime finding remained after exact Agent OS authority validation."
    });
  }
  return receipts;
}

function assertTrustedLandedPackage(packageRoot: string, run: MachineProcessRunner, expectedRevision?: string): string {
  const invokeGit = (args: string[], label: string, allowFailure = false): MachineProcessResult => {
    const result = run("git", args, { cwd: packageRoot, env: { ...process.env } });
    if (!allowFailure && result.status !== 0) throw commandFailure(label, result);
    return result;
  };
  const head = exactRevision(invokeGit(["rev-parse", "HEAD"], "DarkFactory package HEAD").stdout, "DarkFactory package HEAD");
  const status = invokeGit(["status", "--porcelain"], "DarkFactory package status").stdout.trim();
  if (status) throw new Error("DarkFactory package checkout is dirty; machine setup refused global registration");
  const origin = invokeGit(["remote", "get-url", "origin"], "DarkFactory package origin").stdout.trim();
  if (!isCanonicalDarkFactoryRemote(origin)) {
    throw new Error("DarkFactory package checkout origin is not canonical; machine setup refused global registration");
  }
  const remoteMain = invokeGit(["ls-remote", "--exit-code", "origin", "refs/heads/main"], "DarkFactory protected main").stdout.trim();
  const match = remoteMain.match(/^([0-9a-f]{40})\s+refs\/heads\/main$/i);
  if (!match) throw new Error("DarkFactory protected main did not resolve to one exact revision");
  const mainHead = match[1].toLowerCase();
  if (head !== mainHead) throw new Error("DarkFactory package checkout is not the exact landed protected main revision");
  if (expectedRevision !== undefined) {
    const expected = exactRevision(expectedRevision, "trusted DarkFactory control revision");
    if (head !== expected) throw new Error("DarkFactory package checkout does not match the trusted control revision");
  }
  return head;
}

function exactRevision(value: string, label: string): string {
  const revision = String(value || "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error(`${label} must be one exact commit`);
  return revision;
}

function isCanonicalDarkFactoryRemote(value: string): boolean {
  const remote = String(value || "").trim().replace(/\\/g, "/");
  if (/^git@github\.com:marius-patrik\/DarkFactory(?:\.git)?$/i.test(remote)) return true;
  try {
    const url = new URL(remote);
    return url.hostname.toLowerCase() === "github.com"
      && url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").toLowerCase() === "marius-patrik/darkfactory";
  } catch {
    return false;
  }
}

function defaultProcessRunner(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): MachineProcessResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024
  });
  return {
    status: result.status,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    ...(result.error ? { error: result.error } : {})
  };
}

function exactDirectory(value: string, label: string): string {
  const candidate = String(value || "").trim();
  if (!path.isAbsolute(candidate) || candidate.includes("\0")) throw new Error(`${label} must be an absolute path`);
  const resolved = path.resolve(candidate);
  if (!existsSync(resolved)) throw new Error(`${label} does not exist at ${resolved}`);
  return resolved;
}

function parseJson(result: MachineProcessResult, label: string): unknown {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${label} did not return valid JSON`);
  }
}

function hasHealthyCheck(report: Record<string, unknown>, id: string): boolean {
  return Array.isArray(report.checks) && report.checks.some((entry) => isRecord(entry) && entry.id === id && entry.ok === true);
}

function runnerReady(value: unknown): boolean {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.readiness)) return false;
  const readiness = value.readiness;
  return ["installed", "registered", "enabled", "persistent", "process", "online", "launcherBinding"]
    .every((key) => readiness[key] === true);
}

function commandFailure(label: string, result: MachineProcessResult): Error {
  const cause = result.error?.message || `exit ${String(result.status)}`;
  return new Error(`${label} failed (${cause}); command output is withheld from receipts`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
