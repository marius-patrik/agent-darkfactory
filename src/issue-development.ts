import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OWNER_TEXT_END,
  OWNER_TEXT_START,
  issueContentDigest,
  issueVersion,
  renderIssueDraft,
  validateIssueAutofixProposal,
  validateIssueDraftResult,
  validateIssueVersion,
  type IssueDraftResult
} from "./issue-spec.js";
import {
  executeModelTurn,
  validationCommandsForRepository,
  type ModelRequest,
  type PromptProvenance
} from "./model-turn.js";

const CONTROL_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SAFE_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_EFFORT = new Set(["low", "medium", "high"]);
const MAX_INPUT_ITEMS = 200;
const MAX_INPUT_BYTES = 1_000_000;

export type OwnerIssueIntent = Readonly<{
  schemaVersion: 1;
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
  ownerDecisions: readonly string[];
}>;

export type DraftDocument = Readonly<{
  title: string;
  body: string;
  digest: string;
}>;

export type IssueDraftState = Readonly<{
  schemaVersion: 1;
  draftId: string;
  repository: string;
  createdAt: string;
  updatedAt: string;
  status: "drafted" | "reviewed" | "blocked" | "published";
  initial: DraftDocument;
  current: DraftDocument;
  ownerQuestions: readonly string[];
  blockers: readonly string[];
  draftTurn: Readonly<{ request: ModelRequest; prompt: PromptProvenance; receipt: unknown }>;
  review: Readonly<{ targetVersion: string; ok: boolean; code: string | null; rounds: readonly unknown[] }> | null;
  publication: Readonly<{ approvedDigest: string; issueNumber: number; issueUrl: string; issueVersion: string }> | null;
}>;

export interface IssueDevelopmentGithub {
  request(method: string, path: string, body?: unknown): Promise<unknown>;
}

export interface IssueDevelopmentRuntime {
  github: IssueDevelopmentGithub;
  ledger: (kind: string, repository: string, payload: unknown) => Promise<void>;
  agentsHome: string;
  controlRevision: string;
  environment?: NodeJS.ProcessEnv;
  now?: () => Date;
}

type ModelPolicyModule = {
  loadModelPolicy(controlRoot: string): Promise<unknown>;
  modelRequestForPurpose(policy: unknown, purpose: string, options?: Record<string, unknown>): ModelRequest;
  agentRunArguments(request: ModelRequest, options: Record<string, unknown>): string[];
  validateAgentExecutionReceipt(raw: unknown, request: ModelRequest, options: { allowBlocked: true }): {
    schemaVersion: number;
    requested: { modelTier: string; effort: string };
    resolved: { provider: string; model: string; agentPreset: string; providerVersion: string };
    attempts: ReadonlyArray<{ number: number; outcome: string; reason: string | null }>;
    usage: { inputTokens: number; outputTokens: number; totalTokens: number };
    outcome: "success" | "blocked";
    blockReason: string | null;
  };
};

type AutoreviewModule = {
  loadAutoreviewPolicy(controlRoot: string): Promise<{
    limits: { targetContextBytes: number; summaryBytes: number };
  }>;
  runAutoreview(options: Record<string, unknown>): Promise<{
    ok: boolean;
    code: string;
    targetVersion?: string;
    rounds: unknown[];
  }>;
};

type AutoreviewRunnerModule = {
  runComposedTurn(options: Record<string, unknown>): Promise<{
    output: unknown;
    receipt: unknown;
    prompt: PromptProvenance;
  }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], context: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((entry, index) => entry !== wanted[index])) {
    throw new Error(`${context} must contain exactly: ${wanted.join(", ")}`);
  }
}

function safeText(value: unknown, context: string, allowEmpty = false): string {
  if (typeof value !== "string") throw new Error(`${context} must be text`);
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (!allowEmpty && !normalized) throw new Error(`${context} is required`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) throw new Error(`${context} is unsafe`);
  if (Buffer.byteLength(normalized, "utf8") > MAX_INPUT_BYTES) throw new Error(`${context} exceeds its byte limit`);
  return normalized;
}

function safeList(value: unknown, context: string): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_INPUT_ITEMS) throw new Error(`${context} must be a bounded array`);
  return Object.freeze(value.map((entry, index) => safeText(entry, `${context}[${index}]`)));
}

