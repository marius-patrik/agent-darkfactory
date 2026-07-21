import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import type { AdapterDoctorEvidence } from "./adapters";
import type { ProviderId } from "./provider-registry";
import {
  readSessionConfig,
  type ProviderRouteStatus,
  type SessionConfig,
  type SharedState,
} from "./state";

/**
 * Isolated route-resolution and reachability-probe seam (Andromeda #253).
 *
 * Resolves a logical model tier plus an independent effort to the canonical
 * provider/model route, and optionally runs exactly one bounded reachability
 * probe through an injected executor (consumed by DarkFactory #263). The CLI
 * exposes only read-only resolution; reachability remains an injected seam
 * until a production executor can preserve these bounds and trust invariants.
 *
 * Invariants:
 * - Tier and effort are independent; effort never alters provider, model, tier.
 * - Concrete model ids come only from canonical session configuration and are
 *   preserved exactly, never truncated or normalized; an id that fails the
 *   strict output-safe model-id contract fails closed and is never echoed.
 * - Requested tier/effort appear in output only as validated known values;
 *   invalid input becomes a stable null sentinel, never echoed caller text.
 * - Resolution is read-only and makes zero provider calls by default.
 * - A probe runs only when explicitly requested, only when the route is
 *   ready, exactly once, on disposable state, with fixed bounds. Provider
 *   output is measured for bounds but never echoed.
 * - Every failure is closed and reported through finding() with a fixed,
 *   secret-safe message: never paths, stderr, output, or control characters.
 */

