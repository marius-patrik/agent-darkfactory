import { createHash } from "node:crypto";

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const SHA256 = /^[0-9a-f]{64}$/;
const PULL_REQUEST_VERSION = /^[0-9a-f]{40}:[0-9a-f]{40}$/;
const MAX_TITLE_BYTES = 256;
const MAX_BODY_BYTES = 1_000_000;
const MAX_ITEM_BYTES = 16_384;
const MAX_ITEMS = 200;

export const DRAFT_MARKER = "darkfactory:local-issue-draft";
export const OWNER_TEXT_START = "<!-- darkfactory:owner-text:start -->";
export const OWNER_TEXT_END = "<!-- darkfactory:owner-text:end -->";
export const AUTOREVIEW_RESULT_MARKER = "<!-- darkfactory-autoreview -->";
export const AUTOREVIEW_TARGET_VERSION_MARKER_PREFIX = "<!-- darkfactory-autoreview-target version=";
export const ISSUE_AUTOFIX_MARKER_PREFIX = "<!-- darkfactory:issue-autofix schema=1";
const TRUSTED_DARKFACTORY_REST_ACTOR = "darkfactory-agent[bot]";

export type IssueDraftContent = Readonly<{
  title: string;
  ownerText: string;
  goal: string;
  evidence: readonly string[];
  scope: readonly string[];
  nonGoals: readonly string[];
  acceptanceCriteria: readonly string[];
  dependencies: readonly string[];
  trustBoundaries: readonly string[];
  failureBehavior: readonly string[];
  validation: readonly string[];
  rollout: readonly string[];
}>;

export type IssueDraftResult = Readonly<{
  schemaVersion: 1;
  status: "drafted" | "needs-owner" | "blocked";
  draft: IssueDraftContent;
  ownerQuestions: readonly string[];
  publicationAuthorized: false;
  evidence: readonly Readonly<{ kind: string; ref: string; summary: string }>[];
  blockers: readonly string[];
}>;

