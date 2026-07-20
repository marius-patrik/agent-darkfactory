import path from "node:path";
import { spawn } from "node:child_process";
import { chmod, mkdir, readdir, stat } from "node:fs/promises";
import type { SharedState } from "./state";

export interface GitHubSecretSyncOptions {
  name: string;
  targetName?: string;
  owner?: string;
  repo?: string;
  includeArchived?: boolean;
  dryRun?: boolean;
}

export interface GitHubSecretSyncResult {
  repo: string;
  status: "set" | "dry-run";
  targetName: string;
}

export function validateSecretName(name: string): string {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
    throw new Error(`invalid secret name: ${name}`);
  }
  return name;
}

export function secretPath(state: SharedState, name: string): string {
  return path.join(state.secretsDir, `${validateSecretName(name)}.secret`);
}

export async function writeSecret(state: SharedState, name: string, value: string): Promise<string> {
  const file = secretPath(state, name);
  await mkdir(state.secretsDir, { recursive: true });
  if (process.platform !== "win32") await chmod(state.secretsDir, 0o700);
  await Bun.write(file, value);
  if (process.platform !== "win32") await chmod(file, 0o600);
  return file;
}

export async function readSecret(state: SharedState, name: string): Promise<string> {
  const file = secretPath(state, name);
  if (!(await exists(file))) throw new Error(`secret not found: ${name}`);
  return Bun.file(file).text();
}

export async function listSecrets(state: SharedState): Promise<string[]> {
  if (!(await exists(state.secretsDir))) return [];
  const entries = await readdir(state.secretsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".secret"))
    .map((entry) => entry.name.slice(0, -".secret".length))
    .sort();
}

export async function syncGitHubSecret(
  state: SharedState,
  options: GitHubSecretSyncOptions,
): Promise<GitHubSecretSyncResult[]> {
  const name = validateSecretName(options.name);
  const targetName = validateSecretName(options.targetName ?? name);
  const value = await readSecret(state, name);
  if (!options.repo && !options.owner) throw new Error("secrets github sync requires --repo or --owner");
  const repos = options.repo ? [options.repo] : await listGitHubRepositories(options.owner as string, Boolean(options.includeArchived));
  const results: GitHubSecretSyncResult[] = [];

  for (const repo of repos) {
    if (!options.dryRun) await runGh(["secret", "set", targetName, "--repo", repo], value);
    results.push({ repo, status: options.dryRun ? "dry-run" : "set", targetName });
  }

  return results;
}

async function listGitHubRepositories(owner: string, includeArchived: boolean): Promise<string[]> {
  const output = await runGh(["repo", "list", owner, "--limit", "200", "--json", "nameWithOwner,isArchived"]);
  const repos = JSON.parse(output) as Array<{ nameWithOwner?: string; isArchived?: boolean }>;
  return repos
    .filter((repo) => repo.nameWithOwner && (includeArchived || !repo.isArchived))
    .map((repo) => repo.nameWithOwner as string);
}

async function runGh(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const err = Buffer.concat(stderr).toString("utf8").trim();
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else reject(new Error(err || `gh exited with code ${code}`));
    });
    child.stdin.end(input ?? "");
  });
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}
