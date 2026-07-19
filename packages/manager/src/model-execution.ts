import path from "node:path";
import os from "node:os";
import { open, lstat, mkdtemp, realpath, rm, type FileHandle } from "node:fs/promises";
import type { Readable } from "node:stream";
import {
  createSession,
  runSessionTurn,
  type SessionMode,
  type TurnResult,
} from "../../harness/session";
import { doctorAdapter, type AdapterDoctorResult } from "./adapters";
import { providerSessionAdapter } from "./session-adapters";
import type { ProviderId } from "./provider-registry";
import {
  AGENT_ROUTE_POLICY,
  MODEL_TIERS,
  ROUTE_POLICY_VERSION,
  admittedRouteProviderVersion,
  isSafeModelId,
  routeCandidateCapabilityReason,
  runCandidateRouteProbe,
  resolveRouteModel,
  type AgentRoutePolicy,
  type ModelTier,
  type ResolvedRoute,
  type RouteFindingCode,
  type TierRouteCandidate,
} from "./route-probe";
import {
  readSessionConfig,
  type ProviderRouteStatus,
  type SessionConfig,
  type SharedState,
} from "./state";
import { orchestratorSystemPrompt, startOrchestratorHeartbeat } from "./orchestrator";
import {
  runAnchoredFileAuthority,
  type AnchoredFileProof,
} from "./anchored-file-authority";

/**
 * Canonical model execution boundary for DarkFactory #24/#36.
 *
 * Invariants:
 * - A logical tier and independent effort resolve only through the canonical
 *   ordered route policy plus provider-doctor evidence. DarkFactory never
 *   supplies a provider, concrete model, executable, registry, or fallback.
 *   Candidate selection ends before the one admitted turn starts; a turn
 *   failure never retries another provider.
 * - Exactly one bounded prompt source is admitted. Prompt text is never placed
 *   in an Agent OS receipt or error and file-backed input is verified through
 *   one pinned handle before use.
 * - The absolute receipt path is reserved through the manager's physical-root
 *   authority with an identity/content-bound blocked receipt before a provider
 *   turn can start. A crash therefore leaves durable fail-closed evidence
 *   rather than an unreceipted mutation.
 * - Filesystem write policy and model tool policy are independent. A provider
 *   result is accepted only when both resolved policies equal the request.
 *   Zero-tool turns also suppress canonical startup context and repository
 *   discovery through a fresh disposable workdir.
 */

export const MODEL_EFFORTS = ["low", "medium", "high"] as const;
export type ModelEffort = (typeof MODEL_EFFORTS)[number];

export const EXECUTION_POLICIES = ["read-only", "workspace-write"] as const;
export type ExecutionPolicy = (typeof EXECUTION_POLICIES)[number];

export const TOOL_POLICIES = ["standard", "none"] as const;
export type ToolPolicy = (typeof TOOL_POLICIES)[number];

export const MAX_PROMPT_BYTES = 8 * 1024 * 1024;

const SAFE_RECEIPT_VALUE = /^[A-Za-z0-9][A-Za-z0-9_.\/-]{0,127}$/;
const SAFE_RECEIPT_MODEL = /^[A-Za-z0-9][A-Za-z0-9_.\/() -]{0,127}$/;
const SAFE_BLOCK_REASON = /^[a-z][a-z0-9_-]{0,63}$/;

export interface AgentExecutionReceipt {
  schemaVersion: 3;
  requested: {
    modelTier: ModelTier;
    effort: ModelEffort;
    toolPolicy: ToolPolicy;
  };
  routing: {
    policyVersion: string;
    primary: ReceiptRouteCandidate;
    skipped: Array<ReceiptRouteCandidate & { reason: string }>;
  };
  resolved: {
    provider: string;
    model: string;
    agentPreset: string;
    providerVersion: string;
    toolPolicy: ToolPolicy | "unresolved";
  };
  attempts: Array<{
    number: number;
    outcome: "success" | "blocked" | "retryable";
    reason: string | null;
  }>;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  outcome: "success" | "blocked";
  blockReason: string | null;
}

