import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { lstat, open, opendir, readFile, realpath } from "node:fs/promises";
import { findSecretLikePath } from "../../cli/src/event-sync";
import {
  listMemoryRecords,
  rememberMemory,
  supersedeMemory,
  type MemoryEvidence,
  type MemoryRecord,
  type MemoryRecordStatus,
  type MemorySensitivity,
} from "../../cli/src/memory";
import type { SharedState } from "../../cli/src/state";
import {
  pluginRuntimeProjectionPath,
  publishPluginRuntimeProjection,
} from "../../cli/src/state-v2";
import { listSessionIds, loadSessionEventBatch, type SessionEvent } from "../../sdk/harness/session";

export const MEMORY_PLUGIN_SCHEMA_VERSION = 1 as const;
export const DREAM_V13_CURSOR_VERSION = "1.3" as const;
export const DEFAULT_DREAM_IDLE_MS = 30 * 60_000;

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_CANDIDATE_TEXT = 480;
const DEFAULT_MAX_CORPUS_FILES = 1_000;
const DEFAULT_MAX_CORPUS_FILE_BYTES = 1024 * 1024;
const DEFAULT_MAX_CORPUS_DIRECTORIES = 10_000;
const DEFAULT_MAX_CORPUS_DEPTH = 64;
const DEFAULT_MAX_CORPUS_TOTAL_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_SCANNED_SESSIONS = 1_000;
const DEFAULT_MAX_SCANNED_SESSION_ENTRIES = 2_000;
const DEFAULT_MAX_EVENTS_PER_SESSION = 10_000;
const DEFAULT_MAX_TOTAL_SESSION_EVENTS = 50_000;
const DEFAULT_MAX_BYTES_PER_SESSION = 16 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_SESSION_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_SCANNED_ENTRIES_PER_SESSION = 20_000;
const MAX_DREAM_CURSOR_SOURCE_BYTES = 1024 * 1024;
const MAX_DREAM_CURSOR_DECODE_WORK_BYTES = 4 * MAX_DREAM_CURSOR_SOURCE_BYTES;
const DREAM_SESSION_ARTIFACT =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.(?:jsonl|json)$/i;
const SECRET_FIELD_NAME =
  /(?:password|passwd|pwd|secret|token|api.?key|credential|authorization|private.?key|connection.?string|dsn)/i;

export type MemoryCandidateKind = "reflection" | "dream" | "corpus" | "migration";

export interface MemoryCandidate {
  schemaVersion: typeof MEMORY_PLUGIN_SCHEMA_VERSION;
  kind: MemoryCandidateKind;
  scope: string;
  subject: string;
  predicate: string;
  value: string;
  evidence: MemoryEvidence;
  sensitivity: Exclude<MemorySensitivity, "secret">;
  observedAt: string;
  status: Extract<MemoryRecordStatus, "active" | "disputed">;
}

export interface DreamCycleResult {
  status: "skipped" | "recorded";
  reason?: "no-sessions" | "not-idle";
  idleForMs?: number;
  candidate?: MemoryCandidate;
  record?: MemoryRecord;
}

export interface CorpusSkip {
  relativePath: string;
  reason: "unsupported" | "too-large" | "secret-like" | "no-candidate";
}

export interface CorpusBatchResult {
  candidates: MemoryCandidate[];
  skipped: CorpusSkip[];
}

export interface DreamV13Cursor {
  version: typeof DREAM_V13_CURSOR_VERSION;
  last_run: string;
  last_processed_file: string;
  processed_total: number;
  last_session_title: string;
  pending_count: number;
  open_items: string[];
  next_work: string[];
  source_counts: Record<string, number>;
  provider_counts: Record<string, number>;
}

export interface MigratedDreamCursor {
  schemaVersion: typeof MEMORY_PLUGIN_SCHEMA_VERSION;
  kind: "dream-v1.3-cursor";
  migratedAt: string;
  source: {
    uri: string;
    contentHash: string;
  };
  recordId: string;
  legacyCursor: DreamV13Cursor;
  canonicalCursor: {
    lastSessionEventAt: null;
    lastSessionEventHash: null;
  };
}

interface DreamCursorAuthority {
  schemaVersion: typeof MEMORY_PLUGIN_SCHEMA_VERSION;
  version: typeof DREAM_V13_CURSOR_VERSION;
  lastRun: string;
  lastProcessed: {
    timeKey: string;
    provider: string;
    sourceKind: string;
    pathStyle: "windows" | "posix";
    pathUri: string;
  };
  processedTotal: number;
  lastSessionTitleUri: string;
  pendingCount: number;
  openItems: string[];
  nextWork: string[];
  sourceCounts: Record<string, number>;
  providerCounts: Record<string, number>;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function requiredTimestamp(value: unknown, label: string): string {
  const text = requiredText(value, label);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${label} must be an ISO timestamp`);
  return text;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer`);
  return value as number;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return [...value];
}

function countMap(value: unknown, label: string): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const output: Record<string, number> = {};
  for (const [key, count] of Object.entries(value)) {
    output[requiredText(key, `${label} key`)] = nonNegativeInteger(count, `${label}.${key}`);
  }
  return output;
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function candidateText(value: string): string | null {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized || findSecretLikePath(normalized)) return null;
  return normalized.length > MAX_CANDIDATE_TEXT ? `${normalized.slice(0, MAX_CANDIDATE_TEXT - 1)}…` : normalized;
}

