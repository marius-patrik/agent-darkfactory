import path from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import type { SharedState } from "./state";
import { sharedStateAt } from "./state";
import { readSecret, secretPath, writeSecret } from "./secrets";
import { stateV2Paths, writeTextAtomic, writeTextExclusive } from "./state-v2";
import { inspectMemoryIntegrity, rebuildMemoryProjectionsWhileLocked, withMemoryEventWriteLock } from "./memory";
import {
  inspectSessionIntegrity,
  rebuildSessionProjectionsWhileLocked,
  withSessionWriteLock,
} from "../harness/session";
import {
  inspectOrchestratorIntegrity,
  rebuildOrchestratorProjectionWhileLocked,
  withOrchestratorEventWriteLock,
} from "./orchestrator";
import { withStateFileLock } from "./state-lock";

const SYNC_SECRET = "AGENTS_SYNC_KEY";
const AAD_PREFIX = "andromeda-agent-os-event-exchange-v1:";
const SAFE_ID = "[A-Za-z0-9][A-Za-z0-9._-]{0,127}";
const EVENT_FILE = "[0-9]{16}-[A-Za-z0-9_-]+\\.json";
const ALLOWED_EVENT_PATHS = [
  new RegExp(`^memory/events/${SAFE_ID}/${EVENT_FILE}$`),
  new RegExp(`^sessions/${SAFE_ID}/events/${SAFE_ID}/${EVENT_FILE}$`),
  new RegExp(`^orchestrator/events/${SAFE_ID}/${EVENT_FILE}$`),
];
const MAX_FILES = 100_000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;

interface SyncConfig {
  schemaVersion: 2;
  enabled: boolean;
  transport: "encrypted-bundle" | null;
}

interface EventEntry {
  path: string;
  sha256: string;
  content: string;
}

interface BundlePayload {
  schemaVersion: 1;
  source: { installId: string; machineId: string };
  entries: EventEntry[];
}

interface BundleEnvelope {
  schemaVersion: 1;
  algorithm: "aes-256-gcm";
  payloadHash: string;
  nonce: string;
  authTag: string;
  ciphertext: string;
}

interface ImportJournal {
  schemaVersion: 1;
  payloadHash: string;
  state: "prepared" | "committed";
  paths: string[];
  imported: number;
  skipped: number;
  projectionHash?: string;
}

export interface EventSyncStatus {
  enabled: boolean;
  transport: string | null;
  keyAvailable: boolean;
  committedImports: number;
  preparedImports: number;
}

