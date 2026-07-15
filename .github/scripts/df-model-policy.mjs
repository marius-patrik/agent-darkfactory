import { readFile } from "node:fs/promises";
import path from "node:path";

export const MODEL_POLICY_PATH = ".darkfactory/model-policy.json";
export const MODEL_TIERS = Object.freeze(["low", "medium", "high", "max"]);
export const EFFORT_TIERS = Object.freeze(["low", "medium", "high"]);
export const MODEL_PURPOSES = Object.freeze([
  "implementation",
  "planning",
  "orchestration",
  "issueDrafting",
  "iterativeReview",
  "finalReview",
  "explicitMaximum"
]);
export const TASK_CLASSES = Object.freeze(["mechanical", "standard", "hard"]);

const SAFE_ROUTE_VALUE = /^[A-Za-z0-9][A-Za-z0-9_.\/-]{0,127}$/;
const FORBIDDEN_RECEIPT_KEYS = /^(?:auth|authorization|credential|credentials|secret|secrets|privateKey|accessToken|refreshToken)$/i;

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

function validateRequest(value, context, allowOwnerFlag = false) {
  if (!isRecord(value)) throw new Error(`${context} must be an object`);
  exactKeys(value, allowOwnerFlag ? ["modelTier", "effort", "requiresOwnerAuthorization"] : ["modelTier", "effort"], context);
  if (!MODEL_TIERS.includes(value.modelTier)) throw new Error(`${context}.modelTier is invalid`);
  if (!EFFORT_TIERS.includes(value.effort)) throw new Error(`${context}.effort is invalid`);
  if (allowOwnerFlag && value.requiresOwnerAuthorization !== true) {
    throw new Error(`${context}.requiresOwnerAuthorization must be true`);
  }
  return Object.freeze({
    modelTier: value.modelTier,
    effort: value.effort,
    ...(allowOwnerFlag ? { requiresOwnerAuthorization: true } : {})
  });
}

export function validateModelPolicy(raw) {
  if (!isRecord(raw)) throw new Error("DarkFactory model policy must be an object");
  exactKeys(raw, ["schemaVersion", "description", "purposes"], "DarkFactory model policy");
  if (raw.schemaVersion !== 1) throw new Error("DarkFactory model policy schemaVersion must be 1");
  if (typeof raw.description !== "string" || !raw.description.trim()) {
    throw new Error("DarkFactory model policy description is required");
  }
  if (!isRecord(raw.purposes)) throw new Error("DarkFactory model policy purposes must be an object");
  exactKeys(raw.purposes, MODEL_PURPOSES, "DarkFactory model policy purposes");

  const implementation = raw.purposes.implementation;
  if (!isRecord(implementation)) throw new Error("implementation policy must be an object");
  exactKeys(implementation, TASK_CLASSES, "implementation policy");
  const normalizedImplementation = {};
  for (const taskClass of TASK_CLASSES) {
    normalizedImplementation[taskClass] = validateRequest(
      implementation[taskClass],
      `implementation policy ${taskClass}`
    );
  }

  if (normalizedImplementation.mechanical.modelTier !== "low") {
    throw new Error("only proven mechanical implementation may use the low tier");
  }
  for (const taskClass of ["standard", "hard"]) {
    if (normalizedImplementation[taskClass].modelTier !== "medium") {
      throw new Error(`${taskClass} implementation must use the medium tier`);
    }
  }

  const normalizedPurposes = { implementation: Object.freeze(normalizedImplementation) };
  for (const purpose of MODEL_PURPOSES.filter((name) => name !== "implementation")) {
    normalizedPurposes[purpose] = validateRequest(
      raw.purposes[purpose],
      `${purpose} policy`,
      purpose === "explicitMaximum"
    );
  }
  for (const purpose of ["planning", "orchestration", "issueDrafting", "finalReview"]) {
    if (normalizedPurposes[purpose].modelTier !== "high") {
      throw new Error(`${purpose} must use the high tier`);
    }
  }
  if (normalizedPurposes.iterativeReview.modelTier !== "medium") {
    throw new Error("iterativeReview must use the medium tier");
  }
  if (normalizedPurposes.explicitMaximum.modelTier !== "max") {
    throw new Error("explicitMaximum must use the max tier");
  }

  return Object.freeze({
    schemaVersion: 1,
    description: raw.description.trim(),
    purposes: Object.freeze(normalizedPurposes)
  });
}

