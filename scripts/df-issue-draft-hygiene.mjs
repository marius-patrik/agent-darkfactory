import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdir, open, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ISSUE_DRAFT_POLICY_PATH = ".darkfactory/issue-draft-policy.json";
export const ISSUE_DRAFT_DIRECTORY = path.join("runtime", "darkfactory", "drafts");
export const ISSUE_DRAFT_HYGIENE_DIRECTORY = path.join("runtime", "darkfactory", "draft-hygiene", "receipts");

const POLICY_KEYS = ["schemaVersion", "policyVersion", "reminderAfterHours", "expiryAfterHours", "maxDraftFiles", "maxDraftBytes"];
const LEGACY_STATE_KEYS = ["schemaVersion", "draftId", "repository", "createdAt", "updatedAt", "status", "initial", "current", "ownerQuestions", "blockers", "draftTurn", "review", "publication"];
const STATE_KEYS = ["schemaVersion", "draftId", "repository", "createdAt", "updatedAt", "status", "initial", "current", "ownerQuestions", "blockers", "draftTurns", "review", "publication"];
const DRAFT_TURN_KEYS = ["sequence", "kind", "inputVersion", "beforeDigest", "afterDigest", "ownerAnswers", "request", "prompt", "receipt"];
const DOCUMENT_KEYS = ["title", "body", "digest"];
const REVIEW_KEYS = ["targetVersion", "ok", "code", "rounds"];
const PUBLICATION_KEYS = ["approvedDigest", "issueNumber", "issueUrl", "issueVersion"];
const RESUME_RECEIPT_KEYS = ["schemaVersion", "policyVersion", "kind", "cycleId", "draftId", "repository", "reviewedDigest", "reviewTargetVersion", "reviewedAt", "requestedAt", "modelTokens"];
const HYGIENE_RECEIPT_KEYS = ["schemaVersion", "policyVersion", "kind", "cycleId", "draftId", "repository", "reviewedDigest", "reviewTargetVersion", "reviewedAt", "dueAt", "modelTokens"];
const SAFE_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_DRAFT_FILE = /^[A-Za-z0-9._-]{1,220}\.json$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DRAFT_ID = /^[0-9a-f]{32}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const MAX_CLOCK_SKEW_MS = 300_000;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected, context) {
  if (!isRecord(value)) throw new Error(`${context} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((entry, index) => entry !== wanted[index])) {
    throw new Error(`${context} must contain exactly: ${wanted.join(", ")}`);
  }
}

function positiveInteger(value, context) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${context} must be a positive integer`);
  return value;
}

function parseDate(value, context) {
  if (typeof value !== "string") throw new Error(`${context} must be an ISO timestamp`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) throw new Error(`${context} must be an exact ISO timestamp`);
  return parsed;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value.replace(/\r\n/g, "\n")).digest("hex");
}

function issueContentDigest(title, body) {
  return sha256(canonicalJson({ title: title.replace(/\r\n/g, "\n"), body: body.replace(/\r\n/g, "\n") }));
}

function issueVersion(title, body) {
  return sha256(JSON.stringify({ title, body, state: "open" }));
}

function validateDocument(value, context) {
  exactKeys(value, DOCUMENT_KEYS, context);
  if (typeof value.title !== "string" || !value.title.trim() || typeof value.body !== "string" || !value.body.trim() || !SHA256.test(String(value.digest))) {
    throw new Error(`${context} is malformed`);
  }
  if (Buffer.byteLength(value.title, "utf8") > 256 || Buffer.byteLength(value.body, "utf8") > 1_000_000) throw new Error(`${context} exceeds its byte bound`);
  if (issueContentDigest(value.title, value.body) !== value.digest) throw new Error(`${context} digest is invalid`);
}

