import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { dataRepoManagedRoot, readDataRepos, upsertDataRepo } from "../src/data-repos";
import { ensureSharedState, sharedState } from "../src/state";

describe("data repos", () => {
  test("stores managed data repo mappings", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-data-repos-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const initial = await readDataRepos(state);
      expect(initial[0].id).toBe("agent-os-data");
      expect(initial[0].repo).toBe("marius-patrik/agents-data");
      expect(dataRepoManagedRoot(initial[0])).toBe(path.join(root, "data", "agent-os"));

      const repo = await upsertDataRepo(state, {
        id: "project-data",
        repo: "marius-patrik/project-data",
        path: "data/project",
        branch: "main",
        managedPath: "managed-repository",
        env: "PROJECT_DATA_ROOT",
      });

      expect(repo.path).toBe(path.join(root, "data", "project"));
      expect(dataRepoManagedRoot(repo)).toBe(path.join(root, "data", "project", "managed-repository"));

      const repos = await readDataRepos(state);
      expect(repos).toHaveLength(2);
      expect(repos[1].id).toBe("project-data");
      expect(repos[1].repo).toBe("marius-patrik/project-data");

      await expect(
        upsertDataRepo(state, {
          id: "system-data-alias",
          repo: "marius-patrik/agents-data",
          path: "data/system-data-alias",
          branch: "main",
        }),
      ).rejects.toThrow("aliases the canonical agent-os-data authority");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