export interface ReceiptRouteCandidate {
  provider: string;
  model: string;
  agentPreset: string;
  providerVersion: string;
}

export interface ModelExecutionRequest {
  modelTier: string;
  effort: string;
  executionPolicy: string;
  toolPolicy: string;
  receiptPath: string;
  workdir: string;
  mode: SessionMode;
  prompt: string;
  promptSource: "positional" | "file" | "stdin";
  systemPrompt?: string;
}

export interface ModelExecutionResult {
  ok: boolean;
  content: string;
  sessionId: string | null;
  receipt: AgentExecutionReceipt;
}

export interface ManagedProviderOutcome {
  result: TurnResult;
  /** Provider-attested effective policy, never inferred by DarkFactory. */
  resolvedExecutionPolicy: ExecutionPolicy | null;
  /** Provider-attested effective tool policy, never inferred by DarkFactory. */
  resolvedToolPolicy: ToolPolicy | null;
}

export interface ModelExecutionDependencies {
  doctor?: (state: SharedState, provider: ProviderId) => Promise<AdapterDoctorResult>;
  candidateProbe?: typeof runCandidateRouteProbe;
  readConfig?: (state: SharedState) => Promise<SessionConfig>;
  /** Internal trust-test seam. Only the exact canonical policy is admitted. */
  routePolicy?: unknown;
  execute?: (
    state: SharedState,
    route: ResolvedRoute,
    doctor: AdapterDoctorResult,
    request: Readonly<{
      prompt: string;
      systemPrompt?: string;
      mode: SessionMode;
      workdir: string;
      effort: ModelEffort;
      executionPolicy: ExecutionPolicy;
      toolPolicy: ToolPolicy;
    }>,
  ) => Promise<{ outcome: ManagedProviderOutcome; sessionId: string }>;
}

type RoutePolicyFailure =
  | "route_policy_malformed"
  | "route_policy_candidate_unknown"
  | "route_policy_version_mismatch"
  | "route_policy_capability_downgrade"
  | "route_policy_drift";

const CAPABILITY_RANK: Record<ModelTier, number> = {
  low: 0,
  medium: 1,
  high: 2,
  max: 3,
};

const PROVIDERS = new Set<ProviderId>(["agy", "kimi", "codex", "claude"]);
const SAFE_AGENT_PRESET = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

function validateRoutePolicy(
  value: unknown,
): { ok: true; policy: AgentRoutePolicy } | { ok: false; reason: RoutePolicyFailure } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "route_policy_malformed" };
  }
  const policy = value as Partial<AgentRoutePolicy>;
  if (policy.version !== ROUTE_POLICY_VERSION) {
    return { ok: false, reason: "route_policy_version_mismatch" };
  }
  if (policy.schemaVersion !== 1 || !policy.tiers || typeof policy.tiers !== "object") {
    return { ok: false, reason: "route_policy_malformed" };
  }
  for (const tier of MODEL_TIERS) {
    const tierPolicy = policy.tiers[tier];
    if (
      !tierPolicy ||
      !(MODEL_TIERS as readonly string[]).includes(tierPolicy.capabilityFloor) ||
      !Array.isArray(tierPolicy.candidates) ||
      tierPolicy.candidates.length === 0
    ) {
      return { ok: false, reason: "route_policy_malformed" };
    }
    for (const candidate of tierPolicy.candidates) {
      if (!candidate || typeof candidate !== "object" || !PROVIDERS.has(candidate.provider as ProviderId)) {
        return { ok: false, reason: "route_policy_candidate_unknown" };
      }
      if (
        !SAFE_AGENT_PRESET.test(candidate.agentPreset) ||
        !(MODEL_TIERS as readonly string[]).includes(candidate.capabilityTier)
      ) {
        return { ok: false, reason: "route_policy_malformed" };
      }
      const capabilityTier = candidate.capabilityTier as ModelTier;
      const capabilityFloor = tierPolicy.capabilityFloor as ModelTier;
      if (CAPABILITY_RANK[capabilityTier] < CAPABILITY_RANK[capabilityFloor]) {
        return { ok: false, reason: "route_policy_capability_downgrade" };
      }
    }
  }
  try {
    if (JSON.stringify(policy) !== JSON.stringify(AGENT_ROUTE_POLICY)) {
      return { ok: false, reason: "route_policy_drift" };
    }
  } catch {
    return { ok: false, reason: "route_policy_malformed" };
  }
  return { ok: true, policy: policy as AgentRoutePolicy };
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

