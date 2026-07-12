import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { chmod, link, lstat, mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import type { SharedState } from "./state";
import { withRenewableStateLock } from "./state-lock";
import { writeTextAtomic } from "./state-v2";

export interface OrchestratorHeartbeat {
  lastBeatAt: string;
  nextCheckAt: string;
  provider: string;
  model: string;
}

export interface OrchestratorLedgerEntry {
  at: string;
  action: string;
  repo?: string;
  issue?: number;
  note?: string;
}

export interface OrchestratorStateDoc {
  baton: {
    active: boolean;
    holder: string;
    since: string;
    expiresAt: string;
    provider: string;
    model: string;
  };
  heartbeat: OrchestratorHeartbeat;
  ledger: OrchestratorLedgerEntry[];
}

export interface OrchestratorIntegrityInspection {
  ok: boolean;
  events: number;
  eventIntegrity: boolean;
  projectionIntegrity: boolean;
  authority: "none" | "active" | "released" | "expired";
  holder: string | null;
  issues: string[];
}

interface OrchestratorEventBase {
  schemaVersion: 1;
  id: string;
  machineId: string;
  machineSequence: number;
  lamport: number;
  at: string;
  previousEventHash: string | null;
  eventHash: string;
}

export type OrchestratorEvent = OrchestratorEventBase &
  (
    | {
        type: "orchestrator.initialized" | "baton.acquired";
        data: { sessionId: string; provider: string; model: string; leaseExpiresAt: string };
      }
    | {
        type: "heartbeat.recorded";
        data: {
          sessionId: string;
          provider: string;
          model: string;
          nextCheckAt: string;
          leaseExpiresAt: string;
        };
      }
    | {
        type: "ledger.appended";
        data: {
          sessionId: string;
          entry: Omit<OrchestratorLedgerEntry, "at">;
        };
      }
    | {
        type: "baton.released";
        data: { sessionId: string };
      }
  );

type OrchestratorEventDraft = Omit<OrchestratorEvent, keyof OrchestratorEventBase | "type" | "data"> &
  Pick<OrchestratorEvent, "type" | "data">;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const EVENT_FILE = /^(\d{16})-([A-Za-z0-9_-]+)\.json$/;
const HEARTBEAT_INTERVAL_MS = 60_000;
const BATON_LEASE_MS = 5 * 60_000;
const LOCK_LEASE_MS = 60_000;
const LOCK_HEARTBEAT_MS = 5_000;
const LOCK_WAIT_MS = 10_000;

export const orchestratorStateDir = (state: SharedState): string => path.join(state.stateDir, "orchestrator");

function orchestratorPaths(state: SharedState) {
  const directory = orchestratorStateDir(state);
  return {
    directory,
    eventsDirectory: path.join(directory, "events"),
    markdownProjection: path.join(directory, "STATE.md"),
    jsonProjection: path.join(directory, "state.json"),
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function validateId(value: unknown, field: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value) || value === "." || value === "..") {
    throw new Error(`${field} is invalid`);
  }
  return value;
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

function eventDigest(value: Omit<OrchestratorEvent, "eventHash">): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function canonicalClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(canonicalize(value))) as T;
}

