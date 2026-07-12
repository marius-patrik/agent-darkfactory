import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
      expect(initial[0].repo).toBe("marius-patrik/Andromeda-data");
      expect(dataRepoManagedRoot(initial[0])).toBe(state.stateDir);

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
          repo: "marius-patrik/Andromeda-data",
          path: "data/system-data-alias",
          branch: "main",
        }),
      ).rejects.toThrow("aliases the canonical agent-os-data authority");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("converges the exact retired data checkout record during state initialization", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-data-repos-converge-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      await writeFile(
        state.dataReposFile,
        `${JSON.stringify([
          {
            id: "agent-os-data",
            repo: "marius-patrik/agents-data",
            path: path.join(root, "data", "agent-os"),
            branch: "main",
            env: "AGENTS_SYSTEM_DATA_ROOT",
            configuredAt: "2026-07-01T00:00:00.000Z",
          },
        ], null, 2)}\n`,
      );

      await ensureSharedState(state);
      const beforeCheckout = JSON.parse(await Bun.file(state.dataReposFile).text());
      expect(beforeCheckout[0].repo).toBe("marius-patrik/agents-data");
      expect(beforeCheckout[0].path).toBe(path.join(root, "data", "agent-os"));

      await mkdir(path.join(state.stateDir, ".git"), { recursive: true });
      await ensureSharedState(state);
      const [registration] = await readDataRepos(state);
      expect(registration.repo).toBe("marius-patrik/Andromeda-data");
      expect(registration.path).toBe(state.stateDir);
      expect(registration.configuredAt).toBe("2026-07-01T00:00:00.000Z");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