function fileIdentity(info: Awaited<ReturnType<FileHandle["stat"]>>): FileIdentity {
  const value = info as unknown as {
    dev: bigint;
    ino: bigint;
    size: bigint;
    mtimeNs: bigint;
  };
  return { dev: value.dev, ino: value.ino, size: value.size, mtimeNs: value.mtimeNs };
}

function containsPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function requiredAbsolutePath(value: string, label: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw new Error(`${label} must be an absolute path`);
  }
  return path.resolve(value);
}

function validateTier(value: string): ModelTier {
  if (!(MODEL_TIERS as readonly string[]).includes(value)) throw new Error("unknown model tier");
  return value as ModelTier;
}

function validateEffort(value: string): ModelEffort {
  if (!(MODEL_EFFORTS as readonly string[]).includes(value)) throw new Error("unsupported model effort");
  return value as ModelEffort;
}

function validateExecutionPolicy(value: string): ExecutionPolicy {
  if (!(EXECUTION_POLICIES as readonly string[]).includes(value)) {
    throw new Error("unsupported execution policy");
  }
  return value as ExecutionPolicy;
}

function validateToolPolicy(value: string): ToolPolicy {
  if (!(TOOL_POLICIES as readonly string[]).includes(value)) {
    throw new Error("unsupported tool policy");
  }
  return value as ToolPolicy;
}

function outputSafe(value: string, fallback = "unresolved"): string {
  if (SAFE_RECEIPT_VALUE.test(value)) return value;
  return fallback;
}

/** Provider registry versions may include product names; receipts carry the exact semver token. */
export function receiptProviderVersion(value: string | null | undefined): string {
  return admittedRouteProviderVersion(value) ?? "unresolved";
}

function zeroUsage(): AgentExecutionReceipt["usage"] {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

function normalizedUsage(usage: TurnResult["usage"]): AgentExecutionReceipt["usage"] | null {
  if (
    !usage ||
    usage.tokensIn === undefined ||
    usage.tokensOut === undefined ||
    usage.totalTokens === undefined
  ) {
    return null;
  }
  const inputTokens = usage.tokensIn;
  const outputTokens = usage.tokensOut;
  if (
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 ||
    !Number.isSafeInteger(outputTokens) ||
    outputTokens < 0
  ) {
    return null;
  }
  const totalTokens = inputTokens + outputTokens;
  if (!Number.isSafeInteger(totalTokens)) return null;
  if (!Number.isSafeInteger(usage.totalTokens) || usage.totalTokens !== totalTokens) return null;
  return { inputTokens, outputTokens, totalTokens };
}

function providerResolvedModel(
  route: ResolvedRoute,
  effort: ModelEffort,
  receipt: TurnResult["receipt"],
): string | null {
  if (route.provider !== "agy") return route.model;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return null;
  const keys = Object.keys(receipt).sort();
  const expected = ["agentPreset", "concreteModel", "effort", "provider", "requestedModel"];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    receipt.provider !== "agy" ||
    receipt.requestedModel !== route.model ||
    receipt.effort !== effort ||
    receipt.agentPreset !== null ||
    typeof receipt.concreteModel !== "string" ||
    !SAFE_RECEIPT_MODEL.test(receipt.concreteModel)
  ) {
    return null;
  }
  return receipt.concreteModel;
}

function resolvedReceipt(
  route: ResolvedRoute | null,
  providerVersion: string | null | undefined,
  toolPolicy: ToolPolicy | null,
  providerModel?: string,
): AgentExecutionReceipt["resolved"] {
  const model = providerModel ?? route?.model ?? "unresolved";
  return {
    provider: outputSafe(route?.provider ?? "unresolved"),
    model: SAFE_RECEIPT_MODEL.test(model) ? model : "unresolved",
    agentPreset: outputSafe(route?.agentPreset ?? "unresolved"),
    providerVersion: receiptProviderVersion(providerVersion),
    toolPolicy: toolPolicy ?? "unresolved",
  };
}

