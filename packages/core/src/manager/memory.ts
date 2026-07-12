import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { chmod, link, lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import type { SharedState } from "./state";
import {
  ensureStateV2,
  retryWindowsFileOperation,
  readStateManifest,
  stateV2Paths,
  writeTextAtomic,
  type AgentStateManifest,
} from "./state-v2";

export const MEMORY_AGENT_ID = "rommie" as const;
export const MEMORY_SCHEMA_VERSION = 2 as const;

export type MemoryScalar = string | number | boolean | null;
export type MemorySourceClass = "verified" | "inferred";
export type MemorySensitivity = "public" | "internal" | "sensitive" | "secret";
export type MemoryRecordStatus = "active" | "superseded" | "retracted" | "disputed" | "parked";

export interface MemoryEvidence {
  uri: string;
  contentHash: string;
  sourceClass: MemorySourceClass;
  confidence: number;
}

export interface MemoryRecord {
  schemaVersion: typeof MEMORY_SCHEMA_VERSION;
  id: string;
  agentId: typeof MEMORY_AGENT_ID;
  scope: string;
  subject: string;
  predicate: string;
  value: MemoryScalar;
  evidence: MemoryEvidence;
  sensitivity: MemorySensitivity;
  observedAt: string;
  validFrom: string;
  expiresAt?: string;
  createdAt: string;
  machineId: string;
  authorId: string;
  status: MemoryRecordStatus;
  statusChangedAt: string;
  supersedes: string[];
  supersededBy?: string;
  retraction?: {
    at: string;
    evidence: MemoryEvidence;
    reason?: string;
  };
}

interface MemoryRecordSeed {
  id: string;
  scope: string;
  subject: string;
  predicate: string;
  value: MemoryScalar;
  evidence: MemoryEvidence;
  sensitivity: MemorySensitivity;
  observedAt: string;
  validFrom: string;
  expiresAt?: string;
  status: "active" | "disputed";
}

interface MemoryEventBase {
  schemaVersion: typeof MEMORY_SCHEMA_VERSION;
  id: string;
  agentId: typeof MEMORY_AGENT_ID;
  machineId: string;
  machineSequence: number;
  authorId: string;
  at: string;
  previousEventHash: string | null;
  eventHash: string;
}

export type MemoryEvent = MemoryEventBase &
  (
    | {
        type: "memory.remembered";
        data: { record: MemoryRecordSeed };
      }
    | {
        type: "memory.superseded";
        data: { record: MemoryRecordSeed; supersedes: string[] };
      }
    | {
        type: "memory.retracted";
        data: { recordId: string; evidence: MemoryEvidence; reason?: string };
      }
  );

type MemoryEventDraft =
  | { type: "memory.remembered"; data: { record: MemoryRecordSeed } }
  | { type: "memory.superseded"; data: { record: MemoryRecordSeed; supersedes: string[] } }
  | { type: "memory.retracted"; data: { recordId: string; evidence: MemoryEvidence; reason?: string } };

export interface RememberMemoryInput {
  scope: string;
  subject: string;
  predicate: string;
  value: MemoryScalar;
  evidence: MemoryEvidence;
  sensitivity?: MemorySensitivity;
  observedAt?: string;
  validFrom?: string;
  expiresAt?: string;
  status?: "active" | "disputed";
  supersedes?: string[];
}

export interface SupersedeMemoryInput {
  value: MemoryScalar;
  evidence: MemoryEvidence;
  sensitivity?: MemorySensitivity;
  observedAt?: string;
  validFrom?: string;
  expiresAt?: string;
}

export interface MemoryOperationOptions {
  now?: Date;
  authorId?: string;
}

export interface MemoryListFilter {
  scope?: string;
  status?: MemoryRecordStatus;
  subject?: string;
  predicate?: string;
}

export interface MemoryStatus {
  agentId: typeof MEMORY_AGENT_ID;
  records: number;
  events: number;
  byStatus: Record<MemoryRecordStatus, number>;
  activeStartupRecords: number;
  secretRecords: number;
  startupView: string;
  projectionHash: string;
}

export interface RenderStartupResult {
  filePath: string;
  changed: boolean;
  included: number;
  omitted: number;
  content: string;
  projectionHash: string;
}

export interface MemoryIntegrityInspection {
  ok: boolean;
  eventIntegrity: boolean;
  projectionIntegrity: boolean;
  events: number;
  records: number;
  eventHeads: Record<string, string>;
  projectionHash: string | null;
  issues: string[];
}

export interface MemoryProjectionRebuild {
  events: number;
  records: number;
  eventHeads: Record<string, string>;
  projectionHash: string;
  startupView: string;
  startupContent: string;
}

const MEMORY_RECORD_STATUSES = new Set<MemoryRecordStatus>([
  "active",
  "superseded",
  "retracted",
  "disputed",
  "parked",
]);
const MEMORY_SENSITIVITIES = new Set<MemorySensitivity>(["public", "internal", "sensitive", "secret"]);
const SOURCE_CLASSES = new Set<MemorySourceClass>(["verified", "inferred"]);
const SHA256 = /^[a-f0-9]{64}$/;
const SOURCE_URI = /^[a-z][a-z0-9+.-]*:/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const EVENT_FILE = /^(\d{16})-([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.json$/;
const RECORD_FILE = /^([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.json$/;
const DEFAULT_STARTUP_RECORDS = 50;
const DEFAULT_STARTUP_CHARS = 12_000;
const LOCK_LEASE_MS = 5 * 60_000;
const LOCK_WAIT_MS = 10_000;
const PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1_000).toISOString();

export const EMPTY_STARTUP_MEMORY_VIEW =
  "<!-- Generated projection from immutable canonical memory events. Do not edit directly. -->\n" +
  "# Canonical startup context\n\n" +
  `Agent: ${MEMORY_AGENT_ID}\n` +
  "Projection through: none\n\n" +
  "No active non-secret memory records.\n";

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (/\r|\n|\0/.test(normalized)) throw new Error(`${field} must be a single line`);
  return normalized;
}

function assertNormalizedText(value: unknown, field: string): asserts value is string {
  const normalized = requiredText(value, field);
  if (value !== normalized) throw new Error(`${field} must be normalized`);
}

function validateId(value: unknown, field: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error(`${field} is invalid`);
  return value;
}

function isoTimestamp(value: string | undefined, fallback: string, field: string): string {
  if (value === undefined) return fallback;
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${field} must be an ISO-compatible timestamp`);
  return new Date(value).toISOString();
}

function assertIsoTimestamp(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${field} must be a normalized ISO timestamp`);
  }
}

function assertObject(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${field} must be a plain object`);
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  field: string,
): void {
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `${field} has invalid fields` +
        (missing.length > 0 ? `; missing ${missing.join(", ")}` : "") +
        (unknown.length > 0 ? `; unknown ${unknown.join(", ")}` : ""),
    );
  }
}

function validateScalar(value: unknown): asserts value is MemoryScalar {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  throw new Error("memory value must be a finite JSON scalar (string, number, boolean, or null)");
}

function assertEvidence(value: unknown, field: string): asserts value is MemoryEvidence {
  assertObject(value, field);
  assertExactKeys(value, ["uri", "contentHash", "sourceClass", "confidence"], [], field);
  assertNormalizedText(value.uri, `${field} uri`);
  if (!SOURCE_URI.test(value.uri)) throw new Error(`${field} uri must include a URI scheme`);
  if (typeof value.contentHash !== "string" || !SHA256.test(value.contentHash)) {
    throw new Error(`${field} content hash must be a lowercase SHA-256 digest`);
  }
  if (!SOURCE_CLASSES.has(value.sourceClass as MemorySourceClass)) {
    throw new Error(`${field} source class must be verified or inferred`);
  }
  if (typeof value.confidence !== "number" || value.confidence < 0 || value.confidence > 1) {
    throw new Error(`${field} confidence must be between 0 and 1`);
  }
}

export function validateMemoryEvidence(evidence: MemoryEvidence | undefined): MemoryEvidence {
  if (!evidence || typeof evidence !== "object") throw new Error("memory evidence is required");
  const normalized: MemoryEvidence = {
    uri: requiredText(evidence.uri, "evidence uri"),
    contentHash: requiredText(evidence.contentHash, "evidence content hash").toLowerCase(),
    sourceClass: evidence.sourceClass,
    confidence: evidence.confidence,
  };
  assertEvidence(normalized, "memory evidence");
  return normalized;
}

function validateRecordId(recordId: string): string {
  return validateId(requiredText(recordId, "memory record id"), "memory record id");
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical memory cannot contain non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("canonical memory can contain only plain objects and arrays");
    }
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const member = (value as Record<string, unknown>)[key];
      if (member !== undefined) output[key] = canonicalize(member);
    }
    return output;
  }
  throw new Error(`canonical memory cannot contain ${typeof value}`);
}

function canonicalClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(canonicalize(value))) as T;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function withoutEventHash(event: MemoryEvent): Omit<MemoryEvent, "eventHash"> {
  const { eventHash: _eventHash, ...unsigned } = event;
  return unsigned;
}

function assertRecordSeed(value: unknown, field: string): asserts value is MemoryRecordSeed {
  assertObject(value, field);
  assertExactKeys(
    value,
    [
      "id",
      "scope",
      "subject",
      "predicate",
      "value",
      "evidence",
      "sensitivity",
      "observedAt",
      "validFrom",
      "status",
    ],
    ["expiresAt"],
    field,
  );
  validateId(value.id, `${field} id`);
  assertNormalizedText(value.scope, `${field} scope`);
  assertNormalizedText(value.subject, `${field} subject`);
  assertNormalizedText(value.predicate, `${field} predicate`);
  validateScalar(value.value);
  assertEvidence(value.evidence, `${field} evidence`);
  if (!MEMORY_SENSITIVITIES.has(value.sensitivity as MemorySensitivity)) {
    throw new Error(`${field} sensitivity is invalid`);
  }
  if (value.sensitivity === "secret" && (typeof value.value !== "string" || !value.value.startsWith("secret://"))) {
    throw new Error(`${field} secret values must be opaque secret:// references`);
  }
  assertIsoTimestamp(value.observedAt, `${field} observedAt`);
  assertIsoTimestamp(value.validFrom, `${field} validFrom`);
  if (value.expiresAt !== undefined) assertIsoTimestamp(value.expiresAt, `${field} expiresAt`);
  if (value.status !== "active" && value.status !== "disputed") throw new Error(`${field} status is invalid`);
}

