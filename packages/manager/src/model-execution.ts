import path from "node:path";
import { open, lstat, realpath, type FileHandle } from "node:fs/promises";
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
  MODEL_TIERS,
  TIER_ROUTES,
  runRouteProbe,
  type ModelTier,
  type ResolvedRoute,
  type RouteFindingCode,
} from "./route-probe";
import type { SharedState } from "./state";
import { orchestratorSystemPrompt, startOrchestratorHeartbeat } from "./orchestrator";

/**
 * Canonical model execution boundary for DarkFactory #24/#36.
 *
 * Invariants:
 * - A logical tier and independent effort resolve only through the canonical
 *   route module plus provider-doctor evidence. DarkFactory never supplies a
 *   provider, concrete model, executable, registry, or fallback.
 * - Exactly one bounded prompt source is admitted. Prompt text is never placed
 *   in an Agent OS receipt or error and file-backed input is verified through
 *   one pinned handle before use.
 * - The absolute receipt path is reserved with an identity-bound blocked
 *   receipt before a provider turn can start. A crash therefore leaves durable
 *   fail-closed evidence rather than an unreceipted mutation.
 * - Only read-only and workspace-write are representable. A provider result is
 *   accepted only when its resolved policy equals the requested policy.
 */

export const MODEL_EFFORTS = ["low", "medium", "high"] as const;
export type ModelEffort = (typeof MODEL_EFFORTS)[number];

export const EXECUTION_POLICIES = ["read-only", "workspace-write"] as const;
export type ExecutionPolicy = (typeof EXECUTION_POLICIES)[number];

export const MAX_PROMPT_BYTES = 8 * 1024 * 1024;

const SAFE_RECEIPT_VALUE = /^[A-Za-z0-9][A-Za-z0-9_.\/-]{0,127}$/;
const SAFE_BLOCK_REASON = /^[a-z][a-z0-9_-]{0,63}$/;

