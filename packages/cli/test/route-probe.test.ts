import { describe, expect, jest, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rm, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { adapters, adapterHome, doctorAdapter } from "../src/adapters";
import {
  inspectProviderExecutable,
  writeProviderRegistration,
  type ProviderId,
} from "../src/provider-registry";
import { ensureSharedState, sharedStateAt, writeSessionConfig, type SharedState } from "../src/state";
import {
  PROBE_MAX_OUTPUT_BYTES,
  PROBE_TERMINATION_TIMEOUT_MS,
  PROBE_TIMEOUT_MS,
  ROUTE_PROBE_PROMPT,
  TIER_ROUTES,
  admittedRouteProviderVersion,
  formatRouteProbeReport,
  resolveRouteModel,
  runOrderedRouteProbe,
  runRouteProbe as runRouteProbeWithEvidence,
  type ModelTier,
  type ProbeExecutionHandle,
  type ProbeExecutor,
  type ProbeOutcome,
  type ProbeRequest,
  type RouteFindingCode,
  type RouteProbeOptions,
} from "../src/route-probe";

async function runRouteProbe(
  state: SharedState,
  options: RouteProbeOptions,
  stateLifecycle?: Parameters<typeof runRouteProbeWithEvidence>[2],
) {
  let providerDoctorEvidence = options.providerDoctorEvidence;
  if (providerDoctorEvidence === undefined && (Object.keys(TIER_ROUTES) as string[]).includes(options.tier)) {
    const provider = TIER_ROUTES[options.tier as ModelTier].provider;
    providerDoctorEvidence = await doctorAdapter(state, provider).then(
      (result) => result.evidence,
      () => null,
    );
  }
  return runRouteProbeWithEvidence(
    state,
    { ...options, providerDoctorEvidence },
    stateLifecycle,
  );
}

async function withFixture(fn: (state: SharedState, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agents-route-probe-test-"));
  try {
    const state = sharedStateAt(root, path.join(root, ".andromeda"), path.join(root, "user"));
    await ensureSharedState(state);
    await fn(state, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeFullConfig(state: SharedState): Promise<void> {
  await writeSessionConfig(state, {
    schemaVersion: 1,
    providerModels: {
      agy: ["agy-fast"],
      kimi: ["kimi-standard"],
      codex: ["codex-reasoning"],
      claude: ["claude-max"],
    },
  });
}

async function pinProvider(state: SharedState, root: string, id: ProviderId): Promise<string> {
  const executable = path.join(root, "bin", id);
  await Bun.write(executable, "#!/bin/sh\nexit 0\n");
  await writeProviderRegistration(state, await inspectProviderExecutable(id, executable, `${id} 1.0.0`));
  return executable;
}

async function writeCredential(state: SharedState, id: ProviderId): Promise<void> {
  for (const credentialPath of adapters[id].credentialPaths) {
    await Bun.write(path.join(adapterHome(state, id), credentialPath), "{}\n");
  }
}

async function makeReadyRoute(state: SharedState, root: string): Promise<void> {
  await writeFullConfig(state);
  for (const tier of Object.keys(TIER_ROUTES) as ModelTier[]) {
    const provider = TIER_ROUTES[tier].provider;
    await pinProvider(state, root, provider);
    await writeCredential(state, provider);
  }
}

function recordingExecutor(handler: (request: ProbeRequest) => ProbeOutcome | Promise<ProbeOutcome>): {
  calls: ProbeRequest[];
  executor: ProbeExecutor;
} {
  const calls: ProbeRequest[] = [];
  return {
    calls,
    executor: {
      run: (request) => {
        calls.push({ ...request });
        const result = Promise.resolve().then(() => handler(request));
        return {
          result,
          terminate: async () => {
            await result.catch(() => undefined);
          },
        };
      },
    },
  };
}

function successfulOutcome(outputBytes = 0, outputOverflow = false): ProbeOutcome {
  return { ok: true, outputBytes, outputOverflow };
}

describe("route resolution matrix", () => {
  test("all four tiers resolve from canonical fixture config", async () => {
    await withFixture(async (state, root) => {
      await makeReadyRoute(state, root);
      for (const tier of Object.keys(TIER_ROUTES) as ModelTier[]) {
        const report = await runRouteProbe(state, { tier, effort: "medium" });
        expect(report.ok).toBe(true);
        expect(report.findings).toEqual([]);
        expect(report.readiness).toBe("ready");
        expect(report.probe.state).toBe("not_requested");
        expect(report.route).toEqual({
          tier,
          provider: TIER_ROUTES[tier].provider,
          model: { low: "agy-fast", medium: "kimi-standard", high: "codex-reasoning", max: "claude-max" }[tier],
          agentPreset: TIER_ROUTES[tier].agentPreset,
        });
        expect(report.requested).toEqual({ tier, effort: "medium" });
      }
    });
  });

  test("effort varies independently and never changes the resolved route", async () => {
    await withFixture(async (state, root) => {
      await makeReadyRoute(state, root);
      const routes = new Set<string>();
      for (const effort of ["low", "medium", "high", "max", "deep-think.v2"]) {
        const report = await runRouteProbe(state, { tier: "medium", effort });
        expect(report.ok).toBe(true);
        expect(report.requested.effort).toBe(effort);
        expect(report.route?.provider).toBe("kimi");
        expect(report.route?.model).toBe("kimi-standard");
        routes.add(JSON.stringify(report.route));
      }
      expect(routes.size).toBe(1);
      // An effort equal to another tier's name still must not cross tiers.
      const crossed = await runRouteProbe(state, { tier: "medium", effort: "max" });
      expect(crossed.route?.provider).toBe("kimi");
    });
  });

  test("multiple models resolve through the canonical default only", async () => {
    await withFixture(async (state, root) => {
      await writeSessionConfig(state, {
        schemaVersion: 1,
        defaultProvider: "kimi",
        defaultModel: "kimi-standard",
        providerModels: { kimi: ["kimi-standard", "kimi-fast"] },
      });
      await pinProvider(state, root, "kimi");
      await writeCredential(state, "kimi");
      const report = await runRouteProbe(state, { tier: "medium", effort: "low" });
      expect(report.ok).toBe(true);
      expect(report.route?.model).toBe("kimi-standard");
    });
  });

  test("namespaced configured models are accepted and preserved exactly", async () => {
    await withFixture(async (state, root) => {
      const model = "kimi-code/kimi-for-coding";
      await writeSessionConfig(state, { schemaVersion: 1, providerModels: { kimi: [model] } });
      await pinProvider(state, root, "kimi");
      await writeCredential(state, "kimi");

      const report = await runRouteProbe(state, { tier: "medium", effort: "medium" });

      expect(report.ok).toBe(true);
      expect(report.route?.model).toBe(model);
      expect(JSON.stringify(report)).toContain(model);
      expect(formatRouteProbeReport(report)).toContain(`model=${model}`);
    });
  });

  test("provider-version admission accepts exact SemVer including build metadata", () => {
    expect(admittedRouteProviderVersion("1.2.3")).toBe("1.2.3");
    expect(admittedRouteProviderVersion("1.2.3+build")).toBe("1.2.3+build");
    expect(admittedRouteProviderVersion("1.2.3-alpha.1+build.7")).toBe("1.2.3-alpha.1+build.7");
  });

  test("provider-version admission extracts exact SemVer from provider-owned text", () => {
    expect(admittedRouteProviderVersion("codex-cli 0.144.1+windows.1")).toBe("0.144.1+windows.1");
    expect(admittedRouteProviderVersion("2.1.203 (Claude Code)")).toBe("2.1.203");
  });

  test("provider-version admission rejects safe-looking non-SemVer and malformed near-misses", () => {
    for (const value of ["unknown", "not-a-version", "1.2", "1.2.3.4", "01.2.3", "1.2.3-01"]) {
      expect(admittedRouteProviderVersion(value)).toBeNull();
    }
  });

  test("ordered readiness skips unresolved provider versions exactly as execution does", async () => {
    await withFixture(async (state) => {
      await writeSessionConfig(state, {
        schemaVersion: 1,
        routePolicyVersion: "agent-os-tier-routes-v1",
        providerModels: { kimi: ["kimi-standard"], codex: ["codex-reasoning"] },
      });
      const doctorCalls: ProviderId[] = [];
      const report = await runOrderedRouteProbe(
        state,
        { tier: "medium", effort: "medium", probe: "none" },
        async (_state, provider) => {
          doctorCalls.push(provider);
          return {
            schemaVersion: 1,
            provider,
            pinned: true,
            executableVerified: true,
            credentialsPresent: true,
            providerVersion: provider === "kimi" ? "not a version" : "codex 1.2.3",
          };
        },
      );

      expect(doctorCalls).toEqual(["kimi", "codex"]);
      expect(report.ok).toBe(true);
      expect(report.route?.provider).toBe("codex");
      expect(report.routing.selectedCandidateIndex).toBe(1);
      expect(report.routing.skipped).toEqual([
        {
          candidateIndex: 0,
          provider: "kimi",
          agentPreset: "Kimi",
          capabilityTier: "medium",
          reason: "provider_version_unavailable",
        },
      ]);
    });
  });

  test("ordered readiness preserves doctor finding precedence before provider-version admission", async () => {
    await withFixture(async (state) => {
      await writeSessionConfig(state, {
        schemaVersion: 1,
        routePolicyVersion: "agent-os-tier-routes-v1",
        providerModels: { kimi: ["kimi-standard"], codex: ["codex-reasoning"], claude: ["claude-reasoning"] },
      });
      const report = await runOrderedRouteProbe(
        state,
        { tier: "medium", effort: "medium", probe: "none" },
        async (_state, provider) => ({
          schemaVersion: 1,
          provider,
          pinned: false,
          executableVerified: false,
          credentialsPresent: false,
          providerVersion: null,
        }),
      );

      expect(report.ok).toBe(false);
      expect(report.routing.skipped.map(({ provider, reason }) => ({ provider, reason }))).toEqual([
        { provider: "kimi", reason: "provider_unpinned" },
        { provider: "codex", reason: "provider_unpinned" },
        { provider: "claude", reason: "provider_unpinned" },
      ]);
    });
  });

  test("ordered readiness records every candidate when canonical config is unavailable", async () => {
    await withFixture(async (state) => {
      await Bun.write(state.configFile, "{ malformed");
      const doctorCalls: ProviderId[] = [];
      const report = await runOrderedRouteProbe(
        state,
        { tier: "medium", effort: "medium", probe: "none" },
        async (_state, provider) => {
          doctorCalls.push(provider);
          throw new Error("doctor must not run");
        },
      );

      expect(doctorCalls).toEqual([]);
      expect(report.ok).toBe(false);
      expect(report.route).toBeNull();
      expect(report.findings.map((finding) => finding.code)).toEqual(["config_unavailable"]);
      expect(report.routing.skipped.map(({ provider, reason }) => ({ provider, reason }))).toEqual([
        { provider: "kimi", reason: "config_unavailable" },
        { provider: "codex", reason: "config_unavailable" },
        { provider: "claude", reason: "config_unavailable" },
      ]);
    });
  });
});

describe("resolution failures fail closed", () => {
  test("an explicitly empty candidate set is missing rather than ambiguous", () => {
    expect(resolveRouteModel({ schemaVersion: 1, providerModels: { kimi: [] } }, "kimi")).toEqual({
      code: "model_missing",
    });
  });

  test("route resolution consumes path-free doctor evidence and never inspects provider homes", async () => {
    await withFixture(async (state) => {
      await writeFullConfig(state);
      const evidence = {
        schemaVersion: 1 as const,
        provider: "kimi" as const,
        pinned: true,
        executableVerified: true,
        credentialsPresent: true,
      };

      const report = await runRouteProbeWithEvidence(state, {
        tier: "medium",
        effort: "medium",
        providerDoctorEvidence: evidence,
      });
      expect(report.ok).toBe(true);
      expect(report.findings).toEqual([]);

      const missing = await runRouteProbeWithEvidence(state, { tier: "medium", effort: "medium" });
      expect(missing.ok).toBe(false);
      expect(missing.findings.map((finding) => finding.code)).toEqual(["registry_unavailable"]);

      const mismatched = await runRouteProbeWithEvidence(state, {
        tier: "medium",
        effort: "medium",
        providerDoctorEvidence: { ...evidence, provider: "codex" },
      });
      expect(mismatched.ok).toBe(false);
      expect(mismatched.findings.map((finding) => finding.code)).toEqual(["registry_unavailable"]);
    });
  });

  test("unknown tier and malformed effort fail closed with fixed messages and null sentinels", async () => {
    await withFixture(async (state, root) => {
      await makeReadyRoute(state, root);
      const unknownTier = await runRouteProbe(state, { tier: "ultra", effort: "medium" });
      expect(unknownTier.ok).toBe(false);
      expect(unknownTier.route).toBeNull();
      expect(unknownTier.readiness).toBe("unready");
      expect(unknownTier.requested).toEqual({ tier: null, effort: "medium" });
      expect(unknownTier.findings).toEqual([{ code: "unknown_tier", message: "unknown model tier" }]);
      for (const effort of ["", "   ", "high effort", "high/deep", "x".repeat(65)]) {
        const report = await runRouteProbe(state, { tier: "medium", effort });
        expect(report.ok).toBe(false);
        expect(report.route).toBeNull();
        expect(report.requested).toEqual({ tier: "medium", effort: null });
        expect(report.findings).toEqual([{ code: "malformed_effort", message: "requested effort is malformed" }]);
      }
    });
  });

  test("absent or ambiguous models fail closed", async () => {
    await withFixture(async (state) => {
      await writeSessionConfig(state, {
        schemaVersion: 1,
        providerModels: { kimi: ["kimi-standard"] },
      });
      const report = await runRouteProbe(state, { tier: "low", effort: "medium" });
      expect(report.route).toBeNull();
      expect(report.findings.map((finding) => finding.code)).toContain("model_missing");
    });
    await withFixture(async (state, root) => {
      await writeSessionConfig(state, {
        schemaVersion: 1,
        providerModels: { kimi: ["kimi-standard", "kimi-fast"] },
      });
      await pinProvider(state, root, "kimi");
      await writeCredential(state, "kimi");
      const report = await runRouteProbe(state, { tier: "medium", effort: "medium" });
      expect(report.route).toBeNull();
      expect(report.findings.map((finding) => finding.code)).toEqual(["model_ambiguous"]);
    });
  });

  test("model length boundaries and unsafe segments fail closed without echo", async () => {
    // One character and an exact 64-character token are the inclusive safe
    // bounds; every unsafe class fails closed through model_unsafe.
    const exact = `m${"o".repeat(63)}`;
    expect(exact.length).toBe(64);
    for (const model of ["m", exact]) {
      await withFixture(async (state, root) => {
        await writeSessionConfig(state, { schemaVersion: 1, providerModels: { kimi: [model] } });
        await pinProvider(state, root, "kimi");
        await writeCredential(state, "kimi");
        const report = await runRouteProbe(state, { tier: "medium", effort: "medium" });
        expect(report.ok).toBe(true);
        expect(report.route?.model).toBe(model);
        expect(formatRouteProbeReport(report)).toContain(`model=${model}`);
      });
    }
    const overlong = `m${"o".repeat(64)}`;
    expect(overlong.length).toBe(65);
    const unsafe: Array<{ name: string; model: string; marker: string }> = [
      { name: "early secret", model: "token=abc123", marker: "token=abc123" },
      { name: "leading slash", model: "/namespace/model", marker: "/namespace" },
      { name: "trailing slash", model: "namespace/model/", marker: "model/" },
      { name: "repeated slash", model: "namespace//model", marker: "namespace//model" },
      { name: "traversal segment", model: "namespace/../model", marker: "../" },
      { name: "backslash", model: "namespace\\model", marker: "namespace\\model" },
      { name: "control", model: "evil\x1bmodel", marker: "evil" },
      { name: "non-ASCII", model: "namespace/modèle", marker: "modèle" },
      { name: "overlong", model: overlong, marker: "oooo" },
    ];
    for (const entry of unsafe) {
      await withFixture(async (state, root) => {
        await writeSessionConfig(state, { schemaVersion: 1, providerModels: { kimi: [entry.model] } });
        await pinProvider(state, root, "kimi");
        await writeCredential(state, "kimi");
        const report = await runRouteProbe(state, { tier: "medium", effort: "medium" });
        expect(report.ok, entry.name).toBe(false);
        expect(report.route, entry.name).toBeNull();
        expect(report.findings.map((finding) => finding.code), entry.name).toEqual(["model_unsafe"]);
        const json = JSON.stringify(report);
        const human = formatRouteProbeReport(report);
        for (const output of [json, human]) {
          expect(output, entry.name).not.toContain(entry.marker);
        }
      });
    }
  });

  test("unpinned, unverified, and missing-credential providers fail closed", async () => {
    const cases: Array<{
      code: RouteFindingCode;
      setup: (state: SharedState, root: string) => Promise<string | void>;
    }> = [
      {
        code: "provider_unpinned",
        setup: async (state) => {
          await writeFullConfig(state);
          await writeCredential(state, "kimi");
        },
      },
      {
        code: "provider_unverified",
        setup: async (state, root) => {
          await writeFullConfig(state);
          const executable = await pinProvider(state, root, "kimi");
          await writeCredential(state, "kimi");
          // Checksum drift: the pinned content no longer matches the registry.
          await Bun.write(executable, "#!/bin/sh\nexit 1\n");
          return executable;
        },
      },
      {
        code: "credential_missing",
        setup: async (state, root) => {
          await writeFullConfig(state);
          await pinProvider(state, root, "kimi");
        },
      },
      {
        code: "credential_missing",
        setup: async (state, root) => {
          await writeFullConfig(state);
          await pinProvider(state, root, "kimi");
          const credential = path.join(adapterHome(state, "kimi"), adapters.kimi.credentialPaths[0]!);
          await mkdir(credential, { recursive: true });
        },
      },
      {
        code: "credential_missing",
        setup: async (state, root) => {
          await writeFullConfig(state);
          await pinProvider(state, root, "kimi");
          const target = path.join(root, "outside-credentials");
          await mkdir(target, { recursive: true });
          await Bun.write(path.join(target, "kimi-code.json"), "{}\n");
          const credentialsDir = path.join(adapterHome(state, "kimi"), "credentials");
          await mkdir(path.dirname(credentialsDir), { recursive: true });
          await symlink(target, credentialsDir, "junction");
        },
      },
    ];
    for (const entry of cases) {
      await withFixture(async (state, root) => {
        const marker = await entry.setup(state, root);
        const report = await runRouteProbe(state, { tier: "medium", effort: "medium" });
        expect(report.ok).toBe(false);
        expect(report.readiness).toBe("unready");
        expect(report.findings.map((finding) => finding.code)).toEqual([entry.code]);
        if (typeof marker === "string") expect(JSON.stringify(report)).not.toContain(marker);
      });
    }
  });

  test("credential readiness rejects a symlinked authority ancestor above clis", async () => {
    await withFixture(async (_state, root) => {
      const physicalAuthority = path.join(root, "physical-authority");
      const linkedAuthority = path.join(root, "linked-authority");
      await mkdir(physicalAuthority, { recursive: true });
      await symlink(physicalAuthority, linkedAuthority, "junction");
      const linkedState = sharedStateAt(
        root,
        path.join(linkedAuthority, ".andromeda"),
        path.join(root, "linked-user"),
      );
      await ensureSharedState(linkedState);
      await writeFullConfig(linkedState);
      await pinProvider(linkedState, root, "kimi");
      await writeCredential(linkedState, "kimi");

      const report = await runRouteProbe(linkedState, { tier: "medium", effort: "medium" });
      expect(report.ok).toBe(false);
      expect(report.readiness).toBe("unready");
      expect(report.findings.map((finding) => finding.code)).toEqual(["credential_missing"]);
      expect(JSON.stringify(report)).not.toContain(linkedAuthority);
      expect(formatRouteProbeReport(report)).not.toContain(physicalAuthority);
    });
  });

  test("credential readiness accepts an OS-level alias above the declared authority boundary", async () => {
    await withFixture(async (_state, root) => {
      const physicalParent = path.join(root, "physical-platform-root");
      const aliasParent = path.join(root, "platform-alias");
      const physicalAuthority = path.join(physicalParent, "authority");
      await mkdir(physicalAuthority, { recursive: true });
      await symlink(physicalParent, aliasParent, "junction");
      const aliasAuthority = path.join(aliasParent, "authority");
      const aliasedState = sharedStateAt(
        aliasAuthority,
        path.join(aliasAuthority, ".andromeda"),
        path.join(aliasAuthority, "user"),
      );
      await ensureSharedState(aliasedState);
      await writeFullConfig(aliasedState);
      await pinProvider(aliasedState, root, "kimi");
      await writeCredential(aliasedState, "kimi");

      const report = await runRouteProbe(aliasedState, { tier: "medium", effort: "medium" });
      expect(report.ok).toBe(true);
      expect(report.findings).toEqual([]);
    });
  });

  test("boundary exceptions fail closed into a sanitized report instead of rejecting", async () => {
    // Provider verification throws: a pinned executable that is a directory
    // makes realpath succeed but the checksum read fail.
    await withFixture(async (state, root) => {
      await writeFullConfig(state);
      await writeCredential(state, "kimi");
      const directory = path.join(root, "bin", "kimi");
      await mkdir(directory, { recursive: true });
      await writeProviderRegistration(state, {
        id: "kimi",
        executable: directory,
        resolvedExecutable: await realpath(directory),
        sha256: "0".repeat(64),
        version: "kimi 1.0.0",
        pinnedAt: new Date().toISOString(),
      });
      const report = await runRouteProbe(state, { tier: "medium", effort: "medium" });
      expect(report.ok).toBe(false);
      expect(report.findings.map((finding) => finding.code)).toEqual(["provider_unverified"]);
      expect(JSON.stringify(report)).not.toContain(directory);
    });
    // Corrupt canonical config, then (same fixture, repaired) corrupt registry.
    await withFixture(async (state) => {
      await Bun.write(state.configFile, "{ not json");
      const corruptConfig = await runRouteProbe(state, { tier: "medium", effort: "medium" });
      expect(corruptConfig.ok).toBe(false);
      expect(corruptConfig.route).toBeNull();
      expect(corruptConfig.findings.map((finding) => finding.code)).toContain("config_unavailable");

      await writeFullConfig(state);
      await writeCredential(state, "kimi");
      await Bun.write(path.join(state.stateDir, "providers.json"), "{ not json");
      const corruptRegistry = await runRouteProbe(state, { tier: "medium", effort: "medium" });
      expect(corruptRegistry.ok).toBe(false);
      expect(corruptRegistry.findings.map((finding) => finding.code)).toEqual(["registry_unavailable"]);
    });
  });
});

describe("reachability probe", () => {
  test("default resolution makes zero provider calls", async () => {
    await withFixture(async (state, root) => {
      await makeReadyRoute(state, root);
      const { calls, executor } = recordingExecutor(() => successfulOutcome());
      const implicit = await runRouteProbe(state, { tier: "medium", effort: "medium", probeExecutor: executor });
      expect(implicit.ok).toBe(true);
      expect(implicit.probe.state).toBe("not_requested");
      const explicitNone = await runRouteProbe(state, {
        tier: "medium",
        effort: "medium",
        probe: "none",
        probeExecutor: executor,
      });
      expect(explicitNone.probe.state).toBe("not_requested");
      expect(calls).toHaveLength(0);
    });
  });

  test("explicit probe makes exactly one injected bounded call on disposable state", async () => {
    await withFixture(async (state, root) => {
      await makeReadyRoute(state, root);
      let stateDirExisted = false;
      const { calls, executor } = recordingExecutor(async (request) => {
        stateDirExisted = (await stat(request.stateDir)).isDirectory();
        return successfulOutcome(2);
      });
      const report = await runRouteProbe(state, {
        tier: "medium",
        effort: "high",
        probe: "reachability",
        probeExecutor: executor,
      });
      expect(report.ok).toBe(true);
      expect(report.readiness).toBe("ready");
      expect(report.probe.state).toBe("ok");
      if (report.probe.state !== "ok") throw new Error("expected successful probe");
      expect(report.probe.outputBytes).toBe(2);
      expect(report.probe.truncated).toBe(false);
      expect(calls).toHaveLength(1);
      const request = calls[0]!;
      expect(request.provider).toBe("kimi");
      expect(request.model).toBe("kimi-standard");
      expect(request.effort).toBe("high");
      expect(request.prompt).toBe(ROUTE_PROBE_PROMPT);
      expect(request.timeoutMs).toBe(PROBE_TIMEOUT_MS);
      expect(request.maxOutputBytes).toBe(PROBE_MAX_OUTPUT_BYTES);
      expect(request.signal).toBeInstanceOf(AbortSignal);
      expect(request.signal.aborted).toBe(false);
      expect(stateDirExisted).toBe(true);
      expect(request.stateDir).not.toBe(state.stateDir);
      await expect(stat(request.stateDir)).rejects.toThrow();
    });
  });

  test("probe outcomes normalize to stable sanitized codes", async () => {
    const secret = "token=abc123";
    const cases: Array<{ code: RouteFindingCode; outcome: () => ProbeOutcome | Promise<ProbeOutcome> }> = [
      { code: "probe_auth_required", outcome: () => ({ ok: false, reason: "auth_required" }) },
      { code: "probe_unavailable", outcome: () => ({ ok: false, reason: "unavailable" }) },
      { code: "probe_internal", outcome: () => ({ ok: false, reason: "internal" }) },
      {
        code: "probe_internal",
        outcome: () => {
          throw new Error(`raw provider stderr ${secret}`);
        },
      },
      { code: "probe_malformed", outcome: () => ({ ok: false, reason: "weird" } as unknown as ProbeOutcome) },
      {
        code: "probe_malformed",
        outcome: () => ({ ok: true, outputBytes: "2", outputOverflow: false } as unknown as ProbeOutcome),
      },
      { code: "probe_malformed", outcome: () => null as unknown as ProbeOutcome },
      { code: "probe_malformed", outcome: () => ({ ok: "yes" } as unknown as ProbeOutcome) },
    ];
    for (const entry of cases) {
      await withFixture(async (state, root) => {
        await makeReadyRoute(state, root);
        const { calls, executor } = recordingExecutor(entry.outcome);
        const report = await runRouteProbe(state, {
          tier: "medium",
          effort: "medium",
          probe: "reachability",
          probeExecutor: executor,
        });
        expect(report.ok).toBe(false);
        expect(report.readiness).toBe("ready");
        expect(report.probe.state).toBe("failed");
        expect(report.findings.map((finding) => finding.code)).toEqual([entry.code]);
        expect(calls).toHaveLength(1);
        expect(JSON.stringify(report)).not.toContain(secret);
      });
    }
  });

  test("an invalid lifecycle result is aborted and terminated before disposable-state cleanup", async () => {
    await withFixture(async (state, root) => {
      await makeReadyRoute(state, root);
      const stateDir = path.join(root, "invalid-result-state");
      let cleanupCalls = 0;
      let terminateCalls = 0;
      let signal: AbortSignal | undefined;
      const executor: ProbeExecutor = {
        run: (request) => {
          signal = request.signal;
          return {
            result: undefined as unknown as Promise<ProbeOutcome>,
            terminate: async () => {
              terminateCalls += 1;
            },
          };
        },
      };
      const report = await runRouteProbe(
        state,
        { tier: "medium", effort: "medium", probe: "reachability", probeExecutor: executor },
        {
          createStateDir: async () => {
            await mkdir(stateDir, { recursive: true });
            return stateDir;
          },
          removeStateDir: async () => {
            cleanupCalls += 1;
            await rm(stateDir, { recursive: true, force: true });
          },
        },
      );
      expect(report.ok).toBe(false);
      expect(report.probe.state).toBe("failed");
      expect(report.findings.map((finding) => finding.code)).toEqual(["probe_malformed"]);
      expect(signal?.aborted).toBe(true);
      expect(terminateCalls).toBe(1);
      expect(cleanupCalls).toBe(1);
      await expect(stat(stateDir)).rejects.toThrow();
    });
  });

  test("a malformed post-launch handle without termination authority preserves disposable state", async () => {
    await withFixture(async (state, root) => {
      await makeReadyRoute(state, root);
      const stateDir = path.join(root, "unterminated-malformed-state");
      let cleanupCalls = 0;
      let signal: AbortSignal | undefined;
      const executor = {
        run: (request: ProbeRequest) => {
          signal = request.signal;
          return { result: undefined };
        },
      } as unknown as ProbeExecutor;
      const report = await runRouteProbe(
        state,
        { tier: "medium", effort: "medium", probe: "reachability", probeExecutor: executor },
        {
          createStateDir: async () => {
            await mkdir(stateDir, { recursive: true });
            return stateDir;
          },
          removeStateDir: async () => {
            cleanupCalls += 1;
            await rm(stateDir, { recursive: true, force: true });
          },
        },
      );
      expect(report.ok).toBe(false);
      expect(report.findings.map((finding) => finding.code)).toEqual(["probe_malformed"]);
      expect(signal?.aborted).toBe(true);
      expect(cleanupCalls).toBe(0);
      expect((await stat(stateDir)).isDirectory()).toBe(true);
    });
  });

  test("probe timeout aborts, awaits termination, then removes disposable state", async () => {
    await withFixture(async (state, root) => {
      await makeReadyRoute(state, root);
      jest.useFakeTimers();
      try {
        let observed: ProbeRequest | undefined;
        let terminateCalls = 0;
        let statePresentAtTermination = false;
        let called!: () => void;
        const calledPromise = new Promise<void>((resolve) => {
          called = resolve;
        });
        // The executor's invocation is the sync point: the timeout is already
        // registered by then, so advancing the clock fires it deterministically.
        const executor: ProbeExecutor = {
          run: (request) => {
            observed = request;
            called();
            const handle: ProbeExecutionHandle = {
              result: new Promise<ProbeOutcome>(() => {}),
              terminate: async () => {
                terminateCalls += 1;
                statePresentAtTermination = await stat(request.stateDir).then(
                  () => true,
                  () => false,
                );
              },
            };
            return handle;
          },
        };
        const promise = runRouteProbe(state, {
          tier: "medium",
          effort: "medium",
          probe: "reachability",
          probeExecutor: executor,
        });
        await calledPromise;
        expect(observed?.signal.aborted).toBe(false);
        expect(jest.getTimerCount()).toBe(1);
        jest.advanceTimersByTime(PROBE_TIMEOUT_MS);
        const report = await promise;
        expect(report.ok).toBe(false);
        expect(report.probe.state).toBe("failed");
        expect(report.findings.map((finding) => finding.code)).toEqual(["probe_timeout"]);
        expect(observed?.signal.aborted).toBe(true);
        expect(terminateCalls).toBe(1);
        expect(statePresentAtTermination).toBe(true);
        await expect(stat(observed!.stateDir)).rejects.toThrow();
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  test("timeout classification owns an abort-synchronous provider result", async () => {
    await withFixture(async (state, root) => {
      await makeReadyRoute(state, root);
      jest.useFakeTimers();
      try {
        let observed: ProbeRequest | undefined;
        let terminateCalls = 0;
        let called!: () => void;
        const calledPromise = new Promise<void>((resolve) => {
          called = resolve;
        });
        const executor: ProbeExecutor = {
          run: (request) => {
            observed = request;
            let settle!: (outcome: ProbeOutcome) => void;
            const result = new Promise<ProbeOutcome>((resolve) => {
              settle = resolve;
            });
            request.signal.addEventListener("abort", () => settle(successfulOutcome(2)), { once: true });
            called();
            return {
              result,
              terminate: async () => {
                terminateCalls += 1;
              },
            };
          },
        };
        const promise = runRouteProbe(state, {
          tier: "medium",
          effort: "medium",
          probe: "reachability",
          probeExecutor: executor,
        });
        await calledPromise;
        jest.advanceTimersByTime(PROBE_TIMEOUT_MS);
        const report = await promise;
        expect(observed?.signal.aborted).toBe(true);
        expect(terminateCalls).toBe(1);
        expect(report.ok).toBe(false);
        expect(report.probe.state).toBe("failed");
        expect(report.findings.map((finding) => finding.code)).toEqual(["probe_timeout"]);
        await expect(stat(observed!.stateDir)).rejects.toThrow();
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  test("unconfirmed timeout termination fails internally and preserves in-use disposable state", async () => {
    await withFixture(async (state, root) => {
      await makeReadyRoute(state, root);
      jest.useFakeTimers();
      try {
        const stateDir = path.join(root, "termination-unconfirmed-state");
        let observed: ProbeRequest | undefined;
        let cleanupCalls = 0;
        let called!: () => void;
        const calledPromise = new Promise<void>((resolve) => {
          called = resolve;
        });
        const executor: ProbeExecutor = {
          run: (request) => {
            observed = request;
            called();
            return {
              result: new Promise<ProbeOutcome>(() => {}),
              terminate: () => Promise.reject(new Error("termination not confirmed token=abc123")),
            };
          },
        };
        const promise = runRouteProbe(
          state,
          { tier: "medium", effort: "medium", probe: "reachability", probeExecutor: executor },
          {
            createStateDir: async () => {
              await mkdir(stateDir, { recursive: true });
              return stateDir;
            },
            removeStateDir: async () => {
              cleanupCalls += 1;
              await rm(stateDir, { recursive: true, force: true });
            },
          },
        );
        await calledPromise;
        jest.advanceTimersByTime(PROBE_TIMEOUT_MS);
        const report = await promise;
        expect(report.ok).toBe(false);
        expect(report.findings).toEqual([
          { code: "probe_internal", message: "reachability probe failed internally" },
        ]);
        expect(observed?.signal.aborted).toBe(true);
        expect(cleanupCalls).toBe(0);
        expect((await stat(stateDir)).isDirectory()).toBe(true);
        expect(JSON.stringify(report)).not.toContain("token=abc123");
      } finally {
        jest.useRealTimers();
      }
    });
  });

  test("hung timeout termination is bounded and preserves in-use disposable state", async () => {
    await withFixture(async (state, root) => {
      await makeReadyRoute(state, root);
      jest.useFakeTimers();
      try {
        const stateDir = path.join(root, "termination-hung-state");
        let observed: ProbeRequest | undefined;
        let cleanupCalls = 0;
        let terminateCalls = 0;
        let called!: () => void;
        let terminationStarted!: () => void;
        const calledPromise = new Promise<void>((resolve) => {
          called = resolve;
        });
        const terminationStartedPromise = new Promise<void>((resolve) => {
          terminationStarted = resolve;
        });
        const executor: ProbeExecutor = {
          run: (request) => {
            observed = request;
            called();
            return {
              result: new Promise<ProbeOutcome>(() => {}),
              terminate: () => {
                terminateCalls += 1;
                terminationStarted();
                return new Promise<void>(() => {});
              },
            };
          },
        };
        const promise = runRouteProbe(
          state,
          { tier: "medium", effort: "medium", probe: "reachability", probeExecutor: executor },
          {
            createStateDir: async () => {
              await mkdir(stateDir, { recursive: true });
              return stateDir;
            },
            removeStateDir: async () => {
              cleanupCalls += 1;
              await rm(stateDir, { recursive: true, force: true });
            },
          },
        );
        await calledPromise;
        jest.advanceTimersByTime(PROBE_TIMEOUT_MS);
        await terminationStartedPromise;
        expect(terminateCalls).toBe(1);
        expect(jest.getTimerCount()).toBe(1);
        jest.advanceTimersByTime(PROBE_TERMINATION_TIMEOUT_MS);
        const report = await promise;
        expect(observed?.signal.aborted).toBe(true);
        expect(report.ok).toBe(false);
        expect(report.findings).toEqual([
          { code: "probe_internal", message: "reachability probe failed internally" },
        ]);
        expect(cleanupCalls).toBe(0);
        expect((await stat(stateDir)).isDirectory()).toBe(true);
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  test("disposable state creation failure fails closed without calling the executor", async () => {
    await withFixture(async (state, root) => {
      await makeReadyRoute(state, root);
      const { calls, executor } = recordingExecutor(() => successfulOutcome());
      let removeCalls = 0;
      const report = await runRouteProbe(
        state,
        {
          tier: "medium",
          effort: "medium",
          probe: "reachability",
          probeExecutor: executor,
        },
        {
          createStateDir: () => Promise.reject(new Error(`EPERM mkdir ${root} token=abc123`)),
          removeStateDir: async () => {
            removeCalls++;
          },
        },
      );
      expect(report.ok).toBe(false);
      expect(report.readiness).toBe("ready");
      expect(report.probe.state).toBe("failed");
      expect(report.findings.map((finding) => finding.code)).toEqual(["probe_internal"]);
      expect(calls).toHaveLength(0);
      expect(removeCalls).toBe(0);
      const json = JSON.stringify(report);
      expect(json).not.toContain(root);
      expect(json).not.toContain("token=abc123");
    });
  });

  test("disposable state cleanup failure fails closed after a successful probe", async () => {
    await withFixture(async (state, root) => {
      await makeReadyRoute(state, root);
      const { calls, executor } = recordingExecutor(() => successfulOutcome(2));
      const stateDir = path.join(root, "cleanup-failure-state");
      const removedStateDirs: string[] = [];
      const report = await runRouteProbe(
        state,
        {
          tier: "medium",
          effort: "medium",
          probe: "reachability",
          probeExecutor: executor,
        },
        {
          createStateDir: async () => {
            await mkdir(stateDir, { recursive: true });
            return stateDir;
          },
          removeStateDir: (receivedStateDir) => {
            removedStateDirs.push(receivedStateDir);
            return Promise.reject(new Error("EBUSY token=abc123"));
          },
        },
      );
      expect(report.ok).toBe(false);
      expect(report.probe.state).toBe("failed");
      expect(report.findings.map((finding) => finding.code)).toEqual(["probe_internal"]);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.stateDir).toBe(stateDir);
      expect(removedStateDirs).toEqual([stateDir]);
      expect(JSON.stringify(report)).not.toContain("token=abc123");
    });
  });

  test("hostile outcome getters fail closed without leaking and still clean disposable state", async () => {
    await withFixture(async (state, root) => {
      await makeReadyRoute(state, root);
      const secret = "token=gap3-hostile-getter-secret";
      const stateDir = path.join(root, "hostile-getter-state");
      const hostileOutcome = new Proxy(successfulOutcome(), {
        get(target, property, receiver) {
          if (property === "ok") throw new Error(secret);
          return Reflect.get(target, property, receiver);
        },
      });
      const { calls, executor } = recordingExecutor(() => hostileOutcome);
      let removeCalls = 0;
      const removedStateDirs: string[] = [];

      const report = await runRouteProbe(
        state,
        {
          tier: "medium",
          effort: "medium",
          probe: "reachability",
          probeExecutor: executor,
        },
        {
          createStateDir: async () => {
            await mkdir(stateDir, { recursive: true });
            return stateDir;
          },
          removeStateDir: async (receivedStateDir) => {
            removeCalls++;
            removedStateDirs.push(receivedStateDir);
            await rm(receivedStateDir, { recursive: true, force: true });
          },
        },
      );

      expect(report.ok).toBe(false);
      expect(report.readiness).toBe("ready");
      expect(report.probe.state).toBe("failed");
      expect(report.findings).toEqual([
        { code: "probe_internal", message: "reachability probe failed internally" },
      ]);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.stateDir).toBe(stateDir);
      expect(removeCalls).toBe(1);
      expect(removedStateDirs).toEqual([stateDir]);
      await expect(stat(stateDir)).rejects.toThrow();

      const json = JSON.stringify(report);
      const human = formatRouteProbeReport(report);
      for (const output of [json, human]) {
        expect(output).not.toContain(secret);
        expect(output).not.toContain(root);
        expect(output).not.toContain(stateDir);
      }
      expect(human).toContain("probe failed");
      expect(human).toContain("fail probe_internal reachability probe failed internally");
    });
  });

  test("per-call state lifecycles stay isolated across concurrent probes and from the default", async () => {
    await withFixture(async (state, root) => {
      await makeReadyRoute(state, root);
      expect("probeStateLifecycle" in (await import("../src/route-probe"))).toBe(false);

      const stateDirA = path.join(root, "concurrent-probe-a");
      const stateDirB = path.join(root, "concurrent-probe-b");
      const lifecycleEvents: string[] = [];
      let entered = 0;
      let releaseBoth!: () => void;
      const bothEntered = new Promise<void>((resolve) => {
        releaseBoth = resolve;
      });
      const overlap = async (): Promise<void> => {
        entered++;
        if (entered === 2) releaseBoth();
        await bothEntered;
      };

      let observedStateDirA: string | undefined;
      let observedStateDirB: string | undefined;
      const { calls: callsA, executor: executorA } = recordingExecutor(async (request) => {
        observedStateDirA = request.stateDir;
        await overlap();
        return successfulOutcome(2);
      });
      const { calls: callsB, executor: executorB } = recordingExecutor(async (request) => {
        observedStateDirB = request.stateDir;
        await overlap();
        return successfulOutcome(2);
      });

      const [reportA, reportB] = await Promise.all([
        runRouteProbe(
          state,
          { tier: "medium", effort: "medium", probe: "reachability", probeExecutor: executorA },
          {
            createStateDir: async () => {
              lifecycleEvents.push("a:create");
              await mkdir(stateDirA, { recursive: true });
              return stateDirA;
            },
            removeStateDir: async (stateDir) => {
              lifecycleEvents.push(`a:remove:${stateDir}`);
              throw new Error("isolated cleanup failure token=abc123");
            },
          },
        ),
        runRouteProbe(
          state,
          { tier: "medium", effort: "medium", probe: "reachability", probeExecutor: executorB },
          {
            createStateDir: async () => {
              lifecycleEvents.push("b:create");
              await mkdir(stateDirB, { recursive: true });
              return stateDirB;
            },
            removeStateDir: async (stateDir) => {
              lifecycleEvents.push(`b:remove:${stateDir}`);
              await rm(stateDir, { recursive: true, force: true });
            },
          },
        ),
      ]);

      expect(reportA.ok).toBe(false);
      expect(reportA.probe.state).toBe("failed");
      expect(reportA.findings.map((finding) => finding.code)).toEqual(["probe_internal"]);
      expect(JSON.stringify(reportA)).not.toContain("token=abc123");
      expect(reportB.ok).toBe(true);
      expect(reportB.probe.state).toBe("ok");
      expect(reportB.findings).toEqual([]);
      expect(callsA).toHaveLength(1);
      expect(callsB).toHaveLength(1);
      expect(observedStateDirA).toBe(stateDirA);
      expect(observedStateDirB).toBe(stateDirB);
      expect(lifecycleEvents).toContain("a:create");
      expect(lifecycleEvents).toContain(`a:remove:${stateDirA}`);
      expect(lifecycleEvents).toContain("b:create");
      expect(lifecycleEvents).toContain(`b:remove:${stateDirB}`);
      expect((await stat(stateDirA)).isDirectory()).toBe(true);
      await expect(stat(stateDirB)).rejects.toThrow();
      await rm(stateDirA, { recursive: true, force: true });

      let defaultStateDir: string | undefined;
      const { executor: defaultExecutor } = recordingExecutor((request) => {
        defaultStateDir = request.stateDir;
        return successfulOutcome(2);
      });
      const defaultReport = await runRouteProbe(state, {
        tier: "medium",
        effort: "medium",
        probe: "reachability",
        probeExecutor: defaultExecutor,
      });
      expect(defaultReport.ok).toBe(true);
      expect(defaultReport.probe.state).toBe("ok");
      expect(defaultStateDir).toBeDefined();
      expect(defaultStateDir).not.toBe(stateDirA);
      expect(defaultStateDir).not.toBe(stateDirB);
      expect(defaultStateDir).not.toBe(state.stateDir);
      await expect(stat(defaultStateDir!)).rejects.toThrow();
    });
  });

  test("a synchronously throwing executor clears its timer and fails closed as probe_internal", async () => {
    await withFixture(async (state, root) => {
      await makeReadyRoute(state, root);
      jest.useFakeTimers();
      try {
        const secret = "sync raw stderr token=abc123";
        const stateDir = path.join(root, "sync-throw-state");
        let observedStateDir: string | undefined;
        let observedStatePresent = false;
        let observedSignal: AbortSignal | undefined;
        let cleanupCalls = 0;
        const executor: ProbeExecutor = {
          run: (request) => {
            observedStateDir = request.stateDir;
            observedStatePresent = existsSync(request.stateDir);
            observedSignal = request.signal;
            throw new Error(secret);
          },
        };
        const report = await runRouteProbe(
          state,
          {
            tier: "medium",
            effort: "medium",
            probe: "reachability",
            probeExecutor: executor,
          },
          {
            createStateDir: async () => {
              await mkdir(stateDir, { recursive: true });
              return stateDir;
            },
            removeStateDir: async () => {
              cleanupCalls += 1;
              await rm(stateDir, { recursive: true, force: true });
            },
          },
        );
        expect(report.ok).toBe(false);
        expect(report.probe.state).toBe("failed");
        expect(report.findings).toEqual([
          { code: "probe_internal", message: "reachability probe failed internally" },
        ]);
        expect(observedStateDir).toBe(stateDir);
        expect(observedStatePresent).toBe(true);
        expect(observedSignal?.aborted).toBe(true);
        expect(cleanupCalls).toBe(0);
        expect((await stat(stateDir)).isDirectory()).toBe(true);
        expect(jest.getTimerCount()).toBe(0);
        for (const output of [JSON.stringify(report), formatRouteProbeReport(report)]) {
          expect(output).not.toContain(secret);
        }
      } finally {
        jest.useRealTimers();
      }
    });
  });

  test("an asynchronously rejecting executor clears its timer without leaking the raw error", async () => {
    await withFixture(async (state, root) => {
      await makeReadyRoute(state, root);
      jest.useFakeTimers();
      try {
        const secret = "async raw stderr token=def456";
        const executor: ProbeExecutor = {
          run: () => ({
            result: Promise.reject(new Error(secret)),
            terminate: async () => {},
          }),
        };
        const report = await runRouteProbe(state, {
          tier: "medium",
          effort: "medium",
          probe: "reachability",
          probeExecutor: executor,
        });
        expect(report.ok).toBe(false);
        expect(report.probe.state).toBe("failed");
        expect(report.findings).toEqual([
          { code: "probe_internal", message: "reachability probe failed internally" },
        ]);
        expect(jest.getTimerCount()).toBe(0);
        for (const output of [JSON.stringify(report), formatRouteProbeReport(report)]) {
          expect(output).not.toContain(secret);
        }
      } finally {
        jest.useRealTimers();
      }
    });
  });

  test("probe output is measured against the fixed 64-byte ceiling and never echoed", async () => {
    const cases = [
      { name: "below", outputBytes: 2 },
      { name: "exact bound", outputBytes: PROBE_MAX_OUTPUT_BYTES },
    ] as const;
    for (const entry of cases) {
      await withFixture(async (state, root) => {
        await makeReadyRoute(state, root);
        const { executor } = recordingExecutor(() => successfulOutcome(entry.outputBytes));
        const report = await runRouteProbe(state, {
          tier: "medium",
          effort: "medium",
          probe: "reachability",
          probeExecutor: executor,
        });
        expect(report.probe.state, entry.name).toBe("ok");
        if (report.probe.state !== "ok") throw new Error(`expected successful ${entry.name} probe`);
        expect(report.probe.outputBytes, entry.name).toBe(entry.outputBytes);
        expect(report.probe.truncated, entry.name).toBe(false);
        const human = formatRouteProbeReport(report);
        expect(Object.keys(report.probe), entry.name).not.toContain("output");
        expect(human, entry.name).toContain("probe ok (");
      });
    }
    // A successful probe explicitly reports an empty bounded stream as zero bytes.
    await withFixture(async (state, root) => {
      await makeReadyRoute(state, root);
      const { executor } = recordingExecutor(() => successfulOutcome());
      const report = await runRouteProbe(state, {
        tier: "medium",
        effort: "medium",
        probe: "reachability",
        probeExecutor: executor,
      });
      expect(report.probe.state).toBe("ok");
      if (report.probe.state !== "ok") throw new Error("expected successful output-free probe");
      expect(report.probe.outputBytes).toBe(0);
      expect(report.probe.truncated).toBe(false);
    });
    for (const outcome of [
      successfulOutcome(PROBE_MAX_OUTPUT_BYTES, true),
      successfulOutcome(PROBE_MAX_OUTPUT_BYTES + 1),
    ]) {
      await withFixture(async (state, root) => {
        await makeReadyRoute(state, root);
        const { executor } = recordingExecutor(() => outcome);
        const report = await runRouteProbe(state, {
          tier: "medium",
          effort: "medium",
          probe: "reachability",
          probeExecutor: executor,
        });
        expect(report.probe.state).toBe("failed");
        expect(report.ok).toBe(false);
        expect(report.findings).toEqual([
          { code: "probe_output_limit", message: "reachability probe exceeded its bounded output limit" },
        ]);
      });
    }
  });

  test("probe is skipped without a call when the route is unready", async () => {
    await withFixture(async (state) => {
      await writeFullConfig(state);
      // Kimi deliberately unpinned: route resolves but readiness fails closed.
      const { calls, executor } = recordingExecutor(() => successfulOutcome());
      const report = await runRouteProbe(state, {
        tier: "medium",
        effort: "medium",
        probe: "reachability",
        probeExecutor: executor,
      });
      expect(report.ok).toBe(false);
      expect(report.probe.state).toBe("skipped");
      expect(calls).toHaveLength(0);
    });
  });

  test("unsupported probe modes fail closed without a call", async () => {
    await withFixture(async (state, root) => {
      await makeReadyRoute(state, root);
      for (const mode of ["deep", 5]) {
        const { calls, executor } = recordingExecutor(() => successfulOutcome());
        const report = await runRouteProbe(state, {
          tier: "medium",
          effort: "medium",
          probe: mode as never,
          probeExecutor: executor,
        });
        expect(report.ok).toBe(false);
        expect(report.readiness).toBe("ready");
        expect(report.probe.state).toBe("failed");
        expect(report.findings.map((finding) => finding.code)).toEqual(["unsupported_probe_mode"]);
        expect(calls).toHaveLength(0);
      }
      // A reachability probe without an executor is rejected the same way.
      const missing = await runRouteProbe(state, {
        tier: "medium",
        effort: "medium",
        probe: "reachability",
      });
      expect(missing.ok).toBe(false);
      expect(missing.readiness).toBe("ready");
      expect(missing.probe.state).toBe("failed");
      expect(missing.findings.map((finding) => finding.code)).toEqual(["probe_executor_missing"]);
    });
  });

  test("repeated read-only probes do not mutate canonical state", async () => {
    await withFixture(async (state, root) => {
      await makeReadyRoute(state, root);
      const configBefore = await Bun.file(state.configFile).text();
      const registryBefore = await Bun.file(path.join(state.stateDir, "providers.json")).text();
      const sessionsBefore = await readdir(state.sessionsDir);
      const stateDirs = new Set<string>();
      const { calls, executor } = recordingExecutor(async (request) => {
        stateDirs.add(request.stateDir);
        await Bun.write(path.join(request.stateDir, "probe-evidence"), "disposable\n");
        return successfulOutcome(2);
      });
      for (let index = 0; index < 3; index++) {
        const report = await runRouteProbe(state, {
          tier: "medium",
          effort: "medium",
          probe: "reachability",
          probeExecutor: executor,
        });
        expect(report.probe.state).toBe("ok");
      }
      expect(calls).toHaveLength(3);
      expect(stateDirs.size).toBe(3);
      expect(await Bun.file(state.configFile).text()).toBe(configBefore);
      expect(await Bun.file(path.join(state.stateDir, "providers.json")).text()).toBe(registryBefore);
      expect(await readdir(state.sessionsDir)).toEqual(sessionsBefore);
      for (const stateDir of stateDirs) {
        await expect(stat(stateDir)).rejects.toThrow();
      }
    });
  });
});

describe("report output", () => {
  test("JSON shape is versioned and stable", async () => {
    await withFixture(async (state, root) => {
      await makeReadyRoute(state, root);
      const { executor } = recordingExecutor(() => successfulOutcome(2));
      const report = await runRouteProbe(state, {
        tier: "high",
        effort: "low",
        probe: "reachability",
        probeExecutor: executor,
      });
      expect(report.schemaVersion).toBe(1);
      expect(Object.keys(report).sort()).toEqual(
        ["findings", "ok", "probe", "readiness", "requested", "route", "schemaVersion"].sort(),
      );
      expect(Object.keys(report.requested).sort()).toEqual(["effort", "tier"]);
      expect(Object.keys(report.route!).sort()).toEqual(["agentPreset", "model", "provider", "tier"]);
      expect(Object.keys(report.probe).sort()).toEqual(
        ["durationMs", "outputBytes", "state", "truncated"].sort(),
      );
    });
  });

  test("human output is concise and secret-safe", async () => {
    await withFixture(async (state, root) => {
      await writeFullConfig(state);
      const executable = await pinProvider(state, root, "kimi");
      await Bun.write(executable, "#!/bin/sh\nexit 1\n");
      const report = await runRouteProbe(state, { tier: "medium", effort: "medium" });
      const text = formatRouteProbeReport(report);
      expect(text).toContain("route probe FAILED");
      expect(text).toContain("requested tier=medium effort=medium");
      expect(text).toContain("route provider=kimi model=kimi-standard preset=Kimi");
      expect(text).toContain("readiness unready");
      expect(text).toContain("fail provider_unverified");
      expect(text).not.toContain(root);
      expect(text).not.toContain(executable);
      expect(text.split("\n").length).toBeLessThanOrEqual(8);
    });
  });

  test("human output renders skipped and failed probe states", async () => {
    await withFixture(async (state) => {
      await writeFullConfig(state);
      // Kimi deliberately unpinned: route resolves but readiness fails closed.
      const { executor } = recordingExecutor(() => successfulOutcome());
      const report = await runRouteProbe(state, {
        tier: "medium",
        effort: "medium",
        probe: "reachability",
        probeExecutor: executor,
      });
      expect(report.probe.state).toBe("skipped");
      const text = formatRouteProbeReport(report);
      expect(text).toContain("probe skipped (route unready)");
      expect(text).toContain("fail provider_unpinned");
    });
    await withFixture(async (state, root) => {
      await makeReadyRoute(state, root);
      const { executor } = recordingExecutor(() => ({ ok: false, reason: "unavailable" }));
      const report = await runRouteProbe(state, {
        tier: "medium",
        effort: "medium",
        probe: "reachability",
        probeExecutor: executor,
      });
      expect(report.probe.state).toBe("failed");
      const text = formatRouteProbeReport(report);
      expect(text).toContain("probe failed");
      expect(text).toContain("fail probe_unavailable");
    });
  });

  test("requested output carries only validated values; invalid input becomes a null sentinel", async () => {
    await withFixture(async (state, root) => {
      await makeReadyRoute(state, root);
      const secret = "token=abc123";
      const tier = `ultra\r\n${"t".repeat(100)}${root}`;
      const effort = `${"e".repeat(100)}${secret}`;
      const report = await runRouteProbe(state, { tier, effort });
      expect(report.ok).toBe(false);
      expect(report.requested).toEqual({ tier: null, effort: null });
      expect(report.findings.map((finding) => finding.code)).toEqual(["unknown_tier", "malformed_effort"]);
      const json = JSON.stringify(report);
      const human = formatRouteProbeReport(report);
      for (const output of [json, human]) {
        expect(output).not.toContain(root);
        expect(output).not.toContain(secret);
        expect(output).not.toContain("ultra");
        expect(output).not.toContain("tttt");
        expect(output).not.toContain("eeee");
      }
      expect(human).toContain("requested tier=<invalid> effort=<invalid>");
      // JSON.stringify escapes control characters; the human renderer's only
      // structural control character is the newline between lines.
      expect(json).not.toMatch(/[\x00-\x1f\x7f]/);
      for (const line of human.split("\n")) expect(line).not.toMatch(/[\x00-\x1f\x7f]/);
    });
    // An early printable secret or path (no control characters, within any
    // length bound) is still never echoed: only validated tokens reach output.
    await withFixture(async (state, root) => {
      await makeReadyRoute(state, root);
      const report = await runRouteProbe(state, { tier: root, effort: "token=abc123" });
      expect(report.requested).toEqual({ tier: null, effort: null });
      const json = JSON.stringify(report);
      const human = formatRouteProbeReport(report);
      for (const output of [json, human]) {
        expect(output).not.toContain(root);
        expect(output).not.toContain("token=abc123");
      }
    });
    // Findings never carry provider-home relative credential paths.
    await withFixture(async (state, root) => {
      await writeFullConfig(state);
      await pinProvider(state, root, "kimi");
      const report = await runRouteProbe(state, { tier: "medium", effort: "medium" });
      expect(report.findings.map((finding) => finding.code)).toEqual(["credential_missing"]);
      const json = JSON.stringify(report);
      expect(json).not.toContain("kimi-code.json");
      expect(json).not.toContain(state.stateDir);
    });
  });
});