function assertMemoryEvent(value: unknown, filePath: string): asserts value is MemoryEvent {
  assertObject(value, `canonical memory event ${filePath}`);
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "id",
      "agentId",
      "machineId",
      "machineSequence",
      "authorId",
      "at",
      "previousEventHash",
      "eventHash",
      "type",
      "data",
    ],
    [],
    `canonical memory event ${filePath}`,
  );
  if (value.schemaVersion !== MEMORY_SCHEMA_VERSION || value.agentId !== MEMORY_AGENT_ID) {
    throw new Error(`invalid canonical memory event schema or agent: ${filePath}`);
  }
  validateId(value.id, "memory event id");
  validateId(value.machineId, "memory event machine id");
  if (!Number.isSafeInteger(value.machineSequence) || (value.machineSequence as number) < 1) {
    throw new Error(`memory event machine sequence is invalid: ${filePath}`);
  }
  assertNormalizedText(value.authorId, "memory event author id");
  assertIsoTimestamp(value.at, "memory event timestamp");
  if (value.previousEventHash !== null && (typeof value.previousEventHash !== "string" || !SHA256.test(value.previousEventHash))) {
    throw new Error(`memory event previous hash is invalid: ${filePath}`);
  }
  if (typeof value.eventHash !== "string" || !SHA256.test(value.eventHash)) {
    throw new Error(`memory event hash is invalid: ${filePath}`);
  }
  assertObject(value.data, "memory event data");
  if (value.type === "memory.remembered") {
    assertExactKeys(value.data, ["record"], [], "memory.remembered data");
    assertRecordSeed(value.data.record, "memory.remembered record");
  } else if (value.type === "memory.superseded") {
    assertExactKeys(value.data, ["record", "supersedes"], [], "memory.superseded data");
    assertRecordSeed(value.data.record, "memory.superseded record");
    if (value.data.record.status !== "active") throw new Error("memory.superseded records must be active");
    if (!Array.isArray(value.data.supersedes) || value.data.supersedes.length === 0) {
      throw new Error("memory.superseded requires at least one prior record id");
    }
    const supersedes = value.data.supersedes.map((id) => validateId(id, "superseded memory record id"));
    if (new Set(supersedes).size !== supersedes.length) throw new Error("memory.superseded record ids must be unique");
  } else if (value.type === "memory.retracted") {
    assertExactKeys(value.data, ["recordId", "evidence"], ["reason"], "memory.retracted data");
    validateId(value.data.recordId, "retracted memory record id");
    assertEvidence(value.data.evidence, "memory retraction evidence");
    if (value.data.reason !== undefined) assertNormalizedText(value.data.reason, "memory retraction reason");
  } else {
    throw new Error(`unknown canonical memory event type: ${filePath}`);
  }
  if (value.eventHash !== digest(withoutEventHash(value as unknown as MemoryEvent))) {
    throw new Error(`memory event hash mismatch: ${filePath}`);
  }
}

