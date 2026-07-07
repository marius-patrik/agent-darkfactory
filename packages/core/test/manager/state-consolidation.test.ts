import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildSyncCandidates,
  defaultSyncConfig,
  executeAdopt,
  executeSync,
  isPathAllowed,
  isPathHardDenied,
  matchesGlob,
  planAdopt,
  readToolStatus,
  toolAdoptedPath,
  toolOriginalPath,
  type StateSyncConfig,
  type ToolStateId,
} from "../../src/manager/state-consolidation";

describe("state sync allowlist/denylist", () => {
  test("hard denylist always rejects secrets, credentials, caches, logs, history, node_modules", () => {
    expect(isPathHardDenied("skills/auth.json")).toBe(true);
    expect(isPathHardDenied("skills/foo/token.txt")).toBe(true);
    expect(isPathHardDenied("bin/secret.sh")).toBe(true);
    expect(isPathHardDenied("clis/codex/.credentials.json")).toBe(true);
    expect(isPathHardDenied("state/cache/data.json")).toBe(true);
    expect(isPathHardDenied("state/logs/debug.log")).toBe(true);
    expect(isPathHardDenied("skills/history/conv.json")).toBe(true);
    expect(isPathHardDenied("skills/node_modules/foo/index.js")).toBe(true);
  });

  test("hard denylist overrides allowlist for secrets", () => {
    const config: StateSyncConfig = { schemaVersion: 1, include: ["**"] };
    expect(isPathAllowed("skills/auth.json", config).allowed).toBe(false);
    expect(isPathAllowed("auth.json", config).allowed).toBe(false);
    expect(isPathAllowed("any/secret/token.txt", config).allowed).toBe(false);
  });

  test("default allowlist matches expected paths", () => {
    expect(isPathAllowed("skills/hello/SKILL.md", defaultSyncConfig).allowed).toBe(true);
    expect(isPathAllowed("bin/run.sh", defaultSyncConfig).allowed).toBe(true);
    expect(isPathAllowed("state/ledgers.json", defaultSyncConfig).allowed).toBe(true);
    expect(isPathAllowed("clis/codex/config.json", defaultSyncConfig).allowed).toBe(true);
    expect(isPathAllowed("clis/kimi/settings.toml", defaultSyncConfig).allowed).toBe(true);
    expect(isPathAllowed("data-repos.json", defaultSyncConfig).allowed).toBe(true);
    expect(isPathAllowed("sessions/chat-a/state.json", defaultSyncConfig).allowed).toBe(true);
    expect(isPathAllowed("sessions/chat-a/transcript.json", defaultSyncConfig).allowed).toBe(true);
    expect(isPathAllowed("orchestrator/STATE.md", defaultSyncConfig).allowed).toBe(true);
    expect(isPathAllowed("orchestrator/ledger.json", defaultSyncConfig).allowed).toBe(true);
  });

  test("default allowlist excludes unspecified paths", () => {
    expect(isPathAllowed("secrets/CODEX_AUTH_JSON.secret", defaultSyncConfig).allowed).toBe(false);
    expect(isPathAllowed("credits.json", defaultSyncConfig).allowed).toBe(false);
    expect(isPathAllowed("random/file.txt", defaultSyncConfig).allowed).toBe(false);
    expect(isPathAllowed("clis/codex/auth.json", defaultSyncConfig).allowed).toBe(false);
  });

  test("matchesGlob supports *, **, and literal segments", () => {
    expect(matchesGlob("skills/a/SKILL.md", "skills/**")).toBe(true);
    expect(matchesGlob("skills/a/b/c.txt", "skills/**")).toBe(true);
    expect(matchesGlob("bin/run.sh", "bin/**")).toBe(true);
    expect(matchesGlob("clis/codex/config.json", "clis/**/config.*")).toBe(true);
    expect(matchesGlob("clis/kimi/settings.toml", "clis/**/settings.*")).toBe(true);
    expect(matchesGlob("clis/codex/config.json", "clis/**/settings.*")).toBe(false);
    expect(matchesGlob("data-repos.json", "data-repos.json")).toBe(true);
    expect(matchesGlob("data/repos.json", "data-repos.json")).toBe(false);
  });

  test("exclude patterns override include patterns", () => {
    const config: StateSyncConfig = { schemaVersion: 1, include: ["skills/**"], exclude: ["skills/private/**"] };
    expect(isPathAllowed("skills/public/SKILL.md", config).allowed).toBe(true);
    expect(isPathAllowed("skills/private/SKILL.md", config).allowed).toBe(false);
  });

  test("hard denylist rejects secrets, caches, and logs inside sessions and orchestrator", () => {
    expect(isPathAllowed("sessions/chat-a/cache/embedding.json", defaultSyncConfig).allowed).toBe(false);
    expect(isPathAllowed("sessions/chat-a/logs/debug.log", defaultSyncConfig).allowed).toBe(false);
    expect(isPathAllowed("sessions/chat-a/secret.json", defaultSyncConfig).allowed).toBe(false);
    expect(isPathAllowed("sessions/chat-a/credentials.json", defaultSyncConfig).allowed).toBe(false);
    expect(isPathAllowed("orchestrator/cache/state.json", defaultSyncConfig).allowed).toBe(false);
    expect(isPathAllowed("orchestrator/logs/heartbeat.log", defaultSyncConfig).allowed).toBe(false);
    expect(isPathAllowed("orchestrator/auth/token.json", defaultSyncConfig).allowed).toBe(false);
  });

  test("buildSyncCandidates excludes denied dirs early and reports file-level denials", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agents-sync-"));
    try {
      await Bun.write(path.join(dir, "skills", "hello", "SKILL.md"), "# hello");
      await Bun.write(path.join(dir, "skills", "auth.json"), "{}");
      await Bun.write(path.join(dir, "skills", "secret.json"), "{}");
      await Bun.write(path.join(dir, "bin", "run.sh"), "#!/bin/sh");
      await Bun.write(path.join(dir, "secrets", "TOKEN.secret"), "x");
      await Bun.write(path.join(dir, "logs", "debug.log"), "x");
      const candidates = await buildSyncCandidates(dir, defaultSyncConfig);
      const allowed = candidates.filter((c) => !c.denied).map((c) => c.relPath);
      const denied = candidates.filter((c) => c.denied);
      expect(allowed.sort()).toEqual([path.join("bin", "run.sh"), path.join("skills", "hello", "SKILL.md")]);
      expect(allowed.some((c) => c.toLowerCase().includes("secret") || c.toLowerCase().includes("token"))).toBe(false);
      expect(denied.length).toBeGreaterThanOrEqual(2);
      expect(denied.some((c) => c.relPath.toLowerCase().includes("auth.json"))).toBe(true);
      expect(denied.some((c) => c.relPath.toLowerCase().includes("secret.json"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("state adopt planning", () => {
  test("planAdopt refuses the agents tool", () => {
    const plan = planAdopt("agents");
    expect(plan.action).toBe("refuse");
    expect(plan.reason).toMatch(/consolidation root/);
  });

  test("planAdopt returns adopt for claude, codex, and kimi", () => {
    for (const id of ["claude", "codex", "kimi"] as ToolStateId[]) {
      const plan = planAdopt(id);
      expect(plan.action).toBe("adopt");
      expect(plan.original).toBe(toolOriginalPath(id));
      expect(plan.adopted).toBe(toolAdoptedPath(id));
    }
  });

  test("readToolStatus reports missing when neither original nor adopted exists", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "agents-status-"));
    try {
      const agentsHome = path.join(homeDir, ".agents");
      const status = await readToolStatus("codex", homeDir, agentsHome);
      expect(status.location).toBe("missing");
      expect(status.original).toBe(path.join(homeDir, ".codex"));
      expect(status.adopted).toBe(path.join(agentsHome, "state", "codex"));
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  test("readToolStatus reports in-place when original directory exists", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "agents-status-"));
    try {
      await Bun.write(path.join(homeDir, ".claude", "config.json"), "{}");
      const status = await readToolStatus("claude", homeDir, path.join(homeDir, ".agents"));
      expect(status.location).toBe("in-place");
      expect(status.linkTarget).toBeNull();
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  test("readToolStatus reports adopted after executeAdopt", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "agents-status-"));
    try {
      const agentsHome = path.join(homeDir, ".agents");
      const original = toolOriginalPath("kimi", homeDir);
      await Bun.write(path.join(original, "config.json"), "{}");
      await executeAdopt("kimi", homeDir, agentsHome, false);
      const status = await readToolStatus("kimi", homeDir, agentsHome);
      expect(status.location).toBe("adopted");
      expect(status.linkTarget).toBe(toolAdoptedPath("kimi", agentsHome));
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  test("executeAdopt dry-run reports plan without mutating filesystem", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "agents-adopt-"));
    try {
      const agentsHome = path.join(homeDir, ".agents");
      const original = toolOriginalPath("codex", homeDir);
      await Bun.write(path.join(original, "auth.json"), "{}");
      const result = await executeAdopt("codex", homeDir, agentsHome, true);
      expect(result.alreadyAdopted).toBe(false);
      expect(await Bun.file(path.join(original, "auth.json")).exists()).toBe(true);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});

describe("state sync round-trip", () => {
  async function git(cwd: string, args: string[]): Promise<string> {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${err.trim() || out.trim() || `exit ${code}`}`);
    }
    return out.trim();
  }

  async function createBareUpstream(root: string): Promise<string> {
    const seed = path.join(root, "seed");
    const upstream = path.join(root, "upstream.git");
    await mkdir(seed, { recursive: true });
    await git(seed, ["init", "-b", "main"]);
    await git(seed, ["config", "user.email", "test@local"]);
    await git(seed, ["config", "user.name", "test"]);
    await Bun.write(path.join(seed, "README.md"), "# state sync upstream\n");
    await git(seed, ["add", "README.md"]);
    await git(seed, ["commit", "-m", "init"]);
    await git(seed, ["clone", "--bare", seed, upstream]);
    return upstream;
  }

  async function machineState(machinesDir: string, hostname: string): Promise<Record<string, string>> {
    const hostDir = path.join(machinesDir, hostname);
    const out: Record<string, string> = {};
    async function walk(current: string, prefix: string): Promise<void> {
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = path.join(current, entry.name);
        const key = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walk(entryPath, key);
        } else {
          out[key] = await readFile(entryPath, "utf-8");
        }
      }
    }
    await walk(hostDir, "");
    return out;
  }

  test("session and orchestrator state written on machine A appears on machine B", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-sync-roundtrip-"));
    try {
      const upstream = await createBareUpstream(root);

      // Machine A writes state and syncs.
      const machineA = path.join(root, "machine-a");
      const agentsHomeA = path.join(machineA, ".agents");
      const sessionId = "session-2026-001";
      await Bun.write(path.join(agentsHomeA, "sessions", sessionId, "state.json"), JSON.stringify({ provider: "fake", model: "test" }));
      await Bun.write(path.join(agentsHomeA, "sessions", sessionId, "transcript.json"), JSON.stringify({ messages: [] }));
      await Bun.write(path.join(agentsHomeA, "orchestrator", "STATE.md"), "# Orchestrator State\n");
      // Denied files must not be synced.
      await Bun.write(path.join(agentsHomeA, "sessions", sessionId, "secret.json"), "should-not-sync");

      const syncA = await executeSync({ agentsHome: agentsHomeA, hostname: "machine-a", remoteUrl: upstream });
      expect(syncA.committed).toBe(true);
      expect(syncA.pushed).toBe(true);
      expect(syncA.candidates.some((c) => c.relPath.includes("secret.json") && !c.denied)).toBe(false);

      // Machine B clones the state repo and sees machine A's files.
      const machineB = path.join(root, "machine-b");
      const agentsHomeB = path.join(machineB, ".agents");
      const repoB = path.join(agentsHomeB, "state-repo");
      await mkdir(repoB, { recursive: true });
      await git(repoB, ["clone", upstream, "."]);

      const stateB = await machineState(path.join(repoB, "machines"), "machine-a");
      expect(stateB["sessions/session-2026-001/state.json"]).toContain("fake");
      expect(stateB["sessions/session-2026-001/transcript.json"]).toBeDefined();
      expect(stateB["orchestrator/STATE.md"]).toContain("# Orchestrator State");
      expect(stateB["sessions/session-2026-001/secret.json"]).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("updates on machine A are rebased into machine B's state repo on pull", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-sync-rebase-"));
    try {
      const upstream = await createBareUpstream(root);

      const machineA = path.join(root, "machine-a");
      const agentsHomeA = path.join(machineA, ".agents");
      const sessionId = "session-2026-002";
      await Bun.write(path.join(agentsHomeA, "sessions", sessionId, "state.json"), JSON.stringify({ turnCount: 1 }));
      await executeSync({ agentsHome: agentsHomeA, hostname: "machine-a", remoteUrl: upstream });

      const machineB = path.join(root, "machine-b");
      const agentsHomeB = path.join(machineB, ".agents");
      const repoB = path.join(agentsHomeB, "state-repo");
      await mkdir(repoB, { recursive: true });
      await git(repoB, ["clone", upstream, "."]);
      await git(repoB, ["config", "user.email", "test@local"]);
      await git(repoB, ["config", "user.name", "test"]);

      // Machine A updates state and syncs again.
      await Bun.write(path.join(agentsHomeA, "sessions", sessionId, "state.json"), JSON.stringify({ turnCount: 2 }));
      await executeSync({ agentsHome: agentsHomeA, hostname: "machine-a", remoteUrl: upstream });

      // Machine B pulls with rebase and sees the update.
      await git(repoB, ["pull", "--rebase", "origin", "main"]);
      const updated = await readFile(path.join(repoB, "machines", "machine-a", "sessions", sessionId, "state.json"), "utf-8");
      expect(updated).toContain('"turnCount":2');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
