import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureSharedState, sharedStateAt } from "../src/state";
import {
  publishAtomicReplacement,
  readStateManifest,
  stateV2Paths,
  writeTextAtomic,
  writeTextExclusive,
} from "../src/state-v2";

describe("Agent OS state v2 bootstrap", () => {
  test("Windows replacement fallback publishes complete temp and removes its backup", async () => {
    const temporary = "C:\\state\\.projection.tmp";
    const destination = "C:\\state\\projection.json";
    const files = new Map([[temporary, "new"], [destination, "old"]]);
    let directAttempts = 0;
    const renameOperation = async (source: string, target: string) => {
      if (source === temporary && target === destination && directAttempts++ < 8) {
        throw Object.assign(new Error("busy"), { code: "EPERM" });
      }
      const content = files.get(source);
      if (content === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      files.delete(source);
      files.set(target, content);
    };
    await publishAtomicReplacement(temporary, destination, {
      platform: "win32",
      rename: renameOperation as typeof import("node:fs/promises").rename,
      rm: (async (target: string) => { files.delete(target); }) as typeof import("node:fs/promises").rm,
      stat: (async (target: string) => {
        if (!files.has(target)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return {};
      }) as unknown as typeof import("node:fs/promises").stat,
      wait: async () => undefined,
      randomId: () => "backup",
    });
    expect(files.get(destination)).toBe("new");
    expect([...files.keys()].some((item) => item.endsWith(".bak"))).toBe(false);
  });

  test("Windows terminal replacement failure restores the previous complete projection", async () => {
    const temporary = "C:\\state\\.projection.tmp";
    const destination = "C:\\state\\projection.json";
    const files = new Map([[temporary, "new"], [destination, "old"]]);
    let initialAttempts = 0;
    let backupCreated = false;
    const renameOperation = async (source: string, target: string) => {
      if (source === temporary && target === destination) {
        if (!backupCreated) initialAttempts += 1;
        throw Object.assign(new Error("busy"), { code: "EPERM" });
      }
      const content = files.get(source);
      if (content === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      files.delete(source);
      files.set(target, content);
      if (source === destination) backupCreated = true;
    };
    await expect(publishAtomicReplacement(temporary, destination, {
      platform: "win32",
      rename: renameOperation as typeof import("node:fs/promises").rename,
      rm: (async (target: string) => { files.delete(target); }) as typeof import("node:fs/promises").rm,
      stat: (async () => ({})) as unknown as typeof import("node:fs/promises").stat,
      wait: async () => undefined,
      randomId: () => "backup",
    })).rejects.toThrow("busy");
    expect(initialAttempts).toBe(8);
    expect(files.get(destination)).toBe("old");
    expect(files.get(temporary)).toBe("new");
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