export async function loadModelPolicy(controlRoot) {
  const raw = JSON.parse(await readFile(path.join(controlRoot, MODEL_POLICY_PATH), "utf8"));
  return validateModelPolicy(raw);
}

export function modelRequestForPurpose(policy, purpose, options = {}) {
  const validated = validateModelPolicy(policy);
  if (!MODEL_PURPOSES.includes(purpose)) throw new Error(`unknown DarkFactory model purpose: ${purpose}`);
  let request;
  if (purpose === "implementation") {
    const taskClass = options.taskClass || "standard";
    if (!TASK_CLASSES.includes(taskClass)) throw new Error(`unknown DarkFactory task class: ${taskClass}`);
    request = validated.purposes.implementation[taskClass];
  } else if (purpose === "explicitMaximum") {
    if (options.ownerAuthorized !== true || typeof options.authorizationRef !== "string" || !options.authorizationRef.trim()) {
      throw new Error("max tier requires an explicit owner authorization reference");
    }
    request = validated.purposes.explicitMaximum;
  } else {
    request = validated.purposes[purpose];
  }
  return Object.freeze({
    schemaVersion: 1,
    purpose,
    modelTier: request.modelTier,
    effort: request.effort,
    taskClass: purpose === "implementation" ? (options.taskClass || "standard") : null,
    authorizationRef: purpose === "explicitMaximum" ? options.authorizationRef.trim() : null
  });
}

export function agentRunArguments(request, options) {
  if (!isRecord(request) || request.schemaVersion !== 1 || !MODEL_TIERS.includes(request.modelTier) || !EFFORT_TIERS.includes(request.effort)) {
    throw new Error("invalid DarkFactory model request");
  }
  if (!isRecord(options)) throw new Error("Agent OS run options are required");
  const hasPrompt = typeof options.prompt === "string" && options.prompt.trim().length > 0;
  const hasPromptFile = typeof options.promptFile === "string" && options.promptFile.trim().length > 0;
  if (hasPrompt === hasPromptFile) {
    throw new Error("Exactly one Agent OS run prompt or prompt file is required");
  }
  if (hasPromptFile && !path.isAbsolute(options.promptFile)) {
    throw new Error("Agent OS prompt file path must be absolute");
  }
  if (typeof options.receiptPath !== "string" || !path.isAbsolute(options.receiptPath)) {
    throw new Error("Agent OS receipt path must be absolute");
  }
  const executionPolicy = options.executionPolicy || "read-only";
  if (!new Set(["read-only", "workspace-write"]).has(executionPolicy)) {
    throw new Error("Agent OS execution policy is invalid");
  }
  const args = [
    "run",
    "--mode",
    options.mode || "default",
    "--model-tier",
    request.modelTier,
    "--effort",
    request.effort,
    "--execution-policy",
    executionPolicy,
    "--receipt",
    options.receiptPath
  ];
  if (hasPromptFile) return [...args, "--prompt-file", options.promptFile];
  return [...args, options.prompt.trim()];
}

function rejectSensitiveReceiptData(value, seen = new Set()) {
  if (value === null || typeof value === "boolean" || typeof value === "number") return;
  if (typeof value === "string") {
    if (value.length > 1024 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
      throw new Error("Agent OS receipt contains unsafe text");
    }
    return;
  }
  if (!isRecord(value) && !Array.isArray(value)) throw new Error("Agent OS receipt contains an unsupported value");
  if (seen.has(value)) throw new Error("Agent OS receipt contains a cycle");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) rejectSensitiveReceiptData(item, seen);
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_RECEIPT_KEYS.test(key)) throw new Error("Agent OS receipt contains forbidden secret material");
      rejectSensitiveReceiptData(item, seen);
    }
  }
  seen.delete(value);
}

function safeRouteString(value, field) {
  if (typeof value !== "string" || !SAFE_ROUTE_VALUE.test(value)) {
    throw new Error(`Agent OS receipt ${field} is invalid`);
  }
  return value;
}

function nonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Agent OS receipt ${field} is invalid`);
  return value;
}

export function validateAgentExecutionReceipt(raw, expectedRequest, options = {}) {
  rejectSensitiveReceiptData(raw);
  if (!isRecord(raw)) throw new Error("Agent OS execution receipt must be an object");
  exactKeys(raw, ["schemaVersion", "requested", "resolved", "attempts", "usage", "outcome", "blockReason"], "Agent OS execution receipt");
  if (raw.schemaVersion !== 1) throw new Error("Agent OS execution receipt schemaVersion must be 1");
  if (!isRecord(raw.requested)) throw new Error("Agent OS execution receipt requested is invalid");
  exactKeys(raw.requested, ["modelTier", "effort"], "Agent OS execution receipt requested");
  if (raw.requested.modelTier !== expectedRequest.modelTier || raw.requested.effort !== expectedRequest.effort) {
    throw new Error("Agent OS execution receipt does not match the authorized model request");
  }
  if (!isRecord(raw.resolved)) throw new Error("Agent OS execution receipt resolved is invalid");
  exactKeys(raw.resolved, ["provider", "model", "agentPreset", "providerVersion"], "Agent OS execution receipt resolved");
  const resolved = {
    provider: safeRouteString(raw.resolved.provider, "resolved.provider"),
    model: safeRouteString(raw.resolved.model, "resolved.model"),
    agentPreset: safeRouteString(raw.resolved.agentPreset, "resolved.agentPreset"),
    providerVersion: safeRouteString(raw.resolved.providerVersion, "resolved.providerVersion")
  };
  if (!Array.isArray(raw.attempts) || raw.attempts.length < 1 || raw.attempts.length > 8) {
    throw new Error("Agent OS execution receipt attempts are invalid");
  }
  const attempts = raw.attempts.map((attempt, index) => {
    if (!isRecord(attempt)) throw new Error(`Agent OS execution receipt attempt ${index} is invalid`);
    exactKeys(attempt, ["number", "outcome", "reason"], `Agent OS execution receipt attempt ${index}`);
    const outcome = attempt.outcome;
    if (!new Set(["success", "blocked", "retryable"]).has(outcome)) {
      throw new Error(`Agent OS execution receipt attempt ${index} outcome is invalid`);
    }
    if (attempt.reason !== null && (typeof attempt.reason !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(attempt.reason))) {
      throw new Error(`Agent OS execution receipt attempt ${index} reason is invalid`);
    }
    return { number: nonNegativeInteger(attempt.number, `attempt ${index} number`), outcome, reason: attempt.reason };
  });
  if (!isRecord(raw.usage)) throw new Error("Agent OS execution receipt usage is invalid");
  exactKeys(raw.usage, ["inputTokens", "outputTokens", "totalTokens"], "Agent OS execution receipt usage");
  const usage = {
    inputTokens: nonNegativeInteger(raw.usage.inputTokens, "usage.inputTokens"),
    outputTokens: nonNegativeInteger(raw.usage.outputTokens, "usage.outputTokens"),
    totalTokens: nonNegativeInteger(raw.usage.totalTokens, "usage.totalTokens")
  };
  if (usage.totalTokens !== usage.inputTokens + usage.outputTokens) {
    throw new Error("Agent OS execution receipt token totals are inconsistent");
  }
  if (!new Set(["success", "blocked"]).has(raw.outcome)) throw new Error("Agent OS execution receipt outcome is invalid");
  if (raw.blockReason !== null && (typeof raw.blockReason !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(raw.blockReason))) {
    throw new Error("Agent OS execution receipt blockReason is invalid");
  }
  if (raw.outcome === "success" && raw.blockReason !== null) {
    throw new Error("A successful Agent OS execution receipt cannot contain a block reason");
  }
  if (raw.outcome === "blocked" && raw.blockReason === null) {
    throw new Error("A blocked Agent OS execution receipt must contain a block reason");
  }
  if (raw.outcome !== "success" && options.allowBlocked !== true) {
    throw new Error(`Agent OS execution blocked: ${raw.blockReason || "route_unavailable"}`);
  }
  return Object.freeze({
    schemaVersion: 1,
    requested: Object.freeze({ modelTier: raw.requested.modelTier, effort: raw.requested.effort }),
    resolved: Object.freeze(resolved),
    attempts: Object.freeze(attempts.map(Object.freeze)),
    usage: Object.freeze(usage),
    outcome: raw.outcome,
    blockReason: raw.blockReason
  });
}
