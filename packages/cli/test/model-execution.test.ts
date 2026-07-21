import { afterEach, describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { adapterHome, type AdapterDoctorResult } from "../src/adapters";
import {
  MAX_PROMPT_BYTES,
  executeModelRequest,
  readPromptFile,
  readPromptStdin,
  receiptProviderVersion,
  type ExecutionPolicy,
  type ModelEffort,
  type ModelExecutionDependencies,
  type ToolPolicy,
} from "../src/model-execution";
import {
  AGENT_ROUTE_POLICY,
  ROUTE_POLICY_VERSION,
  TIER_ROUTES,
  type ModelTier,
  type ResolvedRoute,
} from "../src/route-probe";
import {
  ensureSharedState,
  readSessionConfig,
  sharedStateAt,
  writeSessionConfig,
  type SharedState,
} from "../src/state";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; state: SharedState; receiptDir: string }> {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "agents-model-execution-"));
  roots.push(sandbox);
  const root = path.join(sandbox, "worktree");
  await mkdir(root);
  const state = sharedStateAt(root, path.join(sandbox, ".agents"), path.join(sandbox, "user"));
  await ensureSharedState(state);
  await writeSessionConfig(state, {
    schemaVersion: 1,
    providerModels: {
      agy: ["agy-fast"],
      kimi: ["kimi-code/kimi-for-coding"],
      codex: ["gpt-5.6-sol"],
      claude: ["claude-fable-5"],
    },
  });
  const receiptDir = path.join(root, ".agents");
  await mkdir(receiptDir, { recursive: true });
  return { root, state, receiptDir };
}

function doctorResult(provider: ResolvedRoute["provider"], version = `${provider} 1.2.3`): AdapterDoctorResult {
  return {
    id: provider,
    home: "<redacted>",
    binary: "<canonical>",
    ok: true,
    pinned: true,
    notes: [],
    evidence: {
      schemaVersion: 1,
      provider,
      pinned: true,
      executableVerified: true,
      credentialsPresent: true,
      providerVersion: version,
    },
  };
}

function successfulDependencies(
  capture: Array<{ route: ResolvedRoute; effort: ModelEffort; executionPolicy: ExecutionPolicy; toolPolicy: ToolPolicy; prompt: string }> = [],
  options: {
    resolvedExecutionPolicy?: ExecutionPolicy | null;
    resolvedToolPolicy?: ToolPolicy | null;
    version?: string;
    usage?: { tokensIn?: number; tokensOut?: number; totalTokens?: number };
    error?: string;
    content?: string;
  } = {},
): ModelExecutionDependencies {
  return {
    doctor: async (_state, provider) => doctorResult(provider, options.version),
    execute: async (_state, route, _doctor, request) => {
      capture.push({
        route,
        effort: request.effort,
        executionPolicy: request.executionPolicy,
        toolPolicy: request.toolPolicy,
        prompt: request.prompt,
      });
      return {
        sessionId: "test-session",
        outcome: {
          resolvedExecutionPolicy: Object.prototype.hasOwnProperty.call(options, "resolvedExecutionPolicy")
            ? options.resolvedExecutionPolicy!
            : request.executionPolicy,
          resolvedToolPolicy: Object.prototype.hasOwnProperty.call(options, "resolvedToolPolicy")
            ? options.resolvedToolPolicy!
            : request.toolPolicy,
          result: {
            content: options.content ?? "ok",
            role: "assistant",
            usage: Object.prototype.hasOwnProperty.call(options, "usage")
              ? options.usage
              : { tokensIn: 11, tokensOut: 7, totalTokens: 18 },
            error: options.error,
            ...(route.provider === "agy"
              ? {
                  receipt: {
                    provider: "agy",
                    requestedModel: route.model,
                    concreteModel: `Gemini 3.5 Flash (${request.effort[0]!.toUpperCase()}${request.effort.slice(1)})`,
                    effort: request.effort,
                    agentPreset: null,
                  },
                }
              : {}),
          },
        },
      };
    },
  };
}

function request(
  root: string,
  receiptDir: string,
  modelTier: ModelTier,
  effort: ModelEffort = "medium",
  executionPolicy: ExecutionPolicy = "read-only",
  toolPolicy: ToolPolicy = "standard",
) {
  return {
    modelTier,
    effort,
    executionPolicy,
    toolPolicy,
    receiptPath: path.join(receiptDir, `${modelTier}-${effort}-${executionPolicy}-${toolPolicy}.json`),
    workdir: root,
    mode: "task" as const,
    prompt: "Review the admitted fixture.",
    promptSource: "positional" as const,
  };
}