export const MODEL_TIERS = ["low", "medium", "high", "max"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/** Owner tier policy (DarkFactory #24): tier -> canonical provider and agent preset. */
export interface TierRoute {
  provider: ProviderId;
  agentPreset: string;
}

export const ROUTE_POLICY_VERSION = "agent-os-tier-routes-v1";

export interface TierRouteCandidate extends TierRoute {
  /** Minimum owner capability tier supplied by this route. */
  capabilityTier: ModelTier;
}

export interface TierRoutePolicy {
  capabilityFloor: ModelTier;
  candidates: readonly TierRouteCandidate[];
}

export interface AgentRoutePolicy {
  schemaVersion: 1;
  version: string;
  tiers: Record<ModelTier, TierRoutePolicy>;
}

/**
 * Canonical ordered pre-turn policy. Medium may promote to a higher-capability
 * route, but no policy candidate may fall below its tier's capability floor.
 */
const AGENT_ROUTE_POLICY_VALUE: AgentRoutePolicy = {
  schemaVersion: 1,
  version: ROUTE_POLICY_VERSION,
  tiers: {
    low: {
      capabilityFloor: "low",
      candidates: [{ provider: "agy", agentPreset: "Agy", capabilityTier: "low" }],
    },
    medium: {
      capabilityFloor: "medium",
      candidates: [
        { provider: "kimi", agentPreset: "Kimi", capabilityTier: "medium" },
        { provider: "codex", agentPreset: "Sol", capabilityTier: "high" },
        { provider: "claude", agentPreset: "Fable", capabilityTier: "max" },
      ],
    },
    high: {
      capabilityFloor: "high",
      candidates: [
        { provider: "codex", agentPreset: "Sol", capabilityTier: "high" },
        { provider: "claude", agentPreset: "Fable", capabilityTier: "max" },
      ],
    },
    max: {
      capabilityFloor: "max",
      candidates: [{ provider: "claude", agentPreset: "Fable", capabilityTier: "max" }],
    },
  },
};
for (const tier of MODEL_TIERS) {
  const tierPolicy = AGENT_ROUTE_POLICY_VALUE.tiers[tier];
  for (const candidate of tierPolicy.candidates) Object.freeze(candidate);
  Object.freeze(tierPolicy.candidates);
  Object.freeze(tierPolicy);
}
Object.freeze(AGENT_ROUTE_POLICY_VALUE.tiers);
export const AGENT_ROUTE_POLICY: Readonly<AgentRoutePolicy> = Object.freeze(AGENT_ROUTE_POLICY_VALUE);

export const TIER_ROUTES: Readonly<Record<ModelTier, TierRoute>> = Object.freeze({
  low: AGENT_ROUTE_POLICY.tiers.low.candidates[0]!,
  medium: AGENT_ROUTE_POLICY.tiers.medium.candidates[0]!,
  high: AGENT_ROUTE_POLICY.tiers.high.candidates[0]!,
  max: AGENT_ROUTE_POLICY.tiers.max.candidates[0]!,
});

export type RouteFindingCode =
  | "unknown_tier"
  | "malformed_effort"
  | "config_unavailable"
  | "route_policy_version_mismatch"
  | "route_unavailable"
  | "registry_unavailable"
  | "model_missing"
  | "model_ambiguous"
  | "model_unsafe"
  | "provider_unpinned"
  | "provider_unverified"
  | "credential_missing"
  | "unsupported_probe_mode"
  | "probe_executor_missing"
  | "probe_auth_required"
  | "probe_unavailable"
  | "probe_timeout"
  | "probe_output_limit"
  | "probe_malformed"
  | "probe_internal";

/** Stable, sanitized finding: fixed message text, never paths or secret material. */
export interface RouteFinding {
  code: RouteFindingCode;
  message: string;
}

export interface ResolvedRoute {
  tier: ModelTier;
  provider: ProviderId;
  model: string;
  agentPreset: string;
}

export type ProbeState = "not_requested" | "skipped" | "ok" | "failed";

export type ProbeReport =
  | { state: "not_requested" | "skipped" | "failed" }
  | { state: "ok"; durationMs: number; outputBytes: number; truncated: boolean };

/** Versioned stable JSON shape; also the input to formatRouteProbeReport. */
export interface RouteProbeReport {
  schemaVersion: 1;
  ok: boolean;
  /** Validated known values only; invalid input is a stable null sentinel. */
  requested: { tier: ModelTier | null; effort: string | null };
  route: ResolvedRoute | null;
  readiness: "ready" | "unready";
  probe: ProbeReport;
  findings: RouteFinding[];
}

export type OrderedRouteSkipReason =
  | RouteFindingCode
  | "provider_disabled"
  | "provider_decommissioned"
  | "provider_unavailable"
  | "provider_quota_blocked"
  | "provider_doctor_failed"
  | "provider_version_unavailable"
  | "execution_policy_unsupported"
  | "tool_policy_unsupported"
  | "provider_prompt_transport_unsupported"
  | "route_probe_failed";

export interface OrderedRouteSkip {
  candidateIndex: number;
  provider: ProviderId;
  agentPreset: string;
  capabilityTier: ModelTier;
  reason: OrderedRouteSkipReason;
}

/** Schema-v2 CLI report for the canonical ordered pre-turn selection policy. */
export interface OrderedRouteProbeReport extends Omit<RouteProbeReport, "schemaVersion"> {
  schemaVersion: 2;
  routing: {
    policyVersion: string;
    capabilityFloor: ModelTier | null;
    selectedCandidateIndex: number | null;
    skipped: OrderedRouteSkip[];
  };
}

export type RouteProbeOutput = RouteProbeReport | OrderedRouteProbeReport;

export type OrderedRouteDoctor = (
  state: SharedState,
  provider: ProviderId,
) => Promise<AdapterDoctorEvidence>;

/** Fixed minimal probe turn: no tools, no repository content. */
export const ROUTE_PROBE_PROMPT = "Agent OS route probe. Reply with the single word: ok";

/** Fixed probe bounds; #253 requires bounded, not configurable, probes. */
export const PROBE_TIMEOUT_MS = 15_000;
/** Forced process-tree termination must acknowledge within this fixed grace. */
export const PROBE_TERMINATION_TIMEOUT_MS = 5_000;
/** The fixed prompt asks for the single word "ok"; 64 bytes is generous headroom. */
export const PROBE_MAX_OUTPUT_BYTES = 64;

/** One bounded probe turn through the canonical session boundary, supplied by the caller. */
export interface ProbeRequest {
  provider: ProviderId;
  model: string;
  effort: string;
  prompt: string;
  timeoutMs: number;
  maxOutputBytes: number;
  /** Aborted when the probe exceeds timeoutMs; executors must stop work on abort. */
  signal: AbortSignal;
  /** Disposable per-probe state root; removed after the probe. Never the canonical state. */
  stateDir: string;
}

/** Strict injected-boundary failure taxonomy; anything outside it is probe_malformed. */
export type ProbeFailureReason = "auth_required" | "unavailable" | "internal";

export type ProbeOutcome =
  | { ok: true; outputBytes: number; outputOverflow: boolean }
  | { ok: false; reason: ProbeFailureReason };

export interface ProbeExecutionHandle {
  /** Settles only after the provider process has stopped producing output or side effects. */
  result: Promise<ProbeOutcome>;
  /** Resolves only after forced termination is complete and disposable state is no longer in use. */
  terminate(): Promise<void>;
}

export interface ProbeExecutor {
  /**
   * Launch exactly one probe and synchronously return its manager-owned lifecycle handle.
   * The executor must cap output while streaming and return only bounded byte evidence;
   * raw provider output never crosses this boundary.
   */
  run(request: ProbeRequest): ProbeExecutionHandle;
}

export interface RouteProbeOptions {
  tier: string;
  effort: string;
  /** Path-free evidence produced by the canonical provider doctor. */
  providerDoctorEvidence?: AdapterDoctorEvidence | null;
  probe?: "none" | "reachability";
  probeExecutor?: ProbeExecutor;
}

export interface CandidateRouteProbeOptions extends RouteProbeOptions {
  /** Canonical policy index, never a caller-provided provider/model override. */
  candidateIndex: number;
  /** One already-validated canonical configuration snapshot for this run. */
  sessionConfig: SessionConfig;
}

type ProbeStateLifecycle = Readonly<{
  createStateDir: () => Promise<string>;
  removeStateDir: (stateDir: string) => Promise<void>;
}>;

/** Immutable production lifecycle; tests inject an isolated lifecycle per call. */
const DEFAULT_PROBE_STATE_LIFECYCLE: ProbeStateLifecycle = Object.freeze({
  createStateDir: (): Promise<string> => mkdtemp(path.join(os.tmpdir(), "agents-route-probe-")),
  removeStateDir: (stateDir: string): Promise<void> => rm(stateDir, { recursive: true, force: true }),
});

/** Strict printable output-safe effort contract; provider namespaces are not effort syntax. */
const EFFORT_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/**
 * Canonical model ids may use provider-owned slash-separated namespaces, but
 * remain bounded to 1..64 ASCII characters with safe, non-traversal segments.
 */
const MODEL_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const SEMVER_NUMERIC_IDENTIFIER = String.raw`(?:0|[1-9][0-9]*)`;
const SEMVER_PRERELEASE_IDENTIFIER = String.raw`(?:${SEMVER_NUMERIC_IDENTIFIER}|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)`;
const SEMVER_PATTERN_SOURCE = String.raw`${SEMVER_NUMERIC_IDENTIFIER}\.${SEMVER_NUMERIC_IDENTIFIER}\.${SEMVER_NUMERIC_IDENTIFIER}(?:-${SEMVER_PRERELEASE_IDENTIFIER}(?:\.${SEMVER_PRERELEASE_IDENTIFIER})*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?`;
const SAFE_PROVIDER_VERSION_PATTERN = new RegExp(`^${SEMVER_PATTERN_SOURCE}$`);
const EMBEDDED_PROVIDER_VERSION_PATTERN = new RegExp(
  `(?:^|[^0-9A-Za-z._+])(${SEMVER_PATTERN_SOURCE})(?=$|[^0-9A-Za-z._+-])`,
);
const MAX_PROVIDER_VERSION_LENGTH = 128;

/** Normalize provider-doctor version evidence through the shared route admission contract. */
export function admittedRouteProviderVersion(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length <= MAX_PROVIDER_VERSION_LENGTH && SAFE_PROVIDER_VERSION_PATTERN.test(trimmed)) {
    return trimmed;
  }
  const semver = EMBEDDED_PROVIDER_VERSION_PATTERN.exec(trimmed)?.[1] ?? null;
  return semver && semver.length <= MAX_PROVIDER_VERSION_LENGTH && SAFE_PROVIDER_VERSION_PATTERN.test(semver)
    ? semver
    : null;
}

