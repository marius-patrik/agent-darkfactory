import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  formatDraftDiff,
  isRetryableIssueDraftReview,
  parseOwnerIssueIntent,
  publishReviewedIssueDraft,
  readIssueDraftState,
  writeIssueDraftState,
  type IssueDraftState
} from "../src/issue-development.js";
import {
  AUTOREVIEW_RESULT_MARKER,
  autoreviewTargetVersionMarker,
  evaluateIssueReady,
  issueContentDigest,
  issueVersion,
  renderIssueDraft,
  validateIssueDraftResult
} from "../src/issue-spec.js";

function validDraftResult() {
  return {
    schemaVersion: 1,
    status: "drafted",
    draft: {
      title: "Complete the deterministic human CLI",
      ownerText: "The owner wants a single safe command surface.",
      goal: "Expose the complete reviewed DarkFactory development lane.",
      evidence: ["Issue #39 contains the approved command contract."],
      scope: ["Add deterministic parsing and help."],
      nonGoals: ["Do not bypass protected branches."],
      acceptanceCriteria: ["Every mutation is exact and receipt-backed."],
      dependencies: ["Blocked-by: #51"],
      trustBoundaries: ["Canonical Agent OS owns model routing."],
      failureBehavior: ["Stale versions block without writes."],
      validation: ["Run npm run check."],
      rollout: ["Land through a reviewed dev PR."]
    },
    ownerQuestions: [],
    publicationAuthorized: false,
    evidence: [{ kind: "issue", ref: "#39", summary: "Owner-approved command contract." }],
    blockers: []
  };
}

function reviewedState(): IssueDraftState {
  const result = validateIssueDraftResult(validDraftResult());
  const rendered = renderIssueDraft(result, "0123456789abcdef0123456789abcdef");
  const digest = issueContentDigest(rendered.title, rendered.body);
  const document = { ...rendered, digest };
  const request = (modelTier: "medium" | "high") => ({ schemaVersion: 1, modelTier, effort: "high", purpose: modelTier === "high" ? "finalReview" : "iterativeReview" });
  const receipt = (modelTier: "medium" | "high") => ({
    schemaVersion: 1,
    requested: { modelTier, effort: "high" },
    resolved: { provider: `fixture-${modelTier}`, model: `fixture/${modelTier}`, agentPreset: `Fixture-${modelTier}`, providerVersion: "1.0.0" },
    attempts: [{ number: 1, outcome: "success", reason: null }],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    outcome: "success",
    blockReason: null
  });
  const prompt = (modelTier: "medium" | "high") => ({ selection: { modelTier, effort: "high" } });
  return {
    schemaVersion: 1,
    draftId: "0123456789abcdef0123456789abcdef",
    repository: "marius-patrik/DarkFactory",
    createdAt: "2026-07-15T12:00:00.000Z",
    updatedAt: "2026-07-15T12:01:00.000Z",
    status: "reviewed",
    initial: document,
    current: document,
    ownerQuestions: [],
    blockers: [],
    draftTurn: { request: request("high"), prompt: prompt("high") as never, receipt: receipt("high") },
    review: {
      targetVersion: issueVersion({ title: rendered.title, body: rendered.body, state: "open" }),
      ok: true,
      code: null,
      rounds: [
        { phase: "medium_review", outcome: "reviewed", request: request("medium"), receipt: receipt("medium"), prompt: prompt("medium"), verdict: { approved: true, blockingFindings: [] } },
        { phase: "high_review", outcome: "reviewed", request: request("high"), receipt: receipt("high"), prompt: prompt("high"), verdict: { approved: true, blockingFindings: [] } }
      ]
    },
    publication: null
  };
}