describe("canonical model execution route and receipt", () => {
  test("success matrix resolves all tiers without a DarkFactory provider registry", async () => {
    const { root, state, receiptDir } = await fixture();
    const captured: Parameters<typeof successfulDependencies>[0] = [];
    for (const tier of ["low", "medium", "high", "max"] as const) {
      const result = await executeModelRequest(
        state,
        request(root, receiptDir, tier),
        successfulDependencies(captured),
      );
      expect(result.ok).toBe(true);
      expect(result.receipt).toEqual(JSON.parse(await Bun.file(request(root, receiptDir, tier).receiptPath).text()));
      expect(result.receipt).toEqual({
        schemaVersion: 3,
        requested: { modelTier: tier, effort: "medium", toolPolicy: "standard" },
        routing: {
          policyVersion: ROUTE_POLICY_VERSION,
          primary: {
            provider: TIER_ROUTES[tier].provider,
            model: {
              low: "agy-fast",
              medium: "kimi-code/kimi-for-coding",
              high: "gpt-5.6-sol",
              max: "claude-fable-5",
            }[tier],
            agentPreset: TIER_ROUTES[tier].agentPreset,
            providerVersion: "1.2.3",
          },
          skipped: [],
        },
        resolved: {
          provider: TIER_ROUTES[tier].provider,
          model: {
            low: "Gemini 3.5 Flash (Medium)",
            medium: "kimi-code/kimi-for-coding",
            high: "gpt-5.6-sol",
            max: "claude-fable-5",
          }[tier],
          agentPreset: TIER_ROUTES[tier].agentPreset,
          providerVersion: "1.2.3",
          toolPolicy: "standard",
        },
        attempts: [{ number: 1, outcome: "success", reason: null }],
        usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
        outcome: "success",
        blockReason: null,
      });
    }
    expect(captured.map(({ route }) => route.provider)).toEqual(["agy", "kimi", "codex", "claude"]);
  });

  test("effort varies independently without changing the medium route", async () => {
    const { root, state, receiptDir } = await fixture();
    const captured: Parameters<typeof successfulDependencies>[0] = [];
    for (const effort of ["low", "medium", "high"] as const) {
      const result = await executeModelRequest(
        state,
        request(root, receiptDir, "medium", effort),
        successfulDependencies(captured),
      );
      expect(result.ok).toBe(true);
      expect(result.receipt.requested.effort).toBe(effort);
      expect(result.receipt.resolved.provider).toBe("kimi");
      expect(result.receipt.resolved.model).toBe("kimi-code/kimi-for-coding");
    }
    expect(captured.map(({ effort }) => effort)).toEqual(["low", "medium", "high"]);
    expect(new Set(captured.map(({ route }) => JSON.stringify(route))).size).toBe(1);
  });

  test("fallback regression triplet: healthy Kimi remains the medium primary", async () => {
    const { root, state, receiptDir } = await fixture();
    const doctors: string[] = [];
    const captured: Parameters<typeof successfulDependencies>[0] = [];
    const dependencies = successfulDependencies(captured);
    dependencies.doctor = async (_state, provider) => {
      doctors.push(provider);
      return doctorResult(provider);
    };

    const result = await executeModelRequest(
      state,
      request(root, receiptDir, "medium"),
      dependencies,
    );

    expect(result.ok).toBe(true);
    expect(doctors).toEqual(["kimi"]);
    expect(captured.map(({ route }) => route.provider)).toEqual(["kimi"]);
    expect(result.receipt.routing).toEqual({
      policyVersion: ROUTE_POLICY_VERSION,
      primary: {
        provider: "kimi",
        model: "kimi-code/kimi-for-coding",
        agentPreset: "Kimi",
        providerVersion: "1.2.3",
      },
      skipped: [],
    });
  });

  test("fallback regression triplet: decommissioned Kimi selects Codex without touching Kimi", async () => {
    const { root, state, receiptDir } = await fixture();
    await writeSessionConfig(state, {
      ...(await readSessionConfig(state)),
      providerRouteStatus: { kimi: "decommissioned" },
    });
    const doctors: string[] = [];
    const captured: Parameters<typeof successfulDependencies>[0] = [];
    const dependencies = successfulDependencies(captured);
    dependencies.doctor = async (_state, provider) => {
      doctors.push(provider);
      return doctorResult(provider);
    };

    const result = await executeModelRequest(
      state,
      request(root, receiptDir, "medium"),
      dependencies,
    );

    expect(result.ok).toBe(true);
    expect(doctors).toEqual(["codex"]);
    expect(captured.map(({ route }) => route.provider)).toEqual(["codex"]);
    expect(await Bun.file(adapterHome(state, "kimi")).exists()).toBe(false);
    expect(result.receipt.requested).toEqual({ modelTier: "medium", effort: "medium", toolPolicy: "standard" });
    expect(result.receipt.resolved).toEqual({
      provider: "codex",
      model: "gpt-5.6-sol",
      agentPreset: "Sol",
      providerVersion: "1.2.3",
      toolPolicy: "standard",
    });
    expect(result.receipt.routing).toEqual({
      policyVersion: ROUTE_POLICY_VERSION,
      primary: {
        provider: "kimi",
        model: "kimi-code/kimi-for-coding",
        agentPreset: "Kimi",
        providerVersion: "unresolved",
      },
      skipped: [
        {
          provider: "kimi",
          model: "kimi-code/kimi-for-coding",
          agentPreset: "Kimi",
          providerVersion: "unresolved",
          reason: "provider_decommissioned",
        },
      ],
    });
  });

  test("fallback regression triplet: both medium candidates unavailable fail closed before launch", async () => {
    const { root, state, receiptDir } = await fixture();
    await writeSessionConfig(state, {
      ...(await readSessionConfig(state)),
      providerRouteStatus: { kimi: "decommissioned" },
    });
    const doctors: string[] = [];
    let executions = 0;
    const result = await executeModelRequest(state, request(root, receiptDir, "medium"), {
      doctor: async (_state, provider) => {
        doctors.push(provider);
        return {
          ...doctorResult(provider),
          binary: null,
          ok: false,
          pinned: false,
          evidence: {
            ...doctorResult(provider).evidence,
            pinned: false,
            executableVerified: false,
          },
        };
      },
      execute: async () => {
        executions += 1;
        throw new Error("must not start");
      },
    });

    expect(result.ok).toBe(false);
    expect(result.sessionId).toBeNull();
    expect(doctors).toEqual(["codex", "claude"]);
    expect(executions).toBe(0);
    expect(result.receipt.blockReason).toBe("provider_unpinned");
    expect(result.receipt.resolved).toEqual({
      provider: "unresolved",
      model: "unresolved",
      agentPreset: "unresolved",
      providerVersion: "unresolved",
      toolPolicy: "unresolved",
    });
    expect(result.receipt.routing.skipped.map(({ provider, reason }) => ({ provider, reason }))).toEqual([
      { provider: "kimi", reason: "provider_decommissioned" },
      { provider: "codex", reason: "provider_unpinned" },
      { provider: "claude", reason: "provider_unpinned" },
    ]);
  });

  test("fallback effort matrix preserves medium tier and low/medium/high effort", async () => {
    const { root, state, receiptDir } = await fixture();
    await writeSessionConfig(state, {
      ...(await readSessionConfig(state)),
      providerRouteStatus: { kimi: "decommissioned" },
    });
    const captured: Parameters<typeof successfulDependencies>[0] = [];
    for (const effort of ["low", "medium", "high"] as const) {
      const result = await executeModelRequest(
        state,
        request(root, receiptDir, "medium", effort),
        successfulDependencies(captured),
      );
      expect(result.ok).toBe(true);
      expect(result.receipt.requested).toEqual({ modelTier: "medium", effort, toolPolicy: "standard" });
      expect(result.receipt.resolved.provider).toBe("codex");
      expect(result.receipt.routing.skipped[0]?.reason).toBe("provider_decommissioned");
    }
    expect(captured.map(({ route, effort }) => ({ provider: route.provider, effort }))).toEqual([
      { provider: "codex", effort: "low" },
      { provider: "codex", effort: "medium" },
      { provider: "codex", effort: "high" },
    ]);
  });

  test("disabled, unavailable, and quota-blocked medium primaries promote with stable evidence", async () => {
    const { root, state, receiptDir } = await fixture();
    const expected = {
      disabled: "provider_disabled",
      unavailable: "provider_unavailable",
      "quota-blocked": "provider_quota_blocked",
    } as const;
    for (const [status, reason] of Object.entries(expected)) {
      await writeSessionConfig(state, {
        ...(await readSessionConfig(state)),
        providerRouteStatus: { kimi: status as keyof typeof expected },
      });
      const doctors: string[] = [];
      const captured: Parameters<typeof successfulDependencies>[0] = [];
      const dependencies = successfulDependencies(captured);
      dependencies.doctor = async (_state, provider) => {
        doctors.push(provider);
        return doctorResult(provider);
      };
      const input = request(root, receiptDir, "medium");
      input.receiptPath = path.join(receiptDir, `${status}.json`);

      const result = await executeModelRequest(state, input, dependencies);

      expect(result.ok, status).toBe(true);
      expect(doctors, status).toEqual(["codex"]);
      expect(captured.map(({ route }) => route.provider), status).toEqual(["codex"]);
      expect(result.receipt.routing.skipped[0]?.reason, status).toBe(reason);
    }
  });

  test("an unhealthy Kimi promotes to healthy Codex before the turn", async () => {
    const { root, state, receiptDir } = await fixture();
    const doctors: string[] = [];
    const captured: Parameters<typeof successfulDependencies>[0] = [];
    const dependencies = successfulDependencies(captured);
    dependencies.doctor = async (_state, provider) => {
      doctors.push(provider);
      if (provider === "kimi") {
        return {
          ...doctorResult(provider),
          binary: null,
          ok: false,
          evidence: { ...doctorResult(provider).evidence, executableVerified: false },
        };
      }
      return doctorResult(provider);
    };

    const result = await executeModelRequest(
      state,
      request(root, receiptDir, "medium"),
      dependencies,
    );

    expect(result.ok).toBe(true);
    expect(doctors).toEqual(["kimi", "codex"]);
    expect(captured.map(({ route }) => route.provider)).toEqual(["codex"]);
    expect(result.receipt.routing.skipped[0]).toMatchObject({
      provider: "kimi",
      reason: "provider_unverified",
    });
  });

  test("a turn-started provider failure never retries another candidate", async () => {
    const { root, state, receiptDir } = await fixture();
    const doctors: string[] = [];
    let executions = 0;
    const result = await executeModelRequest(state, request(root, receiptDir, "medium"), {
      doctor: async (_state, provider) => {
        doctors.push(provider);
        return doctorResult(provider);
      },
      execute: async (_state, route) => {
        executions += 1;
        expect(route.provider).toBe("kimi");
        throw new Error("turn failed after launch");
      },
    });

    expect(result.ok).toBe(false);
    expect(result.receipt.blockReason).toBe("provider_failed");
    expect(doctors).toEqual(["kimi"]);
    expect(executions).toBe(1);
    expect(result.receipt.routing.skipped).toEqual([]);
  });

  test("route policy trust rejects malformed, unknown, drifted, and downgraded candidates", async () => {
    const cases: Array<{ name: string; policy: unknown; reason: string }> = [];
    cases.push({ name: "malformed", policy: null, reason: "route_policy_malformed" });
    const unknown = structuredClone(AGENT_ROUTE_POLICY);
    (unknown.tiers.medium.candidates[1] as { provider: string }).provider = "unknown";
    cases.push({ name: "unknown", policy: unknown, reason: "route_policy_candidate_unknown" });
    const versionDrift = structuredClone(AGENT_ROUTE_POLICY);
    (versionDrift as { version: string }).version = "agent-os-tier-routes-v0";
    cases.push({ name: "version", policy: versionDrift, reason: "route_policy_version_mismatch" });
    const downgraded = structuredClone(AGENT_ROUTE_POLICY);
    (downgraded.tiers.medium.candidates[1] as { capabilityTier: ModelTier }).capabilityTier = "low";
    cases.push({ name: "downgrade", policy: downgraded, reason: "route_policy_capability_downgrade" });
    const drifted = structuredClone(AGENT_ROUTE_POLICY);
    (drifted.tiers.medium.candidates[1] as { agentPreset: string }).agentPreset = "Codex";
    cases.push({ name: "drift", policy: drifted, reason: "route_policy_drift" });

    for (const entry of cases) {
      const { root, state, receiptDir } = await fixture();
      let doctorCalls = 0;
      const input = request(root, receiptDir, "medium");
      input.receiptPath = path.join(receiptDir, `${entry.name}.json`);
      const result = await executeModelRequest(state, input, {
        routePolicy: entry.policy,
        doctor: async (_state, provider) => {
          doctorCalls += 1;
          return doctorResult(provider);
        },
      });
      expect(result.ok, entry.name).toBe(false);
      expect(result.receipt.blockReason, entry.name).toBe(entry.reason);
      expect(doctorCalls, entry.name).toBe(0);
    }
  });

  test("canonical config rejects route-policy version drift before any provider doctor", async () => {
    const { root, state, receiptDir } = await fixture();
    await writeSessionConfig(state, {
      ...(await readSessionConfig(state)),
      routePolicyVersion: "agent-os-tier-routes-v0",
    });
    let doctorCalls = 0;
    const result = await executeModelRequest(state, request(root, receiptDir, "medium"), {
      doctor: async (_state, provider) => {
        doctorCalls += 1;
        return doctorResult(provider);
      },
    });
    expect(result.ok).toBe(false);
    expect(result.receipt.blockReason).toBe("route_policy_version_mismatch");
    expect(doctorCalls).toBe(0);
  });

  test("route failure publishes a blocked receipt and never executes", async () => {
    const { root, state, receiptDir } = await fixture();
    let calls = 0;
    const input = request(root, receiptDir, "high");
    const result = await executeModelRequest(state, input, {
      doctor: async (_state, provider) => ({
        ...doctorResult(provider),
        binary: null,
        ok: false,
        evidence: {
          ...doctorResult(provider).evidence,
          executableVerified: false,
        },
      }),
      execute: async () => {
        calls += 1;
        throw new Error("must not execute");
      },
    });
    expect(calls).toBe(0);
    expect(result.ok).toBe(false);
    expect(result.receipt.outcome).toBe("blocked");
    expect(result.receipt.blockReason).toBe("provider_unverified");
    expect(result.receipt.resolved).toEqual({
      provider: "unresolved",
      model: "unresolved",
      agentPreset: "unresolved",
      providerVersion: "unresolved",
      toolPolicy: "unresolved",
    });
    expect(result.receipt.routing.skipped).toEqual([
      {
        provider: "codex",
        model: "gpt-5.6-sol",
        agentPreset: "Sol",
        providerVersion: "1.2.3",
        reason: "provider_unverified",
      },
      {
        provider: "claude",
        model: "claude-fable-5",
        agentPreset: "Fable",
        providerVersion: "1.2.3",
        reason: "provider_unverified",
      },
    ]);
    expect(JSON.parse(await Bun.file(input.receiptPath).text())).toEqual(result.receipt);
  });

  test("resolved policy mismatch blocks even when provider content looks successful", async () => {
    const { root, state, receiptDir } = await fixture();
    const result = await executeModelRequest(
      state,
      request(root, receiptDir, "high", "high", "workspace-write"),
      successfulDependencies([], { resolvedExecutionPolicy: "read-only", content: "looks green" }),
    );
    expect(result.ok).toBe(false);
    expect(result.content).toBe("");
    expect(result.receipt.blockReason).toBe("execution_policy_mismatch");
    expect(result.receipt.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });

  test("zero-tool regression triplet: Kimi success is independently requested and attested", async () => {
    const { root, state, receiptDir } = await fixture();
    const captured: Parameters<typeof successfulDependencies>[0] = [];
    const result = await executeModelRequest(
      state,
      request(root, receiptDir, "medium", "medium", "read-only", "none"),
      successfulDependencies(captured),
    );
    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.toolPolicy).toBe("none");
    expect(result.receipt.requested.toolPolicy).toBe("none");
    expect(result.receipt.resolved.toolPolicy).toBe("none");
  });

  test("zero-tool regression triplet: unsupported candidates skip inspection before a supported fallback", async () => {
    const { root, state, receiptDir } = await fixture();
    await writeSessionConfig(state, {
      ...(await readSessionConfig(state)),
      providerRouteStatus: { kimi: "decommissioned" },
    });
    const inspectedProviders: string[] = [];
    let executions = 0;
    const result = await executeModelRequest(
      state,
      request(root, receiptDir, "medium", "medium", "read-only", "none"),
      {
        doctor: async (_state, provider) => {
          inspectedProviders.push(provider);
          throw new Error("doctor unavailable");
        },
        execute: async () => {
          executions += 1;
          throw new Error("must not launch");
        },
      },
    );
    expect(result.ok).toBe(false);
    expect(inspectedProviders).toEqual(["claude"]);
    expect(executions).toBe(0);
    expect(result.receipt.blockReason).toBe("provider_doctor_failed");
    expect(result.receipt.routing.skipped.map(({ provider, reason }) => ({ provider, reason }))).toEqual([
      { provider: "kimi", reason: "provider_decommissioned" },
      { provider: "codex", reason: "tool_policy_unsupported" },
      { provider: "claude", reason: "provider_doctor_failed" },
    ]);
  });

  test("zero-tool regression triplet: a broader resolved surface is rejected", async () => {
    const { root, state, receiptDir } = await fixture();
    const result = await executeModelRequest(
      state,
      request(root, receiptDir, "medium", "medium", "read-only", "none"),
      successfulDependencies([], { resolvedToolPolicy: "standard", content: "unsafe success" }),
    );
    expect(result.ok).toBe(false);
    expect(result.content).toBe("");
    expect(result.receipt.blockReason).toBe("tool_policy_mismatch");
    expect(result.receipt.resolved.toolPolicy).toBe("unresolved");
  });

  test("Agy effort varies independently and receipts record the concrete native model", async () => {
    const { root, state, receiptDir } = await fixture();
    const captured: Parameters<typeof successfulDependencies>[0] = [];
    for (const effort of ["low", "medium", "high"] as const) {
      const result = await executeModelRequest(
        state,
        request(root, receiptDir, "low", effort),
        successfulDependencies(captured),
      );
      expect(result.ok).toBe(true);
      expect(result.receipt.resolved.provider).toBe("agy");
      expect(result.receipt.resolved.model).toBe(
        `Gemini 3.5 Flash (${effort[0]!.toUpperCase()}${effort.slice(1)})`,
      );
      expect(result.receipt.requested).toEqual({ modelTier: "low", effort, toolPolicy: "standard" });
    }
    expect(new Set(captured.map(({ route }) => route.provider))).toEqual(new Set(["agy"]));
  });

  test("Agy success fails closed when concrete native model evidence is missing", async () => {
    const { root, state, receiptDir } = await fixture();
    const dependencies = successfulDependencies();
    const execute = dependencies.execute!;
    dependencies.execute = async (...args) => {
      const executed = await execute(...args);
      delete executed.outcome.result.receipt;
      return executed;
    };
    const result = await executeModelRequest(
      state,
      request(root, receiptDir, "low", "high"),
      dependencies,
    );
    expect(result.ok).toBe(false);
    expect(result.receipt.blockReason).toBe("provider_receipt_malformed");
    expect(result.receipt.resolved.model).toBe("agy-fast");
  });

  test("Agy workspace-write is unsupported and never spawns low without physical authority evidence", async () => {
    const { root, state, receiptDir } = await fixture();
    const captured: Parameters<typeof successfulDependencies>[0] = [];
    const result = await executeModelRequest(
      state,
      request(root, receiptDir, "low", "high", "workspace-write"),
      successfulDependencies(captured),
    );
    expect(result.ok).toBe(false);
    expect(result.content).toBe("");
    expect(result.sessionId).toBeNull();
    expect(result.receipt.blockReason).toBe("execution_policy_unsupported");
    expect(captured).toEqual([]);
  });

  test("provider policy without native attestation blocks as unsupported", async () => {
    const { root, state, receiptDir } = await fixture();
    const result = await executeModelRequest(
      state,
      request(root, receiptDir, "max", "high", "read-only"),
      successfulDependencies([], { resolvedExecutionPolicy: null, content: "unattested success" }),
    );
    expect(result.ok).toBe(false);
    expect(result.content).toBe("");
    expect(result.receipt.blockReason).toBe("execution_policy_unsupported");
  });

  test("Claude workspace-write is an explicit unsupported capability and never spawns max", async () => {
    const { root, state, receiptDir } = await fixture();
    const captured: Parameters<typeof successfulDependencies>[0] = [];
    const result = await executeModelRequest(
      state,
      request(root, receiptDir, "max", "high", "workspace-write"),
      successfulDependencies(captured),
    );
    expect(result.ok).toBe(false);
    expect(result.content).toBe("");
    expect(result.sessionId).toBeNull();
    expect(result.receipt.blockReason).toBe("execution_policy_unsupported");
    expect(captured).toEqual([]);
  });

  test("reserves a blocked receipt before any provider turn starts", async () => {
    const { root, state, receiptDir } = await fixture();
    const input = request(root, receiptDir, "high", "high", "workspace-write");
    const result = await executeModelRequest(state, input, {
      ...successfulDependencies(),
      execute: async () => {
        const pending = JSON.parse(await Bun.file(input.receiptPath).text());
        expect(pending.outcome).toBe("blocked");
        expect(pending.blockReason).toBe("execution_pending");
        expect(pending.attempts).toEqual([
          { number: 1, outcome: "blocked", reason: "execution_pending" },
        ]);
        return {
          sessionId: "reserved-session",
          outcome: {
            resolvedExecutionPolicy: "workspace-write",
            resolvedToolPolicy: "standard",
            result: {
              content: "complete",
              role: "assistant",
              usage: { tokensIn: 2, tokensOut: 3, totalTokens: 5 },
            },
          },
        };
      },
    });
    expect(result.ok).toBe(true);
    expect(result.receipt.outcome).toBe("success");
  });

  test("reserves before provider doctor failure and publishes a stable blocked receipt", async () => {
    const { root, state, receiptDir } = await fixture();
    const input = request(root, receiptDir, "high", "low");
    const result = await executeModelRequest(state, input, {
      doctor: async () => {
        const pending = JSON.parse(await Bun.file(input.receiptPath).text());
        expect(pending.blockReason).toBe("execution_pending");
        throw new Error("provider diagnostic must not escape");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.receipt.blockReason).toBe("provider_doctor_failed");
    expect(await Bun.file(input.receiptPath).text()).not.toContain("provider diagnostic");
  });

  test("reserves before route-probe failure and publishes a stable blocked receipt", async () => {
    const { root, state, receiptDir } = await fixture();
    const input = request(root, receiptDir, "high", "medium");
    const result = await executeModelRequest(state, input, {
      doctor: async (_state, provider) => doctorResult(provider),
      candidateProbe: async () => {
        const pending = JSON.parse(await Bun.file(input.receiptPath).text());
        expect(pending.blockReason).toBe("execution_pending");
        throw new Error("route diagnostic must not escape");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.receipt.blockReason).toBe("route_probe_failed");
    expect(await Bun.file(input.receiptPath).text()).not.toContain("route diagnostic");
  });

  test("malformed usage and provider failures remain sanitized and fail closed", async () => {
    const { root, state, receiptDir } = await fixture();
    const secret = "AUTH_TOKEN_SHOULD_NOT_SURVIVE";
    const malformed = await executeModelRequest(
      state,
      request(root, receiptDir, "medium"),
      successfulDependencies([], { usage: { tokensIn: 3, tokensOut: 4, totalTokens: 99 } }),
    );
    expect(malformed.ok).toBe(false);
    expect(malformed.receipt.blockReason).toBe("usage_malformed");

    const missing = await executeModelRequest(
      state,
      request(root, receiptDir, "medium", "low"),
      successfulDependencies([], { usage: undefined }),
    );
    expect(missing.ok).toBe(false);
    expect(missing.receipt.blockReason).toBe("usage_malformed");

    const partial = await executeModelRequest(
      state,
      request(root, receiptDir, "medium", "high"),
      successfulDependencies([], { usage: { tokensIn: 3, tokensOut: 4 } }),
    );
    expect(partial.ok).toBe(false);
    expect(partial.receipt.blockReason).toBe("usage_malformed");

    const failedInput = request(root, receiptDir, "max", "high");
    const failed = await executeModelRequest(state, failedInput, {
      doctor: async (_state, provider) => doctorResult(provider),
      execute: async () => {
        throw new Error(secret);
      },
    });
    const serialized = JSON.stringify(failed.receipt);
    expect(failed.ok).toBe(false);
    expect(failed.receipt.blockReason).toBe("provider_failed");
    expect(serialized).not.toContain(secret);
    expect(await Bun.file(failedInput.receiptPath).text()).not.toContain(secret);
  });

  test("Agy never copies file/stdin-admitted prompt content into provider argv", async () => {
    const { root, state, receiptDir } = await fixture();
    let calls = 0;
    const input = { ...request(root, receiptDir, "low", "low"), promptSource: "file" as const };
    const result = await executeModelRequest(state, input, {
      ...successfulDependencies(),
      execute: async () => {
        calls += 1;
        throw new Error("must not execute");
      },
    });
    expect(calls).toBe(0);
    expect(result.ok).toBe(false);
    expect(result.content).toBe("");
    expect(result.receipt.blockReason).toBe("provider_prompt_transport_unsupported");
    expect(JSON.stringify(result.receipt)).not.toContain(input.prompt);
  });

  test("receipt path is absolute, inside the workdir, new, and identity-bound", async () => {
    const { root, state, receiptDir } = await fixture();
    const relative = request(root, receiptDir, "low");
    relative.receiptPath = "receipt.json";
    await expect(executeModelRequest(state, relative, successfulDependencies())).rejects.toThrow(
      "execution receipt path must be an absolute path",
    );

    const outside = request(root, receiptDir, "low", "low");
    outside.receiptPath = path.join(path.dirname(root), "outside-receipt.json");
    await expect(executeModelRequest(state, outside, successfulDependencies())).rejects.toThrow(
      "inside the execution workdir",
    );

    const existing = request(root, receiptDir, "low", "high");
    await writeFile(existing.receiptPath, "owner data");
    await expect(executeModelRequest(state, existing, successfulDependencies())).rejects.toThrow(
      "must be a new file",
    );
    expect(await Bun.file(existing.receiptPath).text()).toBe("owner data");

    const tampered = request(root, receiptDir, "medium", "high");
    await expect(
      executeModelRequest(state, tampered, {
        ...successfulDependencies(),
        execute: async () => {
          await writeFile(tampered.receiptPath, "external receipt tamper");
          return {
            sessionId: "must-not-land",
            outcome: {
              resolvedExecutionPolicy: "read-only",
              resolvedToolPolicy: "standard",
              result: {
                content: "must not land",
                role: "assistant",
                usage: { tokensIn: 1, tokensOut: 1, totalTokens: 2 },
              },
            },
          };
        },
      }),
    ).rejects.toThrow("execution receipt identity changed");
    expect(await Bun.file(tampered.receiptPath).text()).toBe("external receipt tamper");
  });

  test("receipt containment primary: an OS-aliased receipt stays inside the physical workdir", async () => {
    const { root, state } = await fixture();
    const aliasContainer = await mkdtemp(path.join(os.tmpdir(), "agents-receipt-alias-"));
    roots.push(aliasContainer);
    const workdirAlias = path.join(aliasContainer, "workdir");
    await symlink(root, workdirAlias, process.platform === "win32" ? "junction" : "dir");

    const aliased = request(root, path.join(workdirAlias, ".agents"), "medium");
    const accepted = await executeModelRequest(state, aliased, successfulDependencies());
    expect(accepted.ok).toBe(true);
    expect(await Bun.file(path.join(root, ".agents", path.basename(aliased.receiptPath))).exists()).toBe(true);
  });

  test("receipt containment edge: a physical receipt stays inside an OS-aliased workdir", async () => {
    const { root, state } = await fixture();
    const aliasContainer = await mkdtemp(path.join(os.tmpdir(), "agents-receipt-alias-"));
    roots.push(aliasContainer);
    const workdirAlias = path.join(aliasContainer, "workdir");
    await symlink(root, workdirAlias, process.platform === "win32" ? "junction" : "dir");

    const physical = request(workdirAlias, path.join(root, ".agents"), "medium");
    const accepted = await executeModelRequest(state, physical, successfulDependencies());
    expect(accepted.ok).toBe(true);
    expect(await Bun.file(physical.receiptPath).exists()).toBe(true);
  });

  test("receipt containment denied: a linked parent cannot escape the physical workdir", async () => {
    const { root, state } = await fixture();
    const aliasContainer = await mkdtemp(path.join(os.tmpdir(), "agents-receipt-alias-"));
    roots.push(aliasContainer);

    const outside = path.join(aliasContainer, "outside");
    await mkdir(outside);
    const linkedParent = path.join(root, "linked-receipts");
    await symlink(outside, linkedParent, process.platform === "win32" ? "junction" : "dir");
    const escaped = request(root, linkedParent, "high");
    await expect(executeModelRequest(state, escaped, successfulDependencies())).rejects.toThrow(
      "execution receipt parent is outside the execution workdir",
    );
  });

  test("provider version normalization emits the exact receipt-safe version token", () => {
    expect(receiptProviderVersion("codex-cli 0.144.1")).toBe("0.144.1");
    expect(receiptProviderVersion("2.1.203 (Claude Code)")).toBe("2.1.203");
    expect(receiptProviderVersion("0.22.2")).toBe("0.22.2");
    expect(receiptProviderVersion("codex-cli 1.2.3+build.7")).toBe("1.2.3+build.7");
    expect(receiptProviderVersion("unknown")).toBe("unresolved");
    expect(receiptProviderVersion("not-a-version")).toBe("unresolved");
    expect(receiptProviderVersion("not a version")).toBe("unresolved");
  });
});

describe("bounded prompt admission", () => {
  test("primary: a physical prompt file is read exactly without argv-shaped output", async () => {
    const { root } = await fixture();
    const promptPath = path.join(root, "review.txt");
    const prompt = "Complete review context\nwith unicode: žluťoučký";
    await writeFile(promptPath, prompt);
    expect(await readPromptFile(promptPath)).toBe(prompt);
  });

  test("edge: symlinks, empty input, NUL input, and oversized input fail closed", async () => {
    const { root } = await fixture();
    const physical = path.join(root, "physical.txt");
    const linked = path.join(root, "linked.txt");
    await writeFile(physical, "trusted");
    try {
      await symlink(physical, linked, process.platform === "win32" ? "file" : undefined);
      await expect(readPromptFile(linked)).rejects.toThrow("physical regular file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
    const physicalParent = path.join(root, "physical-prompt-parent");
    const linkedParent = path.join(root, "linked-prompt-parent");
    await mkdir(physicalParent);
    await writeFile(path.join(physicalParent, "nested.txt"), "linked parent content");
    await symlink(physicalParent, linkedParent, process.platform === "win32" ? "junction" : "dir");
    await expect(readPromptFile(path.join(linkedParent, "nested.txt"))).rejects.toThrow(
      "physical regular file",
    );
    const empty = path.join(root, "empty.txt");
    await writeFile(empty, "  \n");
    await expect(readPromptFile(empty)).rejects.toThrow("execution prompt is required");
    const nul = path.join(root, "nul.txt");
    await writeFile(nul, "safe\0unsafe");
    await expect(readPromptFile(nul)).rejects.toThrow("execution prompt is required");
    const oversized = path.join(root, "oversized.txt");
    await writeFile(oversized, Buffer.alloc(MAX_PROMPT_BYTES + 1, 0x61));
    await expect(readPromptFile(oversized)).rejects.toThrow("bounded input limit");
  });

  test("denied: stdin is bounded and never includes input content in diagnostics", async () => {
    const secret = "STDIN_SECRET_SENTINEL";
    expect(await readPromptStdin(Readable.from(["first ", "second"]))).toBe("first second");
    await expect(readPromptStdin(Readable.from([`safe\0${secret}`]))).rejects.toThrow(
      "execution prompt is required",
    );
    try {
      await readPromptStdin(Readable.from([Buffer.alloc(MAX_PROMPT_BYTES + 1, 0x62)]));
      throw new Error("expected bounded failure");
    } catch (error) {
      expect((error as Error).message).toBe("execution prompt exceeds the bounded input limit");
      expect((error as Error).message).not.toContain(secret);
    }
  });

  test("denied: a prompt-file replacement between read and final admission is rejected", async () => {
    const { root } = await fixture();
    const promptPath = path.join(root, "raced.txt");
    const replacement = path.join(root, "replacement.txt");
    await writeFile(promptPath, "admitted content");
    await writeFile(replacement, "replacement content");
    await expect(
      readPromptFile(promptPath, {
        beforeFinalVerification: async () => {
          await rm(promptPath);
          await writeFile(promptPath, await Bun.file(replacement).text());
        },
      }),
    ).rejects.toThrow("prompt file changed during admission");
  });
});
