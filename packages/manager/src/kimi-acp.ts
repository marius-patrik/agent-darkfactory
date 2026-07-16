import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionNotification,
  type Stream,
} from "@agentclientprotocol/sdk";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type {
  SessionDescriptor,
  SessionTranscript,
  TranscriptMessage,
  TurnRequest,
  TurnResult,
} from "../../harness/session";
import { commandInvocation } from "./process-command";
import { runAnchoredFileAuthority } from "./anchored-file-authority";

const KIMI_RECEIPT_KEYS = ["model", "provider", "providerSessionId", "transport"] as const;
const MAX_PROVIDER_SESSION_ID_BYTES = 512;
const MAX_ACP_INPUT_LINE_CHARS = 16 * 1024 * 1024;
const DEFAULT_KIMI_ACP_TIMEOUTS: KimiAcpTimeouts = {
  controlRequestMs: 30_000,
  promptMs: 10 * 60_000,
  shutdownMs: 1_000,
};
const MAX_KIMI_ACP_TIMEOUTS: KimiAcpTimeouts = {
  controlRequestMs: 5 * 60_000,
  promptMs: 60 * 60_000,
  shutdownMs: 10_000,
};

export interface KimiAcpTimeouts {
  controlRequestMs: number;
  promptMs: number;
  shutdownMs: number;
}

export interface KimiNativeSessionReceipt {
  provider: "kimi";
  model: string;
  transport: "acp";
  providerSessionId: string;
}

interface KimiAcpTurnOptions {
  binary: string;
  descriptor: SessionDescriptor;
  transcript: SessionTranscript;
  request: TurnRequest;
  startup: string;
  env: Record<string, string | undefined>;
  timeouts?: Partial<KimiAcpTimeouts>;
}

class KimiContinuityError extends Error {}

function boundedTimeout(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: keyof KimiAcpTimeouts,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new KimiContinuityError(`Kimi ACP ${name} must be a positive bounded integer`);
  }
  return resolved;
}

