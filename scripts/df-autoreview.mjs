import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  modelRequestForPurpose,
  validateAgentExecutionReceipt,
  validateModelPolicy
} from "./df-model-policy.mjs";
import { validatePromptProvenance } from "../../src/model-turn.ts";

export const AUTOREVIEW_POLICY_PATH = ".agents/autoreview-policy.json";
export const AUTOREVIEW_SCHEMA_PATH = ".github/darkfactory-autoreview.schema.json";
export const AUTOREVIEW_CHECK_NAME = "DarkFactory Autoreview";

const BLOCK_CODES = new Set([
  "automation_failure",
  "exhausted_medium_rounds",
  "exhausted_high_rounds",
  "fix_no_change",
  "malformed_fix",
  "malformed_verdict",
  "provider_route_blocked",
  "receipt_persistence_failed",
  "stale_target",
  "target_policy_blocked"
]);
const SAFE_RELATIVE_PATH = /^(?![A-Za-z]:)(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._@+ -]+(?:\/[A-Za-z0-9._@+ -]+)*$/;
const SAFE_CODE = /^[a-z][a-z0-9_-]{0,63}$/;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const WINDOWS_RESERVED_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected, context) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${context} must contain exactly: ${wanted.join(", ")}`);
  }
}

function boundedInteger(value, min, max, context) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${context} must be an integer from ${min} through ${max}`);
  }
  return value;
}

function boundedText(value, maxBytes, context, allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || CONTROL_CHARS.test(value)) {
    throw new Error(`${context} must be safe text`);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) throw new Error(`${context} exceeds its byte limit`);
  return value.trim();
}

function safeRelativePath(value) {
  if (!SAFE_RELATIVE_PATH.test(value)) return false;
  return value.split("/").every((segment) =>
    segment.length > 0 &&
    !/[. ]$/.test(segment) &&
    !WINDOWS_RESERVED_SEGMENT.test(segment) &&
    segment.toLowerCase() !== ".git"
  );
}

function canonicalFindingInput(finding) {
  return JSON.stringify({
    title: finding.title,
    details: finding.details,
    path: finding.path,
    line: finding.line
  });
}

function findingId(finding) {
  return `df-${createHash("sha256").update(canonicalFindingInput(finding)).digest("hex").slice(0, 20)}`;
}

export function validateAutoreviewPolicy(raw) {
  if (!isRecord(raw)) throw new Error("DarkFactory Autoreview policy must be an object");
  exactKeys(
    raw,
    ["schemaVersion", "promptVersion", "roundBudgets", "limits", "protectedAutofixPaths"],
    "DarkFactory Autoreview policy"
  );
  if (raw.schemaVersion !== 1) throw new Error("DarkFactory Autoreview policy schemaVersion must be 1");
  const promptVersion = boundedText(raw.promptVersion, 128, "Autoreview promptVersion");
  if (!SAFE_CODE.test(promptVersion)) throw new Error("Autoreview promptVersion must be a stable code");

  if (!isRecord(raw.roundBudgets)) throw new Error("Autoreview roundBudgets must be an object");
  exactKeys(raw.roundBudgets, ["medium", "high"], "Autoreview roundBudgets");
  const roundBudgets = Object.freeze({
    medium: boundedInteger(raw.roundBudgets.medium, 1, 12, "medium round budget"),
    high: boundedInteger(raw.roundBudgets.high, 1, 8, "high round budget")
  });

  if (!isRecord(raw.limits)) throw new Error("Autoreview limits must be an object");
  const limitKeys = [
    "summaryBytes",
    "findingCount",
    "findingBytes",
    "nonBlockingNoteCount",
    "targetContextBytes",
    "changeCount",
    "changedFileBytes"
  ];
  exactKeys(raw.limits, limitKeys, "Autoreview limits");
  const limits = Object.freeze({
    summaryBytes: boundedInteger(raw.limits.summaryBytes, 1, 64000, "summaryBytes"),
    findingCount: boundedInteger(raw.limits.findingCount, 1, 500, "findingCount"),
    findingBytes: boundedInteger(raw.limits.findingBytes, 1, 64000, "findingBytes"),
    nonBlockingNoteCount: boundedInteger(raw.limits.nonBlockingNoteCount, 0, 500, "nonBlockingNoteCount"),
    targetContextBytes: boundedInteger(raw.limits.targetContextBytes, 1024, 1000000, "targetContextBytes"),
    changeCount: boundedInteger(raw.limits.changeCount, 1, 500, "changeCount"),
    changedFileBytes: boundedInteger(raw.limits.changedFileBytes, 1, 5000000, "changedFileBytes")
  });

  if (!Array.isArray(raw.protectedAutofixPaths) || raw.protectedAutofixPaths.length < 1) {
    throw new Error("Autoreview protectedAutofixPaths must be a non-empty array");
  }
  const protectedAutofixPaths = [...new Set(raw.protectedAutofixPaths.map((entry, index) => {
    const value = boundedText(entry, 256, `protectedAutofixPaths[${index}]`);
    const normalized = value.replace(/\\/g, "/");
    const candidate = normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
    if (!safeRelativePath(candidate)) throw new Error(`protectedAutofixPaths[${index}] is unsafe`);
    return normalized;
  }))].sort();

  return Object.freeze({
    schemaVersion: 1,
    promptVersion,
    roundBudgets,
    limits,
    protectedAutofixPaths: Object.freeze(protectedAutofixPaths)
  });
}