function assistantTexts(events: SessionEvent[]): string[] {
  return events.flatMap((event) => {
    if (event.type !== "message.appended" || event.data.message.role !== "assistant") return [];
    const text = candidateText(event.data.message.content);
    return text ? [text] : [];
  });
}

function sessionEvidenceUri(sessionId: string): string {
  const readable = `agent-session://${encodeURIComponent(sessionId)}/events`;
  if (!findSecretLikePath(readable)) return readable;
  return `agent-session:///${percentEncodeEveryByte(sessionId)}/events`;
}

function validateCandidate(candidate: MemoryCandidate): MemoryCandidate {
  if (candidate.schemaVersion !== MEMORY_PLUGIN_SCHEMA_VERSION) throw new Error("unsupported memory candidate schema");
  if (!SHA256.test(candidate.evidence.contentHash)) throw new Error("candidate evidence hash must be lowercase SHA-256");
  const secretPath = findSecretLikePath(candidate);
  if (secretPath || candidate.sensitivity === ("secret" as MemorySensitivity)) {
    throw new Error(
      `secret-like candidate content cannot cross the memory plugin boundary${secretPath ? ` at ${secretPath}` : ""}`,
    );
  }
  requiredTimestamp(candidate.observedAt, "candidate observedAt");
  return candidate;
}

function latestEventAt(events: SessionEvent[]): string {
  const latest = events.at(-1)?.at;
  if (!latest) throw new Error("canonical session has no events");
  return latest;
}

async function loadBoundedSessionEvents(
  state: SharedState,
  sessionIds: string[],
  options: {
    maximumEventsPerSession: number;
    maximumTotalEvents: number;
    maximumBytesPerSession: number;
    maximumTotalBytes: number;
    maximumScannedEntriesPerSession: number;
  },
): Promise<Array<{ sessionId: string; events: SessionEvent[] }>> {
  const output: Array<{ sessionId: string; events: SessionEvent[] }> = [];
  let remainingEvents = options.maximumTotalEvents;
  let remainingBytes = options.maximumTotalBytes;
  for (const sessionId of sessionIds) {
    if (remainingEvents < 1) {
      throw new Error(`canonical session scan exceeds maximumTotalEvents ${options.maximumTotalEvents}`);
    }
    if (remainingBytes < 1) {
      throw new Error(`canonical session scan exceeds maximumTotalBytes ${options.maximumTotalBytes}`);
    }
    const maximumEvents = Math.min(options.maximumEventsPerSession, remainingEvents);
    const maximumBytes = Math.min(options.maximumBytesPerSession, remainingBytes);
    const batch = await loadSessionEventBatch(state, sessionId, {
      maximumEvents,
      maximumBytes,
      maximumScannedEntries: options.maximumScannedEntriesPerSession,
    });
    remainingEvents -= batch.events.length;
    remainingBytes -= batch.bytes;
    output.push({ sessionId, events: batch.events });
  }
  return output;
}

export async function reflectCanonicalSession(
  state: SharedState,
  sessionId: string,
  options: { maximumEvents?: number; maximumBytes?: number; maximumScannedEntries?: number } = {},
): Promise<MemoryCandidate> {
  const maximumEvents = options.maximumEvents ?? DEFAULT_MAX_EVENTS_PER_SESSION;
  const maximumBytes = options.maximumBytes ?? DEFAULT_MAX_BYTES_PER_SESSION;
  const maximumScannedEntries = options.maximumScannedEntries ?? DEFAULT_MAX_SCANNED_ENTRIES_PER_SESSION;
  if (!Number.isSafeInteger(maximumEvents) || maximumEvents < 1) {
    throw new Error("maximumEvents must be a positive integer");
  }
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error("maximumBytes must be a positive integer");
  }
  if (!Number.isSafeInteger(maximumScannedEntries) || maximumScannedEntries < 1) {
    throw new Error("maximumScannedEntries must be a positive integer");
  }
  const { events } = await loadSessionEventBatch(state, sessionId, {
    maximumEvents,
    maximumBytes,
    maximumScannedEntries,
  });
  if (events.length === 0) throw new Error(`canonical session not found: ${sessionId}`);
  const completedTurns = events.filter((event) => event.type === "turn.completed").length;
  if (completedTurns === 0) throw new Error(`canonical session has no completed turns: ${sessionId}`);
  const responses = assistantTexts(events);
  const latestResponse = responses.at(-1);
  const value = latestResponse
    ? `Completed ${completedTurns} turn${completedTurns === 1 ? "" : "s"}; latest reflection: ${latestResponse}`
    : `Completed ${completedTurns} turn${completedTurns === 1 ? "" : "s"}; assistant content was omitted by admission policy.`;
  return validateCandidate({
    schemaVersion: MEMORY_PLUGIN_SCHEMA_VERSION,
    kind: "reflection",
    scope: "reflection",
    subject: `session:${sessionId}`,
    predicate: "session-summary",
    value,
    evidence: {
      uri: sessionEvidenceUri(sessionId),
      contentHash: sha256(canonicalJson(events)),
      sourceClass: "inferred",
      confidence: latestResponse ? 0.8 : 0.65,
    },
    sensitivity: "internal",
    observedAt: latestEventAt(events),
    status: "active",
  });
}