export function parseOwnerIssueIntent(raw: unknown): OwnerIssueIntent {
  if (!isRecord(raw)) throw new Error("Issue draft input must be an object");
  exactKeys(raw, ["schemaVersion", "goal", "evidence", "scope", "nonGoals", "acceptanceCriteria", "dependencies", "trustBoundaries", "failureBehavior", "validation", "rollout", "ownerDecisions"], "Issue draft input");
  if (raw.schemaVersion !== 1) throw new Error("Issue draft input schemaVersion must be 1");
  const normalized = {
    schemaVersion: 1 as const,
    goal: safeText(raw.goal, "Issue draft goal"),
    evidence: safeList(raw.evidence, "Issue draft evidence"),
    scope: safeList(raw.scope, "Issue draft scope"),
    nonGoals: safeList(raw.nonGoals, "Issue draft nonGoals"),
    acceptanceCriteria: safeList(raw.acceptanceCriteria, "Issue draft acceptanceCriteria"),
    dependencies: safeList(raw.dependencies, "Issue draft dependencies"),
    trustBoundaries: safeList(raw.trustBoundaries, "Issue draft trustBoundaries"),
    failureBehavior: safeList(raw.failureBehavior, "Issue draft failureBehavior"),
    validation: safeList(raw.validation, "Issue draft validation"),
    rollout: safeList(raw.rollout, "Issue draft rollout"),
    ownerDecisions: safeList(raw.ownerDecisions, "Issue draft ownerDecisions")
  };
  for (const required of ["scope", "acceptanceCriteria", "trustBoundaries", "failureBehavior", "validation", "rollout"] as const) {
    if (normalized[required].length === 0) throw new Error(`Issue draft ${required} cannot be empty`);
  }
  return Object.freeze(normalized);
}

export async function readOwnerIssueIntent(inputPath: string): Promise<OwnerIssueIntent> {
  if (!path.isAbsolute(inputPath)) throw new Error("Issue draft input path must be absolute");
  return parseOwnerIssueIntent(JSON.parse(await readFile(inputPath, "utf8")));
}

export function parseIssueTarget(value: string): Readonly<{ repository: string; number: number }> {
  const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*)$/.exec(value);
  if (!match) throw new Error(`invalid issue target: ${value}`);
  const number = Number(match[2]);
  if (!Number.isSafeInteger(number)) throw new Error(`invalid issue target: ${value}`);
  return Object.freeze({ repository: match[1], number });
}

export function validateRepository(value: string): string {
  if (!SAFE_REPOSITORY.test(value)) throw new Error(`invalid repository: ${value}`);
  return value;
}

export function validateEffort(value: string): "low" | "medium" | "high" {
  if (!SAFE_EFFORT.has(value)) throw new Error(`invalid effort: ${value}`);
  return value as "low" | "medium" | "high";
}

export function defaultDraftPath(agentsHome: string, repository: string): string {
  if (!agentsHome || !path.isAbsolute(agentsHome)) throw new Error("A valid absolute AGENTS_HOME is required for local issue draft state");
  const safeRepository = validateRepository(repository).replace("/", "-").toLowerCase();
  return path.join(agentsHome, "runtime", "darkfactory", "drafts", `${safeRepository}-${randomUUID()}.json`);
}

function draftDocument(title: string, body: string): DraftDocument {
  const normalizedTitle = safeText(title, "Issue title");
  const normalizedBody = safeText(body, "Issue body");
  return Object.freeze({ title: normalizedTitle, body: normalizedBody, digest: issueContentDigest(normalizedTitle, normalizedBody) });
}