function receiptCandidate(
  candidate: TierRouteCandidate,
  config?: SessionConfig,
  route?: ResolvedRoute | null,
  providerVersion?: string | null,
): ReceiptRouteCandidate {
  const configured = config ? resolveRouteModel(config, candidate.provider) : null;
  const configuredModel = configured && "model" in configured ? configured.model : "unresolved";
  const model = route?.model ?? configuredModel;
  return {
    provider: outputSafe(candidate.provider),
    model: isSafeModelId(model) ? model : "unresolved",
    agentPreset: outputSafe(candidate.agentPreset),
    providerVersion: receiptProviderVersion(providerVersion),
  };
}

function initialRouting(
  tier: ModelTier,
  policy: AgentRoutePolicy = AGENT_ROUTE_POLICY,
  config?: SessionConfig,
): AgentExecutionReceipt["routing"] {
  return {
    policyVersion: ROUTE_POLICY_VERSION,
    primary: receiptCandidate(policy.tiers[tier].candidates[0]!, config),
    skipped: [],
  };
}

function routingSnapshot(
  routing: AgentExecutionReceipt["routing"],
): AgentExecutionReceipt["routing"] {
  return {
    policyVersion: routing.policyVersion,
    primary: { ...routing.primary },
    skipped: routing.skipped.map((candidate) => ({ ...candidate })),
  };
}

function blockedReceipt(
  tier: ModelTier,
  effort: ModelEffort,
  toolPolicy: ToolPolicy,
  route: ResolvedRoute | null,
  providerVersion: string | null | undefined,
  routing: AgentExecutionReceipt["routing"],
  reason: string,
): AgentExecutionReceipt {
  const blockReason = SAFE_BLOCK_REASON.test(reason) ? reason : "execution_blocked";
  return {
    schemaVersion: 3,
    requested: { modelTier: tier, effort, toolPolicy },
    routing: routingSnapshot(routing),
    resolved: resolvedReceipt(route, providerVersion, null),
    attempts: [{ number: 1, outcome: "blocked", reason: blockReason }],
    usage: zeroUsage(),
    outcome: "blocked",
    blockReason,
  };
}

function successReceipt(
  tier: ModelTier,
  effort: ModelEffort,
  toolPolicy: ToolPolicy,
  route: ResolvedRoute,
  providerVersion: string,
  routing: AgentExecutionReceipt["routing"],
  usage: AgentExecutionReceipt["usage"],
  providerModel: string,
): AgentExecutionReceipt {
  return {
    schemaVersion: 3,
    requested: { modelTier: tier, effort, toolPolicy },
    routing: routingSnapshot(routing),
    resolved: resolvedReceipt(route, providerVersion, toolPolicy, providerModel),
    attempts: [{ number: 1, outcome: "success", reason: null }],
    usage,
    outcome: "success",
    blockReason: null,
  };
}

