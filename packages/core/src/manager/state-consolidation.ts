import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { lstat, mkdir, readdir, readlink, rename, rm, stat } from "node:fs/promises";

export type ToolStateId = "claude" | "codex" | "kimi" | "agents";

export interface ToolStateSpec {
  id: ToolStateId;
  displayName: string;
  originalName: string;
}

export interface ToolStatus {
  id: ToolStateId;
  displayName: string;
  original: string;
  adopted: string;
  location: "in-place" | "adopted" | "missing" | "orphan" | "conflict";
  linkTarget: string | null;
}

export interface AdoptPlan {
  id: ToolStateId;
  original: string;
  adopted: string;
  action: "adopt" | "already-adopted" | "refuse";
  reason?: string;
}

export interface StateSyncConfig {
  schemaVersion: 1;
  include: string[];
  exclude?: string[];
}

export interface SyncCandidate {
  relPath: string;
  source: string;
  target: string;
  denied: boolean;
  denyReason?: string;
}

export interface SyncRepoStatus {
  configured: boolean;
  path: string;
  branch: string | null;
  clean: boolean | null;
  remoteUrl: string | null;
}

const home = os.homedir();

export const toolStateSpecs: ToolStateSpec[] = [
  { id: "claude", displayName: "Claude", originalName: ".claude" },
  { id: "codex", displayName: "Codex", originalName: ".codex" },
  { id: "kimi", displayName: "Kimi", originalName: ".kimi-code" },
  { id: "agents", displayName: "Agents", originalName: ".agents" },
];

export function toolOriginalPath(id: ToolStateId, homeDir = home): string {
  const spec = toolStateSpecs.find((s) => s.id === id);
  if (!spec) throw new Error(`unknown tool state id: ${id}`);
  return path.join(homeDir, spec.originalName);
}

export function toolAdoptedPath(id: ToolStateId, agentsHome = defaultAgentsHome()): string {
  if (id === "agents") return agentsHome;
  return path.join(agentsHome, "state", id);
}

export function defaultAgentsHome(): string {
  return process.env.AGENTS_HOME?.trim() ? path.resolve(process.env.AGENTS_HOME.trim()) : path.join(home, ".agents");
}

export function stateRepoPath(agentsHome = defaultAgentsHome()): string {
  return path.join(agentsHome, "state-repo");
}

export function syncConfigPath(agentsHome = defaultAgentsHome()): string {
  return path.join(agentsHome, "state-sync.json");
}

export const defaultSyncConfig: StateSyncConfig = {
  schemaVersion: 1,
  include: [
    "skills/**",
    "bin/**",
    "state/**",
    "sessions/**",
    "orchestrator/**",
    "clis/**/config.*",
    "clis/**/settings.*",
    "data-repos.json",
    "packages.json",
    "installs.json",
    "environments.json",
  ],
};

const hardDenyComponents = [
  ".git",
  "node_modules",
  "auth",
  "token",
  "secret",
  "credential",
  "credentials",
  "key",
  "keys",
  "cookie",
  "cache",
  "caches",
  "log",
  "logs",
  "history",
  "histories",
];

// Session transcript files are intentionally allowed because they are part of the
// session ledger that must sync across machines.
const alwaysAllowedFileNames = new Set(["transcript.json", "transcripts.json"]);

function componentLooksDenied(component: string): boolean {
  const lower = component.toLowerCase();
  for (const denied of hardDenyComponents) {
    if (lower === denied || lower.includes(denied)) return true;
  }
  return false;
}

export function isPathHardDenied(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  const basename = parts[parts.length - 1] ?? "";
  if (alwaysAllowedFileNames.has(basename.toLowerCase())) return false;
  for (const part of parts) {
    if (componentLooksDenied(part)) return true;
  }
  return false;
}

function globSegmentMatches(segment: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern === segment) return true;
  if (pattern.includes("*")) {
    const regex = new RegExp(`^${pattern.replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*")}$`);
    return regex.test(segment);
  }
  return false;
}

