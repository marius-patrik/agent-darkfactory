import { createHash } from "node:crypto";
import path from "node:path";
import type { BigIntStats } from "node:fs";
import { lstat, open, readFile, readdir } from "node:fs/promises";
import {
  appendImportedSessionMessages,
  createSession,
  loadSessionState,
  sessionPaths,
  type ImportedSessionMessage,
  type MessageRole,
  type SessionDescriptor,
  type TranscriptMessage,
} from "../sdk/harness/session";
import type { SharedState } from "./state";
import { withStateFileLock } from "./state-lock";
import { writeTextAtomic } from "./state-v2";

export type DesktopSessionProvider = "claude" | "codex";

export interface SessionCaptureLimits {
  maximumFiles: number;
  maximumScannedEntries: number;
  maximumDepth: number;
  maximumFileBytes: number;
  maximumTotalBytes: number;
  maximumLinesPerFile: number;
  maximumLineBytes: number;
  maximumMessagesPerFile: number;
}

export interface SessionCaptureError {
  provider: DesktopSessionProvider;
  sourcePath: string | null;
  code: string;
  message: string;
  retryable: boolean;
}

export interface SessionCaptureReport {
  schemaVersion: 1;
  scannedFiles: number;
  reconciledFiles: number;
  importedSessions: number;
  existingSessions: number;
  importedMessages: number;
  existingMessages: number;
  skippedFiles: number;
  deferredFiles: number;
  failedFiles: number;
  errors: SessionCaptureError[];
}

export interface ReconcileDesktopSessionsOptions {
  providers?: DesktopSessionProvider[];
  claudeRoot?: string;
  codexRoot?: string;
  limits?: Partial<SessionCaptureLimits>;
  now?: () => Date;
}

interface EvidenceFile {
  provider: DesktopSessionProvider;
  absolutePath: string;
  relativePath: string;
  sourcePath: string;
  ancestors: PhysicalDirectoryAdmission[];
  identity: PhysicalFileIdentity;
}

interface PhysicalDirectoryAdmission {
  absolutePath: string;
  device: bigint;
  inode: bigint;
}

interface PhysicalFileIdentity {
  device: bigint;
  inode: bigint;
  size: bigint;
  modifiedAtNs: bigint;
}

interface AdmittedJsonl {
  records: ParsedJsonLine[];
  checkpoint: CaptureCheckpointEntry;
  pageStart: number;
  advancedBytes: number;
  hasRemainingBytes: boolean;
}

interface ParsedJsonLine {
  line: number;
  digest: string;
  value: Record<string, unknown>;
}

interface ParsedJsonPage {
  records: ParsedJsonLine[];
  lineCount: number;
}

interface NormalizedSourceMessage {
  sourceLine: number;
  sourceRecordId: string;
  sourceTimestamp: string;
  message: TranscriptMessage;
}

interface NormalizedDesktopSession {
  provider: DesktopSessionProvider;
  nativeSessionId: string;
  sourceFormat: string;
  sourcePath: string;
  createdAt: string;
  model: string;
  metadata: Record<string, unknown>;
  messages: NormalizedSourceMessage[];
  codexProgress?: CodexCaptureProgress;
}

interface LegacyCaptureCursorEntry {
  checkpointVersion?: undefined;
  provider: DesktopSessionProvider;
  relativePath: string;
  admittedBytes: number;
  contentHash: string;
  classification: "captured" | "empty";
  nativeSessionId: string | null;
  canonicalSessionId: string | null;
  updatedAt: string;
}

interface CapturePageReceipt {
  offset: number;
  length: number;
  contentHash: string;
  prefixChainDigest: string;
}

interface CaptureByteGuard {
  offset: number;
  length: number;
  contentHash: string;
}

interface CaptureSessionSeed {
  provider: DesktopSessionProvider;
  nativeSessionId: string;
  sourceFormat: string;
  sourcePath: string;
  createdAt: string;
  model: string;
  metadata: Record<string, unknown>;
  codexProgress?: CodexCaptureProgress;
}

interface CodexCaptureProgress {
  lineageSessionIds: string[];
  ownerParentSessionId: string | null;
  expectedParentSessionId: string | null;
  lineageClosed: boolean;
  lineageTruncated: boolean;
  ownerMessagesStarted: boolean;
}

interface CaptureCheckpointEntry {
  checkpointVersion: 1;
  provider: DesktopSessionProvider;
  relativePath: string;
  fileDevice: string;
  fileInode: string;
  observedSize: number;
  observedModifiedAtNs: string;
  admittedBytes: number;
  admittedLines: number;
  visibleMessages: number;
  prefixChainDigest: string;
  pages: CapturePageReceipt[];
  nextAuditPageIndex: number;
  firstGuard: CaptureByteGuard;
  tailGuard: CaptureByteGuard;
  classification: "captured" | "empty";
  nativeSessionId: string | null;
  canonicalSessionId: string | null;
  sessionSeed: CaptureSessionSeed | null;
  updatedAt: string;
}

type CaptureCursorEntry = LegacyCaptureCursorEntry | CaptureCheckpointEntry;

interface CaptureCursor {
  schemaVersion: 1;
  files: Record<string, CaptureCursorEntry>;
  lastAttemptedFileKey: string | null;
}

interface DiscoveryBudget {
  scannedEntries: number;
  files: number;
}