function resolveTimeouts(overrides: Partial<KimiAcpTimeouts> | undefined): KimiAcpTimeouts {
  return {
    controlRequestMs: boundedTimeout(
      overrides?.controlRequestMs,
      DEFAULT_KIMI_ACP_TIMEOUTS.controlRequestMs,
      MAX_KIMI_ACP_TIMEOUTS.controlRequestMs,
      "controlRequestMs",
    ),
    promptMs: boundedTimeout(
      overrides?.promptMs,
      DEFAULT_KIMI_ACP_TIMEOUTS.promptMs,
      MAX_KIMI_ACP_TIMEOUTS.promptMs,
      "promptMs",
    ),
    shutdownMs: boundedTimeout(
      overrides?.shutdownMs,
      DEFAULT_KIMI_ACP_TIMEOUTS.shutdownMs,
      MAX_KIMI_ACP_TIMEOUTS.shutdownMs,
      "shutdownMs",
    ),
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertConcreteModel(model: string): void {
  if (!model.trim() || model.includes("\0")) {
    throw new KimiContinuityError("Kimi model must be a concrete non-empty identifier");
  }
  if (model === "default") {
    throw new KimiContinuityError("Kimi model uses the retired default model sentinel");
  }
}

function assertProviderSessionId(value: unknown, source: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_PROVIDER_SESSION_ID_BYTES ||
    /[\0-\x1f\x7f]/.test(value)
  ) {
    throw new KimiContinuityError(`Kimi ${source} has an invalid provider session id`);
  }
}

function parseKimiReceipt(value: unknown, model: string): KimiNativeSessionReceipt {
  if (!isPlainRecord(value)) {
    throw new KimiContinuityError("Kimi native continuity receipt must be a plain object");
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== KIMI_RECEIPT_KEYS.length || keys.some((key, index) => key !== KIMI_RECEIPT_KEYS[index])) {
    throw new KimiContinuityError("Kimi native continuity receipt has an unexpected shape");
  }
  if (value.provider !== "kimi" || value.transport !== "acp") {
    throw new KimiContinuityError("Kimi native continuity receipt has an unsupported provider transport");
  }
  if (value.model !== model) {
    throw new KimiContinuityError("Kimi native continuity receipt does not match the canonical model");
  }
  assertProviderSessionId(value.providerSessionId, "native continuity receipt");
  return {
    provider: "kimi",
    model,
    transport: "acp",
    providerSessionId: value.providerSessionId,
  };
}

function messagesBeforeCurrentTurn(transcript: SessionTranscript, request: TurnRequest): TranscriptMessage[] {
  const current = transcript.messages.at(-1);
  if (current?.role !== "user" || current.content !== request.prompt) {
    throw new KimiContinuityError("Kimi ACP turn is not aligned with the canonical current user message");
  }
  return transcript.messages.slice(0, -1);
}

function nativeReceiptForContinuation(
  transcript: SessionTranscript,
  request: TurnRequest,
  model: string,
): KimiNativeSessionReceipt | null {
  const priorMessages = messagesBeforeCurrentTurn(transcript, request);
  const hasPriorConversation = priorMessages.some((message) => message.role !== "system");
  if (!hasPriorConversation) return null;

  let latestBoundary: TranscriptMessage | undefined;
  for (let index = priorMessages.length - 1; index >= 0; index -= 1) {
    if (priorMessages[index]!.role === "system") continue;
    latestBoundary = priorMessages[index];
    break;
  }
  if (latestBoundary?.role !== "assistant") {
    throw new KimiContinuityError(
      "Kimi latest canonical continuation boundary is incomplete; refusing native resume",
    );
  }
  const latestCandidate = latestBoundary.metadata?.receipt;
  if (latestCandidate === undefined) {
    throw new KimiContinuityError(
      "Kimi latest canonical continuation boundary lacks a native receipt; refusing native resume",
    );
  }
  const latestReceipt = parseKimiReceipt(latestCandidate, model);

  for (const message of priorMessages) {
    if (message.role !== "assistant") continue;
    const candidate = message.metadata?.receipt;
    if (!isPlainRecord(candidate) || candidate.provider !== "kimi") continue;
    if (parseKimiReceipt(candidate, model).providerSessionId !== latestReceipt.providerSessionId) {
      throw new KimiContinuityError("Kimi canonical state contains conflicting native session receipts");
    }
  }
  return latestReceipt;
}

function currentTurnPrompt(options: KimiAcpTurnOptions, resuming: boolean): string {
  const sections = [options.startup];
  const priorMessages = messagesBeforeCurrentTurn(options.transcript, options.request);
  let instructionStart = 0;
  if (resuming) {
    instructionStart = priorMessages.length;
    while (instructionStart > 0 && priorMessages[instructionStart - 1]!.role === "system") {
      instructionStart -= 1;
    }
  }
  for (const message of priorMessages.slice(instructionStart)) {
    if (message.role === "system") sections.push(`## Session instructions\n\n${message.content}`);
  }
  sections.push(`## Current request\n\n${options.request.prompt}`);
  return sections.join("\n\n");
}

function assertConfigValue(configOptions: SessionConfigOption[], id: string, value: string): void {
  const matches = configOptions.filter((option) => option.id === id);
  if (matches.length !== 1 || matches[0]!.type !== "select" || matches[0]!.currentValue !== value) {
    throw new KimiContinuityError(`Kimi ACP did not confirm the requested ${id} configuration`);
  }
}

function acpUsage(value: unknown): TurnResult["usage"] | undefined {
  if (!isPlainRecord(value)) return undefined;
  const inputTokens = value.inputTokens;
  const outputTokens = value.outputTokens;
  if (
    !Number.isSafeInteger(inputTokens) ||
    (inputTokens as number) < 0 ||
    !Number.isSafeInteger(outputTokens) ||
    (outputTokens as number) < 0
  ) {
    return undefined;
  }
  const totalTokens = (inputTokens as number) + (outputTokens as number);
  if (!Number.isSafeInteger(totalTokens)) return undefined;
  return { tokensIn: inputTokens as number, tokensOut: outputTokens as number, totalTokens };
}

function containsPath(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

interface WorkspaceFileLocation {
  lexicalRoot: string;
  lexicalTarget: string;
  physicalRoot: string;
  physicalTarget: string;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function workspaceFileLocation(
  workdir: string,
  candidate: string,
): Promise<WorkspaceFileLocation | null> {
  if (!path.isAbsolute(candidate) || candidate.includes("\0")) return null;
  const lexicalRoot = path.resolve(workdir);
  const lexicalTarget = path.resolve(candidate);
  if (!containsPath(lexicalRoot, lexicalTarget) || lexicalTarget === lexicalRoot) return null;

  const rootInfo = await lstat(lexicalRoot).catch(() => null);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) return null;
  const physicalRoot = await realpath(lexicalRoot).catch(() => null);
  if (!physicalRoot) return null;

  const relative = path.relative(lexicalRoot, lexicalTarget);
  let cursor = lexicalRoot;
  let physicalTarget: string | null = null;
  const components = relative.split(path.sep);
  for (const [index, component] of components.entries()) {
    cursor = path.join(cursor, component);
    const info = await lstat(cursor).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    const isTarget = index === components.length - 1;
    if (!info) return null;
    if (info.isSymbolicLink()) return null;
    if (isTarget) {
      if (!info.isFile() || info.nlink !== 1) return null;
    } else if (!info.isDirectory()) {
      return null;
    }
    const physical = await realpath(cursor).catch(() => null);
    if (!physical || !containsPath(physicalRoot, physical)) return null;
    if (isTarget) physicalTarget = physical;
  }
  return physicalTarget ? { lexicalRoot, lexicalTarget, physicalRoot, physicalTarget } : null;
}

async function openWorkspaceFile(
  workdir: string,
  candidate: string,
): Promise<FileHandle> {
  const location = await workspaceFileLocation(workdir, candidate);
  if (!location) throw new KimiContinuityError("Kimi ACP filesystem request escaped managed containment");
  // Reads retain the existing handle-based admission. Writes never use this
  // path: they cross the manager's anchored mutation authority below.
  const handle = await open(location.lexicalTarget, "r");
  try {
    // Re-admit the physical file after open and compare the named entry so a
    // read cannot be redirected between pathname admission and handle use.
    const [opened, named, finalRoot, physicalTarget] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(location.lexicalTarget, { bigint: true }).catch(() => null),
      realpath(location.lexicalRoot).catch(() => null),
      realpath(location.lexicalTarget).catch(() => null),
    ]);
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      !named?.isFile() ||
      named.isSymbolicLink() ||
      named.nlink !== 1n ||
      !sameFile(opened, named) ||
      !finalRoot ||
      !samePath(finalRoot, location.physicalRoot) ||
      !physicalTarget ||
      !containsPath(location.physicalRoot, physicalTarget)
    ) {
      throw new KimiContinuityError("Kimi ACP filesystem request escaped managed containment");
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readWorkspaceTextFile(
  params: { sessionId: string; path: string; line?: number | null; limit?: number | null },
  activeSessionId: string | null,
  workdir: string,
): Promise<{ content: string }> {
  if (
    !activeSessionId ||
    params.sessionId !== activeSessionId ||
    (params.line !== undefined && params.line !== null && (!Number.isSafeInteger(params.line) || params.line < 1)) ||
    (params.limit !== undefined && params.limit !== null && (!Number.isSafeInteger(params.limit) || params.limit < 0))
  ) {
    throw new KimiContinuityError("Kimi ACP filesystem request is malformed");
  }
  const handle = await openWorkspaceFile(workdir, params.path);
  try {
    const info = await handle.stat({ bigint: true });
    if (info.size > BigInt(MAX_ACP_INPUT_LINE_CHARS)) {
      throw new KimiContinuityError("Kimi ACP filesystem request exceeds the managed limit");
    }
    const content = await handle.readFile("utf8");
    if (params.line === undefined && params.limit === undefined) return { content };
    const start = (params.line ?? 1) - 1;
    const lines = content.split("\n");
    const selected = params.limit === undefined || params.limit === null
      ? lines.slice(start)
      : lines.slice(start, start + params.limit);
    return { content: selected.join("\n") };
  } finally {
    await handle.close();
  }
}

async function writeWorkspaceTextFile(
  params: { sessionId: string; path: string; content: string },
  activeSessionId: string | null,
  workdir: string,
  executionPolicy: "read-only" | "workspace-write",
): Promise<Record<string, never>> {
  if (
    executionPolicy !== "workspace-write" ||
    !activeSessionId ||
    params.sessionId !== activeSessionId ||
    typeof params.content !== "string" ||
    Buffer.byteLength(params.content, "utf8") > MAX_ACP_INPUT_LINE_CHARS
  ) {
    throw new KimiContinuityError("Kimi ACP filesystem request is not authorized");
  }
  try {
    const location = await workspaceFileLocation(workdir, params.path);
    if (!location) {
      throw new KimiContinuityError("Kimi ACP filesystem request escaped managed containment");
    }
    const relativeTarget = path.relative(location.physicalRoot, location.physicalTarget);
    const components = relativeTarget.split(path.sep);
    await runAnchoredFileAuthority({
      operation: "replace",
      root: location.physicalRoot,
      components,
      content: Buffer.from(params.content, "utf8"),
    });
    return {};
  } catch (error) {
    if (error instanceof KimiContinuityError) throw error;
    throw new KimiContinuityError("Kimi ACP filesystem target changed during mutation");
  }
}

function processInputStream(stdin: Bun.FileSink): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    async write(chunk) {
      stdin.write(chunk);
      await stdin.flush();
    },
    close() {
      stdin.end();
    },
    abort() {
      stdin.end();
    },
  });
}