export type RouteExecutionPolicy = "read-only" | "workspace-write";
export type RouteToolPolicy = "standard" | "none";
export type RoutePromptSource = "positional" | "file" | "stdin";
export type RouteCapabilityReason =
  | "execution_policy_unsupported"
  | "tool_policy_unsupported"
  | "provider_prompt_transport_unsupported";

/** Shared provider capability admission used by both readiness and execution. */
export function routeCandidateCapabilityReason(
  provider: ProviderId,
  executionPolicy: RouteExecutionPolicy,
  promptSource: RoutePromptSource,
  toolPolicy: RouteToolPolicy = "standard",
): RouteCapabilityReason | null {
  if (toolPolicy === "none" && provider !== "kimi" && provider !== "claude") {
    return "tool_policy_unsupported";
  }
  if ((provider === "agy" || provider === "claude") && executionPolicy === "workspace-write") {
    return "execution_policy_unsupported";
  }
  if (provider === "agy" && promptSource !== "positional") {
    return "provider_prompt_transport_unsupported";
  }
  return null;
}

export function isSafeModelId(model: string): boolean {
  if (model.length < 1 || model.length > 64) return false;
  return model
    .split("/")
    .every((segment) => segment !== "." && segment !== ".." && MODEL_SEGMENT_PATTERN.test(segment));
}

