import { describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureSharedState, sharedStateAt } from "../src/state";
import { enableEventSync } from "../src/event-sync";
import { rememberMemory } from "../src/memory";
import {
  backupStateRepository,
  inspectStateRepository,
  restoreStateRepository,
  syncStateRepository,
} from "../src/state-repository";
import { doctorState } from "../src/state-doctor";

const evidence = {
  uri: "test://state-repository",
  contentHash: "a".repeat(64),
  sourceClass: "verified" as const,
  confidence: 1,
};

async function git(root: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(stderr || stdout);
  return stdout.trim();
}

async function repositoryState(root: string, options: { keepGitIdentity?: boolean } = {}) {
  const stateDir = path.join(root, ".agents");
  await mkdir(stateDir, { recursive: true });
  await git(stateDir, ["init", "-q", "-b", "main"]);
  await git(stateDir, ["config", "user.name", "State repository test"]);
  await git(stateDir, ["config", "user.email", "state@invalid"]);
  await git(stateDir, ["remote", "add", "origin", "https://github.com/marius-patrik/Andromeda-data.git"]);
  await writeFile(
    path.join(stateDir, ".gitignore"),
    [
      "/bin/", "/clis/", "/harnesses/", "/hooks/", "/identity/", "/memory/", "/orchestrator/",
      "/plugins/", "/provenance/", "/quarantine/", "/runtime/", "/secrets/", "/sessions/", "/skills/",
      "/store/", "/sync/", "/templates/", "/config.json", "/credits.json", "/data-repos.json", "/environments.json",
      "/installs.json", "/manifest.json", "/packages.json", "/providers.json", "/env", "/backups/*", "!/backups/events/",
      "!/backups/events/**", "",
    ].join("\n"),
  );
  await writeFile(path.join(stateDir, "README.md"), "# State\n");
  await writeFile(path.join(stateDir, "agent.package.json"), '{"schemaVersion":1,"id":"agent-os-data","kind":"data"}\n');
  await mkdir(path.join(stateDir, "scripts"), { recursive: true });
  await writeFile(path.join(stateDir, "scripts", "validate.mjs"), "// fixture\n");
  await git(stateDir, ["add", ".gitignore", "README.md", "agent.package.json", "scripts/validate.mjs"]);
  await git(stateDir, ["commit", "-q", "-m", "fixture"]);
  if (options.keepGitIdentity === false) {
    await git(stateDir, ["config", "--unset", "user.name"]);
    await git(stateDir, ["config", "--unset", "user.email"]);
  }
  const state = sharedStateAt(path.join(root, "source"), stateDir, root);
  await ensureSharedState(state);
  await enableEventSync(state, true);
  return state;
}

