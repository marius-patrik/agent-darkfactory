import path from "node:path";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import type { SharedState } from "./state";
import { SYSTEM_DATA_REPOSITORY } from "./state";
import { eventSyncStatus, exportEventBundle, importEventBundle, inspectEventBundle, type EventSyncResult } from "./event-sync";
import { stateV2Paths } from "./state-v2";

const CANONICAL_BRANCH = "main";
const BACKUP_DIRECTORY = path.join("backups", "events");
const SAFE_MACHINE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REQUIRED_CONTRACT_FILES = [".gitignore", "agent.package.json", "README.md", "scripts/validate.mjs"];

export interface StateRepositoryStatus {
  checkout: boolean;
  repository: string | null;
  branch: string | null;
  trackedClean: boolean;
  backupBundles: number;
  issues: string[];
}

export interface StateRepositoryBackup {
  bundle: string;
  payloadHash: string;
  entries: number;
  committed: boolean;
}

export interface StateRepositoryRestore {
  bundles: number;
  imported: number;
  skipped: number;
  projectionHash: string | null;
}

export interface StateRepositorySync {
  restored: StateRepositoryRestore;
  backup: StateRepositoryBackup;
  pushed: boolean;
}

interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function git(
  state: SharedState,
  args: string[],
  allowFailure = false,
  env: Record<string, string | undefined> = process.env,
): Promise<GitResult> {
  const child = Bun.spawn(["git", "-C", state.stateDir, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const result = { stdout: stdout.trim(), stderr: stderr.trim(), code };
  if (!allowFailure && code !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args[0] ?? "command"} exited with code ${code}`);
  }
  return result;
}

function normalizedRepository(remote: string): string | null {
  const normalized = remote.trim().replace(/\\/g, "/").replace(/\.git$/i, "");
  const match = normalized.match(/^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+\/[^/]+)$/i);
  return match?.[1] ?? null;
}

async function physicalPathUnderState(
  state: SharedState,
  target: string,
  allowMissing = false,
): Promise<boolean> {
  const root = path.resolve(state.stateDir);
  const resolved = path.resolve(target);
  const relative = path.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`state repository path escapes AGENTS_HOME: ${resolved}`);
  }
  let current = root;
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(`state repository path contains a symbolic link: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && allowMissing) return false;
      throw error;
    }
  }
  return true;
}

async function trackedBackupBundleFiles(state: SharedState): Promise<Array<{ file: string; payloadHash: string }>> {
  const result = await git(state, ["ls-files", "-z", "--", BACKUP_DIRECTORY.split(path.sep).join("/")]);
  const output: Array<{ file: string; payloadHash: string }> = [];
  for (const relative of result.stdout.split("\0").filter(Boolean).sort()) {
    const match = relative.match(/^backups\/events\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/([a-f0-9]{64})\.bundle\.json$/);
    if (!match || !SAFE_MACHINE_ID.test(match[1])) throw new Error(`invalid tracked state backup path: ${relative}`);
    const file = path.join(state.stateDir, ...relative.split("/"));
    await physicalPathUnderState(state, file);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`tracked state backup must be a physical file: ${relative}`);
    output.push({ file, payloadHash: match[2] });
  }
  return output;
}

export async function inspectStateRepository(state: SharedState): Promise<StateRepositoryStatus> {
  const issues: string[] = [];
  const top = await git(state, ["rev-parse", "--show-toplevel"], true);
  const checkout = top.code === 0 && path.resolve(top.stdout) === path.resolve(state.stateDir);
  if (!checkout) issues.push("AGENTS_HOME is not the root of a Git working tree");

  if (checkout) {
    const head = await git(state, ["rev-parse", "--verify", "HEAD^{commit}"], true);
    if (head.code !== 0 || !/^[a-f0-9]{40,64}$/i.test(head.stdout)) {
      issues.push("state repository has no committed HEAD");
    }
    for (const file of REQUIRED_CONTRACT_FILES) {
      const tracked = await git(state, ["ls-files", "--error-unmatch", "--", file], true);
      if (tracked.code !== 0) issues.push(`state repository contract file is not tracked: ${file}`);
    }
    try {
      const manifest = JSON.parse(await readFile(path.join(state.stateDir, "agent.package.json"), "utf8")) as {
        schemaVersion?: unknown;
        id?: unknown;
        kind?: unknown;
      };
      if (manifest.schemaVersion !== 1 || manifest.id !== "agent-os-data" || manifest.kind !== "data") {
        issues.push("state repository agent.package.json does not identify agent-os-data");
      }
    } catch (error) {
      issues.push(`state repository contract manifest is unreadable: ${(error as Error).message}`);
    }
  }

  const remote = checkout ? await git(state, ["remote", "get-url", "origin"], true) : null;
  const repository = remote?.code === 0 ? normalizedRepository(remote.stdout) : null;
  if (repository?.toLowerCase() !== SYSTEM_DATA_REPOSITORY.toLowerCase()) {
    issues.push(`origin must be ${SYSTEM_DATA_REPOSITORY}`);
  }

  const branchResult = checkout ? await git(state, ["branch", "--show-current"], true) : null;
  const branch = branchResult?.code === 0 && branchResult.stdout ? branchResult.stdout : null;
  if (branch !== CANONICAL_BRANCH) issues.push(`state repository branch must be ${CANONICAL_BRANCH}`);

  const status = checkout ? await git(state, ["status", "--porcelain", "--untracked-files=no"], true) : null;
  const trackedClean = status?.code === 0 && status.stdout === "";
  if (!trackedClean) issues.push("state repository has tracked changes");

  let backupBundles = 0;
  let syncReady = false;
  try {
    const sync = await eventSyncStatus(state);
    syncReady = sync.enabled && sync.transport === "encrypted-bundle" && sync.keyAvailable;
    if (!syncReady) issues.push("state repository requires enabled encrypted event exchange with a local key");
  } catch (error) {
    issues.push(`state repository event exchange is invalid: ${(error as Error).message}`);
  }
  try {
    const bundles = checkout ? await trackedBackupBundleFiles(state) : [];
    backupBundles = bundles.length;
    for (const bundle of syncReady ? bundles : []) {
      const inspection = await inspectEventBundle(state, bundle.file);
      if (inspection.payloadHash !== bundle.payloadHash) {
        throw new Error(`tracked state backup filename does not match authenticated payload: ${path.relative(state.stateDir, bundle.file)}`);
      }
    }
  } catch (error) {
    issues.push((error as Error).message);
  }

  return { checkout, repository, branch, trackedClean, backupBundles, issues };
}