/** The single secret-safe message path: every finding text is fixed here. */
const FINDING_MESSAGES: Record<RouteFindingCode, string> = {
  unknown_tier: "unknown model tier",
  malformed_effort: "requested effort is malformed",
  config_unavailable: "canonical session config is unavailable or invalid",
  route_policy_version_mismatch: "canonical route policy version does not match session configuration",
  route_unavailable: "no policy-authorized route candidate is ready",
  registry_unavailable: "canonical provider registry is unavailable or invalid",
  model_missing: "no model is configured for the tier provider",
  model_ambiguous: "multiple models are configured for the tier provider without a canonical default",
  model_unsafe: "configured model is not output-safe",
  provider_unpinned: "tier provider has no pinned executable registration",
  provider_unverified: "tier provider pinned executable failed verification",
  credential_missing: "tier provider credential is not present",
  unsupported_probe_mode: "probe mode is not supported",
  probe_executor_missing: "reachability probe requested without a probe executor",
  probe_auth_required: "reachability probe requires provider authentication",
  probe_unavailable: "reachability probe could not reach the provider",
  probe_timeout: "reachability probe exceeded its bounded timeout",
  probe_output_limit: "reachability probe exceeded its bounded output limit",
  probe_malformed: "reachability probe returned a malformed result",
  probe_internal: "reachability probe failed internally",
};

function finding(code: RouteFindingCode): RouteFinding {
  return { code, message: FINDING_MESSAGES[code] };
}

export type ModelResolution = { model: string } | { code: "model_missing" | "model_ambiguous" };

/** Canonical model policy: a single entry, otherwise the canonical default only. */
export function resolveRouteModel(config: SessionConfig, provider: ProviderId): ModelResolution {
  const models = config.providerModels?.[provider];
  if (!models || models.length === 0) return { code: "model_missing" };
  if (models.length === 1) return { model: models[0]! };
  if (config.defaultProvider === provider && config.defaultModel && models.includes(config.defaultModel)) {
    return { model: config.defaultModel };
  }
  return { code: "model_ambiguous" };
}

type ProbeExecution =
  | { state: "ok"; durationMs: number; outputBytes: number; truncated: false; cleanupSafe: true }
  | { state: "failed"; code: RouteFindingCode; cleanupSafe: boolean };