describe("Andromeda-data state repository", () => {
  test("recognizes an equivalent Windows checkout path alias", async () => {
    if (process.platform !== "win32") return;
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-state-repository-alias-"));
    try {
      const state = await repositoryState(root);
      const aliasedState = { ...state, stateDir: state.stateDir.toUpperCase() };
      const status = await inspectStateRepository(aliasedState);
      expect(status.checkout).toBe(true);
      expect(status.issues).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("backs up canonical events as one authenticated immutable Git bundle", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-state-repository-"));
    try {
      const state = await repositoryState(root);
      await rememberMemory(state, {
        scope: "global",
        subject: "agent-os",
        predicate: "state-root",
        value: "Andromeda-data",
        sensitivity: "internal",
        evidence,
      });

      const backup = await backupStateRepository(state);
      expect(backup.entries).toBe(1);
      expect(backup.committed).toBe(true);
      expect(backup.bundle).toMatch(/^backups\/events\/.+\/[a-f0-9]{64}\.bundle\.json$/);
      expect(await git(state.stateDir, ["ls-files", backup.bundle])).toBe(backup.bundle);

      const status = await inspectStateRepository(state);
      expect(status.issues).toEqual([]);
      expect(status.backupBundles).toBe(1);

      const repeated = await backupStateRepository(state);
      expect(repeated.payloadHash).toBe(backup.payloadHash);
      expect(repeated.committed).toBe(false);

      const restored = await restoreStateRepository(state);
      expect(restored.bundles).toBe(1);
      expect(restored.imported).toBe(0);
      expect(restored.skipped).toBe(1);

      const untracked = path.join(state.stateDir, "backups", "events", "untracked-machine", `${backup.payloadHash}.bundle.json`);
      await mkdir(path.dirname(untracked), { recursive: true });
      await copyFile(path.join(state.stateDir, ...backup.bundle.split("/")), untracked);
      expect((await restoreStateRepository(state)).bundles).toBe(1);

      const renamedRelative = `backups/events/renamed-machine/${"b".repeat(64)}.bundle.json`;
      const renamed = path.join(state.stateDir, ...renamedRelative.split("/"));
      await mkdir(path.dirname(renamed), { recursive: true });
      await copyFile(path.join(state.stateDir, ...backup.bundle.split("/")), renamed);
      await git(state.stateDir, ["add", "--", renamedRelative]);
      await git(state.stateDir, ["commit", "-q", "-m", "malformed fixture"]);
      await expect(restoreStateRepository(state)).rejects.toThrow("filename does not match authenticated payload");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed for repository drift before creating a backup", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-state-repository-drift-"));
    try {
      const state = await repositoryState(root);
      await writeFile(path.join(state.stateDir, "README.md"), "dirty\n");
      await expect(backupStateRepository(state)).rejects.toThrow("state repository has tracked changes");

      await git(state.stateDir, ["checkout", "--", "README.md"]);
      await git(state.stateDir, ["remote", "set-url", "origin", "https://example.invalid/not-andromeda-data.git"]);
      const status = await inspectStateRepository(state);
      expect(status.issues).toContain("origin must be marius-patrik/Andromeda-data");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects disabled exchange, missing keys, and an unborn lookalike checkout", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-state-repository-contract-"));
    try {
      const state = await repositoryState(root);
      await rm(path.join(state.secretsDir, "AGENTS_SYNC_KEY.secret"));
      expect((await inspectStateRepository(state)).issues).toContain(
        "state repository requires enabled encrypted event exchange with a local key",
      );

      const empty = path.join(root, "empty");
      await mkdir(empty, { recursive: true });
      await git(empty, ["init", "-q", "-b", "main"]);
      await git(empty, ["remote", "add", "origin", "https://github.com/marius-patrik/Andromeda-data.git"]);
      const emptyState = sharedStateAt(path.join(root, "empty-source"), empty, root);
      const status = await inspectStateRepository(emptyState);
      expect(status.issues).toContain("state repository has no committed HEAD");
      expect(status.issues).toContain("state repository contract file is not tracked: agent.package.json");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("status and doctor reject a committed tampered backup envelope", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-state-repository-tamper-"));
    try {
      const state = await repositoryState(root);
      await rememberMemory(state, {
        scope: "global",
        subject: "agent-os",
        predicate: "tamper-check",
        value: "enabled",
        sensitivity: "internal",
        evidence,
      });
      const backup = await backupStateRepository(state);
      await writeFile(path.join(state.stateDir, ...backup.bundle.split("/")), "{}\n");
      await git(state.stateDir, ["add", "--", backup.bundle]);
      await git(state.stateDir, ["commit", "-q", "-m", "tampered fixture"]);

      const status = await inspectStateRepository(state);
      expect(status.issues.some((issue) => issue.includes("invalid event exchange envelope"))).toBe(true);
      const report = await doctorState(state);
      const repositoryCheck = report.checks.find((check) => check.id === "state_repository");
      expect(repositoryCheck?.ok).toBe(false);
      expect((repositoryCheck?.details?.issues as string[]).some((issue) => issue.includes("invalid event exchange envelope"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects force-tracked plaintext runtime state before repository operations", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-state-repository-plaintext-"));
    try {
      const state = await repositoryState(root);
      const forbidden = [
        "clis/codex/auth.json",
        "capabilities/rogue/state.json",
        "cache/provider.db",
        "Providers/codex/auth.json",
        "Projections/memory.json",
        "Binaries/tool.exe",
        ".Env.Local",
        "Credentials.JSON",
        "Auth.json",
        "Keys.JSON",
        "synchronization/state.json",
        "Credential/provider.json",
        "context/Auth.json",
        "research/keys.json",
        ".github/providers/codex/auth.json",
      ];
      for (const relative of forbidden) {
        const file = path.join(state.stateDir, ...relative.split("/"));
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, "fixture\n");
      }
      await git(state.stateDir, ["add", "-f", "--", ...forbidden]);
      await git(state.stateDir, ["commit", "-q", "-m", "forbidden fixture"]);

      const status = await inspectStateRepository(state);
      expect(status.issues).toContain("plaintext runtime state is tracked: clis/codex/auth.json");
      expect(status.issues).toContain("plaintext runtime state is tracked: capabilities/rogue/state.json");
      expect(status.issues).toContain("plaintext runtime state is tracked: cache/provider.db");
      expect(status.issues).toContain("plaintext runtime state is tracked: Providers/codex/auth.json");
      expect(status.issues).toContain("plaintext runtime state is tracked: Projections/memory.json");
      expect(status.issues).toContain("plaintext runtime state is tracked: Binaries/tool.exe");
      expect(status.issues).toContain("plaintext runtime state is tracked: .Env.Local");
      expect(status.issues).toContain("plaintext runtime state is tracked: Credentials.JSON");
      expect(status.issues).toContain("plaintext runtime state is tracked: Auth.json");
      expect(status.issues).toContain("plaintext runtime state is tracked: Keys.JSON");
      expect(status.issues).toContain("plaintext runtime state is tracked: synchronization/state.json");
      expect(status.issues).toContain("plaintext runtime state is tracked: Credential/provider.json");
      expect(status.issues).toContain("plaintext runtime state is tracked: context/Auth.json");
      expect(status.issues).toContain("plaintext runtime state is tracked: research/keys.json");
      expect(status.issues).toContain("plaintext runtime state is tracked: .github/providers/codex/auth.json");
      const doctor = await doctorState(state);
      expect(doctor.checks.find((check) => check.id === "state_repository")?.ok).toBe(false);
      await expect(backupStateRepository(state)).rejects.toThrow("plaintext runtime state is tracked");
      await expect(restoreStateRepository(state)).rejects.toThrow("plaintext runtime state is tracked");
      await expect(syncStateRepository(state)).rejects.toThrow("plaintext runtime state is tracked");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("backup uses a controlled identity without local or global Git identity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-state-repository-identity-"));
    const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
    const previousIdentity = Object.fromEntries(
      ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"].map((name) => [name, process.env[name]]),
    );
    try {
      const state = await repositoryState(root, { keepGitIdentity: false });
      process.env.GIT_CONFIG_GLOBAL = path.join(root, "missing-global-gitconfig");
      process.env.GIT_AUTHOR_NAME = "Conflicting Author";
      process.env.GIT_AUTHOR_EMAIL = "conflicting-author@example.invalid";
      process.env.GIT_COMMITTER_NAME = "Conflicting Committer";
      process.env.GIT_COMMITTER_EMAIL = "conflicting-committer@example.invalid";
      await rememberMemory(state, {
        scope: "global",
        subject: "agent-os",
        predicate: "backup-identity",
        value: "controlled",
        sensitivity: "internal",
        evidence,
      });
      const backup = await backupStateRepository(state);
      expect(backup.committed).toBe(true);
      expect(await git(state.stateDir, ["log", "-1", "--format=%an <%ae>"])).toBe(
        "Agent OS State <state@andromeda.invalid>",
      );
    } finally {
      if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
      for (const [name, value] of Object.entries(previousIdentity)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
