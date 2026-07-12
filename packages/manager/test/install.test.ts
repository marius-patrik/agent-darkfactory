import { describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  activateIdentityBundle,
  installCapability,
  type CapabilityPublicationBoundary,
} from "../src/capabilities";
import {
  ensureSharedState,
  readInstalls,
  sharedState,
} from "../src/state";
import { readPackageRegistrations } from "../src/packages";

const repoRoot = path.resolve(import.meta.dir, "..");
const cliPath = path.join(repoRoot, "src", "cli.ts");

function cleanEnv(): Record<string, string | undefined> {
  const copy = { ...process.env };
  for (const key of Object.keys(copy)) {
    if (key.startsWith("AGENTS_")) delete copy[key];
  }
  return copy;
}

async function runAgents(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, cliPath, ...args], {
    cwd,
    env: {
      ...cleanEnv(),
      AGENTS_HOME: path.join(cwd, ".agents"),
      AGENTS_ROOT: cwd,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

interface SnapshotEntry {
  path: string;
  kind: "directory" | "file";
  mode: number;
  content?: string;
}

async function snapshotTree(root: string): Promise<SnapshotEntry[]> {
  const snapshot: SnapshotEntry[] = [];
  async function walk(
    directory: string,
    relativeDirectory: string,
  ): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true })).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const absolutePath = path.join(directory, entry.name);
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink())
        throw new Error(
          `unexpected symlink in canonical state: ${relativePath}`,
        );
      if (info.isDirectory()) {
        snapshot.push({
          path: relativePath,
          kind: "directory",
          mode: info.mode & 0o777,
        });
        await walk(absolutePath, relativePath);
      } else if (info.isFile()) {
        snapshot.push({
          path: relativePath,
          kind: "file",
          mode: info.mode & 0o777,
          content: Buffer.from(await readFile(absolutePath)).toString("base64"),
        });
      } else {
        throw new Error(`unexpected entry in canonical state: ${relativePath}`);
      }
    }
  }
  await walk(root, "");
  return snapshot;
}

async function writeSkillFixture(
  root: string,
  description: string,
): Promise<void> {
  await mkdir(root, { recursive: true });
  await Bun.write(
    path.join(root, "SKILL.md"),
    `---\nname: probe\ndescription: "${description}"\n---\n\n# ${description}\n`,
  );
  await Bun.write(
    path.join(root, "agent.package.json"),
    `${JSON.stringify({ schemaVersion: 1, id: "probe", kind: "skill", description })}\n`,
  );
}

async function writeIdentityFixture(
  root: string,
  description: string,
): Promise<void> {
  await mkdir(path.join(root, "roles"), { recursive: true });
  await mkdir(path.join(root, "prompts"), { recursive: true });
  await Bun.write(
    path.join(root, "persona.md"),
    `# Rommie\n\n${description}\n`,
  );
  await Bun.write(
    path.join(root, "roles", "review.yaml"),
    "name: review\nscope: worker\ntype: on-demand\n",
  );
  await Bun.write(path.join(root, "prompts", "review.md"), `${description}\n`);
}

