import path from "node:path";
import type { SessionDescriptor, TurnRequest } from "../../harness/session";
import { commandInvocation } from "./process-command";

export type NarrowExecutionPolicy = "read-only" | "workspace-write";

const CODEX_PREFLIGHT_TIMEOUT_MS = 30_000;
const CODEX_PREFLIGHT_SHUTDOWN_MS = 1_000;
const MAX_PROTOCOL_LINE_CHARS = 1024 * 1024;
const MAX_PROTOCOL_BYTES = 4 * 1024 * 1024;
const MAX_PROTOCOL_MESSAGES = 128;

class CodexPreflightError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function requestedPolicy(request: TurnRequest): NarrowExecutionPolicy {
  const policy = request.executionPolicy ?? "read-only";
  if (policy !== "read-only" && policy !== "workspace-write") {
    throw new CodexPreflightError("Codex execution policy is unsupported");
  }
  return policy;
}

function permissionProfile(policy: NarrowExecutionPolicy): ":read-only" | ":workspace" {
  return policy === "read-only" ? ":read-only" : ":workspace";
}

function preflightConfig(request: TurnRequest, policy: NarrowExecutionPolicy): Record<string, unknown> {
  return {
    ...(request.effort ? { model_reasoning_effort: request.effort } : {}),
    ...(policy === "workspace-write"
      ? {
          sandbox_workspace_write: {
            network_access: false,
            exclude_tmpdir_env_var: true,
            exclude_slash_tmp: true,
            writable_roots: [],
          },
        }
      : {}),
  };
}

/**
 * Validate the zero-token thread/start receipt returned by Codex app-server.
 * The app-server resolves sandbox/config before a model turn exists, so a
 * policy mismatch can stop the later `codex exec` before repository work.
 */
export function attestCodexPreworkResponse(
  descriptor: SessionDescriptor,
  request: TurnRequest,
  initialized: unknown,
  started: unknown,
): NarrowExecutionPolicy {
  const policy = requestedPolicy(request);
  if (!isRecord(initialized) || !samePath(String(initialized.codexHome ?? ""), path.join(descriptor.stateDir, "clis", "codex"))) {
    throw new CodexPreflightError("Codex preflight did not use canonical provider state");
  }
  if (!isRecord(started) || !isRecord(started.thread) || !isRecord(started.sandbox)) {
    throw new CodexPreflightError("Codex preflight receipt is malformed");
  }
  if (!isRecord(started.activePermissionProfile)) {
    throw new CodexPreflightError("Codex preflight receipt is malformed");
  }
  const roots = Array.isArray(started.runtimeWorkspaceRoots) ? started.runtimeWorkspaceRoots : [];
  if (
    started.model !== descriptor.model ||
    !samePath(String(started.cwd ?? ""), descriptor.workdir) ||
    roots.length !== 1 ||
    typeof roots[0] !== "string" ||
    !samePath(roots[0], descriptor.workdir) ||
    started.approvalPolicy !== "never" ||
    (request.effort !== undefined && started.reasoningEffort !== request.effort) ||
    started.thread.ephemeral !== true ||
    !samePath(String(started.thread.cwd ?? ""), descriptor.workdir) ||
    started.activePermissionProfile.id !== permissionProfile(policy) ||
    started.activePermissionProfile.extends !== null
  ) {
    throw new CodexPreflightError("Codex preflight receipt does not match the canonical request");
  }

  if (policy === "read-only") {
    if (started.sandbox.type !== "readOnly" || started.sandbox.networkAccess !== false) {
      throw new CodexPreflightError("Codex resolved execution policy does not match the requested policy");
    }
    return policy;
  }

  const writableRoots = started.sandbox.writableRoots;
  if (
    started.sandbox.type !== "workspaceWrite" ||
    !Array.isArray(writableRoots) ||
    writableRoots.length !== 0 ||
    started.sandbox.networkAccess !== false ||
    started.sandbox.excludeTmpdirEnvVar !== true ||
    started.sandbox.excludeSlashTmp !== true
  ) {
    throw new CodexPreflightError("Codex resolved execution policy does not match the requested policy");
  }
  return policy;
}

class JsonRpcReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffered = "";
  private bytes = 0;
  private messages = 0;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  async response(id: number): Promise<Record<string, unknown>> {
    while (true) {
      const line = await this.nextLine();
      if (line === null) throw new CodexPreflightError("Codex preflight protocol closed unexpectedly");
      if (!line.trim()) continue;
      this.messages += 1;
      if (this.messages > MAX_PROTOCOL_MESSAGES) {
        throw new CodexPreflightError("Codex preflight protocol exceeded the bounded message count");
      }
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        throw new CodexPreflightError("Codex preflight emitted malformed protocol JSON");
      }
      if (!isRecord(message) || message.id !== id) continue;
      if (message.error !== undefined || !isRecord(message.result)) {
        throw new CodexPreflightError("Codex preflight request failed");
      }
      return message.result;
    }
  }

  async close(): Promise<void> {
    await this.reader.cancel().catch(() => undefined);
    this.reader.releaseLock();
  }

  private async nextLine(): Promise<string | null> {
    while (true) {
      const newline = this.buffered.indexOf("\n");
      if (newline >= 0) {
        const line = this.buffered.slice(0, newline);
        this.buffered = this.buffered.slice(newline + 1);
        if (line.length > MAX_PROTOCOL_LINE_CHARS) {
          throw new CodexPreflightError("Codex preflight protocol line exceeded the bounded size");
        }
        return line;
      }
      const { value, done } = await this.reader.read();
      if (done) {
        this.buffered += this.decoder.decode();
        if (!this.buffered) return null;
        const line = this.buffered;
        this.buffered = "";
        if (line.length > MAX_PROTOCOL_LINE_CHARS) {
          throw new CodexPreflightError("Codex preflight protocol line exceeded the bounded size");
        }
        return line;
      }
      if (!value) continue;
      this.bytes += value.byteLength;
      if (this.bytes > MAX_PROTOCOL_BYTES) {
        throw new CodexPreflightError("Codex preflight protocol exceeded the bounded size");
      }
      this.buffered += this.decoder.decode(value, { stream: true });
      if (this.buffered.length > MAX_PROTOCOL_LINE_CHARS && !this.buffered.includes("\n")) {
        throw new CodexPreflightError("Codex preflight protocol line exceeded the bounded size");
      }
    }
  }
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  try {
    while (!(await reader.read()).done) {
      // Provider stderr may contain prompts, paths, or credentials. Discard it.
    }
  } finally {
    reader.releaseLock();
  }
}

async function bounded<T>(
  operation: Promise<T>,
  proc: Bun.Subprocess<"pipe", "pipe", "pipe">,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          try {
            proc.kill();
          } catch {
            // The process may have exited at the timeout boundary.
          }
          reject(new CodexPreflightError("Codex preflight timed out"));
        }, CODEX_PREFLIGHT_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function stop(
  proc: Bun.Subprocess<"pipe", "pipe", "pipe">,
  reader: JsonRpcReader,
  stderrRead: Promise<void>,
): Promise<void> {
  try {
    proc.stdin.end();
  } catch {
    // The server may already have closed its input.
  }
  await reader.close().catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exited = await Promise.race([
    proc.exited.then(() => true, () => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), CODEX_PREFLIGHT_SHUTDOWN_MS);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (!exited) {
    try {
      proc.kill();
    } catch {
      // The process may have exited between the wait and termination.
    }
  }
  await Promise.race([
    stderrRead.catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, CODEX_PREFLIGHT_SHUTDOWN_MS)),
  ]);
}

async function writeMessage(
  proc: Bun.Subprocess<"pipe", "pipe", "pipe">,
  message: unknown,
): Promise<void> {
  proc.stdin.write(`${JSON.stringify(message)}\n`);
  await proc.stdin.flush();
}

/**
 * Start an ephemeral Codex app-server thread without sending a model turn and
 * attest its resolved authority. This is a zero-token pre-work gate.
 */
export async function preflightCodexExecutionPolicy(
  binary: string,
  descriptor: SessionDescriptor,
  request: TurnRequest,
  env: Record<string, string | undefined>,
): Promise<NarrowExecutionPolicy> {
  const policy = requestedPolicy(request);
  const invocation = commandInvocation(binary, ["app-server", "--stdio", "--strict-config"], env);
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn(invocation, {
      cwd: descriptor.workdir,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    throw new CodexPreflightError("Codex preflight process launch failed");
  }
  const reader = new JsonRpcReader(proc.stdout);
  const stderrRead = drain(proc.stderr);
  try {
    await writeMessage(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "andromeda-manager", title: "Andromeda Manager", version: "0.1.0" },
        capabilities: {
          // runtimeWorkspaceRoots is experimental in the pinned app-server
          // protocol. Opt in so the pre-work receipt proves there is exactly
          // one writable project root rather than merely trusting cwd.
          experimentalApi: true,
          requestAttestation: false,
          optOutNotificationMethods: [],
        },
      },
    });
    const initialized = await bounded(reader.response(1), proc);
    await writeMessage(proc, { jsonrpc: "2.0", method: "initialized" });
    await writeMessage(proc, {
      jsonrpc: "2.0",
      id: 2,
      method: "thread/start",
      params: {
        model: descriptor.model,
        allowProviderModelFallback: false,
        cwd: descriptor.workdir,
        runtimeWorkspaceRoots: [descriptor.workdir],
        approvalPolicy: "never",
        permissions: permissionProfile(policy),
        config: preflightConfig(request, policy),
        ephemeral: true,
        historyMode: "legacy",
        environments: [],
        dynamicTools: [],
        selectedCapabilityRoots: [],
      },
    });
    const started = await bounded(reader.response(2), proc);
    return attestCodexPreworkResponse(descriptor, request, initialized, started);
  } catch (error) {
    if (error instanceof CodexPreflightError) throw error;
    throw new CodexPreflightError("Codex preflight failed");
  } finally {
    await stop(proc, reader, stderrRead);
  }
}
