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
      expect(initial[0].id).toBe("agentos-data");
      expect(initial[0].repo).toBe("marius-patrik/agentos-data");
      expect(dataRepoManagedRoot(initial[0])).toBe(path.join(root, "data", "data-agentos"));

      const repo = await upsertDataRepo(state, {
        id: "darkfactory-workspace",
        repo: "marius-patrik/agentos-data",
        path: "data/data-agentos",
        branch: "main",
        managedPath: "managed-repository",
        env: "DARK_FACTORY_WORKSPACE_ROOT",
      });

      expect(repo.path).toBe(path.join(root, "data", "data-agentos"));
      expect(dataRepoManagedRoot(repo)).toBe(path.join(root, "data", "data-agentos", "managed-repository"));

      const repos = await readDataRepos(state);
      expect(repos).toHaveLength(2);
      expect(repos[1].id).toBe("darkfactory-workspace");
      expect(repos[1].repo).toBe("marius-patrik/agentos-data");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});