export async function applyMemoryCandidate(
  state: SharedState,
  candidateInput: MemoryCandidate,
  options: { now?: Date; authorId?: string } = {},
): Promise<MemoryRecord> {
  const candidate = validateCandidate(candidateInput);
  const input = {
    scope: candidate.scope,
    subject: candidate.subject,
    predicate: candidate.predicate,
    value: candidate.value,
    evidence: candidate.evidence,
    sensitivity: candidate.sensitivity,
    observedAt: candidate.observedAt,
  };
  if (candidate.status === "disputed") {
    return rememberMemory(state, { ...input, status: "disputed" }, options);
  }
  const active = await listMemoryRecords(state, {
    scope: candidate.scope,
    subject: candidate.subject,
    predicate: candidate.predicate,
    status: "active",
  });
  if (active.length > 1) throw new Error("canonical memory contains multiple active records for the candidate key");
  if (active.length === 1) {
    if (
      active[0].value === candidate.value &&
      active[0].evidence.uri === candidate.evidence.uri &&
      active[0].evidence.contentHash === candidate.evidence.contentHash &&
      active[0].evidence.sourceClass === candidate.evidence.sourceClass &&
      active[0].evidence.confidence === candidate.evidence.confidence &&
      active[0].sensitivity === candidate.sensitivity
    ) {
      return active[0];
    }
    return supersedeMemory(state, active[0].id, input, options);
  }
  return rememberMemory(state, input, options);
}

export async function runIdleDreamCycle(
  state: SharedState,
  options: {
    now?: Date;
    minimumIdleMs?: number;
    maximumSessions?: number;
    maximumScannedSessions?: number;
    maximumScannedSessionEntries?: number;
    maximumEventsPerSession?: number;
    maximumTotalEvents?: number;
    maximumBytesPerSession?: number;
    maximumTotalBytes?: number;
    maximumScannedEntriesPerSession?: number;
    authorId?: string;
  } = {},
): Promise<DreamCycleResult> {
  const now = options.now ?? new Date();
  const minimumIdleMs = options.minimumIdleMs ?? DEFAULT_DREAM_IDLE_MS;
  const maximumSessions = options.maximumSessions ?? 8;
  const maximumScannedSessions = options.maximumScannedSessions ?? DEFAULT_MAX_SCANNED_SESSIONS;
  const maximumScannedSessionEntries =
    options.maximumScannedSessionEntries ?? DEFAULT_MAX_SCANNED_SESSION_ENTRIES;
  const maximumEventsPerSession = options.maximumEventsPerSession ?? DEFAULT_MAX_EVENTS_PER_SESSION;
  const maximumTotalEvents = options.maximumTotalEvents ?? DEFAULT_MAX_TOTAL_SESSION_EVENTS;
  const maximumBytesPerSession = options.maximumBytesPerSession ?? DEFAULT_MAX_BYTES_PER_SESSION;
  const maximumTotalBytes = options.maximumTotalBytes ?? DEFAULT_MAX_TOTAL_SESSION_BYTES;
  const maximumScannedEntriesPerSession =
    options.maximumScannedEntriesPerSession ?? DEFAULT_MAX_SCANNED_ENTRIES_PER_SESSION;
  if (!Number.isFinite(minimumIdleMs) || minimumIdleMs < 0) throw new Error("minimumIdleMs must be non-negative");
  if (!Number.isSafeInteger(maximumSessions) || maximumSessions < 1 || maximumSessions > 100) {
    throw new Error("maximumSessions must be an integer between 1 and 100");
  }
  if (!Number.isSafeInteger(maximumScannedSessions) || maximumScannedSessions < maximumSessions) {
    throw new Error("maximumScannedSessions must be an integer greater than or equal to maximumSessions");
  }
  if (
    !Number.isSafeInteger(maximumScannedSessionEntries) ||
    maximumScannedSessionEntries < maximumScannedSessions
  ) {
    throw new Error(
      "maximumScannedSessionEntries must be an integer greater than or equal to maximumScannedSessions",
    );
  }
  if (!Number.isSafeInteger(maximumEventsPerSession) || maximumEventsPerSession < 1) {
    throw new Error("maximumEventsPerSession must be a positive integer");
  }
  if (!Number.isSafeInteger(maximumTotalEvents) || maximumTotalEvents < maximumEventsPerSession) {
    throw new Error("maximumTotalEvents must be an integer greater than or equal to maximumEventsPerSession");
  }
  if (!Number.isSafeInteger(maximumBytesPerSession) || maximumBytesPerSession < 1) {
    throw new Error("maximumBytesPerSession must be a positive integer");
  }
  if (!Number.isSafeInteger(maximumTotalBytes) || maximumTotalBytes < maximumBytesPerSession) {
    throw new Error("maximumTotalBytes must be an integer greater than or equal to maximumBytesPerSession");
  }
  if (!Number.isSafeInteger(maximumScannedEntriesPerSession) || maximumScannedEntriesPerSession < 1) {
    throw new Error("maximumScannedEntriesPerSession must be a positive integer");
  }
  const sessionIds = await listSessionIds(state, {
    maximumSessions: maximumScannedSessions,
    maximumScannedEntries: maximumScannedSessionEntries,
  });
  const sessions = await loadBoundedSessionEvents(state, sessionIds, {
    maximumEventsPerSession,
    maximumTotalEvents,
    maximumBytesPerSession,
    maximumTotalBytes,
    maximumScannedEntriesPerSession,
  });
  const nonEmpty = sessions.filter((session) => session.events.length > 0);
  if (nonEmpty.length === 0) return { status: "skipped", reason: "no-sessions" };
  const latestAt = nonEmpty
    .map((session) => latestEventAt(session.events))
    .sort((left, right) => right.localeCompare(left))[0];
  const idleForMs = now.getTime() - Date.parse(latestAt);
  if (idleForMs < minimumIdleMs) return { status: "skipped", reason: "not-idle", idleForMs };

  const selected = nonEmpty
    .sort((left, right) => latestEventAt(right.events).localeCompare(latestEventAt(left.events)))
    .slice(0, maximumSessions);
  const reflections = selected.flatMap(({ sessionId, events }) => {
    const response = assistantTexts(events).at(-1);
    return response ? [`${sessionId}: ${response}`] : [];
  });
  const value = candidateText(
    reflections.length > 0
      ? `Idle dream across ${selected.length} canonical session${selected.length === 1 ? "" : "s"}: ${reflections.join(" | ")}`
      : `Idle dream observed ${selected.length} canonical session${selected.length === 1 ? "" : "s"}; content was omitted by admission policy.`,
  );
  if (!value) throw new Error("dream output was rejected by admission policy");
  const evidencePayload = selected.map(({ sessionId, events }) => ({ sessionId, events }));
  const evidenceHash = sha256(canonicalJson(evidencePayload));
  const candidate = validateCandidate({
    schemaVersion: MEMORY_PLUGIN_SCHEMA_VERSION,
    kind: "dream",
    scope: "dream",
    subject: "idle-session-distillation",
    predicate: "summary",
    value,
    evidence: {
      uri: `agent-session-set://${evidenceHash.slice(0, 24)}`,
      contentHash: evidenceHash,
      sourceClass: "inferred",
      confidence: reflections.length > 0 ? 0.7 : 0.55,
    },
    sensitivity: "internal",
    observedAt: latestAt,
    status: "active",
  });
  const record = await applyMemoryCandidate(state, candidate, { now, authorId: options.authorId ?? "memory-plugin:dream" });
  return { status: "recorded", idleForMs, candidate, record };
}