function receiptText(receipt: AgentExecutionReceipt): string {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

class ReceiptReservation {
  private closed = false;

  private constructor(
    private readonly root: string,
    private readonly publicationRoot: string,
    private readonly components: readonly string[],
    private proof: AnchoredFileProof,
  ) {}

  static async create(
    receiptPath: string,
    workdir: string,
    publicationRoot: string,
    pending: AgentExecutionReceipt,
  ): Promise<ReceiptReservation> {
    const requestedWorkdir = requiredAbsolutePath(workdir, "execution workdir");
    const canonicalWorkdir = await realpath(requestedWorkdir).catch(() => null);
    if (!canonicalWorkdir) throw new Error("execution workdir is unavailable");
    const canonicalPublicationRoot = await realpath(publicationRoot).catch(() => null);
    if (!canonicalPublicationRoot) {
      throw new Error("execution receipt publication state is unavailable");
    }
    const target = requiredAbsolutePath(receiptPath, "execution receipt path");
    const lexicallyInside = containsPath(requestedWorkdir, target) && target !== requestedWorkdir;
    const parent = path.dirname(target);
    const physicalParent = await realpath(parent).catch(() => null);
    if (!physicalParent || !containsPath(canonicalWorkdir, physicalParent)) {
      // Preserve the caller-facing distinction between an ordinary outside
      // path and a lexically inside parent that escapes through a link. A
      // lexical mismatch alone is not a denial: Windows 8.3 names and other
      // OS aliases may identify the same physical worktree.
      if (!lexicallyInside) throw new Error("execution receipt path must be inside the execution workdir");
      throw new Error("execution receipt parent is outside the execution workdir");
    }
    const parentInfo = await lstat(parent).catch(() => null);
    if (!parentInfo?.isDirectory() || parentInfo.isSymbolicLink()) {
      throw new Error("execution receipt parent must be a physical directory");
    }

    const relativeParent = path.relative(canonicalWorkdir, physicalParent);
    const components = [
      ...(relativeParent ? relativeParent.split(path.sep) : []),
      path.basename(target),
    ];
    let proof: AnchoredFileProof;
    try {
      proof = await runAnchoredFileAuthority({
        operation: "create",
        root: canonicalWorkdir,
        publicationRoot: canonicalPublicationRoot,
        components,
        content: Buffer.from(receiptText(pending), "utf8"),
      });
    } catch {
      throw new Error("execution receipt path must be a new file");
    }
    return new ReceiptReservation(
      canonicalWorkdir,
      canonicalPublicationRoot,
      components,
      proof,
    );
  }

  async commit(receipt: AgentExecutionReceipt): Promise<void> {
    if (this.closed) throw new Error("execution receipt reservation is closed");
    try {
      this.proof = await runAnchoredFileAuthority({
        operation: "publish",
        root: this.root,
        publicationRoot: this.publicationRoot,
        components: this.components,
        content: Buffer.from(receiptText(receipt), "utf8"),
        expected: this.proof,
      });
    } catch {
      throw new Error("execution receipt identity changed");
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await runAnchoredFileAuthority({
        operation: "verify",
        root: this.root,
        components: this.components,
        expected: this.proof,
      });
    } catch {
      throw new Error("execution receipt identity changed");
    }
  }
}

async function defaultExecute(
  state: SharedState,
  route: ResolvedRoute,
  doctor: AdapterDoctorResult,
  request: Readonly<{
    prompt: string;
    systemPrompt?: string;
    mode: SessionMode;
    workdir: string;
    effort: ModelEffort;
    executionPolicy: ExecutionPolicy;
    toolPolicy: ToolPolicy;
  }>,
): Promise<{ outcome: ManagedProviderOutcome; sessionId: string }> {
  if (!doctor.binary) throw new Error("canonical provider is unavailable");
  // A zero-tool turn is also read-isolated from repository-local instruction
  // discovery. The full admitted snapshot is already in the bounded prompt,
  // so providers run from a fresh empty physical directory that is removed
  // after the one non-continuable turn.
  const isolationRoot = request.toolPolicy === "none"
    ? await mkdtemp(path.join(os.tmpdir(), "agents-read-isolated-"))
    : null;
  let heartbeat: Awaited<ReturnType<typeof startOrchestratorHeartbeat>> | null = null;
  try {
    const descriptor = await createSession(state, {
      provider: route.provider,
      model: route.model,
      mode: request.mode,
      workdir: isolationRoot ?? request.workdir,
    });
    heartbeat = request.mode === "orchestrator"
      ? await startOrchestratorHeartbeat(state, descriptor.sessionId, {
          provider: descriptor.provider,
          model: descriptor.model,
        })
      : null;
    const adapter = providerSessionAdapter(route.provider, doctor.binary);
    const result = await runSessionTurn(state, adapter, descriptor, {
      prompt: request.prompt,
      systemPrompt:
        request.systemPrompt ?? (request.mode === "orchestrator" ? orchestratorSystemPrompt() : undefined),
      effort: request.effort,
      executionPolicy: request.executionPolicy,
      toolPolicy: request.toolPolicy,
      agentPreset: route.agentPreset,
    });
    heartbeat?.assertHealthy();
    return {
      sessionId: descriptor.sessionId,
      outcome: {
        result,
        resolvedExecutionPolicy: result.resolvedExecutionPolicy ?? null,
        resolvedToolPolicy: result.resolvedToolPolicy ?? null,
      },
    };
  } finally {
    await heartbeat?.stop();
    if (isolationRoot) await rm(isolationRoot, { recursive: true, force: true });
  }
}

function firstRouteFailure(findings: Array<{ code: RouteFindingCode }>): string {
  return findings[0]?.code ?? "route_unavailable";
}

function providerStatusReason(status: ProviderRouteStatus | undefined): string | null {
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

/** Execute one canonical tier request and always publish exact fail-closed receipt evidence. */
export async function executeModelRequest(
  state: SharedState,
  input: ModelExecutionRequest,
  dependencies: ModelExecutionDependencies = {},
): Promise<ModelExecutionResult> {
  const tier = validateTier(input.modelTier);
  const effort = validateEffort(input.effort);
  const executionPolicy = validateExecutionPolicy(input.executionPolicy);
  const toolPolicy = validateToolPolicy(input.toolPolicy);
  const workdir = requiredAbsolutePath(input.workdir, "execution workdir");
  if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.includes("\0")) {
    throw new Error("execution prompt is required");
  }
  if (Buffer.byteLength(input.prompt, "utf8") > MAX_PROMPT_BYTES) {
    throw new Error("execution prompt exceeds the bounded input limit");
  }

  const pendingRouting = initialRouting(tier);
  const pending = blockedReceipt(tier, effort, toolPolicy, null, null, pendingRouting, "execution_pending");
  const reservation = await ReceiptReservation.create(
    input.receiptPath,
    workdir,
    state.sessionsDir,
    pending,
  );
  let finalReceipt = pending;
  let sessionId: string | null = null;
  let content = "";
  let routing = pendingRouting;
  try {
    const publishBlocked = async (
      reason: string,
      route: ResolvedRoute | null = null,
      providerVersion: string | null | undefined = null,
    ): Promise<ModelExecutionResult> => {
      finalReceipt = blockedReceipt(tier, effort, toolPolicy, route, providerVersion, routing, reason);
      await reservation.commit(finalReceipt);
      return { ok: false, content, sessionId, receipt: finalReceipt };
    };

    const policyInput = Object.prototype.hasOwnProperty.call(dependencies, "routePolicy")
      ? dependencies.routePolicy
      : AGENT_ROUTE_POLICY;
    let policyResult: ReturnType<typeof validateRoutePolicy>;
    try {
      policyResult = validateRoutePolicy(policyInput);
    } catch {
      return await publishBlocked("route_policy_malformed");
    }
    if (!policyResult.ok) return await publishBlocked(policyResult.reason);
    const policy = policyResult.policy;

    let config: SessionConfig;
    try {
      config = await (dependencies.readConfig ?? readSessionConfig)(state);
    } catch {
      routing = initialRouting(tier, policy);
      for (const candidate of policy.tiers[tier].candidates) {
        routing.skipped.push({
          ...receiptCandidate(candidate),
          reason: "config_unavailable",
        });
      }
      return await publishBlocked("config_unavailable");
    }
    routing = initialRouting(tier, policy, config);
    if (config.routePolicyVersion && config.routePolicyVersion !== ROUTE_POLICY_VERSION) {
      return await publishBlocked("route_policy_version_mismatch");
    }

    let selected:
      | {
          doctor: AdapterDoctorResult;
          route: ResolvedRoute;
          safeVersion: string;
        }
      | undefined;
    let terminalReason = "route_unavailable";
    const candidates = policy.tiers[tier].candidates;
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
      const candidate = candidates[candidateIndex]!;
      const statusReason = providerStatusReason(config.providerRouteStatus?.[candidate.provider]);
      if (statusReason) {
        const evidence = receiptCandidate(candidate, config);
        if (candidateIndex === 0) routing.primary = evidence;
        routing.skipped.push({ ...evidence, reason: statusReason });
        terminalReason = statusReason;
        continue;
      }

      const capabilityReason = routeCandidateCapabilityReason(
        candidate.provider,
        executionPolicy,
        input.promptSource,
        toolPolicy,
      );
      if (capabilityReason) {
        const evidence = receiptCandidate(candidate, config);
        if (candidateIndex === 0) routing.primary = evidence;
        routing.skipped.push({ ...evidence, reason: capabilityReason });
        terminalReason = capabilityReason;
        continue;
      }

      let doctor: AdapterDoctorResult;
      try {
        doctor = await (dependencies.doctor ?? doctorAdapter)(state, candidate.provider);
      } catch {
        const evidence = receiptCandidate(candidate, config);
        if (candidateIndex === 0) routing.primary = evidence;
        routing.skipped.push({ ...evidence, reason: "provider_doctor_failed" });
        terminalReason = "provider_doctor_failed";
        continue;
      }

      let report: Awaited<ReturnType<typeof runCandidateRouteProbe>>;
      try {
        report = await (dependencies.candidateProbe ?? runCandidateRouteProbe)(state, {
          tier,
          effort,
          candidateIndex,
          sessionConfig: config,
          providerDoctorEvidence: doctor.evidence,
          probe: "none",
        });
      } catch {
        const evidence = receiptCandidate(
          candidate,
          config,
          null,
          doctor.evidence.providerVersion,
        );
        if (candidateIndex === 0) routing.primary = evidence;
        routing.skipped.push({ ...evidence, reason: "route_probe_failed" });
        terminalReason = "route_probe_failed";
        continue;
      }

      const providerVersion = doctor.evidence.providerVersion;
      const route = report.route;
      const safeVersion = receiptProviderVersion(providerVersion);
      const reason =
        !report.ok || !route
          ? firstRouteFailure(report.findings)
          : safeVersion === "unresolved"
            ? "provider_version_unavailable"
            : routeCandidateCapabilityReason(route.provider, executionPolicy, input.promptSource, toolPolicy);
      const evidence = receiptCandidate(candidate, config, route, providerVersion);
      if (candidateIndex === 0) routing.primary = evidence;
      if (reason) {
        routing.skipped.push({ ...evidence, reason });
        terminalReason = reason;
        continue;
      }
      selected = { doctor, route: route!, safeVersion };
      break;
    }
    if (!selected) return await publishBlocked(terminalReason);

    const { doctor, route, safeVersion } = selected;

    let executed: { outcome: ManagedProviderOutcome; sessionId: string };
    try {
      executed = await (dependencies.execute ?? defaultExecute)(state, route, doctor, {
        prompt: input.prompt,
        systemPrompt: input.systemPrompt,
        mode: input.mode,
        workdir,
        effort,
        executionPolicy,
        toolPolicy,
      });
    } catch {
      finalReceipt = blockedReceipt(tier, effort, toolPolicy, route, safeVersion, routing, "provider_failed");
      await reservation.commit(finalReceipt);
      return { ok: false, content, sessionId, receipt: finalReceipt };
    }
    sessionId = executed.sessionId;
    const providerContent = executed.outcome.result.content;
    if (executed.outcome.result.error) {
      finalReceipt = blockedReceipt(tier, effort, toolPolicy, route, safeVersion, routing, "provider_failed");
    } else if (executed.outcome.resolvedExecutionPolicy === null) {
      finalReceipt = blockedReceipt(tier, effort, toolPolicy, route, safeVersion, routing, "execution_policy_unsupported");
    } else if (executed.outcome.resolvedExecutionPolicy !== executionPolicy) {
      finalReceipt = blockedReceipt(tier, effort, toolPolicy, route, safeVersion, routing, "execution_policy_mismatch");
    } else if (executed.outcome.resolvedToolPolicy === null) {
      finalReceipt = blockedReceipt(tier, effort, toolPolicy, route, safeVersion, routing, "tool_policy_unsupported");
    } else if (executed.outcome.resolvedToolPolicy !== toolPolicy) {
      finalReceipt = blockedReceipt(tier, effort, toolPolicy, route, safeVersion, routing, "tool_policy_mismatch");
    } else {
      const resolvedModel = providerResolvedModel(route, effort, executed.outcome.result.receipt);
      const usage = normalizedUsage(executed.outcome.result.usage);
      finalReceipt = !resolvedModel
        ? blockedReceipt(tier, effort, toolPolicy, route, safeVersion, routing, "provider_receipt_malformed")
        : usage
          ? successReceipt(tier, effort, toolPolicy, route, safeVersion, routing, usage, resolvedModel)
          : blockedReceipt(tier, effort, toolPolicy, route, safeVersion, routing, "usage_malformed");
    }
    content = finalReceipt.outcome === "success" ? providerContent : "";
    await reservation.commit(finalReceipt);
    return { ok: finalReceipt.outcome === "success", content, sessionId, receipt: finalReceipt };
  } finally {
    await reservation.close();
  }
}