export async function loadAutoreviewPolicy(controlRoot) {
  const source = await readFile(path.join(controlRoot, AUTOREVIEW_POLICY_PATH), "utf8");
  return validateAutoreviewPolicy(JSON.parse(source));
}

function normalizeFinding(raw, policy, index) {
  if (!isRecord(raw)) throw new Error(`blockingFindings[${index}] must be an object`);
  exactKeys(raw, ["title", "details", "path", "line"], `blockingFindings[${index}]`);
  const title = boundedText(raw.title, policy.limits.findingBytes, `blockingFindings[${index}].title`);
  const details = boundedText(raw.details, policy.limits.findingBytes, `blockingFindings[${index}].details`);
  let findingPath = null;
  if (raw.path !== null) {
    findingPath = boundedText(raw.path, 512, `blockingFindings[${index}].path`).replace(/\\/g, "/");
    if (!safeRelativePath(findingPath)) throw new Error(`blockingFindings[${index}].path is unsafe`);
  }
  if (raw.line !== null && (!Number.isSafeInteger(raw.line) || raw.line < 1)) {
    throw new Error(`blockingFindings[${index}].line is invalid`);
  }
  const finding = { title, details, path: findingPath, line: raw.line };
  return Object.freeze({ id: findingId(finding), ...finding });
}

export function normalizeAutoreviewVerdict(raw, policyInput) {
  const policy = validateAutoreviewPolicy(policyInput);
  if (!isRecord(raw)) throw new Error("Autoreview verdict must be an object");
  exactKeys(
    raw,
    ["schemaVersion", "approved", "summary", "findingsComplete", "blockingFindings", "nonBlockingNotes"],
    "Autoreview verdict"
  );
  if (raw.schemaVersion !== 1) throw new Error("Autoreview verdict schemaVersion must be 1");
  if (typeof raw.approved !== "boolean") throw new Error("Autoreview verdict approved must be boolean");
  if (raw.findingsComplete !== true) throw new Error("Autoreview verdict must explicitly confirm complete finding extraction");
  const summary = boundedText(raw.summary, policy.limits.summaryBytes, "Autoreview verdict summary");
  if (!Array.isArray(raw.blockingFindings) || raw.blockingFindings.length > policy.limits.findingCount) {
    throw new Error("Autoreview verdict blockingFindings is invalid");
  }
  const uniqueFindings = new Map();
  raw.blockingFindings.forEach((entry, index) => {
    const normalized = normalizeFinding(entry, policy, index);
    if (!uniqueFindings.has(normalized.id)) uniqueFindings.set(normalized.id, normalized);
  });
  const blockingFindings = Object.freeze([...uniqueFindings.values()]);
  if (!Array.isArray(raw.nonBlockingNotes) || raw.nonBlockingNotes.length > policy.limits.nonBlockingNoteCount) {
    throw new Error("Autoreview verdict nonBlockingNotes is invalid");
  }
  const nonBlockingNotes = Object.freeze(raw.nonBlockingNotes.map((note, index) =>
    boundedText(note, policy.limits.findingBytes, `nonBlockingNotes[${index}]`)
  ));
  if (raw.approved !== (blockingFindings.length === 0)) {
    throw new Error("Autoreview verdict approval must exactly match the complete blocking finding set");
  }
  return Object.freeze({
    schemaVersion: 1,
    approved: raw.approved,
    summary,
    findingsComplete: true,
    blockingFindings,
    nonBlockingNotes
  });
}

