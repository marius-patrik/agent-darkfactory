import { createHash, randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import {
  acquireRenewableStateLock,
  withRenewableStateLock,
  type ActiveRenewableLock,
  type RenewableLockOptions,
} from "../manager/src/state-lock";
import { retryWindowsFileOperation, writeTextAtomic } from "../manager/src/state-v2";

export interface SessionStateRoot {
  root: string;
  stateDir: string;
  sessionsDir: string;
}

export interface SessionEventBatch {
  events: SessionEvent[];
  bytes: number;
}

export interface SessionEventReadOptions {
  maximumEvents?: number;
  maximumBytes?: number;
  maximumScannedEntries?: number;
}

export interface SessionCollectionReadOptions {
  maximumSessions?: number;
  maximumScannedEntries?: number;
  maximumEvents?: number;
  maximumBytes?: number;
  maximumEventScannedEntries?: number;
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

/** Generated projection. Canonical authority is the immutable session event stream. */
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

/** Generated projection. Canonical authority is the immutable session event stream. */
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
  /** Independent reasoning setting requested by the canonical caller. */
  effort?: "low" | "medium" | "high";
  /** Narrow manager-owned filesystem policy. Broader policies are not representable. */
  executionPolicy?: "read-only" | "workspace-write";
  /** Independent model tool surface. `none` is admitted only with provider-native zero-tool proof. */
  toolPolicy?: "standard" | "none";
  /** Logical agent preset selected by the canonical tier route. */
  agentPreset?: string;
}

export interface TurnResult {
  content: string;
  role: MessageRole;
  usage?: Usage;
  quota?: QuotaSurface;
  finishReason?: string;
  error?: string;
  /** Manager-recorded description of the concrete request sent for this turn (model, effort, preset). */
  receipt?: Record<string, unknown>;
  /** Provider-attested effective policy for requested-vs-resolved enforcement. */
  resolvedExecutionPolicy?: "read-only" | "workspace-write";
  /** Provider-attested effective tool surface for requested-vs-resolved enforcement. */
  resolvedToolPolicy?: "standard" | "none";
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

interface SessionEventBase {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  machineId: string;
  machineSequence: number;
  lamport: number;
  at: string;
  previousEventHash: string | null;
  eventHash: string;
}

export type SessionEvent = SessionEventBase &
  (
    | {
        type: "session.created";
        data: {
          provider: string;
          model: string;
          mode: SessionMode;
          workdir: string;
          metadata: Record<string, unknown>;
        };
      }
    | { type: "turn.started"; data: { turnId: string } }
    | { type: "message.appended"; data: { turnId: string; message: TranscriptMessage } }
    | {
        type: "turn.completed";
        data: {
          turnId: string;
          usage?: Usage;
          quota?: QuotaSurface;
          finishReason?: string;
          error?: string;
          receipt?: Record<string, unknown>;
        };
      }
    | {
        type: "provider.switched";
        data: {
          fromProvider: string;
          fromModel: string;
          provider: string;
          model: string;
        };
      }
  );

type SessionEventDraft = Omit<SessionEvent, keyof SessionEventBase | "type" | "data"> &
  Pick<SessionEvent, "type" | "data">;

export interface SessionProjection {
  state: SessionState;
  transcript: SessionTranscript;
}

export interface SessionIntegrityInspection {
  ok: boolean;
  sessions: number;
  events: number;
  eventIntegrity: boolean;
  projectionIntegrity: boolean;
  issues: string[];
}

export interface SessionLockOptions {
  leaseMs?: number;
  heartbeatMs?: number;
  waitMs?: number;
}

export type ActiveSessionLock = ActiveRenewableLock;

export interface SessionWriteTransaction {
  readonly sessionId: string;
  load(): Promise<SessionProjection | null>;
  verify(): Promise<void>;
  beginTurn(): Promise<string>;
  appendMessage(turnId: string, message: TranscriptMessage): Promise<SessionProjection>;
  completeTurn(
    turnId: string,
    result?: Pick<TurnResult, "usage" | "quota" | "finishReason" | "error" | "receipt">,
  ): Promise<SessionProjection>;
  switchProvider(provider: string, model: string): Promise<SessionDescriptor>;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const EVENT_FILE = /^(\d{16})-([A-Za-z0-9_-]+)\.json$/;
const SESSION_MODES = new Set<SessionMode>(["chat", "task", "orchestrator", "default"]);
const MESSAGE_ROLES = new Set<MessageRole>(["system", "user", "assistant", "tool"]);
const LOCK_WAIT_MS = 30_000;
const LOCK_LEASE_MS = 30 * 60_000;
const LOCK_HEARTBEAT_MS = 60_000;
const MAX_SESSION_EVENTS = 100_000;
const MAX_SESSION_EVENT_BYTES = 64 * 1024 * 1024;
const MAX_SESSION_EVENT_SCAN_ENTRIES = 200_000;
const MAX_CANONICAL_SESSIONS = 100_000;
const MAX_CANONICAL_SESSION_SCAN_ENTRIES = 200_000;

function canonicalReadLimit(value: number | undefined, ceiling: number, field: string): number {
  const limit = value ?? ceiling;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  if (limit > ceiling) {
    throw new Error(`${field} cannot exceed canonical ceiling ${ceiling}`);
  }
  return limit;
}

function canonicalSessionEventReadLimits(
  options: SessionEventReadOptions = {},
): Required<SessionEventReadOptions> {
  return {
    maximumEvents: canonicalReadLimit(options.maximumEvents, MAX_SESSION_EVENTS, "maximumEvents"),
    maximumBytes: canonicalReadLimit(options.maximumBytes, MAX_SESSION_EVENT_BYTES, "maximumBytes"),
    maximumScannedEntries: canonicalReadLimit(
      options.maximumScannedEntries,
      MAX_SESSION_EVENT_SCAN_ENTRIES,
      "maximumScannedEntries",
    ),
  };
}

function canonicalCollectionEventReadLimits(
  options: SessionCollectionReadOptions,
): Required<SessionEventReadOptions> {
  return {
    maximumEvents: canonicalReadLimit(options.maximumEvents, MAX_SESSION_EVENTS, "maximumEvents"),
    maximumBytes: canonicalReadLimit(options.maximumBytes, MAX_SESSION_EVENT_BYTES, "maximumBytes"),
    maximumScannedEntries: canonicalReadLimit(
      options.maximumEventScannedEntries,
      MAX_SESSION_EVENT_SCAN_ENTRIES,
      "maximumEventScannedEntries",
    ),
  };
}

type SessionCollectionEventBudgetField = "maximumEvents" | "maximumBytes" | "maximumEventScannedEntries";

interface SessionCollectionEventBudget {
  maximumEvents: number;
  maximumBytes: number;
  maximumEventScannedEntries: number;
  remainingEvents: number;
  remainingBytes: number;
  remainingEventScannedEntries: number;
  exhausted?: SessionCollectionEventBudgetField;
}

function createSessionCollectionEventBudget(
  limits: Required<SessionEventReadOptions>,
): SessionCollectionEventBudget {
  return {
    maximumEvents: limits.maximumEvents,
    maximumBytes: limits.maximumBytes,
    maximumEventScannedEntries: limits.maximumScannedEntries,
    remainingEvents: limits.maximumEvents,
    remainingBytes: limits.maximumBytes,
    remainingEventScannedEntries: limits.maximumScannedEntries,
  };
}

function collectionEventBudgetError(
  budget: SessionCollectionEventBudget,
  field: SessionCollectionEventBudgetField,
): Error {
  budget.exhausted = field;
  return new Error(`canonical session collection exceeds ${field} ${budget[field]}`);
}

function assertCollectionEventBudgetAvailable(budget: SessionCollectionEventBudget): void {
  if (budget.remainingEvents < 1) throw collectionEventBudgetError(budget, "maximumEvents");
  if (budget.remainingBytes < 1) throw collectionEventBudgetError(budget, "maximumBytes");
  if (budget.remainingEventScannedEntries < 1) {
    throw collectionEventBudgetError(budget, "maximumEventScannedEntries");
  }
}

function reserveCollectionEvent(budget: SessionCollectionEventBudget | undefined): void {
  if (!budget) return;
  if (budget.remainingEvents < 1) throw collectionEventBudgetError(budget, "maximumEvents");
  budget.remainingEvents -= 1;
}

function reserveCollectionEventBytes(budget: SessionCollectionEventBudget | undefined, size: bigint): void {
  if (!budget) return;
  if (size > BigInt(budget.remainingBytes)) throw collectionEventBudgetError(budget, "maximumBytes");
  budget.remainingBytes -= Number(size);
}

function reserveCollectionEventScanEntry(budget: SessionCollectionEventBudget | undefined): void {
  if (!budget) return;
  if (budget.remainingEventScannedEntries < 1) {
    throw collectionEventBudgetError(budget, "maximumEventScannedEntries");
  }
  budget.remainingEventScannedEntries -= 1;
}

/** Fixed canonical write preflight; callers cannot supply alternate limits. */
export function assertSessionAppendWithinBounds(
  existingEventCount: number,
  existingBytes: number,
  nextEventBytes: number,
): void {
  for (const [label, value] of [
    ["existingEventCount", existingEventCount],
    ["existingBytes", existingBytes],
    ["nextEventBytes", nextEventBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  }
  if (existingEventCount + 1 > MAX_SESSION_EVENTS) {
    throw new Error(`canonical session append exceeds maximumEvents ${MAX_SESSION_EVENTS}`);
  }
  if (existingBytes + nextEventBytes > MAX_SESSION_EVENT_BYTES) {
    throw new Error(`canonical session append exceeds maximumBytes ${MAX_SESSION_EVENT_BYTES}`);
  }
}

export function sessionsDir(state: SessionStateRoot): string {
  return state.sessionsDir;
}

export function sessionPaths(state: SessionStateRoot, rawSessionId: string) {
  const sessionId = validateSessionId(rawSessionId);
  const dir = path.join(state.sessionsDir, sessionId);
  return {
    dir,
    eventsDir: path.join(dir, "events"),
    transcriptFile: path.join(dir, "transcript.json"),
    stateFile: path.join(dir, "state.json"),
  };
}

function validateSessionId(value: string): string {
  if (!SAFE_ID.test(value) || value === "." || value === "..") {
    throw new Error(`invalid session id: ${value}`);
  }
  return value;
}

function validateMachineId(value: unknown): string {
  if (typeof value !== "string" || !SAFE_ID.test(value) || value === "." || value === "..") {
    throw new Error("Agent OS manifest has an invalid machine id");
  }
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function requiredModel(value: unknown, field: string): string {
  const model = requiredString(value, field);
  if (model === "default") throw new Error(`${field} uses the retired default model sentinel`);
  return model;
}

function assertIsoTimestamp(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${field} must be a normalized ISO timestamp`);
  }
}

function assertPlainRecord(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${field} must be a plain object`);
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical events cannot contain non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("canonical events can contain only plain objects and arrays");
    }
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const member = (value as Record<string, unknown>)[key];
      if (member !== undefined) output[key] = canonicalize(member);
    }
    return output;
  }
  throw new Error(`canonical events cannot contain ${typeof value}`);
}

function eventDigest(value: Omit<SessionEvent, "eventHash">): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function canonicalClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(canonicalize(value))) as T;
}

