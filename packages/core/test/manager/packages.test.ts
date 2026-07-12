import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readPackageManifest, upsertPackageRegistration, readPackageRegistrations } from "../../src/manager/packages";
import { ensureSharedState, sharedState } from "../../src/manager/state";

describe("package manifests", () => {
  test("reads harness requirements", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agents-package-"));
    try {
      await Bun.write(
        path.join(dir, "agent.package.json"),
        JSON.stringify({
          schemaVersion: 1,
          id: "agents-harness",
          kind: "harness",
          requires: { clis: ["codex", "claude", "kimi", "agy"], state: ["skills", "plugins", "hooks", "credits"] },
          dataRepo: {
            id: "project-data",
            repo: "marius-patrik/project-data",
            path: "data/project",
            env: "PROJECT_DATA_ROOT",
          },
          entry: "bun run harness.ts",
          workingDirectory: "runtime",
        }),
      );

      const manifest = await readPackageManifest(dir);
      expect(manifest?.id).toBe("agents-harness");
      expect(manifest?.kind).toBe("harness");
      expect(manifest?.workingDirectory).toBe("runtime");
      expect(manifest?.requires?.clis).toContain("codex");
      expect(manifest?.dataRepo?.repo).toBe("marius-patrik/project-data");
      expect(manifest?.dataRepo?.managedPath).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("upserts package registrations", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agents-state-"));
    try {
      const state = sharedState(dir);
      await ensureSharedState(state);
      await upsertPackageRegistration(state, { id: "agents-harness", kind: "harness", path: path.join(dir, "agents-harness") });
      await upsertPackageRegistration(state, { id: "agents-harness", kind: "harness", path: path.join(dir, "agents-harness-2") });

      const registrations = await readPackageRegistrations(state);
      expect(registrations).toHaveLength(1);
      expect(registrations[0].path).toBe(path.join(dir, "agents-harness-2"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