function assertStateShape(raw: unknown): asserts raw is IssueDraftState {
  if (!isRecord(raw)) throw new Error("Issue draft state must be an object");
  exactKeys(raw, ["schemaVersion", "draftId", "repository", "createdAt", "updatedAt", "status", "initial", "current", "ownerQuestions", "blockers", "draftTurn", "review", "publication"], "Issue draft state");
  if (raw.schemaVersion !== 1 || !/^[a-f0-9]{32}$/.test(String(raw.draftId)) || !SAFE_REPOSITORY.test(String(raw.repository))) throw new Error("Issue draft state identity is invalid");
  if (!new Set(["drafted", "reviewed", "blocked", "published"]).has(String(raw.status))) throw new Error("Issue draft state status is invalid");
  for (const name of ["createdAt", "updatedAt"]) {
    if (typeof raw[name] !== "string" || !Number.isFinite(new Date(raw[name]).getTime())) throw new Error(`Issue draft state ${name} is invalid`);
  }
  for (const name of ["initial", "current"]) {
    const value = raw[name];
    if (!isRecord(value)) throw new Error(`Issue draft state ${name} is invalid`);
    exactKeys(value, ["title", "body", "digest"], `Issue draft state ${name}`);
    if (typeof value.title !== "string" || typeof value.body !== "string" || typeof value.digest !== "string") throw new Error(`Issue draft state ${name} document is invalid`);
    const normalized = draftDocument(value.title, value.body);
    if (normalized.digest !== value.digest) throw new Error(`Issue draft state ${name} digest is invalid`);
  }
  for (const name of ["ownerQuestions", "blockers"]) {
    const value = raw[name];
    if (!Array.isArray(value) || value.length > MAX_INPUT_ITEMS || value.some((entry, index) => typeof entry !== "string" || safeText(entry, `Issue draft state ${name}[${index}]`) !== entry)) {
      throw new Error(`Issue draft state ${name} is invalid`);
    }
  }
  if (!isRecord(raw.draftTurn)) throw new Error("Issue draft state turn evidence is invalid");
  exactKeys(raw.draftTurn, ["request", "prompt", "receipt"], "Issue draft state turn evidence");
  if (!isRecord(raw.draftTurn.request) || !isRecord(raw.draftTurn.prompt) || !isRecord(raw.draftTurn.receipt)) throw new Error("Issue draft state turn evidence is incomplete");
  if (raw.review !== null) {
    if (!isRecord(raw.review)) throw new Error("Issue draft state review is invalid");
    exactKeys(raw.review, ["targetVersion", "ok", "code", "rounds"], "Issue draft state review");
    if (typeof raw.review.targetVersion !== "string") throw new Error("Issue draft state review version is invalid");
    validateIssueVersion(raw.review.targetVersion);
    if (raw.review.targetVersion !== issueVersion({ title: (raw.current as Record<string, unknown>).title, body: (raw.current as Record<string, unknown>).body, state: "open" })) throw new Error("Issue draft state review targets stale content");
    if (typeof raw.review.ok !== "boolean" || (raw.review.code !== null && typeof raw.review.code !== "string") || !Array.isArray(raw.review.rounds) || raw.review.rounds.length > MAX_INPUT_ITEMS) {
      throw new Error("Issue draft state review evidence is invalid");
    }
    if ((raw.review.ok && raw.review.code !== null) || (!raw.review.ok && (typeof raw.review.code !== "string" || !raw.review.code.trim()))) {
      throw new Error("Issue draft state review outcome is inconsistent");
    }
  }
  if (raw.publication !== null) {
    if (!isRecord(raw.publication)) throw new Error("Issue draft state publication is invalid");
    exactKeys(raw.publication, ["approvedDigest", "issueNumber", "issueUrl", "issueVersion"], "Issue draft state publication");
    if (typeof raw.publication.approvedDigest !== "string" || typeof raw.publication.issueVersion !== "string") throw new Error("Issue draft state publication versions are invalid");
    validateIssueVersion(raw.publication.approvedDigest);
    validateIssueVersion(raw.publication.issueVersion);
    if (!Number.isSafeInteger(raw.publication.issueNumber) || Number(raw.publication.issueNumber) < 1 || typeof raw.publication.issueUrl !== "string" || !safeText(raw.publication.issueUrl, "Issue draft publication URL")) {
      throw new Error("Issue draft state publication evidence is invalid");
    }
  }
  if ((raw.status === "published") !== (raw.publication !== null)) throw new Error("Issue draft state publication status is inconsistent");
  if (raw.status === "reviewed" && (!isRecord(raw.review) || raw.review.ok !== true)) throw new Error("Issue draft reviewed status lacks clean review evidence");
  if (isRecord(raw.review) && raw.review.ok === true && raw.status !== "reviewed" && raw.status !== "published") throw new Error("Issue draft clean review status is inconsistent");
  if (isRecord(raw.review) && raw.review.ok === false && raw.status !== "blocked") throw new Error("Issue draft blocked review status is inconsistent");
}

export async function readIssueDraftState(draftPath: string): Promise<IssueDraftState> {
  if (!path.isAbsolute(draftPath)) throw new Error("Issue draft state path must be absolute");
  const raw: unknown = JSON.parse(await readFile(draftPath, "utf8"));
  assertStateShape(raw);
  return structuredClone(raw);
}