function pathIsProtected(filePath, policy) {
  const folded = filePath.toLowerCase();
  const baseName = folded.slice(folded.lastIndexOf("/") + 1);
  return policy.protectedAutofixPaths.some((protectedPath) => {
    const protectedFolded = protectedPath.toLowerCase();
    if (protectedFolded.endsWith("/")) return folded.startsWith(protectedFolded);
    if (!protectedFolded.includes("/")) return baseName === protectedFolded;
    return folded === protectedFolded;
  });
}

function canonicalBase64(value) {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error("Autofix content must be canonical base64");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new Error("Autofix content must be canonical base64");
  return decoded;
}

function indexAutofixDeniedPaths(rawDeniedPaths) {
  if (!Array.isArray(rawDeniedPaths)) throw new Error("Autofix denied path list must be an array");
  const deniedByFoldedPath = new Map();
  rawDeniedPaths.forEach((rawPath, index) => {
    const filePath = boundedText(rawPath, 512, `Autofix denied path ${index}`).replace(/\\/g, "/");
    if (!safeRelativePath(filePath)) throw new Error(`Autofix denied path ${index} is unsafe`);
    const foldedPath = filePath.toLowerCase();
    if (deniedByFoldedPath.has(foldedPath)) throw new Error(`Autofix denied paths repeat or case-collide at ${filePath}`);
    deniedByFoldedPath.set(foldedPath, filePath);
  });
  return deniedByFoldedPath;
}

function deniedAutofixRoot(deniedByFoldedPath, filePath) {
  const foldedPath = filePath.toLowerCase();
  for (const [foldedRoot, deniedRoot] of deniedByFoldedPath) {
    if (foldedPath === foldedRoot || foldedPath.startsWith(`${foldedRoot}/`)) return deniedRoot;
  }
  return null;
}

export function assertAutofixPathsEligible(filePaths, rawDeniedPaths) {
  if (!Array.isArray(filePaths)) throw new Error("Autofix candidate paths must be an array");
  const deniedByFoldedPath = indexAutofixDeniedPaths(rawDeniedPaths);
  for (const [index, rawPath] of filePaths.entries()) {
    const filePath = boundedText(rawPath, 512, `Autofix candidate path ${index}`).replace(/\\/g, "/");
    if (!safeRelativePath(filePath)) throw new Error(`Autofix candidate path ${index} is unsafe`);
    if (deniedAutofixRoot(deniedByFoldedPath, filePath)) {
      throw new Error(`Autofix cannot modify ineligible changed path ${filePath}`);
    }
  }
}