function withoutEventHash(event: SessionEvent): Omit<SessionEvent, "eventHash"> {
  const { eventHash: _eventHash, ...unsigned } = event;
  return unsigned;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(directory, 0o700);
}

async function readMachineId(state: SessionStateRoot): Promise<string> {
  const manifestFile = path.join(state.stateDir, "manifest.json");
  let info;
  try {
    info = await lstat(manifestFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Agent OS manifest is required before session use: ${manifestFile}`);
    }
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Agent OS manifest must be a regular file: ${manifestFile}`);
  const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as { schemaVersion?: unknown; machineId?: unknown };
  if (manifest.schemaVersion !== 2) throw new Error(`Agent OS v2 manifest is required before session use: ${manifestFile}`);
  return validateMachineId(manifest.machineId);
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function tryCreatePrivateFile(filePath: string, content: string): Promise<boolean> {
  const directory = path.dirname(filePath);
  await ensurePrivateDirectory(directory);
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await retryWindowsFileOperation(() => link(temporary, filePath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    if (process.platform !== "win32") await chmod(filePath, 0o600);
    await syncDirectory(directory);
    return true;
  } finally {
    await retryWindowsFileOperation(() => rm(temporary, { force: true }));
  }
}

async function writeImmutableEvent(filePath: string, content: string): Promise<void> {
  if (!(await tryCreatePrivateFile(filePath, content))) {
    throw new Error(`canonical session event already exists: ${filePath}`);
  }
}

function newSessionId(): string {
  const stamp = Date.now().toString(36).padStart(9, "0");
  const random = randomUUID().replaceAll("-", "").slice(0, 12);
  return `${stamp}-${random}`;
}

async function acquireSessionLock(
  state: SessionStateRoot,
  sessionId: string,
  options: SessionLockOptions = {},
): Promise<ActiveSessionLock> {
  return acquireRenewableStateLock(state, `session:${sessionId}`, sessionLockOptions(sessionId, options));
}

function sessionLockOptions(sessionId: string, options: SessionLockOptions): RenewableLockOptions {
  const leaseMs = options.leaseMs ?? LOCK_LEASE_MS;
  return {
    leaseMs,
    heartbeatMs: options.heartbeatMs ?? Math.min(LOCK_HEARTBEAT_MS, Math.max(1, Math.floor(leaseMs / 3))),
    waitMs: options.waitMs ?? LOCK_WAIT_MS,
    owner: `session:${sessionId}`,
  };
}

export async function withSessionWriteLock<T>(
  state: SessionStateRoot,
  rawSessionId: string,
  callback: (lock: ActiveSessionLock) => Promise<T>,
  options: SessionLockOptions = {},
): Promise<T> {
  const sessionId = validateSessionId(rawSessionId);
  return withRenewableStateLock(state, `session:${sessionId}`, callback, sessionLockOptions(sessionId, options));
}

function assertTranscriptMessage(value: unknown, field: string): asserts value is TranscriptMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  const message = value as Partial<TranscriptMessage>;
  if (!MESSAGE_ROLES.has(message.role as MessageRole)) throw new Error(`${field}.role is invalid`);
  if (typeof message.content !== "string") throw new Error(`${field}.content must be a string`);
  if (message.name !== undefined && typeof message.name !== "string") throw new Error(`${field}.name must be a string`);
  if (message.toolCallId !== undefined && typeof message.toolCallId !== "string") {
    throw new Error(`${field}.toolCallId must be a string`);
  }
  if (message.metadata !== undefined) assertPlainRecord(message.metadata, `${field}.metadata`);
  if (message.toolCalls !== undefined) {
    if (!Array.isArray(message.toolCalls)) throw new Error(`${field}.toolCalls must be an array`);
    for (const [index, call] of message.toolCalls.entries()) {
      if (!call || typeof call !== "object" || Array.isArray(call)) throw new Error(`${field}.toolCalls[${index}] is invalid`);
      const item = call as Partial<ToolCall>;
      if (typeof item.id !== "string" || item.type !== "function" || !item.function) {
        throw new Error(`${field}.toolCalls[${index}] is invalid`);
      }
      requiredString(item.function.name, `${field}.toolCalls[${index}].function.name`);
      if (typeof item.function.arguments !== "string") {
        throw new Error(`${field}.toolCalls[${index}].function.arguments must be a string`);
      }
    }
  }
}

function assertSessionEvent(value: unknown, filePath: string): asserts value is SessionEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid session event: ${filePath}`);
  const event = value as Partial<SessionEvent>;
  if (
    event.schemaVersion !== 1 ||
    typeof event.id !== "string" ||
    !SAFE_ID.test(event.id) ||
    typeof event.sessionId !== "string" ||
    typeof event.machineId !== "string" ||
    !Number.isSafeInteger(event.machineSequence) ||
    (event.machineSequence ?? 0) < 1 ||
    !Number.isSafeInteger(event.lamport) ||
    (event.lamport ?? 0) < 1 ||
    typeof event.eventHash !== "string" ||
    !SHA256.test(event.eventHash) ||
    (event.previousEventHash !== null &&
      (typeof event.previousEventHash !== "string" || !SHA256.test(event.previousEventHash)))
  ) {
    throw new Error(`invalid session event envelope: ${filePath}`);
  }
  validateSessionId(event.sessionId);
  validateMachineId(event.machineId);
  assertIsoTimestamp(event.at, `session event at (${filePath})`);
  assertPlainRecord(event.data, `session event data (${filePath})`);

  if (event.type === "session.created") {
    requiredString(event.data.provider, "session.created provider");
    requiredModel(event.data.model, "session.created model");
    requiredString(event.data.workdir, "session.created workdir");
    if (!SESSION_MODES.has(event.data.mode as SessionMode)) throw new Error(`invalid session mode: ${filePath}`);
    assertPlainRecord(event.data.metadata, "session.created metadata");
  } else if (event.type === "turn.started") {
    requiredString(event.data.turnId, "turn.started turnId");
  } else if (event.type === "message.appended") {
    requiredString(event.data.turnId, "message.appended turnId");
    assertTranscriptMessage(event.data.message, "message.appended message");
  } else if (event.type === "turn.completed") {
    requiredString(event.data.turnId, "turn.completed turnId");
    if (event.data.receipt !== undefined) assertPlainRecord(event.data.receipt, "turn.completed receipt");
  } else if (event.type === "provider.switched") {
    requiredString(event.data.fromProvider, "provider.switched fromProvider");
    requiredString(event.data.fromModel, "provider.switched fromModel");
    requiredString(event.data.provider, "provider.switched provider");
    requiredModel(event.data.model, "provider.switched model");
  } else {
    throw new Error(`unknown session event type in ${filePath}`);
  }

  const expected = eventDigest(withoutEventHash(event as SessionEvent));
  if (event.eventHash !== expected) throw new Error(`session event hash mismatch: ${filePath}`);
}

interface DirectoryIdentity {
  device: number | bigint;
  inode: number | bigint;
  modifiedAtMs: number | bigint;
  changedAtMs: number | bigint;
}

interface DirectoryAdmission {
  admissionChanged?: boolean;
  admissionWatcher?: FSWatcher;
  directoryPath: string;
  identity: DirectoryIdentity;
}

function directoryIdentity(
  info: {
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    dev: number | bigint;
    ino: number | bigint;
    mtimeMs: number | bigint;
    ctimeMs: number | bigint;
  },
  directoryPath: string,
): DirectoryIdentity {
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`canonical session directory must be physical: ${directoryPath}`);
  }
  return {
    device: info.dev,
    inode: info.ino,
    modifiedAtMs: info.mtimeMs,
    changedAtMs: info.ctimeMs,
  };
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.modifiedAtMs === right.modifiedAtMs &&
    left.changedAtMs === right.changedAtMs
  );
}

async function assertDirectoryIdentity(
  directoryPath: string,
  expected: DirectoryIdentity,
): Promise<void> {
  const current = await lstat(directoryPath);
  const actual = directoryIdentity(current, directoryPath);
  if (!sameDirectoryIdentity(actual, expected)) {
    throw new Error(`canonical session directory changed during admission: ${directoryPath}`);
  }
}

async function openDirectoryAdmission(
  directoryPath: string,
  admitted: Awaited<ReturnType<typeof lstat>>,
): Promise<DirectoryAdmission> {
  const identity = directoryIdentity(admitted, directoryPath);
  // Retain a native watcher handle before traversal. Bun's FileHandle and Dir
  // implementations can reuse one underlying descriptor, so a separate open()
  // handle is not stable across opendir(). The watcher pins the admitted inode,
  // reports replacement, and is paired with dev/inode checks at every read step.
  const admission: DirectoryAdmission = {
    admissionChanged: false,
    directoryPath,
    identity,
  };
  try {
    admission.admissionWatcher = watch(directoryPath, { persistent: false }, (eventType) => {
      if (eventType === "rename") admission.admissionChanged = true;
    });
    admission.admissionWatcher.on("error", () => {
      admission.admissionChanged = true;
    });
    // Let Linux expose the inotify registration before any pathname traversal.
    if (process.platform === "linux") await Bun.sleep(1);
    await assertDirectoryIdentity(directoryPath, identity);
    return admission;
  } catch (error) {
    admission.admissionWatcher?.close();
    throw error;
  }
}

async function openPinnedDirectory(
  directoryPath: string,
  admitted: Awaited<ReturnType<typeof lstat>>,
) {
  const admission = await openDirectoryAdmission(directoryPath, admitted);
  let directory: Awaited<ReturnType<typeof opendir>> | undefined;
  try {
    directory = await opendir(directoryPath);
    await assertPinnedDirectories(admission);
    return Object.assign(admission, { directory });
  } catch (error) {
    try {
      if (directory) await directory.close();
    } finally {
      await closeDirectoryAdmission(admission);
    }
    throw error;
  }
}

async function assertPinnedDirectories(
  ...directories: DirectoryAdmission[]
): Promise<void> {
  for (const directory of directories) {
    if (directory.admissionChanged) {
      throw new Error(`canonical session directory changed during admission: ${directory.directoryPath}`);
    }
    await assertDirectoryIdentity(directory.directoryPath, directory.identity);
  }
}

async function closeDirectoryAdmission(directory: DirectoryAdmission): Promise<void> {
  directory.admissionWatcher?.close();
}

interface AdmittedFileIdentity {
  filePath: string;
  device: bigint;
  inode: bigint;
  size: number;
  modifiedAtNs: bigint;
}

interface SessionEventFileAdmission extends AdmittedFileIdentity {
  machineId: string;
  machineSequence: number;
  eventId: string;
  admissionContentHash: string;
  machineDirectory: string;
  machineIdentity: DirectoryIdentity;
}

function sessionEventContentHash(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function isAdmittedFile(
  info: {
    isFile(): boolean;
    dev: bigint;
    ino: bigint;
    size: bigint;
    mtimeNs: bigint;
  },
  expected: AdmittedFileIdentity,
): boolean {
  return (
    info.isFile() &&
    info.dev === expected.device &&
    info.ino === expected.inode &&
    info.size === BigInt(expected.size) &&
    info.mtimeNs === expected.modifiedAtNs
  );
}

async function readAdmittedFile(
  admittedFile: AdmittedFileIdentity,
  assertTree: () => Promise<void>,
  description: string,
): Promise<Buffer> {
  await assertTree();
  const handle = await open(admittedFile.filePath, "r");
  try {
    await assertTree();
    if (!isAdmittedFile(await handle.stat({ bigint: true }), admittedFile)) {
      throw new Error(`${description} changed during admission: ${admittedFile.filePath}`);
    }
    const content = Buffer.alloc(admittedFile.size);
    let offset = 0;
    while (offset < content.length) {
      const { bytesRead } = await handle.read(content, offset, content.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== admittedFile.size) {
      throw new Error(`${description} changed during admission: ${admittedFile.filePath}`);
    }
    if (!isAdmittedFile(await handle.stat({ bigint: true }), admittedFile)) {
      throw new Error(`${description} changed during admission: ${admittedFile.filePath}`);
    }
    await assertTree();
    return content;
  } finally {
    await handle.close();
  }
}

async function readSessionEventsUnlocked(
  state: SessionStateRoot,
  rawSessionId: string,
  options: {
    allowEmpty?: boolean;
    sessionsRoot?: DirectoryAdmission;
    sessionDirectory?: DirectoryAdmission;
    collectionBudget?: SessionCollectionEventBudget;
  } & SessionEventReadOptions = {},
): Promise<SessionEventBatch> {
  const sessionId = validateSessionId(rawSessionId);
  const { maximumEvents, maximumBytes, maximumScannedEntries } = canonicalSessionEventReadLimits(options);
  const paths = sessionPaths(state, sessionId);
  const sessionAncestors = options.sessionsRoot ? [options.sessionsRoot] : [];
  await assertPinnedDirectories(...sessionAncestors);
  let pinnedSession: DirectoryAdmission;
  let ownsSessionAdmission = false;
  if (options.sessionDirectory) {
    if (path.resolve(options.sessionDirectory.directoryPath) !== path.resolve(paths.dir)) {
      throw new Error(`canonical session directory admission does not match session ${sessionId}`);
    }
    pinnedSession = options.sessionDirectory;
    await assertPinnedDirectories(...sessionAncestors, pinnedSession);
  } else {
    if (!(await pathExists(paths.dir))) return { events: [], bytes: 0 };
    await assertPinnedDirectories(...sessionAncestors);
    const sessionInfo = await lstat(paths.dir);
    await assertPinnedDirectories(...sessionAncestors);
    pinnedSession = await openDirectoryAdmission(paths.dir, sessionInfo);
    ownsSessionAdmission = true;
  }
  const assertSessionTree = (...descendants: DirectoryAdmission[]) =>
    assertPinnedDirectories(...sessionAncestors, pinnedSession, ...descendants);
  const eventFiles: SessionEventFileAdmission[] = [];
  const events: SessionEvent[] = [];
  let totalBytes = 0;
  let scannedEntries = 0;
  try {
    await assertSessionTree();
    if (!(await pathExists(paths.eventsDir))) {
      await assertSessionTree();
      if (options.allowEmpty) return { events: [], bytes: 0 };
      throw new Error(`canonical session events are missing; retired projections are not loadable: ${paths.eventsDir}`);
    }
    await assertSessionTree();
    const eventsInfo = await lstat(paths.eventsDir);
    const pinnedEvents = await openPinnedDirectory(paths.eventsDir, eventsInfo);
    try {
      for await (const machineEntry of pinnedEvents.directory) {
        await assertSessionTree(pinnedEvents);
        reserveCollectionEventScanEntry(options.collectionBudget);
        scannedEntries += 1;
        if (scannedEntries > maximumScannedEntries) {
          throw new Error(`canonical session ${sessionId} exceeds maximumScannedEntries ${maximumScannedEntries}`);
        }
        if (machineEntry.name.startsWith(".")) continue;
        validateMachineId(machineEntry.name);
        if (!machineEntry.isDirectory() || machineEntry.isSymbolicLink()) {
          throw new Error(`invalid machine partition in canonical session events: ${machineEntry.name}`);
        }
        await assertSessionTree(pinnedEvents);
        const machineDirectory = path.join(paths.eventsDir, machineEntry.name);
        const machineInfo = await lstat(machineDirectory);
        const pinnedMachine = await openPinnedDirectory(machineDirectory, machineInfo);
        try {
          for await (const fileEntry of pinnedMachine.directory) {
            await assertSessionTree(pinnedEvents, pinnedMachine);
            reserveCollectionEventScanEntry(options.collectionBudget);
            scannedEntries += 1;
            if (scannedEntries > maximumScannedEntries) {
              throw new Error(`canonical session ${sessionId} exceeds maximumScannedEntries ${maximumScannedEntries}`);
            }
            if (fileEntry.name.startsWith(".")) continue;
            if (!fileEntry.isFile() || fileEntry.isSymbolicLink()) {
              throw new Error(`invalid canonical session event entry: ${path.join(machineDirectory, fileEntry.name)}`);
            }
            const match = fileEntry.name.match(EVENT_FILE);
            if (!match) throw new Error(`invalid canonical session event filename: ${fileEntry.name}`);
            reserveCollectionEvent(options.collectionBudget);
            if (eventFiles.length >= maximumEvents) {
              throw new Error(`canonical session ${sessionId} exceeds maximumEvents ${maximumEvents}`);
            }
            await assertSessionTree(pinnedEvents, pinnedMachine);
            const filePath = path.join(machineDirectory, fileEntry.name);
            const fileInfo = await lstat(filePath, { bigint: true });
            if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) {
              throw new Error(`canonical session event must be a regular file: ${filePath}`);
            }
            await assertSessionTree(pinnedEvents, pinnedMachine);
            reserveCollectionEventBytes(options.collectionBudget, fileInfo.size);
            if (fileInfo.size > BigInt(maximumBytes - totalBytes)) {
              throw new Error(`canonical session ${sessionId} exceeds maximumBytes ${maximumBytes}`);
            }
            const fileSize = Number(fileInfo.size);
            totalBytes += fileSize;
            const fileIdentity: AdmittedFileIdentity = {
              filePath,
              device: fileInfo.dev,
              inode: fileInfo.ino,
              size: fileSize,
              modifiedAtNs: fileInfo.mtimeNs,
            };
            const admittedContent = await readAdmittedFile(
              fileIdentity,
              () => assertSessionTree(pinnedEvents, pinnedMachine),
              "canonical session event",
            );
            eventFiles.push({
              ...fileIdentity,
              machineId: machineEntry.name,
              machineSequence: Number(match[1]),
              eventId: match[2],
              admissionContentHash: sessionEventContentHash(admittedContent),
              machineDirectory,
              machineIdentity: pinnedMachine.identity,
            });
          }
          await assertSessionTree(pinnedEvents, pinnedMachine);
        } finally {
          await closeDirectoryAdmission(pinnedMachine);
        }
      }

      await assertSessionTree(pinnedEvents);
      const admittedMachines = new Map<
        string,
        { directoryPath: string; identity: DirectoryIdentity; files: typeof eventFiles }
      >();
      for (const eventFile of eventFiles) {
        const admitted = admittedMachines.get(eventFile.machineDirectory);
        if (admitted) {
          if (!sameDirectoryIdentity(admitted.identity, eventFile.machineIdentity)) {
            throw new Error(`canonical session machine identity is inconsistent: ${eventFile.machineDirectory}`);
          }
          admitted.files.push(eventFile);
        } else {
          admittedMachines.set(eventFile.machineDirectory, {
            directoryPath: eventFile.machineDirectory,
            identity: eventFile.machineIdentity,
            files: [eventFile],
          });
        }
      }
      for (const admittedMachine of admittedMachines.values()) {
        await assertSessionTree(pinnedEvents, admittedMachine);
        const pinnedMachine = await openDirectoryAdmission(
          admittedMachine.directoryPath,
          await lstat(admittedMachine.directoryPath),
        );
        try {
          if (!sameDirectoryIdentity(pinnedMachine.identity, admittedMachine.identity)) {
            throw new Error(`canonical session directory changed during admission: ${admittedMachine.directoryPath}`);
          }
          await assertSessionTree(pinnedEvents, pinnedMachine);
          for (const eventFile of admittedMachine.files) {
            const content = await readAdmittedFile(
              eventFile,
              () => assertSessionTree(pinnedEvents, pinnedMachine),
              "canonical session event",
            );
            if (sessionEventContentHash(content) !== eventFile.admissionContentHash) {
              throw new Error(`canonical session event content changed during admission: ${eventFile.filePath}`);
            }
            let parsed: unknown;
            try {
              parsed = JSON.parse(content.toString("utf8"));
            } catch (error) {
              throw new Error(`cannot parse canonical session event ${eventFile.filePath}: ${String(error)}`);
            }
            assertSessionEvent(parsed, eventFile.filePath);
            if (parsed.sessionId !== sessionId || parsed.machineId !== eventFile.machineId) {
              throw new Error(`session event path identity mismatch: ${eventFile.filePath}`);
            }
            if (parsed.machineSequence !== eventFile.machineSequence || parsed.id !== eventFile.eventId) {
              throw new Error(`session event filename identity mismatch: ${eventFile.filePath}`);
            }
            events.push(parsed);
          }
          await assertSessionTree(pinnedEvents, pinnedMachine);
        } finally {
          await closeDirectoryAdmission(pinnedMachine);
        }
      }
      await assertSessionTree(pinnedEvents);
    } finally {
      await closeDirectoryAdmission(pinnedEvents);
    }
  } finally {
    if (ownsSessionAdmission) await closeDirectoryAdmission(pinnedSession);
  }

  if (events.length === 0) {
    if (options.allowEmpty) return { events: [], bytes: 0 };
    throw new Error(`canonical session event stream is empty: ${paths.eventsDir}`);
  }
  events.sort(
    (left, right) =>
      left.lamport - right.lamport ||
      left.machineId.localeCompare(right.machineId) ||
      left.machineSequence - right.machineSequence ||
      left.id.localeCompare(right.id),
  );

  const eventIds = new Set<string>();
  const eventHashes = new Set<string>();
  const machineEvents = new Map<string, SessionEvent[]>();
  for (const event of events) {
    if (eventIds.has(event.id)) throw new Error(`duplicate canonical session event id: ${event.id}`);
    if (eventHashes.has(event.eventHash)) throw new Error(`duplicate canonical session event hash: ${event.eventHash}`);
    eventIds.add(event.id);
    eventHashes.add(event.eventHash);
    const partition = machineEvents.get(event.machineId) ?? [];
    partition.push(event);
    machineEvents.set(event.machineId, partition);
  }
  for (const [machineId, partition] of machineEvents) {
    partition.sort((left, right) => left.machineSequence - right.machineSequence);
    for (const [index, event] of partition.entries()) {
      if (event.machineSequence !== index + 1) {
        throw new Error(`non-contiguous machine event sequence for ${machineId}`);
      }
      const previous = partition[index - 1];
      if (event.previousEventHash !== (previous?.eventHash ?? null)) {
        throw new Error(`broken canonical session event chain at ${event.id}`);
      }
      if (previous && event.lamport <= previous.lamport) {
        throw new Error(`non-monotonic session Lamport clock at ${event.id}`);
      }
    }
  }
  return { events, bytes: totalBytes };
}

function replayEvents(events: SessionEvent[], sessionId: string): SessionProjection {
  if (events.length === 0 || events[0].type !== "session.created") {
    throw new Error(`canonical session ${sessionId} has no creation event`);
  }
  if (events.some((event, index) => index > 0 && event.type === "session.created")) {
    throw new Error(`canonical session ${sessionId} has multiple creation events`);
  }
  const created = events[0];
  if (created.type !== "session.created") throw new Error(`canonical session ${sessionId} has an invalid first event`);
  const state: SessionState = {
    schemaVersion: 1,
    sessionId,
    workdir: created.data.workdir,
    provider: created.data.provider,
    model: created.data.model,
    mode: created.data.mode,
    turnCount: 0,
    metadata: structuredClone(created.data.metadata),
  };
  const transcript: SessionTranscript = {
    schemaVersion: 1,
    sessionId,
    provider: created.data.provider,
    model: created.data.model,
    mode: created.data.mode,
    createdAt: created.at,
    updatedAt: created.at,
    messages: [],
  };
  const startedTurns = new Set<string>();
  const completedTurns = new Set<string>();

  for (const event of events.slice(1)) {
    transcript.updatedAt = event.at;
    if (event.type === "turn.started") {
      if (startedTurns.has(event.data.turnId)) throw new Error(`duplicate turn start in session ${sessionId}: ${event.data.turnId}`);
      startedTurns.add(event.data.turnId);
    } else if (event.type === "message.appended") {
      if (!startedTurns.has(event.data.turnId) || completedTurns.has(event.data.turnId)) {
        throw new Error(`message references an inactive turn in session ${sessionId}: ${event.data.turnId}`);
      }
      transcript.messages.push(structuredClone(event.data.message));
    } else if (event.type === "turn.completed") {
      if (!startedTurns.has(event.data.turnId) || completedTurns.has(event.data.turnId)) {
        throw new Error(`completion references an inactive turn in session ${sessionId}: ${event.data.turnId}`);
      }
      completedTurns.add(event.data.turnId);
      state.turnCount += 1;
      state.lastTurnAt = event.at;
    } else if (event.type === "provider.switched") {
      if (state.provider !== event.data.fromProvider || state.model !== event.data.fromModel) {
        throw new Error(`provider switch does not match projected session state at ${event.id}`);
      }
      state.provider = event.data.provider;
      state.model = event.data.model;
      transcript.provider = event.data.provider;
      transcript.model = event.data.model;
    }
  }
  return { state, transcript };
}

async function writeSessionProjections(state: SessionStateRoot, projection: SessionProjection): Promise<void> {
  const paths = sessionPaths(state, projection.state.sessionId);
  await ensurePrivateDirectory(paths.dir);
  await Promise.all([
    writeTextAtomic(paths.stateFile, `${JSON.stringify(projection.state, null, 2)}\n`, 0o600),
    writeTextAtomic(paths.transcriptFile, `${JSON.stringify(projection.transcript, null, 2)}\n`, 0o600),
  ]);
  await syncDirectory(paths.dir);
}

async function rebuildSessionProjectionsUnlocked(
  state: SessionStateRoot,
  sessionId: string,
  options: SessionEventReadOptions = {},
): Promise<SessionProjection | null> {
  const limits = canonicalSessionEventReadLimits(options);
  const paths = sessionPaths(state, sessionId);
  if (!(await pathExists(paths.dir))) return null;
  const { events } = await readSessionEventsUnlocked(state, sessionId, limits);
  const projection = replayEvents(events, sessionId);
  await writeSessionProjections(state, projection);
  return projection;
}

export async function rebuildSessionProjections(
  state: SessionStateRoot,
  rawSessionId: string,
  options: SessionEventReadOptions = {},
): Promise<SessionProjection | null> {
  const sessionId = validateSessionId(rawSessionId);
  const limits = canonicalSessionEventReadLimits(options);
  return withSessionWriteLock(state, sessionId, () => rebuildSessionProjectionsUnlocked(state, sessionId, limits));
}

export async function rebuildSessionProjectionsWhileLocked(
  state: SessionStateRoot,
  rawSessionId: string,
  options: SessionEventReadOptions = {},
): Promise<SessionProjection | null> {
  return rebuildSessionProjectionsUnlocked(state, validateSessionId(rawSessionId), options);
}

export async function loadSessionEventBatch(
  state: SessionStateRoot,
  rawSessionId: string,
  options: SessionEventReadOptions = {},
): Promise<SessionEventBatch> {
  const sessionId = validateSessionId(rawSessionId);
  const limits = canonicalSessionEventReadLimits(options);
  return withSessionWriteLock(state, sessionId, async () => {
    const paths = sessionPaths(state, sessionId);
    if (!(await pathExists(paths.dir))) return { events: [], bytes: 0 };
    return readSessionEventsUnlocked(state, sessionId, limits);
  });
}

export async function loadSessionEvents(
  state: SessionStateRoot,
  rawSessionId: string,
  options: SessionEventReadOptions = {},
): Promise<SessionEvent[]> {
  return (await loadSessionEventBatch(state, rawSessionId, options)).events;
}

async function appendSessionEventUnlocked(
  state: SessionStateRoot,
  sessionId: string,
  machineId: string,
  draft: SessionEventDraft,
  options: { allowEmpty?: boolean; at?: Date } = {},
): Promise<SessionProjection> {
  const existing = await readSessionEventsUnlocked(state, sessionId, { allowEmpty: options.allowEmpty });
  const { events } = existing;
  const machineEvents = events.filter((event) => event.machineId === machineId);
  const machineSequence = machineEvents.length + 1;
  const unsigned = {
    schemaVersion: 1 as const,
    id: randomUUID().replaceAll("-", ""),
    sessionId,
    machineId,
    machineSequence,
    lamport: events.length + 1,
    at: (options.at ?? new Date()).toISOString(),
    previousEventHash: machineEvents.at(-1)?.eventHash ?? null,
    type: draft.type,
    data: canonicalClone(draft.data),
  } as Omit<SessionEvent, "eventHash">;
  const event = { ...unsigned, eventHash: eventDigest(unsigned) } as SessionEvent;
  const eventContent = `${JSON.stringify(event, null, 2)}\n`;
  assertSessionAppendWithinBounds(events.length, existing.bytes, Buffer.byteLength(eventContent));
  const machineDirectory = path.join(sessionPaths(state, sessionId).eventsDir, machineId);
  await ensurePrivateDirectory(machineDirectory);
  const eventFile = path.join(machineDirectory, `${String(machineSequence).padStart(16, "0")}-${event.id}.json`);
  await writeImmutableEvent(eventFile, eventContent);
  const nextEvents = [...events, event];
  const projection = replayEvents(nextEvents, sessionId);
  await writeSessionProjections(state, projection);
  return projection;
}

async function appendSessionEvent(
  state: SessionStateRoot,
  rawSessionId: string,
  draft: SessionEventDraft,
): Promise<SessionProjection> {
  const sessionId = validateSessionId(rawSessionId);
  return withSessionWriteLock(state, sessionId, async () => {
    const machineId = await readMachineId(state);
    return appendSessionEventUnlocked(state, sessionId, machineId, draft);
  });
}

export async function withSessionWriteTransaction<T>(
  state: SessionStateRoot,
  rawSessionId: string,
  callback: (transaction: SessionWriteTransaction) => Promise<T>,
  options: SessionLockOptions = {},
): Promise<T> {
  const sessionId = validateSessionId(rawSessionId);
  return withSessionWriteLock(
    state,
    sessionId,
    async (lock) => {
      const machineId = await readMachineId(state);
      const append = async (draft: SessionEventDraft): Promise<SessionProjection> => {
        await lock.verify();
        const projection = await appendSessionEventUnlocked(state, sessionId, machineId, draft);
        await lock.verify();
        return projection;
      };
      const transaction: SessionWriteTransaction = {
        sessionId,
        load: async () => {
          await lock.verify();
          const projection = await rebuildSessionProjectionsUnlocked(state, sessionId);
          await lock.verify();
          return projection;
        },
        verify: () => lock.verify(),
        beginTurn: async () => {
          const turnId = randomUUID().replaceAll("-", "");
          await append({ type: "turn.started", data: { turnId } });
          return turnId;
        },
        appendMessage: async (turnId, message) => {
          assertTranscriptMessage(message, "session message");
          return append({
            type: "message.appended",
            data: { turnId: requiredString(turnId, "turn id"), message: structuredClone(message) },
          });
        },
        completeTurn: (turnId, result = {}) =>
          append({
            type: "turn.completed",
            data: {
              turnId: requiredString(turnId, "turn id"),
              usage: result.usage,
              quota: result.quota,
              finishReason: result.finishReason,
              error: result.error,
              receipt: result.receipt,
            },
          }),
        switchProvider: async (provider, model) => {
          requiredString(provider, "session provider");
          requiredModel(model, "session model");
          const projection = await rebuildSessionProjectionsUnlocked(state, sessionId);
          if (!projection) throw new Error(`session not found: ${sessionId}`);
          if (projection.state.provider === provider && projection.state.model === model) {
            return descriptorFromProjection(state, projection);
          }
          const next = await append({
            type: "provider.switched",
            data: {
              fromProvider: projection.state.provider,
              fromModel: projection.state.model,
              provider,
              model,
            },
          });
          return descriptorFromProjection(state, next);
        },
      };
      return callback(transaction);
    },
    options,
  );
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
  const machineId = await readMachineId(state);
  const sessionId = validateSessionId(options.sessionId ?? newSessionId());
  const workdir = options.workdir ?? state.root;
  const mode = options.mode ?? "chat";
  requiredString(options.provider, "session provider");
  requiredModel(options.model, "session model");
  requiredString(workdir, "session workdir");
  if (!SESSION_MODES.has(mode)) throw new Error(`invalid session mode: ${mode}`);

  await ensurePrivateDirectory(state.sessionsDir);
  const paths = sessionPaths(state, sessionId);
  try {
    await mkdir(paths.dir, { recursive: false, mode: 0o700 });
    if (process.platform !== "win32") await chmod(paths.dir, 0o700);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`session id collision: ${sessionId}`);
    throw error;
  }

  try {
    await withSessionWriteLock(state, sessionId, () =>
      appendSessionEventUnlocked(
        state,
        sessionId,
        machineId,
        {
          type: "session.created",
          data: { provider: options.provider, model: options.model, mode, workdir, metadata: {} },
        },
        { allowEmpty: true },
      ),
    );
  } catch (error) {
    await rm(paths.dir, { recursive: true, force: true });
    throw error;
  }

  return { sessionId, provider: options.provider, model: options.model, mode, workdir, stateDir: state.stateDir };
}

export async function loadTranscript(
  state: SessionStateRoot,
  rawSessionId: string,
  options: SessionEventReadOptions = {},
): Promise<SessionTranscript | null> {
  const projection = await rebuildSessionProjections(state, rawSessionId, options);
  return projection?.transcript ?? null;
}

export async function loadSessionState(
  state: SessionStateRoot,
  rawSessionId: string,
  options: SessionEventReadOptions = {},
): Promise<SessionState | null> {
  const projection = await rebuildSessionProjections(state, rawSessionId, options);
  return projection?.state ?? null;
}

async function collectSessionIds(
  pinnedRoot: DirectoryAdmission,
  directory: Awaited<ReturnType<typeof opendir>>,
  maximumSessions: number,
  maximumScannedEntries: number,
): Promise<string[]> {
  const sessionIds: string[] = [];
  let scannedEntries = 0;
  for await (const entry of directory) {
    scannedEntries += 1;
    if (scannedEntries > maximumScannedEntries) {
      throw new Error(`canonical session scan exceeds maximumScannedEntries ${maximumScannedEntries}`);
    }
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`invalid entry in canonical sessions directory: ${entry.name}`);
    }
    await assertPinnedDirectories(pinnedRoot);
    sessionIds.push(validateSessionId(entry.name));
    if (sessionIds.length > maximumSessions) {
      throw new Error(`canonical session scan exceeds maximumSessions ${maximumSessions}`);
    }
  }
  await assertPinnedDirectories(pinnedRoot);
  return sessionIds.sort((left, right) => left.localeCompare(right));
}

export async function listSessionIds(
  state: SessionStateRoot,
  options: { maximumSessions?: number; maximumScannedEntries?: number } = {},
): Promise<string[]> {
  const maximumSessions = canonicalReadLimit(options.maximumSessions, MAX_CANONICAL_SESSIONS, "maximumSessions");
  const maximumScannedEntries = canonicalReadLimit(
    options.maximumScannedEntries,
    MAX_CANONICAL_SESSION_SCAN_ENTRIES,
    "maximumScannedEntries",
  );
  if (!(await pathExists(state.sessionsDir))) return [];
  const rootInfo = await lstat(state.sessionsDir);
  const pinnedRoot = await openPinnedDirectory(state.sessionsDir, rootInfo);
  try {
    return collectSessionIds(pinnedRoot, pinnedRoot.directory, maximumSessions, maximumScannedEntries);
  } finally {
    await closeDirectoryAdmission(pinnedRoot);
  }
}

export async function listSessions(
  state: SessionStateRoot,
  options: SessionCollectionReadOptions = {},
): Promise<SessionDescriptor[]> {
  const maximumSessions = canonicalReadLimit(options.maximumSessions, MAX_CANONICAL_SESSIONS, "maximumSessions");
  const maximumScannedEntries = canonicalReadLimit(
    options.maximumScannedEntries,
    MAX_CANONICAL_SESSION_SCAN_ENTRIES,
    "maximumScannedEntries",
  );
  const eventLimits = canonicalCollectionEventReadLimits(options);
  const eventBudget = createSessionCollectionEventBudget(eventLimits);
  if (!(await pathExists(state.sessionsDir))) return [];
  const rootInfo = await lstat(state.sessionsDir);
  const pinnedRoot = await openPinnedDirectory(state.sessionsDir, rootInfo);
  const output: SessionDescriptor[] = [];
  try {
    const sessionIds = await collectSessionIds(
      pinnedRoot,
      pinnedRoot.directory,
      maximumSessions,
      maximumScannedEntries,
    );
    for (const sessionId of sessionIds) {
      await assertPinnedDirectories(pinnedRoot);
      assertCollectionEventBudgetAvailable(eventBudget);
      const sessionState = await withSessionWriteLock(state, sessionId, async () => {
        const { events } = await readSessionEventsUnlocked(state, sessionId, {
          ...eventLimits,
          sessionsRoot: pinnedRoot,
          collectionBudget: eventBudget,
        });
        return replayEvents(events, sessionId).state;
      });
      await assertPinnedDirectories(pinnedRoot);
      output.push({
        sessionId: sessionState.sessionId,
        provider: sessionState.provider,
        model: sessionState.model,
        mode: sessionState.mode,
        workdir: sessionState.workdir,
        stateDir: state.stateDir,
      });
    }
    return output;
  } finally {
    await closeDirectoryAdmission(pinnedRoot);
  }
}

export async function inspectSessionIntegrity(
  state: SessionStateRoot,
  options: SessionCollectionReadOptions = {},
): Promise<SessionIntegrityInspection> {
  const maximumSessions = canonicalReadLimit(options.maximumSessions, MAX_CANONICAL_SESSIONS, "maximumSessions");
  const maximumScannedEntries = canonicalReadLimit(
    options.maximumScannedEntries,
    MAX_CANONICAL_SESSION_SCAN_ENTRIES,
    "maximumScannedEntries",
  );
  const eventLimits = canonicalCollectionEventReadLimits(options);
  const eventBudget = createSessionCollectionEventBudget(eventLimits);
  const issues: string[] = [];
  let sessionCount = 0;
  let eventCount = 0;
  let eventIntegrity = true;
  let projectionIntegrity = true;
  if (!(await pathExists(state.sessionsDir))) {
    return { ok: true, sessions: 0, events: 0, eventIntegrity: true, projectionIntegrity: true, issues: [] };
  }
  const rootInfo = await lstat(state.sessionsDir);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    return {
      ok: false,
      sessions: 0,
      events: 0,
      eventIntegrity: false,
      projectionIntegrity: false,
      issues: [`canonical sessions path must be a physical directory: ${state.sessionsDir}`],
    };
  }
  let pinnedRoot: Awaited<ReturnType<typeof openPinnedDirectory>>;
  try {
    pinnedRoot = await openPinnedDirectory(state.sessionsDir, rootInfo);
  } catch (error) {
    return {
      ok: false,
      sessions: 0,
      events: 0,
      eventIntegrity: false,
      projectionIntegrity: false,
      issues: [`canonical sessions directory admission failed: ${(error as Error).message}`],
    };
  }
  const sessionIds: string[] = [];
  let scannedEntries = 0;
  let rootAdmissionIntact = true;
  try {
    for await (const entry of pinnedRoot.directory) {
      await assertPinnedDirectories(pinnedRoot);
      scannedEntries += 1;
      if (scannedEntries > maximumScannedEntries) {
        issues.push(`canonical session integrity scan exceeds maximumScannedEntries ${maximumScannedEntries}`);
        eventIntegrity = false;
        break;
      }
      if (entry.name.startsWith(".")) {
        issues.push(`unexpected hidden entry in canonical sessions: ${entry.name}`);
        projectionIntegrity = false;
        continue;
      }
      try {
        validateSessionId(entry.name);
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          throw new Error(`session entry must be a physical directory: ${entry.name}`);
        }
        if (sessionCount >= maximumSessions) {
          issues.push(`canonical session integrity scan exceeds maximumSessions ${maximumSessions}`);
          eventIntegrity = false;
          break;
        }
        sessionCount += 1;
        sessionIds.push(entry.name);
      } catch (error) {
        eventIntegrity = false;
        issues.push(`session ${entry.name}: ${(error as Error).message}`);
      }
      await assertPinnedDirectories(pinnedRoot);
    }
    await assertPinnedDirectories(pinnedRoot);
  } catch (error) {
    eventIntegrity = false;
    projectionIntegrity = false;
    rootAdmissionIntact = false;
    issues.push(`canonical sessions directory changed during integrity inspection: ${(error as Error).message}`);
  }
  try {
    if (rootAdmissionIntact) {
      try {
        for (const sessionId of sessionIds) {
          await assertPinnedDirectories(pinnedRoot);
          let collectionBudgetExhausted = false;
          try {
            assertCollectionEventBudgetAvailable(eventBudget);
            const paths = sessionPaths(state, sessionId);
            const sessionInfo = await lstat(paths.dir);
            await assertPinnedDirectories(pinnedRoot);
            const pinnedSession = await openDirectoryAdmission(paths.dir, sessionInfo);
            try {
              const assertIntegrityTree = () => assertPinnedDirectories(pinnedRoot, pinnedSession);
              await assertIntegrityTree();
              const { events } = await readSessionEventsUnlocked(state, sessionId, {
                ...eventLimits,
                sessionsRoot: pinnedRoot,
                sessionDirectory: pinnedSession,
                collectionBudget: eventBudget,
              });
              await assertIntegrityTree();
              eventCount += events.length;
              const projection = replayEvents(events, sessionId);
              for (const [label, filePath, expected] of [
                ["state", paths.stateFile, `${JSON.stringify(projection.state, null, 2)}\n`],
                ["transcript", paths.transcriptFile, `${JSON.stringify(projection.transcript, null, 2)}\n`],
              ] as const) {
                await assertIntegrityTree();
                let info;
                try {
                  info = await lstat(filePath, { bigint: true });
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                  await assertIntegrityTree();
                  issues.push(`session ${sessionId} ${label} projection is missing`);
                  projectionIntegrity = false;
                  continue;
                }
                await assertIntegrityTree();
                const expectedContent = Buffer.from(expected);
                if (!info.isFile() || info.isSymbolicLink()) {
                  issues.push(`session ${sessionId} ${label} projection must be a physical file`);
                  projectionIntegrity = false;
                } else if (info.size !== BigInt(expectedContent.length)) {
                  issues.push(`session ${sessionId} ${label} projection does not match immutable events`);
                  projectionIntegrity = false;
                } else {
                  const admittedProjection: AdmittedFileIdentity = {
                    filePath,
                    device: info.dev,
                    inode: info.ino,
                    size: expectedContent.length,
                    modifiedAtNs: info.mtimeNs,
                  };
                  const content = await readAdmittedFile(
                    admittedProjection,
                    assertIntegrityTree,
                    `canonical session ${label} projection`,
                  );
                  if (!content.equals(expectedContent)) {
                    issues.push(`session ${sessionId} ${label} projection does not match immutable events`);
                    projectionIntegrity = false;
                  }
                }
                await assertIntegrityTree();
              }
            } finally {
              await closeDirectoryAdmission(pinnedSession);
            }
          } catch (error) {
            eventIntegrity = false;
            projectionIntegrity = false;
            issues.push(`session ${sessionId}: ${(error as Error).message}`);
            collectionBudgetExhausted = eventBudget.exhausted !== undefined;
          }
          await assertPinnedDirectories(pinnedRoot);
          if (collectionBudgetExhausted) break;
        }
      } catch (error) {
        eventIntegrity = false;
        projectionIntegrity = false;
        issues.push(`canonical sessions directory changed during integrity inspection: ${(error as Error).message}`);
      }
    }
  } finally {
    await closeDirectoryAdmission(pinnedRoot);
  }
  return {
    ok: eventIntegrity && projectionIntegrity && issues.length === 0,
    sessions: sessionCount,
    events: eventCount,
    eventIntegrity,
    projectionIntegrity,
    issues: issues.sort((left, right) => left.localeCompare(right)),
  };
}

export async function beginSessionTurn(state: SessionStateRoot, sessionId: string): Promise<string> {
  const turnId = randomUUID().replaceAll("-", "");
  await appendSessionEvent(state, sessionId, { type: "turn.started", data: { turnId } });
  return turnId;
}

export async function appendSessionMessage(
  state: SessionStateRoot,
  sessionId: string,
  turnId: string,
  message: TranscriptMessage,
): Promise<SessionProjection> {
  assertTranscriptMessage(message, "session message");
  return appendSessionEvent(state, sessionId, {
    type: "message.appended",
    data: { turnId: requiredString(turnId, "turn id"), message: structuredClone(message) },
  });
}

export async function completeSessionTurn(
  state: SessionStateRoot,
  sessionId: string,
  turnId: string,
  result: Pick<TurnResult, "usage" | "quota" | "finishReason" | "error" | "receipt"> = {},
): Promise<SessionProjection> {
  return appendSessionEvent(state, sessionId, {
    type: "turn.completed",
    data: {
      turnId: requiredString(turnId, "turn id"),
      usage: result.usage,
      quota: result.quota,
      finishReason: result.finishReason,
      error: result.error,
      receipt: result.receipt,
    },
  });
}

function descriptorFromProjection(state: SessionStateRoot, projection: SessionProjection): SessionDescriptor {
  return {
    sessionId: projection.state.sessionId,
    provider: projection.state.provider,
    model: projection.state.model,
    mode: projection.state.mode,
    workdir: projection.state.workdir,
    stateDir: state.stateDir,
  };
}

export async function runSessionTurn(
  state: SessionStateRoot,
  adapter: ProviderAdapter,
  descriptor: SessionDescriptor,
  request: TurnRequest,
): Promise<TurnResult> {
  return withSessionWriteTransaction(state, descriptor.sessionId, async (transaction) => {
    let projection = await transaction.load();
    if (!projection) throw new Error(`session not found: ${descriptor.sessionId}`);
    const canonicalDescriptor = descriptorFromProjection(state, projection);
    await adapter.startSession(canonicalDescriptor);
    await adapter.continueSession(canonicalDescriptor, projection.transcript);

    const turnId = await transaction.beginTurn();
    if (request.systemPrompt && !projection.transcript.messages.some((message) => message.role === "system")) {
      projection = await transaction.appendMessage(turnId, {
        role: "system",
        content: request.systemPrompt,
      });
    }
    projection = await transaction.appendMessage(turnId, {
      role: "user",
      content: request.prompt,
    });

    let result: TurnResult;
    try {
      result = await adapter.runTurn(canonicalDescriptor, projection.transcript, request);
    } catch (error) {
      await transaction.verify();
      const message = error instanceof Error ? error.message : String(error);
      await transaction.appendMessage(turnId, {
        role: "assistant",
        content: message,
        metadata: { error: true },
      });
      await transaction.completeTurn(turnId, { error: message });
      throw error;
    }

    await transaction.verify();
    await transaction.appendMessage(turnId, {
      role: "assistant",
      content: result.error ?? result.content,
      metadata: {
        ...(result.error
          ? { error: true }
          : { usage: result.usage, quota: result.quota, finishReason: result.finishReason }),
        ...(result.receipt ? { receipt: result.receipt } : {}),
      },
    });
    await transaction.completeTurn(turnId, result);
    return result;
  });
}

export async function* streamSessionTurn(
  state: SessionStateRoot,
  adapter: ProviderAdapter,
  descriptor: SessionDescriptor,
  request: TurnRequest,
): AsyncGenerator<TurnChunk> {
  const sessionId = validateSessionId(descriptor.sessionId);
  const lock = await acquireSessionLock(state, sessionId);
  const machineId = await readMachineId(state);
  let turnId: string | undefined;
  let content = "";
  let usage: Usage | undefined;
  let quota: QuotaSurface | undefined;
  let finishReason: string | undefined;
  let receipt: Record<string, unknown> | undefined;
  let error: string | undefined;
  let thrown: unknown;

  try {
    let projection = await rebuildSessionProjectionsUnlocked(state, sessionId);
    if (!projection) throw new Error(`session not found: ${sessionId}`);
    const canonicalDescriptor = descriptorFromProjection(state, projection);
    await adapter.startSession(canonicalDescriptor);
    await adapter.continueSession(canonicalDescriptor, projection.transcript);
    await lock.verify();
    turnId = randomUUID().replaceAll("-", "");
    projection = await appendSessionEventUnlocked(state, sessionId, machineId, {
      type: "turn.started",
      data: { turnId },
    });
    if (request.systemPrompt && !projection.transcript.messages.some((message) => message.role === "system")) {
      projection = await appendSessionEventUnlocked(state, sessionId, machineId, {
        type: "message.appended",
        data: { turnId, message: { role: "system", content: request.systemPrompt } },
      });
    }
    projection = await appendSessionEventUnlocked(state, sessionId, machineId, {
      type: "message.appended",
      data: { turnId, message: { role: "user", content: request.prompt } },
    });

    try {
      if (!adapter.streamTurn) {
        const result = await adapter.runTurn(canonicalDescriptor, projection.transcript, request);
        content = result.content;
        usage = result.usage;
        quota = result.quota;
        finishReason = result.finishReason;
        receipt = result.receipt;
        error = result.error;
        if (error) yield { type: "error", error };
        else {
          yield { type: "text", delta: content };
          if (usage) yield { type: "usage", usage };
          if (quota) yield { type: "quota", quota };
          yield { type: "finish", finishReason };
        }
      } else {
        for await (const chunk of adapter.streamTurn(canonicalDescriptor, projection.transcript, request)) {
          if (chunk.type === "text" && chunk.delta) content += chunk.delta;
          if (chunk.type === "usage") usage = chunk.usage;
          if (chunk.type === "quota") quota = chunk.quota;
          if (chunk.type === "finish") finishReason = chunk.finishReason;
          if (chunk.type === "error") error = chunk.error;
          yield chunk;
        }
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      thrown = caught;
    }
  } finally {
    try {
      if (turnId) {
        await lock.verify();
        await appendSessionEventUnlocked(state, sessionId, machineId, {
          type: "message.appended",
          data: {
            turnId,
            message: error
              ? { role: "assistant", content: error, metadata: { error: true, ...(receipt ? { receipt } : {}) } }
              : { role: "assistant", content, metadata: { usage, quota, finishReason, ...(receipt ? { receipt } : {}) } },
          },
        });
        await lock.verify();
        await appendSessionEventUnlocked(state, sessionId, machineId, {
          type: "turn.completed",
          data: { turnId, usage, quota, finishReason, error, receipt },
        });
      }
    } finally {
      await lock.release();
    }
  }
  if (thrown) throw thrown;
}

export async function switchSessionProvider(
  state: SessionStateRoot,
  rawSessionId: string,
  provider: string,
  model: string,
): Promise<SessionDescriptor> {
  const sessionId = validateSessionId(rawSessionId);
  requiredString(provider, "session provider");
  requiredModel(model, "session model");
  return withSessionWriteTransaction(state, sessionId, (transaction) => transaction.switchProvider(provider, model));
}

export function describeSession(descriptor: SessionDescriptor): string {
  return `${descriptor.provider}/${descriptor.model} ${descriptor.mode} ${descriptor.sessionId}`;
}