async function terminateWithinGrace(terminate: () => Promise<void>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), PROBE_TERMINATION_TIMEOUT_MS);
  });
  const acknowledged = Promise.resolve()
    .then(terminate)
    .then(
      () => true as const,
      () => false as const,
    );
  try {
    return await Promise.race([acknowledged, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Runs the injected executor exactly once under the bounded probe contract. */
async function executeProbe(
  executor: ProbeExecutor,
  request: Omit<ProbeRequest, "signal">,
): Promise<ProbeExecution> {
  const started = Date.now();
  const controller = new AbortController();
  // The timeout is registered before the executor runs so abort-on-timeout
  // ordering is deterministic; a late executor still cannot run unbounded.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      resolve({ kind: "timeout" });
    }, request.timeoutMs);
  });
  let handle: ProbeExecutionHandle;
  try {
    handle = executor.run({ ...request, signal: controller.signal });
  } catch {
    clearTimeout(timer);
    controller.abort();
    return { state: "failed", code: "probe_internal", cleanupSafe: false };
  }
  let result: Promise<ProbeOutcome>;
  let terminate: (() => Promise<void>) | undefined;
  try {
    if (!handle || typeof handle !== "object") {
      clearTimeout(timer);
      controller.abort();
      return { state: "failed", code: "probe_malformed", cleanupSafe: false };
    }
    const candidateTerminate = handle.terminate;
    if (typeof candidateTerminate !== "function") {
      clearTimeout(timer);
      controller.abort();
      return { state: "failed", code: "probe_malformed", cleanupSafe: false };
    }
    terminate = candidateTerminate.bind(handle);
    const candidateResult = handle.result;
    if (
      !candidateResult ||
      (typeof candidateResult !== "object" && typeof candidateResult !== "function") ||
      typeof candidateResult.then !== "function"
    ) {
      clearTimeout(timer);
      controller.abort();
      return {
        state: "failed",
        code: "probe_malformed",
        cleanupSafe: await terminateWithinGrace(terminate),
      };
    }
    result = Promise.resolve(candidateResult);
  } catch {
    clearTimeout(timer);
    controller.abort();
    return {
      state: "failed",
      code: "probe_malformed",
      cleanupSafe: terminate ? await terminateWithinGrace(terminate) : false,
    };
  }
  const execution = result.then(
    (outcome) => ({ kind: "outcome" as const, outcome }),
    () => ({ kind: "error" as const }),
  );
  let raced:
    | Awaited<typeof execution>
    | Awaited<typeof timeout>;
  try {
    raced = await Promise.race([execution, timeout]);
  } finally {
    clearTimeout(timer);
  }

  if (timedOut || raced.kind === "timeout") {
    if (!(await terminateWithinGrace(terminate))) {
      return { state: "failed", code: "probe_internal", cleanupSafe: false };
    }
    return { state: "failed", code: "probe_timeout", cleanupSafe: true };
  }
  if (raced.kind === "error") return { state: "failed", code: "probe_internal", cleanupSafe: true };

  try {
    const outcome = raced.outcome;
    if (!outcome || typeof outcome !== "object" || typeof outcome.ok !== "boolean") {
      return { state: "failed", code: "probe_malformed", cleanupSafe: true };
    }
    if (outcome.ok) {
      if (
        typeof outcome.outputBytes !== "number" ||
        !Number.isSafeInteger(outcome.outputBytes) ||
        outcome.outputBytes < 0 ||
        typeof outcome.outputOverflow !== "boolean"
      ) {
        return { state: "failed", code: "probe_malformed", cleanupSafe: true };
      }
      if (outcome.outputOverflow || outcome.outputBytes > request.maxOutputBytes) {
        return { state: "failed", code: "probe_output_limit", cleanupSafe: true };
      }
      return {
        state: "ok",
        durationMs: Date.now() - started,
        outputBytes: outcome.outputBytes,
        truncated: false,
        cleanupSafe: true,
      };
    }
    switch (outcome.reason) {
      case "auth_required":
        return { state: "failed", code: "probe_auth_required", cleanupSafe: true };
      case "unavailable":
        return { state: "failed", code: "probe_unavailable", cleanupSafe: true };
      case "internal":
        return { state: "failed", code: "probe_internal", cleanupSafe: true };
      default:
        return { state: "failed", code: "probe_malformed", cleanupSafe: true };
    }
  } catch {
      return { state: "failed", code: "probe_internal", cleanupSafe: true };
  }
}