async function readBoundedStream(stream: ReadableStream<Uint8Array> | Readable): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream as AsyncIterable<Uint8Array | string>) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_PROMPT_BYTES) throw new Error("execution prompt exceeds the bounded input limit");
    chunks.push(buffer);
  }
  const prompt = Buffer.concat(chunks).toString("utf8");
  if (!prompt.trim() || prompt.includes("\0")) throw new Error("execution prompt is required");
  return prompt;
}

/** Read a bounded prompt from stdin without ever copying it into argv or diagnostics. */
export function readPromptStdin(stream: ReadableStream<Uint8Array> | Readable): Promise<string> {
  return readBoundedStream(stream);
}

async function assertPhysicalPromptPath(target: string): Promise<void> {
  const parsed = path.parse(target);
  const relative = path.relative(parsed.root, target);
  const components = relative ? relative.split(path.sep) : [];
  let cursor = parsed.root;
  for (let index = 0; index < components.length; index += 1) {
    cursor = path.join(cursor, components[index]!);
    const info = await lstat(cursor).catch(() => null);
    const isTarget = index === components.length - 1;
    if (
      !info ||
      info.isSymbolicLink() ||
      (isTarget ? !info.isFile() : !info.isDirectory())
    ) {
      throw new Error("prompt file must be a physical regular file");
    }
    // Walking and lstat'ing every lexical component rejects POSIX links and
    // Windows junction/reparse ancestors while accepting a native DOS 8.3
    // spelling, which is an alias for the same entry rather than a reparse.
  }
}

