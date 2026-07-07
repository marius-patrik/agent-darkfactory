import path from "node:path";
import { mkdir, stat } from "node:fs/promises";

export interface SessionStateRoot {
  root: string;
  stateDir: string;
  sessionsDir: string;
}

export type SessionMode = "chat" | "task" | "orchestrator" | "default";
export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface TranscriptMessage {
  role: MessageRole;
  content: string;
  name?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface Usage {
  tokensIn?: number;
  tokensOut?: number;
  totalTokens?: number;
}

export interface QuotaSurface {
  remaining?: number;
  resetAt?: string;
  limit?: number;
}

export interface SessionTranscript {
  schemaVersion: 1;
  sessionId: string;
  provider: string;
  model: string;
  mode: SessionMode;
  createdAt: string;
  updatedAt: string;
  messages: TranscriptMessage[];
}

export interface SessionState {
  schemaVersion: 1;
  sessionId: string;
  workdir: string;
  provider: string;
  model: string;
  mode: SessionMode;
  turnCount: number;
  lastTurnAt?: string;
  metadata: Record<string, unknown>;
}

export interface SessionDescriptor {
  sessionId: string;
  provider: string;
  model: string;
  mode: SessionMode;
  workdir: string;
  stateDir: string;
}

export interface TurnRequest {
  prompt: string;
  systemPrompt?: string;
  stream?: boolean;
}

export interface TurnResult {
  content: string;
  role: MessageRole;
  usage?: Usage;
  quota?: QuotaSurface;
  finishReason?: string;
  error?: string;
}

export interface TurnChunk {
  type: "text" | "usage" | "quota" | "finish" | "error";
  delta?: string;
  usage?: Usage;
  quota?: QuotaSurface;
  finishReason?: string;
  error?: string;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly supportsStreaming: boolean;
  startSession(descriptor: SessionDescriptor): Promise<void>;
  continueSession(descriptor: SessionDescriptor, transcript: SessionTranscript): Promise<void>;
  runTurn(descriptor: SessionDescriptor, transcript: SessionTranscript, request: TurnRequest): Promise<TurnResult>;
  streamTurn?(
    descriptor: SessionDescriptor,
    transcript: SessionTranscript,
    request: TurnRequest,
  ): AsyncGenerator<TurnChunk>;
}

export function sessionsDir(state: SessionStateRoot): string {
  return state.sessionsDir;
}

export function sessionPaths(state: SessionStateRoot, sessionId: string) {
  const dir = path.join(state.sessionsDir, sessionId);
  return {
    dir,
    transcriptFile: path.join(dir, "transcript.json"),
    stateFile: path.join(dir, "state.json"),
  };
}

function newSessionId(): string {
  const stamp = Date.now().toString(36).padStart(9, "0");
  const random = Math.random().toString(36).slice(2, 10);
  return `${stamp}-${random}`;
}

export async function createSession(
  state: SessionStateRoot,
  options: {
    provider: string;
    model: string;
    mode?: SessionMode;
    workdir?: string;
    sessionId?: string;
  },
): Promise<SessionDescriptor> {
  const sessionId = options.sessionId ?? newSessionId();
  const workdir = options.workdir ?? state.root;
  const mode = options.mode ?? "chat";
  const descriptor: SessionDescriptor = {
    sessionId,
    provider: options.provider,
    model: options.model,
    mode,
    workdir,
    stateDir: state.stateDir,
  };

  const paths = sessionPaths(state, sessionId);
  await mkdir(paths.dir, { recursive: true });

  const now = new Date().toISOString();
  const transcript: SessionTranscript = {
    schemaVersion: 1,
    sessionId,
    provider: options.provider,
    model: options.model,
    mode,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };

  const sessionState: SessionState = {
    schemaVersion: 1,
    sessionId,
    workdir,
    provider: options.provider,
    model: options.model,
    mode,
    turnCount: 0,
    metadata: {},
  };

  await Promise.all([saveTranscript(state, transcript), saveSessionState(state, sessionState)]);
  return descriptor;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

export async function loadTranscript(state: SessionStateRoot, sessionId: string): Promise<SessionTranscript | null> {
  const { transcriptFile } = sessionPaths(state, sessionId);
  if (!(await exists(transcriptFile))) return null;
  return JSON.parse(await Bun.file(transcriptFile).text()) as SessionTranscript;
}

export async function saveTranscript(state: SessionStateRoot, transcript: SessionTranscript): Promise<void> {
  const { transcriptFile } = sessionPaths(state, transcript.sessionId);
  await mkdir(path.dirname(transcriptFile), { recursive: true });
  await Bun.write(transcriptFile, `${JSON.stringify(transcript, null, 2)}\n`);
}

export async function loadSessionState(state: SessionStateRoot, sessionId: string): Promise<SessionState | null> {
  const { stateFile } = sessionPaths(state, sessionId);
  if (!(await exists(stateFile))) return null;
  return JSON.parse(await Bun.file(stateFile).text()) as SessionState;
}

export async function saveSessionState(state: SessionStateRoot, sessionState: SessionState): Promise<void> {
  const { stateFile } = sessionPaths(state, sessionState.sessionId);
  await mkdir(path.dirname(stateFile), { recursive: true });
  await Bun.write(stateFile, `${JSON.stringify(sessionState, null, 2)}\n`);
}

export async function listSessions(state: SessionStateRoot): Promise<SessionDescriptor[]> {
  const dir = sessionsDir(state);
  if (!(await exists(dir))) return [];
  const out: SessionDescriptor[] = [];
  const { opendir } = await import("node:fs/promises");
  for await (const entry of await opendir(dir)) {
    if (!entry.isDirectory()) continue;
    const sessionState = await loadSessionState(state, entry.name);
    if (!sessionState) continue;
    out.push({
      sessionId: sessionState.sessionId,
      provider: sessionState.provider,
      model: sessionState.model,
      mode: sessionState.mode,
      workdir: sessionState.workdir,
      stateDir: state.stateDir,
    });
  }
  return out.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

export async function runSessionTurn(
  state: SessionStateRoot,
  adapter: ProviderAdapter,
  descriptor: SessionDescriptor,
  request: TurnRequest,
): Promise<TurnResult> {
  await adapter.startSession(descriptor);
  const transcript = (await loadTranscript(state, descriptor.sessionId)) ?? emptyTranscript(descriptor);
  await adapter.continueSession(descriptor, transcript);

  if (request.systemPrompt) {
    const hasSystem = transcript.messages.some((m) => m.role === "system");
    if (!hasSystem) {
      transcript.messages.unshift({ role: "system", content: request.systemPrompt });
    }
  }

  transcript.messages.push({ role: "user", content: request.prompt });
  const result = await adapter.runTurn(descriptor, transcript, request);

  if (result.error) {
    transcript.messages.push({ role: "assistant", content: result.error, metadata: { error: true } });
  } else {
    transcript.messages.push({
      role: "assistant",
      content: result.content,
      metadata: {
        usage: result.usage,
        quota: result.quota,
        finishReason: result.finishReason,
      },
    });
  }

  const sessionState = (await loadSessionState(state, descriptor.sessionId)) ?? emptyState(descriptor);
  sessionState.turnCount += 1;
  sessionState.lastTurnAt = new Date().toISOString();
  transcript.updatedAt = sessionState.lastTurnAt;

  await Promise.all([saveTranscript(state, transcript), saveSessionState(state, sessionState)]);
  return result;
}

export async function* streamSessionTurn(
  state: SessionStateRoot,
  adapter: ProviderAdapter,
  descriptor: SessionDescriptor,
  request: TurnRequest,
): AsyncGenerator<TurnChunk> {
  await adapter.startSession(descriptor);
  const transcript = (await loadTranscript(state, descriptor.sessionId)) ?? emptyTranscript(descriptor);
  await adapter.continueSession(descriptor, transcript);

  if (request.systemPrompt) {
    const hasSystem = transcript.messages.some((m) => m.role === "system");
    if (!hasSystem) {
      transcript.messages.unshift({ role: "system", content: request.systemPrompt });
    }
  }

  transcript.messages.push({ role: "user", content: request.prompt });

  let content = "";
  let usage: Usage | undefined;
  let quota: QuotaSurface | undefined;
  let finishReason: string | undefined;
  let error: string | undefined;

  try {
    if (!adapter.streamTurn) {
      const result = await adapter.runTurn(descriptor, transcript, request);
      content = result.content;
      usage = result.usage;
      quota = result.quota;
      finishReason = result.finishReason;
      error = result.error;
      if (error) {
        yield { type: "error", error };
      } else {
        yield { type: "text", delta: content };
        if (usage) yield { type: "usage", usage };
        if (quota) yield { type: "quota", quota };
        yield { type: "finish", finishReason };
      }
    } else {
      for await (const chunk of adapter.streamTurn(descriptor, transcript, request)) {
        if (chunk.type === "text" && chunk.delta) content += chunk.delta;
        if (chunk.type === "usage") usage = chunk.usage;
        if (chunk.type === "quota") quota = chunk.quota;
        if (chunk.type === "finish") finishReason = chunk.finishReason;
        if (chunk.type === "error") error = chunk.error;
        yield chunk;
      }
    }
  } finally {
    if (error) {
      transcript.messages.push({ role: "assistant", content: error, metadata: { error: true } });
    } else {
      transcript.messages.push({
        role: "assistant",
        content,
        metadata: { usage, quota, finishReason },
      });
    }

    const sessionState = (await loadSessionState(state, descriptor.sessionId)) ?? emptyState(descriptor);
    sessionState.turnCount += 1;
    sessionState.lastTurnAt = new Date().toISOString();
    transcript.updatedAt = sessionState.lastTurnAt;

    await Promise.all([saveTranscript(state, transcript), saveSessionState(state, sessionState)]);
  }
}

export async function switchSessionProvider(
  state: SessionStateRoot,
  sessionId: string,
  provider: string,
  model: string,
): Promise<SessionDescriptor> {
  const sessionState = await loadSessionState(state, sessionId);
  if (!sessionState) throw new Error(`session not found: ${sessionId}`);
  const transcript = await loadTranscript(state, sessionId);
  if (!transcript) throw new Error(`transcript not found: ${sessionId}`);

  sessionState.provider = provider;
  sessionState.model = model;
  transcript.provider = provider;
  transcript.model = model;
  transcript.updatedAt = new Date().toISOString();

  await Promise.all([saveTranscript(state, transcript), saveSessionState(state, sessionState)]);

  return {
    sessionId,
    provider,
    model,
    mode: sessionState.mode,
    workdir: sessionState.workdir,
    stateDir: state.stateDir,
  };
}

function emptyTranscript(descriptor: SessionDescriptor): SessionTranscript {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    sessionId: descriptor.sessionId,
    provider: descriptor.provider,
    model: descriptor.model,
    mode: descriptor.mode,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

function emptyState(descriptor: SessionDescriptor): SessionState {
  return {
    schemaVersion: 1,
    sessionId: descriptor.sessionId,
    workdir: descriptor.workdir,
    provider: descriptor.provider,
    model: descriptor.model,
    mode: descriptor.mode,
    turnCount: 0,
    metadata: {},
  };
}

export function describeSession(descriptor: SessionDescriptor): string {
  return `${descriptor.provider}/${descriptor.model} ${descriptor.mode} ${descriptor.sessionId}`;
}
