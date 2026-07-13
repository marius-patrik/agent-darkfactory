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
} from "../../harness/session";
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
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const CANONICAL_HASH_OR_ID = /^(?:[a-f0-9]{32}|[a-f0-9]{64})$/;
const COMPACTION_CAPSULE_ID = /^\d{8}-\d{6}-[a-f0-9]{32}$/;
const CANONICAL_REPO_SLUG = /^\/?[a-z0-9](?:[a-z0-9.-]{0,38}[a-z0-9])?\/[a-z0-9][a-z0-9._-]{0,99}$/;

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
  entryHashes?: Array<{ path: string; sha256: string; bytes: number }>;
  envelope?: BundleEnvelope;
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

export interface EventBundleInspection {
  payloadHash: string;
  entries: number;
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
  const configPath = syncConfigPath(state);
  await assertPhysicalPathUnderRoot(state.stateDir, configPath, { leaf: "file" });
  const parsed = JSON.parse(await readFile(configPath, "utf8")) as Partial<SyncConfig>;
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

async function assertPhysicalPathUnderRoot(
  root: string,
  target: string,
  options: { allowMissing?: boolean; leaf?: "directory" | "file" | "any" } = {},
): Promise<boolean> {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`event exchange path escapes canonical state: ${resolvedTarget}`);
  }
  const segments = relative === "" ? [] : relative.split(path.sep);
  let current = resolvedRoot;
  for (let index = -1; index < segments.length; index += 1) {
    if (index >= 0) current = path.join(current, segments[index]);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && options.allowMissing) return false;
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error(`event exchange path contains a symbolic link: ${current}`);
    const isLeaf = index === segments.length - 1;
    if (!isLeaf && !info.isDirectory()) {
      throw new Error(`event exchange path ancestor is not a physical directory: ${current}`);
    }
    if (isLeaf && options.leaf === "directory" && !info.isDirectory()) {
      throw new Error(`event exchange path is not a physical directory: ${current}`);
    }
    if (isLeaf && options.leaf === "file" && !info.isFile()) {
      throw new Error(`event exchange path is not a physical file: ${current}`);
    }
  }
  return true;
}

async function ensurePhysicalDirectoryChain(root: string, directory: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const resolvedDirectory = path.resolve(directory);
  const relative = path.relative(resolvedRoot, resolvedDirectory);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`event exchange path escapes canonical state: ${resolvedDirectory}`);
  }
  await assertPhysicalPathUnderRoot(resolvedRoot, resolvedRoot, { leaf: "directory" });
  let current = resolvedRoot;
  for (const segment of relative === "" ? [] : relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await assertPhysicalPathUnderRoot(resolvedRoot, current, { leaf: "directory" });
  }
}

const STRUCTURAL_STRING_FIELDS = new Set([
  "id",
  "recordId",
  "agentId",
  "machineId",
  "sessionId",
  "turnId",
  "supersedes",
  "eventHash",
  "previousEventHash",
  "contentHash",
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
  // Evidence fields can embed local file URIs; explicit secret signatures above
  // still scan the full value, while URI path material is excluded only from the
  // generic high-entropy fallback.
  const entropyInput = value
    .replace(/\bfile:\/\/[^\s)]+/gi, "")
    // Canonical GitHub repository URLs and an adjacent, explicitly labelled
    // repository lineage are identifiers, not bearer material. The lineage
    // exemption intentionally accepts one to three identifier segments with at
    // least two dots or hyphens. Routes, queries, and unlabelled slash-delimited
    // strings still reach the generic entropy guard below.
    .replace(
      /\bhttps?:\/\/github\.com\/[a-z0-9](?:[a-z0-9.-]{0,38}[a-z0-9])?\/[a-z0-9][a-z0-9._-]{0,99}(?=[\s),;]|$)/gi,
      "",
    )
    .replace(
      /\(renamed from (?=[a-z0-9._/-]*(?:[-.][a-z0-9._/-]*){2})[a-z0-9][a-z0-9._-]{0,99}(?:\/[a-z0-9][a-z0-9._-]{0,99}){1,2}\)/gi,
      "",
    )
    // Remove only a credential-free HTTP(S) origin. Repository slugs and opaque
    // path/query material remain in the entropy scan.
    .replace(/\bhttps?:\/\/(?:\[[^\]]+\]|[^\s/:@]+)(?::\d+)?(?=\/)/gi, "");
  for (const candidate of entropyInput.match(/[A-Za-z0-9_+.\/-]{32,}={0,2}/g) ?? []) {
    if (UUID.test(candidate)) continue;
    if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})\.?$/.test(candidate)) continue;
    // Bare GitHub-style owner/repository slugs in prose are identifiers. Requiring
    // repository punctuation avoids exempting arbitrary lowercase slash tokens.
    if (CANONICAL_REPO_SLUG.test(candidate) && /[.-]/.test(candidate)) continue;
    if (/[A-Za-z]/.test(candidate) && (/[0-9]/.test(candidate) || /[_+\/-]/.test(candidate))) return true;
    if (/[a-z]/.test(candidate) && /[A-Z]/.test(candidate)) {
      const counts = new Map<string, number>();
      for (const character of candidate) counts.set(character, (counts.get(character) ?? 0) + 1);
      const entropy = [...counts.values()].reduce((total, count) => {
        const probability = count / candidate.length;
        return total - probability * Math.log2(probability);
      }, 0);
      if (entropy >= 4) return true;
    }
  }
  return false;
}

