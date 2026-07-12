import path from "node:path";
import { lstat, readFile, realpath } from "node:fs/promises";
import type { SharedState } from "./state";
import { stateV2Paths, writeTextAtomic } from "./state-v2";

export interface SourceComponentPin {
  path: string;
  commit: string;
}

export interface SourceInstallRecord {
  schemaVersion: 1;
  sourceRoot: string;
  repository: string;
  branch: string;
  commit: string;
  components: SourceComponentPin[];
  recordedAt: string;
}

export interface SourceInstallInspection {
  ok: boolean;
  record: SourceInstallRecord | null;
  issues: string[];
}

export function sourceInstallFile(state: SharedState): string {
  return path.join(stateV2Paths(state).provenanceDir, "install.json");
}

async function git(root: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(stderr.trim() || `git ${args.join(" ")} exited with ${code}`);
  return stdout.trim();
}

async function currentSource(state: SharedState): Promise<Omit<SourceInstallRecord, "schemaVersion" | "recordedAt">> {
  const root = path.resolve(state.root);
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`source root must be a physical directory: ${root}`);
  const topLevel = path.resolve(await git(root, ["rev-parse", "--show-toplevel"]));
  if ((await realpath(topLevel)) !== (await realpath(root))) {
    throw new Error(`AGENTS_ROOT is not the Git top level: ${root}`);
  }
  const status = await git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status) throw new Error(`canonical source checkout is dirty: ${root}`);
  const repository = await git(root, ["remote", "get-url", "origin"]);
  const branch = await git(root, ["branch", "--show-current"]);
  if (!repository || !branch) throw new Error("canonical source checkout requires an origin and named branch");
  const commit = await git(root, ["rev-parse", "HEAD"]);
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("canonical source commit is invalid");
  const componentOutput = await git(root, ["submodule", "status", "--recursive"]);
  const components: SourceComponentPin[] = [];
  for (const line of componentOutput.split("\n").filter(Boolean)) {
    const match = line.match(/^ ([a-f0-9]{40}) (\S+)(?: .*)?$/);
    if (!match) throw new Error(`component is uninitialized or does not match its gitlink: ${line}`);
    components.push({ path: match[2], commit: match[1] });
  }
  components.sort((left, right) => left.path.localeCompare(right.path));
  return { sourceRoot: root, repository, branch, commit, components };
}

function assertRecord(value: unknown, filePath: string): SourceInstallRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid source install record: ${filePath}`);
  const record = value as Partial<SourceInstallRecord>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.sourceRoot !== "string" ||
    !path.isAbsolute(record.sourceRoot) ||
    typeof record.repository !== "string" ||
    !record.repository ||
    typeof record.branch !== "string" ||
    !record.branch ||
    typeof record.commit !== "string" ||
    !/^[a-f0-9]{40}$/.test(record.commit) ||
    typeof record.recordedAt !== "string" ||
    new Date(record.recordedAt).toISOString() !== record.recordedAt ||
    !Array.isArray(record.components)
  ) {
    throw new Error(`invalid source install record: ${filePath}`);
  }
  const seen = new Set<string>();
  for (const component of record.components) {
    if (
      !component ||
      typeof component.path !== "string" ||
      !component.path ||
      path.isAbsolute(component.path) ||
      component.path.split("/").includes("..") ||
      typeof component.commit !== "string" ||
      !/^[a-f0-9]{40}$/.test(component.commit) ||
      seen.has(component.path)
    ) {
      throw new Error(`invalid source component pin: ${filePath}`);
    }
    seen.add(component.path);
  }
  return record as SourceInstallRecord;
}

export async function readSourceInstall(state: SharedState): Promise<SourceInstallRecord | null> {
  const filePath = sourceInstallFile(state);
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`source install record must be a physical file: ${filePath}`);
    return assertRecord(JSON.parse(await readFile(filePath, "utf8")), filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function recordSourceInstall(state: SharedState, now = new Date()): Promise<SourceInstallRecord> {
  const current = await currentSource(state);
  const existing = await readSourceInstall(state);
  const comparable = existing
    ? { sourceRoot: existing.sourceRoot, repository: existing.repository, branch: existing.branch, commit: existing.commit, components: existing.components }
    : null;
  const record: SourceInstallRecord = {
    schemaVersion: 1,
    ...current,
    recordedAt:
      comparable && JSON.stringify(comparable) === JSON.stringify(current) ? existing!.recordedAt : now.toISOString(),
  };
  await writeTextAtomic(sourceInstallFile(state), `${JSON.stringify(record, null, 2)}\n`, 0o600);
  return record;
}

export async function inspectSourceInstall(state: SharedState): Promise<SourceInstallInspection> {
  const issues: string[] = [];
  let record: SourceInstallRecord | null = null;
  try {
    record = await readSourceInstall(state);
    if (!record) throw new Error(`source install record is missing: ${sourceInstallFile(state)}`);
    const current = await currentSource(state);
    const recorded = {
      sourceRoot: record.sourceRoot,
      repository: record.repository,
      branch: record.branch,
      commit: record.commit,
      components: record.components,
    };
    if (JSON.stringify(recorded) !== JSON.stringify(current)) {
      throw new Error("canonical source checkout does not match the recorded clean install");
    }
  } catch (error) {
    issues.push((error as Error).message);
  }
  return { ok: issues.length === 0, record, issues };
}
