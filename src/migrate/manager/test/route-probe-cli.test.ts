import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { adapters, adapterHome } from "../src/adapters";
import { inspectProviderExecutable, writeProviderRegistration, type ProviderId } from "../src/provider-registry";
import { ensureSharedState, sharedStateAt, writeSessionConfig, type SharedState } from "../src/state";

const repoRoot = path.resolve(import.meta.dir, "..");
const cliPath = path.join(repoRoot, "src", "cli.ts");

function cleanEnv(): Record<string, string | undefined> {
  const copy = { ...process.env };
  for (const key of Object.keys(copy)) {
    if (key.startsWith("AGENTS_")) delete copy[key];
  }
  return copy;
}

async function runAgents(
  root: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, cliPath, ...args], {
    cwd: root,
    env: {
      ...cleanEnv(),
      AGENTS_HOME: path.join(root, ".agents"),
      AGENTS_USER_HOME: path.join(root, "user"),
      AGENTS_ROOT: root,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

async function withFixture(fn: (state: SharedState, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agents-route-cli-test-"));
  try {
    const state = sharedStateAt(root, path.join(root, ".agents"), path.join(root, "user"));
    await ensureSharedState(state);
    await fn(state, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function pinReadyProvider(state: SharedState, root: string, provider: ProviderId): Promise<string> {
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  const sentinel = path.join(root, `${provider}-invoked`);
  const executable = path.join(bin, `${provider}${process.platform === "win32" ? ".cmd" : ""}`);
  const content = process.platform === "win32"
    ? `@echo off\r\n>"${sentinel}" echo invoked\r\nexit /b 0\r\n`
    : `#!/bin/sh\nprintf invoked > '${sentinel.replaceAll("'", "'\\''")}'\n`;
  await Bun.write(executable, content);
  if (process.platform !== "win32") await chmod(executable, 0o700);
  await writeProviderRegistration(
    state,
    await inspectProviderExecutable(provider, executable, `${provider} 1.0.0`),
  );
  for (const credentialPath of adapters[provider].credentialPaths) {
    await Bun.write(path.join(adapterHome(state, provider), credentialPath), "{}\n");
  }
  return sentinel;
}

async function snapshotTree(root: string, prefix = ""): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(snapshot, await snapshotTree(root, relative));
    else if (entry.isFile()) {
      snapshot[relative] = Buffer.from(await Bun.file(path.join(root, relative)).arrayBuffer()).toString("base64");
    }
  }
  return snapshot;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

describe("route probe CLI regression triplet", () => {
  test("primary: the exact DarkFactory command resolves medium/medium without provider calls or state writes", async () => {
    await withFixture(async (state, root) => {
      await writeSessionConfig(state, {
        schemaVersion: 1,
        providerModels: { kimi: ["kimi-standard"] },
      });
      const sentinel = await pinReadyProvider(state, root, "kimi");
      const before = await snapshotTree(state.stateDir);

      const result = await runAgents(root, ["route", "probe", "--json"]);

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        schemaVersion: 2,
        ok: true,
        requested: { tier: "medium", effort: "medium" },
        route: { tier: "medium", provider: "kimi", model: "kimi-standard", agentPreset: "Kimi" },
        readiness: "ready",
        probe: { state: "not_requested" },
        findings: [],
        routing: {
          policyVersion: "agent-os-tier-routes-v1",
          capabilityFloor: "medium",
          selectedCandidateIndex: 0,
          skipped: [],
        },
      });
      expect(result.stdout).not.toContain(root);
      expect(await Bun.file(sentinel).exists()).toBe(false);
      expect(await snapshotTree(state.stateDir)).toEqual(before);

      const help = await runAgents(root, ["help"]);
      expect(help.stdout).toContain("agents route probe [--model-tier low|medium|high|max]");
    });
  });

  test("fallback: decommissioned Kimi selects Codex without touching the Kimi provider home", async () => {
    await withFixture(async (state, root) => {
      await writeSessionConfig(state, {
        schemaVersion: 1,
        routePolicyVersion: "agent-os-tier-routes-v1",
        providerRouteStatus: { kimi: "decommissioned", codex: "enabled" },
        providerModels: { kimi: ["kimi-standard"], codex: ["gpt-5.6-sol"] },
      });
      const sentinel = await pinReadyProvider(state, root, "codex");
      const kimiHome = adapterHome(state, "kimi");
      expect(await pathExists(kimiHome)).toBe(false);

      const result = await runAgents(root, ["route", "probe", "--json"]);

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      const report = JSON.parse(result.stdout);
      expect(report).toMatchObject({
        schemaVersion: 2,
        ok: true,
        requested: { tier: "medium", effort: "medium" },
        route: { tier: "medium", provider: "codex", model: "gpt-5.6-sol", agentPreset: "Sol" },
        readiness: "ready",
        routing: {
          policyVersion: "agent-os-tier-routes-v1",
          capabilityFloor: "medium",
          selectedCandidateIndex: 1,
          skipped: [
            {
              candidateIndex: 0,
              provider: "kimi",
              agentPreset: "Kimi",
              capabilityTier: "medium",
              reason: "provider_decommissioned",
            },
          ],
        },
      });
      expect(await pathExists(kimiHome)).toBe(false);
      expect(await Bun.file(sentinel).exists()).toBe(false);
    });
  });

  test("blocked: every unavailable medium candidate is recorded and no provider home is touched", async () => {
    await withFixture(async (state, root) => {
      await writeSessionConfig(state, {
        schemaVersion: 1,
        routePolicyVersion: "agent-os-tier-routes-v1",
        providerRouteStatus: { kimi: "decommissioned", codex: "unavailable" },
        providerModels: { kimi: ["kimi-standard"], codex: ["gpt-5.6-sol"] },
      });
      const kimiHome = adapterHome(state, "kimi");
      const codexHome = adapterHome(state, "codex");
      expect(await pathExists(kimiHome)).toBe(false);
      expect(await pathExists(codexHome)).toBe(false);

      const result = await runAgents(root, ["route", "probe", "--json"]);

      expect(result.code).toBe(1);
      expect(result.stderr).toBe("");
      const report = JSON.parse(result.stdout);
      expect(report.ok).toBe(false);
      expect(report.route).toBeNull();
      expect(report.findings).toEqual([
        { code: "route_unavailable", message: "no policy-authorized route candidate is ready" },
      ]);
      expect(report.routing).toEqual({
        policyVersion: "agent-os-tier-routes-v1",
        capabilityFloor: "medium",
        selectedCandidateIndex: null,
        skipped: [
          {
            candidateIndex: 0,
            provider: "kimi",
            agentPreset: "Kimi",
            capabilityTier: "medium",
            reason: "provider_decommissioned",
          },
          {
            candidateIndex: 1,
            provider: "codex",
            agentPreset: "Sol",
            capabilityTier: "high",
            reason: "provider_unavailable",
          },
          {
            candidateIndex: 2,
            provider: "claude",
            agentPreset: "Fable",
            capabilityTier: "max",
            reason: "model_missing",
          },
        ],
      });
      expect(await pathExists(kimiHome)).toBe(false);
      expect(await pathExists(codexHome)).toBe(false);
    });
  });

  test("edge: explicit tier and effort stay independent and still perform only route resolution", async () => {
    await withFixture(async (state, root) => {
      await writeSessionConfig(state, {
        schemaVersion: 1,
        providerModels: { codex: ["gpt-5.6-sol"] },
      });
      const sentinel = await pinReadyProvider(state, root, "codex");

      const result = await runAgents(root, [
        "route",
        "probe",
        "--model-tier",
        "high",
        "--effort",
        "low",
      ]);

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("requested tier=high effort=low");
      expect(result.stdout).toContain("route provider=codex model=gpt-5.6-sol preset=Sol");
      expect(await Bun.file(sentinel).exists()).toBe(false);
    });
  });

  test("denied: CLI reachability cannot invent a raw or unbounded provider executor", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-route-cli-denied-"));
    try {
      const result = await runAgents(root, ["route", "probe", "--reachability", "--json"]);

      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr.trim()).toBe(
        "agents: route probe accepts only --model-tier, --effort, and --json",
      );
      expect(await Bun.file(path.join(root, ".agents")).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