test("issue draft validation preserves all approved planning fields and forbids publication authority", () => {
  const result = validateIssueDraftResult(validDraftResult());
  const rendered = renderIssueDraft(result, "0123456789abcdef0123456789abcdef");
  assert.match(rendered.body, /^<!-- darkfactory:local-issue-draft id=/);
  for (const heading of ["# Goal", "## Acceptance criteria", "## Trust boundaries", "## Failure behavior", "## Validation and evidence plan", "## Owner-authored context"]) {
    assert.match(rendered.body, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.throws(() => validateIssueDraftResult({ ...validDraftResult(), publicationAuthorized: true }), /cannot authorize publication/);
  assert.throws(() => validateIssueDraftResult({ ...validDraftResult(), extra: true }), /must contain exactly/);
});

test("structured owner input requires the execution-ready contract rather than a goal-only prompt", () => {
  const input = {
    schemaVersion: 1,
    goal: "Build it",
    evidence: [],
    scope: ["Implementation"],
    nonGoals: [],
    acceptanceCriteria: ["Verified"],
    dependencies: [],
    trustBoundaries: ["No bypass"],
    failureBehavior: ["Block closed"],
    validation: ["npm run check"],
    rollout: ["dev then main"],
    ownerDecisions: []
  };
  assert.equal(parseOwnerIssueIntent(input).goal, "Build it");
  assert.throws(() => parseOwnerIssueIntent({ ...input, validation: [] }), /validation cannot be empty/);
  assert.throws(() => parseOwnerIssueIntent({ ...input, unexpected: [] }), /must contain exactly/);
});

test("ready evaluation succeeds only for the exact reviewed version with closed dependencies", () => {
  const state = reviewedState();
  const issue = {
    title: state.current.title,
    body: state.current.body,
    state: "open",
    labels: [{ name: "df:reviewed" }]
  };
  const expectedVersion = issueVersion(issue);
  const cleanComment = {
    body: `${AUTOREVIEW_RESULT_MARKER}\n${autoreviewTargetVersionMarker(expectedVersion)}\n## DarkFactory Autoreview\n\n**Verdict:** Clean high confirmation`,
    user: { login: "darkfactory-agent[bot]", type: "Bot" }
  };
  assert.equal(evaluateIssueReady({ issue, comments: [cleanComment], dependencies: [{ number: 51, state: "closed" }], expectedVersion }).ready, true);
  assert.equal(evaluateIssueReady({ issue, comments: [{ ...cleanComment, user: { login: "untrusted-user" } }], dependencies: [{ number: 51, state: "closed" }], expectedVersion }).ready, false);
  const staleReview = { ...cleanComment, body: `${AUTOREVIEW_RESULT_MARKER}\n${autoreviewTargetVersionMarker("0".repeat(64))}\n## DarkFactory Autoreview\n\n**Verdict:** Clean high confirmation` };
  assert.equal(evaluateIssueReady({ issue, comments: [staleReview], dependencies: [], expectedVersion }).ready, false);
  assert.equal(evaluateIssueReady({ issue, comments: [{ ...cleanComment, user: { login: "mp-agents[bot]", type: "Bot" } }], dependencies: [], expectedVersion }).ready, false);
  assert.equal(evaluateIssueReady({ issue, comments: [{ ...cleanComment, user: { login: "darkfactory-agent[bot]" } }], dependencies: [], expectedVersion }).ready, false);
  assert.throws(() => evaluateIssueReady({ issue: { ...issue, title: `${issue.title}!` }, comments: [cleanComment], dependencies: [], expectedVersion }), /stale issue version/);
  const denied = evaluateIssueReady({ issue: { ...issue, labels: [] }, comments: [], dependencies: [{ number: 51, state: "open" }], expectedVersion });
  assert.equal(denied.ready, false);
  assert.ok(denied.findings.some((finding) => finding.startsWith("reviewed-label:")));
  assert.ok(denied.findings.some((finding) => finding.startsWith("dependencies-closed:")));
});

test("only a prior Autoreview failure is retryable without changing owner intent", () => {
  const reviewed = reviewedState();
  const blocked = {
    ...reviewed,
    status: "blocked" as const,
    blockers: ["Autoreview blocked: provider_route_blocked"],
    review: { ...reviewed.review!, ok: false, code: "provider_route_blocked" }
  } satisfies IssueDraftState;
  assert.equal(isRetryableIssueDraftReview(blocked), true);
  assert.equal(isRetryableIssueDraftReview({ ...blocked, ownerQuestions: ["Choose rollout"] }), false);
  assert.equal(isRetryableIssueDraftReview({ ...blocked, blockers: ["Owner decision missing"] }), false);
});

test("reviewed draft publication is digest-approved, admission-ledgered, exact, and idempotent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "df-issue-publish-"));
  try {
    const draftPath = path.join(root, "draft.json");
    const initial = reviewedState();
    await writeIssueDraftState(draftPath, initial);
    const ledgers: Array<{ kind: string; payload: unknown }> = [];
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    let created: Record<string, unknown> | null = null;
    const runtime = {
      agentsHome: root,
      controlRevision: "0".repeat(40),
      ledger: async (kind: string, _repository: string, payload: unknown) => { ledgers.push({ kind, payload }); },
      github: {
        async request(method: string, requestPath: string, body?: unknown) {
          calls.push({ method, path: requestPath, body });
          if (method === "GET" && requestPath.includes("issues?state=all")) return created ? [created] : [];
          if (method === "POST" && requestPath.endsWith("/issues")) {
            const value = body as { title: string; body: string };
            created = { number: 123, title: value.title, body: value.body, state: "open", html_url: "https://example.test/issues/123" };
            return created;
          }
          if (method === "GET" && requestPath.endsWith("/issues/123")) return created;
          throw new Error(`unexpected ${method} ${requestPath}`);
        }
      }
    };
    const published = await publishReviewedIssueDraft(draftPath, initial.current.digest, runtime);
    assert.equal(published.status, "published");
    assert.equal(published.publication?.issueNumber, 123);
    assert.deepEqual(ledgers.map((entry) => entry.kind), ["issue-draft-publication-admission", "issue-draft-publication-completion"]);
    assert.equal(calls.filter((call) => call.method === "POST").length, 1);

    const again = await publishReviewedIssueDraft(draftPath, initial.current.digest, runtime);
    assert.equal(again.publication?.issueNumber, 123);
    assert.equal(calls.filter((call) => call.method === "POST").length, 1);
    assert.equal((await readIssueDraftState(draftPath)).status, "published");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stale approval and colliding published draft fail before a second issue write", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "df-issue-denied-"));
  try {
    const draftPath = path.join(root, "draft.json");
    const state = reviewedState();
    await writeIssueDraftState(draftPath, state);
    let writes = 0;
    const runtime = {
      agentsHome: root,
      controlRevision: "0".repeat(40),
      ledger: async () => {},
      github: {
        async request(method: string, requestPath: string) {
          if (method === "GET" && requestPath.includes("issues?state=all")) {
            return [{ number: 77, title: "Human edit", body: `<!-- darkfactory:local-issue-draft id=${state.draftId} -->\nchanged`, state: "open" }];
          }
          writes += 1;
          return {};
        }
      }
    };
    await assert.rejects(() => publishReviewedIssueDraft(draftPath, "f".repeat(64), runtime), /approval mismatch/);
    assert.equal(writes, 0);
    await assert.rejects(() => publishReviewedIssueDraft(draftPath, state.current.digest, runtime), /does not match the reviewed content/);
    assert.equal(writes, 0);
    assert.match(formatDraftDiff(state), /reviewed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publication recovers an exact remote issue with a durable completion receipt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "df-issue-recover-"));
  try {
    const draftPath = path.join(root, "draft.json");
    const state = reviewedState();
    await writeIssueDraftState(draftPath, state);
    const marker = `<!-- darkfactory:local-issue-draft id=${state.draftId} digest=${state.current.digest} -->`;
    const body = state.current.body.replace(/^<!-- darkfactory:local-issue-draft[^\n]*-->\n?/, `${marker}\n`);
    const existing = { number: 88, title: state.current.title, body, state: "open", html_url: "https://example.test/issues/88" };
    const ledgers: Array<{ kind: string; payload: unknown }> = [];
    let writes = 0;
    const recovered = await publishReviewedIssueDraft(draftPath, state.current.digest, {
      agentsHome: root,
      controlRevision: "0".repeat(40),
      ledger: async (kind, _repository, payload) => { ledgers.push({ kind, payload }); },
      github: {
        async request(method, requestPath) {
          if (method === "GET" && requestPath.includes("issues?state=all")) return [existing];
          writes += 1;
          return {};
        }
      }
    });
    assert.equal(recovered.status, "published");
    assert.equal(recovered.publication?.issueNumber, 88);
    assert.equal(writes, 0);
    assert.deepEqual(ledgers.map((entry) => entry.kind), ["issue-draft-publication-completion"]);
    assert.equal((ledgers[0].payload as { recovered: boolean }).recovered, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publication revalidates the local reviewed draft after durable admission", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "df-issue-race-"));
  try {
    const draftPath = path.join(root, "draft.json");
    const state = reviewedState();
    await writeIssueDraftState(draftPath, state);
    let writes = 0;
    await assert.rejects(() => publishReviewedIssueDraft(draftPath, state.current.digest, {
      agentsHome: root,
      controlRevision: "0".repeat(40),
      ledger: async (kind) => {
        if (kind !== "issue-draft-publication-admission") return;
        const changedBody = `${state.current.body}\nconcurrent owner edit`;
        const changedVersion = issueVersion({ title: state.current.title, body: changedBody, state: "open" });
        await writeIssueDraftState(draftPath, {
          ...state,
          current: { title: state.current.title, body: changedBody, digest: issueContentDigest(state.current.title, changedBody) },
          review: { ...state.review!, targetVersion: changedVersion }
        });
      },
      github: {
        async request(method, requestPath) {
          if (method === "GET" && requestPath.includes("issues?state=all")) return [];
          writes += 1;
          return {};
        }
      }
    }), /changed after publication admission/);
    assert.equal(writes, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shared CLI and Actions issue target admits one exact initial version and rejects malformed or stale versions", async () => {
  // @ts-ignore The base-trusted workflow runner is native ESM and shared directly with the CLI.
  const { createIssueTarget } = await import("../.github/scripts/run-darkfactory-autoreview.mjs");
  const issue = { number: 39, title: "Current", body: "# Goal\n\nExact", state: "open", labels: [], user: { login: "owner" }, updated_at: "2026-07-15T12:00:00Z" };
  const currentVersion = issueVersion(issue);
  let writes = 0;
  const gh = {
    async request(method: string, requestPath: string) {
      if (method !== "GET") writes += 1;
      if (requestPath === "/repos/marius-patrik/DarkFactory") return { default_branch: "main" };
      if (requestPath === "/repos/marius-patrik/DarkFactory/git/trees/main?recursive=1") return { truncated: false, tree: [{ type: "blob", path: "README.md" }] };
      if (requestPath === "/repos/marius-patrik/DarkFactory/issues/39") return issue;
      if (requestPath.startsWith("/repos/marius-patrik/DarkFactory/issues/39/comments?")) return [];
      if (requestPath.startsWith("/repos/marius-patrik/DarkFactory/issues?state=open&")) return [issue];
      throw new Error(`unexpected ${method} ${requestPath}`);
    }
  };
  const policy = { limits: { targetContextBytes: 100_000, summaryBytes: 10_000 } };
  const admitted = await createIssueTarget({ gh, repository: { owner: "marius-patrik", repo: "DarkFactory" }, number: 39, tempRoot: "C:\\temp", policy, expectedVersion: currentVersion });
  assert.equal((await admitted.read()).version, currentVersion);
  await assert.rejects(() => createIssueTarget({ gh, repository: { owner: "marius-patrik", repo: "DarkFactory" }, number: 39, tempRoot: "C:\\temp", policy, expectedVersion: "bad" }), /lowercase SHA-256/);
  const stale = await createIssueTarget({ gh, repository: { owner: "marius-patrik", repo: "DarkFactory" }, number: 39, tempRoot: "C:\\temp", policy, expectedVersion: "f".repeat(64) });
  await assert.rejects(() => stale.read(), /Issue changed before Autoreview admission/);
  assert.equal(writes, 0);
});

test("shared PR Autoreview target rejects a stale base SHA before cloning or executing target content", async () => {
  // @ts-ignore The base-trusted workflow runner is native ESM and shared directly with the CLI.
  const { createPullRequestTarget } = await import("../.github/scripts/run-darkfactory-autoreview.mjs");
  let calls = 0;
  const gh = {
    async request(_method: string, requestPath: string) {
      calls += 1;
      if (requestPath === "/repos/marius-patrik/DarkFactory") return { default_branch: "main" };
      if (requestPath === "/repos/marius-patrik/DarkFactory/pulls/270") return {
        state: "open",
        draft: false,
        base: { ref: "dev", sha: "1".repeat(40) },
        head: { ref: "feature", sha: "2".repeat(40), repo: { full_name: "marius-patrik/DarkFactory" } },
        body: "Closes #39",
        user: { login: "darkfactory-agent[bot]" }
      };
      throw new Error(`unexpected request ${requestPath}`);
    }
  };
  const target = await createPullRequestTarget({
    gh,
    repository: { owner: "marius-patrik", repo: "DarkFactory" },
    number: 270,
    token: "redacted",
    tempRoot: path.join(tmpdir(), "never-created"),
    policy: { limits: { targetContextBytes: 100_000 } },
    expectedBase: "dev",
    expectedBaseSha: "f".repeat(40),
    expectedHeadSha: "2".repeat(40)
  });
  await assert.rejects(() => target.read(), /base changed before Autoreview admission/);
  assert.equal(calls, 2);
  await assert.rejects(() => createPullRequestTarget({
    gh,
    repository: { owner: "marius-patrik", repo: "DarkFactory" },
    number: 270,
    token: "redacted",
    tempRoot: path.join(tmpdir(), "never-created"),
    policy: { limits: { targetContextBytes: 100_000 } },
    expectedBase: "dev",
    expectedBaseSha: "bad",
    expectedHeadSha: "2".repeat(40)
  }), /lowercase 40-character/);
  assert.equal(calls, 2);
});