export function matchesGlob(relPath: string, pattern: string): boolean {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\//, "");
  const parts = normalized.split("/");
  const segments = pattern.replace(/\\/g, "/").replace(/^\//, "").split("/");
  let pi = 0;
  let si = 0;
  while (si < segments.length) {
    const seg = segments[si];
    if (seg === "**") {
      si += 1;
      if (si === segments.length) return true;
      const next = segments[si];
      while (pi < parts.length && !globSegmentMatches(parts[pi], next)) {
        pi += 1;
      }
      if (pi === parts.length) return false;
    } else {
      if (pi >= parts.length) return false;
      if (!globSegmentMatches(parts[pi], seg)) return false;
      pi += 1;
      si += 1;
    }
  }
  return pi === parts.length;
}

export function isPathIncluded(relPath: string, config: StateSyncConfig): boolean {
  if (config.exclude?.some((pattern) => matchesGlob(relPath, pattern))) return false;
  return config.include.some((pattern) => matchesGlob(relPath, pattern));
}

export function isPathAllowed(relPath: string, config: StateSyncConfig): { allowed: boolean; reason?: string } {
  if (isPathHardDenied(relPath)) {
    return { allowed: false, reason: "hard denylist" };
  }
  if (!isPathIncluded(relPath, config)) {
    return { allowed: false, reason: "not in allowlist" };
  }
  return { allowed: true };
}

async function pathLinkInfo(filePath: string): Promise<{ exists: boolean; isLink: boolean; target: string | null }> {
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink()) {
      const raw = await readlink(filePath);
      return { exists: true, isLink: true, target: path.resolve(path.dirname(filePath), raw) };
    }
    return { exists: true, isLink: false, target: null };
  } catch {
    return { exists: false, isLink: false, target: null };
  }
}

export async function readToolStatus(
  id: ToolStateId,
  homeDir = home,
  agentsHome = defaultAgentsHome(),
): Promise<ToolStatus> {
  const original = toolOriginalPath(id, homeDir);
  const adopted = toolAdoptedPath(id, agentsHome);
  const originalInfo = await pathLinkInfo(original);
  const adoptedInfo = await pathLinkInfo(adopted);

  let location: ToolStatus["location"];
  let linkTarget: string | null = originalInfo.target;

  if (id === "agents") {
    location = originalInfo.exists ? "in-place" : "missing";
  } else if (!originalInfo.exists && !adoptedInfo.exists) {
    location = "missing";
  } else if (originalInfo.exists && originalInfo.isLink && adoptedInfo.exists && !adoptedInfo.isLink && originalInfo.target === adopted) {
    location = "adopted";
  } else if (originalInfo.exists && !originalInfo.isLink && !adoptedInfo.exists) {
    location = "in-place";
  } else if (!originalInfo.exists && adoptedInfo.exists) {
    location = "orphan";
  } else {
    location = "conflict";
  }

  return { id, displayName: toolStateSpecs.find((s) => s.id === id)!.displayName, original, adopted, location, linkTarget };
}

export function planAdopt(id: ToolStateId, homeDir = home, agentsHome = defaultAgentsHome()): AdoptPlan {
  if (id === "agents") {
    return {
      id,
      original: toolOriginalPath(id, homeDir),
      adopted: toolAdoptedPath(id, agentsHome),
      action: "refuse",
      reason: "the agents state directory is the consolidation root and cannot be adopted into itself",
    };
  }
  const original = toolOriginalPath(id, homeDir);
  const adopted = toolAdoptedPath(id, agentsHome);
  return { id, original, adopted, action: "adopt" };
}