function assertContainedPath(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escaped its declared root: ${candidate}`);
  }
}

function corpusEvidenceUri(absolute: string, relativePath: string): string {
  if (findSecretLikePath(relativePath)) {
    throw new Error("secret-like candidate content cannot cross the memory plugin boundary at corpus path metadata");
  }
  // The absolute root is operator-selected and physically contained. Encode
  // its components so filesystem-generated identifiers are not mistaken for
  // credentials while the unencoded corpus-relative path remains admitted.
  const uri = pathToFileURL(absolute);
  uri.pathname = uri.pathname
    .split("/")
    .map((segment) => (segment ? percentEncodeEveryByte(decodeURIComponent(segment)) : ""))
    .join("/");
  return uri.href;
}

async function corpusFiles(
  root: string,
  limits: { maxFiles: number; maxDirectories: number; maxDepth: number },
): Promise<string[]> {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("corpus root must be a regular directory");
  const physicalRoot = await realpath(root);
  const physicalRootInfo = await lstat(physicalRoot);
  if (rootInfo.dev !== physicalRootInfo.dev || rootInfo.ino !== physicalRootInfo.ino) {
    throw new Error(`corpus root changed while resolving its physical path: ${root}`);
  }
  const files: string[] = [];
  let directories = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > limits.maxDepth) throw new Error(`corpus exceeds maximum directory depth ${limits.maxDepth}`);
    directories += 1;
    if (directories > limits.maxDirectories) {
      throw new Error(`corpus exceeds maximum directory count ${limits.maxDirectories}`);
    }
    const physicalDirectory = await realpath(directory);
    assertContainedPath(physicalRoot, physicalDirectory, "corpus directory");
    for await (const entry of await opendir(directory)) {
      const absolute = path.join(directory, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error(`corpus links are not admitted: ${absolute}`);
      if (info.isDirectory()) await visit(absolute, depth + 1);
      else if (info.isFile()) {
        files.push(absolute);
        if (files.length > limits.maxFiles) throw new Error(`corpus exceeds maximum file count ${limits.maxFiles}`);
      } else {
        throw new Error(`corpus contains an unsupported filesystem entry: ${absolute}`);
      }
    }
  };
  await visit(root, 0);
  return files.sort((left, right) => left.localeCompare(right));
}

async function readPhysicalCorpusFile(root: string, absolute: string, maxFileBytes: number): Promise<{
  bytes: Buffer;
  modifiedAt: Date;
}> {
  const physical = await realpath(absolute);
  assertContainedPath(root, physical, "corpus file");
  const before = await lstat(absolute);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`corpus file is not physical: ${absolute}`);
  if (before.size > maxFileBytes) throw new Error("corpus-file-too-large");
  const handle = await open(absolute, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error(`corpus file changed during admission: ${absolute}`);
    }
    const bytes = await handle.readFile();
    const after = await lstat(absolute);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size
    ) {
      throw new Error(`corpus file changed during admission: ${absolute}`);
    }
    return { bytes, modifiedAt: opened.mtime };
  } finally {
    await handle.close();
  }
}

function findMessageContent(value: unknown, output: string[]): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let visited = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    visited += 1;
    if (visited > 10_000 || current.depth > 64) return;
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: current.value[index], depth: current.depth + 1 });
      }
      continue;
    }
    if (!current.value || typeof current.value !== "object") continue;
    const object = current.value as Record<string, unknown>;
    if (
      typeof object.content === "string" &&
      (object.role === "assistant" || object.type === "assistant" || object.role === "user")
    ) {
      output.push(object.content);
    }
    const children = Object.values(object);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ value: children[index], depth: current.depth + 1 });
    }
  }
}

function extractCorpusCandidate(content: string, extension: string): string | null {
  const messages: string[] = [];
  if (extension === ".jsonl") {
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        findMessageContent(JSON.parse(line), messages);
      } catch {
        continue;
      }
    }
  } else if (extension === ".json") {
    try {
      findMessageContent(JSON.parse(content), messages);
    } catch {
      return null;
    }
  } else {
    messages.push(content);
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const admitted = candidateText(messages[index]);
    if (admitted) return admitted;
  }
  return null;
}

export async function processHistoricalCorpus(
  rootInput: string,
  options: {
    maxFiles?: number;
    maxDirectories?: number;
    maxDepth?: number;
    maxFileBytes?: number;
    maxTotalBytes?: number;
    observedAt?: Date;
  } = {},
): Promise<CorpusBatchResult> {
  const root = path.resolve(rootInput);
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_CORPUS_FILES;
  const maxDirectories = options.maxDirectories ?? DEFAULT_MAX_CORPUS_DIRECTORIES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_CORPUS_DEPTH;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_CORPUS_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_CORPUS_TOTAL_BYTES;
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) throw new Error("maxFiles must be a positive integer");
  if (!Number.isSafeInteger(maxDirectories) || maxDirectories < 1) {
    throw new Error("maxDirectories must be a positive integer");
  }
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) throw new Error("maxDepth must be a non-negative integer");
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1) throw new Error("maxFileBytes must be a positive integer");
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1) throw new Error("maxTotalBytes must be a positive integer");
  const candidates: MemoryCandidate[] = [];
  const skipped: CorpusSkip[] = [];
  let admittedBytes = 0;
  const physicalRoot = await realpath(root);
  for (const absolute of await corpusFiles(root, { maxFiles, maxDirectories, maxDepth })) {
    const relativePath = path.relative(root, absolute).split(path.sep).join("/");
    if (!relativePath || relativePath.startsWith("../") || path.isAbsolute(relativePath)) {
      throw new Error(`corpus path escaped its declared root: ${absolute}`);
    }
    const extension = path.extname(absolute).toLowerCase();
    if (![".json", ".jsonl", ".md", ".txt"].includes(extension)) {
      skipped.push({ relativePath, reason: "unsupported" });
      continue;
    }
    let admitted;
    try {
      admitted = await readPhysicalCorpusFile(physicalRoot, absolute, maxFileBytes);
    } catch (error) {
      if ((error as Error).message === "corpus-file-too-large") {
        skipped.push({ relativePath, reason: "too-large" });
        continue;
      }
      throw error;
    }
    const { bytes, modifiedAt } = admitted;
    admittedBytes += bytes.byteLength;
    if (admittedBytes > maxTotalBytes) throw new Error(`corpus exceeds maximum total bytes ${maxTotalBytes}`);
    const content = bytes.toString("utf8");
    if (findSecretLikePath(content)) {
      skipped.push({ relativePath, reason: "secret-like" });
      continue;
    }
    const value = extractCorpusCandidate(content, extension);
    if (!value) {
      skipped.push({ relativePath, reason: "no-candidate" });
      continue;
    }
    candidates.push(
      validateCandidate({
        schemaVersion: MEMORY_PLUGIN_SCHEMA_VERSION,
        kind: "corpus",
        scope: "corpus",
        subject: `file:${relativePath}`,
        predicate: "historical-candidate",
        value,
        evidence: {
          uri: corpusEvidenceUri(absolute, relativePath),
          contentHash: sha256(bytes),
          sourceClass: "inferred",
          confidence: 0.5,
        },
        sensitivity: "internal",
        observedAt: (options.observedAt ?? modifiedAt).toISOString(),
        status: "active",
      }),
    );
  }
  return { candidates, skipped };
}

function validateDreamV13Cursor(value: unknown): DreamV13Cursor {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Dream cursor must be an object");
  const cursor = value as Record<string, unknown>;
  const expectedKeys = new Set([
    "version",
    "last_run",
    "last_processed_file",
    "processed_total",
    "last_session_title",
    "pending_count",
    "open_items",
    "next_work",
    "source_counts",
    "provider_counts",
  ]);
  const unexpected = Object.keys(cursor).filter((key) => !expectedKeys.has(key));
  if (unexpected.length > 0) throw new Error(`Dream cursor contains unsupported fields: ${unexpected.sort().join(", ")}`);
  if (cursor.version !== DREAM_V13_CURSOR_VERSION) {
    throw new Error(`Dream cursor must be version ${DREAM_V13_CURSOR_VERSION}; earlier formats remain retired`);
  }
  const validated = {
    version: DREAM_V13_CURSOR_VERSION,
    last_run: requiredTimestamp(cursor.last_run, "Dream cursor last_run"),
    last_processed_file: requiredText(cursor.last_processed_file, "Dream cursor last_processed_file"),
    processed_total: nonNegativeInteger(cursor.processed_total, "Dream cursor processed_total"),
    last_session_title: requiredText(cursor.last_session_title, "Dream cursor last_session_title"),
    pending_count: nonNegativeInteger(cursor.pending_count, "Dream cursor pending_count"),
    open_items: stringArray(cursor.open_items, "Dream cursor open_items"),
    next_work: stringArray(cursor.next_work, "Dream cursor next_work"),
    source_counts: countMap(cursor.source_counts, "Dream cursor source_counts"),
    provider_counts: countMap(cursor.provider_counts, "Dream cursor provider_counts"),
  };
  const sourceTotal = Object.values(validated.source_counts).reduce((sum, count) => sum + count, 0);
  const providerTotal = Object.values(validated.provider_counts).reduce((sum, count) => sum + count, 0);
  if (sourceTotal !== validated.processed_total || providerTotal !== validated.processed_total) {
    throw new Error("Dream cursor processed_total must match both source and provider counts");
  }
  return validated;
}

export function dreamCursorPath(state: SharedState): string {
  return pluginRuntimeProjectionPath(state, "memory", "dream-v1.3-cursor");
}

function percentEncodeEveryByte(value: string): string {
  return [...Buffer.from(value, "utf8")]
    .map((byte) => `%${byte.toString(16).padStart(2, "0").toUpperCase()}`)
    .join("");
}

function encodeCursorUriComponent(value: string): string {
  if (!DREAM_SESSION_ARTIFACT.test(value)) return encodeURIComponent(value);
  // UUID-named provider session artifacts are admitted evidence identifiers,
  // not credentials. Encode every byte so the manager's opaque-token scanner
  // does not mistake their reversible URI representation for secret material.
  return percentEncodeEveryByte(value);
}

function cursorSourceUri(sourcePath: string): string {
  assertAdmittedCursorSourcePath(sourcePath);
  const uri = pathToFileURL(sourcePath);
  uri.pathname = uri.pathname
    .split("/")
    .map((segment) => (segment ? percentEncodeEveryByte(decodeURIComponent(segment)) : ""))
    .join("/");
  return uri.href;
}

function cursorPathUri(rawPath: string): { pathStyle: "windows" | "posix"; pathUri: string } {
  if (/^[A-Za-z]:\\/.test(rawPath)) {
    const normalized = rawPath.replaceAll("\\", "/");
    const drive = normalized.slice(0, 2);
    const tail = normalized
      .slice(3)
      .split("/")
      .map(encodeCursorUriComponent)
      .join("/");
    return { pathStyle: "windows", pathUri: `file:///${drive}/${tail}` };
  }
  if (!rawPath.startsWith("/")) throw new Error("Dream cursor timeline path must be absolute");
  const uri = pathToFileURL(rawPath);
  uri.pathname = uri.pathname
    .split("/")
    .map((segment) => (segment ? encodeCursorUriComponent(decodeURIComponent(segment)) : ""))
    .join("/");
  return { pathStyle: "posix", pathUri: uri.href };
}