export interface EventSyncResult {
  payloadHash: string;
  entries: number;
  imported: number;
  skipped: number;
  projectionHash: string;
  idempotent: boolean;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalBase64(value: string, field: string, expectedBytes?: number): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`event exchange ${field} is not canonical base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new Error(`event exchange ${field} is not canonical base64`);
  if (expectedBytes !== undefined && decoded.byteLength !== expectedBytes) {
    throw new Error(`event exchange ${field} must be exactly ${expectedBytes} bytes`);
  }
  return decoded;
}

function syncConfigPath(state: SharedState): string {
  return path.join(stateV2Paths(state).syncDir, "config.json");
}

function importsDirectory(state: SharedState): string {
  return path.join(stateV2Paths(state).syncDir, "imports");
}

async function readConfig(state: SharedState): Promise<SyncConfig> {
  const parsed = JSON.parse(await readFile(syncConfigPath(state), "utf8")) as Partial<SyncConfig>;
  if (
    parsed.schemaVersion !== 2 ||
    typeof parsed.enabled !== "boolean" ||
    (parsed.transport !== null && parsed.transport !== "encrypted-bundle")
  ) {
    throw new Error("invalid event exchange configuration");
  }
  return parsed as SyncConfig;
}

async function keyMaterial(state: SharedState): Promise<Buffer> {
  let value: string;
  try {
    value = await readSecret(state, SYNC_SECRET);
  } catch {
    throw new Error(`event exchange requires a local ${SYNC_SECRET} secret`);
  }
  const normalized = value.trim();
  if (!/^[a-fA-F0-9]{64}$/.test(normalized)) {
    throw new Error(`${SYNC_SECRET} must contain exactly 32 bytes encoded as 64 hexadecimal characters`);
  }
  return Buffer.from(normalized, "hex");
}

function assertAllowedPath(relativePath: string): void {
  if (
    relativePath.includes("\\") ||
    path.posix.isAbsolute(relativePath) ||
    relativePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
    !ALLOWED_EVENT_PATHS.some((pattern) => pattern.test(relativePath))
  ) {
    throw new Error(`event exchange payload contains a forbidden path: ${relativePath}`);
  }
}

const STRUCTURAL_STRING_FIELDS = new Set([
  "id",
  "agentId",
  "machineId",
  "sessionId",
  "turnId",
  "eventHash",
  "previousEventHash",
  "contentHash",
  "uri",
  "at",
  "createdAt",
  "updatedAt",
  "observedAt",
  "validFrom",
  "expiresAt",
  "leaseExpiresAt",
  "lastBeatAt",
  "nextCheckAt",
]);

function secretLikeText(value: string): boolean {
  if (
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(value) ||
    /\bAKIA[A-Z0-9]{16}\b/.test(value) ||
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/.test(value) ||
    /\b(?:sk-(?:ant-|proj-)?|xox[baprs]-|hf_|npm_|pypi-)[A-Za-z0-9_\-]{16,}\b/.test(value) ||
    /\bAIza[A-Za-z0-9_-]{30,}\b/.test(value) ||
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(value) ||
    /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}={0,2}\b/i.test(value) ||
    /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|https?):\/\/[^\s/:@]+:[^\s/@]+@/i.test(value) ||
    /\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|authorization|connection[_-]?string|dsn)\s*[:=]\s*["']?[^\s"']{8,}/i.test(value)
  ) {
    return true;
  }
  for (const candidate of value.match(/[A-Za-z0-9_+\/-]{32,}={0,2}/g) ?? []) {
    if (/^[a-f0-9]{64}$/.test(candidate)) continue;
    if (/[A-Za-z]/.test(candidate) && (/[0-9]/.test(candidate) || /[_+\/-]/.test(candidate))) return true;
  }
  return false;
}

function containsSecretField(value: unknown, field = ""): boolean {
  if (typeof value === "string") {
    if (STRUCTURAL_STRING_FIELDS.has(field)) return false;
    return secretLikeText(value);
  }
  if (Array.isArray(value)) return value.some((item) => containsSecretField(item, field));
  if (!value || typeof value !== "object") return false;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (
      /(?:password|passwd|pwd|secret|token|api.?key|credential|authorization|private.?key|connection.?string|dsn)/i.test(key) &&
      typeof nested === "string" &&
      nested.length > 0
    ) {
      return true;
    }
    if (containsSecretField(nested, key)) return true;
  }
  return false;
}

function assertNoPlantedSecret(relativePath: string, content: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`event exchange payload is not valid JSON at ${relativePath}: ${String(error)}`);
  }
  const record = (parsed as { data?: { record?: { sensitivity?: unknown } } }).data?.record;
  if (record?.sensitivity === "secret") {
    throw new Error(`secret memory events are local-only and cannot roam: ${relativePath}`);
  }
  if (containsSecretField(parsed)) {
    throw new Error(`event exchange payload contains a secret-like field: ${relativePath}`);
  }
}

async function collectFiles(
  state: SharedState,
  relativeDirectory: string,
  entries: EventEntry[],
): Promise<void> {
  const absoluteDirectory = path.join(state.stateDir, ...relativeDirectory.split("/"));
  let info;
  try {
    info = await lstat(absoluteDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`event exchange source must be a physical directory: ${absoluteDirectory}`);
  }
  for (const entry of (await readdir(absoluteDirectory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) throw new Error(`hidden entries cannot roam: ${path.join(absoluteDirectory, entry.name)}`);
    const relativePath = `${relativeDirectory}/${entry.name}`;
    const absolutePath = path.join(absoluteDirectory, entry.name);
    const entryInfo = await lstat(absolutePath);
    if (entryInfo.isSymbolicLink()) throw new Error(`event exchange source contains a symbolic link: ${absolutePath}`);
    if (entryInfo.isDirectory()) {
      await collectFiles(state, relativePath, entries);
      continue;
    }
    if (!entryInfo.isFile()) throw new Error(`event exchange source contains an unsupported entry: ${absolutePath}`);
    assertAllowedPath(relativePath);
    if (entryInfo.size > MAX_FILE_BYTES) throw new Error(`event exchange event is too large: ${relativePath}`);
    const content = await readFile(absolutePath, "utf8");
    assertNoPlantedSecret(relativePath, content);
    entries.push({ path: relativePath, sha256: sha256(content), content: Buffer.from(content).toString("base64") });
    if (entries.length > MAX_FILES) throw new Error(`event exchange exceeds ${MAX_FILES} files`);
  }
}

async function collectEventEntries(state: SharedState): Promise<EventEntry[]> {
  const entries: EventEntry[] = [];
  await collectFiles(state, "memory/events", entries);
  const sessionsRoot = path.join(state.stateDir, "sessions");
  try {
    const rootInfo = await lstat(sessionsRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("canonical sessions root is not physical");
    for (const entry of (await readdir(sessionsRoot, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) throw new Error(`hidden canonical session entries cannot roam: ${entry.name}`);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`invalid canonical session entry: ${entry.name}`);
      await collectFiles(state, `sessions/${entry.name}/events`, entries);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await collectFiles(state, "orchestrator/events", entries);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function decodeEntries(entries: EventEntry[]): Map<string, string> {
  if (!Array.isArray(entries) || entries.length > MAX_FILES) throw new Error("invalid event exchange entry list");
  const decoded = new Map<string, string>();
  for (const entry of entries) {
    if (!entry || typeof entry.path !== "string" || typeof entry.sha256 !== "string" || typeof entry.content !== "string") {
      throw new Error("invalid event exchange entry");
    }
    assertAllowedPath(entry.path);
    if (decoded.has(entry.path)) throw new Error(`duplicate event exchange path: ${entry.path}`);
    const bytes = Buffer.from(entry.content, "base64");
    if (bytes.byteLength > MAX_FILE_BYTES) throw new Error(`event exchange event is too large: ${entry.path}`);
    const content = bytes.toString("utf8");
    if (Buffer.from(content, "utf8").toString("base64") !== entry.content) {
      throw new Error(`event exchange entry is not canonical UTF-8 base64: ${entry.path}`);
    }
    if (sha256(content) !== entry.sha256) throw new Error(`event exchange entry hash mismatch: ${entry.path}`);
    assertNoPlantedSecret(entry.path, content);
    decoded.set(entry.path, content);
  }
  const sorted = [...decoded.keys()].sort();
  if (entries.some((entry, index) => entry.path !== sorted[index])) throw new Error("event exchange entries are not sorted");
  return decoded;
}

async function validateMergedEvents(state: SharedState, incoming: Map<string, string>): Promise<Map<string, string>> {
  const combined = new Map((await collectEventEntries(state)).map((entry) => [entry.path, Buffer.from(entry.content, "base64").toString("utf8")]));
  for (const [relativePath, content] of incoming) {
    const existing = combined.get(relativePath);
    if (existing !== undefined && existing !== content) throw new Error(`immutable event collision: ${relativePath}`);
    combined.set(relativePath, content);
  }

  const validationRoot = await mkdtemp(path.join(stateV2Paths(state).syncDir, "validate-"));
  try {
    await mkdir(path.join(validationRoot, "memory", "events"), { recursive: true });
    for (const [relativePath, content] of combined) {
      const target = path.join(validationRoot, ...relativePath.split("/"));
      if (!(await writeTextExclusive(target, content))) throw new Error(`duplicate validation event: ${relativePath}`);
    }
    const shadow = sharedStateAt(state.root, validationRoot, state.userHome);
    const [memory, sessions, orchestrator] = await Promise.all([
      inspectMemoryIntegrity(shadow),
      inspectSessionIntegrity(shadow),
      inspectOrchestratorIntegrity(shadow),
    ]);
    if (!memory.eventIntegrity) throw new Error(`merged memory events are invalid: ${memory.issues.join("; ")}`);
    if (!sessions.eventIntegrity) throw new Error(`merged session events are invalid: ${sessions.issues.join("; ")}`);
    if (!orchestrator.eventIntegrity) throw new Error(`merged orchestrator events are invalid: ${orchestrator.issues.join("; ")}`);
  } finally {
    await rm(validationRoot, { recursive: true, force: true });
  }
  return combined;
}

async function projectionHash(state: SharedState, incoming: Map<string, string>): Promise<string> {
  const hashes: string[] = [];
  const includeMemory = [...incoming.keys()].some((item) => item.startsWith("memory/"));
  const includeOrchestrator = [...incoming.keys()].some((item) => item.startsWith("orchestrator/"));
  const sessionIds = new Set(
    [...incoming.keys()].filter((item) => item.startsWith("sessions/")).map((item) => item.split("/")[1]),
  );
  const visit = async (relativeDirectory: string, accept: (name: string) => boolean): Promise<void> => {
    const directory = path.join(state.stateDir, ...relativeDirectory.split("/"));
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relativePath = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) await visit(relativePath, accept);
      else if (entry.isFile() && accept(entry.name)) hashes.push(`${relativePath}:${sha256(await readFile(path.join(directory, entry.name)))}`);
    }
  };
  if (includeMemory) {
    await visit("memory/records", (name) => name.endsWith(".json"));
    await visit("memory/views", (name) => name.endsWith(".md"));
  }
  for (const sessionId of [...sessionIds].sort()) {
    await visit(`sessions/${sessionId}`, (name) => name === "state.json" || name === "transcript.json");
  }
  if (includeOrchestrator) await visit("orchestrator", (name) => name === "state.json" || name === "STATE.md");
  return sha256(hashes.sort().join("\n"));
}

async function rebuildImportedProjectionsWhileLocked(state: SharedState, incoming: Map<string, string>): Promise<string> {
  if ([...incoming.keys()].some((item) => item.startsWith("memory/"))) await rebuildMemoryProjectionsWhileLocked(state);
  const sessionIds = new Set(
    [...incoming.keys()].filter((item) => item.startsWith("sessions/")).map((item) => item.split("/")[1]),
  );
  for (const sessionId of [...sessionIds].sort()) await rebuildSessionProjectionsWhileLocked(state, sessionId);
  if ([...incoming.keys()].some((item) => item.startsWith("orchestrator/"))) {
    await rebuildOrchestratorProjectionWhileLocked(state);
  }
  return projectionHash(state, incoming);
}

async function withAffectedEventLocks<T>(
  state: SharedState,
  incoming: Map<string, string>,
  callback: () => Promise<T>,
): Promise<T> {
  const lockOrchestrator = [...incoming.keys()].some((item) => item.startsWith("orchestrator/"));
  const lockMemory = [...incoming.keys()].some((item) => item.startsWith("memory/"));
  const sessionIds = [...new Set(
    [...incoming.keys()].filter((item) => item.startsWith("sessions/")).map((item) => item.split("/")[1]),
  )].sort();
  const afterSessions = (): Promise<T> => {
    const afterMemory = () => lockOrchestrator ? withOrchestratorEventWriteLock(state, callback) : callback();
    return lockMemory ? withMemoryEventWriteLock(state, "event-sync-import", afterMemory) : afterMemory();
  };
  const lockSessions = async (index: number): Promise<T> => {
    const sessionId = sessionIds[index];
    if (!sessionId) return afterSessions();
    return withSessionWriteLock(state, sessionId, () => lockSessions(index + 1));
  };
  return lockSessions(0);
}

export async function enableEventSync(state: SharedState, generateKey = false): Promise<void> {
  if (generateKey) {
    try {
      await lstat(secretPath(state, SYNC_SECRET));
      throw new Error(`${SYNC_SECRET} already exists; refusing implicit key rotation`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await writeSecret(state, SYNC_SECRET, randomBytes(32).toString("hex"));
  }
  await keyMaterial(state);
  await writeTextAtomic(
    syncConfigPath(state),
    `${JSON.stringify({ schemaVersion: 2, enabled: true, transport: "encrypted-bundle" }, null, 2)}\n`,
  );
  await mkdir(importsDirectory(state), { recursive: true });
}

export async function disableEventSync(state: SharedState): Promise<void> {
  await writeTextAtomic(syncConfigPath(state), `${JSON.stringify({ schemaVersion: 2, enabled: false, transport: null }, null, 2)}\n`);
}

export async function eventSyncStatus(state: SharedState): Promise<EventSyncStatus> {
  const config = await readConfig(state);
  let keyAvailable = true;
  try {
    await keyMaterial(state);
  } catch {
    keyAvailable = false;
  }
  let committedImports = 0;
  let preparedImports = 0;
  try {
    for (const entry of await readdir(importsDirectory(state), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const journal = JSON.parse(await readFile(path.join(importsDirectory(state), entry.name), "utf8")) as ImportJournal;
      if (journal.state === "committed") committedImports += 1;
      else if (journal.state === "prepared") preparedImports += 1;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { enabled: config.enabled, transport: config.transport, keyAvailable, committedImports, preparedImports };
}

export async function exportEventBundle(state: SharedState, outputPath: string): Promise<EventSyncResult> {
  const config = await readConfig(state);
  if (!config.enabled || config.transport !== "encrypted-bundle") throw new Error("event exchange is disabled");
  const key = await keyMaterial(state);
  const manifest = JSON.parse(await readFile(stateV2Paths(state).manifestFile, "utf8")) as { installId: string; machineId: string };
  const [memory, sessions, orchestrator] = await Promise.all([
    inspectMemoryIntegrity(state),
    inspectSessionIntegrity(state),
    inspectOrchestratorIntegrity(state),
  ]);
  if (!memory.eventIntegrity) throw new Error(`cannot export invalid memory events: ${memory.issues.join("; ")}`);
  if (!sessions.eventIntegrity) throw new Error(`cannot export invalid session events: ${sessions.issues.join("; ")}`);
  if (!orchestrator.eventIntegrity) throw new Error(`cannot export invalid orchestrator events: ${orchestrator.issues.join("; ")}`);
  const entries = await collectEventEntries(state);
  const payload: BundlePayload = { schemaVersion: 1, source: manifest, entries };
  const plaintext = JSON.stringify(payload);
  if (Buffer.byteLength(plaintext) > MAX_BUNDLE_BYTES) throw new Error("event exchange bundle is too large");
  const payloadHash = sha256(plaintext);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(`${AAD_PREFIX}${payloadHash}`));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const envelope: BundleEnvelope = {
    schemaVersion: 1,
    algorithm: "aes-256-gcm",
    payloadHash,
    nonce: nonce.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  await writeTextAtomic(path.resolve(outputPath), `${JSON.stringify(envelope, null, 2)}\n`);
  const entryMap = new Map(entries.map((entry) => [entry.path, ""]));
  return { payloadHash, entries: entries.length, imported: 0, skipped: 0, projectionHash: await projectionHash(state, entryMap), idempotent: false };
}

export async function importEventBundle(
  state: SharedState,
  inputPath: string,
  options: { failAfter?: number; beforeProjection?: () => Promise<void> } = {},
): Promise<EventSyncResult> {
  return withStateFileLock(state, "event-sync-import", async () => {
    const config = await readConfig(state);
    if (!config.enabled || config.transport !== "encrypted-bundle") throw new Error("event exchange is disabled");
    const inputInfo = await lstat(path.resolve(inputPath));
    if (!inputInfo.isFile() || inputInfo.isSymbolicLink()) throw new Error("event exchange bundle must be a physical file");
    if (inputInfo.size > MAX_BUNDLE_BYTES * 2) throw new Error("event exchange envelope is too large");
    const envelope = JSON.parse(await readFile(path.resolve(inputPath), "utf8")) as Partial<BundleEnvelope>;
    if (
      envelope.schemaVersion !== 1 ||
      envelope.algorithm !== "aes-256-gcm" ||
      typeof envelope.payloadHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(envelope.payloadHash) ||
      typeof envelope.nonce !== "string" ||
      typeof envelope.authTag !== "string" ||
      typeof envelope.ciphertext !== "string"
    ) {
      throw new Error("invalid event exchange envelope");
    }
    const payloadHash = envelope.payloadHash;
    const nonce = canonicalBase64(envelope.nonce, "nonce", 12);
    const authTag = canonicalBase64(envelope.authTag, "authentication tag", 16);
    const ciphertext = canonicalBase64(envelope.ciphertext, "ciphertext");
    const key = await keyMaterial(state);
    let plaintextBytes: Buffer;
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
      decipher.setAAD(Buffer.from(`${AAD_PREFIX}${payloadHash}`));
      decipher.setAuthTag(authTag);
      plaintextBytes = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
    } catch {
      throw new Error("event exchange authentication failed");
    }
    if (plaintextBytes.byteLength > MAX_BUNDLE_BYTES) throw new Error("event exchange payload is too large");
    const plaintext = plaintextBytes.toString("utf8");
    if (sha256(plaintext) !== payloadHash) throw new Error("event exchange payload hash mismatch");
    const payload = JSON.parse(plaintext) as Partial<BundlePayload>;
    if (
      payload.schemaVersion !== 1 ||
      !payload.source ||
      typeof payload.source.installId !== "string" ||
      typeof payload.source.machineId !== "string" ||
      !Array.isArray(payload.entries)
    ) {
      throw new Error("invalid event exchange payload");
    }
    const incoming = decodeEntries(payload.entries);
    const journalPath = path.join(importsDirectory(state), `${payloadHash}.json`);
    return withAffectedEventLocks(state, incoming, async () => {
      let journal: ImportJournal | null = null;
      try {
        journal = JSON.parse(await readFile(journalPath, "utf8")) as ImportJournal;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (journal?.state === "committed") {
        let complete = true;
        for (const [relativePath, content] of incoming) {
          try {
            if ((await readFile(path.join(state.stateDir, ...relativePath.split("/")), "utf8")) !== content) {
              throw new Error(`immutable event collision: ${relativePath}`);
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") complete = false;
            else throw error;
          }
        }
        if (complete) {
          await validateMergedEvents(state, incoming);
          return {
            payloadHash,
            entries: incoming.size,
            imported: 0,
            skipped: incoming.size,
            projectionHash: journal.projectionHash ?? await projectionHash(state, incoming),
            idempotent: true,
          };
        }
      }

      await validateMergedEvents(state, incoming);
      let imported = 0;
      let skipped = 0;
      for (const [relativePath, content] of incoming) {
        try {
          const current = await readFile(path.join(state.stateDir, ...relativePath.split("/")), "utf8");
          if (current !== content) throw new Error(`immutable event collision: ${relativePath}`);
          skipped += 1;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      await mkdir(importsDirectory(state), { recursive: true });
      const prepared: ImportJournal = {
        schemaVersion: 1,
        payloadHash,
        state: "prepared",
        paths: [...incoming.keys()],
        imported: 0,
        skipped,
      };
      await writeTextAtomic(journalPath, `${JSON.stringify(prepared, null, 2)}\n`);

      for (const [relativePath, content] of incoming) {
        const target = path.join(state.stateDir, ...relativePath.split("/"));
        if (await writeTextExclusive(target, content)) imported += 1;
        else if ((await readFile(target, "utf8")) !== content) throw new Error(`immutable event collision: ${relativePath}`);
        if (options.failAfter !== undefined && imported >= options.failAfter) {
          throw new Error("simulated interrupted event import");
        }
      }
      await options.beforeProjection?.();
      const finalProjectionHash = await rebuildImportedProjectionsWhileLocked(state, incoming);
      const committed: ImportJournal = {
        ...prepared,
        state: "committed",
        imported,
        skipped: incoming.size - imported,
        projectionHash: finalProjectionHash,
      };
      await writeTextAtomic(journalPath, `${JSON.stringify(committed, null, 2)}\n`);
      return {
        payloadHash,
        entries: incoming.size,
        imported,
        skipped: incoming.size - imported,
        projectionHash: finalProjectionHash,
        idempotent: false,
      };
    });
  });
}
