import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readPackagesAndEnvironmentsState } from "../src/environments";
import { ensureSharedState, sharedState } from "../src/state";

const repoRoot = path.resolve(import.meta.dir, "..");
const cliPath = path.join(repoRoot, "src", "cli.ts");

async function runAgents(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, cliPath, ...args], {
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

describe("packages and environments groundwork", () => {
  test("shared state seeds environments file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-env-state-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);

      const environments = await readPackagesAndEnvironmentsState(state);
      expect(environments.schemaVersion).toBe(1);
      expect(environments.distroPackages).toEqual([]);
      expect(environments.containerPackages).toEqual([]);
      expect(environments.environments).toEqual([]);
      expect(await Bun.file(state.envFile).text()).toContain(`AGENTS_ENVIRONMENTS=${state.environmentsFile}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("env list exposes empty groundwork state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-env-list-"));
    try {
      const result = await runAgents(root, ["env", "list", "--json"]);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("real package and environment mutations are explicit stubs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-env-stubs-"));
    try {
      const distro = await runAgents(root, ["packages", "distro", "install", "curl"]);
      expect(distro.code).toBe(1);
      expect(distro.stderr).toContain("not yet implemented");
      expect(distro.stderr).toContain("agents-mono#8");
      expect(distro.stderr).toContain("agents-mono#9");

      const create = await runAgents(root, ["env", "create", "host"]);
      expect(create.code).toBe(1);
      expect(create.stderr).toContain("not yet implemented");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