export function validateIssueDraftPolicy(value) {
  exactKeys(value, POLICY_KEYS, "Issue draft hygiene policy");
  if (value.schemaVersion !== 1 || typeof value.policyVersion !== "string" || !SEMVER.test(value.policyVersion)) {
    throw new Error("Issue draft hygiene policy identity is invalid");
  }
  positiveInteger(value.reminderAfterHours, "Issue draft reminder threshold");
  positiveInteger(value.expiryAfterHours, "Issue draft expiry threshold");
  positiveInteger(value.maxDraftFiles, "Issue draft inventory bound");
  positiveInteger(value.maxDraftBytes, "Issue draft byte bound");
  if (value.expiryAfterHours <= value.reminderAfterHours) throw new Error("Issue draft expiry must follow the reminder threshold");
  if (value.maxDraftFiles > 10_000 || value.maxDraftBytes > 2_000_000) throw new Error("Issue draft hygiene bounds are unsafe");
  return Object.freeze({ ...value });
}

export async function readIssueDraftPolicy(controlRoot) {
  if (typeof controlRoot !== "string" || !path.isAbsolute(controlRoot)) throw new Error("Issue draft policy requires an absolute trusted control root");
  let raw;
  try {
    raw = JSON.parse(await readFile(path.join(controlRoot, ISSUE_DRAFT_POLICY_PATH), "utf8"));
  } catch (error) {
    throw new Error(`Issue draft hygiene policy is unavailable: ${error instanceof SyntaxError ? "invalid JSON" : "read failed"}`);
  }
  return validateIssueDraftPolicy(raw);
}