async function requireStateRepository(state: SharedState): Promise<void> {
  const status = await inspectStateRepository(state);
  if (status.issues.length > 0) throw new Error(`invalid state repository: ${status.issues.join("; ")}`);
}

async function machineId(state: SharedState): Promise<string> {
  const manifest = JSON.parse(await readFile(stateV2Paths(state).manifestFile, "utf8")) as { machineId?: unknown };
  if (typeof manifest.machineId !== "string" || !SAFE_MACHINE_ID.test(manifest.machineId)) {
    throw new Error("state manifest has an invalid machine id");
  }
  return manifest.machineId;
}

export async function backupStateRepository(state: SharedState): Promise<StateRepositoryBackup> {
  await requireStateRepository(state);
  const id = await machineId(state);
  const temporary = path.join(stateV2Paths(state).syncDir, `repository-backup-${randomUUID()}.bundle.json`);
  const exported = await exportEventBundle(state, temporary);
  const relative = path.join(BACKUP_DIRECTORY, id, `${exported.payloadHash}.bundle.json`);
  const target = path.join(state.stateDir, relative);
  await physicalPathUnderState(state, path.dirname(target), true);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await physicalPathUnderState(state, path.dirname(target));
  try {
    await lstat(target);
    await physicalPathUnderState(state, target);
    const existing = await inspectEventBundle(state, target);
    if (existing.payloadHash !== exported.payloadHash || existing.entries !== exported.entries) {
      throw new Error(`immutable state backup collision: ${relative}`);
    }
    await rm(temporary, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await rename(temporary, target);
  }

  const gitPath = relative.split(path.sep).join("/");
  await git(state, ["add", "--", gitPath]);
  const staged = await git(state, ["diff", "--cached", "--quiet"], true);
  let committed = false;
  if (staged.code === 1) {
    await git(state, [
      "-c",
      "user.name=Agent OS State",
      "-c",
      "user.email=state@andromeda.invalid",
      "commit",
      "-m",
      `state: backup ${id} ${exported.payloadHash.slice(0, 12)}`,
    ], false, {
      ...process.env,
      GIT_AUTHOR_NAME: "Agent OS State",
      GIT_AUTHOR_EMAIL: "state@andromeda.invalid",
      GIT_COMMITTER_NAME: "Agent OS State",
      GIT_COMMITTER_EMAIL: "state@andromeda.invalid",
    });
    committed = true;
  } else if (staged.code !== 0) {
    throw new Error(staged.stderr || "unable to inspect staged state backup");
  }
  return { bundle: gitPath, payloadHash: exported.payloadHash, entries: exported.entries, committed };
}

export async function restoreStateRepository(state: SharedState): Promise<StateRepositoryRestore> {
  await requireStateRepository(state);
  const bundles = await trackedBackupBundleFiles(state);
  const preflight: Array<{ file: string }> = [];
  for (const bundle of bundles) {
    const inspection = await inspectEventBundle(state, bundle.file);
    if (inspection.payloadHash !== bundle.payloadHash) {
      throw new Error(`tracked state backup filename does not match authenticated payload: ${path.relative(state.stateDir, bundle.file)}`);
    }
    preflight.push({ file: bundle.file });
  }
  let imported = 0;
  let skipped = 0;
  let projectionHash: string | null = null;
  for (const bundle of preflight) {
    const result: EventSyncResult = await importEventBundle(state, bundle.file);
    imported += result.imported;
    skipped += result.skipped;
    projectionHash = result.projectionHash;
  }
  return { bundles: bundles.length, imported, skipped, projectionHash };
}

export async function syncStateRepository(state: SharedState): Promise<StateRepositorySync> {
  await requireStateRepository(state);
  await git(state, ["pull", "--rebase", "origin", CANONICAL_BRANCH]);
  let restored = await restoreStateRepository(state);
  let backup = await backupStateRepository(state);

  await git(state, ["pull", "--rebase", "origin", CANONICAL_BRANCH]);
  const secondRestore = await restoreStateRepository(state);
  if (secondRestore.imported > 0) {
    restored = {
      bundles: secondRestore.bundles,
      imported: restored.imported + secondRestore.imported,
      skipped: restored.skipped + secondRestore.skipped,
      projectionHash: secondRestore.projectionHash,
    };
    backup = await backupStateRepository(state);
  }
  await git(state, ["push", "origin", CANONICAL_BRANCH]);
  return { restored, backup, pushed: true };
}