function withoutEventHash(event: OrchestratorEvent): Omit<OrchestratorEvent, "eventHash"> {
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

async function readMachineId(state: SharedState): Promise<string> {
  const manifestFile = path.join(state.stateDir, "manifest.json");
  let info;
  try {
    info = await lstat(manifestFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Agent OS manifest is required before orchestrator use: ${manifestFile}`);
    }
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Agent OS manifest must be a regular file: ${manifestFile}`);
  const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as { schemaVersion?: unknown; machineId?: unknown };
  if (manifest.schemaVersion !== 2) throw new Error(`Agent OS v2 manifest is required before orchestrator use: ${manifestFile}`);
  return validateId(manifest.machineId, "Agent OS machine id");
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
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    try {
      await link(temporary, filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    if (process.platform !== "win32") await chmod(filePath, 0o600);
    await syncDirectory(directory);
    return true;
  } finally {
    await rm(temporary, { force: true });
  }
}

async function writeImmutableEvent(filePath: string, content: string): Promise<void> {
  if (!(await tryCreatePrivateFile(filePath, content))) {
    throw new Error(`canonical orchestrator event already exists: ${filePath}`);
  }
}

export async function ensureOrchestratorState(state: SharedState): Promise<void> {
  const paths = orchestratorPaths(state);
  await Promise.all([
    ensurePrivateDirectory(paths.directory),
    ensurePrivateDirectory(paths.eventsDirectory),
  ]);
}

export function orchestratorStateMarkdown(doc: OrchestratorStateDoc): string {
  const ledgerRows = doc.ledger
    .map(
      (entry) =>
        `| ${entry.at} | ${entry.action} | ${entry.repo ?? ""} | ${entry.issue ?? ""} | ${entry.note ?? ""} |`,
    )
    .join("\n");
  return `<!-- Generated projection from immutable orchestrator events. Do not edit. -->
# Orchestrator State

## Baton
- active: ${doc.baton.active}
- holder: ${doc.baton.holder}
- since: ${doc.baton.since}
- expiresAt: ${doc.baton.expiresAt}
- provider: ${doc.baton.provider}/${doc.baton.model}

## Heartbeat
- lastBeatAt: ${doc.heartbeat.lastBeatAt}
- nextCheckAt: ${doc.heartbeat.nextCheckAt}
- provider: ${doc.heartbeat.provider}/${doc.heartbeat.model}

## Ledger

| at | action | repo | issue | note |
|---|---|---|---|---|
${ledgerRows}
`;
}

function extractSection(text: string, heading: string): string {
  const pattern = new RegExp(`(?:^|\\n)## ${heading}\\n([\\s\\S]*?)(?=\\n## |\\n# |$)`);
  const match = text.match(pattern);
  return match ? match[1].trim() : "";
}

/** Pure projection parser for display tests; runtime state is never loaded from Markdown. */
export function parseStateMarkdown(text: string): OrchestratorStateDoc {
  const batonSection = extractSection(text, "Baton");
  const heartbeatSection = extractSection(text, "Heartbeat");
  const holder = batonSection.match(/^- holder: (.+)$/m)?.[1]?.trim() ?? "";
  const active = batonSection.match(/^- active: (true|false)$/m)?.[1] === "true";
  const since = batonSection.match(/^- since: (.+)$/m)?.[1]?.trim() ?? "";
  const expiresAt = batonSection.match(/^- expiresAt: (.+)$/m)?.[1]?.trim() ?? "";
  const batonProvider = batonSection.match(/^- provider: (.+)\/(.+)$/m);
  const lastBeatAt = heartbeatSection.match(/^- lastBeatAt: (.+)$/m)?.[1]?.trim() ?? "";
  const nextCheckAt = heartbeatSection.match(/^- nextCheckAt: (.+)$/m)?.[1]?.trim() ?? "";
  const heartbeatProvider = heartbeatSection.match(/^- provider: (.+)\/(.+)$/m);
  const ledgerSection = extractSection(text, "Ledger");
  const ledgerLines = ledgerSection.split("\n").filter((line) => line.startsWith("| ") && !line.includes("---"));
  const ledger = ledgerLines.slice(1).map((line) => {
    const cells = line.split("|").map((cell) => cell.trim());
    return {
      at: cells[1] ?? "",
      action: cells[2] ?? "",
      repo: cells[3] || undefined,
      issue: cells[4] ? Number(cells[4]) : undefined,
      note: cells[5] || undefined,
    };
  });
  return {
    baton: {
      active,
      holder,
      since,
      expiresAt,
      provider: batonProvider?.[1]?.trim() ?? "",
      model: batonProvider?.[2]?.trim() ?? "",
    },
    heartbeat: {
      lastBeatAt,
      nextCheckAt,
      provider: heartbeatProvider?.[1]?.trim() ?? "",
      model: heartbeatProvider?.[2]?.trim() ?? "",
    },
    ledger,
  };
}

function assertEvent(value: unknown, filePath: string): asserts value is OrchestratorEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid canonical orchestrator event: ${filePath}`);
  }
  const event = value as Partial<OrchestratorEvent>;
  if (
    event.schemaVersion !== 1 ||
    typeof event.id !== "string" ||
    !SAFE_ID.test(event.id) ||
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
    throw new Error(`invalid canonical orchestrator event envelope: ${filePath}`);
  }
  validateId(event.machineId, "orchestrator event machine id");
  assertIsoTimestamp(event.at, "orchestrator event at");
  assertObject(event.data, "orchestrator event data");
  if (event.type === "orchestrator.initialized" || event.type === "baton.acquired") {
    validateId(event.data.sessionId, `${event.type} session id`);
    requiredString(event.data.provider, `${event.type} provider`);
    requiredString(event.data.model, `${event.type} model`);
    assertIsoTimestamp(event.data.leaseExpiresAt, `${event.type} lease expiry`);
  } else if (event.type === "heartbeat.recorded") {
    validateId(event.data.sessionId, "heartbeat session id");
    requiredString(event.data.provider, "heartbeat provider");
    requiredString(event.data.model, "heartbeat model");
    assertIsoTimestamp(event.data.nextCheckAt, "heartbeat next check");
    assertIsoTimestamp(event.data.leaseExpiresAt, "heartbeat lease expiry");
  } else if (event.type === "ledger.appended") {
    validateId(event.data.sessionId, "ledger session id");
    assertObject(event.data.entry, "ledger entry");
    requiredString(event.data.entry.action, "ledger action");
    if (event.data.entry.issue !== undefined && !Number.isSafeInteger(event.data.entry.issue)) {
      throw new Error(`ledger issue must be an integer: ${filePath}`);
    }
  } else if (event.type === "baton.released") {
    validateId(event.data.sessionId, "released baton session id");
  } else {
    throw new Error(`unknown canonical orchestrator event type: ${filePath}`);
  }
  if (event.eventHash !== eventDigest(withoutEventHash(event as OrchestratorEvent))) {
    throw new Error(`orchestrator event hash mismatch: ${filePath}`);
  }
}

async function readEventsUnlocked(state: SharedState): Promise<OrchestratorEvent[]> {
  const paths = orchestratorPaths(state);
  if (!(await pathExists(paths.eventsDirectory))) return [];
  const eventsInfo = await lstat(paths.eventsDirectory);
  if (!eventsInfo.isDirectory() || eventsInfo.isSymbolicLink()) {
    throw new Error(`canonical orchestrator events path must be a regular directory: ${paths.eventsDirectory}`);
  }
  const events: OrchestratorEvent[] = [];
  const machineEntries = await readdir(paths.eventsDirectory, { withFileTypes: true });
  for (const machineEntry of machineEntries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (machineEntry.name.startsWith(".")) continue;
    validateId(machineEntry.name, "orchestrator event machine partition");
    if (!machineEntry.isDirectory() || machineEntry.isSymbolicLink()) {
      throw new Error(`invalid canonical orchestrator machine partition: ${machineEntry.name}`);
    }
    const machineDirectory = path.join(paths.eventsDirectory, machineEntry.name);
    const fileEntries = await readdir(machineDirectory, { withFileTypes: true });
    for (const fileEntry of fileEntries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (fileEntry.name.startsWith(".")) continue;
      if (!fileEntry.isFile() || fileEntry.isSymbolicLink()) {
        throw new Error(`invalid canonical orchestrator event entry: ${fileEntry.name}`);
      }
      const match = fileEntry.name.match(EVENT_FILE);
      if (!match) throw new Error(`invalid canonical orchestrator event filename: ${fileEntry.name}`);
      const filePath = path.join(machineDirectory, fileEntry.name);
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(filePath, "utf8"));
      } catch (error) {
        throw new Error(`cannot parse canonical orchestrator event ${filePath}: ${String(error)}`);
      }
      assertEvent(parsed, filePath);
      if (
        parsed.machineId !== machineEntry.name ||
        parsed.machineSequence !== Number(match[1]) ||
        parsed.id !== match[2]
      ) {
        throw new Error(`orchestrator event path identity mismatch: ${filePath}`);
      }
      events.push(parsed);
    }
  }
  events.sort(
    (left, right) =>
      left.lamport - right.lamport ||
      left.machineId.localeCompare(right.machineId) ||
      left.machineSequence - right.machineSequence ||
      left.id.localeCompare(right.id),
  );
  const ids = new Set<string>();
  const hashes = new Set<string>();
  const machineEvents = new Map<string, OrchestratorEvent[]>();
  for (const event of events) {
    if (ids.has(event.id)) throw new Error(`duplicate canonical orchestrator event id: ${event.id}`);
    if (hashes.has(event.eventHash)) throw new Error(`duplicate canonical orchestrator event hash: ${event.eventHash}`);
    ids.add(event.id);
    hashes.add(event.eventHash);
    const partition = machineEvents.get(event.machineId) ?? [];
    partition.push(event);
    machineEvents.set(event.machineId, partition);
  }
  for (const [machineId, partition] of machineEvents) {
    partition.sort((left, right) => left.machineSequence - right.machineSequence);
    for (const [index, event] of partition.entries()) {
      if (event.machineSequence !== index + 1) {
        throw new Error(`non-contiguous orchestrator machine sequence for ${machineId}`);
      }
      const previous = partition[index - 1];
      if (event.previousEventHash !== (previous?.eventHash ?? null)) {
        throw new Error(`broken canonical orchestrator chain at ${event.id}`);
      }
      if (previous && event.lamport <= previous.lamport) {
        throw new Error(`non-monotonic orchestrator Lamport clock at ${event.id}`);
      }
    }
  }
  return events;
}

function replayEvents(events: OrchestratorEvent[]): OrchestratorStateDoc | null {
  if (events.length === 0) return null;
  if (events[0].type !== "orchestrator.initialized") {
    throw new Error("canonical orchestrator stream has no initialization event");
  }
  if (events.some((event, index) => index > 0 && event.type === "orchestrator.initialized")) {
    throw new Error("canonical orchestrator stream has multiple initialization events");
  }
  let state: OrchestratorStateDoc | null = null;
  const ledger: OrchestratorLedgerEntry[] = [];
  for (const event of events) {
    if (event.type === "orchestrator.initialized" || event.type === "baton.acquired") {
      state = {
        baton: {
          active: true,
          holder: event.data.sessionId,
          since: event.at,
          expiresAt: event.data.leaseExpiresAt,
          provider: event.data.provider,
          model: event.data.model,
        },
        heartbeat: {
          lastBeatAt: event.at,
          nextCheckAt: new Date(Date.parse(event.at) + HEARTBEAT_INTERVAL_MS).toISOString(),
          provider: event.data.provider,
          model: event.data.model,
        },
        ledger,
      };
    } else if (event.type === "heartbeat.recorded") {
      if (!state || !state.baton.active || state.baton.holder !== event.data.sessionId) {
        throw new Error(`heartbeat is not owned by the projected baton holder at ${event.id}`);
      }
      state.baton.expiresAt = event.data.leaseExpiresAt;
      state.baton.provider = event.data.provider;
      state.baton.model = event.data.model;
      state.heartbeat = {
        lastBeatAt: event.at,
        nextCheckAt: event.data.nextCheckAt,
        provider: event.data.provider,
        model: event.data.model,
      };
    } else if (event.type === "ledger.appended") {
      if (!state || !state.baton.active || state.baton.holder !== event.data.sessionId) {
        throw new Error(`ledger entry is not owned by the projected baton holder at ${event.id}`);
      }
      ledger.push({ ...event.data.entry, at: event.at });
    } else if (event.type === "baton.released") {
      if (!state || !state.baton.active || state.baton.holder !== event.data.sessionId) {
        throw new Error(`baton release is not owned by the projected baton holder at ${event.id}`);
      }
      state.baton.active = false;
      state.baton.expiresAt = event.at;
    }
  }
  return state;
}

async function writeProjections(state: SharedState, document: OrchestratorStateDoc): Promise<void> {
  const paths = orchestratorPaths(state);
  await ensurePrivateDirectory(paths.directory);
  await Promise.all([
    writeTextAtomic(paths.jsonProjection, `${JSON.stringify(document, null, 2)}\n`, 0o600),
    writeTextAtomic(paths.markdownProjection, orchestratorStateMarkdown(document), 0o600),
  ]);
  await syncDirectory(paths.directory);
}

async function appendEventUnlocked(
  state: SharedState,
  machineId: string,
  draft: OrchestratorEventDraft,
  now = new Date(),
): Promise<OrchestratorStateDoc> {
  const events = await readEventsUnlocked(state);
  const machineEvents = events.filter((event) => event.machineId === machineId);
  const machineSequence = machineEvents.length + 1;
  const unsigned = {
    schemaVersion: 1 as const,
    id: randomUUID().replaceAll("-", ""),
    machineId,
    machineSequence,
    lamport: events.length + 1,
    at: now.toISOString(),
    previousEventHash: machineEvents.at(-1)?.eventHash ?? null,
    type: draft.type,
    data: canonicalClone(draft.data),
  } as Omit<OrchestratorEvent, "eventHash">;
  const event = { ...unsigned, eventHash: eventDigest(unsigned) } as OrchestratorEvent;
  const machineDirectory = path.join(orchestratorPaths(state).eventsDirectory, machineId);
  await ensurePrivateDirectory(machineDirectory);
  const eventFile = path.join(machineDirectory, `${String(machineSequence).padStart(16, "0")}-${event.id}.json`);
  await writeImmutableEvent(eventFile, `${JSON.stringify(event, null, 2)}\n`);
  const projection = replayEvents([...events, event]);
  if (!projection) throw new Error("orchestrator event replay produced no state");
  await writeProjections(state, projection);
  return projection;
}

async function withOrchestratorLock<T>(
  state: SharedState,
  sessionId: string,
  callback: (machineId: string) => Promise<T>,
): Promise<T> {
  validateId(sessionId, "orchestrator session id");
  return withRenewableStateLock(
    state,
    "orchestrator",
    async (lock) => {
      const machineId = await readMachineId(state);
      await lock.verify();
      return callback(machineId);
    },
    {
      leaseMs: LOCK_LEASE_MS,
      heartbeatMs: LOCK_HEARTBEAT_MS,
      waitMs: LOCK_WAIT_MS,
      owner: `orchestrator:${sessionId}`,
    },
  );
}

export async function withOrchestratorEventWriteLock<T>(
  state: SharedState,
  callback: () => Promise<T>,
): Promise<T> {
  return withOrchestratorLock(state, "event-sync-import", () => callback());
}

async function readAndProjectUnlocked(state: SharedState): Promise<OrchestratorStateDoc | null> {
  const projection = replayEvents(await readEventsUnlocked(state));
  if (projection) await writeProjections(state, projection);
  return projection;
}

export async function readOrchestratorEvents(state: SharedState): Promise<OrchestratorEvent[]> {
  return withOrchestratorLock(state, "event-reader", () => readEventsUnlocked(state));
}

export async function readOrchestratorState(state: SharedState): Promise<OrchestratorStateDoc | null> {
  return withOrchestratorLock(state, "state-reader", () => readAndProjectUnlocked(state));
}

export async function rebuildOrchestratorProjectionWhileLocked(state: SharedState): Promise<OrchestratorStateDoc | null> {
  return readAndProjectUnlocked(state);
}

export async function inspectOrchestratorIntegrity(
  state: SharedState,
  now = new Date(),
): Promise<OrchestratorIntegrityInspection> {
  const paths = orchestratorPaths(state);
  if (!(await pathExists(paths.eventsDirectory))) {
    return {
      ok: true,
      events: 0,
      eventIntegrity: true,
      projectionIntegrity: true,
      authority: "none",
      holder: null,
      issues: [],
    };
  }
  let events: OrchestratorEvent[];
  let projection: OrchestratorStateDoc | null;
  try {
    events = await readEventsUnlocked(state);
    projection = replayEvents(events);
  } catch (error) {
    return {
      ok: false,
      events: 0,
      eventIntegrity: false,
      projectionIntegrity: false,
      authority: "none",
      holder: null,
      issues: [(error as Error).message],
    };
  }
  if (!projection) {
    const candidates = [paths.jsonProjection, paths.markdownProjection];
    const present = await Promise.all(candidates.map((filePath) => pathExists(filePath)));
    const stray = candidates.filter((_, index) => present[index]);
    return {
      ok: stray.length === 0,
      events: 0,
      eventIntegrity: true,
      projectionIntegrity: stray.length === 0,
      authority: "none",
      holder: null,
      issues: stray.map((filePath) => `orchestrator projection exists without events: ${filePath}`),
    };
  }
  const issues: string[] = [];
  for (const [label, filePath, expected] of [
    ["JSON", paths.jsonProjection, `${JSON.stringify(projection, null, 2)}\n`],
    ["Markdown", paths.markdownProjection, orchestratorStateMarkdown(projection)],
  ] as const) {
    try {
      const info = await lstat(filePath);
      if (!info.isFile() || info.isSymbolicLink()) issues.push(`orchestrator ${label} projection must be a physical file`);
      else if ((await readFile(filePath, "utf8")) !== expected) {
        issues.push(`orchestrator ${label} projection does not match immutable events`);
      }
    } catch (error) {
      issues.push(
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? `orchestrator ${label} projection is missing`
          : `cannot inspect orchestrator ${label} projection: ${(error as Error).message}`,
      );
    }
  }
  const authority = projection.baton.active
    ? Date.parse(projection.baton.expiresAt) <= now.getTime()
      ? "expired"
      : "active"
    : "released";
  if (authority === "expired") {
    issues.push(`active orchestrator baton expired at ${projection.baton.expiresAt}`);
  }
  return {
    ok: issues.length === 0,
    events: events.length,
    eventIntegrity: true,
    projectionIntegrity: !issues.some((issue) => issue.includes("projection")),
    authority,
    holder: projection.baton.holder,
    issues,
  };
}

function leaseExpiry(now: Date): string {
  return new Date(now.getTime() + BATON_LEASE_MS).toISOString();
}

function assertBatonAvailable(document: OrchestratorStateDoc, sessionId: string, now: Date): void {
  if (document.baton.active && document.baton.holder !== sessionId && Date.parse(document.baton.expiresAt) > now.getTime()) {
    throw new Error(`orchestrator baton is held by ${document.baton.holder} until ${document.baton.expiresAt}`);
  }
}

async function ensureBatonUnlocked(
  state: SharedState,
  machineId: string,
  sessionId: string,
  provider: string,
  model: string,
  now: Date,
): Promise<OrchestratorStateDoc> {
  const current = replayEvents(await readEventsUnlocked(state));
  if (!current) {
    return appendEventUnlocked(
      state,
      machineId,
      {
        type: "orchestrator.initialized",
        data: { sessionId, provider, model, leaseExpiresAt: leaseExpiry(now) },
      },
      now,
    );
  }
  assertBatonAvailable(current, sessionId, now);
  if (!current.baton.active || current.baton.holder !== sessionId || Date.parse(current.baton.expiresAt) <= now.getTime()) {
    return appendEventUnlocked(
      state,
      machineId,
      { type: "baton.acquired", data: { sessionId, provider, model, leaseExpiresAt: leaseExpiry(now) } },
      now,
    );
  }
  return current;
}

export async function appendOrchestratorLedger(
  state: SharedState,
  sessionId: string,
  entry: Omit<OrchestratorLedgerEntry, "at">,
): Promise<void> {
  requiredString(entry.action, "orchestrator ledger action");
  await withOrchestratorLock(state, sessionId, async (machineId) => {
    const now = new Date();
    const current = replayEvents(await readEventsUnlocked(state));
    if (!current) throw new Error("orchestrator state must be initialized before appending a ledger entry");
    assertBatonAvailable(current, sessionId, now);
    if (!current.baton.active || current.baton.holder !== sessionId || Date.parse(current.baton.expiresAt) <= now.getTime()) {
      await appendEventUnlocked(
        state,
        machineId,
        {
          type: "baton.acquired",
          data: {
            sessionId,
            provider: current.heartbeat.provider,
            model: current.heartbeat.model,
            leaseExpiresAt: leaseExpiry(now),
          },
        },
        now,
      );
    }
    await appendEventUnlocked(state, machineId, { type: "ledger.appended", data: { sessionId, entry } }, new Date());
  });
}

export async function writeOrchestratorHeartbeat(
  state: SharedState,
  sessionId: string,
  heartbeat: Omit<OrchestratorHeartbeat, "lastBeatAt" | "nextCheckAt">,
): Promise<void> {
  requiredString(heartbeat.provider, "orchestrator heartbeat provider");
  requiredString(heartbeat.model, "orchestrator heartbeat model");
  await withOrchestratorLock(state, sessionId, async (machineId) => {
    const now = new Date();
    await ensureBatonUnlocked(state, machineId, sessionId, heartbeat.provider, heartbeat.model, now);
    await appendEventUnlocked(
      state,
      machineId,
      {
        type: "heartbeat.recorded",
        data: {
          sessionId,
          provider: heartbeat.provider,
          model: heartbeat.model,
          nextCheckAt: new Date(now.getTime() + HEARTBEAT_INTERVAL_MS).toISOString(),
          leaseExpiresAt: leaseExpiry(now),
        },
      },
      now,
    );
  });
}

export async function initializeOrchestratorState(
  state: SharedState,
  sessionId: string,
  provider: string,
  model: string,
): Promise<void> {
  requiredString(provider, "orchestrator provider");
  requiredString(model, "orchestrator model");
  await ensureOrchestratorState(state);
  await withOrchestratorLock(state, sessionId, async (machineId) => {
    await ensureBatonUnlocked(state, machineId, sessionId, provider, model, new Date());
  });
}

export async function releaseOrchestratorBaton(state: SharedState, sessionId: string): Promise<void> {
  await withOrchestratorLock(state, sessionId, async (machineId) => {
    const current = replayEvents(await readEventsUnlocked(state));
    if (!current) throw new Error("orchestrator state is not initialized");
    if (!current.baton.active && current.baton.holder === sessionId) return;
    if (current.baton.holder !== sessionId) {
      throw new Error(`orchestrator baton is held by ${current.baton.holder}`);
    }
    await appendEventUnlocked(state, machineId, { type: "baton.released", data: { sessionId } });
  });
}

export interface OrchestratorHeartbeatController {
  assertHealthy(): void;
  update(heartbeat: Omit<OrchestratorHeartbeat, "lastBeatAt" | "nextCheckAt">): Promise<void>;
  stop(): Promise<void>;
}

export async function startOrchestratorHeartbeat(
  state: SharedState,
  sessionId: string,
  heartbeat: Omit<OrchestratorHeartbeat, "lastBeatAt" | "nextCheckAt">,
  options: { intervalMs?: number } = {},
): Promise<OrchestratorHeartbeatController> {
  const intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error("orchestrator heartbeat interval must be positive");
  await ensureOrchestratorState(state);
  await initializeOrchestratorState(state, sessionId, heartbeat.provider, heartbeat.model);
  await writeOrchestratorHeartbeat(state, sessionId, heartbeat);

  let stopped = false;
  let failure: Error | null = null;
  let inFlight: Promise<void> | null = null;
  let currentHeartbeat = { ...heartbeat };
  const renew = (): void => {
    if (stopped || failure || inFlight) return;
    inFlight = writeOrchestratorHeartbeat(state, sessionId, currentHeartbeat)
      .catch((error) => {
        failure = error instanceof Error ? error : new Error(String(error));
      })
      .finally(() => {
        inFlight = null;
      });
  };
  const timer = setInterval(renew, intervalMs);
  timer.unref?.();

  return {
    assertHealthy: () => {
      if (failure) throw failure;
    },
    update: async (nextHeartbeat) => {
      requiredString(nextHeartbeat.provider, "orchestrator heartbeat provider");
      requiredString(nextHeartbeat.model, "orchestrator heartbeat model");
      if (stopped) throw new Error("orchestrator heartbeat is stopped");
      if (inFlight) await inFlight;
      if (failure) throw failure;
      currentHeartbeat = { ...nextHeartbeat };
      inFlight = writeOrchestratorHeartbeat(state, sessionId, currentHeartbeat)
        .catch((error) => {
          failure = error instanceof Error ? error : new Error(String(error));
        })
        .finally(() => {
          inFlight = null;
        });
      await inFlight;
      if (failure) throw failure;
    },
    stop: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      if (inFlight) await inFlight;
      if (failure) throw failure;
      await releaseOrchestratorBaton(state, sessionId);
    },
  };
}

export function defaultOrchestratorState(
  _state: SharedState,
  provider: string,
  model: string,
  sessionId: string,
): OrchestratorStateDoc {
  const now = new Date();
  return {
    baton: {
      active: true,
      holder: sessionId,
      since: now.toISOString(),
      expiresAt: leaseExpiry(now),
      provider,
      model,
    },
    heartbeat: {
      lastBeatAt: now.toISOString(),
      nextCheckAt: new Date(now.getTime() + HEARTBEAT_INTERVAL_MS).toISOString(),
      provider,
      model,
    },
    ledger: [],
  };
}

export function orchestratorSystemPrompt(): string {
  return `You are the Agent OS orchestrator session.

Your job is to direct work across providers, harnesses, and delegated workers while preserving one personal-agent identity and one canonical state authority.

Core behavior contract:
- Follow the current user instruction first, then verify live runtime, repository, and remote facts before relying on projections or remembered context.
- Delegate bounded independent work when it improves speed or verification, while retaining integration and decision ownership in this session.
- Continue through safe in-scope work until the objective is complete or a concrete user decision is required.
- Validate behavior at the real boundary and report failures or residual risk plainly; never manufacture a green result.
- Keep provider and model changes inside the managed session so ordered canonical context and usage are preserved.
- The Agent OS runtime owns immutable orchestrator events, the expiring baton lease, heartbeat, ledger, and generated projections. Never edit STATE.md or state.json directly.
- Treat provider-native histories and generated projections as evidence, never as a competing state or memory authority.

Use the managed switch_provider, switch_model, list_providers, and set_status tools to manage the session. Orchestrator state is persisted by Agent OS APIs under .agents/orchestrator/events/.`.trim();
}