export function validateIssueDraftInventoryState(raw, now = new Date()) {
  exactKeys(raw, raw?.schemaVersion === 1 ? LEGACY_STATE_KEYS : STATE_KEYS, "Issue draft state");
  if (![1, 2].includes(raw.schemaVersion) || typeof raw.draftId !== "string" || !DRAFT_ID.test(raw.draftId) || typeof raw.repository !== "string" || !SAFE_REPOSITORY.test(raw.repository)) {
    throw new Error("Issue draft state identity is invalid");
  }
  if (!new Set(["drafted", "reviewed", "blocked", "published"]).has(raw.status)) throw new Error("Issue draft state status is invalid");
  const createdAt = parseDate(raw.createdAt, "Issue draft createdAt");
  const updatedAt = parseDate(raw.updatedAt, "Issue draft updatedAt");
  if (updatedAt < createdAt || updatedAt.valueOf() > now.valueOf() + MAX_CLOCK_SKEW_MS) throw new Error("Issue draft state chronology is invalid");
  validateDocument(raw.initial, "Issue draft initial document");
  validateDocument(raw.current, "Issue draft current document");
  const expectedMarker = `<!-- darkfactory:local-issue-draft id=${raw.draftId} -->`;
  if (!raw.initial.body.startsWith(expectedMarker) || !raw.current.body.startsWith(expectedMarker)) throw new Error("Issue draft document identity marker is invalid");
  for (const name of ["ownerQuestions", "blockers"]) {
    if (!Array.isArray(raw[name]) || raw[name].length > 200 || raw[name].some((entry) => typeof entry !== "string" || !entry.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(entry))) {
      throw new Error(`Issue draft ${name} is malformed`);
    }
  }
  if (raw.schemaVersion === 1) {
    exactKeys(raw.draftTurn, ["request", "prompt", "receipt"], "Issue draft turn evidence");
    if (!isRecord(raw.draftTurn.request) || !isRecord(raw.draftTurn.prompt) || !isRecord(raw.draftTurn.receipt)) throw new Error("Issue draft turn evidence is incomplete");
  } else {
    if (!Array.isArray(raw.draftTurns) || raw.draftTurns.length === 0 || raw.draftTurns.length > 200) throw new Error("Issue draft turn history is malformed");
    let previousDigest = null;
    for (const [index, turn] of raw.draftTurns.entries()) {
      exactKeys(turn, DRAFT_TURN_KEYS, `Issue draft turn ${index + 1}`);
      if (turn.sequence !== index + 1 || !["initial", "owner-continuation"].includes(turn.kind) || !SHA256.test(String(turn.afterDigest)) || !Array.isArray(turn.ownerAnswers) || turn.ownerAnswers.length > 200 || !isRecord(turn.request) || !isRecord(turn.prompt) || !isRecord(turn.receipt)) {
        throw new Error(`Issue draft turn ${index + 1} is malformed`);
      }
      for (const answer of turn.ownerAnswers) {
        exactKeys(answer, ["question", "answer"], `Issue draft turn ${index + 1} owner answer`);
        if (typeof answer.question !== "string" || !answer.question.trim() || typeof answer.answer !== "string" || !answer.answer.trim()) throw new Error(`Issue draft turn ${index + 1} owner answer is malformed`);
      }
      if (index === 0) {
        if (turn.kind !== "initial" || turn.inputVersion !== null || turn.beforeDigest !== null || turn.ownerAnswers.length !== 0 || turn.afterDigest !== raw.initial.digest) throw new Error("Issue draft initial turn is malformed");
      } else if (turn.kind !== "owner-continuation" || !SHA256.test(String(turn.inputVersion)) || !SHA256.test(String(turn.beforeDigest)) || turn.beforeDigest !== previousDigest || turn.ownerAnswers.length === 0) {
        throw new Error(`Issue draft turn ${index + 1} continuation is malformed`);
      }
      previousDigest = turn.afterDigest;
    }
  }
  if (raw.review !== null) {
    exactKeys(raw.review, REVIEW_KEYS, "Issue draft review");
    if (!SHA256.test(String(raw.review.targetVersion)) || typeof raw.review.ok !== "boolean" || (raw.review.code !== null && typeof raw.review.code !== "string") || !Array.isArray(raw.review.rounds) || raw.review.rounds.length > 200) {
      throw new Error("Issue draft review is malformed");
    }
    if (raw.review.targetVersion !== issueVersion(raw.current.title, raw.current.body)) throw new Error("Issue draft review targets stale content");
    if ((raw.review.ok && (raw.review.code !== null || raw.review.rounds.length < 2)) || (!raw.review.ok && (typeof raw.review.code !== "string" || !raw.review.code.trim()))) {
      throw new Error("Issue draft review outcome is inconsistent");
    }
  }
  if (raw.publication !== null) {
    exactKeys(raw.publication, PUBLICATION_KEYS, "Issue draft publication");
    if (!SHA256.test(String(raw.publication.approvedDigest)) || !SHA256.test(String(raw.publication.issueVersion)) || !Number.isSafeInteger(raw.publication.issueNumber) || raw.publication.issueNumber < 1 || typeof raw.publication.issueUrl !== "string" || !raw.publication.issueUrl.trim()) {
      throw new Error("Issue draft publication is malformed");
    }
  }
  if ((raw.status === "published") !== (raw.publication !== null)) throw new Error("Issue draft publication status is inconsistent");
  if (raw.status === "reviewed" && (raw.review?.ok !== true || raw.publication !== null)) throw new Error("Issue draft reviewed status is inconsistent");
  if (raw.status === "blocked" && raw.review !== null && raw.review?.ok !== false) throw new Error("Issue draft blocked status is inconsistent");
  if (raw.status === "drafted" && raw.review !== null) throw new Error("Issue draft drafted status is inconsistent");
  return structuredClone(raw);
}

function reviewedLifecycle(state, policy, now) {
  if (state.status !== "reviewed" || state.review?.ok !== true) return null;
  const reviewedAt = parseDate(state.updatedAt, "Issue draft reviewedAt");
  const ageMs = now.valueOf() - reviewedAt.valueOf();
  if (ageMs < -MAX_CLOCK_SKEW_MS) throw new Error("Issue draft review is from the future");
  const reminderDue = new Date(reviewedAt.valueOf() + policy.reminderAfterHours * 3_600_000);
  const expiryDue = new Date(reviewedAt.valueOf() + policy.expiryAfterHours * 3_600_000);
  const cycleId = sha256(canonicalJson({
    policyVersion: policy.policyVersion,
    draftId: state.draftId,
    repository: state.repository.toLowerCase(),
    reviewedDigest: state.current.digest,
    reviewTargetVersion: state.review.targetVersion,
    reviewedAt: state.updatedAt
  })).slice(0, 32);
  return Object.freeze({ reviewedAt, ageMs, reminderDue, expiryDue, cycleId });
}