type AcpMessage = Stream["writable"] extends WritableStream<infer Message> ? Message : never;

function safeNdJsonStream(
  output: WritableStream<Uint8Array>,
  input: ReadableStream<Uint8Array>,
): Stream {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const readable = new ReadableStream<AcpMessage>({
    async start(controller) {
      const reader = input.getReader();
      let buffered = "";
      const enqueue = (rawLine: string): void => {
        const line = rawLine.trim();
        if (!line) return;
        if (line.length > MAX_ACP_INPUT_LINE_CHARS) {
          throw new Error("Kimi ACP input exceeded the bounded protocol line size");
        }
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          // Never echo malformed provider stdout: it may contain credentials,
          // prompts, or tool output. Closing the protocol stream rejects the
          // pending SDK request without turning provider bytes into logs.
          throw new Error("Kimi ACP emitted malformed protocol JSON");
        }
        controller.enqueue(message as AcpMessage);
      };
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            buffered += decoder.decode();
            break;
          }
          if (!value) continue;
          buffered += decoder.decode(value, { stream: true });
          if (buffered.length > MAX_ACP_INPUT_LINE_CHARS && !buffered.includes("\n")) {
            throw new Error("Kimi ACP input exceeded the bounded protocol line size");
          }
          const lines = buffered.split("\n");
          buffered = lines.pop() ?? "";
          for (const line of lines) enqueue(line);
        }
        enqueue(buffered);
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
  });
  const writable = new WritableStream<AcpMessage>({
    async write(message) {
      const writer = output.getWriter();
      try {
        await writer.write(encoder.encode(`${JSON.stringify(message)}\n`));
      } finally {
        writer.releaseLock();
      }
    },
  });
  return { readable, writable };
}