function visitDecodedTextVariants(value: string, label: string, visit: (variant: string) => void): void {
  if (Buffer.byteLength(value, "utf8") > MAX_DREAM_CURSOR_SOURCE_BYTES) {
    throw new Error(`${label} exceeds the Dream cursor text admission limit`);
  }
  let decoded = value;
  let decodedWorkBytes = 0;
  // Every changing decode removes at least two source characters, so the input
  // length is a strict upper bound without imposing a bypassable fixed pass cap.
  for (let pass = 0; pass <= value.length; pass += 1) {
    visit(decoded);
    if (!decoded.includes("%")) return;
    decodedWorkBytes += Buffer.byteLength(decoded, "utf8");
    if (decodedWorkBytes > MAX_DREAM_CURSOR_DECODE_WORK_BYTES) {
      throw new Error(`${label} exceeds the Dream cursor percent-decoding work limit`);
    }
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      throw new Error(`${label} contains malformed percent encoding`);
    }
    if (Buffer.byteLength(next, "utf8") > MAX_DREAM_CURSOR_SOURCE_BYTES) {
      throw new Error(`${label} exceeds the Dream cursor decoded-text admission limit`);
    }
    if (next === decoded) return;
    decoded = next;
  }
  throw new Error(`${label} exceeds the Dream cursor percent-decoding limit`);
}