export function issueDraftFreshness(state, policy, now = new Date()) {
  const validatedPolicy = validateIssueDraftPolicy(policy);
  const validatedState = validateIssueDraftInventoryState(state, now);
  const lifecycle = reviewedLifecycle(validatedState, validatedPolicy, now);
  if (!lifecycle) return Object.freeze({ state: validatedState.status, publicationEligible: false, resumeRequired: false, reminderDueAt: null, expiresAt: null });
  const expired = now.valueOf() >= lifecycle.expiryDue.valueOf();
  const reminderDue = now.valueOf() >= lifecycle.reminderDue.valueOf();
  return Object.freeze({
    state: expired ? "expired" : reminderDue ? "reminder-due" : "fresh",
    publicationEligible: !expired,
    resumeRequired: expired,
    reminderDueAt: lifecycle.reminderDue.toISOString(),
    expiresAt: lifecycle.expiryDue.toISOString(),
    cycleId: lifecycle.cycleId
  });
}

export function assertIssueDraftPublicationFresh(state, policy, now = new Date()) {
  const freshness = issueDraftFreshness(state, policy, now);
  if (freshness.resumeRequired) {
    throw new Error(`Issue draft review expired at ${freshness.expiresAt}; run an explicit owner resume and complete a fresh high confirmation before publication`);
  }
  if (!freshness.publicationEligible) throw new Error("Issue draft is not publication-eligible");
  return freshness;
}

async function existingDirectoryRealPath(directory, label) {
  let stats;
  try {
    stats = await lstat(directory);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return null;
    throw new Error(`${label} cannot be inspected`);
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`${label} must be a real directory, not a link`);
  return await realpath(directory);
}