function normalizeRememberInput(input: RememberMemoryInput, now: string): MemoryRecordSeed & { supersedes: string[] } {
  validateScalar(input.value);
  const sensitivity = input.sensitivity ?? "internal";
  if (!MEMORY_SENSITIVITIES.has(sensitivity)) throw new Error(`invalid memory sensitivity: ${sensitivity}`);
  if (sensitivity === "secret" && (typeof input.value !== "string" || !input.value.startsWith("secret://"))) {
    throw new Error("secret memory values must be opaque secret:// references; plaintext secrets are forbidden");
  }
  const status = input.status ?? "active";
  if (status !== "active" && status !== "disputed") throw new Error(`invalid initial memory status: ${status}`);
  const observedAt = isoTimestamp(input.observedAt, now, "observedAt");
  const validFrom = isoTimestamp(input.validFrom, observedAt, "validFrom");
  const expiresAt = input.expiresAt === undefined ? undefined : isoTimestamp(input.expiresAt, now, "expiresAt");
  const supersedes = (input.supersedes ?? []).map((id) => validateRecordId(id));
  if (new Set(supersedes).size !== supersedes.length) throw new Error("superseded memory record ids must be unique");
  if (status === "disputed" && supersedes.length > 0) {
    throw new Error("a disputed record cannot supersede another record");
  }
  return {
    id: randomUUID().replaceAll("-", ""),
    scope: requiredText(input.scope, "memory scope"),
    subject: requiredText(input.subject, "memory subject"),
    predicate: requiredText(input.predicate, "memory predicate"),
    value: input.value,
    evidence: validateMemoryEvidence(input.evidence),
    sensitivity,
    observedAt,
    validFrom,
    ...(expiresAt ? { expiresAt } : {}),
    status,
    supersedes,
  };
}

function recordKey(record: Pick<MemoryRecordSeed, "scope" | "subject" | "predicate">): string {
  return JSON.stringify([MEMORY_AGENT_ID, record.scope, record.subject, record.predicate]);
}

function scalarEquals(left: MemoryScalar, right: MemoryScalar): boolean {
  return Object.is(left, right);
}