interface AdmissionReadBudget {
  maximumBytes: number;
  usedBytes: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const CURSOR_SCHEMA_VERSION = 1 as const;
const MAX_CURSOR_BYTES = 4 * 1024 * 1024;
const CAPTURE_CHECKPOINT_VERSION = 1 as const;
const CAPTURE_GUARD_BYTES = 4 * 1024;
const MAX_CAPTURE_CHECKPOINT_PAGES = 20_000;
const MAX_CODEX_LINEAGE_DEPTH = 16;
const EMPTY_PREFIX_CHAIN_DIGEST = createHash("sha256")
  .update("andromeda-session-capture-prefix-chain-v1")
  .digest("hex");
const DEFAULT_LIMITS: SessionCaptureLimits = {
  maximumFiles: 10_000,
  maximumScannedEntries: 100_000,
  maximumDepth: 8,
  maximumFileBytes: 64 * 1024 * 1024,
  maximumTotalBytes: 512 * 1024 * 1024,
  maximumLinesPerFile: 100_000,
  maximumLineBytes: 4 * 1024 * 1024,
  maximumMessagesPerFile: 25_000,
};

class CaptureFailure extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

function plainRecord(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CaptureFailure("provider_drift", `${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new CaptureFailure("provider_drift", `${context} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") ? value : null;
}

function normalizedTimestamp(value: unknown, context: string): string {
  const timestamp = nonEmptyString(value, context);
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) {
    throw new CaptureFailure("provider_drift", `${context} must be an ISO timestamp`);
  }
  return new Date(milliseconds).toISOString();
}

function normalizedModel(value: string | null): string {
  return value && value !== "default" ? value : "unknown";
}

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function checkpointChainDigest(
  previousDigest: string,
  offset: number,
  length: number,
  contentHash: string,
): string {
  return createHash("sha256")
    .update(previousDigest)
    .update("\0")
    .update(String(offset))
    .update("\0")
    .update(String(length))
    .update("\0")
    .update(contentHash)
    .digest("hex");
}

function isCaptureCheckpoint(entry: CaptureCursorEntry | undefined): entry is CaptureCheckpointEntry {
  return entry?.checkpointVersion === CAPTURE_CHECKPOINT_VERSION;
}

function canonicalSessionId(provider: DesktopSessionProvider, nativeSessionId: string): string {
  if (!UUID.test(nativeSessionId)) {
    throw new CaptureFailure("provider_drift", `${provider} native session id is not a UUID`);
  }
  return `desktop-${provider}-${nativeSessionId.toLowerCase()}`;
}

function normalizedRelativePath(root: string, filePath: string): string {
  const relative = path.relative(root, filePath);
  if (!relative || relative === "." || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new CaptureFailure("unsafe_source_path", "provider transcript escaped its configured evidence root");
  }
  return relative.split(path.sep).join("/");
}

function sourcePathFor(provider: DesktopSessionProvider, relativePath: string): string {
  const prefix = provider === "claude" ? ".claude/projects" : ".codex/sessions";
  return `${prefix}/${relativePath}`;
}

function cursorKey(file: EvidenceFile): string {
  return `${file.provider}:${file.relativePath}`;
}

function captureCursorPath(state: SharedState): string {
  return path.join(state.stateDir, "runtime", "session-capture", "cursor.json");
}

function resolvedLimits(overrides: Partial<SessionCaptureLimits> = {}): SessionCaptureLimits {
  const result = { ...DEFAULT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
  if (result.maximumFileBytes <= result.maximumLineBytes) {
    throw new Error("maximumFileBytes must be greater than maximumLineBytes so a complete bounded line can be admitted");
  }
  const minimumTotalBytes = CAPTURE_GUARD_BYTES * 2 + (result.maximumLineBytes + 1) * 2;
  if (result.maximumTotalBytes < minimumTotalBytes) {
    throw new Error(
      `maximumTotalBytes must be at least ${minimumTotalBytes} for guards, one audit page, and one new page`,
    );
  }
  return result;
}

function emptyReport(): SessionCaptureReport {
  return {
    schemaVersion: 1,
    scannedFiles: 0,
    reconciledFiles: 0,
    importedSessions: 0,
    existingSessions: 0,
    importedMessages: 0,
    existingMessages: 0,
    skippedFiles: 0,
    deferredFiles: 0,
    failedFiles: 0,
    errors: [],
  };
}

function emptyCursor(): CaptureCursor {
  return {
    schemaVersion: CURSOR_SCHEMA_VERSION,
    files: {},
    lastAttemptedFileKey: null,
  };
}

function cursorRecord(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CaptureFailure("cursor_invalid", `${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function cursorInteger(value: unknown, context: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new CaptureFailure("cursor_invalid", `${context} must be an integer at least ${minimum}`);
  }
  return value as number;
}

function cursorSha256(value: unknown, context: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new CaptureFailure("cursor_invalid", `${context} must be a SHA-256 digest`);
  }
  return value;
}

function cursorDecimal(value: unknown, context: string): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new CaptureFailure("cursor_invalid", `${context} must be a canonical unsigned decimal`);
  }
  return value;
}

function validateCursorIdentity(
  key: string,
  entry: Record<string, unknown>,
): {
  provider: DesktopSessionProvider;
  relativePath: string;
  classification: "captured" | "empty";
  nativeSessionId: string | null;
  canonicalSessionId: string | null;
  updatedAt: string;
} {
  const provider = entry.provider;
  if (provider !== "claude" && provider !== "codex") {
    throw new CaptureFailure("cursor_invalid", `session capture cursor entry ${key} has an invalid provider`);
  }
  const relativePath = nonEmptyString(entry.relativePath, `session capture cursor entry ${key} relativePath`);
  if (
    relativePath.includes("\\") ||
    path.posix.isAbsolute(relativePath) ||
    path.posix.normalize(relativePath) !== relativePath ||
    relativePath.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
    key !== `${provider}:${relativePath}`
  ) {
    throw new CaptureFailure("cursor_invalid", `session capture cursor entry ${key} has an invalid source identity`);
  }
  if (entry.classification !== "captured" && entry.classification !== "empty") {
    throw new CaptureFailure("cursor_invalid", `session capture cursor entry ${key} has an invalid classification`);
  }
  const nativeSessionId = entry.nativeSessionId === null ? null : nonEmptyString(entry.nativeSessionId, "nativeSessionId");
  const canonicalId =
    entry.canonicalSessionId === null ? null : nonEmptyString(entry.canonicalSessionId, "canonicalSessionId");
  if (
    nativeSessionId !== null &&
    (!UUID.test(nativeSessionId) || nativeSessionId !== nativeSessionId.toLowerCase())
  ) {
    throw new CaptureFailure("cursor_invalid", `session capture cursor entry ${key} has an invalid nativeSessionId`);
  }
  if (
    canonicalId !== null &&
    (nativeSessionId === null || canonicalId !== canonicalSessionId(provider, nativeSessionId))
  ) {
    throw new CaptureFailure("cursor_invalid", `session capture cursor entry ${key} has an invalid canonicalSessionId`);
  }
  if (entry.classification === "captured" && (nativeSessionId === null || canonicalId === null)) {
    throw new CaptureFailure("cursor_invalid", `session capture cursor entry ${key} has incomplete captured identity`);
  }
  const updatedAt = normalizedTimestamp(entry.updatedAt, `session capture cursor entry ${key} updatedAt`);
  return {
    provider,
    relativePath,
    classification: entry.classification,
    nativeSessionId,
    canonicalSessionId: canonicalId,
    updatedAt,
  };
}

function validateCursorGuard(
  value: unknown,
  context: string,
  expectedOffset: number,
  expectedLength: number,
): CaptureByteGuard {
  const guard = cursorRecord(value, context);
  const offset = cursorInteger(guard.offset, `${context} offset`);
  const length = cursorInteger(guard.length, `${context} length`);
  const contentHash = cursorSha256(guard.contentHash, `${context} contentHash`);
  if (offset !== expectedOffset || length !== expectedLength) {
    throw new CaptureFailure("cursor_invalid", `${context} does not bind the expected byte range`);
  }
  return { offset, length, contentHash };
}

function validateCodexCaptureProgress(
  value: unknown,
  nativeSessionId: string,
  context: string,
): CodexCaptureProgress {
  const progress = cursorRecord(value, context);
  if (
    !Array.isArray(progress.lineageSessionIds) ||
    progress.lineageSessionIds.length < 1 ||
    progress.lineageSessionIds.length > MAX_CODEX_LINEAGE_DEPTH
  ) {
    throw new CaptureFailure("cursor_invalid", `${context} has an invalid lineageSessionIds`);
  }
  const lineageSessionIds = progress.lineageSessionIds.map((value, index) => {
    if (typeof value !== "string" || !UUID.test(value) || value !== value.toLowerCase()) {
      throw new CaptureFailure("cursor_invalid", `${context} lineageSessionIds[${index}] is invalid`);
    }
    return value;
  });
  if (
    lineageSessionIds[0] !== nativeSessionId ||
    new Set(lineageSessionIds).size !== lineageSessionIds.length
  ) {
    throw new CaptureFailure("cursor_invalid", `${context} lineage identity drifted`);
  }
  const nullableUuid = (value: unknown, field: string): string | null => {
    if (value === null) return null;
    if (typeof value !== "string" || !UUID.test(value) || value !== value.toLowerCase()) {
      throw new CaptureFailure("cursor_invalid", `${context} ${field} is invalid`);
    }
    return value;
  };
  const ownerParentSessionId = nullableUuid(progress.ownerParentSessionId, "ownerParentSessionId");
  const expectedParentSessionId = nullableUuid(
    progress.expectedParentSessionId,
    "expectedParentSessionId",
  );
  if (
    typeof progress.lineageClosed !== "boolean" ||
    typeof progress.lineageTruncated !== "boolean" ||
    typeof progress.ownerMessagesStarted !== "boolean"
  ) {
    throw new CaptureFailure("cursor_invalid", `${context} has invalid boolean state`);
  }
  if (
    (lineageSessionIds.length > 1 && ownerParentSessionId !== lineageSessionIds[1]) ||
    (ownerParentSessionId === null && lineageSessionIds.length !== 1) ||
    (!progress.lineageClosed && expectedParentSessionId === null) ||
    (!progress.lineageClosed &&
      lineageSessionIds.length === 1 &&
      expectedParentSessionId !== ownerParentSessionId) ||
    (!progress.lineageClosed && lineageSessionIds.includes(expectedParentSessionId as string)) ||
    (!progress.lineageClosed && lineageSessionIds.length >= MAX_CODEX_LINEAGE_DEPTH) ||
    (progress.lineageClosed && expectedParentSessionId !== null) ||
    (progress.lineageTruncated &&
      (!progress.lineageClosed ||
        lineageSessionIds.length !== 1 ||
        ownerParentSessionId === null)) ||
    (progress.lineageClosed &&
      lineageSessionIds.length === 1 &&
      ownerParentSessionId !== null &&
      !progress.lineageTruncated) ||
    (!progress.lineageClosed && progress.lineageTruncated) ||
    (!progress.lineageClosed && progress.ownerMessagesStarted) ||
    (ownerParentSessionId === null &&
      (!progress.lineageClosed || progress.lineageTruncated || !progress.ownerMessagesStarted))
  ) {
    throw new CaptureFailure("cursor_invalid", `${context} has inconsistent lineage state`);
  }
  return {
    lineageSessionIds,
    ownerParentSessionId,
    expectedParentSessionId,
    lineageClosed: progress.lineageClosed,
    lineageTruncated: progress.lineageTruncated,
    ownerMessagesStarted: progress.ownerMessagesStarted,
  };
}

function validateSessionSeed(
  value: unknown,
  identity: ReturnType<typeof validateCursorIdentity>,
  key: string,
): CaptureSessionSeed | null {
  if (value === null) return null;
  const seed = cursorRecord(value, `session capture cursor entry ${key} sessionSeed`);
  if (seed.provider !== identity.provider) {
    throw new CaptureFailure("cursor_invalid", `session capture cursor entry ${key} seed provider drifted`);
  }
  const nativeSessionId = nonEmptyString(seed.nativeSessionId, `session capture cursor entry ${key} seed nativeSessionId`);
  if (!UUID.test(nativeSessionId) || nativeSessionId !== nativeSessionId.toLowerCase()) {
    throw new CaptureFailure("cursor_invalid", `session capture cursor entry ${key} seed nativeSessionId is invalid`);
  }
  const sourceFormat = nonEmptyString(seed.sourceFormat, `session capture cursor entry ${key} seed sourceFormat`);
  const sourcePath = nonEmptyString(seed.sourcePath, `session capture cursor entry ${key} seed sourcePath`);
  const expectedFormat =
    identity.provider === "claude" ? "claude-project-jsonl-v1" : "codex-rollout-jsonl-v1";
  if (
    sourceFormat !== expectedFormat ||
    sourcePath !== sourcePathFor(identity.provider, identity.relativePath)
  ) {
    throw new CaptureFailure("cursor_invalid", `session capture cursor entry ${key} seed source provenance drifted`);
  }
  const metadata = cursorRecord(seed.metadata, `session capture cursor entry ${key} seed metadata`);
  if (
    metadata.source !== "provider-transcript" ||
    metadata.sourceProvider !== identity.provider ||
    metadata.exchange !== "local-only" ||
    metadata.exchangeReason !== "provider-transcript" ||
    metadata.nativeSessionId !== nativeSessionId ||
    metadata.sourceFormat !== sourceFormat ||
    metadata.sourcePath !== sourcePath
  ) {
    throw new CaptureFailure("cursor_invalid", `session capture cursor entry ${key} seed metadata drifted`);
  }
  const codexProgress =
    identity.provider === "codex"
      ? validateCodexCaptureProgress(
          seed.codexProgress,
          nativeSessionId,
          `session capture cursor entry ${key} seed codexProgress`,
        )
      : undefined;
  if (identity.provider === "claude" && seed.codexProgress !== undefined) {
    throw new CaptureFailure("cursor_invalid", `session capture cursor entry ${key} has Codex progress for Claude`);
  }
  return {
    provider: identity.provider,
    nativeSessionId,
    sourceFormat,
    sourcePath,
    createdAt: normalizedTimestamp(seed.createdAt, `session capture cursor entry ${key} seed createdAt`),
    model: nonEmptyString(seed.model, `session capture cursor entry ${key} seed model`),
    metadata,
    ...(codexProgress ? { codexProgress } : {}),
  };
}

function validateLegacyCursorEntry(
  key: string,
  entry: Record<string, unknown>,
  identity: ReturnType<typeof validateCursorIdentity>,
): LegacyCaptureCursorEntry {
  const admittedBytes = cursorInteger(entry.admittedBytes, `session capture cursor entry ${key} admittedBytes`);
  const contentHash = cursorSha256(entry.contentHash, `session capture cursor entry ${key} contentHash`);
  return {
    ...identity,
    admittedBytes,
    contentHash,
  };
}

function validateCheckpointCursorEntry(
  key: string,
  entry: Record<string, unknown>,
  identity: ReturnType<typeof validateCursorIdentity>,
): CaptureCheckpointEntry {
  const admittedBytes = cursorInteger(entry.admittedBytes, `session capture cursor entry ${key} admittedBytes`);
  const admittedLines = cursorInteger(entry.admittedLines, `session capture cursor entry ${key} admittedLines`);
  const visibleMessages = cursorInteger(entry.visibleMessages, `session capture cursor entry ${key} visibleMessages`);
  const observedSize = cursorInteger(entry.observedSize, `session capture cursor entry ${key} observedSize`);
  if (observedSize < admittedBytes) {
    throw new CaptureFailure("cursor_invalid", `session capture cursor entry ${key} observed size precedes its checkpoint`);
  }
  const fileDevice = cursorDecimal(entry.fileDevice, `session capture cursor entry ${key} fileDevice`);
  const fileInode = cursorDecimal(entry.fileInode, `session capture cursor entry ${key} fileInode`);
  const observedModifiedAtNs = cursorDecimal(
    entry.observedModifiedAtNs,
    `session capture cursor entry ${key} observedModifiedAtNs`,
  );
  if (!Array.isArray(entry.pages) || entry.pages.length > MAX_CAPTURE_CHECKPOINT_PAGES) {
    throw new CaptureFailure("cursor_invalid", `session capture cursor entry ${key} has invalid page receipts`);
  }
  const pages: CapturePageReceipt[] = [];
  let expectedOffset = 0;
  let expectedChain = EMPTY_PREFIX_CHAIN_DIGEST;
  for (const [index, value] of entry.pages.entries()) {
    const page = cursorRecord(value, `session capture cursor entry ${key} page ${index}`);
    const offset = cursorInteger(page.offset, `session capture cursor entry ${key} page ${index} offset`);
    const length = cursorInteger(page.length, `session capture cursor entry ${key} page ${index} length`, 1);
    const contentHash = cursorSha256(
      page.contentHash,
      `session capture cursor entry ${key} page ${index} contentHash`,
    );
    const prefixChainDigest = cursorSha256(
      page.prefixChainDigest,
      `session capture cursor entry ${key} page ${index} prefixChainDigest`,
    );
    if (offset !== expectedOffset) {
      throw new CaptureFailure("cursor_invalid", `session capture cursor entry ${key} pages are not contiguous`);
    }
    expectedChain = checkpointChainDigest(expectedChain, offset, length, contentHash);
    if (prefixChainDigest !== expectedChain) {
      throw new CaptureFailure("cursor_invalid", `session capture cursor entry ${key} page chain drifted`);
    }
    expectedOffset += length;
    pages.push({ offset, length, contentHash, prefixChainDigest });
  }
  if (expectedOffset !== admittedBytes) {
    throw new CaptureFailure("cursor_invalid", `session capture cursor entry ${key} page boundary drifted`);
  }
  const prefixChainDigest = cursorSha256(
    entry.prefixChainDigest,
    `session capture cursor entry ${key} prefixChainDigest`,
  );
  if (prefixChainDigest !== expectedChain) {
    throw new CaptureFailure("cursor_invalid", `session capture cursor entry ${key} prefix chain drifted`);
  }
  const nextAuditPageIndex = cursorInteger(
    entry.nextAuditPageIndex,
    `session capture cursor entry ${key} nextAuditPageIndex`,
  );
  if (
    (pages.length === 0 && nextAuditPageIndex !== 0) ||
    (pages.length > 0 && nextAuditPageIndex >= pages.length)
  ) {
    throw new CaptureFailure("cursor_invalid", `session capture cursor entry ${key} audit cursor is invalid`);
  }
  const firstLength = Math.min(admittedBytes, CAPTURE_GUARD_BYTES);
  const tailOffset = Math.max(0, admittedBytes - CAPTURE_GUARD_BYTES);
  const firstGuard = validateCursorGuard(
    entry.firstGuard,
    `session capture cursor entry ${key} firstGuard`,
    0,
    firstLength,
  );
  const tailGuard = validateCursorGuard(
    entry.tailGuard,
    `session capture cursor entry ${key} tailGuard`,
    tailOffset,
    admittedBytes - tailOffset,
  );
  const sessionSeed = validateSessionSeed(entry.sessionSeed, identity, key);
  if (
    identity.nativeSessionId !== null &&
    sessionSeed !== null &&
    identity.nativeSessionId !== sessionSeed.nativeSessionId
  ) {
    throw new CaptureFailure("cursor_invalid", `session capture cursor entry ${key} seed identity drifted`);
  }
  return {
    checkpointVersion: CAPTURE_CHECKPOINT_VERSION,
    ...identity,
    fileDevice,
    fileInode,
    observedSize,
    observedModifiedAtNs,
    admittedBytes,
    admittedLines,
    visibleMessages,
    prefixChainDigest,
    pages,
    nextAuditPageIndex,
    firstGuard,
    tailGuard,
    sessionSeed,
  };
}

function validateCursorEntry(key: string, value: unknown): CaptureCursorEntry {
  const entry = cursorRecord(value, `session capture cursor entry ${key}`);
  const identity = validateCursorIdentity(key, entry);
  if (entry.checkpointVersion === undefined) return validateLegacyCursorEntry(key, entry, identity);
  if (entry.checkpointVersion !== CAPTURE_CHECKPOINT_VERSION) {
    throw new CaptureFailure("cursor_invalid", `session capture cursor entry ${key} checkpoint version is unsupported`);
  }
  return validateCheckpointCursorEntry(key, entry, identity);
}

async function readCursor(state: SharedState): Promise<CaptureCursor> {
  const filePath = captureCursorPath(state);
  let info;
  try {
    info = await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyCursor();
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new CaptureFailure("cursor_invalid", "session capture cursor must be a physical regular file");
  }
  if (info.size > MAX_CURSOR_BYTES) {
    throw new CaptureFailure("cursor_invalid", `session capture cursor exceeds ${MAX_CURSOR_BYTES} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new CaptureFailure("cursor_invalid", `session capture cursor is malformed: ${(error as Error).message}`);
  }
  const record = plainRecord(parsed, "session capture cursor");
  if (record.schemaVersion !== CURSOR_SCHEMA_VERSION) {
    throw new CaptureFailure("cursor_invalid", "session capture cursor schema is unsupported");
  }
  const rawFiles = plainRecord(record.files, "session capture cursor files");
  const files: Record<string, CaptureCursorEntry> = {};
  for (const [key, value] of Object.entries(rawFiles)) files[key] = validateCursorEntry(key, value);
  const lastAttemptedFileKey =
    record.lastAttemptedFileKey === undefined || record.lastAttemptedFileKey === null
      ? null
      : nonEmptyString(record.lastAttemptedFileKey, "session capture cursor lastAttemptedFileKey");
  return {
    schemaVersion: CURSOR_SCHEMA_VERSION,
    files,
    lastAttemptedFileKey,
  };
}

async function writeCursor(state: SharedState, cursor: CaptureCursor): Promise<void> {
  const content = `${JSON.stringify(cursor, null, 2)}\n`;
  if (Buffer.byteLength(content) > MAX_CURSOR_BYTES) {
    throw new CaptureFailure("cursor_limit", `session capture cursor exceeds ${MAX_CURSOR_BYTES} bytes`);
  }
  await writeTextAtomic(captureCursorPath(state), content, 0o600);
}

async function physicalSessionExists(state: SharedState, sessionId: string): Promise<boolean> {
  try {
    const info = await lstat(sessionPaths(state, sessionId).dir);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function directoryAdmission(
  absolutePath: string,
  info: BigIntStats,
  context: string,
): PhysicalDirectoryAdmission {
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new CaptureFailure("unsafe_source_root", `${context} must have only physical directory ancestors`);
  }
  return {
    absolutePath,
    device: BigInt(info.dev),
    inode: BigInt(info.ino),
  };
}

function samePhysicalDirectory(
  admission: PhysicalDirectoryAdmission,
  info: BigIntStats,
): boolean {
  return (
    info.isDirectory() &&
    !info.isSymbolicLink() &&
    BigInt(info.dev) === admission.device &&
    BigInt(info.ino) === admission.inode
  );
}

async function admitConfiguredEvidenceRoot(
  provider: DesktopSessionProvider,
  root: string,
): Promise<PhysicalDirectoryAdmission[] | null> {
  const resolved = path.resolve(root);
  const parsed = path.parse(resolved);
  const relative = path.relative(parsed.root, resolved);
  const components = relative.length === 0 ? [] : relative.split(path.sep);
  const paths = [parsed.root];
  let current = parsed.root;
  for (const component of components) {
    current = path.join(current, component);
    paths.push(current);
  }
  const admissions: PhysicalDirectoryAdmission[] = [];
  for (const directoryPath of paths) {
    let info: BigIntStats;
    try {
      info = await lstat(directoryPath, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    admissions.push(directoryAdmission(directoryPath, info, `${provider} evidence root`));
  }
  return admissions;
}

async function assertPhysicalDirectoryChain(
  admissions: PhysicalDirectoryAdmission[],
): Promise<void> {
  for (const admission of admissions) {
    let info: BigIntStats;
    try {
      info = await lstat(admission.absolutePath, { bigint: true });
    } catch (error) {
      throw new CaptureFailure(
        "source_changed",
        `provider transcript ancestor changed during admission: ${admission.absolutePath}`,
        true,
      );
    }
    if (!samePhysicalDirectory(admission, info)) {
      throw new CaptureFailure(
        "source_changed",
        `provider transcript ancestor changed during admission: ${admission.absolutePath}`,
        true,
      );
    }
  }
}

function physicalFileIdentity(
  info: BigIntStats,
  context: string,
): PhysicalFileIdentity {
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new CaptureFailure("unsafe_source_path", `${context} must be a physical regular file`);
  }
  return {
    device: BigInt(info.dev),
    inode: BigInt(info.ino),
    size: BigInt(info.size),
    modifiedAtNs: BigInt(info.mtimeNs),
  };
}

function samePhysicalFile(
  left: PhysicalFileIdentity,
  right: PhysicalFileIdentity,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedAtNs === right.modifiedAtNs
  );
}

async function discoverEvidenceFiles(
  provider: DesktopSessionProvider,
  root: string,
  limits: SessionCaptureLimits,
  budget: DiscoveryBudget,
): Promise<EvidenceFile[]> {
  const rootAdmissions = await admitConfiguredEvidenceRoot(provider, root);
  if (rootAdmissions === null) return [];

  const output: EvidenceFile[] = [];
  const pending: Array<{
    directory: string;
    depth: number;
    ancestors: PhysicalDirectoryAdmission[];
  }> = [{ directory: path.resolve(root), depth: 0, ancestors: rootAdmissions }];
  while (pending.length > 0) {
    const current = pending.shift()!;
    await assertPhysicalDirectoryChain(current.ancestors);
    const entries = (await readdir(current.directory, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    await assertPhysicalDirectoryChain(current.ancestors);
    for (const entry of entries) {
      budget.scannedEntries += 1;
      if (budget.scannedEntries > limits.maximumScannedEntries) {
        throw new CaptureFailure(
          "scan_limit",
          `desktop transcript discovery exceeds maximumScannedEntries ${limits.maximumScannedEntries}`,
        );
      }
      const absolutePath = path.join(current.directory, entry.name);
      await assertPhysicalDirectoryChain(current.ancestors);
      let info: BigIntStats;
      try {
        info = await lstat(absolutePath, { bigint: true });
      } catch (error) {
        throw new CaptureFailure(
          "source_changed",
          `provider transcript evidence changed during discovery: ${absolutePath}`,
          true,
        );
      }
      await assertPhysicalDirectoryChain(current.ancestors);
      if (info.isSymbolicLink()) {
        if (entry.name.toLowerCase().endsWith(".jsonl")) {
          throw new CaptureFailure("unsafe_source_path", `${provider} transcript cannot be a symlink`);
        }
        continue;
      }
      if (info.isDirectory()) {
        if (current.depth >= limits.maximumDepth) {
          throw new CaptureFailure("scan_limit", `${provider} evidence tree exceeds maximumDepth ${limits.maximumDepth}`);
        }
        pending.push({
          directory: absolutePath,
          depth: current.depth + 1,
          ancestors: [
            ...current.ancestors,
            directoryAdmission(absolutePath, info, `${provider} evidence tree`),
          ],
        });
        continue;
      }
      const lower = entry.name.toLowerCase();
      const matches =
        info.isFile() &&
        (provider === "claude" ? lower.endsWith(".jsonl") : lower.startsWith("rollout-") && lower.endsWith(".jsonl"));
      if (!matches) continue;
      budget.files += 1;
      if (budget.files > limits.maximumFiles) {
        throw new CaptureFailure("scan_limit", `desktop transcript discovery exceeds maximumFiles ${limits.maximumFiles}`);
      }
      const relativePath = normalizedRelativePath(root, absolutePath);
      output.push({
        provider,
        absolutePath,
        relativePath,
        sourcePath: sourcePathFor(provider, relativePath),
        ancestors: current.ancestors,
        identity: physicalFileIdentity(info, `${provider} transcript`),
      });
    }
    await assertPhysicalDirectoryChain(current.ancestors);
  }
  return output.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function parseCompleteJsonLines(
  bytes: Buffer,
  completeBytes: number,
  limits: SessionCaptureLimits,
  startingLine = 0,
): ParsedJsonPage {
  const text = bytes.subarray(0, completeBytes).toString("utf8");
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (startingLine + lines.length > limits.maximumLinesPerFile) {
    throw new CaptureFailure("file_limit", `provider transcript exceeds maximumLinesPerFile ${limits.maximumLinesPerFile}`);
  }
  const records: ParsedJsonLine[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index];
    const lineNumber = startingLine + index + 1;
    if (lineNumber === 1 && line.startsWith("\uFEFF")) line = line.slice(1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.length === 0) continue;
    if (Buffer.byteLength(line) > limits.maximumLineBytes) {
      throw new CaptureFailure("line_limit", `provider transcript line ${lineNumber} exceeds maximumLineBytes`);
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new CaptureFailure(
        "malformed_jsonl",
        `provider transcript line ${lineNumber} is malformed: ${(error as Error).message}`,
      );
    }
    records.push({
      line: lineNumber,
      digest: sha256(line),
      value: plainRecord(value, `provider transcript line ${lineNumber}`),
    });
  }
  return { records, lineCount: lines.length };
}

function checkpointPageQuantum(limits: SessionCaptureLimits): number {
  const afterGuards = limits.maximumTotalBytes - CAPTURE_GUARD_BYTES * 2;
  const quantum = Math.min(limits.maximumFileBytes, Math.floor(afterGuards / 2));
  if (quantum <= limits.maximumLineBytes) {
    throw new Error("session capture page quantum cannot admit one maximum-size JSONL line");
  }
  return quantum;
}

function reserveAdmissionBytes(budget: AdmissionReadBudget, length: number): void {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new CaptureFailure("file_limit", "provider transcript byte range is not safely addressable");
  }
  if (length > budget.maximumBytes - budget.usedBytes) {
    throw new CaptureFailure(
      "scan_limit",
      `desktop transcript admission exceeds maximumTotalBytes ${budget.maximumBytes}`,
      true,
    );
  }
  budget.usedBytes += length;
}

interface CachedAdmissionRange {
  offset: number;
  bytes: Buffer;
}

async function readAdmissionRange(
  handle: Awaited<ReturnType<typeof open>>,
  offset: number,
  length: number,
  budget: AdmissionReadBudget,
  cache: CachedAdmissionRange[],
): Promise<Buffer> {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
    throw new CaptureFailure("file_limit", "provider transcript byte range is not safely addressable");
  }
  if (length === 0) return Buffer.alloc(0);
  const cached = cache.find(
    (item) => item.offset <= offset && item.offset + item.bytes.length >= offset + length,
  );
  if (cached) {
    return cached.bytes.subarray(offset - cached.offset, offset - cached.offset + length);
  }
  reserveAdmissionBytes(budget, length);
  const bytes = Buffer.alloc(length);
  let consumed = 0;
  while (consumed < length) {
    const { bytesRead } = await handle.read(bytes, consumed, length - consumed, offset + consumed);
    if (bytesRead === 0) break;
    consumed += bytesRead;
  }
  if (consumed !== length) {
    throw new CaptureFailure("source_changed", "provider transcript changed during admission", true);
  }
  cache.push({ offset, bytes });
  return bytes;
}

function captureGuard(offset: number, bytes: Buffer): CaptureByteGuard {
  return { offset, length: bytes.length, contentHash: sha256(bytes) };
}

function appendCheckpointReceipt(
  checkpoint: CaptureCheckpointEntry,
  offset: number,
  bytes: Buffer,
): void {
  if (checkpoint.pages.length >= MAX_CAPTURE_CHECKPOINT_PAGES) {
    throw new CaptureFailure(
      "cursor_limit",
      `provider transcript exceeds ${MAX_CAPTURE_CHECKPOINT_PAGES} checkpoint pages`,
    );
  }
  const contentHash = sha256(bytes);
  const prefixChainDigest = checkpointChainDigest(
    checkpoint.prefixChainDigest,
    offset,
    bytes.length,
    contentHash,
  );
  checkpoint.pages.push({ offset, length: bytes.length, contentHash, prefixChainDigest });
  checkpoint.prefixChainDigest = prefixChainDigest;
}

function initialCheckpoint(
  file: EvidenceFile,
  identity: PhysicalFileIdentity,
  updatedAt: string,
): CaptureCheckpointEntry {
  const emptyGuard = captureGuard(0, Buffer.alloc(0));
  return {
    checkpointVersion: CAPTURE_CHECKPOINT_VERSION,
    provider: file.provider,
    relativePath: file.relativePath,
    fileDevice: identity.device.toString(),
    fileInode: identity.inode.toString(),
    observedSize: Number(identity.size),
    observedModifiedAtNs: identity.modifiedAtNs.toString(),
    admittedBytes: 0,
    admittedLines: 0,
    visibleMessages: 0,
    prefixChainDigest: EMPTY_PREFIX_CHAIN_DIGEST,
    pages: [],
    nextAuditPageIndex: 0,
    firstGuard: emptyGuard,
    tailGuard: emptyGuard,
    classification: "empty",
    nativeSessionId: null,
    canonicalSessionId: null,
    sessionSeed: null,
    updatedAt,
  };
}

async function upgradeLegacyCheckpoint(
  file: EvidenceFile,
  legacy: LegacyCaptureCursorEntry,
  identity: PhysicalFileIdentity,
  handle: Awaited<ReturnType<typeof open>>,
  limits: SessionCaptureLimits,
  budget: AdmissionReadBudget,
  cache: CachedAdmissionRange[],
): Promise<CaptureCheckpointEntry> {
  if (identity.size < BigInt(legacy.admittedBytes)) {
    throw new CaptureFailure("source_rewritten", "provider transcript shrank after canonical admission");
  }
  const prefix = await readAdmissionRange(handle, 0, legacy.admittedBytes, budget, cache);
  if (sha256(prefix) !== legacy.contentHash) {
    throw new CaptureFailure("source_rewritten", "provider transcript changed before its admitted append boundary");
  }
  const parsed = parseCompleteJsonLines(prefix, prefix.length, limits);
  const normalized = normalizeDesktopSession(
    file,
    parsed.records,
    limits,
    null,
    legacy.admittedBytes === Number(identity.size),
  );
  const checkpoint = initialCheckpoint(file, identity, legacy.updatedAt);
  checkpoint.classification = legacy.classification;
  checkpoint.nativeSessionId = legacy.nativeSessionId;
  checkpoint.canonicalSessionId = legacy.canonicalSessionId;
  checkpoint.admittedLines = parsed.lineCount;
  checkpoint.visibleMessages = normalized?.messages.length ?? 0;
  checkpoint.sessionSeed = normalized === null ? null : sessionSeedFromNormalized(normalized);
  const quantum = checkpointPageQuantum(limits);
  for (let offset = 0; offset < prefix.length; offset += quantum) {
    appendCheckpointReceipt(checkpoint, offset, prefix.subarray(offset, Math.min(prefix.length, offset + quantum)));
  }
  checkpoint.admittedBytes = legacy.admittedBytes;
  return checkpoint;
}

async function verifyCheckpointGuard(
  guard: CaptureByteGuard,
  handle: Awaited<ReturnType<typeof open>>,
  budget: AdmissionReadBudget,
  cache: CachedAdmissionRange[],
  description: string,
): Promise<void> {
  const bytes = await readAdmissionRange(handle, guard.offset, guard.length, budget, cache);
  if (sha256(bytes) !== guard.contentHash) {
    throw new CaptureFailure("source_rewritten", `provider transcript changed in its ${description}`);
  }
}

async function admitJsonl(
  file: EvidenceFile,
  limits: SessionCaptureLimits,
  previous: CaptureCursorEntry | undefined,
  budget: AdmissionReadBudget,
  updatedAt: string,
): Promise<AdmittedJsonl> {
  await assertPhysicalDirectoryChain(file.ancestors);
  const before = physicalFileIdentity(
    await lstat(file.absolutePath, { bigint: true }),
    "provider transcript",
  );
  if (before.device !== file.identity.device || before.inode !== file.identity.inode) {
    throw new CaptureFailure("source_changed", "provider transcript changed after discovery", true);
  }
  if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CaptureFailure("file_limit", "provider transcript exceeds the safe byte-offset range");
  }
  const size = Number(before.size);
  const handle = await open(file.absolutePath, "r");
  const cache: CachedAdmissionRange[] = [];
  let checkpoint: CaptureCheckpointEntry;
  let pageStart = 0;
  let records: ParsedJsonLine[] = [];
  try {
    await assertPhysicalDirectoryChain(file.ancestors);
    const opened = physicalFileIdentity(
      await handle.stat({ bigint: true }),
      "provider transcript",
    );
    if (!samePhysicalFile(before, opened)) {
      throw new CaptureFailure("source_changed", "provider transcript changed during admission", true);
    }

    if (isCaptureCheckpoint(previous)) {
      if (
        previous.fileDevice !== before.device.toString() ||
        previous.fileInode !== before.inode.toString()
      ) {
        throw new CaptureFailure("source_rewritten", "provider transcript file identity changed after canonical admission");
      }
      checkpoint = structuredClone(previous);
    } else if (previous) {
      checkpoint = await upgradeLegacyCheckpoint(file, previous, before, handle, limits, budget, cache);
    } else {
      checkpoint = initialCheckpoint(file, before, updatedAt);
    }
    if (size < checkpoint.admittedBytes) {
      throw new CaptureFailure("source_rewritten", "provider transcript shrank after canonical admission");
    }

    await verifyCheckpointGuard(checkpoint.firstGuard, handle, budget, cache, "first boundary guard");
    if (
      checkpoint.tailGuard.offset !== checkpoint.firstGuard.offset ||
      checkpoint.tailGuard.length !== checkpoint.firstGuard.length
    ) {
      await verifyCheckpointGuard(checkpoint.tailGuard, handle, budget, cache, "tail boundary guard");
    }
    if (checkpoint.pages.length > 0) {
      const auditIndex = checkpoint.nextAuditPageIndex;
      const auditPage = checkpoint.pages[auditIndex];
      const auditBytes = await readAdmissionRange(
        handle,
        auditPage.offset,
        auditPage.length,
        budget,
        cache,
      );
      if (sha256(auditBytes) !== auditPage.contentHash) {
        throw new CaptureFailure(
          "source_rewritten",
          `provider transcript changed in checkpoint page ${auditIndex + 1}`,
        );
      }
      checkpoint.nextAuditPageIndex = (auditIndex + 1) % checkpoint.pages.length;
    }

    pageStart = checkpoint.admittedBytes;
    if (pageStart < size) {
      const readLength = Math.min(size - pageStart, checkpointPageQuantum(limits));
      const pageBytes = await readAdmissionRange(handle, pageStart, readLength, budget, cache);
      const lastNewline = pageBytes.lastIndexOf(0x0a);
      if (lastNewline === -1) {
        if (readLength > limits.maximumLineBytes) {
          throw new CaptureFailure(
            "line_limit",
            `provider transcript line ${checkpoint.admittedLines + 1} exceeds maximumLineBytes`,
          );
        }
      } else {
        const completeLength = lastNewline + 1;
        const completePage = pageBytes.subarray(0, completeLength);
        const parsed = parseCompleteJsonLines(
          completePage,
          completePage.length,
          limits,
          checkpoint.admittedLines,
        );
        appendCheckpointReceipt(checkpoint, pageStart, completePage);
        checkpoint.admittedBytes += completeLength;
        checkpoint.admittedLines += parsed.lineCount;
        records = parsed.records;
      }
    }

    const firstLength = Math.min(checkpoint.admittedBytes, CAPTURE_GUARD_BYTES);
    const tailOffset = Math.max(0, checkpoint.admittedBytes - CAPTURE_GUARD_BYTES);
    checkpoint.firstGuard = captureGuard(
      0,
      await readAdmissionRange(handle, 0, firstLength, budget, cache),
    );
    checkpoint.tailGuard = captureGuard(
      tailOffset,
      await readAdmissionRange(
        handle,
        tailOffset,
        checkpoint.admittedBytes - tailOffset,
        budget,
        cache,
      ),
    );
    checkpoint.observedSize = size;
    checkpoint.observedModifiedAtNs = before.modifiedAtNs.toString();
    checkpoint.updatedAt = updatedAt;

    const afterHandle = physicalFileIdentity(
      await handle.stat({ bigint: true }),
      "provider transcript",
    );
    if (!samePhysicalFile(before, afterHandle)) {
      throw new CaptureFailure("source_changed", "provider transcript changed during admission", true);
    }
  } finally {
    await handle.close();
  }
  const afterPath = physicalFileIdentity(
    await lstat(file.absolutePath, { bigint: true }),
    "provider transcript",
  );
  if (!samePhysicalFile(before, afterPath)) {
    throw new CaptureFailure("source_changed", "provider transcript changed during admission", true);
  }
  await assertPhysicalDirectoryChain(file.ancestors);
  return {
    records,
    checkpoint,
    pageStart,
    advancedBytes: checkpoint.admittedBytes - pageStart,
    hasRemainingBytes: checkpoint.admittedBytes < size,
  };
}

function visibleText(value: unknown, context: string, textualKinds: Set<string>): string | null {
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (!Array.isArray(value)) {
    throw new CaptureFailure("provider_drift", `${context} must be text or an array`);
  }
  const texts: string[] = [];
  for (const [index, rawPart] of value.entries()) {
    const part = plainRecord(rawPart, `${context}[${index}]`);
    const kind = nonEmptyString(part.type, `${context}[${index}].type`);
    if (!textualKinds.has(kind)) continue;
    if (typeof part.text !== "string") {
      throw new CaptureFailure("provider_drift", `${context}[${index}].text must be a string`);
    }
    if (part.text.length > 0) texts.push(part.text);
  }
  return texts.length > 0 ? texts.join("\n") : null;
}

function deduplicateMessages(
  messages: NormalizedSourceMessage[],
  maximumMessages: number,
): NormalizedSourceMessage[] {
  const unique = new Map<string, NormalizedSourceMessage>();
  for (const message of [...messages].sort((left, right) => left.sourceLine - right.sourceLine)) {
    const previous = unique.get(message.sourceRecordId);
    if (
      previous &&
      (previous.sourceTimestamp !== message.sourceTimestamp ||
        JSON.stringify(previous.message) !== JSON.stringify(message.message))
    ) {
      throw new CaptureFailure(
        "provider_drift",
        `provider source record ${message.sourceRecordId} is duplicated with conflicting content`,
      );
    }
    unique.set(message.sourceRecordId, message);
    if (unique.size > maximumMessages) {
      throw new CaptureFailure("file_limit", `provider transcript exceeds maximumMessagesPerFile ${maximumMessages}`);
    }
  }
  return [...unique.values()];
}

function normalizeClaude(
  file: EvidenceFile,
  records: ParsedJsonLine[],
  limits: SessionCaptureLimits,
): NormalizedDesktopSession | null {
  const fileSessionId = path.basename(file.relativePath, path.extname(file.relativePath));
  if (!UUID.test(fileSessionId)) {
    throw new CaptureFailure("provider_drift", "Claude transcript filename does not contain a native session UUID");
  }
  const sessionIds = new Set<string>();
  const entrypoints = new Set<string>();
  const versions = new Set<string>();
  const workdirs = new Set<string>();
  const models: string[] = [];
  const timestamps: string[] = [];
  const messages: NormalizedSourceMessage[] = [];
  const textualKinds = new Set(["text"]);

  for (const record of records) {
    const type = optionalString(record.value.type);
    if (type !== "user" && type !== "assistant") continue;
    const nativeSessionId = nonEmptyString(record.value.sessionId, `Claude line ${record.line} sessionId`);
    sessionIds.add(nativeSessionId.toLowerCase());
    const sourceRecordId = nonEmptyString(record.value.uuid, `Claude line ${record.line} uuid`);
    const sourceTimestamp = normalizedTimestamp(record.value.timestamp, `Claude line ${record.line} timestamp`);
    const entrypoint = optionalString(record.value.entrypoint);
    if (entrypoint) entrypoints.add(entrypoint);
    const version = optionalString(record.value.version);
    if (version) versions.add(version);
    const cwd = optionalString(record.value.cwd);
    if (cwd) workdirs.add(cwd);
    if (record.value.isMeta !== undefined && typeof record.value.isMeta !== "boolean") {
      throw new CaptureFailure("provider_drift", `Claude line ${record.line} isMeta must be a boolean`);
    }
    if (record.value.isMeta === true) continue;
    timestamps.push(sourceTimestamp);

    const nativeMessage = plainRecord(record.value.message, `Claude line ${record.line} message`);
    const nativeRole = nonEmptyString(nativeMessage.role, `Claude line ${record.line} message.role`);
    if (nativeRole !== type) {
      throw new CaptureFailure("provider_drift", `Claude line ${record.line} role does not match its record type`);
    }
    const model = optionalString(nativeMessage.model);
    if (model && model !== "<synthetic>" && model !== "default") models.push(model);
    const content = visibleText(
      nativeMessage.content,
      `Claude line ${record.line} message.content`,
      textualKinds,
    );
    if (content === null) continue;
    messages.push({
      sourceLine: record.line,
      sourceRecordId,
      sourceTimestamp,
      message: { role: type, content },
    });
  }

  if (sessionIds.size === 0) return null;
  if (sessionIds.size !== 1 || !sessionIds.has(fileSessionId.toLowerCase())) {
    throw new CaptureFailure("provider_drift", "Claude transcript native session identity drifted");
  }
  const normalizedMessages = deduplicateMessages(messages, limits.maximumMessagesPerFile);
  const createdAt = timestamps.sort()[0];
  if (!createdAt) return null;
  return {
    provider: "claude",
    nativeSessionId: fileSessionId.toLowerCase(),
    sourceFormat: "claude-project-jsonl-v1",
    sourcePath: file.sourcePath,
    createdAt,
    model: normalizedModel(models[0] ?? null),
    metadata: {
      source: "provider-transcript",
      sourceProvider: "claude",
      exchange: "local-only",
      exchangeReason: "provider-transcript",
      nativeSessionId: fileSessionId.toLowerCase(),
      sourceFormat: "claude-project-jsonl-v1",
      sourcePath: file.sourcePath,
      entrypoints: [...entrypoints].sort(),
      versions: [...versions].sort(),
      sourceWorkdirs: [...workdirs].sort(),
    },
    messages: normalizedMessages,
  };
}

function codexFilenameSessionId(relativePath: string): string {
  const match = path.basename(relativePath).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  if (!match) throw new CaptureFailure("provider_drift", "Codex rollout filename does not contain a native session UUID");
  return match[1].toLowerCase();
}

function codexMessageRole(value: unknown, line: number): MessageRole | null {
  const role = nonEmptyString(value, `Codex line ${line} message.role`);
  if (role === "user" || role === "assistant") return role;
  if (role === "developer" || role === "system" || role === "tool") return null;
  throw new CaptureFailure("provider_drift", `Codex line ${line} has an unsupported message role ${role}`);
}

function codexLineageUuid(value: unknown, context: string): string {
  const id = nonEmptyString(value, context);
  if (!UUID.test(id) || id !== id.toLowerCase()) {
    throw new CaptureFailure("provider_drift", `${context} must be a canonical lowercase UUID`);
  }
  return id;
}

function codexLineageParent(payload: Record<string, unknown>, line: number): string | null {
  if (payload.parent_thread_id === undefined || payload.parent_thread_id === null) return null;
  return codexLineageUuid(payload.parent_thread_id, `Codex line ${line} parent_thread_id`);
}

function validateCodexLineageMeta(
  payload: Record<string, unknown>,
  line: number,
): { id: string; parentSessionId: string | null } {
  const id = codexLineageUuid(payload.id, `Codex line ${line} session_meta.id`);
  if (payload.session_id !== undefined) {
    codexLineageUuid(payload.session_id, `Codex line ${line} session_meta.session_id`);
  }
  const parentSessionId = codexLineageParent(payload, line);
  if (payload.forked_from_id !== undefined && payload.forked_from_id !== null) {
    const forkedFrom = codexLineageUuid(
      payload.forked_from_id,
      `Codex line ${line} session_meta.forked_from_id`,
    );
    if (forkedFrom !== parentSessionId) {
      throw new CaptureFailure("provider_drift", `Codex line ${line} fork lineage conflicts`);
    }
  }
  return { id, parentSessionId };
}

function closeCodexLineage(progress: CodexCaptureProgress): void {
  if (progress.expectedParentSessionId !== null) {
    if (
      progress.lineageSessionIds.length !== 1 ||
      progress.ownerParentSessionId === null
    ) {
      throw new CaptureFailure(
        "provider_drift",
        "Codex rollout lineage terminates before its declared root",
      );
    }
    progress.lineageTruncated = true;
  }
  progress.lineageClosed = true;
  progress.expectedParentSessionId = null;
  if (progress.ownerParentSessionId === null) progress.ownerMessagesStarted = true;
}

function normalizeCodex(
  file: EvidenceFile,
  records: ParsedJsonLine[],
  limits: SessionCaptureLimits,
  seed: CaptureSessionSeed | null,
  sourceComplete: boolean,
): NormalizedDesktopSession | null {
  const nativeSessionId = codexFilenameSessionId(file.relativePath);
  const responseMessages: NormalizedSourceMessage[] = [];
  const models: string[] = [];
  const textualKinds = new Set(["text", "input_text", "output_text"]);
  let ownerMetadata: { line: ParsedJsonLine; payload: Record<string, unknown> } | null = null;
  const progress: CodexCaptureProgress = seed?.codexProgress
    ? structuredClone(seed.codexProgress)
    : {
        lineageSessionIds: [],
        ownerParentSessionId: null,
        expectedParentSessionId: null,
        lineageClosed: false,
        lineageTruncated: false,
        ownerMessagesStarted: false,
      };

  if (seed === null && records.length === 0) return null;
  if (
    seed === null &&
    (records[0]?.line !== 1 || optionalString(records[0]?.value.type) !== "session_meta")
  ) {
    throw new CaptureFailure(
      "provider_drift",
      "Codex rollout line 1 must be its owner session_meta",
    );
  }

  for (const record of records) {
    const type = optionalString(record.value.type);
    if (!progress.lineageClosed) {
      const nextLine = progress.lineageSessionIds.length + 1;
      if (record.line === nextLine && type === "session_meta") {
        const payload = plainRecord(record.value.payload, `Codex line ${record.line} payload`);
        const lineage = validateCodexLineageMeta(payload, record.line);
        if (progress.lineageSessionIds.length === 0) {
          if (lineage.id !== nativeSessionId) {
            throw new CaptureFailure(
              "provider_drift",
              "Codex rollout owner session_meta does not match its filename",
            );
          }
          ownerMetadata = { line: record, payload };
          progress.ownerParentSessionId = lineage.parentSessionId;
        } else {
          if (lineage.id !== progress.expectedParentSessionId) {
            throw new CaptureFailure(
              "provider_drift",
              "Codex rollout lineage is not linked to its declared parent",
            );
          }
          if (progress.lineageSessionIds.includes(lineage.id)) {
            throw new CaptureFailure("provider_drift", "Codex rollout lineage repeats or cycles");
          }
        }
        progress.lineageSessionIds.push(lineage.id);
        progress.expectedParentSessionId = lineage.parentSessionId;
        if (
          progress.lineageSessionIds.length >= MAX_CODEX_LINEAGE_DEPTH &&
          progress.expectedParentSessionId !== null
        ) {
          throw new CaptureFailure(
            "provider_drift",
            `Codex rollout lineage exceeds depth ${MAX_CODEX_LINEAGE_DEPTH}`,
          );
        }
        if (progress.expectedParentSessionId === null) closeCodexLineage(progress);
        continue;
      }
      closeCodexLineage(progress);
    }

    if (type === "session_meta") {
      throw new CaptureFailure(
        "provider_drift",
        "Codex rollout contains a non-contiguous session_meta",
      );
    }

    if (type === "inter_agent_communication_metadata") {
      const payload = plainRecord(record.value.payload, `Codex line ${record.line} payload`);
      if (typeof payload.trigger_turn !== "boolean") {
        throw new CaptureFailure(
          "provider_drift",
          `Codex line ${record.line} inter-agent trigger must be a boolean`,
        );
      }
      if (
        progress.ownerParentSessionId !== null &&
        !progress.ownerMessagesStarted &&
        payload.trigger_turn
      ) {
        progress.ownerMessagesStarted = true;
      }
      continue;
    }

    if (!progress.ownerMessagesStarted) continue;
    if (type === "turn_context") {
      const payload = plainRecord(record.value.payload, `Codex line ${record.line} payload`);
      const model = optionalString(payload.model);
      if (model && model !== "default") models.push(model);
      continue;
    }
    if (type === "response_item") {
      const payload = plainRecord(record.value.payload, `Codex line ${record.line} payload`);
      if (optionalString(payload.type) !== "message") continue;
      const role = codexMessageRole(payload.role, record.line);
      if (role === null) continue;
      const content = visibleText(payload.content, `Codex line ${record.line} message.content`, textualKinds);
      if (content === null) continue;
      const sourceRecordId =
        optionalString(payload.id) ?? `response-${record.line}-${record.digest.slice(0, 32)}`;
      const sourceTimestamp = normalizedTimestamp(record.value.timestamp, `Codex line ${record.line} timestamp`);
      responseMessages.push({ sourceLine: record.line, sourceRecordId, sourceTimestamp, message: { role, content } });
    }
  }

  if (!progress.lineageClosed && sourceComplete) closeCodexLineage(progress);
  if (seed !== null) {
    return {
      ...seed,
      codexProgress: progress,
      messages: deduplicateMessages(responseMessages, limits.maximumMessagesPerFile),
    };
  }
  if (ownerMetadata === null) {
    throw new CaptureFailure("provider_drift", "Codex rollout has no owner session_meta");
  }
  const createdAt = normalizedTimestamp(
    ownerMetadata.line.value.timestamp ?? ownerMetadata.payload.timestamp,
    `Codex line ${ownerMetadata.line.line} session timestamp`,
  );
  const messages = deduplicateMessages(responseMessages, limits.maximumMessagesPerFile);
  const originator = optionalString(ownerMetadata.payload.originator);
  const version = optionalString(ownerMetadata.payload.cli_version);
  const cwd = optionalString(ownerMetadata.payload.cwd);
  return {
    provider: "codex",
    nativeSessionId,
    sourceFormat: "codex-rollout-jsonl-v1",
    sourcePath: file.sourcePath,
    createdAt,
    model: normalizedModel(models[0] ?? null),
    metadata: {
      source: "provider-transcript",
      sourceProvider: "codex",
      exchange: "local-only",
      exchangeReason: "provider-transcript",
      nativeSessionId,
      sourceFormat: "codex-rollout-jsonl-v1",
      sourcePath: file.sourcePath,
      ...(originator ? { entrypoint: originator } : {}),
      ...(version ? { version } : {}),
      ...(cwd ? { sourceWorkdir: cwd } : {}),
    },
    messages,
    codexProgress: progress,
  };
}

function normalizeDesktopSession(
  file: EvidenceFile,
  records: ParsedJsonLine[],
  limits: SessionCaptureLimits,
  seed: CaptureSessionSeed | null,
  sourceComplete: boolean,
): NormalizedDesktopSession | null {
  if (file.provider === "codex") return normalizeCodex(file, records, limits, seed, sourceComplete);
  const normalized = normalizeClaude(file, records, limits);
  if (normalized !== null) return normalized;
  return seed === null ? null : { ...seed, messages: [] };
}

function sessionSeedFromNormalized(source: NormalizedDesktopSession): CaptureSessionSeed {
  return {
    provider: source.provider,
    nativeSessionId: source.nativeSessionId,
    sourceFormat: source.sourceFormat,
    sourcePath: source.sourcePath,
    createdAt: source.createdAt,
    model: source.model,
    metadata: structuredClone(source.metadata),
    ...(source.codexProgress
      ? { codexProgress: structuredClone(source.codexProgress) }
      : {}),
  };
}

function normalizedWithCheckpointSeed(
  source: NormalizedDesktopSession,
  seed: CaptureSessionSeed | null,
): NormalizedDesktopSession {
  if (seed === null) return source;
  if (
    source.provider !== seed.provider ||
    source.nativeSessionId !== seed.nativeSessionId ||
    source.sourceFormat !== seed.sourceFormat ||
    source.sourcePath !== seed.sourcePath
  ) {
    throw new CaptureFailure("provider_drift", "provider transcript identity changed between checkpoint pages");
  }
  return {
    ...seed,
    ...(source.codexProgress
      ? { codexProgress: structuredClone(source.codexProgress) }
      : {}),
    messages: source.messages,
  };
}

function descriptorFromExisting(state: SharedState, session: NonNullable<Awaited<ReturnType<typeof loadSessionState>>>): SessionDescriptor {
  return {
    sessionId: session.sessionId,
    provider: session.provider,
    model: session.model,
    mode: session.mode,
    workdir: session.workdir,
    stateDir: state.stateDir,
  };
}

function assertExistingSource(
  session: NonNullable<Awaited<ReturnType<typeof loadSessionState>>>,
  source: NormalizedDesktopSession,
): void {
  if (
    session.provider !== source.provider ||
    session.metadata.source !== "provider-transcript" ||
    session.metadata.sourceProvider !== source.provider ||
    session.metadata.nativeSessionId !== source.nativeSessionId ||
    session.metadata.sourceFormat !== source.sourceFormat ||
    session.metadata.exchange !== "local-only" ||
    session.metadata.exchangeReason !== "provider-transcript"
  ) {
    throw new CaptureFailure("canonical_collision", `canonical session id collision for ${source.nativeSessionId}`);
  }
}

async function ensureCanonicalSession(
  state: SharedState,
  source: NormalizedDesktopSession,
): Promise<{ descriptor: SessionDescriptor; created: boolean }> {
  const sessionId = canonicalSessionId(source.provider, source.nativeSessionId);
  const existing = await loadSessionState(state, sessionId);
  if (existing) {
    assertExistingSource(existing, source);
    return { descriptor: descriptorFromExisting(state, existing), created: false };
  }
  try {
    const descriptor = await createSession(state, {
      provider: source.provider,
      model: source.model,
      mode: "chat",
      workdir: state.root,
      sessionId,
      metadata: source.metadata,
      createdAt: source.createdAt,
    });
    return { descriptor, created: true };
  } catch (error) {
    if (!String(error).includes("session id collision")) throw error;
    const raced = await loadSessionState(state, sessionId);
    if (!raced) throw error;
    assertExistingSource(raced, source);
    return { descriptor: descriptorFromExisting(state, raced), created: false };
  }
}

function importedMessages(source: NormalizedDesktopSession): ImportedSessionMessage[] {
  return source.messages.map((item) => ({
    provider: source.provider,
    nativeSessionId: source.nativeSessionId,
    sourceFormat: source.sourceFormat,
    sourcePath: source.sourcePath,
    sourceRecordId: item.sourceRecordId,
    sourceTimestamp: item.sourceTimestamp,
    message: {
      ...item.message,
      metadata: {
        source: "provider-transcript",
        sourceProvider: source.provider,
        nativeSessionId: source.nativeSessionId,
        sourcePath: source.sourcePath,
        sourceRecordId: item.sourceRecordId,
        sourceTimestamp: item.sourceTimestamp,
      },
    },
  }));
}

function captureError(
  provider: DesktopSessionProvider,
  sourcePath: string | null,
  error: unknown,
): SessionCaptureError {
  const failure = error instanceof CaptureFailure ? error : null;
  return {
    provider,
    sourcePath,
    code: failure?.code ?? "capture_failed",
    message: failure?.message ?? (error as Error).message ?? String(error),
    retryable: failure?.retryable ?? false,
  };
}

function selectedProviders(input: DesktopSessionProvider[] | undefined): DesktopSessionProvider[] {
  const values = input ?? ["claude", "codex"];
  if (values.length === 0) throw new Error("at least one desktop session provider must be selected");
  const unique = [...new Set(values)];
  for (const provider of unique) {
    if (provider !== "claude" && provider !== "codex") throw new Error(`unsupported desktop session provider: ${provider}`);
  }
  return unique;
}

function rotateEvidenceFiles(
  files: EvidenceFile[],
  lastAttemptedFileKey: string | null,
): EvidenceFile[] {
  const sorted = [...files].sort((left, right) => cursorKey(left).localeCompare(cursorKey(right)));
  if (sorted.length === 0 || lastAttemptedFileKey === null) return sorted;
  const start = sorted.findIndex((file) => cursorKey(file) > lastAttemptedFileKey);
  const index = start < 0 ? 0 : start;
  return [...sorted.slice(index), ...sorted.slice(0, index)];
}

export async function reconcileDesktopSessions(
  state: SharedState,
  options: ReconcileDesktopSessionsOptions = {},
): Promise<SessionCaptureReport> {
  const limits = resolvedLimits(options.limits);
  const providers = selectedProviders(options.providers);
  const roots: Record<DesktopSessionProvider, string> = {
    claude: path.resolve(options.claudeRoot ?? path.join(state.userHome, ".claude", "projects")),
    codex: path.resolve(options.codexRoot ?? path.join(state.userHome, ".codex", "sessions")),
  };
  const now = options.now ?? (() => new Date());

  return withStateFileLock(state, "session-capture", async () => {
    const report = emptyReport();
    let cursor: CaptureCursor;
    try {
      cursor = await readCursor(state);
    } catch (error) {
      for (const provider of providers) report.errors.push(captureError(provider, null, error));
      report.failedFiles = providers.length;
      return report;
    }
    const budget: DiscoveryBudget = { scannedEntries: 0, files: 0 };
    const evidenceFiles: EvidenceFile[] = [];
    for (const provider of providers) {
      try {
        evidenceFiles.push(...(await discoverEvidenceFiles(provider, roots[provider], limits, budget)));
      } catch (error) {
        report.errors.push(captureError(provider, null, error));
        report.failedFiles += 1;
      }
    }

    const admissionBudget: AdmissionReadBudget = {
      maximumBytes: limits.maximumTotalBytes,
      usedBytes: 0,
    };
    for (const file of rotateEvidenceFiles(evidenceFiles, cursor.lastAttemptedFileKey)) {
      if (admissionBudget.usedBytes >= admissionBudget.maximumBytes) break;
      report.scannedFiles += 1;
      const key = cursorKey(file);
      const previous = cursor.files[key];
      try {
        const updatedAt = now().toISOString();
        const admitted = await admitJsonl(file, limits, previous, admissionBudget, updatedAt);
        const checkpoint = admitted.checkpoint;
        if (admitted.hasRemainingBytes) report.deferredFiles += 1;

        if (
          checkpoint.classification === "captured" &&
          checkpoint.canonicalSessionId !== null &&
          !(await physicalSessionExists(state, checkpoint.canonicalSessionId))
        ) {
          throw new CaptureFailure(
            "canonical_missing",
            `captured canonical session is missing: ${checkpoint.canonicalSessionId}`,
          );
        }

        const checkpointOnly =
          admitted.advancedBytes === 0 &&
          (previous === undefined ||
            !isCaptureCheckpoint(previous) ||
            previous.classification === "empty" ||
            (previous.canonicalSessionId !== null &&
              (await physicalSessionExists(state, previous.canonicalSessionId))));
        if (checkpointOnly && previous !== undefined && isCaptureCheckpoint(previous)) {
          cursor.files[key] = checkpoint;
          cursor.lastAttemptedFileKey = key;
          await writeCursor(state, cursor);
          report.skippedFiles += 1;
          continue;
        }

        const pageNormalized = normalizeDesktopSession(
          file,
          admitted.records,
          limits,
          checkpoint.sessionSeed,
          !admitted.hasRemainingBytes,
        );
        const normalized =
          pageNormalized === null
            ? null
            : normalizedWithCheckpointSeed(pageNormalized, checkpoint.sessionSeed);
        if (normalized !== null) {
          checkpoint.sessionSeed = sessionSeedFromNormalized(normalized);
          const nextVisibleMessages = checkpoint.visibleMessages + normalized.messages.length;
          if (nextVisibleMessages > limits.maximumMessagesPerFile) {
            throw new CaptureFailure(
              "file_limit",
              `provider transcript exceeds maximumMessagesPerFile ${limits.maximumMessagesPerFile}`,
            );
          }
          if (normalized.messages.length > 0) {
            const canonical = await ensureCanonicalSession(state, normalized);
            if (canonical.created) report.importedSessions += 1;
            else report.existingSessions += 1;
            const messages = await appendImportedSessionMessages(
              state,
              canonical.descriptor.sessionId,
              importedMessages(normalized),
            );
            report.importedMessages += messages.appended;
            report.existingMessages += messages.existing;
            checkpoint.visibleMessages = nextVisibleMessages;
            checkpoint.classification = "captured";
            checkpoint.nativeSessionId = normalized.nativeSessionId;
            checkpoint.canonicalSessionId = canonical.descriptor.sessionId;
          } else if (checkpoint.nativeSessionId === null) {
            checkpoint.nativeSessionId = normalized.nativeSessionId;
          }
        }

        cursor.files[key] = checkpoint;
        cursor.lastAttemptedFileKey = key;
        await writeCursor(state, cursor);
        if (admitted.advancedBytes > 0) report.reconciledFiles += 1;
        if (normalized === null || normalized.messages.length === 0) report.skippedFiles += 1;
      } catch (error) {
        const captured = captureError(file.provider, file.sourcePath, error);
        const exhaustedTotalBudget =
          captured.code === "scan_limit" &&
          captured.message.includes("maximumTotalBytes");
        if (!exhaustedTotalBudget) cursor.lastAttemptedFileKey = key;
        try {
          await writeCursor(state, cursor);
        } catch (cursorError) {
          const capturedCursorError = captureError(file.provider, file.sourcePath, cursorError);
          report.failedFiles += 1;
          report.errors.push(capturedCursorError);
          break;
        }
        if (captured.retryable) report.deferredFiles += 1;
        else report.failedFiles += 1;
        report.errors.push(captured);
        if (exhaustedTotalBudget) break;
      }
    }
    return report;
  });
}