function assertContained(parent, child, label) {
  const relative = path.relative(parent, child);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label} does not resolve beneath canonical ANDROMEDA_HOME`);
}

async function ensurePrivateDirectory(root, segments) {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const stats = await lstat(current);
      if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("Issue draft hygiene receipt authority contains a non-directory or link");
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
  return current;
}

async function readJsonFile(file, maximumBytes, context) {
  const stats = await lstat(file);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > maximumBytes) throw new Error(`${context} is not one bounded regular file`);
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`${context} contains invalid JSON`);
  }
}

async function writeExactReceipt(receiptRoot, receipt, expectedKeys) {
  exactKeys(receipt, expectedKeys, "Issue draft hygiene receipt");
  const directory = await ensurePrivateDirectory(receiptRoot, [receipt.draftId]);
  const receiptPath = path.join(directory, `${receipt.cycleId}-${receipt.kind}.json`);
  const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
  try {
    const handle = await open(receiptPath, "wx", 0o600);
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    if (!isRecord(error) || error.code !== "EEXIST") throw new Error("Issue draft hygiene receipt could not be recorded");
    const existing = await readJsonFile(receiptPath, 16_384, "Existing issue draft hygiene receipt");
    exactKeys(existing, expectedKeys, "Existing issue draft hygiene receipt");
    if (canonicalJson(existing) !== canonicalJson(receipt)) throw new Error("Existing issue draft hygiene receipt conflicts with the exact lifecycle identity");
    return false;
  }
}

async function canonicalAgentsHome(agentsHome) {
  if (typeof agentsHome !== "string" || !path.isAbsolute(agentsHome)) throw new Error("Issue draft hygiene requires absolute canonical ANDROMEDA_HOME");
  const resolved = await existingDirectoryRealPath(path.resolve(agentsHome), "Canonical ANDROMEDA_HOME");
  if (!resolved) throw new Error("Canonical ANDROMEDA_HOME is unavailable");
  return resolved;
}

async function inventoryDrafts(agentsHome, policy, now) {
  const draftRoot = path.join(agentsHome, ISSUE_DRAFT_DIRECTORY);
  const resolvedDraftRoot = await existingDirectoryRealPath(draftRoot, "Canonical issue draft directory");
  if (!resolvedDraftRoot) return [];
  assertContained(agentsHome, resolvedDraftRoot, "Canonical issue draft directory");
  const entries = await readdir(resolvedDraftRoot, { withFileTypes: true });
  if (entries.length > policy.maxDraftFiles) throw new Error("Issue draft inventory exceeds its versioned file bound");
  const states = [];
  const identities = new Set();
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || entry.isSymbolicLink() || !SAFE_DRAFT_FILE.test(entry.name)) {
      throw new Error(`Issue draft inventory contains an ambiguous entry: ${entry.name}`);
    }
    const state = validateIssueDraftInventoryState(await readJsonFile(path.join(resolvedDraftRoot, entry.name), policy.maxDraftBytes, `Issue draft ${entry.name}`), now);
    if (identities.has(state.draftId)) throw new Error(`Issue draft inventory contains duplicate identity ${state.draftId}`);
    identities.add(state.draftId);
    states.push(state);
  }
  return states.sort((left, right) => left.draftId.localeCompare(right.draftId));
}

function hygieneReceipt(kind, state, lifecycle, policy, dueAt) {
  return Object.freeze({
    schemaVersion: 1,
    policyVersion: policy.policyVersion,
    kind,
    cycleId: lifecycle.cycleId,
    draftId: state.draftId,
    repository: state.repository,
    reviewedDigest: state.current.digest,
    reviewTargetVersion: state.review.targetVersion,
    reviewedAt: state.updatedAt,
    dueAt: dueAt.toISOString(),
    modelTokens: 0
  });
}

export async function maintainIssueDraftInventory({ agentsHome, controlRoot, now = new Date() }) {
  if (!(now instanceof Date) || !Number.isFinite(now.valueOf())) throw new Error("Issue draft hygiene requires a valid observation time");
  const [canonicalHome, policy] = await Promise.all([canonicalAgentsHome(agentsHome), readIssueDraftPolicy(controlRoot)]);
  const states = await inventoryDrafts(canonicalHome, policy, now);
  const receiptRoot = await ensurePrivateDirectory(canonicalHome, ["runtime", "darkfactory", "draft-hygiene", "receipts"]);
  const drafts = [];
  let newReceipts = 0;
  for (const state of states) {
    const lifecycle = reviewedLifecycle(state, policy, now);
    if (!lifecycle) {
      drafts.push({ draftId: state.draftId, repository: state.repository, status: state.status, action: "none", ownerAction: null });
      continue;
    }
    const reminderDue = now.valueOf() >= lifecycle.reminderDue.valueOf();
    const expired = now.valueOf() >= lifecycle.expiryDue.valueOf();
    if (reminderDue) {
      if (await writeExactReceipt(receiptRoot, hygieneReceipt("owner-reminder", state, lifecycle, policy, lifecycle.reminderDue), HYGIENE_RECEIPT_KEYS)) newReceipts += 1;
    }
    if (expired) {
      if (await writeExactReceipt(receiptRoot, hygieneReceipt("review-expired", state, lifecycle, policy, lifecycle.expiryDue), HYGIENE_RECEIPT_KEYS)) newReceipts += 1;
    }
    drafts.push({
      draftId: state.draftId,
      repository: state.repository,
      status: expired ? "expired" : reminderDue ? "reminder-due" : "reviewed",
      action: expired ? "owner-resume-required" : reminderDue ? "owner-reminder" : "none",
      reviewedDigest: state.current.digest,
      reminderDueAt: lifecycle.reminderDue.toISOString(),
      expiresAt: lifecycle.expiryDue.toISOString(),
      ownerAction: expired ? "Run df issue draft --draft <local-draft> --resume; publish only after the fresh high confirmation." : reminderDue ? "Publish the exact reviewed digest or explicitly resume after expiry." : null
    });
  }
  const report = Object.freeze({
    schemaVersion: 1,
    policyVersion: policy.policyVersion,
    status: "complete",
    observedAt: now.toISOString(),
    inventory: Object.freeze({ total: states.length, reviewed: drafts.filter((draft) => ["reviewed", "reminder-due", "expired"].includes(draft.status)).length }),
    reminders: drafts.filter((draft) => draft.action === "owner-reminder").length,
    expired: drafts.filter((draft) => draft.action === "owner-resume-required").length,
    newReceipts,
    modelTokens: 0,
    sanitized: true,
    drafts: Object.freeze(drafts)
  });
  const serialized = JSON.stringify(report);
  if (serialized.includes(canonicalHome) || /"(?:title|body|statePath|draftPath|environment|secret)"\s*:/.test(serialized)) {
    throw new Error("Issue draft hygiene report failed its sanitization boundary");
  }
  return report;
}

export async function recordIssueDraftOwnerResume({ agentsHome, state, policy, now = new Date() }) {
  const canonicalHome = await canonicalAgentsHome(agentsHome);
  const validatedPolicy = validateIssueDraftPolicy(policy);
  const validatedState = validateIssueDraftInventoryState(state, now);
  const lifecycle = reviewedLifecycle(validatedState, validatedPolicy, now);
  if (!lifecycle || now.valueOf() < lifecycle.expiryDue.valueOf()) throw new Error("Owner resume is admitted only for an expired reviewed issue draft");
  const receiptRoot = await ensurePrivateDirectory(canonicalHome, ["runtime", "darkfactory", "draft-hygiene", "receipts"]);
  const receiptDirectory = await ensurePrivateDirectory(receiptRoot, [validatedState.draftId]);
  const receipt = Object.freeze({
    schemaVersion: 1,
    policyVersion: validatedPolicy.policyVersion,
    kind: "owner-resume",
    cycleId: lifecycle.cycleId,
    draftId: validatedState.draftId,
    repository: validatedState.repository,
    reviewedDigest: validatedState.current.digest,
    reviewTargetVersion: validatedState.review.targetVersion,
    reviewedAt: validatedState.updatedAt,
    requestedAt: now.toISOString(),
    modelTokens: 0
  });
  const receiptPath = path.join(receiptDirectory, `${receipt.cycleId}-${receipt.kind}.json`);
  try {
    const existing = await readJsonFile(receiptPath, 16_384, "Existing owner-resume receipt");
    exactKeys(existing, RESUME_RECEIPT_KEYS, "Existing owner-resume receipt");
    const stableKeys = RESUME_RECEIPT_KEYS.filter((key) => key !== "requestedAt");
    if (stableKeys.some((key) => canonicalJson(existing[key]) !== canonicalJson(receipt[key]))) {
      throw new Error("Existing owner-resume receipt conflicts with the exact lifecycle identity");
    }
    const requestedAt = parseDate(existing.requestedAt, "Existing owner-resume requestedAt");
    if (requestedAt < lifecycle.expiryDue || requestedAt.valueOf() > now.valueOf() + MAX_CLOCK_SKEW_MS) throw new Error("Existing owner-resume receipt chronology is invalid");
    return existing;
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") throw error;
  }
  await writeExactReceipt(receiptRoot, receipt, RESUME_RECEIPT_KEYS);
  return receipt;
}

function sanitizedFailure(error, agentsHome) {
  const raw = error instanceof Error ? error.message : "Unknown issue draft hygiene failure";
  return typeof agentsHome === "string" && agentsHome ? raw.replaceAll(path.resolve(agentsHome), "$ANDROMEDA_HOME") : raw;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  const controlRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
  try {
    await access(controlRoot, fsConstants.R_OK);
    const report = await maintainIssueDraftInventory({ agentsHome: process.env.ANDROMEDA_HOME || "", controlRoot });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, status: "blocked", code: "draft_hygiene_blocked", message: sanitizedFailure(error, process.env.ANDROMEDA_HOME || ""), modelTokens: 0, sanitized: true }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
