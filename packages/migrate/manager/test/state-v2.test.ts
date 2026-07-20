import { describe, expect, test } from "bun:test";
import { link, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureSharedState, sharedStateAt } from "../src/state";
import {
  MAX_PLUGIN_RUNTIME_PROJECTION_BYTES,
  pluginRuntimeProjectionPath,
  publishAtomicReplacement,
  publishPluginRuntimeProjection,
  readStateManifest,
  stateV2Paths,
  writeTextAtomic,
  writeTextExclusive,
} from "../src/state-v2";

describe("Agent OS state v2 bootstrap", () => {
  test("publishes bounded plugin runtime projections through the manager boundary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-plugin-projection-"));
    try {
      const state = sharedStateAt(root, path.join(root, ".agents"), path.join(root, "user"));
      await ensureSharedState(state);
      const filePath = await publishPluginRuntimeProjection(state, "memory", "dream-v1.3-cursor", {
        schemaVersion: 1,
        authority: "canonical-memory-event",
      });
      expect(filePath).toBe(pluginRuntimeProjectionPath(state, "memory", "dream-v1.3-cursor"));
      expect(await Bun.file(filePath).json()).toEqual({ schemaVersion: 1, authority: "canonical-memory-event" });
      const admittedContent = await readFile(filePath, "utf8");
      await expect(
        publishPluginRuntimeProjection(state, "memory", "dream-v1.3-cursor", {
          payload: "é".repeat(Math.ceil(MAX_PLUGIN_RUNTIME_PROJECTION_BYTES / 2)),
        }),
      ).rejects.toThrow(/exceeds 16777216 bytes/);
      expect(await readFile(filePath, "utf8")).toBe(admittedContent);
      await expect(
        publishPluginRuntimeProjection(state, "Memory", "dream-v1.3-cursor", { schemaVersion: 2 }),
      ).rejects.toThrow(/id is invalid/);
      await expect(
        publishPluginRuntimeProjection(state, "memory", "Dream-v1.3-cursor", { schemaVersion: 2 }),
      ).rejects.toThrow(/name is invalid/);
      await expect(
        publishPluginRuntimeProjection(state, "memory", "dream-v1.3-cursor", { toJSON: () => "scalar" }),
      ).rejects.toThrow(/must serialize to a JSON object/);
      await expect(
        publishPluginRuntimeProjection(state, "memory", "dream-v1.3-cursor", { toJSON: () => ["array"] }),
      ).rejects.toThrow(/must serialize to a JSON object/);
      expect(await readFile(filePath, "utf8")).toBe(admittedContent);
      expect(() => pluginRuntimeProjectionPath(state, "../escape", "cursor")).toThrow(/id is invalid/);
      expect(() => pluginRuntimeProjectionPath(state, "CON", "cursor")).toThrow(/id is invalid/);
      expect(() => pluginRuntimeProjectionPath(state, "memory", "NUL.json")).toThrow(/name is invalid/);
      expect(() => pluginRuntimeProjectionPath(state, "memory", "cursor.")).toThrow(/name is invalid/);
      await expect(publishPluginRuntimeProjection(state, "memory", "cursor", "not-an-object")).rejects.toThrow(
        /must be an object/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("success: Windows projection publication performs one atomic replace without waiting", async () => {
    const temporary = "C:\\state\\.projection.tmp";
    const destination = "C:\\state\\projection.json";
    const files = new Map([[temporary, "new"], [destination, "old"]]);
    const waits: number[] = [];
    let attempts = 0;
    const renameOperation = async (source: string, target: string) => {
      attempts += 1;
      expect(source).toBe(temporary);
      expect(target).toBe(destination);
      expect(files.get(destination)).toBe("old");
      const content = files.get(source);
      if (content === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      files.delete(source);
      files.set(target, content);
    };
    await publishAtomicReplacement(temporary, destination, {
      platform: "win32",
      rename: renameOperation as typeof import("node:fs/promises").rename,
      wait: async (milliseconds) => { waits.push(milliseconds); },
    });
    expect(files.get(destination)).toBe("new");
    expect(files.has(temporary)).toBe(false);
    expect(attempts).toBe(1);
    expect(waits).toEqual([]);
  });

  test("edge: Windows projection publication survives handle delay beyond the generic retry horizon", async () => {
    const temporary = "C:\\state\\.projection.tmp";
    const destination = "C:\\state\\projection.json";
    const files = new Map([[temporary, "new"], [destination, "old"]]);
    const waits: number[] = [];
    let attempts = 0;
    let elapsedMilliseconds = 0;
    await publishAtomicReplacement(temporary, destination, {
      platform: "win32",
      rename: (async (source: string, target: string) => {
        attempts += 1;
        expect(files.get(destination)).toBe("old");
        if (elapsedMilliseconds < 1_000) {
          throw Object.assign(new Error("busy"), { code: "EPERM" });
        }
        const content = files.get(source);
        if (content === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        files.delete(source);
        files.set(target, content);
      }) as typeof import("node:fs/promises").rename,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
        elapsedMilliseconds += milliseconds;
      },
    });
    expect(attempts).toBe(8);
    expect(waits).toEqual([10, 20, 40, 80, 160, 320, 640]);
    expect(elapsedMilliseconds).toBe(1_270);
    expect(files.get(destination)).toBe("new");
    expect(files.has(temporary)).toBe(false);
  });

  test("denied: Windows projection exhaustion preserves prior state and cleans its temp", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-v2-projection-failure-"));
    const destination = path.join(root, "projection.json");
    const waits: number[] = [];
    let attempts = 0;
    const busy = Object.assign(new Error("busy"), { code: "EPERM" });
    let caught: unknown;
    try {
      await Bun.write(destination, "old-complete-projection\n");
      try {
        await writeTextAtomic(destination, "new-complete-projection\n", 0o600, {
          platform: "win32",
          rename: (async (_source: string, target: string) => {
            attempts += 1;
            expect(target).toBe(destination);
            expect(await readFile(destination, "utf8")).toBe("old-complete-projection\n");
            throw busy;
          }) as typeof import("node:fs/promises").rename,
          wait: async (milliseconds) => { waits.push(milliseconds); },
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(busy);
      expect(attempts).toBe(12);
      expect(waits).toEqual([10, 20, 40, 80, 160, 320, 640, 1_000, 1_000, 1_000, 1_000]);
      expect(await readFile(destination, "utf8")).toBe("old-complete-projection\n");
      expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("POSIX projection publication does not retry a terminal rename failure", async () => {
    let attempts = 0;
    let waited = false;
    await expect(publishAtomicReplacement("/state/.projection.tmp", "/state/projection.json", {
      platform: "linux",
      rename: (async () => {
        attempts += 1;
        throw Object.assign(new Error("denied"), { code: "EPERM" });
      }) as typeof import("node:fs/promises").rename,
      wait: async () => { waited = true; },
    })).rejects.toThrow("denied");
    expect(attempts).toBe(1);
    expect(waited).toBe(false);
  });

  test("manifest publication retries transient Windows link failures", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-v2-manifest-retry-"));
    const destination = path.join(root, "manifest.json");
    let attempts = 0;
    try {
      const published = await writeTextExclusive(destination, "{\"complete\":true}\n", 0o600, {
        platform: "win32",
        link: (async (source: string, target: string) => {
          if (attempts++ < 2) throw Object.assign(new Error("busy"), { code: "EBUSY" });
          await link(source, target);
        }) as typeof import("node:fs/promises").link,
        wait: async () => undefined,
      });
      expect(published).toBe(true);
      expect(attempts).toBe(3);
      expect(await readFile(destination, "utf8")).toBe("{\"complete\":true}\n");
      expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("concurrent manifest publication preserves one immutable winner", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-v2-manifest-winner-"));
    const destination = path.join(root, "manifest.json");
    try {
      const candidates = Array.from({ length: 16 }, (_, index) => `candidate-${index}\n`);
      const publications = await Promise.all(
        candidates.map((candidate) => writeTextExclusive(destination, candidate)),
      );
      expect(publications.filter(Boolean)).toHaveLength(1);
      const winner = candidates[publications.findIndex(Boolean)];
      expect(await readFile(destination, "utf8")).toBe(winner);
      expect(await writeTextExclusive(destination, "late-loser\n")).toBe(false);
      expect(await readFile(destination, "utf8")).toBe(winner);
      expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("terminal manifest publication failure is loud and cleans its temporary file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-v2-manifest-failure-"));
    const destination = path.join(root, "manifest.json");
    const waits: number[] = [];
    let attempts = 0;
    try {
      await expect(writeTextExclusive(destination, "unpublished\n", 0o600, {
        platform: "win32",
        link: (async () => {
          attempts += 1;
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        }) as typeof import("node:fs/promises").link,
        wait: async (milliseconds) => { waits.push(milliseconds); },
      })).rejects.toThrow("denied");
      expect(attempts).toBe(10);
      expect(waits).toEqual([10, 20, 40, 80, 160, 160, 160, 160, 160]);
      expect(await Bun.file(destination).exists()).toBe(false);
      expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("concurrent atomic replacements leave one complete value and no temp files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-v2-atomic-"));
    const destination = path.join(root, "projection.json");
    const contents = Array.from({ length: 32 }, (_, index) => JSON.stringify({ index, body: "x".repeat(64_000) }));
    try {
      await Promise.all(contents.map((content) => writeTextAtomic(destination, content)));
      expect(contents).toContain(await readFile(destination, "utf8"));
      expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("exclusive seeds become visible only after their complete content is durable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-v2-exclusive-"));
    const destination = path.join(root, "seed.txt");
    const content = `${"complete-seed-content\n".repeat(200_000)}done\n`;
    const observed = new Set<string>();
    let writerDone = false;

    try {
      const writer = writeTextExclusive(destination, content).finally(() => {
        writerDone = true;
      });
      while (!writerDone) {
        try {
          observed.add(await readFile(destination, "utf8"));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      expect(await writer).toBe(true);
      observed.add(await readFile(destination, "utf8"));
      expect([...observed]).toEqual([content]);

      const contenders = await Promise.all(
        Array.from({ length: 16 }, () => writeTextExclusive(destination, "replacement\n")),
      );
      expect(contenders.every((published) => !published)).toBe(true);
      expect(await readFile(destination, "utf8")).toBe(content);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("creates one stable Rommie manifest and canonical bootstrap paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-v2-"));
    try {
      const state = sharedStateAt(root, path.join(root, ".agents"), path.join(root, "user"));
      await ensureSharedState(state);
      const first = await readStateManifest(state);
      expect(first?.schemaVersion).toBe(2);
      expect(first?.agentId).toBe("rommie");

      const paths = stateV2Paths(state);
      expect(await Bun.file(path.join(paths.identityDir, "agent.json")).exists()).toBe(true);
      expect(await Bun.file(path.join(paths.memoryViewsDir, "startup.md")).exists()).toBe(true);
      expect(await Bun.file(paths.providersFile).exists()).toBe(true);
      expect(await Bun.file(state.configFile).json()).toEqual({ schemaVersion: 1 });

      const manifestBefore = await readFile(paths.manifestFile, "utf8");
      const envBefore = await readFile(state.envFile, "utf8");
      await ensureSharedState(state);
      expect(await readFile(paths.manifestFile, "utf8")).toBe(manifestBefore);
      expect(await readFile(state.envFile, "utf8")).toBe(envBefore);
      expect((await readStateManifest(state))?.installId).toBe(first?.installId);

      expect(envBefore).toContain(`AGENTS_HOME=${state.stateDir}`);
      expect(envBefore).toContain(`AGENTS_USER_HOME=${state.userHome}`);
      expect(envBefore).toContain(`AGENTS_MEMORY=${paths.memoryDir}`);

      if (process.platform !== "win32") {
        expect((await stat(state.stateDir)).mode & 0o077).toBe(0);
        expect((await stat(paths.manifestFile)).mode & 0o077).toBe(0);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
