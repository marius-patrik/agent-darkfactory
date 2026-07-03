import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readPackageManifest, upsertPackageRegistration, readPackageRegistrations } from "../src/packages";
import { ensureSharedState, sharedState } from "../src/state";

describe("package manifests", () => {
  test("reads harness requirements", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agents-package-"));
    try {
      await Bun.write(
        path.join(dir, "agent.package.json"),
        JSON.stringify({
          schemaVersion: 1,
          id: "andromeda-harness",
          kind: "harness",
          requires: { clis: ["codex", "claude", "kimi", "agy"], state: ["skills", "plugins", "hooks", "credits"] },
          dataRepo: {
            id: "darkfactory-workspace",
            repo: "marius-patrik/agentos-data",
            path: "packages/agentos-data",
            managedPath: "managed-repository",
            env: "DARK_FACTORY_WORKSPACE_ROOT",
          },
          entry: "go run ./cmd/rommie",
          workingDirectory: "services/cli",
        }),
      );

      const manifest = await readPackageManifest(dir);
      expect(manifest?.id).toBe("andromeda-harness");
      expect(manifest?.kind).toBe("harness");
      expect(manifest?.workingDirectory).toBe("services/cli");
      expect(manifest?.requires?.clis).toContain("codex");
      expect(manifest?.dataRepo?.repo).toBe("marius-patrik/agentos-data");
      expect(manifest?.dataRepo?.managedPath).toBe("managed-repository");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("upserts package registrations", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agents-state-"));
    try {
      const state = sharedState(dir);
      await ensureSharedState(state);
      await upsertPackageRegistration(state, { id: "andromeda-harness", kind: "harness", path: path.join(dir, "andromeda-harness") });
      await upsertPackageRegistration(state, { id: "andromeda-harness", kind: "harness", path: path.join(dir, "andromeda-harness-2") });

      const registrations = await readPackageRegistrations(state);
      expect(registrations).toHaveLength(1);
      expect(registrations[0].path).toBe(path.join(dir, "andromeda-harness-2"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