export async function executeAdopt(
  id: ToolStateId,
  homeDir = home,
  agentsHome = defaultAgentsHome(),
  dryRun = false,
): Promise<{ alreadyAdopted: boolean; original: string; adopted: string }> {
  const plan = planAdopt(id, homeDir, agentsHome);
  if (plan.action === "refuse") {
    throw new Error(plan.reason);
  }

  const original = plan.original;
  const adopted = plan.adopted;
  const originalInfo = await pathLinkInfo(original);
  const adoptedInfo = await pathLinkInfo(adopted);

  if (originalInfo.exists && originalInfo.isLink && originalInfo.target === adopted) {
    if (dryRun) return { alreadyAdopted: true, original, adopted };
    return { alreadyAdopted: true, original, adopted };
  }

  if (adoptedInfo.exists) {
    throw new Error(
      `refusing to adopt ${id}: adopted path already exists (${adopted}). Resolve the conflict before retrying.`,
    );
  }

  if (!originalInfo.exists) {
    throw new Error(`refusing to adopt ${id}: original state directory does not exist (${original})`);
  }

  if (dryRun) {
    return { alreadyAdopted: false, original, adopted };
  }

  await mkdir(path.dirname(adopted), { recursive: true });
  try {
    await rename(original, adopted);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EBUSY" || code === "EPERM" || code === "ENOENT") {
      throw new Error(
        `refusing to adopt ${id}: cannot move ${original} because it is locked by a running process or no longer exists`,
      );
    }
    throw err;
  }

  await createDirectoryJunction(original, adopted);
  return { alreadyAdopted: false, original, adopted };
}

async function createDirectoryJunction(link: string, target: string): Promise<void> {
  if (process.platform === "win32") {
    const proc = Bun.spawn(["cmd", "/c", "mklink", "/J", link, target], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`failed to create junction ${link} -> ${target}: ${err.trim() || `exit ${code}`}`);
    }
  } else {
    const proc = Bun.spawn(["ln", "-s", target, link], { stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`failed to create symlink ${link} -> ${target}: ${err.trim() || `exit ${code}`}`);
    }
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function* walk(
  root: string,
  current: string,
  excludeDir: string | null,
): AsyncGenerator<{ relPath: string; absolute: string; isDirectory: boolean }> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relPath = path.relative(root, absolute);
    if (excludeDir && (absolute === excludeDir || absolute.startsWith(excludeDir + path.sep))) {
      continue;
    }
    if (entry.isDirectory()) {
      if (isPathHardDenied(relPath)) continue;
      yield { relPath, absolute, isDirectory: true };
      yield* walk(root, absolute, excludeDir);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      yield { relPath, absolute, isDirectory: false };
    }
  }
}

export async function buildSyncCandidates(
  root: string,
  config: StateSyncConfig,
  excludeDir: string | null = null,
): Promise<SyncCandidate[]> {
  const candidates: SyncCandidate[] = [];
  if (!(await exists(root))) return candidates;
  for await (const entry of walk(root, root, excludeDir)) {
    if (entry.isDirectory) continue;
    const { allowed, reason } = isPathAllowed(entry.relPath, config);
    candidates.push({
      relPath: entry.relPath,
      source: entry.absolute,
      target: "",
      denied: !allowed,
      denyReason: reason,
    });
  }
  return candidates;
}

export async function loadSyncConfig(configPath: string): Promise<StateSyncConfig> {
  if (!(await exists(configPath))) {
    return { ...defaultSyncConfig };
  }
  const parsed = JSON.parse(await Bun.file(configPath).text()) as Partial<StateSyncConfig>;
  return {
    schemaVersion: 1,
    include: Array.isArray(parsed.include) ? parsed.include : defaultSyncConfig.include,
    exclude: Array.isArray(parsed.exclude) ? parsed.exclude : undefined,
  };
}

