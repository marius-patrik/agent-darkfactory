import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  continueIssueDraft,
  formatDraftDiff,
  issueDraftConversationVersion,
  isRetryableIssueDraftReview,
  parseOwnerIssueAnswers,
  parseOwnerIssueIntent,
  publishReviewedIssueDraft,
  readIssueDraftState,
  writeIssueDraftState,
  type IssueDevelopmentRuntime,
  type IssueDraftState
} from "../src/issue-development.js";
import {
  AUTOREVIEW_RESULT_MARKER,
  autoreviewTargetVersionMarker,
  evaluateIssueReady,
  issueContentDigest,
  issueVersion,
  renderIssueAutofixComment,
  renderIssueDraft,
  resolveEffectiveIssueContent,
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
    schemaVersion: 2,
    requested: { modelTier, effort: "high" },
    routing: {
      policyVersion: "fixture-route-policy-v1",
      primary: { provider: "fixture-primary", model: "fixture/primary-model", agentPreset: "Fixture-Primary", providerVersion: "1.0.0" },
      skipped: []
    },
    resolved: { provider: `fixture-${modelTier}`, model: `fixture/${modelTier}`, agentPreset: `Fixture-${modelTier}`, providerVersion: "1.0.0" },
    attempts: [{ number: 1, outcome: "success", reason: null }],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    outcome: "success",
    blockReason: null
  });
  const prompt = (modelTier: "medium" | "high") => ({ selection: { modelTier, effort: "high" } });
  const reviewedAt = new Date(Date.now() - 60_000).toISOString();
  const createdAt = new Date(Date.now() - 120_000).toISOString();
  return {
    schemaVersion: 2,
    draftId: "0123456789abcdef0123456789abcdef",
    repository: "marius-patrik/DarkFactory",
    createdAt,
    updatedAt: reviewedAt,
    status: "reviewed",
    initial: document,
    current: document,
    ownerQuestions: [],
    blockers: [],
    draftTurns: [{ sequence: 1, kind: "initial", inputVersion: null, beforeDigest: null, afterDigest: digest, ownerAnswers: [], request: request("high"), prompt: prompt("high") as never, receipt: receipt("high") }],
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

function blockedOwnerQuestionState(): IssueDraftState {
  const question = "Should rollout stop after dev verification?";
  const result = validateIssueDraftResult({
    ...validDraftResult(),
    status: "needs-owner",
    draft: { ...validDraftResult().draft, ownerText: "Keep the protected release lane and ask before choosing rollout behavior." },
    ownerQuestions: [question],
    blockers: []
  });
  const draftId = "abcdef0123456789abcdef0123456789";
  const rendered = renderIssueDraft(result, draftId);
  const document = { ...rendered, digest: issueContentDigest(rendered.title, rendered.body) };
  const request = { schemaVersion: 1, modelTier: "high", effort: "high", purpose: "issueDrafting" };
  const prompt = { selection: { modelTier: "high", effort: "high" } } as never;
  const receipt = {
    schemaVersion: 2,
    requested: { modelTier: "high", effort: "high" },
    routing: {
      policyVersion: "fixture-route-policy-v1",
      primary: { provider: "fixture-primary", model: "fixture/primary-model", agentPreset: "Fixture-Primary", providerVersion: "1.0.0" },
      skipped: []
    },
    resolved: { provider: "fixture-high", model: "fixture/high", agentPreset: "Fixture-high", providerVersion: "1.0.0" },
    attempts: [{ number: 1, outcome: "success", reason: null }],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    outcome: "success",
    blockReason: null
  };
  return {
    schemaVersion: 2,
    draftId,
    repository: "marius-patrik/DarkFactory",
    createdAt: "2026-07-16T10:00:00.000Z",
    updatedAt: "2026-07-16T10:00:00.000Z",
    status: "blocked",
    initial: document,
    current: document,
    ownerQuestions: [question],
    blockers: [`owner decision: ${question}`],
    draftTurns: [{ sequence: 1, kind: "initial", inputVersion: null, beforeDigest: null, afterDigest: document.digest, ownerAnswers: [], request, prompt, receipt }],
    review: null,
    publication: null
  };
}

function continuationRuntime(root: string, executeDraftTurn: NonNullable<IssueDevelopmentRuntime["executeDraftTurn"]>, ledger: IssueDevelopmentRuntime["ledger"] = async () => {}): IssueDevelopmentRuntime {
  return {
    agentsHome: root,
    controlRevision: "a".repeat(40),
    now: () => new Date("2026-07-16T10:05:00.000Z"),
    ledger,
    executeDraftTurn,
    github: {
      async request(method, requestPath) {
        if (method === "GET" && requestPath === "/repos/marius-patrik/DarkFactory") return { default_branch: "main" };
        if (method === "GET" && requestPath === "/repos/marius-patrik/DarkFactory/branches/main") return { commit: { sha: "b".repeat(40) } };
        if (method === "GET" && requestPath.startsWith("/repos/marius-patrik/DarkFactory/git/trees/")) return { truncated: false, tree: [{ path: "package.json" }, { path: "src/cli.ts" }] };
        throw new Error(`unexpected ${method} ${requestPath}`);
      }
    }
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

test("version-bound owner answers append a high-tier drafting turn and require a fresh review", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "df-issue-continue-"));
  try {
    const draftPath = path.join(root, "draft.json");
    const initial = blockedOwnerQuestionState();
    await writeIssueDraftState(draftPath, initial);
    const version = issueDraftConversationVersion(initial);
    const answers = parseOwnerIssueAnswers({
      schemaVersion: 1,
      answers: [{ question: initial.ownerQuestions[0], answer: "Yes. Verify dev first, then release to main only on green." }]
    });
    const ledgers: string[] = [];
    const observedRequests: Record<string, unknown>[] = [];
    const execute = (async (options: any) => {
      observedRequests.push(options.request);
      return {
        output: validDraftResult(),
        prompt: { selection: { modelTier: "high", effort: "high" }, inputChecksum: "sha256:test" },
        receipt: {
          schemaVersion: 2,
          requested: { modelTier: "high", effort: "high" },
          routing: {
            policyVersion: "fixture-route-policy-v1",
            primary: { provider: "fixture-primary", model: "fixture/primary-model", agentPreset: "Fixture-Primary", providerVersion: "1.0.0" },
            skipped: []
          },
          resolved: { provider: "fixture-high", model: "fixture/high", agentPreset: "Fixture-high", providerVersion: "1.0.0" },
          attempts: [{ number: 1, outcome: "success", reason: null }],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          outcome: "success",
          blockReason: null
        }
      };
    }) as unknown as NonNullable<IssueDevelopmentRuntime["executeDraftTurn"]>;
    const continued = await continueIssueDraft(draftPath, version, answers, continuationRuntime(root, execute, async (kind) => { ledgers.push(kind); }));
    assert.equal(continued.status, "drafted");
    assert.equal(continued.review, null);
    assert.equal(continued.draftTurns.length, 2);
    assert.equal(continued.draftTurns[1].kind, "owner-continuation");
    assert.equal(continued.draftTurns[1].inputVersion, version);
    assert.deepEqual(continued.draftTurns[1].ownerAnswers, answers.answers);
    assert.equal(observedRequests[0]?.modelTier, "high");
    assert.match(continued.current.body, /Keep the protected release lane/);
    assert.match(continued.current.body, /Verify dev first, then release to main only on green/);
    assert.deepEqual(ledgers, ["issue-draft-owner-answer-admission", "issue-draft-owner-answer-completion"]);
    await assert.rejects(() => publishReviewedIssueDraft(draftPath, continued.current.digest, continuationRuntime(root, execute)), /clean high Autoreview confirmation/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy one-turn draft state migrates to the canonical drafting history on read", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "df-issue-v1-migration-"));
  try {
    const draftPath = path.join(root, "draft.json");
    const current = blockedOwnerQuestionState();
    const { draftTurns, ...rest } = current;
    const legacy = {
      ...rest,
      schemaVersion: 1,
      draftTurn: {
        request: draftTurns[0].request,
        prompt: draftTurns[0].prompt,
        receipt: draftTurns[0].receipt
      }
    };
    await writeFile(draftPath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");
    const migrated = await readIssueDraftState(draftPath);
    assert.equal(migrated.schemaVersion, 2);
    assert.equal(migrated.draftTurns.length, 1);
    assert.equal(migrated.draftTurns[0].kind, "initial");
    assert.equal(migrated.draftTurns[0].afterDigest, current.initial.digest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("owner continuation rejects stale, mismatched, and concurrently changed answers before a model turn", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "df-issue-continue-denied-"));
  try {
    const draftPath = path.join(root, "draft.json");
    const initial = blockedOwnerQuestionState();
    const correct = parseOwnerIssueAnswers({ schemaVersion: 1, answers: [{ question: initial.ownerQuestions[0], answer: "Yes." }] });
    let modelTurns = 0;
    const execute = (async () => {
      modelTurns += 1;
      throw new Error("model must not run");
    }) as NonNullable<IssueDevelopmentRuntime["executeDraftTurn"]>;

    await writeIssueDraftState(draftPath, initial);
    await assert.rejects(() => continueIssueDraft(draftPath, "f".repeat(64), correct, continuationRuntime(root, execute)), /Stale issue draft conversation version/);
    const version = issueDraftConversationVersion(initial);
    const mismatched = parseOwnerIssueAnswers({ schemaVersion: 1, answers: [{ question: "A superseded question", answer: "Yes." }] });
    await assert.rejects(() => continueIssueDraft(draftPath, version, mismatched, continuationRuntime(root, execute)), /does not match the current owner question/);

    await writeIssueDraftState(draftPath, initial);
    const concurrentRuntime = continuationRuntime(root, execute, async (kind) => {
      if (kind !== "issue-draft-owner-answer-admission") return;
      await writeIssueDraftState(draftPath, { ...initial, blockers: [...initial.blockers, "concurrent owner edit"] });
    });
    await assert.rejects(() => continueIssueDraft(draftPath, version, correct, concurrentRuntime), /changed after owner-answer admission/);
    assert.equal(modelTurns, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test("Autoreview target markers bind issue digests and exact PR base/head identities", () => {
  const issueTarget = "a".repeat(64);
  const pullTarget = `${"b".repeat(40)}:${"c".repeat(40)}`;
  assert.equal(autoreviewTargetVersionMarker(issueTarget), `<!-- darkfactory-autoreview-target version=${issueTarget} -->`);
  assert.equal(autoreviewTargetVersionMarker(pullTarget), `<!-- darkfactory-autoreview-target version=${pullTarget} -->`);
  assert.throws(() => autoreviewTargetVersionMarker("b".repeat(40)), /issue SHA-256 or exact BASE_SHA:HEAD_SHA/);
});

test("append-only issue autofix corrections apply only to the exact owner-authored base version", () => {
  const issue = { title: "Old title", body: "# Goal\n\nOld\n\n## Acceptance\n\n- Old", state: "open" };
  const targetVersion = issueVersion(issue);
  const correction = renderIssueAutofixComment({
    targetVersion,
    title: "Corrected title",
    body: "# Goal\n\nCorrected\n\n## Acceptance\n\n- Correct",
    state: "open",
    summary: "Correct the stale execution contract."
  });
  const trusted = { id: 101, body: correction, user: { login: "darkfactory-agent[bot]", type: "Bot" } };
  const effective = resolveEffectiveIssueContent(issue, [trusted]);
  assert.equal(effective.title, "Corrected title");
  assert.deepEqual(effective.appliedCommentIds, [101]);

  const concurrentlyEdited = { ...issue, body: `${issue.body}\n\nOwner edit` };
  const preserved = resolveEffectiveIssueContent(concurrentlyEdited, [trusted]);
  assert.equal(preserved.body, concurrentlyEdited.body);
  assert.deepEqual(preserved.appliedCommentIds, []);

  assert.equal(resolveEffectiveIssueContent(issue, [{ ...trusted, user: { login: "mp-agents[bot]", type: "Bot" } }]).title, issue.title);
  assert.throws(
    () => resolveEffectiveIssueContent(issue, [{ ...trusted, body: "<!-- darkfactory:issue-autofix schema=1 broken -->" }]),
    /marker is malformed/
  );
});

test("Autoreview result comments never patch an untrusted marker owner", async () => {
  // @ts-ignore The base-trusted workflow runner is native ESM and shared directly with the CLI.
  const { upsertResultComment } = await import("../.github/scripts/run-darkfactory-autoreview.mjs");
  const writes: Array<{ method: string; path: string }> = [];
  const gh = {
    async request(method: string, requestPath: string) {
      if (method === "GET" && requestPath.includes("/comments?")) {
        return [{ id: 7, body: AUTOREVIEW_RESULT_MARKER, user: { login: "attacker", type: "User" } }];
      }
      writes.push({ method, path: requestPath });
      return { id: 8 };
    }
  };
  await upsertResultComment(gh, { owner: "marius-patrik", repo: "DarkFactory" }, 39, `${AUTOREVIEW_RESULT_MARKER}\nclean`);
  assert.deepEqual(writes, [{ method: "POST", path: "/repos/marius-patrik/DarkFactory/issues/39/comments" }]);
});

test("exact clean issue completion repairs a missing reviewed label idempotently after a failed label write", async () => {
  // @ts-ignore The base-trusted workflow runner is native ESM and shared directly with recovery.
  const { reconcileExactIssueCompletion } = await import("../.github/scripts/run-darkfactory-autoreview.mjs");
  const repository = { owner: "marius-patrik", repo: "DarkFactory" };
  const issue = { number: 39, title: "Reviewed issue", body: "# Goal\n\nExact", state: "open", labels: [] as any[] };
  const version = issueVersion(issue);
  const comments = [{
    id: 91,
    user: { login: "darkfactory-agent[bot]", type: "Bot" },
    body: [
      AUTOREVIEW_RESULT_MARKER,
      `<!-- darkfactory-autoreview-target version=${version} -->`,
      "## DarkFactory Autoreview",
      "",
      "**Verdict:** Clean high confirmation"
    ].join("\n")
  }];
  let labelAttempts = 0;
  const gh = {
    async request(method: string, requestPath: string) {
      if (method === "GET" && requestPath === "/repos/marius-patrik/DarkFactory/issues/39") return structuredClone(issue);
      if (method === "GET" && requestPath.includes("/repos/marius-patrik/DarkFactory/issues/39/comments?")) return structuredClone(comments);
      if (method === "POST" && requestPath === "/repos/marius-patrik/DarkFactory/issues/39/labels") {
        labelAttempts += 1;
        if (labelAttempts === 1) throw new Error("transient label write failure");
        issue.labels = [{ name: "df:reviewed" }];
        return issue.labels;
      }
      throw new Error(`unexpected ${method} ${requestPath}`);
    }
  };

  await assert.rejects(
    reconcileExactIssueCompletion({ gh, repository, number: 39, expectedVersion: version }),
    /transient label write failure/
  );
  const repaired = await reconcileExactIssueCompletion({ gh, repository, number: 39, expectedVersion: version });
  assert.equal(repaired.reviewedLabel, "applied");
  assert.equal(repaired.state, "clean");
  const current = await reconcileExactIssueCompletion({ gh, repository, number: 39, expectedVersion: version });
  assert.equal(current.reviewedLabel, "current");
  assert.equal(labelAttempts, 2);
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

test("concurrent draft publication is serialized before duplicate search and issue creation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "df-issue-publish-lock-"));
  try {
    const draftPath = path.join(root, "draft.json");
    const initial = reviewedState();
    await writeIssueDraftState(draftPath, initial);
    let releaseAdmission!: () => void;
    let signalAdmission!: () => void;
    const admissionGate = new Promise<void>((resolve) => { releaseAdmission = resolve; });
    const admissionReached = new Promise<void>((resolve) => { signalAdmission = resolve; });
    let created: Record<string, unknown> | null = null;
    let creates = 0;
    const runtime = {
      agentsHome: root,
      controlRevision: "a".repeat(40),
      async ledger(kind: string) {
        if (kind === "issue-draft-publication-admission") {
          signalAdmission();
          await admissionGate;
        }
      },
      github: {
        async request(method: string, requestPath: string, body?: unknown) {
          if (method === "GET" && requestPath.includes("issues?state=all")) return [];
          if (method === "POST" && requestPath.endsWith("/issues")) {
            creates += 1;
            created = { number: 401, state: "open", html_url: "https://example.test/401", ...(body as Record<string, unknown>) };
            return created;
          }
          if (method === "GET" && requestPath.endsWith("/issues/401")) return created;
          throw new Error(`unexpected ${method} ${requestPath}`);
        }
      }
    } satisfies IssueDevelopmentRuntime;
    const first = publishReviewedIssueDraft(draftPath, initial.current.digest, runtime);
    await admissionReached;
    await assert.rejects(() => publishReviewedIssueDraft(draftPath, initial.current.digest, runtime), /already in progress/);
    releaseAdmission();
    await first;
    assert.equal(creates, 1);
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