function hasDuplicateJsonObjectKeys(source: string): boolean {
  let offset = 0;
  let duplicate = false;
  const skipWhitespace = (): void => {
    while (/\s/.test(source[offset] ?? "")) offset += 1;
  };
  const parseString = (): string => {
    const start = offset;
    offset += 1;
    while (offset < source.length) {
      if (source[offset] === "\\") {
        offset += 2;
        continue;
      }
      if (source[offset] === '"') {
        offset += 1;
        return JSON.parse(source.slice(start, offset)) as string;
      }
      offset += 1;
    }
    throw new Error("unterminated JSON string");
  };
  const parseValue = (): void => {
    skipWhitespace();
    if (source[offset] === "{") {
      offset += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (source[offset] === "}") {
        offset += 1;
        return;
      }
      while (offset < source.length) {
        skipWhitespace();
        const key = parseString();
        if (keys.has(key)) duplicate = true;
        keys.add(key);
        skipWhitespace();
        offset += 1;
        parseValue();
        skipWhitespace();
        if (source[offset] === "}") {
          offset += 1;
          return;
        }
        offset += 1;
      }
      return;
    }
    if (source[offset] === "[") {
      offset += 1;
      skipWhitespace();
      if (source[offset] === "]") {
        offset += 1;
        return;
      }
      while (offset < source.length) {
        parseValue();
        skipWhitespace();
        if (source[offset] === "]") {
          offset += 1;
          return;
        }
        offset += 1;
      }
      return;
    }
    if (source[offset] === '"') {
      parseString();
      return;
    }
    while (offset < source.length && !/[\s,}\]]/.test(source[offset])) offset += 1;
  };
  parseValue();
  return duplicate;
}

