import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  cp,
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
  importBundledLegacySkill,
  installCapability,
  type CapabilityPublicationBoundary,
} from "../capabilities";
import {
  ensureSharedState,
  readInstalls,
  sharedState,
} from "../state";
import {
  readPackageRegistrations,
  upsertPackageRegistration,
} from "../packages";

const repoRoot = path.resolve(import.meta.dir, "..");
const cliPath = path.join(repoRoot, "cli.ts");

function cleanEnv(): Record<string, string | undefined> {
  const copy = { ...process.env };
  for (const key of Object.keys(copy)) {
    if (key.startsWith("ANDROMEDA_")) delete copy[key];
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
      ANDROMEDA_HOME: path.join(cwd, ".agents"),
      ANDROMEDA_ROOT: cwd,
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
  publisher = "andromeda-test",
  id = "probe",
): Promise<void> {
  await mkdir(root, { recursive: true });
  await Bun.write(
    path.join(root, "SKILL.md"),
    `---\nname: ${id}\ndescription: "${description}"\n---\n\n# ${description}\n`,
  );
  await Bun.write(
    path.join(root, "agent.package.json"),
    `${JSON.stringify(publicCapabilityManifest(id, "skill", publisher))}\n`,
  );
}

function publicCapabilityManifest(
  id: string,
  kind: "skill" | "plugin" | "hook" | "template" | "cli" | "harness",
  publisher = "andromeda-test",
) {
  return {
    schemaVersion: 2,
    publisher,
    id,
    name: `${publisher}/${id}`,
    kind,
    version: "1.0.0",
    license: "Apache-2.0",
    compatibility: {
      andromeda: ">=0.10.0 <2.0.0",
      api: "2",
    },
    runtime: {
      kind: "declarative",
    },
    contributions: {
      commands: [
        {
          id: "probe",
          name: "probe",
          description: "Run the probe.",
          handler: {
            kind: "declarative",
            action: "probe.run",
          },
        },
      ],
    },
    permissions: {
      workspaces: "none",
      sessions: "none",
      memory: "none",
      models: [],
      networkOrigins: [],
      secrets: [],
      clipboard: "none",
      notifications: false,
      externalUrls: [],
    },
  };
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
      await writeSkillFixture(source, "A deterministic probe.");
      const identity = "andromeda-test/probe";

      const install = await runAgents(root, [
        "install",
        "skill",
        identity,
        source,
      ]);
      expect(install.code).toBe(0);
      expect(install.stdout).toContain(`installed skill ${identity} sha256=`);
      const installs = await readInstalls(sharedState(root));
      expect(installs).toHaveLength(1);
      expect(
        await Bun.file(path.join(installs[0].path, "SKILL.md")).text(),
      ).toContain("# A deterministic probe.");
      const registryBefore = await Bun.file(
        path.join(root, ".agents", "installs.json"),
      ).text();

      const duplicate = await runAgents(root, [
        "install",
        "skill",
        identity,
        source,
      ]);
      expect(duplicate.code).toBe(0);
      expect(duplicate.stdout).toContain(`verified skill ${identity} sha256=`);
      expect(
        await Bun.file(path.join(root, ".agents", "installs.json")).text(),
      ).toBe(registryBefore);

      expect(installs[0].kind).toBe("skill");
      expect(installs[0].name).toBe(identity);
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
      await writeSkillFixture(source, "First.");
      const skillFile = path.join(source, "SKILL.md");
      const identity = "andromeda-test/probe";
      expect(
        (await runAgents(root, ["install", "skill", identity, source])).code,
      ).toBe(0);
      const firstHash = (await readInstalls(sharedState(root)))[0].sha256;

      await Bun.write(
        skillFile,
        '---\nname: probe\ndescription: "Second."\n---\n',
      );
      const conflict = await runAgents(root, [
        "install",
        "skill",
        identity,
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
        identity,
        source,
        "--replace",
      ]);
      expect(replacement.code).toBe(0);
      expect(replacement.stdout).toContain(
        `replaced skill ${identity} sha256=`,
      );
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
      await Bun.write(
        path.join(malformed, "agent.package.json"),
        JSON.stringify(publicCapabilityManifest("malformed", "skill")),
      );
      const malformedResult = await runAgents(root, [
        "install",
        "skill",
        "andromeda-test/malformed",
        malformed,
      ]);
      expect(malformedResult.code).toBe(1);
      expect(malformedResult.stderr).toContain("requires YAML frontmatter");

      const secret = path.join(root, "secret");
      await mkdir(secret, { recursive: true });
      await Bun.write(
        path.join(secret, "agent.package.json"),
        JSON.stringify(publicCapabilityManifest("secret", "plugin")),
      );
      await Bun.write(path.join(secret, "auth.json"), "{}\n");
      const secretResult = await runAgents(root, [
        "install",
        "plugin",
        "andromeda-test/secret",
        secret,
      ]);
      expect(secretResult.code).toBe(1);
      expect(secretResult.stderr).toContain("secret-like file");

      if (process.platform !== "win32") {
        const linked = path.join(root, "linked");
        await mkdir(linked, { recursive: true });
        await Bun.write(
          path.join(linked, "agent.package.json"),
          JSON.stringify(publicCapabilityManifest("linked", "plugin")),
        );
        await symlink(
          path.join(linked, "agent.package.json"),
          path.join(linked, "alias.json"),
        );
        const linkedResult = await runAgents(root, [
          "install",
          "plugin",
          "andromeda-test/linked",
          linked,
        ]);
        expect(linkedResult.code).toBe(1);
        expect(linkedResult.stderr).toContain("symlinks are forbidden");
      }

      expect(await readInstalls(sharedState(root))).toEqual([]);
      expect(await readdir(path.join(root, ".agents", "skills"))).toEqual([]);
      expect(await readdir(path.join(root, ".agents", "plugins"))).toEqual([]);
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
        JSON.stringify(publicCapabilityManifest("probe-harness", "harness")),
      );

      const install = await runAgents(root, [
        "install",
        "harness",
        "andromeda-test/probe-harness",
        source,
      ]);
      expect(install.code).toBe(0);

      const registrations = await readPackageRegistrations(sharedState(root));
      expect(registrations).toHaveLength(1);
      expect(registrations[0].id).toBe("andromeda-test/probe-harness");
      expect(registrations[0].kind).toBe("harness");
      expect(path.dirname(registrations[0].path)).toBe(
        path.join(root, ".agents", "harnesses"),
      );
      expect(path.basename(registrations[0].path)).toMatch(/^v2-[a-f0-9]{64}$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires schema v2 and qualified identity for public package registration", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "agents-package-register-v2-"),
    );
    try {
      const legacy = path.join(root, "legacy-package");
      await mkdir(legacy, { recursive: true });
      await Bun.write(
        path.join(legacy, "agent.package.json"),
        '{"schemaVersion":1,"id":"legacy","kind":"plugin"}\n',
      );
      const rejected = await runAgents(root, [
        "packages",
        "register",
        legacy,
      ]);
      expect(rejected.code).toBe(1);
      expect(rejected.stderr).toContain(
        "schemaVersion 2 is required for public capabilities",
      );
      expect(await readPackageRegistrations(sharedState(root))).toEqual([]);

      const modern = path.join(root, "modern-package");
      await mkdir(modern, { recursive: true });
      await Bun.write(
        path.join(modern, "agent.package.json"),
        JSON.stringify(
          publicCapabilityManifest("shared", "plugin", "alpha"),
        ),
      );
      const registered = await runAgents(root, [
        "packages",
        "register",
        modern,
      ]);
      expect(registered).toMatchObject({ code: 0, stderr: "" });
      expect(registered.stdout).toContain("registered plugin alpha/shared");
      expect(await readPackageRegistrations(sharedState(root))).toMatchObject([
        { id: "alpha/shared", kind: "plugin", path: modern },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps equal package ids from different publishers distinct in state and on disk", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "agents-install-qualified-id-"),
    );
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      for (const publisher of ["alpha", "beta"]) {
        const source = path.join(root, `${publisher}-shared`);
        await mkdir(source, { recursive: true });
        await Bun.write(
          path.join(source, "agent.package.json"),
          JSON.stringify(
            publicCapabilityManifest("shared", "plugin", publisher),
          ),
        );
        await expect(
          installCapability(state, {
            kind: "plugin",
            name: `${publisher}/shared`,
            source,
          }),
        ).resolves.toMatchObject({ changed: true, replaced: false });
      }

      const installs = await readInstalls(state);
      expect(installs.map((item) => item.name).sort()).toEqual([
        "alpha/shared",
        "beta/shared",
      ]);
      expect(new Set(installs.map((item) => item.path)).size).toBe(2);
      for (const record of installs) {
        expect(path.dirname(record.path)).toBe(state.pluginsDir);
        expect(path.basename(record.path)).toMatch(/^v2-[a-f0-9]{64}$/);
      }
      expect(
        (await readPackageRegistrations(state))
          .map((item) => item.id)
          .sort(),
      ).toEqual(["alpha/shared", "beta/shared"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects incompatible public packages without publishing state", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "agents-install-compatibility-"),
    );
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const source = path.join(root, "future-plugin");
      await mkdir(source, { recursive: true });
      const manifest = publicCapabilityManifest("future", "plugin");
      manifest.compatibility.andromeda = ">=999.0.0";
      await Bun.write(
        path.join(source, "agent.package.json"),
        JSON.stringify(manifest),
      );
      const before = await snapshotTree(state.stateDir);

      await expect(
        installCapability(state, {
          kind: "plugin",
          name: "andromeda-test/future",
          source,
        }),
      ).rejects.toThrow(
        "requires Andromeda >=999.0.0, current version is 0.10.0",
      );
      expect(await snapshotTree(state.stateDir)).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preflights installed v2 registrations and the candidate before publication", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "agents-install-command-preflight-"),
    );
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const broken = path.join(root, "broken-registration");
      await mkdir(broken, { recursive: true });
      await Bun.write(
        path.join(broken, "agent.package.json"),
        '{"schemaVersion":1,"id":"broken","kind":"plugin"}\n',
      );
      await upsertPackageRegistration(state, {
        id: "broken/public",
        kind: "plugin",
        path: broken,
        manifestPath: path.join(broken, "agent.package.json"),
      });

      const candidate = path.join(root, "candidate");
      await mkdir(candidate, { recursive: true });
      await Bun.write(
        path.join(candidate, "agent.package.json"),
        JSON.stringify(publicCapabilityManifest("candidate", "plugin")),
      );
      const before = await snapshotTree(state.stateDir);
      await expect(
        installCapability(state, {
          kind: "plugin",
          name: "andromeda-test/candidate",
          source: candidate,
        }),
      ).rejects.toThrow(
        "public package registration broken/public has no schema v2 manifest",
      );
      expect(await snapshotTree(state.stateDir)).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps legacy skills behind the path-pinned first-party import bridge", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "agents-install-legacy-bridge-"),
    );
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const arbitrary = path.join(root, "legacy-skill");
      await mkdir(arbitrary, { recursive: true });
      await Bun.write(
        path.join(arbitrary, "SKILL.md"),
        '---\nname: legacy\ndescription: "Legacy."\n---\n',
      );
      const before = await snapshotTree(state.stateDir);

      await expect(
        installCapability(state, {
          kind: "skill",
          name: "legacy-owner/legacy",
          source: arbitrary,
        }),
      ).rejects.toThrow("requires agent.package.json");
      await expect(
        importBundledLegacySkill(state, {
          name: "legacy",
          source: arbitrary,
        }),
      ).rejects.toThrow("internal bundled-skill import is path-pinned");
      expect(await snapshotTree(state.stateDir)).toEqual(before);

      const bundledPass = path.resolve(
        repoRoot,
        "..",
        "..",
        ".agents",
        "global",
        "skills",
        "pass",
      );
      const imported = await importBundledLegacySkill(state, {
        name: "pass",
        source: bundledPass,
      });
      expect(imported.record).toMatchObject({
        kind: "skill",
        name: "pass",
        path: path.join(state.skillsDir, "pass"),
      });
      const provenance = (
        await readdir(path.join(state.stateDir, "provenance", "migrations"))
      ).find((name) => name.startsWith("capability-skill-pass-"));
      expect(provenance).toBeDefined();
      const receipt = (await Bun.file(
        path.join(
          state.stateDir,
          "provenance",
          "migrations",
          provenance!,
          "manifest.json",
        ),
      ).json()) as { importMode?: string };
      expect(receipt.importMode).toBe("andromeda-bundled-skill-v1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("activates one worker-scoped identity bundle without replacing capability projections", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-identity-"));
    try {
      const skill = path.join(root, "probe-skill");
      await writeSkillFixture(skill, "Probe.");
      expect(
        (
          await runAgents(root, [
            "install",
            "skill",
            "andromeda-test/probe",
            skill,
          ])
        ).code,
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
      ).toContain("## andromeda-test/probe");
      expect(await readdir(path.join(identity, "roles"))).toEqual([
        "review.yaml",
      ]);

      const verified = await runAgents(root, ["identity", "activate", source]);
      expect(verified.code).toBe(0);
      expect(verified.stdout).toContain("verified identity rommie sha256=");
      const relocatedSource = path.join(root, "relocated-identity-source");
      await cp(source, relocatedSource, { recursive: true });
      const relocated = await runAgents(root, ["identity", "activate", relocatedSource]);
      expect(relocated.code).toBe(0);
      expect(relocated.stdout).toContain("verified identity rommie sha256=");
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
          name: "andromeda-test/missing",
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
          name: "andromeda-test/retired",
          source: retired,
        }),
      ).rejects.toThrow("agents.package.json is not supported");

      const legacyNative = path.join(root, "legacy-native");
      await mkdir(legacyNative, { recursive: true });
      await Bun.write(
        path.join(legacyNative, "agent.package.json"),
        '{"schemaVersion":1,"id":"legacy-native","kind":"harness","entry":"bun main.ts"}\n',
      );
      await expect(
        installCapability(state, {
          kind: "harness",
          name: "andromeda-test/legacy-native",
          source: legacyNative,
        }),
      ).rejects.toThrow(
        "schemaVersion 2 is required for public capabilities",
      );

      const oldSchema = path.join(root, "old-schema");
      await mkdir(oldSchema, { recursive: true });
      await Bun.write(
        path.join(oldSchema, "agent.package.json"),
        '{"schemaVersion":0,"id":"old-schema","kind":"plugin"}\n',
      );
      await expect(
        installCapability(state, {
          kind: "plugin",
          name: "andromeda-test/old-schema",
          source: oldSchema,
        }),
      ).rejects.toThrow("schemaVersion 2 is required for public capabilities");

      const invalidShape = path.join(root, "invalid-shape");
      await mkdir(invalidShape, { recursive: true });
      const invalidManifest = {
        ...publicCapabilityManifest("invalid-shape", "plugin"),
        provides: "old-shape",
      };
      await Bun.write(
        path.join(invalidShape, "agent.package.json"),
        JSON.stringify(invalidManifest),
      );
      await expect(
        installCapability(state, {
          kind: "plugin",
          name: "andromeda-test/invalid-shape",
          source: invalidShape,
        }),
      ).rejects.toThrow("manifest contains unsupported field provides");

      const native = path.join(root, "native-entry");
      await mkdir(native, { recursive: true });
      await Bun.write(
        path.join(native, "agent.package.json"),
        JSON.stringify({
          ...publicCapabilityManifest("native-entry", "plugin"),
          entry: "node plugin.js",
        }),
      );
      await expect(
        installCapability(state, {
          kind: "plugin",
          name: "andromeda-test/native-entry",
          source: native,
        }),
      ).rejects.toThrow("manifest contains unsupported field entry");

      const wasi = path.join(root, "wasi-plugin");
      await mkdir(path.join(wasi, "runtime"), { recursive: true });
      const wasm = Uint8Array.from([
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
        0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
        0x03, 0x02, 0x01, 0x00,
        0x07, 0x0d, 0x01, 0x09, 0x72, 0x75, 0x6e, 0x5f, 0x70, 0x72, 0x6f,
        0x62, 0x65, 0x00, 0x00,
        0x0a, 0x04, 0x01, 0x02, 0x00, 0x0b,
      ]);
      await Bun.write(path.join(wasi, "runtime", "plugin.wasm"), wasm);
      const wasiManifest = publicCapabilityManifest("wasi-plugin", "plugin");
      (wasiManifest as any).runtime = {
        kind: "wasi",
        module: "runtime/plugin.wasm",
        sha256: "f".repeat(64),
      };
      (wasiManifest.contributions.commands[0] as any).handler = {
        kind: "wasi",
        export: "run_probe",
      };
      await Bun.write(
        path.join(wasi, "agent.package.json"),
        JSON.stringify(wasiManifest),
      );
      await expect(
        installCapability(state, {
          kind: "plugin",
          name: "andromeda-test/wasi-plugin",
          source: wasi,
        }),
      ).rejects.toThrow(
        "WASI module digest does not match runtime.sha256",
      );
      expect(await snapshotTree(state.stateDir)).toEqual(before);

      (wasiManifest.runtime as any).sha256 = createHash("sha256")
        .update(wasm)
        .digest("hex");
      await Bun.write(
        path.join(wasi, "agent.package.json"),
        JSON.stringify(wasiManifest),
      );
      await expect(
        installCapability(state, {
          kind: "plugin",
          name: "andromeda-test/wasi-plugin",
          source: wasi,
        }),
      ).resolves.toMatchObject({
        changed: true,
      });

      (wasiManifest.contributions.commands[0] as any).handler.export =
        "missing_export";
      await Bun.write(
        path.join(wasi, "agent.package.json"),
        JSON.stringify(wasiManifest),
      );
      const beforeMissingExport = await snapshotTree(state.stateDir);
      await expect(
        installCapability(state, {
          kind: "plugin",
          name: "andromeda-test/wasi-plugin",
          source: wasi,
          replace: true,
        }),
      ).rejects.toThrow(
        "WASI command export is missing or not a function: missing_export",
      );
      expect(await snapshotTree(state.stateDir)).toEqual(beforeMissingExport);
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
        name: "andromeda-test/probe",
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
            name: "andromeda-test/probe",
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
        name: "andromeda-test/probe",
        source: secondSource,
        replace: true,
        now: new Date("2026-02-01T00:00:00.000Z"),
      });
      expect(replacement.changed).toBe(true);
      expect(replacement.replaced).toBe(true);
      const replaced = await snapshotTree(state.stateDir);

      const replay = await installCapability(state, {
        kind: "skill",
        name: "andromeda-test/probe",
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
        name: "andromeda-test/probe",
        source: firstSource,
        now: new Date("2026-01-01T00:00:00.000Z"),
      });
      const before = await snapshotTree(state.stateDir);
      const capabilitiesModule = path.join(repoRoot, "capabilities.ts");
      const stateModule = path.join(repoRoot, "state.ts");
      const crashScript = `
        import { installCapability } from ${JSON.stringify(capabilitiesModule)};
        import { sharedState } from ${JSON.stringify(stateModule)};
        await installCapability(sharedState(process.env.TEST_ROOT), {
          kind: "skill",
          name: "andromeda-test/probe",
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
        name: "andromeda-test/probe",
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
