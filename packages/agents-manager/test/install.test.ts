import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readInstalls, sharedState } from "../src/state";
import { readPackageRegistrations } from "../src/packages";

const repoRoot = path.resolve(import.meta.dir, "..");
const cliPath = path.join(repoRoot, "src", "cli.ts");

function cleanEnv(): Record<string, string | undefined> {
  const copy = { ...process.env };
  for (const key of Object.keys(copy)) {
    if (key.startsWith("AGENTS_")) delete copy[key];
  }
  return copy;
}

async function runAgents(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, cliPath, ...args], {
    cwd,
    env: { ...cleanEnv(), AGENTS_HOME: path.join(cwd, ".agents"), AGENTS_ROOT: cwd },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

describe("install CLI", () => {
  test("installs local capability directories and rejects duplicate targets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-install-"));
    try {
      const source = path.join(root, "source-skill");
      await mkdir(source, { recursive: true });
      await Bun.write(path.join(source, "SKILL.md"), "# Probe skill\n");

      const install = await runAgents(root, ["install", "skill", "probe", source]);
      expect(install.code).toBe(0);
      expect(await Bun.file(path.join(root, ".agents", "skills", "probe", "SKILL.md")).text()).toBe("# Probe skill\n");

      const duplicate = await runAgents(root, ["install", "skill", "probe", source]);
      expect(duplicate.code).toBe(1);
      expect(duplicate.stderr).toContain("install target already exists");

      const installs = await readInstalls(sharedState(root));
      expect(installs).toHaveLength(1);
      expect(installs[0].kind).toBe("skill");
      expect(installs[0].name).toBe("probe");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("registers package manifests as install side effects", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-install-manifest-"));
    try {
      const source = path.join(root, "source-harness");
      await mkdir(source, { recursive: true });
      await Bun.write(
        path.join(source, "agent.package.json"),
        JSON.stringify({
          schemaVersion: 1,
          id: "probe-harness",
          kind: "harness",
          entry: `${process.execPath} probe.ts`,
          requires: { clis: [], state: ["credits"] },
        }),
      );

      const install = await runAgents(root, ["install", "harness", "probe-harness", source]);
      expect(install.code).toBe(0);

      const registrations = await readPackageRegistrations(sharedState(root));
      expect(registrations).toHaveLength(1);
      expect(registrations[0].id).toBe("probe-harness");
      expect(registrations[0].kind).toBe("harness");
      expect(registrations[0].path).toBe(path.join(root, ".agents", "harnesses", "probe-harness"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