function secretFieldPath(value: unknown, field = "", path = ""): string | null {
  if (typeof value === "string") {
    if (STRUCTURAL_STRING_FIELDS.has(field) && (UUID.test(value) || CANONICAL_HASH_OR_ID.test(value))) return null;
    if (field === "capsuleId" && COMPACTION_CAPSULE_ID.test(value)) return null;
    const trimmed = value.trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      let structured: unknown;
      try {
        structured = JSON.parse(trimmed) as unknown;
      } catch {
        return secretLikeText(value) ? path || field || "<root>" : null;
      }
      if (structured !== null && typeof structured === "object") {
        try {
          if (hasDuplicateJsonObjectKeys(trimmed)) return path || field || "<root>";
          return secretFieldPath(structured, field, path);
        } catch {
          return path || field || "<root>";
        }
      }
    }
    return secretLikeText(value) ? path || field || "<root>" : null;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = secretFieldPath(item, field, `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const nestedPath = path ? `${path}.${key}` : key;
    if (
      /(?:password|passwd|pwd|secret|token|api.?key|credential|authorization|private.?key|connection.?string|dsn)/i.test(key) &&
      typeof nested === "string" &&
      nested.length > 0
    ) {
      return nestedPath;
    }
    const found = secretFieldPath(nested, key, nestedPath);
    if (found) return found;
  }
  return null;
}

function assertSourceMetadata(source: { installId: string; machineId: string }): void {
  for (const field of ["installId", "machineId"] as const) {
    const value = source[field];
    if (!UUID.test(value)) {
      throw new Error(`event exchange source ${field} is not a canonical non-secret identifier`);
    }
  }
}

function assertNoPlantedSecret(relativePath: string, content: string): unknown {
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
  const plantedSecret = secretFieldPath(parsed);
  if (plantedSecret) {
    throw new Error(`event exchange payload contains a secret-like field at ${plantedSecret}: ${relativePath}`);
  }
  return parsed;
}

function assertEventPathIdentity(relativePath: string, parsed: unknown): void {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`event exchange path identity requires an event object: ${relativePath}`);
  }
  const event = parsed as { id?: unknown; machineId?: unknown; machineSequence?: unknown; sessionId?: unknown };
  const segments = relativePath.split("/");
  const fileName = segments.at(-1) ?? "";
  const match = fileName.match(/^([0-9]{16})-([A-Za-z0-9_-]+)\.json$/);
  const machineId = segments[0] === "memory" ? segments[2] : segments[0] === "sessions" ? segments[3] : segments[2];
  const sessionId = segments[0] === "sessions" ? segments[1] : undefined;
  if (
    !match ||
    event.machineId !== machineId ||
    event.machineSequence !== Number(match[1]) ||
    event.id !== match[2] ||
    (sessionId !== undefined && event.sessionId !== sessionId)
  ) {
    throw new Error(`event exchange path identity mismatch: ${relativePath}`);
  }
}

async function collectFiles(
  state: SharedState,
  relativeDirectory: string,
  entries: EventEntry[],
  scanSecrets: boolean,
): Promise<void> {
  const absoluteDirectory = path.join(state.stateDir, ...relativeDirectory.split("/"));
  try {
    await assertPhysicalPathUnderRoot(state.stateDir, absoluteDirectory, { leaf: "directory" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of (await readdir(absoluteDirectory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) throw new Error(`hidden entries cannot roam: ${path.join(absoluteDirectory, entry.name)}`);
    const relativePath = `${relativeDirectory}/${entry.name}`;
    const absolutePath = path.join(absoluteDirectory, entry.name);
    const entryInfo = await lstat(absolutePath);
    await assertPhysicalPathUnderRoot(state.stateDir, absolutePath);
    if (entryInfo.isDirectory()) {
      await collectFiles(state, relativePath, entries, scanSecrets);
      continue;
    }
    if (!entryInfo.isFile()) throw new Error(`event exchange source contains an unsupported entry: ${absolutePath}`);
    assertAllowedPath(relativePath);
    if (entryInfo.size > MAX_FILE_BYTES) throw new Error(`event exchange event is too large: ${relativePath}`);
    const content = await readFile(absolutePath, "utf8");
    let parsed: unknown;
    if (scanSecrets) parsed = assertNoPlantedSecret(relativePath, content);
    else {
      try {
        parsed = JSON.parse(content);
      } catch (error) {
        throw new Error(`local event history is not valid JSON at ${relativePath}: ${String(error)}`);
      }
    }
    assertEventPathIdentity(relativePath, parsed);
    entries.push({ path: relativePath, sha256: sha256(content), content: Buffer.from(content).toString("base64") });
    if (entries.length > MAX_FILES) throw new Error(`event exchange exceeds ${MAX_FILES} files`);
  }
}

async function collectEventEntries(state: SharedState, scanSecrets = true): Promise<EventEntry[]> {
  const entries: EventEntry[] = [];
  await collectFiles(state, "memory/events", entries, scanSecrets);
  const sessionsRoot = path.join(state.stateDir, "sessions");
  try {
    await assertPhysicalPathUnderRoot(state.stateDir, sessionsRoot, { leaf: "directory" });
    for (const entry of (await readdir(sessionsRoot, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) throw new Error(`hidden canonical session entries cannot roam: ${entry.name}`);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`invalid canonical session entry: ${entry.name}`);
      await collectFiles(state, `sessions/${entry.name}/events`, entries, scanSecrets);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await collectFiles(state, "orchestrator/events", entries, scanSecrets);
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
    assertEventPathIdentity(entry.path, assertNoPlantedSecret(entry.path, content));
    decoded.set(entry.path, content);
  }
  const sorted = [...decoded.keys()].sort();
  if (entries.some((entry, index) => entry.path !== sorted[index])) throw new Error("event exchange entries are not sorted");
  return decoded;
}

async function authenticateBundleEnvelope(
  state: SharedState,
  value: unknown,
): Promise<{ envelope: BundleEnvelope; payloadHash: string; payload: BundlePayload; incoming: Map<string, string> }> {
  const envelope = value as Partial<BundleEnvelope>;
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
  const normalized = envelope as BundleEnvelope;
  const nonce = canonicalBase64(normalized.nonce, "nonce", 12);
  const authTag = canonicalBase64(normalized.authTag, "authentication tag", 16);
  const ciphertext = canonicalBase64(normalized.ciphertext, "ciphertext");
  const key = await keyMaterial(state);
  let plaintextBytes: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
    decipher.setAAD(Buffer.from(`${AAD_PREFIX}${normalized.payloadHash}`));
    decipher.setAuthTag(authTag);
    plaintextBytes = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("event exchange authentication failed");
  }
  if (plaintextBytes.byteLength > MAX_BUNDLE_BYTES) throw new Error("event exchange payload is too large");
  const plaintext = plaintextBytes.toString("utf8");
  if (sha256(plaintext) !== normalized.payloadHash) throw new Error("event exchange payload hash mismatch");
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
  assertSourceMetadata(payload.source);
  const completePayload = payload as BundlePayload;
  return {
    envelope: normalized,
    payloadHash: normalized.payloadHash,
    payload: completePayload,
    incoming: decodeEntries(completePayload.entries),
  };
}

async function readAuthenticatedEventBundle(state: SharedState, inputPath: string) {
  const resolved = path.resolve(inputPath);
  const inputInfo = await lstat(resolved);
  if (!inputInfo.isFile() || inputInfo.isSymbolicLink()) throw new Error("event exchange bundle must be a physical file");
  if (inputInfo.size > MAX_BUNDLE_BYTES * 2) throw new Error("event exchange envelope is too large");
  return authenticateBundleEnvelope(state, JSON.parse(await readFile(resolved, "utf8")));
}

export async function inspectEventBundle(state: SharedState, inputPath: string): Promise<EventBundleInspection> {
  const authenticated = await readAuthenticatedEventBundle(state, inputPath);
  return { payloadHash: authenticated.payloadHash, entries: authenticated.incoming.size };
}

async function validateMergedEvents(state: SharedState, incoming: Map<string, string>): Promise<Map<string, string>> {
  const combined = new Map((await collectEventEntries(state, false)).map((entry) => [entry.path, Buffer.from(entry.content, "base64").toString("utf8")]));
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

async function projectionHashForCapturedEntries(state: SharedState, entries: EventEntry[]): Promise<string> {
  const validationRoot = await mkdtemp(path.join(stateV2Paths(state).syncDir, "export-validate-"));
  try {
    await mkdir(path.join(validationRoot, "memory", "events"), { recursive: true });
    const captured = new Map<string, string>();
    for (const entry of entries) {
      const content = Buffer.from(entry.content, "base64").toString("utf8");
      const target = path.join(validationRoot, ...entry.path.split("/"));
      if (!(await writeTextExclusive(target, content))) throw new Error(`duplicate captured event: ${entry.path}`);
      captured.set(entry.path, content);
    }
    const shadow = sharedStateAt(state.root, validationRoot, state.userHome);
    const [memory, sessions, orchestrator] = await Promise.all([
      inspectMemoryIntegrity(shadow),
      inspectSessionIntegrity(shadow),
      inspectOrchestratorIntegrity(shadow),
    ]);
    if (!memory.eventIntegrity) throw new Error(`captured memory events are invalid: ${memory.issues.join("; ")}`);
    if (!sessions.eventIntegrity) throw new Error(`captured session events are invalid: ${sessions.issues.join("; ")}`);
    if (!orchestrator.eventIntegrity) throw new Error(`captured orchestrator events are invalid: ${orchestrator.issues.join("; ")}`);
    return await rebuildImportedProjectionsWhileLocked(shadow, captured);
  } finally {
    await rm(validationRoot, { recursive: true, force: true });
  }
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

function entryMetadata(incoming: Map<string, string>): Array<{ path: string; sha256: string; bytes: number }> {
  return [...incoming.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([relativePath, content]) => ({
      path: relativePath,
      sha256: sha256(content),
      bytes: Buffer.byteLength(content, "utf8"),
    }));
}

async function preparedJournalEntries(state: SharedState, journal: ImportJournal): Promise<Map<string, string>> {
  if (!journal.envelope) throw new Error(`prepared event import ${journal.payloadHash} has no durable authenticated envelope`);
  const authenticated = await authenticateBundleEnvelope(state, journal.envelope);
  if (authenticated.payloadHash !== journal.payloadHash) {
    throw new Error(`prepared event import ${journal.payloadHash} does not match its authenticated envelope`);
  }
  const incoming = authenticated.incoming;
  const expectedMetadata = entryMetadata(incoming);
  if (!journal.entryHashes || JSON.stringify(journal.entryHashes) !== JSON.stringify(expectedMetadata)) {
    throw new Error(`prepared event import ${journal.payloadHash} has inconsistent authenticated entry metadata`);
  }
  if (journal.paths.length !== incoming.size || journal.paths.some((item, index) => item !== [...incoming.keys()][index])) {
    throw new Error(`prepared event import ${journal.payloadHash} has inconsistent recovery paths`);
  }
  return incoming;
}

function assertSameIncoming(left: Map<string, string>, right: Map<string, string>): void {
  if (left.size !== right.size) throw new Error("prepared event import does not match the supplied authenticated bundle");
  for (const [relativePath, content] of left) {
    if (right.get(relativePath) !== content) {
      throw new Error(`prepared event import does not match the supplied authenticated bundle: ${relativePath}`);
    }
  }
}

async function publishPreparedImport(
  state: SharedState,
  payloadHash: string,
  incoming: Map<string, string>,
  journalPath: string,
  prepared: ImportJournal,
  options: {
    failAfter?: number;
    afterValidationBeforePublication?: () => Promise<void>;
    beforeProjection?: () => Promise<void>;
  } = {},
): Promise<EventSyncResult> {
  await validateMergedEvents(state, incoming);
  await options.afterValidationBeforePublication?.();
  let imported = 0;
  const created = new Map<string, string>();
  for (const [relativePath, content] of incoming) {
    const target = path.join(state.stateDir, ...relativePath.split("/"));
    await ensurePhysicalDirectoryChain(state.stateDir, path.dirname(target));
    await assertPhysicalPathUnderRoot(state.stateDir, target, { allowMissing: true, leaf: "file" });
    if (await writeTextExclusive(target, content)) {
      imported += 1;
      created.set(target, content);
    }
    else if ((await readFile(target, "utf8")) !== content) throw new Error(`immutable event collision: ${relativePath}`);
    if (options.failAfter !== undefined && imported >= options.failAfter) {
      throw new Error("simulated interrupted event import");
    }
  }
  await options.beforeProjection?.();
  try {
    await validateMergedEvents(state, new Map());
  } catch (error) {
    for (const [target, content] of [...created.entries()].reverse()) {
      try {
        if ((await readFile(target, "utf8")) === content) await rm(target, { force: true });
      } catch (rollbackError) {
        if ((rollbackError as NodeJS.ErrnoException).code !== "ENOENT") throw rollbackError;
      }
    }
    throw error;
  }
  const finalProjectionHash = await rebuildImportedProjectionsWhileLocked(state, incoming);
  const committed: ImportJournal = {
    ...prepared,
    state: "committed",
    imported,
    skipped: incoming.size - imported,
    projectionHash: finalProjectionHash,
  };
  await assertPhysicalPathUnderRoot(state.stateDir, journalPath, { leaf: "file" });
  await writeTextAtomic(journalPath, `${JSON.stringify(committed, null, 2)}\n`);
  return {
    payloadHash,
    entries: incoming.size,
    imported,
    skipped: incoming.size - imported,
    projectionHash: finalProjectionHash,
    idempotent: false,
  };
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
  await ensurePhysicalDirectoryChain(state.stateDir, importsDirectory(state));
  await assertPhysicalPathUnderRoot(state.stateDir, syncConfigPath(state), { allowMissing: true, leaf: "file" });
  await writeTextAtomic(
    syncConfigPath(state),
    `${JSON.stringify({ schemaVersion: 2, enabled: true, transport: "encrypted-bundle" }, null, 2)}\n`,
  );
}

export async function disableEventSync(state: SharedState): Promise<void> {
  await ensurePhysicalDirectoryChain(state.stateDir, path.dirname(syncConfigPath(state)));
  await assertPhysicalPathUnderRoot(state.stateDir, syncConfigPath(state), { allowMissing: true, leaf: "file" });
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
    await assertPhysicalPathUnderRoot(state.stateDir, importsDirectory(state), { leaf: "directory" });
    for (const entry of await readdir(importsDirectory(state), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const journalPath = path.join(importsDirectory(state), entry.name);
      await assertPhysicalPathUnderRoot(state.stateDir, journalPath, { leaf: "file" });
      const journal = JSON.parse(await readFile(journalPath, "utf8")) as ImportJournal;
      if (journal.state === "committed") committedImports += 1;
      else if (journal.state === "prepared") preparedImports += 1;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { enabled: config.enabled, transport: config.transport, keyAvailable, committedImports, preparedImports };
}

export async function exportEventBundle(
  state: SharedState,
  outputPath: string,
  options: { afterCollection?: () => Promise<void> } = {},
): Promise<EventSyncResult> {
  const config = await readConfig(state);
  if (!config.enabled || config.transport !== "encrypted-bundle") throw new Error("event exchange is disabled");
  const key = await keyMaterial(state);
  const manifest = JSON.parse(await readFile(stateV2Paths(state).manifestFile, "utf8")) as { installId: string; machineId: string };
  assertSourceMetadata(manifest);
  const [memory, sessions, orchestrator] = await Promise.all([
    inspectMemoryIntegrity(state),
    inspectSessionIntegrity(state),
    inspectOrchestratorIntegrity(state),
  ]);
  if (!memory.eventIntegrity) throw new Error(`cannot export invalid memory events: ${memory.issues.join("; ")}`);
  if (!sessions.eventIntegrity) throw new Error(`cannot export invalid session events: ${sessions.issues.join("; ")}`);
  if (!orchestrator.eventIntegrity) throw new Error(`cannot export invalid orchestrator events: ${orchestrator.issues.join("; ")}`);
  const entries = await collectEventEntries(state);
  await options.afterCollection?.();
  const capturedProjectionHash = await projectionHashForCapturedEntries(state, entries);
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
  return { payloadHash, entries: entries.length, imported: 0, skipped: 0, projectionHash: capturedProjectionHash, idempotent: false };
}

export async function importEventBundle(
  state: SharedState,
  inputPath: string,
  options: {
    failAfter?: number;
    afterValidationBeforePublication?: () => Promise<void>;
    beforeProjection?: () => Promise<void>;
  } = {},
): Promise<EventSyncResult> {
  return withStateFileLock(state, "event-sync-import", async () => {
    const config = await readConfig(state);
    if (!config.enabled || config.transport !== "encrypted-bundle") throw new Error("event exchange is disabled");
    const authenticated = await readAuthenticatedEventBundle(state, inputPath);
    const { payloadHash, incoming } = authenticated;
    const journalPath = path.join(importsDirectory(state), `${payloadHash}.json`);
    await ensurePhysicalDirectoryChain(state.stateDir, importsDirectory(state));
    await assertPhysicalPathUnderRoot(state.stateDir, journalPath, { allowMissing: true, leaf: "file" });
    return withAffectedEventLocks(state, incoming, async () => {
      let journal: ImportJournal | null = null;
      try {
        await assertPhysicalPathUnderRoot(state.stateDir, journalPath, { allowMissing: true, leaf: "file" });
        journal = JSON.parse(await readFile(journalPath, "utf8")) as ImportJournal;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (journal && (journal.schemaVersion !== 1 || journal.payloadHash !== payloadHash)) {
        throw new Error(`invalid event import journal: ${payloadHash}`);
      }
      if (journal?.state === "committed") {
        let complete = true;
        for (const [relativePath, content] of incoming) {
          const target = path.join(state.stateDir, ...relativePath.split("/"));
          await assertPhysicalPathUnderRoot(state.stateDir, target, { allowMissing: true, leaf: "file" });
          try {
            if ((await readFile(target, "utf8")) !== content) {
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
            projectionHash: await projectionHash(state, incoming),
            idempotent: true,
          };
        }
      }

      if (journal?.state === "prepared") {
        const durableIncoming = await preparedJournalEntries(state, journal);
        assertSameIncoming(durableIncoming, incoming);
        return publishPreparedImport(state, payloadHash, durableIncoming, journalPath, journal, options);
      }

      await validateMergedEvents(state, incoming);
      let skipped = 0;
      for (const [relativePath, content] of incoming) {
        const target = path.join(state.stateDir, ...relativePath.split("/"));
        await assertPhysicalPathUnderRoot(state.stateDir, target, { allowMissing: true, leaf: "file" });
        try {
          const current = await readFile(target, "utf8");
          if (current !== content) throw new Error(`immutable event collision: ${relativePath}`);
          skipped += 1;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      await ensurePhysicalDirectoryChain(state.stateDir, importsDirectory(state));
      await assertPhysicalPathUnderRoot(state.stateDir, journalPath, { allowMissing: true, leaf: "file" });
      const prepared: ImportJournal = {
        schemaVersion: 1,
        payloadHash,
        state: "prepared",
        paths: [...incoming.keys()],
        entryHashes: entryMetadata(incoming),
        envelope: authenticated.envelope,
        imported: 0,
        skipped,
      };
      await writeTextAtomic(journalPath, `${JSON.stringify(prepared, null, 2)}\n`);
      return publishPreparedImport(state, payloadHash, incoming, journalPath, prepared, options);
    });
  });
}

export async function recoverPreparedEventImports(state: SharedState): Promise<EventSyncResult[]> {
  return withStateFileLock(state, "event-sync-import", async () => {
    const config = await readConfig(state);
    if (!config.enabled || config.transport !== "encrypted-bundle") throw new Error("event exchange is disabled");
    await assertPhysicalPathUnderRoot(state.stateDir, importsDirectory(state), { leaf: "directory" });
    const results: EventSyncResult[] = [];
    for (const entry of (await readdir(importsDirectory(state), { withFileTypes: true }))
      .filter((item) => item.isFile() && item.name.endsWith(".json"))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const journalPath = path.join(importsDirectory(state), entry.name);
      await assertPhysicalPathUnderRoot(state.stateDir, journalPath, { leaf: "file" });
      const journal = JSON.parse(await readFile(journalPath, "utf8")) as ImportJournal;
      const filePayloadHash = entry.name.slice(0, -".json".length);
      if (
        journal.schemaVersion !== 1 ||
        journal.payloadHash !== filePayloadHash ||
        !/^[a-f0-9]{64}$/.test(journal.payloadHash) ||
        !Array.isArray(journal.paths) ||
        (journal.state !== "prepared" && journal.state !== "committed")
      ) {
        throw new Error(`invalid event import journal: ${entry.name}`);
      }
      if (journal.state === "committed") continue;
      const incoming = await preparedJournalEntries(state, journal);
      results.push(await withAffectedEventLocks(state, incoming, () => (
        publishPreparedImport(state, journal.payloadHash, incoming, journalPath, journal)
      )));
    }
    return results;
  });
}