export function validateAutofixProposal(raw, snapshotFiles, policyInput, rawDeniedPaths = []) {
  const policy = validateAutoreviewPolicy(policyInput);
  if (!isRecord(raw)) throw new Error("Autofix proposal must be an object");
  exactKeys(raw, ["schemaVersion", "summary", "changes"], "Autofix proposal");
  if (raw.schemaVersion !== 1) throw new Error("Autofix proposal schemaVersion must be 1");
  const summary = boundedText(raw.summary, policy.limits.summaryBytes, "Autofix proposal summary");
  if (!isRecord(snapshotFiles)) throw new Error("Autofix snapshot file map must be an object");
  if (!Array.isArray(raw.changes) || raw.changes.length < 1 || raw.changes.length > policy.limits.changeCount) {
    throw new Error("Autofix proposal changes are invalid");
  }
  const snapshotByFoldedPath = new Map();
  for (const [snapshotPath, snapshot] of Object.entries(snapshotFiles)) {
    const folded = snapshotPath.toLowerCase();
    if (snapshotByFoldedPath.has(folded)) throw new Error(`Autofix snapshot contains a case-colliding path ${snapshotPath}`);
    snapshotByFoldedPath.set(folded, { path: snapshotPath, snapshot });
  }
  const deniedByFoldedPath = indexAutofixDeniedPaths(rawDeniedPaths);
  const seen = new Set();
  const changes = raw.changes.map((change, index) => {
    if (!isRecord(change)) throw new Error(`Autofix change ${index} must be an object`);
    exactKeys(change, ["path", "expectedSha256", "contentBase64"], `Autofix change ${index}`);
    const filePath = boundedText(change.path, 512, `Autofix change ${index} path`).replace(/\\/g, "/");
    if (!safeRelativePath(filePath)) {
      throw new Error(`Autofix change ${index} path is unsafe`);
    }
    const foldedPath = filePath.toLowerCase();
    if (seen.has(foldedPath)) throw new Error(`Autofix proposal repeats or case-collides path ${filePath}`);
    seen.add(foldedPath);
    if (deniedAutofixRoot(deniedByFoldedPath, filePath)) throw new Error(`Autofix cannot modify ineligible changed path ${filePath}`);
    if (pathIsProtected(filePath, policy)) throw new Error(`Autofix cannot modify protected path ${filePath}`);
    const snapshotEvidence = snapshotByFoldedPath.get(foldedPath) ?? null;
    if (snapshotEvidence && snapshotEvidence.path !== filePath) {
      throw new Error(`Autofix change ${index} path case does not match the reviewed file version`);
    }
    const snapshot = snapshotEvidence?.snapshot ?? null;
    if (snapshot !== null && (!isRecord(snapshot) || typeof snapshot.sha256 !== "string")) {
      throw new Error(`Autofix snapshot evidence for ${filePath} is malformed`);
    }
    if (snapshot?.isTest === true) throw new Error(`Autofix cannot rewrite an existing test file ${filePath}`);
    const expectedSha256 = boundedText(change.expectedSha256, 64, `Autofix change ${index} expectedSha256`);
    if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error(`Autofix change ${index} expectedSha256 is invalid`);
    const expected = snapshot?.sha256 ?? "0".repeat(64);
    if (expectedSha256 !== expected) throw new Error(`Autofix change ${index} does not match the reviewed file version`);
    const content = canonicalBase64(change.contentBase64);
    if (content.length > policy.limits.changedFileBytes) throw new Error(`Autofix change ${index} content exceeds its byte limit`);
    let decoded;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      throw new Error(`Autofix change ${index} content must be UTF-8 text`);
    }
    if (CONTROL_CHARS.test(decoded)) throw new Error(`Autofix change ${index} content must be safe text`);
    return Object.freeze({ path: filePath, expectedSha256, content });
  });
  return Object.freeze({ schemaVersion: 1, summary, changes: Object.freeze(changes) });
}

export function validateTargetSnapshot(raw) {
  if (!isRecord(raw)) throw new Error("Autoreview target snapshot must be an object");
  if (!new Set(["pull_request", "issue"]).has(raw.kind)) throw new Error("Autoreview target kind is invalid");
  if (typeof raw.repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw.repository)) {
    throw new Error("Autoreview target repository is invalid");
  }
  if (!Number.isSafeInteger(raw.number) || raw.number < 1) throw new Error("Autoreview target number is invalid");
  if (typeof raw.version !== "string" || !/^[A-Za-z0-9:_.-]{1,160}$/.test(raw.version)) {
    throw new Error("Autoreview target version is invalid");
  }
  return raw;
}

function stableBlockCode(error, fallback) {
  const candidate = isRecord(error) && typeof error.code === "string" ? error.code : "";
  return BLOCK_CODES.has(candidate) ? candidate : fallback;
}

function blockedResult(code, rounds, details = null) {
  return Object.freeze({
    schemaVersion: 1,
    ok: false,
    state: "blocked",
    code,
    details,
    rounds: Object.freeze([...rounds])
  });
}

function successfulResult(rounds, snapshot) {
  return Object.freeze({
    schemaVersion: 1,
    ok: true,
    state: "clean",
    code: null,
    targetVersion: snapshot.version,
    rounds: Object.freeze([...rounds])
  });
}

async function persistRound(record, round, rounds) {
  try {
    await record(round);
  } catch (error) {
    return blockedResult("receipt_persistence_failed", rounds, stableBlockCode(error, "receipt_persistence_failed"));
  }
  rounds.push(Object.freeze(round));
  return null;
}