export interface AgentExecutionReceipt {
  schemaVersion: 1;
  requested: {
    modelTier: ModelTier;
    effort: ModelEffort;
  };
  resolved: {
    provider: string;
    model: string;
    agentPreset: string;
    providerVersion: string;
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

export interface ModelExecutionRequest {
  modelTier: string;
  effort: string;
  executionPolicy: string;
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
  resolvedExecutionPolicy: ExecutionPolicy;
}

export interface ModelExecutionDependencies {
  doctor?: (state: SharedState, provider: ProviderId) => Promise<AdapterDoctorResult>;
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
    }>,
  ) => Promise<{ outcome: ManagedProviderOutcome; sessionId: string }>;
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

function outputSafe(value: string, fallback = "unresolved"): string {
  if (SAFE_RECEIPT_VALUE.test(value)) return value;
  return fallback;
}

/** Provider registry versions may include product names; receipts carry the exact semver token. */
export function receiptProviderVersion(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (SAFE_RECEIPT_VALUE.test(trimmed)) return trimmed;
  const semver = trimmed.match(/\b\d+(?:\.\d+){1,3}(?:[-+][A-Za-z0-9.-]+)?\b/)?.[0];
  return semver && SAFE_RECEIPT_VALUE.test(semver) ? semver : "unresolved";
}

function zeroUsage(): AgentExecutionReceipt["usage"] {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

function normalizedUsage(usage: TurnResult["usage"]): AgentExecutionReceipt["usage"] | null {
  const inputTokens = usage?.tokensIn ?? 0;
  const outputTokens = usage?.tokensOut ?? 0;
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
  if (usage?.totalTokens !== undefined && usage.totalTokens !== totalTokens) return null;
  return { inputTokens, outputTokens, totalTokens };
}

function resolvedReceipt(
  tier: ModelTier,
  route: ResolvedRoute | null,
  providerVersion: string | null | undefined,
): AgentExecutionReceipt["resolved"] {
  const declared = TIER_ROUTES[tier];
  return {
    provider: outputSafe(route?.provider ?? declared.provider),
    model: outputSafe(route?.model ?? "unresolved"),
    agentPreset: outputSafe(route?.agentPreset ?? declared.agentPreset),
    providerVersion: receiptProviderVersion(providerVersion),
  };
}

function blockedReceipt(
  tier: ModelTier,
  effort: ModelEffort,
  route: ResolvedRoute | null,
  providerVersion: string | null | undefined,
  reason: string,
): AgentExecutionReceipt {
  const blockReason = SAFE_BLOCK_REASON.test(reason) ? reason : "execution_blocked";
  return {
    schemaVersion: 1,
    requested: { modelTier: tier, effort },
    resolved: resolvedReceipt(tier, route, providerVersion),
    attempts: [{ number: 1, outcome: "blocked", reason: blockReason }],
    usage: zeroUsage(),
    outcome: "blocked",
    blockReason,
  };
}

function successReceipt(
  tier: ModelTier,
  effort: ModelEffort,
  route: ResolvedRoute,
  providerVersion: string,
  usage: AgentExecutionReceipt["usage"],
): AgentExecutionReceipt {
  return {
    schemaVersion: 1,
    requested: { modelTier: tier, effort },
    resolved: resolvedReceipt(tier, route, providerVersion),
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
    private readonly receiptPath: string,
    private readonly handle: FileHandle,
    private identity: FileIdentity,
  ) {}

  static async create(
    receiptPath: string,
    workdir: string,
    pending: AgentExecutionReceipt,
  ): Promise<ReceiptReservation> {
    const requestedWorkdir = requiredAbsolutePath(workdir, "execution workdir");
    const canonicalWorkdir = await realpath(requestedWorkdir).catch(() => null);
    if (!canonicalWorkdir) throw new Error("execution workdir is unavailable");
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

    let handle: FileHandle;
    try {
      handle = await open(target, "wx", 0o600);
    } catch {
      throw new Error("execution receipt path must be a new file");
    }
    try {
      const content = Buffer.from(receiptText(pending), "utf8");
      await handle.write(content, 0, content.length, 0);
      await handle.sync();
      const identity = fileIdentity(await handle.stat({ bigint: true }));
      return new ReceiptReservation(target, handle, identity);
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  async commit(receipt: AgentExecutionReceipt): Promise<void> {
    if (this.closed) throw new Error("execution receipt reservation is closed");
    const before = fileIdentity(await this.handle.stat({ bigint: true }));
    if (!sameIdentity(this.identity, before)) {
      throw new Error("execution receipt identity changed");
    }
    const named = await lstat(this.receiptPath, { bigint: true }).catch(() => null);
    if (!named || named.isSymbolicLink()) throw new Error("execution receipt identity changed");
    const namedIdentity = fileIdentity(named as unknown as Awaited<ReturnType<FileHandle["stat"]>>);
    if (!sameIdentity(before, namedIdentity)) {
      throw new Error("execution receipt identity changed");
    }
    const content = Buffer.from(receiptText(receipt), "utf8");
    await this.handle.truncate(0);
    await this.handle.write(content, 0, content.length, 0);
    await this.handle.sync();
    this.identity = fileIdentity(await this.handle.stat({ bigint: true }));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.handle.close();
    const named = await lstat(this.receiptPath, { bigint: true }).catch(() => null);
    if (!named || named.isSymbolicLink()) throw new Error("execution receipt identity changed");
    const finalIdentity = fileIdentity(named as unknown as Awaited<ReturnType<FileHandle["stat"]>>);
    if (!sameIdentity(this.identity, finalIdentity)) throw new Error("execution receipt identity changed");
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
  }>,
): Promise<{ outcome: ManagedProviderOutcome; sessionId: string }> {
  if (!doctor.binary) throw new Error("canonical provider is unavailable");
  const descriptor = await createSession(state, {
    provider: route.provider,
    model: route.model,
    mode: request.mode,
    workdir: request.workdir,
  });
  const heartbeat =
    request.mode === "orchestrator"
      ? await startOrchestratorHeartbeat(state, descriptor.sessionId, {
          provider: descriptor.provider,
          model: descriptor.model,
        })
      : null;
  try {
    const adapter = providerSessionAdapter(route.provider, doctor.binary);
    const result = await runSessionTurn(state, adapter, descriptor, {
      prompt: request.prompt,
      systemPrompt:
        request.systemPrompt ?? (request.mode === "orchestrator" ? orchestratorSystemPrompt() : undefined),
      effort: request.effort,
      executionPolicy: request.executionPolicy,
      agentPreset: route.agentPreset,
    });
    heartbeat?.assertHealthy();
    if (!result.resolvedExecutionPolicy) {
      throw new Error("provider did not attest the resolved execution policy");
    }
    return {
      sessionId: descriptor.sessionId,
      outcome: {
        result,
        resolvedExecutionPolicy: result.resolvedExecutionPolicy,
      },
    };
  } finally {
    await heartbeat?.stop();
  }
}

function firstRouteFailure(findings: Array<{ code: RouteFindingCode }>): string {
  return findings[0]?.code ?? "route_unavailable";
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
  const workdir = requiredAbsolutePath(input.workdir, "execution workdir");
  if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.includes("\0")) {
    throw new Error("execution prompt is required");
  }
  if (Buffer.byteLength(input.prompt, "utf8") > MAX_PROMPT_BYTES) {
    throw new Error("execution prompt exceeds the bounded input limit");
  }

  const provider = TIER_ROUTES[tier].provider;
  const doctor = await (dependencies.doctor ?? doctorAdapter)(state, provider);
  const report = await runRouteProbe(state, {
    tier,
    effort,
    providerDoctorEvidence: doctor.evidence,
    probe: "none",
  });
  const providerVersion = doctor.evidence.providerVersion;
  const route = report.route;
  const pending = blockedReceipt(tier, effort, route, providerVersion, "execution_pending");
  const reservation = await ReceiptReservation.create(input.receiptPath, workdir, pending);
  let finalReceipt = pending;
  let sessionId: string | null = null;
  let content = "";
  try {
    if (!report.ok || !route) {
      finalReceipt = blockedReceipt(
        tier,
        effort,
        route,
        providerVersion,
        firstRouteFailure(report.findings),
      );
      await reservation.commit(finalReceipt);
      return { ok: false, content, sessionId, receipt: finalReceipt };
    }
    const safeVersion = receiptProviderVersion(providerVersion);
    if (safeVersion === "unresolved") {
      finalReceipt = blockedReceipt(tier, effort, route, providerVersion, "provider_version_unavailable");
      await reservation.commit(finalReceipt);
      return { ok: false, content, sessionId, receipt: finalReceipt };
    }
    // Agy 1.1.1 has no stdin/file prompt transport: --print consumes the
    // prompt as the next argv token. Low-tier positional text is already
    // caller-visible argv and remains suitable for trivial work, but content
    // admitted from a secret-safe file/stdin boundary must never be copied
    // into a downstream process argv.
    if (route.provider === "agy" && input.promptSource !== "positional") {
      finalReceipt = blockedReceipt(
        tier,
        effort,
        route,
        safeVersion,
        "provider_prompt_transport_unsupported",
      );
      await reservation.commit(finalReceipt);
      return { ok: false, content, sessionId, receipt: finalReceipt };
    }

    let executed: { outcome: ManagedProviderOutcome; sessionId: string };
    try {
      executed = await (dependencies.execute ?? defaultExecute)(state, route, doctor, {
        prompt: input.prompt,
        systemPrompt: input.systemPrompt,
        mode: input.mode,
        workdir,
        effort,
        executionPolicy,
      });
    } catch {
      finalReceipt = blockedReceipt(tier, effort, route, safeVersion, "provider_failed");
      await reservation.commit(finalReceipt);
      return { ok: false, content, sessionId, receipt: finalReceipt };
    }
    sessionId = executed.sessionId;
    const providerContent = executed.outcome.result.content;
    if (executed.outcome.resolvedExecutionPolicy !== executionPolicy) {
      finalReceipt = blockedReceipt(tier, effort, route, safeVersion, "execution_policy_mismatch");
    } else if (executed.outcome.result.error) {
      finalReceipt = blockedReceipt(tier, effort, route, safeVersion, "provider_failed");
    } else {
      const usage = normalizedUsage(executed.outcome.result.usage);
      finalReceipt = usage
        ? successReceipt(tier, effort, route, safeVersion, usage)
        : blockedReceipt(tier, effort, route, safeVersion, "usage_malformed");
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

/**
 * Admit an absolute prompt file through one pinned handle. The path, contents,
 * and any provider-owned text are deliberately absent from failure messages.
 */
export async function readPromptFile(
  promptPath: string,
  admissionLifecycle: { beforeFinalVerification?: () => Promise<void> } = {},
): Promise<string> {
  const target = requiredAbsolutePath(promptPath, "prompt file");
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