function evidenceEquals(left: MemoryEvidence, right: MemoryEvidence): boolean {
  return (
    left.uri === right.uri &&
    left.contentHash === right.contentHash &&
    left.sourceClass === right.sourceClass &&
    left.confidence === right.confidence
  );
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
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`canonical memory path must be a regular directory: ${directory}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  if (process.platform !== "win32") await chmod(directory, 0o700);
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
    throw new Error(`canonical memory event collision: ${filePath}`);
  }
}

interface MemoryStream {
  events: MemoryEvent[];
  eventHeads: Record<string, string>;
}

async function readMemoryEventsUnlocked(state: SharedState): Promise<MemoryStream> {
  const directory = stateV2Paths(state).memoryEventsDir;
  if (!(await pathExists(directory))) return { events: [], eventHeads: {} };
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error(`canonical memory events path must be a regular directory: ${directory}`);
  }

  const events: MemoryEvent[] = [];
  const machineEntries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  for (const machineEntry of machineEntries) {
    validateId(machineEntry.name, "memory event machine partition");
    if (!machineEntry.isDirectory() || machineEntry.isSymbolicLink()) {
      throw new Error(`invalid canonical memory machine partition: ${machineEntry.name}`);
    }
    const machineDirectory = path.join(directory, machineEntry.name);
    const fileEntries = (await readdir(machineDirectory, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const fileEntry of fileEntries) {
      if (!fileEntry.isFile() || fileEntry.isSymbolicLink()) {
        throw new Error(`invalid canonical memory event entry: ${fileEntry.name}`);
      }
      const match = fileEntry.name.match(EVENT_FILE);
      if (!match) throw new Error(`invalid canonical memory event filename: ${fileEntry.name}`);
      const filePath = path.join(machineDirectory, fileEntry.name);
      let serialized: string;
      let parsed: unknown;
      try {
        serialized = await readFile(filePath, "utf8");
        parsed = JSON.parse(serialized);
      } catch (error) {
        throw new Error(`cannot parse canonical memory event ${filePath}: ${(error as Error).message}`);
      }
      assertMemoryEvent(parsed, filePath);
      if (serialized !== `${JSON.stringify(parsed, null, 2)}\n`) {
        throw new Error(`non-canonical memory event serialization: ${filePath}`);
      }
      if (
        parsed.machineId !== machineEntry.name ||
        parsed.machineSequence !== Number(match[1]) ||
        parsed.id !== match[2]
      ) {
        throw new Error(`memory event path identity mismatch: ${filePath}`);
      }
      events.push(parsed);
    }
  }

  const ids = new Set<string>();
  const hashes = new Set<string>();
  const byMachine = new Map<string, MemoryEvent[]>();
  for (const event of events) {
    if (ids.has(event.id)) throw new Error(`duplicate canonical memory event id: ${event.id}`);
    if (hashes.has(event.eventHash)) throw new Error(`duplicate canonical memory event hash: ${event.eventHash}`);
    ids.add(event.id);
    hashes.add(event.eventHash);
    const machineEvents = byMachine.get(event.machineId) ?? [];
    machineEvents.push(event);
    byMachine.set(event.machineId, machineEvents);
  }

  const eventHeads: Record<string, string> = {};
  for (const machineId of [...byMachine.keys()].sort()) {
    const machineEvents = byMachine.get(machineId)!.sort((left, right) => left.machineSequence - right.machineSequence);
    let previousAt: string | null = null;
    for (const [index, event] of machineEvents.entries()) {
      if (event.machineSequence !== index + 1) {
        throw new Error(`non-contiguous canonical memory sequence for ${machineId}`);
      }
      const expectedPrevious = index === 0 ? null : machineEvents[index - 1].eventHash;
      if (event.previousEventHash !== expectedPrevious) throw new Error(`broken canonical memory chain at ${event.id}`);
      if (previousAt !== null && event.at < previousAt) {
        throw new Error(`non-monotonic canonical memory timestamp at ${event.id}`);
      }
      previousAt = event.at;
    }
    eventHeads[machineId] = machineEvents.at(-1)!.eventHash;
  }

  events.sort(
    (left, right) =>
      left.at.localeCompare(right.at) ||
      left.machineId.localeCompare(right.machineId) ||
      left.machineSequence - right.machineSequence ||
      left.id.localeCompare(right.id),
  );
  return { events, eventHeads };
}

function assertActiveScalarInvariant(records: MemoryRecord[]): void {
  const active = new Map<string, string>();
  for (const record of records) {
    if (record.status !== "active") continue;
    const key = recordKey(record);
    const existing = active.get(key);
    if (existing) {
      throw new Error(`canonical memory invariant violated: active records ${existing} and ${record.id} share a scalar key`);
    }
    active.set(key, record.id);
  }
}

function replayMemoryEvents(events: MemoryEvent[]): MemoryRecord[] {
  const records: MemoryRecord[] = [];
  const byId = new Map<string, MemoryRecord>();
  for (const event of events) {
    if (event.type === "memory.remembered" || event.type === "memory.superseded") {
      const seed = event.data.record;
      if (byId.has(seed.id)) throw new Error(`duplicate canonical memory record id: ${seed.id}`);
      const key = recordKey(seed);
      const active = records.filter((record) => record.status === "active" && recordKey(record) === key);
      if (event.type === "memory.remembered") {
        if (seed.status === "active" && active.length > 0) {
          throw new Error(`memory.remembered conflicts with active record ${active[0].id} at ${event.id}`);
        }
        if (seed.status === "disputed") {
          if (active.length !== 1) throw new Error(`disputed memory has no single active record at ${event.id}`);
          if (scalarEquals(active[0].value, seed.value)) {
            throw new Error(`disputed memory does not conflict with active value at ${event.id}`);
          }
        }
      } else {
        if (active.length !== 1 || !event.data.supersedes.includes(active[0].id)) {
          throw new Error(`memory.superseded must explicitly replace the active scalar at ${event.id}`);
        }
        for (const priorId of event.data.supersedes) {
          const prior = byId.get(priorId);
          if (!prior) throw new Error(`memory.superseded references unknown record ${priorId} at ${event.id}`);
          if (recordKey(prior) !== key) {
            throw new Error(`memory.superseded crosses scalar keys for ${priorId} at ${event.id}`);
          }
          if (prior.status === "superseded" || prior.status === "retracted") {
            throw new Error(`memory.superseded references inactive record ${priorId} at ${event.id}`);
          }
          prior.status = "superseded";
          prior.statusChangedAt = event.at;
          prior.supersededBy = seed.id;
        }
      }
      const supersedes = event.type === "memory.superseded" ? [...event.data.supersedes] : [];
      const record: MemoryRecord = {
        schemaVersion: MEMORY_SCHEMA_VERSION,
        id: seed.id,
        agentId: MEMORY_AGENT_ID,
        scope: seed.scope,
        subject: seed.subject,
        predicate: seed.predicate,
        value: seed.value,
        evidence: canonicalClone(seed.evidence),
        sensitivity: seed.sensitivity,
        observedAt: seed.observedAt,
        validFrom: seed.validFrom,
        ...(seed.expiresAt ? { expiresAt: seed.expiresAt } : {}),
        createdAt: event.at,
        machineId: event.machineId,
        authorId: event.authorId,
        status: seed.status,
        statusChangedAt: event.at,
        supersedes,
      };
      records.push(record);
      byId.set(record.id, record);
    } else {
      const prior = byId.get(event.data.recordId);
      if (!prior) throw new Error(`memory.retracted references unknown record ${event.data.recordId} at ${event.id}`);
      if (prior.status === "superseded" || prior.status === "retracted") {
        throw new Error(`memory.retracted references inactive record ${prior.id} at ${event.id}`);
      }
      prior.status = "retracted";
      prior.statusChangedAt = event.at;
      prior.retraction = {
        at: event.at,
        evidence: canonicalClone(event.data.evidence),
        ...(event.data.reason ? { reason: event.data.reason } : {}),
      };
    }
    assertActiveScalarInvariant(records);
  }
  return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

function formatAge(observedAt: string, projectionAt: string): string {
  const milliseconds = Math.max(0, Date.parse(projectionAt) - Date.parse(observedAt));
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function oneLine(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

function isExpired(record: MemoryRecord, projectionAt: string | null): boolean {
  return Boolean(projectionAt && record.expiresAt && Date.parse(record.expiresAt) <= Date.parse(projectionAt));
}

function renderStartupContent(
  records: MemoryRecord[],
  projectionAt: string | null,
): { content: string; included: number; omitted: number } {
  if (records.length === 0 && projectionAt === null) return { content: EMPTY_STARTUP_MEMORY_VIEW, included: 0, omitted: 0 };
  const eligible = records
    .filter(
      (record) =>
        record.status === "active" &&
        record.sensitivity !== "sensitive" &&
        record.sensitivity !== "secret" &&
        !isExpired(record, projectionAt),
    )
    .sort(
      (left, right) =>
        left.scope.localeCompare(right.scope) ||
        left.subject.localeCompare(right.subject) ||
        left.predicate.localeCompare(right.predicate) ||
        right.createdAt.localeCompare(left.createdAt) ||
        left.id.localeCompare(right.id),
    );
  let content =
    "<!-- Generated projection from immutable canonical memory events. Do not edit directly. -->\n" +
    "# Canonical startup context\n\n" +
    `Agent: ${MEMORY_AGENT_ID}\n` +
    `Projection through: ${projectionAt ?? "none"}\n\n`;
  let included = 0;
  if (eligible.length === 0) {
    content += "No active non-secret memory records.\n";
    return { content, included, omitted: 0 };
  }
  for (const record of eligible.slice(0, DEFAULT_STARTUP_RECORDS)) {
    const line =
      `- [${oneLine(record.scope)}] ${oneLine(record.subject)} · ${oneLine(record.predicate)} = ${oneLine(JSON.stringify(record.value))}` +
      ` — ${record.evidence.sourceClass} ${record.evidence.confidence.toFixed(2)}, source ${oneLine(record.evidence.uri)}, age ${formatAge(record.observedAt, projectionAt!)}, id ${record.id}\n`;
    if (content.length + line.length > DEFAULT_STARTUP_CHARS) break;
    content += line;
    included += 1;
  }
  const omitted = eligible.length - included;
  if (omitted > 0) {
    const marker = `\n_${omitted} additional active record${omitted === 1 ? "" : "s"} omitted by canonical startup bounds._\n`;
    if (content.length + marker.length <= DEFAULT_STARTUP_CHARS) content += marker;
  }
  return { content, included, omitted };
}

interface ExpectedMemoryProjection {
  recordFiles: Map<string, string>;
  startup: ReturnType<typeof renderStartupContent>;
  projectionHash: string;
}

function expectedMemoryProjection(stream: MemoryStream, records: MemoryRecord[]): ExpectedMemoryProjection {
  const recordFiles = new Map<string, string>();
  for (const record of records) {
    recordFiles.set(`${validateRecordId(record.id)}.json`, `${JSON.stringify(canonicalize(record), null, 2)}\n`);
  }
  const startup = renderStartupContent(records, stream.events.at(-1)?.at ?? null);
  const projectionHash = digest({
    schemaVersion: MEMORY_SCHEMA_VERSION,
    eventHeads: stream.eventHeads,
    records: records.map((record) => canonicalize(record)),
    startup: startup.content,
  });
  return { recordFiles, startup, projectionHash };
}

async function writeProjectionFileIfChanged(filePath: string, content: string): Promise<boolean> {
  try {
    const info = await lstat(filePath);
    if (info.isFile() && !info.isSymbolicLink() && (await readFile(filePath, "utf8")) === content) {
      if (process.platform !== "win32") await chmod(filePath, 0o600);
      return false;
    }
    if (info.isDirectory()) throw new Error(`memory projection path is a directory: ${filePath}`);
    await rm(filePath, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeTextAtomic(filePath, content, 0o600);
  return true;
}

async function removeStaleProjectionEntries(directory: string, expected: Set<string>): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (expected.has(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    // State-v2 publishers prepare complete bytes beside the destination and
    // then publish with an atomic link/rename or a Windows backup swap.
    // Concurrent cleanup must not delete another live writer's source/backup.
    const publication = entry.name.match(/^\.(.+)\.(\d+)\.[0-9a-f-]{36}\.(tmp|bak)$/i);
    if (publication) {
      try {
        process.kill(Number(publication[2]), 0);
        continue;
      } catch {
        // The publishing process is gone. Restore an expected backup only
        // when its destination is absent; otherwise remove the artifact.
      }
      if (publication[3].toLowerCase() === "bak" && expected.has(publication[1])) {
        const destination = path.join(directory, publication[1]);
        try {
          await lstat(destination);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await retryWindowsFileOperation(() => rename(entryPath, destination));
          continue;
        }
      }
    }
    if (entry.isDirectory()) throw new Error(`unexpected memory projection directory: ${entryPath}`);
    await retryWindowsFileOperation(() => rm(entryPath, { force: true }));
  }
}

async function materializeMemoryProjections(
  state: SharedState,
  stream: MemoryStream,
  records: MemoryRecord[],
): Promise<ExpectedMemoryProjection & { startupChanged: boolean }> {
  const paths = stateV2Paths(state);
  await ensurePrivateDirectory(paths.memoryRecordsDir);
  await ensurePrivateDirectory(paths.memoryViewsDir);
  const expected = expectedMemoryProjection(stream, records);
  await removeStaleProjectionEntries(paths.memoryRecordsDir, new Set(expected.recordFiles.keys()));
  await removeStaleProjectionEntries(paths.memoryViewsDir, new Set(["startup.md"]));
  for (const [name, content] of expected.recordFiles) {
    await writeProjectionFileIfChanged(path.join(paths.memoryRecordsDir, name), content);
  }
  const startupChanged = await writeProjectionFileIfChanged(
    path.join(paths.memoryViewsDir, "startup.md"),
    expected.startup.content,
  );
  await Promise.all([syncDirectory(paths.memoryRecordsDir), syncDirectory(paths.memoryViewsDir)]);
  return { ...expected, startupChanged };
}

interface MemoryLock {
  schemaVersion: typeof MEMORY_SCHEMA_VERSION;
  token: string;
  machineId: string;
  pid: number;
  processStartedAt: string;
  operation: string;
  acquiredAt: string;
  expiresAt: string;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireMemoryLock(
  state: SharedState,
  manifest: AgentStateManifest,
  operation: string,
): Promise<() => Promise<void>> {
  const lockPath = path.join(stateV2Paths(state).runtimeDir, "locks", "memory.lock");
  const deadline = Date.now() + LOCK_WAIT_MS;
  const token = randomUUID();
  while (Date.now() < deadline) {
    const acquired = new Date();
    const document: MemoryLock = {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      token,
      machineId: validateId(manifest.machineId, "Agent OS machine id"),
      pid: process.pid,
      processStartedAt: PROCESS_STARTED_AT,
      operation,
      acquiredAt: acquired.toISOString(),
      expiresAt: new Date(acquired.getTime() + LOCK_LEASE_MS).toISOString(),
    };
    if (await tryCreatePrivateFile(lockPath, `${JSON.stringify(document, null, 2)}\n`)) {
      return async () => {
        try {
          const current = JSON.parse(await retryWindowsFileOperation(() => readFile(lockPath, "utf8"))) as Partial<MemoryLock>;
          if (current.token === token) await retryWindowsFileOperation(() => rm(lockPath, { force: true }));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      };
    }
    try {
      const existing = JSON.parse(await retryWindowsFileOperation(() => readFile(lockPath, "utf8"))) as Partial<MemoryLock>;
      if (typeof existing.expiresAt !== "string" || !Number.isFinite(Date.parse(existing.expiresAt))) {
        throw new Error(`invalid canonical memory lock: ${lockPath}`);
      }
      if (Date.parse(existing.expiresAt) <= Date.now()) {
        const staleToken = existing.token;
        const current = JSON.parse(await retryWindowsFileOperation(() => readFile(lockPath, "utf8"))) as Partial<MemoryLock>;
        if (current.token === staleToken) await retryWindowsFileOperation(() => rm(lockPath, { force: true }));
        continue;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    await delay(20);
  }
  throw new Error(`timed out waiting for canonical memory lock: ${lockPath}`);
}

async function withMemoryLock<T>(
  state: SharedState,
  operation: string,
  now: Date,
  callback: (manifest: AgentStateManifest) => Promise<T>,
): Promise<T> {
  const manifest = (await readStateManifest(state)) ?? await ensureStateV2(state, now);
  const release = await acquireMemoryLock(state, manifest, operation);
  try {
    return await callback(await ensureStateV2(state, now));
  } finally {
    await release();
  }
}

export async function withMemoryEventWriteLock<T>(
  state: SharedState,
  operation: string,
  callback: () => Promise<T>,
): Promise<T> {
  const now = new Date();
  return withMemoryLock(state, operation, now, callback);
}

async function loadCanonicalMemoryUnlocked(
  state: SharedState,
): Promise<{ stream: MemoryStream; records: MemoryRecord[]; projection: ExpectedMemoryProjection & { startupChanged: boolean } }> {
  const stream = await readMemoryEventsUnlocked(state);
  const records = replayMemoryEvents(stream.events);
  const projection = await materializeMemoryProjections(state, stream, records);
  return { stream, records, projection };
}

async function appendEventUnlocked(
  state: SharedState,
  manifest: AgentStateManifest,
  stream: MemoryStream,
  authorId: string,
  at: string,
  draft: MemoryEventDraft,
): Promise<{ event: MemoryEvent; stream: MemoryStream; records: MemoryRecord[]; projection: ExpectedMemoryProjection & { startupChanged: boolean } }> {
  const latestAt = stream.events.at(-1)?.at;
  if (latestAt && at < latestAt) {
    throw new Error(`memory event timestamp ${at} precedes canonical stream head ${latestAt}`);
  }
  const machineId = validateId(manifest.machineId, "Agent OS machine id");
  const machineEvents = stream.events.filter((event) => event.machineId === machineId);
  const machineSequence = machineEvents.length + 1;
  const unsigned = {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    id: randomUUID().replaceAll("-", ""),
    agentId: MEMORY_AGENT_ID,
    machineId,
    machineSequence,
    authorId,
    at,
    previousEventHash: machineEvents.at(-1)?.eventHash ?? null,
    type: draft.type,
    data: canonicalClone(draft.data),
  } as Omit<MemoryEvent, "eventHash">;
  const event = { ...unsigned, eventHash: digest(unsigned) } as MemoryEvent;
  assertMemoryEvent(event, "new event");
  const nextStream: MemoryStream = {
    events: [...stream.events, event].sort(
      (left, right) =>
        left.at.localeCompare(right.at) ||
        left.machineId.localeCompare(right.machineId) ||
        left.machineSequence - right.machineSequence ||
        left.id.localeCompare(right.id),
    ),
    eventHeads: { ...stream.eventHeads, [machineId]: event.eventHash },
  };
  // Replay the complete candidate stream before the irreversible append. This
  // is the single semantic enforcement boundary for both local and exchanged
  // events; caller-side checks exist only to provide earlier, clearer errors.
  const records = replayMemoryEvents(nextStream.events);
  const machineDirectory = path.join(stateV2Paths(state).memoryEventsDir, machineId);
  await ensurePrivateDirectory(machineDirectory);
  const eventFile = path.join(machineDirectory, `${String(machineSequence).padStart(16, "0")}-${event.id}.json`);
  await writeImmutableEvent(eventFile, `${JSON.stringify(event, null, 2)}\n`);
  const projection = await materializeMemoryProjections(state, nextStream, records);
  return { event, stream: nextStream, records, projection };
}

function activeForKey(records: MemoryRecord[], key: string): MemoryRecord[] {
  return records.filter((record) => record.status === "active" && recordKey(record) === key);
}

async function rememberUnlocked(
  state: SharedState,
  manifest: AgentStateManifest,
  canonical: Awaited<ReturnType<typeof loadCanonicalMemoryUnlocked>>,
  normalized: MemoryRecordSeed & { supersedes: string[] },
  now: string,
  authorId: string,
): Promise<MemoryRecord> {
  const key = recordKey(normalized);
  const active = activeForKey(canonical.records, key);
  if (active.length > 1) throw new Error(`canonical memory invariant violated: ${active.length} active scalar records`);
  if (
    normalized.status === "active" &&
    active.length === 1 &&
    scalarEquals(active[0].value, normalized.value) &&
    evidenceEquals(active[0].evidence, normalized.evidence) &&
    active[0].sensitivity === normalized.sensitivity &&
    normalized.supersedes.length === 0
  ) {
    return active[0];
  }
  if (normalized.status === "disputed") {
    if (active.length === 0) throw new Error("a disputed memory requires an existing active record for the same scalar key");
    if (scalarEquals(active[0].value, normalized.value)) {
      throw new Error("a disputed memory must conflict with the active scalar value");
    }
  } else if (normalized.supersedes.length === 0 && active.length > 0) {
    throw new Error(`conflicting active memory ${active[0].id}; explicitly supersede it or remember the new value as disputed`);
  }
  if (normalized.supersedes.length > 0) {
    if (active.length !== 1 || !normalized.supersedes.includes(active[0].id)) {
      throw new Error("explicit supersession must include the active record for the scalar key");
    }
    for (const recordId of normalized.supersedes) {
      const prior = canonical.records.find((record) => record.id === recordId);
      if (!prior) throw new Error(`memory record not found: ${recordId}`);
      if (recordKey(prior) !== key) throw new Error(`cannot supersede a record with a different scalar key: ${recordId}`);
      if (prior.status === "superseded" || prior.status === "retracted") {
        throw new Error(`memory record is already inactive: ${recordId}`);
      }
    }
  }
  const { supersedes, ...seed } = normalized;
  const appended = await appendEventUnlocked(
    state,
    manifest,
    canonical.stream,
    authorId,
    now,
    supersedes.length > 0
      ? { type: "memory.superseded", data: { record: seed, supersedes } }
      : { type: "memory.remembered", data: { record: seed } },
  );
  const record = appended.records.find((candidate) => candidate.id === seed.id);
  if (!record) throw new Error(`canonical replay did not produce memory record ${seed.id}`);
  return record;
}

export async function rememberMemory(
  state: SharedState,
  input: RememberMemoryInput,
  options: MemoryOperationOptions = {},
): Promise<MemoryRecord> {
  const nowDate = options.now ?? new Date();
  const now = nowDate.toISOString();
  const authorId = requiredText(options.authorId ?? "user", "memory author id");
  const normalized = normalizeRememberInput(input, now);
  return withMemoryLock(state, "remember", nowDate, async (manifest) =>
    rememberUnlocked(state, manifest, await loadCanonicalMemoryUnlocked(state), normalized, now, authorId),
  );
}

export async function supersedeMemory(
  state: SharedState,
  recordId: string,
  input: SupersedeMemoryInput,
  options: MemoryOperationOptions = {},
): Promise<MemoryRecord> {
  const priorId = validateRecordId(recordId);
  const nowDate = options.now ?? new Date();
  const now = nowDate.toISOString();
  const authorId = requiredText(options.authorId ?? "user", "memory author id");
  return withMemoryLock(state, "supersede", nowDate, async (manifest) => {
    const canonical = await loadCanonicalMemoryUnlocked(state);
    const prior = canonical.records.find((record) => record.id === priorId);
    if (!prior) throw new Error(`memory record not found: ${priorId}`);
    const normalized = normalizeRememberInput(
      {
        scope: prior.scope,
        subject: prior.subject,
        predicate: prior.predicate,
        value: input.value,
        evidence: input.evidence,
        sensitivity: input.sensitivity ?? prior.sensitivity,
        observedAt: input.observedAt,
        validFrom: input.validFrom,
        expiresAt: input.expiresAt,
        supersedes: [prior.id],
      },
      now,
    );
    return rememberUnlocked(state, manifest, canonical, normalized, now, authorId);
  });
}

export async function retractMemory(
  state: SharedState,
  recordId: string,
  evidence: MemoryEvidence,
  reason?: string,
  options: MemoryOperationOptions = {},
): Promise<MemoryRecord> {
  const id = validateRecordId(recordId);
  const retractionEvidence = validateMemoryEvidence(evidence);
  const nowDate = options.now ?? new Date();
  const now = nowDate.toISOString();
  const authorId = requiredText(options.authorId ?? "user", "memory author id");
  const normalizedReason = reason === undefined || !reason.trim() ? undefined : requiredText(reason, "memory retraction reason");
  return withMemoryLock(state, "retract", nowDate, async (manifest) => {
    const canonical = await loadCanonicalMemoryUnlocked(state);
    const prior = canonical.records.find((record) => record.id === id);
    if (!prior) throw new Error(`memory record not found: ${id}`);
    if (prior.status === "superseded" || prior.status === "retracted") {
      throw new Error(`memory record is already inactive: ${id}`);
    }
    const appended = await appendEventUnlocked(state, manifest, canonical.stream, authorId, now, {
      type: "memory.retracted",
      data: { recordId: id, evidence: retractionEvidence, ...(normalizedReason ? { reason: normalizedReason } : {}) },
    });
    return appended.records.find((record) => record.id === id)!;
  });
}

export async function listMemoryRecords(state: SharedState, filter: MemoryListFilter = {}): Promise<MemoryRecord[]> {
  return withMemoryLock(state, "list", new Date(), async () => {
    const { records } = await loadCanonicalMemoryUnlocked(state);
    return records.filter(
      (record) =>
        (!filter.scope || record.scope === filter.scope) &&
        (!filter.status || record.status === filter.status) &&
        (!filter.subject || record.subject === filter.subject) &&
        (!filter.predicate || record.predicate === filter.predicate),
    );
  });
}

export async function memoryStatus(state: SharedState): Promise<MemoryStatus> {
  return withMemoryLock(state, "status", new Date(), async () => {
    const { stream, records, projection } = await loadCanonicalMemoryUnlocked(state);
    const byStatus: Record<MemoryRecordStatus, number> = {
      active: 0,
      superseded: 0,
      retracted: 0,
      disputed: 0,
      parked: 0,
    };
    for (const record of records) byStatus[record.status] += 1;
    const projectionAt = stream.events.at(-1)?.at ?? null;
    return {
      agentId: MEMORY_AGENT_ID,
      records: records.length,
      events: stream.events.length,
      byStatus,
      activeStartupRecords: records.filter(
        (record) =>
          record.status === "active" &&
          record.sensitivity !== "sensitive" &&
          record.sensitivity !== "secret" &&
          !isExpired(record, projectionAt),
      ).length,
      secretRecords: records.filter((record) => record.sensitivity === "secret").length,
      startupView: path.join(stateV2Paths(state).memoryViewsDir, "startup.md"),
      projectionHash: projection.projectionHash,
    };
  });
}

export async function renderStartupMemory(state: SharedState): Promise<RenderStartupResult> {
  return withMemoryLock(state, "render", new Date(), async () => {
    const { projection } = await loadCanonicalMemoryUnlocked(state);
    return {
      filePath: path.join(stateV2Paths(state).memoryViewsDir, "startup.md"),
      changed: projection.startupChanged,
      ...projection.startup,
      projectionHash: projection.projectionHash,
    };
  });
}

export async function rebuildMemoryProjectionsWhileLocked(state: SharedState): Promise<MemoryProjectionRebuild> {
  const { stream, records, projection } = await loadCanonicalMemoryUnlocked(state);
  return {
    events: stream.events.length,
    records: records.length,
    eventHeads: stream.eventHeads,
    projectionHash: projection.projectionHash,
    startupView: path.join(stateV2Paths(state).memoryViewsDir, "startup.md"),
    startupContent: projection.startup.content,
  };
}

export async function rebuildMemoryProjections(state: SharedState): Promise<MemoryProjectionRebuild> {
  return withMemoryLock(state, "rebuild", new Date(), () => rebuildMemoryProjectionsWhileLocked(state));
}

async function projectionIssues(
  state: SharedState,
  expected: ExpectedMemoryProjection,
): Promise<string[]> {
  const paths = stateV2Paths(state);
  const issues: string[] = [];
  const inspectDirectory = async (directory: string, expectedFiles: Map<string, string>) => {
    let info;
    try {
      info = await lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        issues.push(`memory projection directory is missing: ${directory}`);
        return;
      }
      issues.push(`cannot inspect memory projection directory ${directory}: ${(error as Error).message}`);
      return;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      issues.push(`memory projection path is not a regular directory: ${directory}`);
      return;
    }
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    const actualNames = new Set(entries.map((entry) => entry.name));
    for (const entry of entries) {
      const expectedContent = expectedFiles.get(entry.name);
      const entryPath = path.join(directory, entry.name);
      if (expectedContent === undefined) {
        issues.push(`unexpected memory projection entry: ${entryPath}`);
        continue;
      }
      if (!entry.isFile() || entry.isSymbolicLink()) {
        issues.push(`memory projection is not a regular file: ${entryPath}`);
        continue;
      }
      try {
        if ((await readFile(entryPath, "utf8")) !== expectedContent) {
          issues.push(`memory projection content mismatch: ${entryPath}`);
        }
      } catch (error) {
        issues.push(`cannot read memory projection ${entryPath}: ${(error as Error).message}`);
      }
    }
    for (const name of expectedFiles.keys()) {
      if (!actualNames.has(name)) issues.push(`memory projection is missing: ${path.join(directory, name)}`);
    }
  };
  await inspectDirectory(paths.memoryRecordsDir, expected.recordFiles);
  await inspectDirectory(paths.memoryViewsDir, new Map([["startup.md", expected.startup.content]]));
  return issues;
}

export async function inspectMemoryIntegrity(state: SharedState): Promise<MemoryIntegrityInspection> {
  const issues: string[] = [];
  const eventsDirectory = stateV2Paths(state).memoryEventsDir;
  try {
    const info = await lstat(eventsDirectory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      issues.push(`canonical memory events path is not a regular directory: ${eventsDirectory}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      issues.push(`canonical memory events directory is missing: ${eventsDirectory}`);
    } else {
      issues.push(`cannot inspect canonical memory events path: ${(error as Error).message}`);
    }
  }
  let stream: MemoryStream;
  let records: MemoryRecord[];
  try {
    stream = await readMemoryEventsUnlocked(state);
    records = replayMemoryEvents(stream.events);
  } catch (error) {
    issues.push(`canonical memory event integrity failure: ${(error as Error).message}`);
    return {
      ok: false,
      eventIntegrity: false,
      projectionIntegrity: false,
      events: 0,
      records: 0,
      eventHeads: {},
      projectionHash: null,
      issues,
    };
  }
  const expected = expectedMemoryProjection(stream, records);
  const projectionIntegrityIssues = await projectionIssues(state, expected);
  issues.push(...projectionIntegrityIssues);
  const eventIntegrity = !issues.some((issue) => issue.includes("events path") || issue.includes("events directory"));
  const projectionIntegrity = projectionIntegrityIssues.length === 0;
  return {
    ok: eventIntegrity && projectionIntegrity,
    eventIntegrity,
    projectionIntegrity,
    events: stream.events.length,
    records: records.length,
    eventHeads: stream.eventHeads,
    projectionHash: expected.projectionHash,
    issues,
  };
}