describe("install CLI", () => {
  test("installs checksum-addressed skills and makes an identical repeat a no-op", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-install-"));
    try {
      const source = path.join(root, "source-skill");
      await mkdir(source, { recursive: true });
      await Bun.write(
        path.join(source, "SKILL.md"),
        '---\nname: probe\ndescription: "A deterministic probe."\n---\n\n# Probe skill\n',
      );

      const install = await runAgents(root, [
        "install",
        "skill",
        "probe",
        source,
      ]);
      expect(install.code).toBe(0);
      expect(install.stdout).toContain("installed skill probe sha256=");
      expect(
        await Bun.file(
          path.join(root, ".agents", "skills", "probe", "SKILL.md"),
        ).text(),
      ).toContain("# Probe skill");
      const registryBefore = await Bun.file(
        path.join(root, ".agents", "installs.json"),
      ).text();

      const duplicate = await runAgents(root, [
        "install",
        "skill",
        "probe",
        source,
      ]);
      expect(duplicate.code).toBe(0);
      expect(duplicate.stdout).toContain("verified skill probe sha256=");
      expect(
        await Bun.file(path.join(root, ".agents", "installs.json")).text(),
      ).toBe(registryBefore);

      const installs = await readInstalls(sharedState(root));
      expect(installs).toHaveLength(1);
      expect(installs[0].kind).toBe("skill");
      expect(installs[0].name).toBe("probe");
      expect(installs[0].sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(
        await Bun.file(
          path.join(root, ".agents", "identity", "capabilities.md"),
        ).text(),
      ).toContain("A deterministic probe.");
      expect(
        await Bun.file(
          path.join(
            root,
            ".agents",
            "store",
            "sha256",
            installs[0].sha256,
            "SKILL.md",
          ),
        ).exists(),
      ).toBe(true);
      if (process.platform !== "win32") {
        expect(
          (await stat(path.join(root, ".agents", "installs.json"))).mode &
            0o777,
        ).toBe(0o600);
      }
      expect(
        (await readdir(path.join(root, ".agents"))).some((name) =>
          name.includes(".tmp"),
        ),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires deliberate replacement when installed content changes", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "agents-install-replace-"),
    );
    try {
      const source = path.join(root, "source-skill");
      await mkdir(source, { recursive: true });
      const skillFile = path.join(source, "SKILL.md");
      await Bun.write(
        skillFile,
        '---\nname: probe\ndescription: "First."\n---\n',
      );
      expect(
        (await runAgents(root, ["install", "skill", "probe", source])).code,
      ).toBe(0);
      const firstHash = (await readInstalls(sharedState(root)))[0].sha256;

      await Bun.write(
        skillFile,
        '---\nname: probe\ndescription: "Second."\n---\n',
      );
      const conflict = await runAgents(root, [
        "install",
        "skill",
        "probe",
        source,
      ]);
      expect(conflict.code).toBe(1);
      expect(conflict.stderr).toContain(
        "pass --replace for deliberate replacement",
      );
      expect((await readInstalls(sharedState(root)))[0].sha256).toBe(firstHash);

      const replacement = await runAgents(root, [
        "install",
        "skill",
        "probe",
        source,
        "--replace",
      ]);
      expect(replacement.code).toBe(0);
      expect(replacement.stdout).toContain("replaced skill probe sha256=");
      const next = (await readInstalls(sharedState(root)))[0];
      expect(next.sha256).not.toBe(firstHash);
      expect(await Bun.file(path.join(next.path, "SKILL.md")).text()).toContain(
        'description: "Second."',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects malformed skills, symlinks, and secret-like payloads before mutation", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "agents-install-reject-"),
    );
    try {
      const malformed = path.join(root, "malformed");
      await mkdir(malformed, { recursive: true });
      await Bun.write(path.join(malformed, "SKILL.md"), "# No frontmatter\n");
      const malformedResult = await runAgents(root, [
        "install",
        "skill",
        "malformed",
        malformed,
      ]);
      expect(malformedResult.code).toBe(1);
      expect(malformedResult.stderr).toContain("requires YAML frontmatter");

      const secret = path.join(root, "secret");
      await mkdir(secret, { recursive: true });
      await Bun.write(
        path.join(secret, "agent.package.json"),
        '{"schemaVersion":1,"id":"secret","kind":"plugin"}\n',
      );
      await Bun.write(path.join(secret, "auth.json"), "{}\n");
      const secretResult = await runAgents(root, [
        "install",
        "plugin",
        "secret",
        secret,
      ]);
      expect(secretResult.code).toBe(1);
      expect(secretResult.stderr).toContain("secret-like file");

      if (process.platform !== "win32") {
        const linked = path.join(root, "linked");
        await mkdir(linked, { recursive: true });
        await Bun.write(
          path.join(linked, "agent.package.json"),
          '{"schemaVersion":1,"id":"linked","kind":"plugin"}\n',
        );
        await symlink(
          path.join(linked, "agent.package.json"),
          path.join(linked, "alias.json"),
        );
        const linkedResult = await runAgents(root, [
          "install",
          "plugin",
          "linked",
          linked,
        ]);
        expect(linkedResult.code).toBe(1);
        expect(linkedResult.stderr).toContain("symlinks are forbidden");
      }

      expect(await readInstalls(sharedState(root))).toEqual([]);
      expect(
        await Bun.file(
          path.join(root, ".agents", "skills", "malformed"),
        ).exists(),
      ).toBe(false);
      expect(
        await Bun.file(
          path.join(root, ".agents", "plugins", "secret"),
        ).exists(),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("registers package manifests as install side effects", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "agents-install-manifest-"),
    );
    try {
      const source = path.join(root, "source-harness");
      await mkdir(source, { recursive: true });
      await Bun.write(
        path.join(source, "agent.package.json"),
        JSON.stringify({
          schemaVersion: 1,
          id: "probe-harness",
          kind: "harness",
          entry: `${process.execPath} probe.ts`,
          requires: { clis: [], state: ["credits"] },
        }),
      );

      const install = await runAgents(root, [
        "install",
        "harness",
        "probe-harness",
        source,
      ]);
      expect(install.code).toBe(0);

      const registrations = await readPackageRegistrations(sharedState(root));
      expect(registrations).toHaveLength(1);
      expect(registrations[0].id).toBe("probe-harness");
      expect(registrations[0].kind).toBe("harness");
      expect(registrations[0].path).toBe(
        path.join(root, ".agents", "harnesses", "probe-harness"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("activates one worker-scoped identity bundle without replacing capability projections", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-identity-"));
    try {
      const skill = path.join(root, "probe-skill");
      await mkdir(skill, { recursive: true });
      await Bun.write(
        path.join(skill, "SKILL.md"),
        '---\nname: probe\ndescription: "Probe."\n---\n',
      );
      expect(
        (await runAgents(root, ["install", "skill", "probe", skill])).code,
      ).toBe(0);

      const source = path.join(root, "identity-source");
      await mkdir(path.join(source, "roles"), { recursive: true });
      await mkdir(path.join(source, "prompts"), { recursive: true });
      await Bun.write(
        path.join(source, "persona.md"),
        "# Rommie\n\nOne canonical personal agent.\n",
      );
      await Bun.write(
        path.join(source, "roles", "review.yaml"),
        "name: review\nscope: worker\ntype: on-demand\n",
      );
      await Bun.write(
        path.join(source, "prompts", "review.md"),
        "Find defects and return evidence.\n",
      );

      const guarded = await runAgents(root, ["identity", "activate", source]);
      expect(guarded.code).toBe(1);
      expect(guarded.stderr).toContain(
        "pass --replace for deliberate replacement",
      );

      const activated = await runAgents(root, [
        "identity",
        "activate",
        source,
        "--replace",
      ]);
      expect(activated.code).toBe(0);
      expect(activated.stdout).toContain("activated identity rommie sha256=");
      const identity = path.join(root, ".agents", "identity");
      expect(
        await Bun.file(path.join(identity, "persona.md")).text(),
      ).toContain("One canonical personal agent");
      expect(await Bun.file(path.join(identity, "agent.json")).exists()).toBe(
        true,
      );
      expect(
        await Bun.file(path.join(identity, "capabilities.md")).text(),
      ).toContain("## probe");
      expect(await readdir(path.join(identity, "roles"))).toEqual([
        "review.yaml",
      ]);

      const verified = await runAgents(root, ["identity", "activate", source]);
      expect(verified.code).toBe(0);
      expect(verified.stdout).toContain("verified identity rommie sha256=");
      const migrations = await readdir(
        path.join(root, ".agents", "provenance", "migrations"),
      );
      expect(
        migrations.filter((name) => name.startsWith("identity-rommie-")),
      ).toHaveLength(1);
      expect(
        await Bun.file(
          path.join(
            root,
            ".agents",
            "provenance",
            "migrations",
            migrations[0],
            "manifest.json",
          ),
        ).exists(),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires only the canonical, valid manifest for package and executable capability kinds", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "agents-install-strict-manifest-"),
    );
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const before = await snapshotTree(state.stateDir);

      const missing = path.join(root, "missing-manifest");
      await mkdir(missing, { recursive: true });
      await Bun.write(path.join(missing, "main.ts"), "export {};\n");
      await expect(
        installCapability(state, {
          kind: "harness",
          name: "missing",
          source: missing,
        }),
      ).rejects.toThrow("requires agent.package.json");

      const retired = path.join(root, "retired-manifest");
      await mkdir(retired, { recursive: true });
      await Bun.write(
        path.join(retired, "agents.package.json"),
        '{"schemaVersion":1,"id":"retired","kind":"harness","entry":"bun main.ts"}\n',
      );
      await expect(
        installCapability(state, {
          kind: "harness",
          name: "retired",
          source: retired,
        }),
      ).rejects.toThrow("agents.package.json is not supported");

      const noEntry = path.join(root, "missing-entry");
      await mkdir(noEntry, { recursive: true });
      await Bun.write(
        path.join(noEntry, "agent.package.json"),
        '{"schemaVersion":1,"id":"no-entry","kind":"harness"}\n',
      );
      await expect(
        installCapability(state, {
          kind: "harness",
          name: "no-entry",
          source: noEntry,
        }),
      ).rejects.toThrow("requires a non-empty entry command");

      const oldSchema = path.join(root, "old-schema");
      await mkdir(oldSchema, { recursive: true });
      await Bun.write(
        path.join(oldSchema, "agent.package.json"),
        '{"schemaVersion":0,"id":"old-schema","kind":"plugin"}\n',
      );
      await expect(
        installCapability(state, {
          kind: "plugin",
          name: "old-schema",
          source: oldSchema,
        }),
      ).rejects.toThrow("schemaVersion must be 1");

      const invalidShape = path.join(root, "invalid-shape");
      await mkdir(invalidShape, { recursive: true });
      await Bun.write(
        path.join(invalidShape, "agent.package.json"),
        '{"schemaVersion":1,"id":"invalid-shape","kind":"plugin","provides":"old-shape"}\n',
      );
      await expect(
        installCapability(state, {
          kind: "plugin",
          name: "invalid-shape",
          source: invalidShape,
        }),
      ).rejects.toThrow("provides must be an array of non-empty strings");

      expect(await snapshotTree(state.stateDir)).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rolls back every capability publication boundary and makes successful replay byte-identical", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "agents-install-atomic-"),
    );
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const firstSource = path.join(root, "probe-v1");
      const secondSource = path.join(root, "probe-v2");
      await writeSkillFixture(firstSource, "First version");
      await writeSkillFixture(secondSource, "Second version");
      await installCapability(state, {
        kind: "skill",
        name: "probe",
        source: firstSource,
        now: new Date("2026-01-01T00:00:00.000Z"),
      });
      const before = await snapshotTree(state.stateDir);
      const boundaries: CapabilityPublicationBoundary[] = [
        "store",
        "target",
        "installs",
        "packages",
        "capabilities-view",
        "provenance",
      ];

      for (const boundary of boundaries) {
        const observed: CapabilityPublicationBoundary[] = [];
        await expect(
          installCapability(state, {
            kind: "skill",
            name: "probe",
            source: secondSource,
            replace: true,
            now: new Date("2026-02-01T00:00:00.000Z"),
            transactionHooks: {
              afterPublish(current) {
                observed.push(current);
                if (current === boundary)
                  throw new Error(`injected failure after ${boundary}`);
              },
            },
          }),
        ).rejects.toThrow(`injected failure after ${boundary}`);
        expect(observed).toContain(boundary);
        expect(await snapshotTree(state.stateDir)).toEqual(before);
      }

      const replacement = await installCapability(state, {
        kind: "skill",
        name: "probe",
        source: secondSource,
        replace: true,
        now: new Date("2026-02-01T00:00:00.000Z"),
      });
      expect(replacement.changed).toBe(true);
      expect(replacement.replaced).toBe(true);
      const replaced = await snapshotTree(state.stateDir);

      const replay = await installCapability(state, {
        kind: "skill",
        name: "probe",
        source: secondSource,
        now: new Date("2030-01-01T00:00:00.000Z"),
      });
      expect(replay.changed).toBe(false);
      expect(replay.replaced).toBe(false);
      expect(await snapshotTree(state.stateDir)).toEqual(replaced);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rolls back identity publication boundaries and makes activation replay byte-identical", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "agents-identity-atomic-"),
    );
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const firstSource = path.join(root, "identity-v1");
      const secondSource = path.join(root, "identity-v2");
      await writeIdentityFixture(firstSource, "First identity");
      await writeIdentityFixture(secondSource, "Second identity");
      await activateIdentityBundle(state, firstSource, {
        replace: true,
        now: new Date("2026-01-01T00:00:00.000Z"),
      });
      const before = await snapshotTree(state.stateDir);

      for (const boundary of ["store", "target", "provenance"] as const) {
        const observed: CapabilityPublicationBoundary[] = [];
        await expect(
          activateIdentityBundle(state, secondSource, {
            replace: true,
            now: new Date("2026-02-01T00:00:00.000Z"),
            transactionHooks: {
              afterPublish(current) {
                observed.push(current);
                if (current === boundary)
                  throw new Error(`injected failure after ${boundary}`);
              },
            },
          }),
        ).rejects.toThrow(`injected failure after ${boundary}`);
        expect(observed).toContain(boundary);
        expect(await snapshotTree(state.stateDir)).toEqual(before);
      }

      const activated = await activateIdentityBundle(state, secondSource, {
        replace: true,
        now: new Date("2026-02-01T00:00:00.000Z"),
      });
      expect(activated.changed).toBe(true);
      const replaced = await snapshotTree(state.stateDir);
      const replay = await activateIdentityBundle(state, secondSource, {
        now: new Date("2030-01-01T00:00:00.000Z"),
      });
      expect(replay.changed).toBe(false);
      expect(await snapshotTree(state.stateDir)).toEqual(replaced);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("recovers an interrupted prepared transaction before the next capability operation", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "agents-install-recovery-"),
    );
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const firstSource = path.join(root, "probe-v1");
      const secondSource = path.join(root, "probe-v2");
      await writeSkillFixture(firstSource, "First version");
      await writeSkillFixture(secondSource, "Second version");
      await installCapability(state, {
        kind: "skill",
        name: "probe",
        source: firstSource,
        now: new Date("2026-01-01T00:00:00.000Z"),
      });
      const before = await snapshotTree(state.stateDir);
      const capabilitiesModule = path.join(
        repoRoot,
        "src",
        "capabilities.ts",
      );
      const stateModule = path.join(repoRoot, "src", "state.ts");
      const crashScript = `
        import { installCapability } from ${JSON.stringify(capabilitiesModule)};
        import { sharedState } from ${JSON.stringify(stateModule)};
        await installCapability(sharedState(process.env.TEST_ROOT), {
          kind: "skill",
          name: "probe",
          source: process.env.TEST_SOURCE,
          replace: true,
          now: new Date("2026-02-01T00:00:00.000Z"),
          transactionHooks: {
            afterPublish(boundary) {
              if (boundary === "installs") process.exit(86);
            },
          },
        });
      `;
      const crashed = Bun.spawn([process.execPath, "-e", crashScript], {
        cwd: repoRoot,
        env: { ...cleanEnv(), TEST_ROOT: root, TEST_SOURCE: secondSource },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stderr] = await Promise.all([
        crashed.exited,
        new Response(crashed.stderr).text(),
      ]);
      expect({ code, stderr }).toEqual({ code: 86, stderr: "" });
      expect(await snapshotTree(state.stateDir)).not.toEqual(before);

      const recovered = await installCapability(state, {
        kind: "skill",
        name: "probe",
        source: firstSource,
        now: new Date("2030-01-01T00:00:00.000Z"),
      });
      expect(recovered.changed).toBe(false);
      expect(await snapshotTree(state.stateDir)).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