async function runRouteProbeForCandidate(
  state: SharedState,
  options: RouteProbeOptions,
  candidate: TierRoute,
  sessionConfig: SessionConfig | undefined,
  stateLifecycle: ProbeStateLifecycle = DEFAULT_PROBE_STATE_LIFECYCLE,
): Promise<RouteProbeReport> {
  const findings: RouteFinding[] = [];
  const tier = (MODEL_TIERS as readonly string[]).includes(options.tier) ? (options.tier as ModelTier) : null;
  const effort =
    typeof options.effort === "string" && EFFORT_TOKEN_PATTERN.test(options.effort) ? options.effort : null;
  const requested: RouteProbeReport["requested"] = { tier, effort };
  if (!tier) findings.push(finding("unknown_tier"));
  if (!effort) findings.push(finding("malformed_effort"));

  let route: ResolvedRoute | null = null;
  if (tier && effort) {
    const { provider, agentPreset } = candidate;

    const config = sessionConfig ?? (await readSessionConfig(state).catch(() => null));
    if (!config) {
      findings.push(finding("config_unavailable"));
    } else {
      const resolved = resolveRouteModel(config, provider);
      if ("code" in resolved) {
        findings.push(finding(resolved.code));
      } else if (!isSafeModelId(resolved.model)) {
        // Never truncate, normalize, or echo an unsafe configured model id.
        findings.push(finding("model_unsafe"));
      } else {
        route = { tier, provider, model: resolved.model, agentPreset };
      }
    }

    const evidence = options.providerDoctorEvidence;
    const evidenceValid =
      evidence?.schemaVersion === 1 &&
      evidence.provider === provider &&
      typeof evidence.pinned === "boolean" &&
      typeof evidence.executableVerified === "boolean" &&
      typeof evidence.credentialsPresent === "boolean";
    if (!evidenceValid) {
      findings.push(finding("registry_unavailable"));
    } else if (!evidence.pinned) {
      findings.push(finding("provider_unpinned"));
    } else if (!evidence.executableVerified) {
      findings.push(finding("provider_unverified"));
    } else {
      // The route seam deliberately does not inspect executable or provider-home
      // paths. Only the canonical doctor may produce this path-free evidence.
    }
    if (evidenceValid && !evidence.credentialsPresent) findings.push(finding("credential_missing"));
  }

  const readiness: RouteProbeReport["readiness"] = findings.length === 0 ? "ready" : "unready";

  let probe: ProbeReport = { state: "not_requested" };
  const mode = options.probe ?? "none";
  if (mode === "reachability") {
    if (readiness === "unready") {
      probe = { state: "skipped" };
    } else if (!options.probeExecutor) {
      findings.push(finding("probe_executor_missing"));
      probe = { state: "failed" };
    } else {
      // Readiness "ready" requires a fully resolved route and a validated
      // effort (every resolution failure pushes a finding), so both are set.
      const resolvedRoute = route!;
      const readyEffort = effort!;
      const stateResult = await Promise.resolve()
        .then(() => stateLifecycle.createStateDir())
        .then(
          (stateDir) => ({ ok: true as const, stateDir }),
          () => ({ ok: false as const }),
        );
      if (!stateResult.ok) {
        findings.push(finding("probe_internal"));
        probe = { state: "failed" };
      } else {
        let cleanupSafe = false;
        try {
          try {
            const result = await executeProbe(options.probeExecutor, {
              provider: resolvedRoute.provider,
              model: resolvedRoute.model,
              effort: readyEffort,
              prompt: ROUTE_PROBE_PROMPT,
              timeoutMs: PROBE_TIMEOUT_MS,
              maxOutputBytes: PROBE_MAX_OUTPUT_BYTES,
              stateDir: stateResult.stateDir,
            });
            cleanupSafe = result.cleanupSafe;
            if (result.state === "ok") {
              probe = {
                state: "ok",
                durationMs: result.durationMs,
                outputBytes: result.outputBytes,
                truncated: result.truncated,
              };
            } else {
              findings.push(finding(result.code));
              probe = { state: "failed" };
            }
          } catch {
            findings.push(finding("probe_internal"));
            probe = { state: "failed" };
          }
        } finally {
          if (cleanupSafe) {
            try {
              await stateLifecycle.removeStateDir(stateResult.stateDir);
            } catch {
              findings.push(finding("probe_internal"));
              probe = { state: "failed" };
            }
          }
        }
      }
    }
  } else if (mode !== "none") {
    findings.push(finding("unsupported_probe_mode"));
    probe = { state: "failed" };
  }

  return {
    schemaVersion: 1,
    ok: findings.length === 0 && (probe.state === "not_requested" || probe.state === "ok"),
    requested,
    route,
    readiness,
    probe,
    findings,
  };
}

export async function runRouteProbe(
  state: SharedState,
  options: RouteProbeOptions,
  stateLifecycle: ProbeStateLifecycle = DEFAULT_PROBE_STATE_LIFECYCLE,
): Promise<RouteProbeReport> {
  const tier = (MODEL_TIERS as readonly string[]).includes(options.tier)
    ? (options.tier as ModelTier)
    : null;
  const candidate = tier ? TIER_ROUTES[tier] : TIER_ROUTES.medium;
  return runRouteProbeForCandidate(state, options, candidate, undefined, stateLifecycle);
}

/**
 * Resolve one candidate selected by the canonical ordered policy. The caller
 * supplies only its index and an already-admitted config snapshot; arbitrary
 * provider/model overrides are not representable.
 */
export async function runCandidateRouteProbe(
  state: SharedState,
  options: CandidateRouteProbeOptions,
  stateLifecycle: ProbeStateLifecycle = DEFAULT_PROBE_STATE_LIFECYCLE,
): Promise<RouteProbeReport> {
  const tier = (MODEL_TIERS as readonly string[]).includes(options.tier)
    ? (options.tier as ModelTier)
    : null;
  if (!tier || !Number.isSafeInteger(options.candidateIndex) || options.candidateIndex < 0) {
    throw new Error("invalid canonical route candidate");
  }
  const candidate = AGENT_ROUTE_POLICY.tiers[tier].candidates[options.candidateIndex];
  if (!candidate) throw new Error("invalid canonical route candidate");
  const { candidateIndex: _candidateIndex, sessionConfig, ...probeOptions } = options;
  return runRouteProbeForCandidate(state, probeOptions, candidate, sessionConfig, stateLifecycle);
}