export async function ensureSyncConfig(configPath: string): Promise<StateSyncConfig> {
  const config = await loadSyncConfig(configPath);
  if (!(await exists(configPath))) {
    await Bun.write(configPath, `${JSON.stringify(config, null, 2)}\n`);
  }
  return config;
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  const out = await new Response(proc.stdout).text();
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${err.trim() || out.trim() || `exit ${code}`}`);
  }
  return out.trim();
}

export async function readStateRepoStatus(repoPath: string): Promise<SyncRepoStatus> {
  if (!(await exists(path.join(repoPath, ".git")))) {
    return { configured: false, path: repoPath, branch: null, clean: null, remoteUrl: null };
  }
  const branch = await gitOutput(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => null);
  const remoteUrl = await gitOutput(repoPath, ["remote", "get-url", "origin"]).catch(() => null);
  const porcelain = await gitOutput(repoPath, ["status", "--porcelain"]).catch(() => null);
  return { configured: true, path: repoPath, branch, clean: porcelain === "", remoteUrl };
}

async function ensureStateRepo(repoPath: string, remoteUrl?: string): Promise<void> {
  const resolvedRemote = remoteUrl ?? "https://github.com/marius-patrik/agents-data.git";
  if (await exists(path.join(repoPath, ".git"))) {
    const current = await gitOutput(repoPath, ["remote", "get-url", "origin"]).catch(() => null);
    if (current !== resolvedRemote) {
      await gitOutput(repoPath, ["remote", "set-url", "origin", resolvedRemote]);
    }
    return;
  }
  await mkdir(path.dirname(repoPath), { recursive: true });
  const proc = Bun.spawn(["git", "clone", resolvedRemote, repoPath], { stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`failed to clone agents-data repo: ${err.trim() || `exit ${code}`}`);
  }
}

async function ensureGitUser(repoPath: string): Promise<void> {
  const name = await gitOutput(repoPath, ["config", "user.name"]).catch(() => "");
  const email = await gitOutput(repoPath, ["config", "user.email"]).catch(() => "");
  if (!name) await gitOutput(repoPath, ["config", "user.name", "agents-manager"]);
  if (!email) await gitOutput(repoPath, ["config", "user.email", "agents-manager@local"]);
}

export async function executeSync(
  options: {
    agentsHome?: string;
    dryRun?: boolean;
    hostname?: string;
    remoteUrl?: string;
  } = {},
): Promise<{ candidates: SyncCandidate[]; committed: boolean; pushed: boolean; message: string }> {
  const agentsHome = options.agentsHome ?? defaultAgentsHome();
  const hostname = options.hostname ?? os.hostname();
  const repoPath = stateRepoPath(agentsHome);
  const config = await ensureSyncConfig(syncConfigPath(agentsHome));

  const candidates = await buildSyncCandidates(agentsHome, config, repoPath);
  const allowed = candidates.filter((c) => !c.denied);

  if (options.dryRun) {
    return { candidates, committed: false, pushed: false, message: "dry-run" };
  }

  await ensureStateRepo(repoPath, options.remoteUrl);
  await ensureGitUser(repoPath);

  const machineDir = path.join(repoPath, "machines", hostname);
  await mkdir(machineDir, { recursive: true });

  for (const candidate of allowed) {
    candidate.target = path.join(machineDir, candidate.relPath);
    await mkdir(path.dirname(candidate.target), { recursive: true });
    await Bun.write(candidate.target, Bun.file(candidate.source));
  }

  const statusBefore = await gitOutput(repoPath, ["status", "--porcelain"]);
  if (!statusBefore.trim()) {
    return { candidates, committed: false, pushed: false, message: "no changes to sync" };
  }

  await gitOutput(repoPath, ["add", "-A"]);
  const message = `sync agent state for ${hostname}`;
  await gitOutput(repoPath, ["commit", "-m", message]);

  const branch = await gitOutput(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  await gitOutput(repoPath, ["pull", "--rebase", "origin", branch]);
  await gitOutput(repoPath, ["push", "origin", branch]);

  return { candidates, committed: true, pushed: true, message };
}

export function formatStatus(
  tools: ToolStatus[],
  repo: SyncRepoStatus,
  config: StateSyncConfig,
): string {
  const lines: string[] = [];
  for (const tool of tools) {
    const arrow = tool.location === "adopted" && tool.linkTarget ? ` -> ${tool.linkTarget}` : "";
    lines.push(`${tool.displayName.padEnd(10)} ${tool.location.padEnd(10)} ${tool.original}${arrow}`);
  }
  lines.push("");
  lines.push(`state-repo ${repo.configured ? (repo.clean ? "clean" : "dirty") : "not configured"} ${repo.path}`);
  lines.push(`  branch:   ${repo.branch ?? "-"}`);
  lines.push(`  remote:   ${repo.remoteUrl ?? "-"}`);
  lines.push(`  includes: ${config.include.join(", ")}`);
  return lines.join("\n");
}