function validateTurnResult(raw, request, policy) {
  if (!isRecord(raw)) throw new Error("Autoreview turn result must be an object");
  exactKeys(raw, ["verdict", "receipt", "prompt"], "Autoreview review turn result");
  const prompt = validatePromptProvenance(raw.prompt);
  let receipt;
  try {
    receipt = validateAgentExecutionReceipt(raw.receipt, request, { allowBlocked: true });
  } catch (error) {
    error.prompt = prompt;
    throw error;
  }
  if (prompt.selection.modelTier !== request.modelTier || prompt.selection.effort !== request.effort) {
    const error = new Error("Autoreview prompt provenance does not match the authorized model request");
    error.code = "malformed_verdict";
    error.prompt = prompt;
    error.receipt = receipt;
    throw error;
  }
  if (receipt.outcome !== "success") {
    const error = new Error("Canonical Agent OS route was blocked");
    error.code = "provider_route_blocked";
    error.receipt = receipt;
    error.prompt = prompt;
    throw error;
  }
  try {
    return {
      verdict: normalizeAutoreviewVerdict(raw.verdict, policy),
      receipt,
      prompt
    };
  } catch (error) {
    error.receipt = receipt;
    error.prompt = prompt;
    throw error;
  }
}

function validateFixResult(raw, request, beforeVersion) {
  if (!isRecord(raw)) throw new Error("Autoreview fix turn result must be an object");
  exactKeys(raw, ["beforeVersion", "afterVersion", "changeRef", "receipt", "prompt"], "Autoreview fix turn result");
  const prompt = validatePromptProvenance(raw.prompt);
  if (raw.beforeVersion !== beforeVersion) {
    const error = new Error("Autoreview fix used a stale target version");
    error.code = "stale_target";
    error.prompt = prompt;
    throw error;
  }
  if (typeof raw.afterVersion !== "string" || raw.afterVersion === beforeVersion) {
    const error = new Error("Autoreview fix did not produce a new target version");
    error.code = "fix_no_change";
    error.prompt = prompt;
    throw error;
  }
  if (typeof raw.changeRef !== "string" || !raw.changeRef.trim() || CONTROL_CHARS.test(raw.changeRef)) {
    const error = new Error("Autoreview fix change reference is malformed");
    error.code = "malformed_fix";
    error.prompt = prompt;
    throw error;
  }
  let receipt;
  try {
    receipt = validateAgentExecutionReceipt(raw.receipt, request, { allowBlocked: true });
  } catch (error) {
    error.prompt = prompt;
    throw error;
  }
  if (prompt.selection.modelTier !== request.modelTier || prompt.selection.effort !== request.effort) {
    const error = new Error("Autoreview autofix prompt provenance does not match the authorized model request");
    error.code = "malformed_fix";
    error.prompt = prompt;
    error.receipt = receipt;
    throw error;
  }
  if (receipt.outcome !== "success") {
    const error = new Error("Canonical Agent OS autofix route was blocked");
    error.code = "provider_route_blocked";
    error.receipt = receipt;
    error.prompt = prompt;
    throw error;
  }
  return Object.freeze({
    beforeVersion: raw.beforeVersion,
    afterVersion: raw.afterVersion,
    changeRef: raw.changeRef.trim(),
    receipt,
    prompt
  });
}