function cliFlag(flags: Record<string, string | boolean>, name: string, required = false): string | undefined {
  const value = flags[name];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (required) throw new Error(`memory command requires --${name} <value>`);
  return undefined;
}

function cliEvidence(flags: Record<string, string | boolean>): MemoryEvidence {
  return validateMemoryEvidence({
    uri: cliFlag(flags, "source", true)!,
    contentHash: cliFlag(flags, "hash", true)!,
    sourceClass: cliFlag(flags, "source-class", true)! as MemorySourceClass,
    confidence: Number(cliFlag(flags, "confidence", true)!),
  });
}

function cliValue(flags: Record<string, string | boolean>): MemoryScalar {
  const json = cliFlag(flags, "value-json");
  if (json !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error("--value-json must contain valid JSON");
    }
    validateScalar(parsed);
    return parsed;
  }
  const value = cliFlag(flags, "value", true)!;
  validateScalar(value);
  return value;
}

function cliSensitivity(flags: Record<string, string | boolean>): MemorySensitivity | undefined {
  const value = cliFlag(flags, "sensitivity") as MemorySensitivity | undefined;
  if (value && !MEMORY_SENSITIVITIES.has(value)) throw new Error(`invalid memory sensitivity: ${value}`);
  return value;
}

function cliOperationOptions(flags: Record<string, string | boolean>): MemoryOperationOptions {
  return { ...(cliFlag(flags, "author") ? { authorId: cliFlag(flags, "author") } : {}) };
}