export async function writeIssueDraftState(draftPath: string, state: IssueDraftState): Promise<void> {
  if (!path.isAbsolute(draftPath)) throw new Error("Issue draft state path must be absolute");
  assertStateShape(state);
  await mkdir(path.dirname(draftPath), { recursive: true });
  const temporary = `${draftPath}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    await rename(temporary, draftPath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function loadRuntimeModules(): Promise<{
  model: ModelPolicyModule;
  autoreview: AutoreviewModule;
  runner: AutoreviewRunnerModule;
}> {
  const [model, autoreview, runner] = await Promise.all([
    import(new URL("../.github/scripts/df-model-policy.mjs", import.meta.url).href),
    import(new URL("../.github/scripts/df-autoreview.mjs", import.meta.url).href),
    import(new URL("../.github/scripts/run-darkfactory-autoreview.mjs", import.meta.url).href)
  ]);
  return { model: model as unknown as ModelPolicyModule, autoreview: autoreview as unknown as AutoreviewModule, runner: runner as unknown as AutoreviewRunnerModule };
}

function githubObject(value: unknown, context: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`GitHub returned invalid ${context}`);
  return value;
}

async function fetchRepositoryContext(github: IssueDevelopmentGithub, repository: string): Promise<{
  owner: string;
  repo: string;
  defaultBranch: string;
  repositoryPaths: string[];
}> {
  const [owner, repo] = validateRepository(repository).split("/");
  const metadata = githubObject(await github.request("GET", `/repos/${repository}`), "repository metadata");
  const defaultBranch = typeof metadata.default_branch === "string" && metadata.default_branch ? metadata.default_branch : "main";
  const branch = githubObject(await github.request("GET", `/repos/${repository}/branches/${encodeURIComponent(defaultBranch)}`), "default branch");
  const commit = githubObject(branch.commit, "default-branch commit");
  if (typeof commit.sha !== "string" || !/^[0-9a-f]{40}$/.test(commit.sha)) throw new Error("GitHub returned invalid default-branch revision");
  const tree = githubObject(await github.request("GET", `/repos/${repository}/git/trees/${commit.sha}?recursive=1`), "repository tree");
  if (tree.truncated === true || !Array.isArray(tree.tree)) throw new Error("Complete repository inventory is unavailable");
  const repositoryPaths = tree.tree.map((entry) => isRecord(entry) && typeof entry.path === "string" ? entry.path : "").filter(Boolean).sort();
  if (repositoryPaths.length === 0) throw new Error("Repository inventory is empty");
  return { owner, repo, defaultBranch, repositoryPaths };
}

function intentComments(intent: OwnerIssueIntent): string[] {
  return [
    `Current evidence: ${JSON.stringify(intent.evidence)}`,
    `Scope: ${JSON.stringify(intent.scope)}`,
    `Non-goals: ${JSON.stringify(intent.nonGoals)}`,
    `Acceptance criteria: ${JSON.stringify(intent.acceptanceCriteria)}`,
    `Dependencies: ${JSON.stringify(intent.dependencies)}`,
    `Trust boundaries: ${JSON.stringify(intent.trustBoundaries)}`,
    `Failure behavior: ${JSON.stringify(intent.failureBehavior)}`,
    `Validation: ${JSON.stringify(intent.validation)}`,
    `Rollout: ${JSON.stringify(intent.rollout)}`,
    `Owner decisions already supplied: ${JSON.stringify(intent.ownerDecisions)}`
  ];
}

export async function createIssueDraft(
  repository: string,
  intent: OwnerIssueIntent,
  effort: "low" | "medium" | "high",
  draftPath: string,
  runtime: IssueDevelopmentRuntime
): Promise<IssueDraftState> {
  if (existsSync(draftPath)) throw new Error("Issue draft state already exists; resume it explicitly instead of overwriting");
  if (!path.isAbsolute(runtime.agentsHome) || !/^[0-9a-f]{40}$/i.test(runtime.controlRevision)) throw new Error("Canonical Agent OS and exact control revision are required");
  const observedAt = (runtime.now?.() ?? new Date()).toISOString();
  const context = await fetchRepositoryContext(runtime.github, repository);
  const modules = await loadRuntimeModules();
  const modelPolicy = await modules.model.loadModelPolicy(CONTROL_ROOT);
  const policyRequest = modules.model.modelRequestForPurpose(modelPolicy, "issueDrafting");
  if (policyRequest.modelTier !== "high") throw new Error("Issue drafting policy must resolve to the fixed high model tier");
  const request = Object.freeze({ ...policyRequest, effort });
  const runtimeRoot = path.join(runtime.agentsHome, "runtime", "darkfactory");
  await mkdir(runtimeRoot, { recursive: true });
  const tempRoot = await mkdtemp(path.join(runtimeRoot, "issue-draft-turn-"));
  try {
    const turn = await executeModelTurn({
      intent: {
        runId: `issue-draft-${randomUUID().replaceAll("-", "")}`,
        triggeredBy: "owner-interactive",
        profile: "profile/issue-drafter",
        repository: { owner: context.owner, repo: context.repo, defaultBranch: context.defaultBranch },
        repositoryPaths: context.repositoryPaths,
        workItem: null,
        draftIntent: { intent: intent.goal, comments: intentComments(intent) },
        policy: {
          branching: "One worker issue, branch, and reviewed pull request; preserve dependency order and protected release lanes.",
          labels: ["P0", "P1", "P2", "df:ready", "df:blocked", "df:ask-owner"],
          enforcement: "Keep publication behind issue Autoreview and exact owner approval; never infer owner decisions or bypass gates."
        },
        validation: { commands: validationCommandsForRepository({ owner: context.owner, repo: context.repo }, context.repositoryPaths) },
        verified: {
          observedAt,
          facts: [
            `Repository ${repository} exists and its default branch is ${context.defaultBranch}.`,
            `A complete default-branch inventory with ${context.repositoryPaths.length} paths was observed.`
          ]
        },
        effort,
        controlRevision: runtime.controlRevision
      },
      request,
      promptsRoot: path.join(CONTROL_ROOT, "prompts"),
      tempRoot,
      turnName: "issue-draft",
      cwd: tempRoot,
      executionPolicy: "read-only",
      environment: { ...runtime.environment, AGENTS_HOME: runtime.agentsHome }
    }, {
      agentRunArguments: modules.model.agentRunArguments,
      validateAgentExecutionReceipt: modules.model.validateAgentExecutionReceipt
    });
    if (turn.receipt.outcome !== "success" || turn.output === null) throw new Error("Canonical Agent OS issue-drafting route blocked closed");
    const result = validateIssueDraftResult(turn.output);
    const draftId = issueContentDigest(repository, `${observedAt}\n${turn.prompt.inputChecksum}`).slice(0, 32);
    const rendered = renderIssueDraft(result, draftId);
    const document = draftDocument(rendered.title, rendered.body);
    const state: IssueDraftState = Object.freeze({
      schemaVersion: 1,
      draftId,
      repository,
      createdAt: observedAt,
      updatedAt: observedAt,
      status: result.status === "drafted" ? "drafted" : "blocked",
      initial: document,
      current: document,
      ownerQuestions: result.ownerQuestions,
      blockers: Object.freeze([...result.blockers, ...result.ownerQuestions.map((question) => `owner decision: ${question}`)]),
      draftTurn: Object.freeze({ request, prompt: turn.prompt, receipt: turn.receipt }),
      review: null,
      publication: null
    });
    await runtime.ledger("issue-draft", repository, {
      schemaVersion: 1,
      draftId,
      draftDigest: document.digest,
      status: result.status,
      request,
      prompt: turn.prompt,
      receipt: turn.receipt,
      ownerQuestions: result.ownerQuestions,
      blockers: result.blockers
    });
    await writeIssueDraftState(draftPath, state);
    return state;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function ownerText(body: string): string {
  const start = body.indexOf(OWNER_TEXT_START);
  const end = body.indexOf(OWNER_TEXT_END);
  if (start < 0 || end < start) throw new Error("Issue draft lost its owner-text boundary");
  return body.slice(start, end + OWNER_TEXT_END.length);
}

function localReviewContext(state: IssueDraftState, openIssues: unknown[], maximumBytes: number): string {
  const context = JSON.stringify({
    target: {
      kind: "local_issue_draft",
      repository: state.repository,
      draftId: state.draftId,
      title: state.current.title,
      body: state.current.body,
      digest: state.current.digest
    },
    openIssueIndex: openIssues
  }, null, 2);
  if (Buffer.byteLength(context, "utf8") > maximumBytes) throw new Error("Complete local issue-draft review context exceeds the versioned Autoreview bound");
  return context;
}

async function listOpenIssues(github: IssueDevelopmentGithub, repository: string): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const raw = await github.request("GET", `/repos/${repository}/issues?state=open&per_page=100&page=${page}`);
    const items = Array.isArray(raw)
      ? raw
      : isRecord(raw) && Array.isArray(raw.items)
        ? raw.items
        : isRecord(raw) && Array.isArray(raw.data)
          ? raw.data
          : null;
    if (!items) throw new Error("GitHub returned invalid open issue inventory");
    out.push(...items.filter((entry) => isRecord(entry) && !entry.pull_request).map((entry) => ({
      number: entry.number,
      title: typeof entry.title === "string" ? entry.title : "",
      labels: Array.isArray(entry.labels) ? entry.labels.map((label: unknown) => isRecord(label) ? label.name : label).filter((label: unknown) => typeof label === "string") : []
    })));
    if (items.length < 100) return out;
  }
  throw new Error("Complete open issue inventory exceeds the bounded review limit");
}

export async function reviewIssueDraft(
  draftPath: string,
  runtime: IssueDevelopmentRuntime
): Promise<IssueDraftState> {
  let state = await readIssueDraftState(draftPath);
  if (state.status === "published") return state;
  if (state.status === "reviewed") return state;
  if (state.ownerQuestions.length > 0) throw new Error("Issue draft retains unresolved owner questions");
  if (state.status === "blocked") {
    if (!isRetryableIssueDraftReview(state)) throw new Error("Issue draft retains unresolved owner questions or blockers");
    state = Object.freeze({ ...state, status: "drafted", blockers: Object.freeze([]), review: null });
  } else if (state.status !== "drafted" || state.blockers.length > 0) {
    throw new Error("Issue draft is not eligible for Autoreview");
  }
  const context = await fetchRepositoryContext(runtime.github, state.repository);
  const modules = await loadRuntimeModules();
  const [policy, modelPolicy] = await Promise.all([
    modules.autoreview.loadAutoreviewPolicy(CONTROL_ROOT),
    modules.model.loadModelPolicy(CONTROL_ROOT)
  ]);
  const runtimeRoot = path.join(runtime.agentsHome, "runtime", "darkfactory");
  await mkdir(runtimeRoot, { recursive: true });
  const tempRoot = await mkdtemp(path.join(runtimeRoot, "issue-draft-review-"));
  try {
    const openIssues = await listOpenIssues(runtime.github, state.repository);
    const localIssueNumber = Number.parseInt(state.draftId.slice(0, 8), 16) || 1;
    const target = {
      read: async () => ({
        kind: "issue",
        repository: state.repository,
        number: localIssueNumber,
        version: issueVersion({ title: state.current.title, body: state.current.body, state: "open" }),
        defaultBranch: context.defaultBranch,
        repositoryPaths: context.repositoryPaths,
        author: "owner-interactive",
        url: `local-draft:${state.draftId}`,
        reviewContext: localReviewContext(state, openIssues, policy.limits.targetContextBytes),
        title: state.current.title,
        body: state.current.body,
        updatedAt: state.updatedAt
      }),
      fix: async ({ phase, request, snapshot, findings }: Record<string, any>) => {
        const beforeVersion = issueVersion({ title: state.current.title, body: state.current.body, state: "open" });
        if (beforeVersion !== snapshot.version) throw new Error("Local issue draft changed before autofix");
        const turn = await modules.runner.runComposedTurn({
          request,
          snapshot,
          tempRoot,
          turnName: phase,
          profile: "profile/issue-fixer",
          findings,
          controlRevision: runtime.controlRevision,
          environment: { ...runtime.environment, AGENTS_HOME: runtime.agentsHome }
        });
        const proposal = validateIssueAutofixProposal(turn.output, policy.limits);
        if (ownerText(proposal.body) !== ownerText(state.current.body)) throw new Error("Issue autofix cannot alter or remove owner-authored context");
        const nextDocument = draftDocument(proposal.title, proposal.body);
        const now = (runtime.now?.() ?? new Date()).toISOString();
        state = Object.freeze({ ...state, updatedAt: now, status: "drafted", current: nextDocument });
        await writeIssueDraftState(draftPath, state);
        return {
          beforeVersion,
          afterVersion: issueVersion({ title: nextDocument.title, body: nextDocument.body, state: "open" }),
          changeRef: `local-draft:${state.draftId}:${nextDocument.digest}`,
          receipt: turn.receipt,
          prompt: turn.prompt
        };
      }
    };
    const result = await modules.autoreview.runAutoreview({
      policy,
      modelPolicy,
      target,
      review: async ({ phase, request, snapshot }: Record<string, any>) => {
        const turn = await modules.runner.runComposedTurn({
          request,
          snapshot,
          tempRoot,
          turnName: phase,
          profile: phase === "high_review" ? "profile/issue-final-review" : "profile/issue-reviewer",
          controlRevision: runtime.controlRevision,
          environment: { ...runtime.environment, AGENTS_HOME: runtime.agentsHome }
        });
        return { verdict: turn.output, receipt: turn.receipt, prompt: turn.prompt };
      },
      record: async (round: unknown) => {
        await runtime.ledger("issue-draft-autoreview-round", state.repository, { schemaVersion: 1, draftId: state.draftId, round });
      }
    });
    const now = (runtime.now?.() ?? new Date()).toISOString();
    state = Object.freeze({
      ...state,
      updatedAt: now,
      status: result.ok ? "reviewed" : "blocked",
      blockers: result.ok ? Object.freeze([]) : Object.freeze([`Autoreview blocked: ${result.code}`]),
      review: Object.freeze({
        targetVersion: result.targetVersion ?? issueVersion({ title: state.current.title, body: state.current.body, state: "open" }),
        ok: result.ok,
        code: result.ok ? null : result.code,
        rounds: Object.freeze(result.rounds)
      })
    });
    await runtime.ledger("issue-draft-autoreview-result", state.repository, {
      schemaVersion: 1,
      draftId: state.draftId,
      draftDigest: state.current.digest,
      result
    });
    await writeIssueDraftState(draftPath, state);
    return state;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

export function isRetryableIssueDraftReview(state: IssueDraftState): boolean {
  return state.status === "blocked"
    && state.ownerQuestions.length === 0
    && state.review?.ok === false
    && state.blockers.length === 1
    && state.blockers[0] === `Autoreview blocked: ${state.review.code}`;
}

async function findPublishedDraft(github: IssueDevelopmentGithub, state: IssueDraftState): Promise<Record<string, unknown> | null> {
  const marker = `<!-- darkfactory:local-issue-draft id=${state.draftId}`;
  for (let page = 1; page <= 10; page += 1) {
    const result = await github.request("GET", `/repos/${state.repository}/issues?state=all&per_page=100&page=${page}`);
    if (!Array.isArray(result)) throw new Error("GitHub returned invalid issue inventory during publication admission");
    const issues = result.filter((entry) => isRecord(entry) && !entry.pull_request);
    const found = issues.find((issue) => typeof issue.body === "string" && issue.body.includes(marker));
    if (found) return found;
    if (result.length < 100) return null;
  }
  throw new Error("Complete issue inventory is unavailable for idempotent publication admission");
}

async function validateReviewedDraftEvidence(state: IssueDraftState): Promise<void> {
  if (state.review?.ok !== true || state.review.rounds.length < 2) throw new Error("Issue draft review evidence is incomplete");
  if (state.review.targetVersion !== issueVersion({ title: state.current.title, body: state.current.body, state: "open" })) {
    throw new Error("Issue draft review evidence targets stale content");
  }
  const modules = await loadRuntimeModules();
  const draftReceipt = modules.model.validateAgentExecutionReceipt(state.draftTurn.receipt, state.draftTurn.request, { allowBlocked: true });
  if (draftReceipt.outcome !== "success" || state.draftTurn.request.modelTier !== "high" || !isRecord(state.draftTurn.prompt) || !isRecord(state.draftTurn.prompt.selection) || state.draftTurn.prompt.selection.modelTier !== "high" || state.draftTurn.prompt.selection.effort !== state.draftTurn.request.effort) {
    throw new Error("Issue draft turn provenance is invalid");
  }
  for (const [index, rawRound] of state.review.rounds.entries()) {
    if (!isRecord(rawRound) || !isRecord(rawRound.request) || !isRecord(rawRound.receipt) || !isRecord(rawRound.prompt) || !isRecord(rawRound.prompt.selection)) {
      throw new Error(`Issue draft Autoreview round ${index + 1} provenance is incomplete`);
    }
    const request = rawRound.request as ModelRequest;
    const receipt = modules.model.validateAgentExecutionReceipt(rawRound.receipt, request, { allowBlocked: true });
    if (receipt.outcome !== "success" || rawRound.prompt.selection.modelTier !== request.modelTier || rawRound.prompt.selection.effort !== request.effort) {
      throw new Error(`Issue draft Autoreview round ${index + 1} provenance does not match its canonical Agent OS receipt`);
    }
  }
  const finalRound = state.review.rounds[state.review.rounds.length - 1];
  if (!isRecord(finalRound) || finalRound.phase !== "high_review" || finalRound.outcome !== "reviewed" || !isRecord(finalRound.verdict) || finalRound.verdict.approved !== true || !Array.isArray(finalRound.verdict.blockingFindings) || finalRound.verdict.blockingFindings.length !== 0) {
    throw new Error("Issue draft lacks a schema-valid clean final high confirmation");
  }
}

export async function publishReviewedIssueDraft(
  draftPath: string,
  approvedDigest: string,
  runtime: IssueDevelopmentRuntime
): Promise<IssueDraftState> {
  const lockPath = `${path.resolve(draftPath)}.publish.lock`;
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
    await lock.writeFile(JSON.stringify({ schemaVersion: 1, pid: process.pid, draftPath: path.resolve(draftPath) }), "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "EEXIST") {
      throw new Error(`Issue draft publication is already in progress for ${path.resolve(draftPath)}`);
    }
    throw error;
  }
  try {
    return await publishReviewedIssueDraftLocked(draftPath, approvedDigest, runtime);
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

async function publishReviewedIssueDraftLocked(
  draftPath: string,
  approvedDigest: string,
  runtime: IssueDevelopmentRuntime
): Promise<IssueDraftState> {
  validateIssueVersion(approvedDigest);
  let state = await readIssueDraftState(draftPath);
  if (state.status === "published") {
    if (state.publication?.approvedDigest !== approvedDigest) throw new Error("Published issue draft approval does not match the requested digest");
    return state;
  }
  if (state.status !== "reviewed" || state.review?.ok !== true) throw new Error("Issue draft must have a clean high Autoreview confirmation before publication");
  if (state.current.digest !== approvedDigest) throw new Error(`Issue draft approval mismatch: expected ${state.current.digest}`);
  if (state.ownerQuestions.length > 0 || state.blockers.length > 0) throw new Error("Issue draft retains unresolved owner decisions or blockers");
  await validateReviewedDraftEvidence(state);
  const marker = `<!-- darkfactory:local-issue-draft id=${state.draftId} digest=${state.current.digest} -->`;
  const publishedBody = state.current.body.replace(/^<!-- darkfactory:local-issue-draft[^\n]*-->\n?/, `${marker}\n`);
  const existing = await findPublishedDraft(runtime.github, state);
  if (existing) {
    if (existing.title !== state.current.title || existing.body !== publishedBody || typeof existing.number !== "number") {
      throw new Error("A published issue with this draft ID does not match the reviewed content");
    }
    const now = (runtime.now?.() ?? new Date()).toISOString();
    state = Object.freeze({
      ...state,
      updatedAt: now,
      status: "published",
      publication: Object.freeze({
        approvedDigest,
        issueNumber: existing.number,
        issueUrl: typeof existing.html_url === "string" ? existing.html_url : `https://github.com/${state.repository}/issues/${existing.number}`,
        issueVersion: issueVersion(existing)
      })
    });
    await runtime.ledger("issue-draft-publication-completion", state.repository, {
      schemaVersion: 1,
      draftId: state.draftId,
      approvedDigest,
      issue: state.publication,
      recovered: true
    });
    await writeIssueDraftState(draftPath, state);
    return state;
  }
  await runtime.ledger("issue-draft-publication-admission", state.repository, {
    schemaVersion: 1,
    draftId: state.draftId,
    approvedDigest,
    reviewTargetVersion: state.review.targetVersion,
    authorizedMutation: { repository: state.repository, kind: "create-issue", title: state.current.title }
  });
  const admittedState = await readIssueDraftState(draftPath);
  if (
    admittedState.status !== "reviewed"
    || admittedState.draftId !== state.draftId
    || admittedState.repository !== state.repository
    || admittedState.current.title !== state.current.title
    || admittedState.current.body !== state.current.body
    || admittedState.current.digest !== approvedDigest
    || admittedState.review?.ok !== true
    || admittedState.review.targetVersion !== state.review.targetVersion
  ) {
    throw new Error("Issue draft changed after publication admission");
  }
  state = admittedState;
  await validateReviewedDraftEvidence(state);
  const created = githubObject(await runtime.github.request("POST", `/repos/${state.repository}/issues`, {
    title: state.current.title,
    body: publishedBody
  }), "created issue");
  if (typeof created.number !== "number" || !Number.isSafeInteger(created.number)) throw new Error("GitHub did not return a valid created issue number");
  const confirmed = githubObject(await runtime.github.request("GET", `/repos/${state.repository}/issues/${created.number}`), "created issue confirmation");
  if (confirmed.title !== state.current.title || confirmed.body !== publishedBody || confirmed.state !== "open") {
    throw new Error("GitHub did not confirm the exact reviewed issue publication");
  }
  const now = (runtime.now?.() ?? new Date()).toISOString();
  state = Object.freeze({
    ...state,
    updatedAt: now,
    status: "published",
    publication: Object.freeze({
      approvedDigest,
      issueNumber: created.number,
      issueUrl: typeof confirmed.html_url === "string" ? confirmed.html_url : `https://github.com/${state.repository}/issues/${created.number}`,
      issueVersion: issueVersion(confirmed)
    })
  });
  await runtime.ledger("issue-draft-publication-completion", state.repository, {
    schemaVersion: 1,
    draftId: state.draftId,
    approvedDigest,
    issue: state.publication
  });
  await writeIssueDraftState(draftPath, state);
  return state;
}

export function formatDraftDiff(state: IssueDraftState): string {
  const before = `${state.initial.title}\n${state.initial.body}`.split("\n");
  const after = `${state.current.title}\n${state.current.body}`.split("\n");
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  const removed = before.slice(prefix, before.length - suffix);
  const added = after.slice(prefix, after.length - suffix);
  return [
    `--- initial ${state.initial.digest}`,
    `+++ reviewed ${state.current.digest}`,
    `@@ changed lines after ${prefix} common line(s) @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`)
  ].join("\n");
}

export function issueDraftSummary(state: IssueDraftState, draftPath: string): unknown {
  return {
    schemaVersion: 1,
    draftId: state.draftId,
    repository: state.repository,
    statePath: draftPath,
    status: state.status,
    initialDigest: state.initial.digest,
    reviewedDigest: state.current.digest,
    review: state.review,
    ownerQuestions: state.ownerQuestions,
    blockers: state.blockers,
    publication: state.publication
  };
}

export function draftExists(draftPath: string): boolean {
  return existsSync(draftPath);
}