async function drainStream(input: ReadableStream<Uint8Array>): Promise<void> {
  const reader = input.getReader();
  try {
    while (!(await reader.read()).done) {
      // Drain without retaining provider logs or secret-bearing diagnostics.
    }
  } finally {
    reader.releaseLock();
  }
}

async function withPhaseDeadline<T>(
  operation: Promise<T>,
  milliseconds: number,
  phase: string,
  proc: Bun.Subprocess<"pipe", "pipe", "pipe">,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new KimiContinuityError(`Kimi ACP ${phase} timed out`));
      try {
        proc.kill();
      } catch {
        // The process may have exited at the deadline boundary.
      }
    }, milliseconds);
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function completesWithin(operation: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function stopProcess(
  proc: Bun.Subprocess<"pipe", "pipe", "pipe">,
  input: WritableStream<Uint8Array>,
  stderrRead: Promise<void>,
  shutdownMs: number,
): Promise<void> {
  try {
    await input.close();
  } catch {
    // The provider may have already closed its stdin while reporting an ACP error.
  }
  const exited = await completesWithin(proc.exited, shutdownMs);
  if (!exited) {
    try {
      proc.kill();
    } catch {
      // The process may have exited between the bounded wait and termination.
    }
    if (!(await completesWithin(proc.exited, shutdownMs))) {
      try {
        proc.kill(9);
      } catch {
        // Cleanup remains bounded even if the platform rejects a second kill.
      }
      await completesWithin(proc.exited, shutdownMs);
    }
  }
  await completesWithin(stderrRead, shutdownMs);
}

function normalizedBoundaryFailure(phase: string): Error {
  const suffix = phase === "session resume" ? "; native session was not replaced" : "";
  return new Error(`Kimi ACP ${phase} failed${suffix}`);
}

/**
 * Execute one Kimi turn over the official ACP stdio boundary. Historical
 * transcript content never enters argv: continuation is bound exclusively to
 * the provider's opaque native session handle recorded in canonical state.
 */
export async function runKimiAcpTurn(options: KimiAcpTurnOptions): Promise<TurnResult> {
  assertConcreteModel(options.descriptor.model);
  const executionPolicy = options.request.executionPolicy ?? "read-only";
  if (executionPolicy !== "read-only" && executionPolicy !== "workspace-write") {
    throw new KimiContinuityError("Kimi execution policy is unsupported");
  }
  // Kimi's auto mode can execute ambient provider tools without a manager
  // authorization callback. Workspace-write therefore uses manual mode and
  // grants only one workspace-bounded edit at a time; shell/delete/move and
  // every out-of-root or link-bearing target remain denied.
  const providerMode = executionPolicy === "read-only" ? "plan" : "manual";
  const timeouts = resolveTimeouts(options.timeouts);
  const priorReceipt = nativeReceiptForContinuation(
    options.transcript,
    options.request,
    options.descriptor.model,
  );
  const invocation = commandInvocation(options.binary, ["acp"], options.env);
  let phase = "process launch";
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn(invocation, {
      cwd: options.descriptor.workdir,
      env: options.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    throw normalizedBoundaryFailure(phase);
  }

  const stderrRead = drainStream(proc.stderr);
  const processInput = processInputStream(proc.stdin);
  const output: string[] = [];
  let unexpectedPermissionRequest = false;
  let unexpectedFilesystemRequest = false;
  let unexpectedSessionUpdate = false;
  let activeSessionId = priorReceipt?.providerSessionId ?? null;
  const client: Client = {
    async requestPermission(_params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
      // Provider-side pathname mutation is never authorized. Workspace writes
      // must come through writeTextFile so the manager owns the operation and
      // can pin and re-attest the physical file at mutation time.
      unexpectedPermissionRequest = true;
      return { outcome: { outcome: "cancelled" } };
    },
    async readTextFile(params) {
      try {
        return await readWorkspaceTextFile(params, activeSessionId, options.descriptor.workdir);
      } catch {
        // The ACP SDK logs rejected client handlers with the provider's raw
        // request. Return a content-free response and fail the managed turn
        // after prompt completion instead of exposing paths or file content.
        unexpectedFilesystemRequest = true;
        return { content: "" };
      }
    },
    async writeTextFile(params) {
      try {
        return await writeWorkspaceTextFile(
          params,
          activeSessionId,
          options.descriptor.workdir,
          executionPolicy,
        );
      } catch {
        unexpectedFilesystemRequest = true;
        return {};
      }
    },
    async sessionUpdate(notification: SessionNotification) {
      if (!activeSessionId || notification.sessionId !== activeSessionId) {
        // Do not throw provider-bearing notification data back through the SDK:
        // its generic handler logs rejected notifications verbatim. Record the
        // continuity violation and fail the turn after the prompt settles.
        unexpectedSessionUpdate = true;
        return;
      }
      const update = notification.update;
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        output.push(update.content.text);
      }
    },
  };

  try {
    const connection = new ClientSideConnection(() => client, safeNdJsonStream(processInput, proc.stdout));
    phase = "initialization";
    const initialized = await withPhaseDeadline(
      connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: executionPolicy === "workspace-write" },
          terminal: false,
        },
        clientInfo: { name: "Andromeda Manager", version: "0.1.0" },
      }),
      timeouts.controlRequestMs,
      phase,
      proc,
    );
    if (initialized.protocolVersion !== PROTOCOL_VERSION) {
      throw new KimiContinuityError("Kimi ACP negotiated an unsupported protocol version");
    }
    if (!initialized.agentCapabilities?.sessionCapabilities?.resume) {
      throw new KimiContinuityError("Kimi ACP does not advertise native session resume support");
    }

    if (priorReceipt) {
      phase = "session resume";
      const resumed = await withPhaseDeadline(
        connection.resumeSession({
          sessionId: priorReceipt.providerSessionId,
          cwd: options.descriptor.workdir,
          mcpServers: [],
        }),
        timeouts.controlRequestMs,
        phase,
        proc,
      );
      if (!resumed.configOptions) {
        throw new KimiContinuityError("Kimi ACP resume did not report the native session configuration");
      }
      assertConfigValue(resumed.configOptions, "model", options.descriptor.model);
    } else {
      phase = "session creation";
      const created = await withPhaseDeadline(
        connection.newSession({ cwd: options.descriptor.workdir, mcpServers: [] }),
        timeouts.controlRequestMs,
        phase,
        proc,
      );
      assertProviderSessionId(created.sessionId, "ACP session creation response");
      activeSessionId = created.sessionId;
      phase = "model configuration";
      const modelConfig = await withPhaseDeadline(
        connection.setSessionConfigOption({
          sessionId: activeSessionId,
          configId: "model",
          value: options.descriptor.model,
        }),
        timeouts.controlRequestMs,
        phase,
        proc,
      );
      assertConfigValue(modelConfig.configOptions, "model", options.descriptor.model);
    }

    phase = "mode configuration";
    const modeConfig = await withPhaseDeadline(
      connection.setSessionConfigOption({
        sessionId: activeSessionId!,
        configId: "mode",
        value: providerMode,
      }),
      timeouts.controlRequestMs,
      phase,
      proc,
    );
    assertConfigValue(modeConfig.configOptions, "model", options.descriptor.model);
    assertConfigValue(modeConfig.configOptions, "mode", providerMode);

    phase = "prompt";
    const response = await withPhaseDeadline(
      connection.prompt({
        sessionId: activeSessionId!,
        prompt: [{ type: "text", text: currentTurnPrompt(options, priorReceipt !== null) }],
      }),
      timeouts.promptMs,
      phase,
      proc,
    );
    if (unexpectedSessionUpdate) {
      throw new KimiContinuityError("Kimi ACP emitted an update for an unexpected native session");
    }
    if (unexpectedPermissionRequest) {
      throw new KimiContinuityError("Kimi ACP requested permission despite the confirmed execution policy");
    }
    if (unexpectedFilesystemRequest) {
      throw new KimiContinuityError("Kimi ACP attempted a filesystem operation outside managed containment");
    }
    if (response.stopReason === "cancelled") {
      throw new KimiContinuityError("Kimi ACP cancelled the managed turn");
    }

    return {
      content: output.join(""),
      role: "assistant",
      finishReason: response.stopReason,
      usage: acpUsage(response.usage),
      resolvedExecutionPolicy: executionPolicy,
      receipt: {
        provider: "kimi",
        model: options.descriptor.model,
        transport: "acp",
        providerSessionId: activeSessionId!,
      } satisfies KimiNativeSessionReceipt,
    };
  } catch (error) {
    if (error instanceof KimiContinuityError) throw error;
    throw normalizedBoundaryFailure(phase);
  } finally {
    await stopProcess(proc, processInput, stderrRead, timeouts.shutdownMs);
  }
}