export type OrderedRouteProbeOptions = Omit<RouteProbeOptions, "providerDoctorEvidence">;

function providerRouteSkipReason(status: ProviderRouteStatus | undefined): OrderedRouteSkipReason | null {
  switch (status) {
    case undefined:
    case "enabled":
      return null;
    case "disabled":
      return "provider_disabled";
    case "decommissioned":
      return "provider_decommissioned";
    case "unavailable":
      return "provider_unavailable";
    case "quota-blocked":
      return "provider_quota_blocked";
  }
}

function orderedReport(
  report: RouteProbeReport,
  capabilityFloor: ModelTier | null,
  selectedCandidateIndex: number | null,
  skipped: OrderedRouteSkip[],
): OrderedRouteProbeReport {
  return {
    ...report,
    schemaVersion: 2,
    routing: {
      policyVersion: ROUTE_POLICY_VERSION,
      capabilityFloor,
      selectedCandidateIndex,
      skipped,
    },
  };
}

function unavailableOrderedReport(
  tier: ModelTier,
  effort: string,
  skipped: OrderedRouteSkip[],
  code: "config_unavailable" | "route_policy_version_mismatch" | "route_unavailable",
  probeMode: OrderedRouteProbeOptions["probe"],
): OrderedRouteProbeReport {
  return orderedReport(
    {
      schemaVersion: 1,
      ok: false,
      requested: { tier, effort },
      route: null,
      readiness: "unready",
      probe: { state: probeMode === "reachability" ? "skipped" : "not_requested" },
      findings: [finding(code)],
    },
    AGENT_ROUTE_POLICY.tiers[tier].capabilityFloor,
    null,
    skipped,
  );
}

/**
 * Resolve the complete canonical candidate order used by `andromeda route probe`.
 * Explicitly disabled/decommissioned providers are skipped from config alone,
 * before their doctor (and therefore their provider home) can be touched.
 */