/**
 * Admit an absolute, entirely physical prompt path through one pinned handle.
 * The path, contents, and any provider-owned text are deliberately absent from
 * failure messages.
 */
export async function readPromptFile(
  promptPath: string,
  admissionLifecycle: { beforeFinalVerification?: () => Promise<void> } = {},
): Promise<string> {
  const target = requiredAbsolutePath(promptPath, "prompt file");
  await assertPhysicalPromptPath(target);
  const pathInfo = await lstat(target, { bigint: true }).catch(() => null);
  if (!pathInfo?.isFile() || pathInfo.isSymbolicLink()) {
    throw new Error("prompt file must be a physical regular file");
  }
  const handle = await open(target, "r");
  try {
    const before = fileIdentity(await handle.stat({ bigint: true }));
    if (before.size > BigInt(MAX_PROMPT_BYTES)) {
      throw new Error("execution prompt exceeds the bounded input limit");
    }
    const buffer = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < buffer.length) {
      const read = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (offset !== buffer.length) throw new Error("prompt file changed during admission");
    await admissionLifecycle.beforeFinalVerification?.();
    await assertPhysicalPromptPath(target);
    const after = fileIdentity(await handle.stat({ bigint: true }));
    const named = await lstat(target, { bigint: true }).catch(() => null);
    if (!named || named.isSymbolicLink()) throw new Error("prompt file changed during admission");
    const namedIdentity = fileIdentity(named as unknown as Awaited<ReturnType<FileHandle["stat"]>>);
    if (!sameIdentity(before, after) || !sameIdentity(after, namedIdentity)) {
      throw new Error("prompt file changed during admission");
    }
    const prompt = buffer.toString("utf8");
    if (!prompt.trim() || prompt.includes("\0")) throw new Error("execution prompt is required");
    return prompt;
  } finally {
    await handle.close();
  }
}