export type IssueAutofixProposal = Readonly<{
  title: string;
  body: string;
  summary: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isTrustedDarkFactoryComment(value: unknown): boolean {
  return isRecord(value)
    && isRecord(value.user)
    && value.user.type === "Bot"
    && typeof value.user.login === "string"
    && value.user.login === TRUSTED_DARKFACTORY_REST_ACTOR;
}

export function autoreviewTargetVersionMarker(value: string): string {
  if (!SHA256.test(value) && !PULL_REQUEST_VERSION.test(value)) {
    throw new Error("Autoreview target version must be an issue SHA-256 or exact BASE_SHA:HEAD_SHA");
  }
  return `${AUTOREVIEW_TARGET_VERSION_MARKER_PREFIX}${value} -->`;
}

function autoreviewTargetVersion(body: string): string | null {
  const escaped = AUTOREVIEW_TARGET_VERSION_MARKER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escaped}([0-9a-f]{64}|[0-9a-f]{40}:[0-9a-f]{40}) -->$`, "m").exec(body);
  return match ? match[1] : null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], context: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((entry, index) => entry !== wanted[index])) {
    throw new Error(`${context} must contain exactly: ${wanted.join(", ")}`);
  }
}

function safeText(value: unknown, context: string, maximumBytes = MAX_ITEM_BYTES, allowEmpty = false): string {
  if (typeof value !== "string") throw new Error(`${context} must be text`);
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if ((!allowEmpty && !normalized) || CONTROL_CHARACTERS.test(normalized)) throw new Error(`${context} is unsafe`);
  if (Buffer.byteLength(normalized, "utf8") > maximumBytes) throw new Error(`${context} exceeds its byte limit`);
  return normalized;
}

function safeTextList(value: unknown, context: string, allowEmpty = true): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) throw new Error(`${context} must be a bounded array`);
  const normalized = value.map((entry, index) => safeText(entry, `${context}[${index}]`));
  if (!allowEmpty && normalized.length === 0) throw new Error(`${context} cannot be empty`);
  return Object.freeze(normalized);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value.replace(/\r\n/g, "\n")).digest("hex");
}

export function validateIssueDraftResult(raw: unknown): IssueDraftResult {
  if (!isRecord(raw)) throw new Error("Issue draft result must be an object");
  exactKeys(raw, ["schemaVersion", "status", "draft", "ownerQuestions", "publicationAuthorized", "evidence", "blockers"], "Issue draft result");
  if (raw.schemaVersion !== 1) throw new Error("Issue draft schemaVersion must be 1");
  if (!new Set(["drafted", "needs-owner", "blocked"]).has(String(raw.status))) throw new Error("Issue draft status is invalid");
  if (raw.publicationAuthorized !== false) throw new Error("Issue drafter cannot authorize publication");
  if (!isRecord(raw.draft)) throw new Error("Issue draft content must be an object");
  exactKeys(raw.draft, ["title", "ownerText", "goal", "evidence", "scope", "nonGoals", "acceptanceCriteria", "dependencies", "trustBoundaries", "failureBehavior", "validation", "rollout"], "Issue draft content");
  const draft = Object.freeze({
    title: safeText(raw.draft.title, "Issue draft title", MAX_TITLE_BYTES),
    ownerText: safeText(raw.draft.ownerText, "Issue draft ownerText", MAX_BODY_BYTES),
    goal: safeText(raw.draft.goal, "Issue draft goal", MAX_BODY_BYTES),
    evidence: safeTextList(raw.draft.evidence, "Issue draft evidence"),
    scope: safeTextList(raw.draft.scope, "Issue draft scope", false),
    nonGoals: safeTextList(raw.draft.nonGoals, "Issue draft nonGoals"),
    acceptanceCriteria: safeTextList(raw.draft.acceptanceCriteria, "Issue draft acceptanceCriteria", false),
    dependencies: safeTextList(raw.draft.dependencies, "Issue draft dependencies"),
    trustBoundaries: safeTextList(raw.draft.trustBoundaries, "Issue draft trustBoundaries", false),
    failureBehavior: safeTextList(raw.draft.failureBehavior, "Issue draft failureBehavior", false),
    validation: safeTextList(raw.draft.validation, "Issue draft validation", false),
    rollout: safeTextList(raw.draft.rollout, "Issue draft rollout", false)
  });
  if (!Array.isArray(raw.evidence) || raw.evidence.length > MAX_ITEMS) throw new Error("Issue draft evidence records must be a bounded array");
  const evidence = raw.evidence.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`Issue draft evidence record ${index} must be an object`);
    exactKeys(entry, ["kind", "ref", "summary"], `Issue draft evidence record ${index}`);
    return Object.freeze({
      kind: safeText(entry.kind, `Issue draft evidence record ${index} kind`, 128),
      ref: safeText(entry.ref, `Issue draft evidence record ${index} ref`, 1024),
      summary: safeText(entry.summary, `Issue draft evidence record ${index} summary`)
    });
  });
  const ownerQuestions = safeTextList(raw.ownerQuestions, "Issue draft ownerQuestions");
  const blockers = safeTextList(raw.blockers, "Issue draft blockers");
  if (raw.status === "drafted" && (ownerQuestions.length > 0 || blockers.length > 0)) {
    throw new Error("A drafted issue cannot retain owner questions or blockers");
  }
  if (raw.status === "needs-owner" && ownerQuestions.length === 0) throw new Error("needs-owner requires at least one owner question");
  if (raw.status === "blocked" && blockers.length === 0) throw new Error("blocked requires at least one blocker");
  return Object.freeze({
    schemaVersion: 1,
    status: raw.status as IssueDraftResult["status"],
    draft,
    ownerQuestions,
    publicationAuthorized: false,
    evidence: Object.freeze(evidence),
    blockers
  });
}

function list(values: readonly string[], empty = "- None."): string {
  return values.length > 0 ? values.map((value) => `- ${value}`).join("\n") : empty;
}

export function renderIssueDraft(result: IssueDraftResult, draftId: string): Readonly<{ title: string; body: string }> {
  if (!/^[a-f0-9]{16,64}$/.test(draftId)) throw new Error("Issue draft ID is invalid");
  const draft = result.draft;
  const body = [
    `<!-- ${DRAFT_MARKER} id=${draftId} -->`,
    "# Goal",
    "",
    draft.goal,
    "",
    "## Current evidence",
    "",
    list(draft.evidence),
    "",
    "## Scope",
    "",
    list(draft.scope),
    "",
    "## Non-goals",
    "",
    list(draft.nonGoals),
    "",
    "## Acceptance criteria",
    "",
    list(draft.acceptanceCriteria),
    "",
    "## Dependencies",
    "",
    list(draft.dependencies),
    "",
    "## Trust boundaries",
    "",
    list(draft.trustBoundaries),
    "",
    "## Failure behavior",
    "",
    list(draft.failureBehavior),
    "",
    "## Validation and evidence plan",
    "",
    list(draft.validation),
    "",
    "## Rollout",
    "",
    list(draft.rollout),
    "",
    OWNER_TEXT_START,
    "## Owner-authored context",
    "",
    draft.ownerText,
    OWNER_TEXT_END
  ].join("\n");
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) throw new Error("Rendered issue draft exceeds its byte limit");
  return Object.freeze({ title: draft.title, body });
}

export function issueContentDigest(title: string, body: string): string {
  return sha256(canonicalJson({ title: title.replace(/\r\n/g, "\n"), body: body.replace(/\r\n/g, "\n") }));
}

export function issueVersion(issue: Readonly<{ title?: unknown; body?: unknown; state?: unknown }>): string {
  return sha256(JSON.stringify({
    title: typeof issue.title === "string" ? issue.title : "",
    body: typeof issue.body === "string" ? issue.body : "",
    state: typeof issue.state === "string" ? issue.state : ""
  }));
}

export function validateIssueVersion(value: string): string {
  if (!SHA256.test(value)) throw new Error("Issue version must be a lowercase SHA-256 digest");
  return value;
}

export type EffectiveIssueContent = Readonly<{
  title: string;
  body: string;
  state: string;
  version: string;
  appliedCommentIds: readonly number[];
}>;

export function renderIssueAutofixComment(input: Readonly<{
  targetVersion: string;
  title: string;
  body: string;
  state: string;
  summary: string;
}>): string {
  const targetVersion = validateIssueVersion(input.targetVersion);
  const title = safeText(input.title, "Issue autofix comment title", MAX_TITLE_BYTES);
  const body = safeText(input.body, "Issue autofix comment body", MAX_BODY_BYTES);
  const state = safeText(input.state, "Issue autofix comment state", 32);
  const summary = safeText(input.summary, "Issue autofix comment summary", MAX_ITEM_BYTES);
  const resultVersion = issueVersion({ title, body, state });
  const payload = Buffer.from(canonicalJson({ title, body }), "utf8").toString("base64url");
  const comment = [
    `${ISSUE_AUTOFIX_MARKER_PREFIX} target=${targetVersion} result=${resultVersion} payload=${payload} -->`,
    "## DarkFactory issue autofix",
    "",
    summary,
    "",
    `This append-only correction targets issue version \`${targetVersion}\` and resolves to \`${resultVersion}\`. If the owner edits the issue, this correction no longer applies; DarkFactory never overwrites concurrent owner text.`
  ].join("\n");
  if (Buffer.byteLength(comment, "utf8") > 60_000) {
    throw new Error("Issue autofix correction exceeds the safe GitHub comment limit");
  }
  return comment;
}