export async function runOrderedRouteProbe(
  state: SharedState,
  options: OrderedRouteProbeOptions,
  doctor: OrderedRouteDoctor,
  stateLifecycle: ProbeStateLifecycle = DEFAULT_PROBE_STATE_LIFECYCLE,
): Promise<OrderedRouteProbeReport> {
  const tier = (MODEL_TIERS as readonly string[]).includes(options.tier)
    ? (options.tier as ModelTier)
    : null;
  const effort =
    typeof options.effort === "string" && EFFORT_TOKEN_PATTERN.test(options.effort)
      ? options.effort
      : null;
  if (!tier || !effort) {
    const primary = tier ? TIER_ROUTES[tier] : TIER_ROUTES.medium;
    const report = await runRouteProbeForCandidate(state, options, primary, undefined, stateLifecycle);
    return orderedReport(report, tier ? AGENT_ROUTE_POLICY.tiers[tier].capabilityFloor : null, null, []);
  }

  let config: SessionConfig;
  const policy = AGENT_ROUTE_POLICY.tiers[tier];
  try {
    config = await readSessionConfig(state);
  } catch {
    const skipped = policy.candidates.map((candidate, candidateIndex) => ({
      candidateIndex,
      provider: candidate.provider,
      agentPreset: candidate.agentPreset,
      capabilityTier: candidate.capabilityTier,
      reason: "config_unavailable" as const,
    }));
    return unavailableOrderedReport(tier, effort, skipped, "config_unavailable", options.probe);
  }
  if (config.routePolicyVersion && config.routePolicyVersion !== ROUTE_POLICY_VERSION) {
    const skipped = policy.candidates.map((candidate, candidateIndex) => ({
      candidateIndex,
      provider: candidate.provider,
      agentPreset: candidate.agentPreset,
      capabilityTier: candidate.capabilityTier,
      reason: "route_policy_version_mismatch" as const,
    }));
    return unavailableOrderedReport(
      tier,
      effort,
      skipped,
      "route_policy_version_mismatch",
      options.probe,
    );
  }

  const skipped: OrderedRouteSkip[] = [];
  for (let candidateIndex = 0; candidateIndex < policy.candidates.length; candidateIndex += 1) {
    const candidate = policy.candidates[candidateIndex]!;
    const statusReason = providerRouteSkipReason(config.providerRouteStatus?.[candidate.provider]);
    if (statusReason) {
      skipped.push({
        candidateIndex,
        provider: candidate.provider,
        agentPreset: candidate.agentPreset,
        capabilityTier: candidate.capabilityTier,
        reason: statusReason,
      });
      continue;
    }

    let evidence: AdapterDoctorEvidence;
    try {
      evidence = await doctor(state, candidate.provider);
    } catch {
      skipped.push({
        candidateIndex,
        provider: candidate.provider,
        agentPreset: candidate.agentPreset,
        capabilityTier: candidate.capabilityTier,
        reason: "provider_doctor_failed",
      });
      continue;
    }

    let admissionReport: RouteProbeReport;
    try {
      admissionReport = await runRouteProbeForCandidate(
        state,
        { ...options, providerDoctorEvidence: evidence, probe: "none" },
        candidate,
        config,
        stateLifecycle,
      );
    } catch {
      skipped.push({
        candidateIndex,
        provider: candidate.provider,
        agentPreset: candidate.agentPreset,
        capabilityTier: candidate.capabilityTier,
        reason: "route_probe_failed",
      });
      continue;
    }
    if (admissionReport.readiness !== "ready" || !admissionReport.route) {
      skipped.push({
        candidateIndex,
        provider: candidate.provider,
        agentPreset: candidate.agentPreset,
        capabilityTier: candidate.capabilityTier,
        reason: admissionReport.findings[0]?.code ?? "route_probe_failed",
      });
      continue;
    }
    if (admittedRouteProviderVersion(evidence.providerVersion) === null) {
      skipped.push({
        candidateIndex,
        provider: candidate.provider,
        agentPreset: candidate.agentPreset,
        capabilityTier: candidate.capabilityTier,
        reason: "provider_version_unavailable",
      });
      continue;
    }
    const capabilityReason = routeCandidateCapabilityReason(candidate.provider, "read-only", "positional");
    if (capabilityReason) {
      skipped.push({
        candidateIndex,
        provider: candidate.provider,
        agentPreset: candidate.agentPreset,
        capabilityTier: candidate.capabilityTier,
        reason: capabilityReason,
      });
      continue;
    }

    // Only the admitted candidate may start a bounded reachability probe. A
    // failure after that start is terminal and never retries another provider.
    if (options.probe && options.probe !== "none") {
      try {
        const report = await runRouteProbeForCandidate(
          state,
          { ...options, providerDoctorEvidence: evidence },
          candidate,
          config,
          stateLifecycle,
        );
        return orderedReport(report, policy.capabilityFloor, candidateIndex, skipped);
      } catch {
        return orderedReport(
          {
            ...admissionReport,
            ok: false,
            probe: { state: "failed" },
            findings: [...admissionReport.findings, finding("probe_internal")],
          },
          policy.capabilityFloor,
          candidateIndex,
          skipped,
        );
      }
    }
    return orderedReport(admissionReport, policy.capabilityFloor, candidateIndex, skipped);
  }

  return unavailableOrderedReport(tier, effort, skipped, "route_unavailable", options.probe);
}

/** Concise, secret-safe human rendering of a route probe report. */
export function formatRouteProbeReport(report: RouteProbeOutput): string {
  const lines: string[] = [];
  lines.push(`route probe ${report.ok ? "ok" : "FAILED"}`);
  lines.push(
    `requested tier=${report.requested.tier ?? "<invalid>"} effort=${report.requested.effort ?? "<invalid>"}`,
  );
  if (report.route) {
    lines.push(
      `route provider=${report.route.provider} model=${report.route.model} preset=${report.route.agentPreset}`,
    );
  } else {
    lines.push("route <unresolved>");
  }
  lines.push(`readiness ${report.readiness}`);
  switch (report.probe.state) {
    case "not_requested":
      lines.push("probe not requested");
      break;
    case "skipped":
      lines.push("probe skipped (route unready)");
      break;
    case "ok":
      lines.push(
        `probe ok (${report.probe.durationMs}ms, ${report.probe.outputBytes} bytes${
          report.probe.truncated ? ", truncated" : ""
        })`,
      );
      break;
    case "failed":
      lines.push("probe failed");
      break;
  }
  for (const finding of report.findings) {
    lines.push(`fail ${finding.code} ${finding.message}`);
  }
  if (report.schemaVersion === 2) {
    lines.push(
      `policy ${report.routing.policyVersion} selected=${report.routing.selectedCandidateIndex ?? "none"}`,
    );
    for (const skipped of report.routing.skipped) {
      lines.push(`skip ${skipped.provider}/${skipped.agentPreset} ${skipped.reason}`);
    }
  }
  return lines.join("\n");
}