export async function runAutoreview(options) {
  if (!isRecord(options)) throw new Error("Autoreview options must be an object");
  const policy = validateAutoreviewPolicy(options.policy);
  const modelPolicy = validateModelPolicy(options.modelPolicy);
  if (!isRecord(options.target) || typeof options.target.read !== "function" || typeof options.target.fix !== "function") {
    throw new Error("Autoreview target adapter is invalid");
  }
  if (typeof options.review !== "function" || typeof options.record !== "function") {
    throw new Error("Autoreview review and record callbacks are required");
  }

  const mediumRequest = modelRequestForPurpose(modelPolicy, "iterativeReview");
  const highRequest = modelRequestForPurpose(modelPolicy, "finalReview");
  const rounds = [];
  let mediumRounds = 0;
  let highRounds = 0;
  let sequence = 0;
  let mediumCleanProof = null;

  const blockAttempt = async ({ phase, request, snapshot: attemptSnapshot, error, verdict = null, findings = [], findingIds = [] }) => {
    const code = stableBlockCode(error, phase.endsWith("review") ? "malformed_verdict" : "malformed_fix");
    const round = {
      schemaVersion: 1,
      sequence: ++sequence,
      phase,
      target: {
        kind: attemptSnapshot.kind,
        repository: attemptSnapshot.repository,
        number: attemptSnapshot.number,
        version: attemptSnapshot.version
      },
      promptVersion: policy.promptVersion,
      request,
      receipt: isRecord(error) && isRecord(error.receipt) ? error.receipt : null,
      prompt: isRecord(error) && isRecord(error.prompt) ? error.prompt : null,
      verdict,
      findings: Object.freeze([...findings]),
      findingIds: Object.freeze([...findingIds]),
      blockCode: code,
      outcome: "blocked"
    };
    const recordFailure = await persistRound(options.record, round, rounds);
    return recordFailure || blockedResult(code, rounds);
  };

  const readSnapshot = async () => validateTargetSnapshot(await options.target.read());
  let snapshot;
  try {
    snapshot = await readSnapshot();
  } catch (error) {
    return blockedResult(stableBlockCode(error, "target_policy_blocked"), rounds);
  }

  while (true) {
    let mediumClean = false;
    while (!mediumClean) {
      mediumCleanProof = null;
      if (mediumRounds >= policy.roundBudgets.medium) {
        return blockedResult("exhausted_medium_rounds", rounds);
      }
      mediumRounds += 1;
      let turn;
      try {
        turn = validateTurnResult(await options.review({
          phase: "medium_review",
          request: mediumRequest,
          snapshot,
          promptVersion: policy.promptVersion,
          round: mediumRounds
        }), mediumRequest, policy);
      } catch (error) {
        return blockAttempt({ phase: "medium_review", request: mediumRequest, snapshot, error });
      }

      let current;
      try {
        current = await readSnapshot();
      } catch (error) {
        if (!error.code) error.code = "target_policy_blocked";
        error.receipt = turn.receipt;
        error.prompt = turn.prompt;
        return blockAttempt({ phase: "medium_review", request: mediumRequest, snapshot, error, verdict: turn.verdict });
      }
      if (current.version !== snapshot.version) {
        const error = new Error("Target changed after medium review");
        error.code = "stale_target";
        error.receipt = turn.receipt;
        error.prompt = turn.prompt;
        return blockAttempt({ phase: "medium_review", request: mediumRequest, snapshot, error, verdict: turn.verdict });
      }

      const reviewRound = {
        schemaVersion: 1,
        sequence: ++sequence,
        phase: "medium_review",
        target: { kind: snapshot.kind, repository: snapshot.repository, number: snapshot.number, version: snapshot.version },
        promptVersion: policy.promptVersion,
        request: mediumRequest,
        receipt: turn.receipt,
        prompt: turn.prompt,
        verdict: turn.verdict,
        outcome: turn.verdict.approved ? "clean" : "findings"
      };
      const recordFailure = await persistRound(options.record, reviewRound, rounds);
      if (recordFailure) return recordFailure;
      if (turn.verdict.approved) {
        mediumCleanProof = Object.freeze({
          schemaVersion: 1,
          phase: "medium_review",
          sequence: reviewRound.sequence,
          targetVersion: snapshot.version,
          outcome: "clean"
        });
        mediumClean = true;
        snapshot = current;
        break;
      }
      if (mediumRounds >= policy.roundBudgets.medium) {
        return blockedResult("exhausted_medium_rounds", rounds);
      }

      let fix;
      try {
        fix = validateFixResult(await options.target.fix({
          phase: "medium_fix",
          request: mediumRequest,
          snapshot,
          findings: turn.verdict.blockingFindings,
          promptVersion: policy.promptVersion
        }), mediumRequest, snapshot.version);
      } catch (error) {
        return blockAttempt({
          phase: "medium_fix",
          request: mediumRequest,
          snapshot,
          error,
          findings: turn.verdict.blockingFindings,
          findingIds: turn.verdict.blockingFindings.map((finding) => finding.id)
        });
      }
      const fixRound = {
        schemaVersion: 1,
        sequence: ++sequence,
        phase: "medium_fix",
        target: { kind: snapshot.kind, repository: snapshot.repository, number: snapshot.number, version: snapshot.version },
        promptVersion: policy.promptVersion,
        request: mediumRequest,
        receipt: fix.receipt,
        prompt: fix.prompt,
        findings: turn.verdict.blockingFindings,
        findingIds: Object.freeze(turn.verdict.blockingFindings.map((finding) => finding.id)),
        changeRef: fix.changeRef,
        afterVersion: fix.afterVersion,
        outcome: "fixed"
      };
      const fixRecordFailure = await persistRound(options.record, fixRound, rounds);
      if (fixRecordFailure) return fixRecordFailure;
      try {
        snapshot = await readSnapshot();
      } catch (error) {
        return blockedResult(stableBlockCode(error, "target_policy_blocked"), rounds);
      }
      if (snapshot.version !== fix.afterVersion) return blockedResult("stale_target", rounds);
    }

    if (highRounds >= policy.roundBudgets.high) return blockedResult("exhausted_high_rounds", rounds);
    highRounds += 1;
    let highTurn;
    try {
      highTurn = validateTurnResult(await options.review({
        phase: "high_review",
        request: highRequest,
        snapshot,
        promptVersion: policy.promptVersion,
        round: highRounds,
        priorCleanRound: mediumCleanProof
      }), highRequest, policy);
    } catch (error) {
      return blockAttempt({ phase: "high_review", request: highRequest, snapshot, error });
    }
    let current;
    try {
      current = await readSnapshot();
    } catch (error) {
      if (!error.code) error.code = "target_policy_blocked";
      error.receipt = highTurn.receipt;
      error.prompt = highTurn.prompt;
      return blockAttempt({ phase: "high_review", request: highRequest, snapshot, error, verdict: highTurn.verdict });
    }
    if (current.version !== snapshot.version) {
      const error = new Error("Target changed after high review");
      error.code = "stale_target";
      error.receipt = highTurn.receipt;
      error.prompt = highTurn.prompt;
      return blockAttempt({ phase: "high_review", request: highRequest, snapshot, error, verdict: highTurn.verdict });
    }

    const highRound = {
      schemaVersion: 1,
      sequence: ++sequence,
      phase: "high_review",
      target: { kind: snapshot.kind, repository: snapshot.repository, number: snapshot.number, version: snapshot.version },
      promptVersion: policy.promptVersion,
      request: highRequest,
      receipt: highTurn.receipt,
      prompt: highTurn.prompt,
      verdict: highTurn.verdict,
      outcome: highTurn.verdict.approved ? "clean" : "findings"
    };
    const highRecordFailure = await persistRound(options.record, highRound, rounds);
    if (highRecordFailure) return highRecordFailure;
    if (highTurn.verdict.approved) return successfulResult(rounds, current);
    if (highRounds >= policy.roundBudgets.high) return blockedResult("exhausted_high_rounds", rounds);

    let highFix;
    try {
      highFix = validateFixResult(await options.target.fix({
        phase: "high_finding_fix",
        request: mediumRequest,
        snapshot,
        findings: highTurn.verdict.blockingFindings,
        promptVersion: policy.promptVersion
      }), mediumRequest, snapshot.version);
    } catch (error) {
      return blockAttempt({
        phase: "high_finding_fix",
        request: mediumRequest,
        snapshot,
        error,
        findings: highTurn.verdict.blockingFindings,
        findingIds: highTurn.verdict.blockingFindings.map((finding) => finding.id)
      });
    }
    const highFixRound = {
      schemaVersion: 1,
      sequence: ++sequence,
      phase: "high_finding_fix",
      target: { kind: snapshot.kind, repository: snapshot.repository, number: snapshot.number, version: snapshot.version },
      promptVersion: policy.promptVersion,
      request: mediumRequest,
      receipt: highFix.receipt,
      prompt: highFix.prompt,
      findings: highTurn.verdict.blockingFindings,
      findingIds: Object.freeze(highTurn.verdict.blockingFindings.map((finding) => finding.id)),
      changeRef: highFix.changeRef,
      afterVersion: highFix.afterVersion,
      outcome: "fixed"
    };
    const highFixRecordFailure = await persistRound(options.record, highFixRound, rounds);
    if (highFixRecordFailure) return highFixRecordFailure;
    try {
      snapshot = await readSnapshot();
    } catch (error) {
      return blockedResult(stableBlockCode(error, "target_policy_blocked"), rounds);
    }
    if (snapshot.version !== highFix.afterVersion) return blockedResult("stale_target", rounds);
  }
}