function assertAdmittedCursorText(
  value: string,
  label: string,
  options: { allowSessionArtifact?: boolean } = {},
): void {
  visitDecodedTextVariants(value, label, (variant) => {
    if (options.allowSessionArtifact && DREAM_SESSION_ARTIFACT.test(variant)) return;
    if (SECRET_FIELD_NAME.test(variant) || findSecretLikePath(variant)) {
      throw new Error(`Dream cursor contains secret-like content at ${label}`);
    }
  });
}

function assertAdmittedCursorPath(rawPath: string): void {
  visitDecodedTextVariants(rawPath, "last_processed_file.path", (variant) => {
    assertAdmittedPathSegments(variant, "last_processed_file.path");
    const withoutSessionArtifacts = variant.replace(
      /(^|[\\/])[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.(?:jsonl|json)(?=$|[\\/])/gi,
      "$1session-artifact.jsonl",
    );
    if (findSecretLikePath(withoutSessionArtifacts)) {
      throw new Error("Dream cursor contains secret-like content at last_processed_file.path");
    }
  });
}

function assertAdmittedPathSegments(value: string, label: string): void {
  const segments = value.split(/[\\/]/).filter(Boolean);
  for (const [index, segment] of segments.entries()) {
    assertAdmittedCursorText(segment, `${label}[${index}]`, { allowSessionArtifact: true });
  }
}

function assertAdmittedCursorSourcePath(rawPath: string): void {
  visitDecodedTextVariants(rawPath, "source.path", (variant) => assertAdmittedPathSegments(variant, "source.path"));
}

function assertDreamCursorAdmission(
  cursor: DreamV13Cursor,
  temporal: { provider: string; sourceKind: string; rawPath: string },
): void {
  assertAdmittedCursorText(temporal.provider, "last_processed_file.provider");
  assertAdmittedCursorText(temporal.sourceKind, "last_processed_file.sourceKind");
  assertAdmittedCursorPath(temporal.rawPath);
  assertAdmittedCursorText(cursor.last_session_title, "last_session_title", { allowSessionArtifact: true });
  cursor.open_items.forEach((value, index) => assertAdmittedCursorText(value, `open_items[${index}]`));
  cursor.next_work.forEach((value, index) => assertAdmittedCursorText(value, `next_work[${index}]`));
  Object.keys(cursor.source_counts).forEach((value) => assertAdmittedCursorText(value, "source_counts key"));
  Object.keys(cursor.provider_counts).forEach((value) => assertAdmittedCursorText(value, "provider_counts key"));
}

function authorityFromCursor(cursor: DreamV13Cursor): DreamCursorAuthority {
  const parts = cursor.last_processed_file.split("|");
  if (parts.length < 4) throw new Error("Dream cursor last_processed_file must use the v1.3 temporal cursor format");
  const [timeKey, provider, sourceKind, ...pathParts] = parts;
  if (!/^\d{17}$/.test(timeKey)) throw new Error("Dream cursor time key must contain 17 digits");
  const rawPath = pathParts.join("|");
  const validatedProvider = requiredText(provider, "Dream cursor provider");
  const validatedSourceKind = requiredText(sourceKind, "Dream cursor source kind");
  assertDreamCursorAdmission(cursor, {
    provider: validatedProvider,
    sourceKind: validatedSourceKind,
    rawPath,
  });
  const encodedPath = cursorPathUri(rawPath);
  const authority: DreamCursorAuthority = {
    schemaVersion: MEMORY_PLUGIN_SCHEMA_VERSION,
    version: DREAM_V13_CURSOR_VERSION,
    lastRun: cursor.last_run,
    lastProcessed: {
      timeKey,
      provider: validatedProvider,
      sourceKind: validatedSourceKind,
      ...encodedPath,
    },
    processedTotal: cursor.processed_total,
    lastSessionTitleUri: `file:///dream-session-title/${encodeCursorUriComponent(cursor.last_session_title)}`,
    pendingCount: cursor.pending_count,
    openItems: [...cursor.open_items],
    nextWork: [...cursor.next_work],
    sourceCounts: { ...cursor.source_counts },
    providerCounts: { ...cursor.provider_counts },
  };
  const plantedSecret = findSecretLikePath(authority);
  if (plantedSecret) throw new Error(`Dream cursor contains secret-like content at ${plantedSecret}`);
  return authority;
}

function cursorFromAuthority(value: unknown): DreamV13Cursor {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Dream cursor authority must be an object");
  const authority = value as Partial<DreamCursorAuthority>;
  if (authority.schemaVersion !== MEMORY_PLUGIN_SCHEMA_VERSION || authority.version !== DREAM_V13_CURSOR_VERSION) {
    throw new Error("Dream cursor authority schema is unsupported");
  }
  if (!authority.lastProcessed || typeof authority.lastProcessed !== "object") {
    throw new Error("Dream cursor authority is missing its temporal cursor");
  }
  const temporal = authority.lastProcessed;
  const pathUri = requiredText(temporal.pathUri, "Dream cursor authority path URI");
  const parsedUri = new URL(pathUri);
  if (parsedUri.protocol !== "file:") throw new Error("Dream cursor authority path URI must use file:");
  if (parsedUri.hostname) throw new Error("Dream cursor authority path URI must not use a host");
  let rawPath: string;
  if (temporal.pathStyle === "windows") {
    rawPath = decodeURIComponent(parsedUri.pathname).replace(/^\/([A-Za-z]:)/, "$1").replaceAll("/", "\\");
  } else if (temporal.pathStyle === "posix") {
    rawPath = decodeURIComponent(parsedUri.pathname);
    if (!rawPath.startsWith("/")) throw new Error("Dream cursor authority POSIX path must be absolute");
  } else {
    throw new Error("Dream cursor authority path style is unsupported");
  }
  const titleUri = new URL(requiredText(authority.lastSessionTitleUri, "Dream cursor authority title URI"));
  if (titleUri.protocol !== "file:") throw new Error("Dream cursor authority title URI must use file:");
  const title = decodeURIComponent(titleUri.pathname.split("/").at(-1) ?? "");
  const cursor = validateDreamV13Cursor({
    version: DREAM_V13_CURSOR_VERSION,
    last_run: authority.lastRun,
    last_processed_file: [
      requiredText(temporal.timeKey, "Dream cursor authority time key"),
      requiredText(temporal.provider, "Dream cursor authority provider"),
      requiredText(temporal.sourceKind, "Dream cursor authority source kind"),
      rawPath,
    ].join("|"),
    processed_total: authority.processedTotal,
    last_session_title: title,
    pending_count: authority.pendingCount,
    open_items: authority.openItems,
    next_work: authority.nextWork,
    source_counts: authority.sourceCounts,
    provider_counts: authority.providerCounts,
  });
  authorityFromCursor(cursor);
  return cursor;
}

function migratedEnvelope(record: MemoryRecord): MigratedDreamCursor {
  if (typeof record.value !== "string") throw new Error("canonical Dream cursor authority must be a string scalar");
  const cursor = cursorFromAuthority(JSON.parse(record.value) as unknown);
  return {
    schemaVersion: MEMORY_PLUGIN_SCHEMA_VERSION,
    kind: "dream-v1.3-cursor",
    migratedAt: record.createdAt,
    source: { uri: record.evidence.uri, contentHash: record.evidence.contentHash },
    recordId: record.id,
    legacyCursor: cursor,
    canonicalCursor: { lastSessionEventAt: null, lastSessionEventHash: null },
  };
}

async function publishDreamCursorProjection(state: SharedState, record: MemoryRecord): Promise<MigratedDreamCursor> {
  const migrated = migratedEnvelope(record);
  await publishPluginRuntimeProjection(state, "memory", "dream-v1.3-cursor", migrated);
  return migrated;
}

export async function restoreDreamV13CursorProjection(state: SharedState): Promise<MigratedDreamCursor> {
  const records = await listMemoryRecords(state, {
    scope: "memory-plugin",
    subject: "dream-v1.3",
    predicate: "cursor-authority",
    status: "active",
  });
  if (records.length !== 1) throw new Error(`expected one active canonical Dream cursor record, found ${records.length}`);
  return publishDreamCursorProjection(state, records[0]);
}

export async function migrateDreamV13Cursor(
  state: SharedState,
  sourcePathInput: string,
  options: { now?: Date } = {},
): Promise<MigratedDreamCursor> {
  const sourcePath = path.resolve(sourcePathInput);
  const sourceInfo = await lstat(sourcePath);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error("Dream cursor source must be a regular file");
  if (sourceInfo.size > MAX_DREAM_CURSOR_SOURCE_BYTES) throw new Error("Dream cursor source exceeds the admission size limit");
  const sourceHandle = await open(sourcePath, "r");
  let sourceBytes: Buffer;
  try {
    const opened = await sourceHandle.stat();
    if (!opened.isFile() || opened.dev !== sourceInfo.dev || opened.ino !== sourceInfo.ino || opened.size !== sourceInfo.size) {
      throw new Error("Dream cursor source changed during admission");
    }
    sourceBytes = await sourceHandle.readFile();
    if (sourceBytes.byteLength > MAX_DREAM_CURSOR_SOURCE_BYTES) {
      throw new Error("Dream cursor source exceeds the admission size limit");
    }
    const after = await sourceHandle.stat();
    const pathAfter = await lstat(sourcePath);
    if (
      !after.isFile() ||
      !pathAfter.isFile() ||
      pathAfter.isSymbolicLink() ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      pathAfter.dev !== after.dev ||
      pathAfter.ino !== after.ino ||
      pathAfter.size !== after.size ||
      sourceBytes.byteLength !== after.size
    ) {
      throw new Error("Dream cursor source changed during admission");
    }
  } finally {
    await sourceHandle.close();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceBytes.toString("utf8"));
  } catch {
    throw new Error("Dream cursor source is not valid JSON");
  }
  const sourceHash = sha256(sourceBytes);
  const cursor = validateDreamV13Cursor(parsed);
  const authority = authorityFromCursor(cursor);
  const record = await applyMemoryCandidate(
    state,
    {
      schemaVersion: MEMORY_PLUGIN_SCHEMA_VERSION,
      kind: "migration",
      scope: "memory-plugin",
      subject: "dream-v1.3",
      predicate: "cursor-authority",
      value: canonicalJson(authority),
      evidence: {
        uri: cursorSourceUri(sourcePath),
        contentHash: sourceHash,
        sourceClass: "verified",
        confidence: 1,
      },
      sensitivity: "sensitive",
      observedAt: cursor.last_run,
      status: "active",
    },
    { now: options.now, authorId: "memory-plugin:migration" },
  );
  return publishDreamCursorProjection(state, record);
}

export async function memoryPluginStatus(state: SharedState): Promise<{
  records: Record<MemoryCandidateKind, number>;
  migration: null | { recordId: string; observedAt: string; contentHash: string };
  cursorProjection: string;
}> {
  const records = await listMemoryRecords(state);
  const owned = records.filter((record) =>
    ["reflection", "dream", "corpus", "memory-plugin"].includes(record.scope),
  );
  const migration = owned.find(
    (record) =>
      record.scope === "memory-plugin" &&
      record.subject === "dream-v1.3" &&
      record.predicate === "cursor-authority" &&
      record.status === "active",
  );
  return {
    records: {
      reflection: owned.filter((record) => record.scope === "reflection").length,
      dream: owned.filter((record) => record.scope === "dream").length,
      corpus: owned.filter((record) => record.scope === "corpus").length,
      migration: owned.filter((record) => record.scope === "memory-plugin").length,
    },
    migration: migration
      ? { recordId: migration.id, observedAt: migration.observedAt, contentHash: migration.evidence.contentHash }
      : null,
    cursorProjection: dreamCursorPath(state),
  };
}
