import path from "node:path";
import { readRequiredJson, repoName } from "./df-lib.mjs";

export const TRIGGER_POLICY_PATH = ".darkfactory/trigger-policy.json";
export const REQUIRED_LOOP_IDS = [
  "repository-doctor",
  "managed-baseline-sync",
  "pr-autoreview-fix",
  "issue-autoreview-fix",
  "interactive-issue-drafting",
  "issue-draft-hygiene",
  "prd-backlog-reconcile",
  "worker-dispatch",
  "worker-heartbeat-recovery",
  "worker-claim-follow-through",
  "release-convergence",
  "submodule-autoupdate",
  "repository-hygiene",
  "provider-capacity-health",
  "dashboard-refresh"
];

const TOP_KEYS = ["schemaVersion", "policyVersion", "trustedSourceRef", "loops"];
const LOOP_KEYS = [
  "id", "ownerIssue", "status", "engine", "eventWorkflows", "recoveryWorkflow",
  "eventTriggers", "recovery", "settleSeconds", "debounceSeconds",
  "idempotencyKey", "modelPolicy", "authorization", "retry", "ledgerKind"
];
const AUTH_KEYS = ["defaultMode", "mutationAuthority", "permissions", "receiptRequired"];
const RETRY_KEYS = ["maxAttempts", "backoffSeconds", "noProgressLimit", "escalationLabel"];
const RECOVERY_KEYS = ["cron", "intervalMinutes", "maxDetectionMinutes"];
const EVENT_KEYS = ["event", "types"];
const SAFE_TOKEN = /^[a-z][a-z0-9-]*$/;
const SAFE_PATH = /^\.github\/workflows\/[a-z0-9-]+\.ya?ml$/;
const SAFE_REF = /^refs\/heads\/[A-Za-z0-9._/-]+$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const MODEL_POLICIES = new Set([
  "zero-token",
  "task-class-policy",
  "autoreview-medium-clean-high-confirmation",
  "high",
  "zero-token-unless-semantic-conflict-high"
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, expected, context) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${context} has unknown or missing properties: ${actual.join(", ")}`);
  }
}

function assertSafeStrings(values, context) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !value.trim())) {
    throw new Error(`${context} must contain nonblank strings`);
  }
  if (new Set(values).size !== values.length) throw new Error(`${context} must not contain duplicates`);
}

function assertPositiveInteger(value, context, allowZero = false) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(`${context} must be a ${allowZero ? "nonnegative" : "positive"} integer`);
  }
}

export async function readTriggerPolicy(root) {
  return validateTriggerPolicy(await readRequiredJson(path.join(root, TRIGGER_POLICY_PATH)));
}

export function validateTriggerPolicy(value) {
  if (!isRecord(value)) throw new Error("Trigger policy must be an object");
  assertExactKeys(value, TOP_KEYS, "Trigger policy");
  if (value.schemaVersion !== 1) throw new Error("Trigger policy schemaVersion must be 1");
  if (typeof value.policyVersion !== "string" || !SEMVER.test(value.policyVersion)) {
    throw new Error("Trigger policy must declare a semantic policyVersion");
  }
  if (typeof value.trustedSourceRef !== "string" || !SAFE_REF.test(value.trustedSourceRef)) {
    throw new Error("Trigger policy must declare one trusted branch ref");
  }
  if (!Array.isArray(value.loops)) throw new Error("Trigger policy loops must be an array");

  const ids = new Set();
  const loops = value.loops.map((entry) => {
    if (!isRecord(entry)) throw new Error("Trigger policy loop must be an object");
    assertExactKeys(entry, LOOP_KEYS, "Trigger policy loop");
    if (typeof entry.id !== "string" || !SAFE_TOKEN.test(entry.id) || ids.has(entry.id)) {
      throw new Error(`Trigger policy loop has invalid or duplicate id: ${String(entry.id)}`);
    }
    ids.add(entry.id);
    assertPositiveInteger(entry.ownerIssue, `Trigger loop ${entry.id} ownerIssue`);
    if (!new Set(["active", "planned"]).has(entry.status)) {
      throw new Error(`Trigger loop ${entry.id} has invalid status`);
    }
    for (const [name, candidate] of [["engine", entry.engine], ["ledgerKind", entry.ledgerKind]]) {
      if (typeof candidate !== "string" || !candidate.trim() || /[\r\n]/.test(candidate)) {
        throw new Error(`Trigger loop ${entry.id} ${name} must be one line`);
      }
    }
    const localHumanLoop = entry.id === "interactive-issue-drafting";
    if (!Array.isArray(entry.eventWorkflows)
        || entry.eventWorkflows.some((workflow) => typeof workflow !== "string" || !SAFE_PATH.test(workflow))
        || new Set(entry.eventWorkflows).size !== entry.eventWorkflows.length) {
      throw new Error(`Trigger loop ${entry.id} must name trusted workflow paths`);
    }
    if (localHumanLoop) {
      if (entry.status !== "planned" || entry.eventWorkflows.length !== 0 || entry.recoveryWorkflow !== null
          || !Array.isArray(entry.eventTriggers) || entry.eventTriggers.length !== 0 || entry.recovery !== null) {
        throw new Error("Interactive issue drafting must remain an explicitly local, human-driven planned loop without workflow or schedule claims");
      }
    } else {
      if (entry.eventWorkflows.length === 0 || !SAFE_PATH.test(entry.recoveryWorkflow)) {
        throw new Error(`Trigger loop ${entry.id} must name trusted workflow paths`);
      }
      if (!Array.isArray(entry.eventTriggers) || entry.eventTriggers.length === 0) {
        throw new Error(`Trigger loop ${entry.id} must declare at least one event trigger`);
      }
    }
    const eventNames = new Set();
    for (const event of entry.eventTriggers) {
      if (!isRecord(event)) throw new Error(`Trigger loop ${entry.id} event must be an object`);
      assertExactKeys(event, EVENT_KEYS, `Trigger loop ${entry.id} event`);
      if (typeof event.event !== "string" || !/^[a-z][a-z0-9_]*$/.test(event.event) || eventNames.has(event.event)) {
        throw new Error(`Trigger loop ${entry.id} has invalid or duplicate event`);
      }
      eventNames.add(event.event);
      if (!Array.isArray(event.types) || event.types.some((type) => typeof type !== "string" || !type.trim() || /[\r\n]/.test(type))) {
        throw new Error(`Trigger loop ${entry.id} event types must be one-line strings`);
      }
      if (new Set(event.types).size !== event.types.length) throw new Error(`Trigger loop ${entry.id} event types must be unique`);
    }
    if (!localHumanLoop) {
      if (!isRecord(entry.recovery)) throw new Error(`Trigger loop ${entry.id} recovery must be an object`);
      assertExactKeys(entry.recovery, RECOVERY_KEYS, `Trigger loop ${entry.id} recovery`);
      if (typeof entry.recovery.cron !== "string" || entry.recovery.cron.trim().split(/\s+/).length !== 5) {
        throw new Error(`Trigger loop ${entry.id} recovery cron must have five fields`);
      }
      assertPositiveInteger(entry.recovery.intervalMinutes, `Trigger loop ${entry.id} recovery interval`);
      assertPositiveInteger(entry.recovery.maxDetectionMinutes, `Trigger loop ${entry.id} maximum detection latency`);
      if (entry.recovery.maxDetectionMinutes < entry.recovery.intervalMinutes) {
        throw new Error(`Trigger loop ${entry.id} maximum detection latency must cover its schedule interval`);
      }
    }
    assertPositiveInteger(entry.settleSeconds, `Trigger loop ${entry.id} settleSeconds`, true);
    assertPositiveInteger(entry.debounceSeconds, `Trigger loop ${entry.id} debounceSeconds`, true);
    const expectedPrefix = `${entry.id}:`;
    if (
      typeof entry.idempotencyKey !== "string" ||
      !entry.idempotencyKey.startsWith(expectedPrefix) ||
      !entry.idempotencyKey.includes("{repository}") ||
      !entry.idempotencyKey.includes("{target}") ||
      !entry.idempotencyKey.includes("{sourceVersion}") ||
      /\{(?!repository\}|target\}|sourceVersion\})/.test(entry.idempotencyKey)
    ) {
      throw new Error(`Trigger loop ${entry.id} idempotency key must bind repository, target, and sourceVersion`);
    }
    if (!MODEL_POLICIES.has(entry.modelPolicy)) throw new Error(`Trigger loop ${entry.id} has unknown model policy`);
    if (!isRecord(entry.authorization)) throw new Error(`Trigger loop ${entry.id} authorization must be an object`);
    assertExactKeys(entry.authorization, AUTH_KEYS, `Trigger loop ${entry.id} authorization`);
    if (
      typeof entry.authorization.defaultMode !== "string" || !entry.authorization.defaultMode.trim() ||
      typeof entry.authorization.mutationAuthority !== "string" || !entry.authorization.mutationAuthority.trim() ||
      entry.authorization.receiptRequired !== true
    ) {
      throw new Error(`Trigger loop ${entry.id} must declare read/default mode, mutation authority, and receipt admission`);
    }
    assertSafeStrings(entry.authorization.permissions, `Trigger loop ${entry.id} permissions`);
    if (!isRecord(entry.retry)) throw new Error(`Trigger loop ${entry.id} retry must be an object`);
    assertExactKeys(entry.retry, RETRY_KEYS, `Trigger loop ${entry.id} retry`);
    assertPositiveInteger(entry.retry.maxAttempts, `Trigger loop ${entry.id} retry maxAttempts`);
    assertPositiveInteger(entry.retry.backoffSeconds, `Trigger loop ${entry.id} retry backoffSeconds`);
    assertPositiveInteger(entry.retry.noProgressLimit, `Trigger loop ${entry.id} retry noProgressLimit`);
    if (entry.retry.escalationLabel !== "df:ask-owner") {
      throw new Error(`Trigger loop ${entry.id} must escalate through df:ask-owner`);
    }
    return entry;
  });

  const missing = REQUIRED_LOOP_IDS.filter((id) => !ids.has(id));
  const extra = [...ids].filter((id) => !REQUIRED_LOOP_IDS.includes(id));
  if (missing.length || extra.length) {
    throw new Error(`Trigger policy loop coverage mismatch; missing=${missing.join(",")} extra=${extra.join(",")}`);
  }
  return { ...value, loops };
}

export function loopById(policy, id) {
  const validated = validateTriggerPolicy(policy);
  const loop = validated.loops.find((entry) => entry.id === id);
  if (!loop) throw new Error(`Unknown trigger policy loop: ${id}`);
  return loop;
}

export function renderLoopIdempotencyKey(policy, id, context) {
  const loop = loopById(policy, id);
  for (const [name, value] of Object.entries(context || {})) {
    if (typeof value !== "string" || !value || /[\r\n{}]/.test(value)) {
      throw new Error(`Loop idempotency context ${name} must be a nonblank safe string`);
    }
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(context.repository || "")) {
    throw new Error("Loop idempotency context requires owner/repository");
  }
  if (!/^[A-Za-z0-9._:/#-]+$/.test(context.target || "")) throw new Error("Loop idempotency context requires a safe target");
  if (!/^[A-Za-z0-9._-]+$/.test(context.sourceVersion || "")) throw new Error("Loop idempotency context requires a safe sourceVersion");
  return loop.idempotencyKey
    .replaceAll("{repository}", context.repository.toLowerCase())
    .replaceAll("{target}", context.target.toLowerCase())
    .replaceAll("{sourceVersion}", context.sourceVersion.toLowerCase());
}

export function admitLoopInvocation(policy, id, invocation, now = new Date()) {
  const loop = loopById(policy, id);
  if (loop.status !== "active") throw new Error(`Trigger loop ${id} is planned, not active`);
  if (invocation.sourceRef !== policy.trustedSourceRef) {
    throw new Error(`Trigger loop ${id} requires trusted source ref ${policy.trustedSourceRef}`);
  }
  const deliveredAt = new Date(invocation.deliveredAt);
  if (!Number.isFinite(deliveredAt.valueOf())) throw new Error(`Trigger loop ${id} requires a valid deliveredAt`);
  const ageMs = now.valueOf() - deliveredAt.valueOf();
  if (ageMs < -300_000) throw new Error(`Trigger loop ${id} event is from the future`);
  if (ageMs > loop.recovery.maxDetectionMinutes * 60_000) {
    throw new Error(`Trigger loop ${id} event is stale and must be replanned from current state`);
  }
  return {
    loopId: id,
    idempotencyKey: renderLoopIdempotencyKey(policy, id, invocation),
    settleSeconds: loop.settleSeconds,
    debounceSeconds: loop.debounceSeconds,
    sourceRef: invocation.sourceRef,
    sourceVersion: invocation.sourceVersion
  };
}

function parseTime(value) {
  const parsed = new Date(value || "");
  return Number.isFinite(parsed.valueOf()) ? parsed : null;
}

export async function collectLoopWorkflowEvidence(gh, repository, policy) {
  const validated = validateTriggerPolicy(policy);
  const workflows = [...new Set(validated.loops.filter((loop) => loop.status === "active").flatMap((loop) => [...loop.eventWorkflows, loop.recoveryWorkflow]))];
  const evidence = {};
  for (const workflow of workflows) {
    const workflowId = encodeURIComponent(path.basename(workflow));
    const response = await gh.request(
      "GET",
      `/repos/${repoName(repository)}/actions/workflows/${workflowId}/runs?branch=main&per_page=20`
    );
    evidence[workflow] = Array.isArray(response?.workflow_runs) ? response.workflow_runs : [];
  }
  return evidence;
}

export function projectLoopStatus(policy, evidenceByWorkflow = {}, now = new Date()) {
  const validated = validateTriggerPolicy(policy);
  return validated.loops.map((loop) => {
    if (loop.status === "planned") {
      return {
        id: loop.id,
        state: "planned",
        lastSuccess: null,
        nextExpected: null,
        source: validated.trustedSourceRef,
        retry: `blocked-by:#${loop.ownerIssue}`,
        stale: false
      };
    }
    const workflows = [...new Set([...loop.eventWorkflows, loop.recoveryWorkflow])];
    const runs = workflows.flatMap((workflow) =>
      Array.isArray(evidenceByWorkflow[workflow]) ? evidenceByWorkflow[workflow] : []
    )
      .filter((run) => run && run.head_branch === "main" && parseTime(run.created_at))
      .sort((a, b) => parseTime(b.created_at).valueOf() - parseTime(a.created_at).valueOf());
    const latest = runs[0] || null;
    const success = runs.find((run) => run.status === "completed" && run.conclusion === "success") || null;
    const lastSuccessTime = success ? parseTime(success.updated_at || success.created_at) : null;
    const nextExpectedTime = lastSuccessTime
      ? new Date(lastSuccessTime.valueOf() + loop.recovery.intervalMinutes * 60_000)
      : null;
    const stale = !lastSuccessTime || now.valueOf() > lastSuccessTime.valueOf() + loop.recovery.maxDetectionMinutes * 60_000;
    const attempt = Number.isSafeInteger(latest?.run_attempt) ? latest.run_attempt : 1;
    let retry = "idle";
    if (latest && latest.status !== "completed") retry = `running:attempt-${attempt}`;
    else if (latest && latest.conclusion !== "success" && attempt < loop.retry.maxAttempts) retry = `retry:${attempt}/${loop.retry.maxAttempts}`;
    else if (stale || (latest && latest.conclusion !== "success")) retry = `escalate:${loop.retry.escalationLabel}`;
    return {
      id: loop.id,
      state: stale ? "stale" : latest?.status === "completed" ? latest.conclusion : latest?.status || "missing",
      lastSuccess: lastSuccessTime?.toISOString() || null,
      nextExpected: nextExpectedTime?.toISOString() || null,
      source: latest?.head_sha ? `${validated.trustedSourceRef}@${String(latest.head_sha).slice(0, 12)}` : validated.trustedSourceRef,
      retry,
      stale
    };
  });
}

export function loopStatusMarkdownRows(statuses) {
  return statuses.map((status) =>
    `| \`${status.id}\` | ${status.state} | ${status.lastSuccess ? `\`${status.lastSuccess}\`` : "never"} | ${status.nextExpected ? `\`${status.nextExpected}\`` : "n/a"} | \`${status.source}\` | \`${status.retry}\` |`
  ).join("\n");
}