/** CLI boundary kept here so manager/cli.ts only owns import, help, and dispatch wiring. */
export async function memoryCommand(
  state: SharedState,
  values: string[],
  flags: Record<string, string | boolean>,
): Promise<void> {
  const action = values[0];
  if (action === "remember") {
    const supersedes = cliFlag(flags, "supersedes")
      ?.split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    const record = await rememberMemory(
      state,
      {
        scope: cliFlag(flags, "scope", true)!,
        subject: cliFlag(flags, "subject", true)!,
        predicate: cliFlag(flags, "predicate", true)!,
        value: cliValue(flags),
        evidence: cliEvidence(flags),
        sensitivity: cliSensitivity(flags),
        observedAt: cliFlag(flags, "observed-at"),
        validFrom: cliFlag(flags, "valid-from"),
        expiresAt: cliFlag(flags, "expires-at"),
        status: flags.disputed ? "disputed" : "active",
        supersedes,
      },
      cliOperationOptions(flags),
    );
    console.log(flags.json ? JSON.stringify(record, null, 2) : `remembered ${record.id} (${record.status})`);
    return;
  }
  if (action === "supersede") {
    const recordId = values[1];
    if (!recordId) throw new Error("memory supersede requires a record id");
    const record = await supersedeMemory(
      state,
      recordId,
      {
        value: cliValue(flags),
        evidence: cliEvidence(flags),
        sensitivity: cliSensitivity(flags),
        observedAt: cliFlag(flags, "observed-at"),
        validFrom: cliFlag(flags, "valid-from"),
        expiresAt: cliFlag(flags, "expires-at"),
      },
      cliOperationOptions(flags),
    );
    console.log(flags.json ? JSON.stringify(record, null, 2) : `superseded ${recordId} with ${record.id}`);
    return;
  }
  if (action === "retract") {
    const recordId = values[1];
    if (!recordId) throw new Error("memory retract requires a record id");
    const record = await retractMemory(
      state,
      recordId,
      cliEvidence(flags),
      cliFlag(flags, "reason"),
      cliOperationOptions(flags),
    );
    console.log(flags.json ? JSON.stringify(record, null, 2) : `retracted ${record.id}`);
    return;
  }
  if (action === "list") {
    const status = cliFlag(flags, "status") as MemoryRecordStatus | undefined;
    if (status && !MEMORY_RECORD_STATUSES.has(status)) throw new Error(`invalid memory status: ${status}`);
    const records = await listMemoryRecords(state, {
      scope: cliFlag(flags, "scope"),
      subject: cliFlag(flags, "subject"),
      predicate: cliFlag(flags, "predicate"),
      status,
    });
    if (flags.json) console.log(JSON.stringify(records, null, 2));
    else {
      for (const record of records) {
        console.log(
          `${record.id} ${record.status.padEnd(10)} ${record.scope}:${record.subject}.${record.predicate} = ${JSON.stringify(record.value)}`,
        );
      }
    }
    return;
  }
  if (action === "status") {
    const status = await memoryStatus(state);
    if (flags.json) console.log(JSON.stringify(status, null, 2));
    else {
      console.log(`agent: ${status.agentId}`);
      console.log(`records: ${status.records}; events: ${status.events}; startup-active: ${status.activeStartupRecords}`);
      console.log(`projection: ${status.projectionHash}`);
      console.log(`view: ${status.startupView}`);
    }
    return;
  }
  if (action === "render") {
    if (flags["max-records"] !== undefined || flags["max-chars"] !== undefined) {
      throw new Error("canonical startup projection bounds are fixed and cannot be overridden");
    }
    const result = await renderStartupMemory(state);
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else console.log(`${result.changed ? "rendered" : "unchanged"} ${result.filePath} (${result.included} included)`);
    return;
  }
  throw new Error(
    "memory requires remember, list, status, supersede, retract, or render; mutating commands require explicit evidence flags",
  );
}