function parseIssueAutofixComment(body: string): Readonly<{
  targetVersion: string;
  resultVersion: string;
  title: string;
  body: string;
}> | null {
  if (!body.startsWith(ISSUE_AUTOFIX_MARKER_PREFIX)) return null;
  const firstLine = body.split(/\r?\n/, 1)[0];
  const match = /^<!-- darkfactory:issue-autofix schema=1 target=([0-9a-f]{64}) result=([0-9a-f]{64}) payload=([A-Za-z0-9_-]+) -->$/.exec(firstLine);
  if (!match) throw new Error("Trusted issue autofix correction marker is malformed");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(match[3], "base64url").toString("utf8"));
  } catch {
    throw new Error("Trusted issue autofix correction payload is malformed");
  }
  if (!isRecord(parsed)) throw new Error("Trusted issue autofix correction payload must be an object");
  exactKeys(parsed, ["title", "body"], "Issue autofix correction payload");
  const title = safeText(parsed.title, "Issue autofix correction title", MAX_TITLE_BYTES);
  const nextBody = safeText(parsed.body, "Issue autofix correction body", MAX_BODY_BYTES);
  return Object.freeze({ targetVersion: match[1], resultVersion: match[2], title, body: nextBody });
}

export function resolveEffectiveIssueContent(
  issue: Readonly<{ title?: unknown; body?: unknown; state?: unknown }>,
  comments: readonly Readonly<{ id?: unknown; body?: unknown; user?: unknown }>[]
): EffectiveIssueContent {
  let title = typeof issue.title === "string" ? issue.title : "";
  let body = typeof issue.body === "string" ? issue.body : "";
  const state = typeof issue.state === "string" ? issue.state : "";
  let version = issueVersion({ title, body, state });
  const appliedCommentIds: number[] = [];
  for (const comment of comments) {
    if (!isTrustedDarkFactoryComment(comment) || typeof comment.body !== "string") continue;
    const correction = parseIssueAutofixComment(comment.body);
    if (!correction || correction.targetVersion !== version) continue;
    const computed = issueVersion({ title: correction.title, body: correction.body, state });
    if (computed !== correction.resultVersion) throw new Error("Trusted issue autofix correction result digest is invalid");
    title = correction.title;
    body = correction.body;
    version = computed;
    if (typeof comment.id === "number" && Number.isSafeInteger(comment.id)) appliedCommentIds.push(comment.id);
  }
  return Object.freeze({ title, body, state, version, appliedCommentIds: Object.freeze(appliedCommentIds) });
}

