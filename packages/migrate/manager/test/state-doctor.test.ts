import { describe, expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureSharedState, sharedStateAt, systemDataPath } from "../src/state";
import { doctorState, formatStateDoctor, launcherNameForPlatform } from "../src/state-doctor";
import { readStateManifest, stateV2Paths } from "../src/state-v2";
import { toolCanonicalPath, toolForbiddenPath } from "../src/state-consolidation";
import { rebuildMemoryProjections, rememberMemory, type MemoryEvent } from "../src/memory";
import { activateIdentityBundle, installCapability } from "../src/capabilities";
import { recordSourceInstall } from "../src/source-install";
import { enableEventSync } from "../src/event-sync";
import { createSession, rebuildSessionProjections, sessionPaths } from "../../harness/session";

const repoRoot = path.resolve(import.meta.dir, "..");
const sourceRoot = path.resolve(repoRoot, "../../..");
const cliPath = path.join(repoRoot, "src", "cli.ts");
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

function tempState(root: string) {
  const userHome = path.join(root, "user");
  return sharedStateAt(root, path.join(userHome, ".agents"), userHome);
}

async function git(root: string, args: string[]): Promise<void> {
  const child = Bun.spawn(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(stderr);
}

async function ensureDoctorProduct(state: ReturnType<typeof tempState>): Promise<void> {
  await writeFile(path.join(state.root, ".gitignore"), "user/\n", "utf8");
  await git(state.root, ["init", "-q", "-b", "dev"]);
  await git(state.root, ["config", "user.name", "Agent OS doctor test"]);
  await git(state.root, ["config", "user.email", "doctor@invalid"]);
  await git(state.root, ["add", ".gitignore"]);
  await git(state.root, ["commit", "-q", "-m", "doctor fixture"]);
  await git(state.root, ["remote", "add", "origin", "https://example.invalid/agents-manager.git"]);
  await mkdir(state.stateDir, { recursive: true });
  await git(state.stateDir, ["init", "-q", "-b", "main"]);
  await git(state.stateDir, ["config", "user.name", "Agent OS state test"]);
  await git(state.stateDir, ["config", "user.email", "state@invalid"]);
  await git(state.stateDir, ["remote", "add", "origin", "https://github.com/marius-patrik/Andromeda-data.git"]);
  await writeFile(path.join(state.stateDir, ".gitignore"), "*\n!.gitignore\n!agent.package.json\n!README.md\n!scripts/\n!scripts/validate.mjs\n");
  await writeFile(path.join(state.stateDir, "agent.package.json"), '{"schemaVersion":1,"id":"agent-os-data","kind":"data"}\n');
  await writeFile(path.join(state.stateDir, "README.md"), "# State fixture\n");
  await mkdir(path.join(state.stateDir, "scripts"), { recursive: true });
  await writeFile(path.join(state.stateDir, "scripts", "validate.mjs"), "// fixture\n");
  await git(state.stateDir, ["add", ".gitignore", "agent.package.json", "README.md", "scripts/validate.mjs"]);
  await git(state.stateDir, ["commit", "-q", "-m", "state fixture"]);
  await ensureSharedState(state);
  await enableEventSync(state, true);
  await installCapability(state, {
    kind: "skill",
    name: "test",
    source: path.join(sourceRoot, "skills", "test"),
  });
  const identitySource = path.join(state.root, "identity-source");
  await mkdir(path.join(identitySource, "roles"), { recursive: true });
  await mkdir(path.join(identitySource, "prompts"), { recursive: true });
  await copyFile(path.join(sourceRoot, "persona.md"), path.join(identitySource, "persona.md"));
  for (const name of await readdir(path.join(sourceRoot, "roles"))) {
    if (name.endsWith(".yaml")) await copyFile(path.join(sourceRoot, "roles", name), path.join(identitySource, "roles", name));
  }
  for (const name of await readdir(path.join(sourceRoot, "commands"))) {
    if (name.endsWith(".md")) await copyFile(path.join(sourceRoot, "commands", name), path.join(identitySource, "prompts", name));
  }
  await activateIdentityBundle(state, identitySource, { replace: true });
  await rm(identitySource, { recursive: true, force: true });
  const bin = path.join(state.stateDir, "bin");
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const launcher = path.join(bin, launcherNameForPlatform(process.platform));
  const launcherContent =
    process.platform === "win32"
      ? `$env:AGENTS_HOME = '${state.stateDir.replaceAll("'", "''")}'\n$env:AGENTS_USER_HOME = '${state.userHome.replaceAll("'", "''")}'\n$env:AGENTS_ROOT = '${state.root.replaceAll("'", "''")}'\n$env:AGENTS_WORKSPACE = '${state.workspaceDir.replaceAll("'", "''")}'\n$env:AGENTS_SYSTEM_DATA_ROOT = '${systemDataPath(state).replaceAll("'", "''")}'\n$env:AGENTS_ENTRYPOINT = '${path.join(state.root, "packages", "migrate", "manager", "src", "cli.ts").replaceAll("'", "''")}'\n& bun $env:AGENTS_ENTRYPOINT @args\n`
      : `#!/usr/bin/env bash\nexport AGENTS_HOME=${shellQuote(state.stateDir)}\nexport AGENTS_USER_HOME=${shellQuote(state.userHome)}\nexport AGENTS_ROOT=${shellQuote(state.root)}\nexport AGENTS_WORKSPACE=${shellQuote(state.workspaceDir)}\nexport AGENTS_SYSTEM_DATA_ROOT=${shellQuote(systemDataPath(state))}\nexport AGENTS_ENTRYPOINT=${shellQuote(path.join(state.root, "packages", "migrate", "manager", "src", "cli.ts"))}\nexec bun "$AGENTS_ENTRYPOINT" "$@"\n`;
  await writeFile(
    launcher,
    launcherContent,
    { mode: 0o700 },
  );
  if (process.platform !== "win32") {
    await chmod(bin, 0o700);
    await chmod(launcher, 0o700);
  }
  await recordSourceInstall(state);
}

describe("read-only Agent OS state doctor", () => {
  test("selects one platform-native launcher name", () => {
    expect(launcherNameForPlatform("win32")).toBe("agents.ps1");
    expect(launcherNameForPlatform("darwin")).toBe("agents");
    expect(launcherNameForPlatform("linux")).toBe("agents");
  });
  test("does not initialize or create files while diagnosing missing state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-doctor-empty-"));
    try {
      const state = tempState(root);
      const before = await readdir(root);
      const report = await doctorState(state);

      expect(report.ok).toBe(false);
      expect(report.stateRoot).toBe(path.resolve(state.stateDir));
      expect(report.checks.map((check) => check.id)).toEqual([
        "state_root",
        "manifest",
        "tool_roots",
        "provider_registry",
        "retired_state",
        "memory_integrity",
        "session_integrity",
        "orchestrator_integrity",
        "capability_integrity",
        "registry_integrity",
        "launcher",
        "source_install",
        "permissions",
        "generated_env",
        "sync_safety",
        "state_repository",
      ]);
      expect(await readdir(root)).toEqual(before);
      expect(await Bun.file(state.stateDir).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports a healthy state after explicit initialization", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-doctor-healthy-"));
    try {
      const state = tempState(root);
      await ensureDoctorProduct(state);
      const report = await doctorState(state);

      expect(report.ok).toBe(true);
      expect(report.checks.every((check) => check.ok)).toBe(true);
      expect(report.tools.find((tool) => tool.id === "agents")?.location).toBe("canonical");
      expect(formatStateDoctor(report)).toContain(`root ${path.resolve(state.stateDir)}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails when canonical and forbidden provider roots are split", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-doctor-split-"));
    try {
      const state = tempState(root);
      await ensureDoctorProduct(state);
      await mkdir(toolCanonicalPath("kimi", state.stateDir), { recursive: true, mode: 0o700 });
      await mkdir(toolForbiddenPath("kimi", state.userHome), { recursive: true, mode: 0o700 });

      const report = await doctorState(state);
      expect(report.ok).toBe(false);
      expect(report.tools.find((tool) => tool.id === "kimi")?.location).toBe("split");
      expect(report.checks.find((check) => check.id === "tool_roots")?.ok).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails when a retired global, shared, or multi-agent root reappears", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-doctor-retired-"));
    try {
      const state = tempState(root);
      await ensureDoctorProduct(state);
      await mkdir(path.join(state.stateDir, "global"), { mode: 0o700 });
      const report = await doctorState(state);
      const check = report.checks.find((item) => item.id === "retired_state");
      expect(report.ok).toBe(false);
      expect(check?.ok).toBe(false);
      expect(check?.message).toContain("global");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails on group/other-readable private state where POSIX modes are supported", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-doctor-mode-"));
    try {
      const state = tempState(root);
      await ensureDoctorProduct(state);
      if (process.platform === "win32") {
        const report = await doctorState(state);
        expect(report.checks.find((check) => check.id === "permissions")?.details?.supported).toBe(false);
        return;
      }

      await chmod(stateV2Paths(state).memoryDir, 0o755);
      const report = await doctorState(state);
      const check = report.checks.find((item) => item.id === "permissions");
      expect(report.ok).toBe(false);
      expect(check?.ok).toBe(false);
      expect(JSON.stringify(check?.details)).toContain('"mode":"0o755"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("exposes stable JSON through agents state doctor without initializing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-doctor-cli-"));
    try {
      const state = tempState(root);
      await ensureDoctorProduct(state);
      const proc = Bun.spawn([process.execPath, cliPath, "state", "doctor", "--json"], {
        cwd: root,
        env: {
          ...process.env,
          AGENTS_ROOT: root,
          AGENTS_HOME: state.stateDir,
          AGENTS_USER_HOME: state.userHome,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      expect(code).toBe(0);
      expect(stderr).toBe("");
      const report = JSON.parse(stdout) as { ok: boolean; stateRoot: string; checks: unknown[]; tools: unknown[] };
      expect(report.ok).toBe(true);
      expect(report.stateRoot).toBe(path.resolve(state.stateDir));
      expect(report.checks.length).toBe(16);
      expect(report.tools.length).toBe(5);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("diagnoses projection drift read-only and turns green after explicit rebuild", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-doctor-memory-projection-"));
    try {
      const state = tempState(root);
      await ensureDoctorProduct(state);
      await rememberMemory(state, {
        scope: "profile",
        subject: "user",
        predicate: "display-name",
        value: "Patrik",
        evidence: {
          uri: "user://instruction/display-name",
          contentHash: "a".repeat(64),
          sourceClass: "verified",
          confidence: 1,
        },
      });
      const startupPath = path.join(stateV2Paths(state).memoryViewsDir, "startup.md");
      await writeFile(startupPath, "tampered projection\n", "utf8");

      const report = await doctorState(state);
      const check = report.checks.find((item) => item.id === "memory_integrity");
      expect(report.ok).toBe(false);
      expect(check?.ok).toBe(false);
      expect(check?.details?.eventIntegrity).toBe(true);
      expect(check?.details?.projectionIntegrity).toBe(false);
      expect(await readFile(startupPath, "utf8")).toBe("tampered projection\n");

      await rebuildMemoryProjections(state);
      expect((await doctorState(state)).ok).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports a tampered canonical memory event separately from projection drift", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-doctor-memory-event-"));
    try {
      const state = tempState(root);
      await ensureDoctorProduct(state);
      await rememberMemory(state, {
        scope: "profile",
        subject: "user",
        predicate: "locale",
        value: "sk-SK",
        evidence: {
          uri: "user://instruction/locale",
          contentHash: "b".repeat(64),
          sourceClass: "verified",
          confidence: 1,
        },
      });
      const manifest = await readStateManifest(state);
      const directory = path.join(stateV2Paths(state).memoryEventsDir, manifest!.machineId);
      const name = (await readdir(directory)).find((entry) => entry.endsWith(".json"))!;
      const eventPath = path.join(directory, name);
      const event = JSON.parse(await readFile(eventPath, "utf8")) as MemoryEvent;
      event.schemaVersion = 1 as 2;
      await writeFile(eventPath, `${JSON.stringify(event, null, 2)}\n`, "utf8");

      const report = await doctorState(state);
      const check = report.checks.find((item) => item.id === "memory_integrity");
      expect(report.ok).toBe(false);
      expect(check?.ok).toBe(false);
      expect(check?.details?.eventIntegrity).toBe(false);
      expect(check?.message).toContain("event integrity");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails read-only on session projection drift and turns green after explicit rebuild", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-doctor-session-projection-"));
    try {
      const state = tempState(root);
      await ensureDoctorProduct(state);
      const descriptor = await createSession(state, {
        provider: "codex",
        model: "test-model",
        sessionId: "doctor-session",
      });
      const transcriptPath = sessionPaths(state, descriptor.sessionId).transcriptFile;
      await writeFile(transcriptPath, '{"forged":true}\n', "utf8");

      const report = await doctorState(state);
      const check = report.checks.find((item) => item.id === "session_integrity");
      expect(report.ok).toBe(false);
      expect(check?.details?.eventIntegrity).toBe(true);
      expect(check?.details?.projectionIntegrity).toBe(false);
      expect(await readFile(transcriptPath, "utf8")).toBe('{"forged":true}\n');

      await rebuildSessionProjections(state, descriptor.sessionId);
      expect((await doctorState(state)).ok).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails on capability content drift without repairing the installed projection", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-doctor-capability-drift-"));
    try {
      const state = tempState(root);
      await ensureDoctorProduct(state);
      const installedSkill = path.join(state.skillsDir, "test", "SKILL.md");
      await writeFile(installedSkill, "forged capability\n", "utf8");

      const report = await doctorState(state);
      const check = report.checks.find((item) => item.id === "capability_integrity");
      expect(report.ok).toBe(false);
      expect(check?.ok).toBe(false);
      expect(JSON.stringify(check?.details)).toContain("checksum mismatch");
      expect(await readFile(installedSkill, "utf8")).toBe("forged capability\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails when source provenance, launcher cardinality, or a canonical registry drifts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-doctor-product-drift-"));
    try {
      const state = tempState(root);
      await ensureDoctorProduct(state);
      await writeFile(path.join(root, "unrecorded.txt"), "dirty\n", "utf8");
      await writeFile(path.join(state.stateDir, "bin", "second-launcher"), "#!/bin/sh\n", { mode: 0o700 });
      await writeFile(state.packagesFile, '[{"name":"duplicate"},{"name":"duplicate"}]\n', "utf8");

      const report = await doctorState(state);
      expect(report.ok).toBe(false);
      expect(report.checks.find((item) => item.id === "source_install")?.ok).toBe(false);
      expect(report.checks.find((item) => item.id === "launcher")?.ok).toBe(false);
      expect(report.checks.find((item) => item.id === "registry_integrity")?.ok).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails when a symlink appears anywhere in recursively private canonical state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-doctor-symlink-"));
    try {
      const state = tempState(root);
      await ensureDoctorProduct(state);
      if (process.platform === "win32") return;
      const target = path.join(root, "outside.txt");
      await writeFile(target, "outside\n", "utf8");
      await symlink(target, path.join(stateV2Paths(state).memoryViewsDir, "forbidden-link"));

      const report = await doctorState(state);
      const check = report.checks.find((item) => item.id === "permissions");
      expect(report.ok).toBe(false);
      expect(check?.ok).toBe(false);
      expect(JSON.stringify(check?.details)).toContain('"kind":"symlink"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
