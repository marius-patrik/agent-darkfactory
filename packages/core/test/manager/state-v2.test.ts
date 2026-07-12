import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureSharedState, sharedStateAt } from "../../src/manager/state";
import { readStateManifest, stateV2Paths, writeTextExclusive } from "../../src/manager/state-v2";

describe("Agent OS state v2 bootstrap", () => {
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