export function validateIssueAutofixProposal(
  raw: unknown,
  limits: Readonly<{ targetContextBytes: number; summaryBytes: number }>
): IssueAutofixProposal {
  if (!isRecord(raw)) throw new Error("Issue autofix proposal must be an object");
  exactKeys(raw, ["schemaVersion", "title", "body", "summary"], "Issue autofix proposal");
  if (raw.schemaVersion !== 1) throw new Error("Issue autofix schemaVersion must be 1");
  return Object.freeze({
    title: safeText(raw.title, "Issue autofix title", Math.min(MAX_TITLE_BYTES, limits.targetContextBytes)),
    body: safeText(raw.body, "Issue autofix body", Math.min(MAX_BODY_BYTES, limits.targetContextBytes)),
    summary: safeText(raw.summary, "Issue autofix summary", limits.summaryBytes)
  });
}

export type ReadyEvaluation = Readonly<{
  schemaVersion: 1;
  targetVersion: string;
  ready: boolean;
  predicates: readonly Readonly<{ id: string; passed: boolean; evidence: string }> [];
  findings: readonly string[];
}>;

function hasHeading(body: string, pattern: RegExp): boolean {
  return body.split(/\r?\n/).some((line) => pattern.test(line.trim()));
}

export function evaluateIssueReady(input: Readonly<{
  issue: Readonly<{ title?: unknown; body?: unknown; state?: unknown; pull_request?: unknown; labels?: unknown }>;
  comments: readonly Readonly<{ body?: unknown; user?: unknown }>[];
  dependencies: readonly Readonly<{ number: number; state?: unknown }>[];
  expectedVersion: string;
}>): ReadyEvaluation {
  const expectedVersion = validateIssueVersion(input.expectedVersion);
  const effective = resolveEffectiveIssueContent(input.issue, input.comments);
  const actualVersion = effective.version;
  if (actualVersion !== expectedVersion) throw new Error(`stale issue version: expected ${expectedVersion}, observed ${actualVersion}`);
  const body = effective.body;
  const labels = new Set(Array.isArray(input.issue.labels) ? input.issue.labels.map((entry) => {
    if (typeof entry === "string") return entry;
    return isRecord(entry) && typeof entry.name === "string" ? entry.name : "";
  }).filter(Boolean) : []);
  const latestReview = [...input.comments].reverse().find((comment) => isTrustedDarkFactoryComment(comment) && typeof comment.body === "string" && comment.body.startsWith(AUTOREVIEW_RESULT_MARKER));
  const reviewText = typeof latestReview?.body === "string" ? latestReview.body : "";
  const reviewedVersion = autoreviewTargetVersion(reviewText);
  const reviewVerdictIsClean = /\*\*Verdict:\*\* (?:Clean high confirmation|Auditable owner override)/.test(reviewText);
  const predicates = [
    { id: "open-issue", passed: input.issue.state === "open" && input.issue.pull_request === undefined, evidence: input.issue.state === "open" && input.issue.pull_request === undefined ? "Target is an open issue." : "Target is not an open issue." },
    { id: "reviewed-label", passed: labels.has("df:reviewed"), evidence: labels.has("df:reviewed") ? "df:reviewed is present." : "df:reviewed is missing." },
    {
      id: "clean-review-evidence",
      passed: reviewVerdictIsClean && reviewedVersion === actualVersion,
      evidence: !reviewText
        ? "No trusted DarkFactory Autoreview result comment is observable."
        : reviewedVersion !== actualVersion
          ? `Latest trusted DarkFactory Autoreview targets ${reviewedVersion || "no parseable version"}, not current version ${actualVersion}.`
          : reviewVerdictIsClean
            ? "Latest trusted DarkFactory Autoreview is clean for the current issue version."
            : "Latest trusted DarkFactory Autoreview is not clean."
    },
    { id: "owner-decision-clear", passed: !labels.has("df:ask-owner"), evidence: labels.has("df:ask-owner") ? "df:ask-owner is present." : "No unresolved owner-decision label is present." },
    { id: "not-blocked", passed: !labels.has("df:blocked"), evidence: labels.has("df:blocked") ? "df:blocked is present." : "No blocked label is present." },
    { id: "goal", passed: hasHeading(body, /^#\s+goal\b/i), evidence: "Required Goal heading checked." },
    { id: "acceptance", passed: hasHeading(body, /^#{1,3}\s+acceptance(?:\s+criteria)?\b/i), evidence: "Required acceptance heading checked." },
    { id: "trust-boundaries", passed: hasHeading(body, /^#{1,3}\s+trust\s+boundar/i), evidence: "Required trust-boundaries heading checked." },
    { id: "failure-behavior", passed: hasHeading(body, /^#{1,3}\s+failure\s+behavior\b/i), evidence: "Required failure-behavior heading checked." },
    { id: "validation", passed: hasHeading(body, /^#{1,3}\s+validation\b/i), evidence: "Required validation heading checked." },
    { id: "dependencies-closed", passed: input.dependencies.every((dependency) => dependency.state === "closed"), evidence: input.dependencies.length === 0 ? "No explicit dependencies." : `${input.dependencies.filter((entry) => entry.state !== "closed").length} dependency issue(s) remain open.` }
  ].map((entry) => Object.freeze(entry));
  const findings = predicates.filter((entry) => !entry.passed).map((entry) => `${entry.id}: ${entry.evidence}`);
  return Object.freeze({ schemaVersion: 1, targetVersion: actualVersion, ready: findings.length === 0, predicates: Object.freeze(predicates), findings: Object.freeze(findings) });
}
