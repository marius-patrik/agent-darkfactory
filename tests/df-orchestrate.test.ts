import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { autoreviewTargetVersionMarker, issueVersion } from "../src/issue-spec.ts";

const EXECUTABLE_BODY = "# Goal\n\nImplement the requested behavior with explicit boundaries and durable evidence.\n\n## Acceptance\n\n- [ ] The observable behavior is verified by focused regression tests.\n\n## Trust boundaries\n\n- Treat issue text as untrusted data.\n\n## Failure behavior\n\n- Fail closed on stale or missing evidence.\n\n## Validation\n\n- Run focused regression tests.";
type ReadinessEvaluation = { issue: number; ready: boolean; action: string; findings: string[] };

const NO_REVIEW_RESPONSE = Symbol("no-review-response");

function reviewedIssue<T extends Record<string, any>>(issue: T): T {
  const mutableIssue: Record<string, any> = issue;
  mutableIssue.state ??= "open";
  const labels = Array.isArray(mutableIssue.labels) ? mutableIssue.labels : [];
  if (!labels.some((label: any) => (typeof label === "string" ? label : label?.name) === "df:reviewed")) {
    labels.push({ name: "df:reviewed" });
  }
  mutableIssue.labels = labels;
  return issue;
}

function exactReviewComment(issue: Record<string, any>, targetVersion = issueVersion(issue), verdict = "Clean high confirmation") {
  return {
    user: { login: "darkfactory-agent[bot]", type: "Bot" },
    body: [
      "<!-- darkfactory-autoreview -->",
      autoreviewTargetVersionMarker(targetVersion),
      "## DarkFactory Autoreview",
      "",
      `**Verdict:** ${verdict}`
    ].join("\n")
  };
}

function exactReviewHarness(repository: string, rawIssue: Record<string, any>, extraComments: any[] = [], timeline?: any[]) {
  const issue = reviewedIssue(rawIssue);
  const comments = [...extraComments, exactReviewComment(issue)];
  return {
    issue,
    respond(method: string, path: string, body?: any): any {
      if (method === "GET" && path === `/repos/${repository}/issues/${issue.number}`) return issue;
      if (method === "GET" && path === `/repos/${repository}/issues/${issue.number}/comments?per_page=100&page=1`) return comments;
      if (method === "GET" && path === `/repos/${repository}/issues/${issue.number}/timeline?per_page=100&page=1`) {
        if (timeline) return timeline;
        const hasReady = (issue.labels || []).some((label: any) => (typeof label === "string" ? label : label?.name) === "df:ready");
        return hasReady ? [labeledEvent("df:ready", "2026-07-16T12:00:00Z")] : [];
      }
      if (method === "POST" && path === `/repos/${repository}/issues/${issue.number}/labels`) {
        const current = new Set((issue.labels || []).map((label: any) => typeof label === "string" ? label : label?.name));
        for (const label of body?.labels || []) current.add(label);
        issue.labels = [...current].map((name) => ({ name }));
        return {};
      }
      const prefix = `/repos/${repository}/issues/${issue.number}/labels/`;
      if (method === "DELETE" && path.startsWith(prefix)) {
        const removed = decodeURIComponent(path.slice(prefix.length));
        issue.labels = (issue.labels || []).filter((label: any) => (typeof label === "string" ? label : label?.name) !== removed);
        return {};
      }
      return NO_REVIEW_RESPONSE;
    }
  };
}

function healthyReadiness() {
  return new Map([
    ["marius-patrik/example", { observable: true, doctorPerfect: true, gatesHealthy: true }],
    ["marius-patrik/other", { observable: true, doctorPerfect: true, gatesHealthy: true }]
  ]);
}

function healthyManagedProtection() {
  return {
    required_status_checks: {
      strict: true,
      checks: [
        { context: "Validate", app_id: 15368 },
        { context: "DarkFactory Autoreview", app_id: 15368 }
      ]
    },
    enforce_admins: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false }
  };
}

function healthyPolicy() {
  return {
    schemaVersion: 1,
    concurrency: { global: 10, perRepository: 10, perStream: 10 },
    waves: [{ name: "features", streams: ["default"] }],
    dashboard: { enabled: false, issueTitle: "Dashboard" }
  };
}

const HEALTHY_EVALUATION = {
  repositoryState: { observable: true, doctorPerfect: true, gatesHealthy: true },
  capacityAvailable: true
};

function blockedComment(createdAt: string) {
  return {
    body: "DarkFactory worker blocked.\n\nBlocker:\n\n```text\nfailure\n```",
    created_at: createdAt
  };
}

function labeledEvent(label: string, createdAt: string, actor: Record<string, unknown> = { login: "darkfactory-agent[bot]", type: "Bot" }) {
  return {
    event: "labeled",
    label: { name: label },
    created_at: createdAt,
    actor
  };
}

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("orchestration policy loading fails closed and accepts only the canonical schema", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { readOrchestrationPolicy } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-policy-test");
  const root = await mkdtemp(join(tmpdir(), "df-orchestration-policy-"));
  const policyPath = join(root, ".darkfactory", "orchestration.json");
  try {
    await assert.rejects(readOrchestrationPolicy(root), /Failed to read required JSON file/);
    await mkdir(join(root, ".darkfactory"), { recursive: true });
    await writeFile(policyPath, "{");
    await assert.rejects(readOrchestrationPolicy(root), /Invalid JSON/);
    await writeFile(policyPath, JSON.stringify({ schemaVersion: 2 }));
    await assert.rejects(readOrchestrationPolicy(root), /schemaVersion 1/);

    const policy = {
      schemaVersion: 1,
      concurrency: { global: 2, perRepository: 1, perStream: 1 },
      waves: [{ name: "features", streams: ["features", "default"] }],
      dashboard: { enabled: true, issueTitle: "Dashboard" }
    };
    await writeFile(policyPath, JSON.stringify(policy));
    assert.deepEqual(await readOrchestrationPolicy(root), policy);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("targeted issue readiness uses the full shared fleet, capacity, and exact Autoreview evaluator without mutation", async () => {
  // @ts-ignore Native ESM workflow helper is exercised directly.
  const { evaluateTargetIssueReadiness } = await import("../.github/scripts/df-orchestrate.mjs?unit=targeted-readiness-test");
  const repository = "marius-patrik/example";
  const review = exactReviewHarness(repository, {
    number: 42,
    title: "Implement exact targeted readiness",
    body: EXECUTABLE_BODY,
    labels: []
  });
  const calls: Array<{ method: string; path: string }> = [];
  const gh = {
    async request(method: string, path: string, body?: unknown) {
      calls.push({ method, path });
      const response = review.respond(method, path, body);
      if (response !== NO_REVIEW_RESPONSE) return response;
      if (method === "GET" && path === `/repos/${repository}/issues?state=open&per_page=100&page=1`) return [review.issue];
      throw new Error(`unexpected ${method} ${path}`);
    }
  };
  const version = issueVersion(review.issue);
  const options = {
    registry: { schemaVersion: 1, repositories: { [repository]: { state: "active" } } },
    repositories: [{ full_name: repository, archived: false, disabled: false }],
    readinessByRepository: healthyReadiness(),
    policy: healthyPolicy(),
    expectedVersion: version
  };
  const result = await evaluateTargetIssueReadiness(
    gh,
    { owner: "marius-patrik", repo: "DarkFactory" },
    { owner: "marius-patrik", repo: "example" },
    42,
    options
  );
  assert.equal(result.ready, true);
  assert.equal(result.targetVersion, version);
  assert.equal(result.issueReview.ready, true);
  assert.equal(result.capacityAvailable, true);
  assert.equal(calls.some((call) => call.method !== "GET"), false);

  await assert.rejects(
    evaluateTargetIssueReadiness(
      gh,
      { owner: "marius-patrik", repo: "DarkFactory" },
      { owner: "marius-patrik", repo: "example" },
      42,
      { ...options, expectedVersion: "f".repeat(64) }
    ),
    /stale issue version/
  );
});

test("orchestrator dispatches open df:ready issues in active managed repos", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { orchestrate } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-test");
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const notFound = Object.assign(new Error("not found"), { status: 404 });
  const review = exactReviewHarness("marius-patrik/example", {
    number: 42,
    title: "Directly queued implementation",
    body: EXECUTABLE_BODY,
    labels: [{ name: "df:ready" }]
  });

  const gh = {
    async graphql() {
      return {
        repository: {
          pullRequests: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: []
          }
        }
      };
    },
    async request(method: string, path: string, body?: unknown) {
      calls.push({ method, path, body });
      const reviewResponse = review.respond(method, path, body);
      if (reviewResponse !== NO_REVIEW_RESPONSE) return reviewResponse;

      if (method === "GET" && path === "/repos/marius-patrik/example/issues?state=open&per_page=100&page=1") {
        return [review.issue];
      }
      if (method === "GET" && path === "/repos/marius-patrik/example/issues?state=open&per_page=100&page=2") {
        return [];
      }
      if (method === "GET" && path === "/repos/marius-patrik/example") {
        return { default_branch: "main", allow_auto_merge: true };
      }
      if (method === "GET" && path === "/repos/marius-patrik/example/git/ref/heads/dev") {
        throw notFound;
      }
      if (method === "GET" && path === "/repos/marius-patrik/example/branches/main/protection") {
        return healthyManagedProtection();
      }
      if (method === "POST" && path === "/repos/marius-patrik/example/issues/42/labels") {
        return {};
      }
      if (method === "DELETE" && path === "/repos/marius-patrik/example/issues/42/labels/df%3Aready") {
        return null;
      }
      if (method === "POST" && path === "/repos/marius-patrik/DarkFactory/actions/workflows/df-work.yml/dispatches") {
        return null;
      }

      throw new Error(`Unexpected GitHub request: ${method} ${path}`);
    }
  };

  const result = await orchestrate({
    gh,
    controlRepo: { owner: "marius-patrik", repo: "DarkFactory" },
    readinessByRepository: healthyReadiness(),
    registry: { repositories: { "marius-patrik/example": { state: "active" } } },
    repositories: [{ full_name: "marius-patrik/example", archived: false, disabled: false }],
    writeLedger: false,
    updateDashboard: false,
    warn: () => {},
    log: () => {}
  });

  assert.deepEqual(result.dispatched, [{ repo: "marius-patrik/example", issue: 42, wave: "features", streams: ["default"] }]);
  assert.deepEqual(
    calls.find((call) => call.method === "POST" && call.path === "/repos/marius-patrik/example/issues/42/labels")?.body,
    { labels: ["df:running"] }
  );
  assert.ok(calls.some((call) => call.method === "DELETE" && call.path === "/repos/marius-patrik/example/issues/42/labels/df%3Aready"));
  assert.deepEqual(
    calls.find((call) => call.method === "POST" && call.path.endsWith("/actions/workflows/df-work.yml/dispatches"))?.body,
    { ref: "main", inputs: { repo: "marius-patrik/example", issue_number: "42" } }
  );
});

test("programmatic orchestration ignores ambient workflow dispatch scope", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { orchestrate } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-hermetic-dispatch-test");
  const previous = {
    repo: process.env.DF_TARGET_REPO,
    issue: process.env.DF_TARGET_ISSUE_NUMBER,
    source: process.env.DF_SOURCE_EVENT,
    payload: process.env.GITHUB_EVENT_PAYLOAD
  };
  process.env.DF_TARGET_REPO = "marius-patrik/example";
  process.env.DF_TARGET_ISSUE_NUMBER = "42";
  process.env.DF_SOURCE_EVENT = "workflow_dispatch";
  delete process.env.GITHUB_EVENT_PAYLOAD;
  const inspected: string[] = [];

  try {
    const result = await orchestrate({
      gh: {
        async request(method: string, path: string) {
          if (method === "GET" && /\/repos\/marius-patrik\/(example|other)\/issues\?state=open&per_page=100&page=1/.test(path)) {
            inspected.push(path);
            return [];
          }
          throw new Error(`Unexpected GitHub request: ${method} ${path}`);
        }
      },
      controlRepo: { owner: "marius-patrik", repo: "DarkFactory" },
      trigger: "schedule",
      readinessByRepository: healthyReadiness(),
      registry: { repositories: { "marius-patrik/example": { state: "active" }, "marius-patrik/other": { state: "active" } } },
      repositories: [
        { full_name: "marius-patrik/example", archived: false, disabled: false },
        { full_name: "marius-patrik/other", archived: false, disabled: false }
      ],
      writeLedger: false,
      updateDashboard: false,
      warn: () => {},
      log: () => {}
    });

    assert.equal(inspected.some((path) => path.includes("/marius-patrik/example/")), true);
    assert.equal(inspected.some((path) => path.includes("/marius-patrik/other/")), true);
    assert.deepEqual(result.dispatched, []);
  } finally {
    restoreEnvironment("DF_TARGET_REPO", previous.repo);
    restoreEnvironment("DF_TARGET_ISSUE_NUMBER", previous.issue);
    restoreEnvironment("DF_SOURCE_EVENT", previous.source);
    restoreEnvironment("GITHUB_EVENT_PAYLOAD", previous.payload);
  }
});

test("orchestrator does not dispatch issues that already have an open worker PR", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { orchestrate } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-existing-pr-test");
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const review = exactReviewHarness("marius-patrik/example", {
    number: 8,
    title: "Existing worker PR",
    body: EXECUTABLE_BODY,
    labels: [{ name: "df:ready" }]
  });

  const gh = {
    async graphql() {
      return {
        repository: {
          pullRequests: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: "PR_21",
                number: 21,
                title: "Worker PR",
                body: "<!-- dark-factory:worker-pr issue=8 -->\n\nCloses #8",
                url: "https://github.com/marius-patrik/example/pull/21",
                headRefName: "df/8-worker",
                baseRefName: "main",
                headRepository: { owner: { login: "marius-patrik" }, name: "example" },
                author: { __typename: "Bot", login: "darkfactory-agent" }
              }
            ]
          }
        }
      };
    },
    async request(method: string, path: string, body?: unknown) {
      calls.push({ method, path, body });
      const reviewResponse = review.respond(method, path, body);
      if (reviewResponse !== NO_REVIEW_RESPONSE) return reviewResponse;

      if (method === "GET" && path === "/repos/marius-patrik/example/issues?state=open&per_page=100&page=1") {
        return [review.issue];
      }
      if (method === "GET" && path === "/repos/marius-patrik/example/issues?state=open&per_page=100&page=2") {
        return [];
      }
      if (method === "POST" && path === "/repos/marius-patrik/example/issues/8/labels") return {};
      if (method === "DELETE" && path === "/repos/marius-patrik/example/issues/8/labels/df%3Aready") return {};

      throw new Error(`Unexpected GitHub request: ${method} ${path}`);
    }
  };

  const result = await orchestrate({
    gh,
    controlRepo: { owner: "marius-patrik", repo: "DarkFactory" },
    readinessByRepository: healthyReadiness(),
    registry: { repositories: { "marius-patrik/example": { state: "active" } } },
    repositories: [{ full_name: "marius-patrik/example", archived: false, disabled: false }],
    writeLedger: false,
    updateDashboard: false,
    warn: () => {},
    log: () => {}
  });

  assert.deepEqual(result.dispatched, []);
  assert.equal(calls.some((call) => call.path.endsWith("/actions/workflows/df-work.yml/dispatches")), false);
  assert.deepEqual(
    calls.find((call) => call.method === "POST" && call.path === "/repos/marius-patrik/example/issues/8/labels")?.body,
    { labels: ["df:running"] }
  );
  assert.ok(calls.some((call) => call.method === "DELETE" && call.path === "/repos/marius-patrik/example/issues/8/labels/df%3Aready"));
});

test("orchestrator selects ready issues by priority and blocked-by state", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { blockedByIssueNumbers, selectDispatchableIssues } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-scheduler-test");

  assert.deepEqual(blockedByIssueNumbers("Blocked-by: #61, #63\nBlocked-by: owner/repo#70"), [61, 63, 70]);
  assert.equal(Number.isNaN(blockedByIssueNumbers("Blocked-by: waiting for owner")[0]), true);

  const selected = selectDispatchableIssues([
    {
      number: 10,
      body: "",
      labels: [{ name: "df:ready" }, { name: "P2" }, { name: "stream:docs" }]
    },
    {
      number: 11,
      body: "## Sequencing\n\nBlocked-by: #9",
      labels: [{ name: "df:ready" }, { name: "P0" }, { name: "stream:core" }]
    },
    {
      number: 9,
      body: "",
      labels: [{ name: "df:running" }, { name: "stream:core" }]
    },
    {
      number: 12,
      body: "",
      labels: [{ name: "df:ready" }, { name: "P1" }, { name: "stream:docs" }]
    },
    {
      number: 13,
      body: "",
      labels: [{ name: "df:ready" }, { name: "P0" }, { name: "stream:ui" }]
    },
    {
      number: 14,
      body: "Blocked-by: #99",
      labels: [{ name: "df:ready" }, { name: "P0" }, { name: "stream:api" }]
    },
    {
      number: 15,
      body: "Blocked-by: #99, #12",
      labels: [{ name: "df:ready" }, { name: "P0" }, { name: "stream:ops" }]
    },
    {
      number: 16,
      body: "Blocked-by: owner/repo#99, owner/repo#98",
      labels: [{ name: "df:ready" }, { name: "P0" }, { name: "stream:review" }]
    },
    {
      number: 17,
      body: "Blocked-by: waiting for owner",
      labels: [{ name: "df:ready" }, { name: "P0" }, { name: "stream:unsafe" }]
    },
    {
      number: 18,
      body: "",
      labels: [{ name: "df:ready" }, { name: "df:ask-owner" }, { name: "P0" }, { name: "stream:owner" }]
    }
  ]);

  // Issue 16 is held: explicit cross-repo refs never resolve without a
  // managed snapshot index proving the referenced issues are closed.
  // Issue 18 is held: owner-decision lanes must not dispatch until the
  // df:ask-owner escalation label is cleared.
  assert.deepEqual(
    selected.map((issue: { number: number }) => issue.number),
    [13, 14, 12, 10]
  );
});

test("readiness evaluator accepts a bounded executable issue contract", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { evaluateIssueReadiness } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-readiness-positive-test");
  const result = evaluateIssueReadiness({
    number: 40,
    title: "Implement bounded readiness",
    body: EXECUTABLE_BODY,
    labels: [{ name: "P1" }]
  }, { currentRepoOpenIssueNumbers: new Set(), ...HEALTHY_EVALUATION });

  assert.equal(result.ready, true);
  assert.deepEqual(result.findings, []);
});

test("issue Autoreview admission accepts exact clean or auditable override and rejects stale, malformed, or untrusted evidence", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { evaluateIssueAutoreviewEvidence } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-issue-review-evidence-triplet-test");
  const issue = reviewedIssue({ number: 401, title: "Reviewed issue", body: EXECUTABLE_BODY, labels: [] });
  const clean = evaluateIssueAutoreviewEvidence(issue, [exactReviewComment(issue)], { dependencies: [] });
  const override = evaluateIssueAutoreviewEvidence(issue, [exactReviewComment(issue, issueVersion(issue), "Auditable owner override")], { dependencies: [] });
  const stale = evaluateIssueAutoreviewEvidence(issue, [exactReviewComment(issue, "0".repeat(64))], { dependencies: [] });
  const untrusted = evaluateIssueAutoreviewEvidence(issue, [{ ...exactReviewComment(issue), user: { login: "marius-patrik", type: "User" } }], { dependencies: [] });
  const malformed = evaluateIssueAutoreviewEvidence(issue, [{
    user: { login: "darkfactory-agent[bot]", type: "Bot" },
    body: "<!-- darkfactory:issue-autofix schema=1 target=bad -->"
  }], { dependencies: [] });

  assert.equal(clean.ready, true);
  assert.equal(override.ready, true);
  assert.equal(stale.ready, false);
  assert.ok(stale.findings.some((finding: { id: string }) => finding.id === "clean-review-evidence"));
  assert.equal(untrusted.ready, false);
  assert.ok(untrusted.findings.some((finding: { id: string }) => finding.id === "clean-review-evidence"));
  assert.equal(malformed.ready, false);
  assert.ok(malformed.findings.some((finding: { id: string }) => finding.id === "issue-review-evidence-invalid"));
});

test("dispatch-time admission revokes a cached ready label when the reviewed issue version changes", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { orchestrate } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-dispatch-review-race-test");
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const queued = reviewedIssue({
    number: 402,
    title: "Queued reviewed issue",
    body: EXECUTABLE_BODY,
    labels: [{ name: "df:ready" }]
  });
  const reviewComment = exactReviewComment(queued);
  const live = reviewedIssue({
    ...queued,
    body: `${EXECUTABLE_BODY}\n\nOwner edit after queue evaluation.`,
    labels: [{ name: "df:ready" }, { name: "df:reviewed" }]
  });
  const gh = {
    async graphql() {
      return { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } };
    },
    async request(method: string, path: string, body?: any) {
      calls.push({ method, path, body });
      if (method === "GET" && path === "/repos/marius-patrik/example/issues?state=open&per_page=100&page=1") return [queued];
      if (method === "GET" && path === "/repos/marius-patrik/example/issues/402") return live;
      if (method === "GET" && path === "/repos/marius-patrik/example/issues/402/comments?per_page=100&page=1") return [reviewComment];
      if (method === "GET" && path === "/repos/marius-patrik/example/issues/402/timeline?per_page=100&page=1") return [labeledEvent("df:ready", "2026-07-16T10:00:00Z")];
      if (method === "DELETE" && path === "/repos/marius-patrik/example/issues/402/labels/df%3Aready") return {};
      throw new Error(`Unexpected GitHub request: ${method} ${path}`);
    }
  };

  const result = await orchestrate({
    gh,
    controlRepo: { owner: "marius-patrik", repo: "DarkFactory" },
    readinessByRepository: healthyReadiness(),
    registry: { repositories: { "marius-patrik/example": { state: "active" } } },
    repositories: [{ full_name: "marius-patrik/example", archived: false, disabled: false }],
    writeLedger: false,
    updateDashboard: false,
    warn: () => {},
    log: () => {}
  });

  assert.deepEqual(result.dispatched, []);
  assert.ok(calls.some((call) => call.method === "GET" && call.path === "/repos/marius-patrik/example/issues/402"));
  assert.ok(calls.some((call) => call.method === "DELETE" && call.path.endsWith("/labels/df%3Aready")));
  assert.equal(calls.some((call) => call.path.endsWith("/actions/workflows/df-work.yml/dispatches")), false);
});

test("dispatch-time admission requires the exact referenced dependency to be a closed issue", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { revalidateDispatchAdmission } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-dispatch-dependency-identity-test");
  const issue = reviewedIssue({
    number: 403,
    title: "Dependency-bound reviewed issue",
    body: `${EXECUTABLE_BODY}\n\n## Sequencing\n\nBlocked-by: #9`,
    labels: [{ name: "df:ready" }]
  });
  const calls: Array<{ method: string; path: string }> = [];
  const gh = {
    async request(method: string, path: string) {
      calls.push({ method, path });
      if (method === "GET" && path === "/repos/marius-patrik/example/issues/403") return issue;
      if (method === "GET" && path === "/repos/marius-patrik/example/issues/403/comments?per_page=100&page=1") return [exactReviewComment(issue)];
      if (method === "GET" && path === "/repos/marius-patrik/example/issues/9") {
        return { number: 10, state: "closed" };
      }
      throw new Error(`Unexpected GitHub request: ${method} ${path}`);
    }
  };

  const evaluation = await revalidateDispatchAdmission(gh, { owner: "marius-patrik", repo: "example" }, 403, {
    repositoryState: HEALTHY_EVALUATION.repositoryState,
    knownRepositories: new Set(["marius-patrik/example"])
  });

  assert.equal(evaluation.ready, false);
  assert.ok(evaluation.findings.some((finding: { id: string }) => finding.id === "blocked-by-open"));
  assert.ok(calls.some((call) => call.path === "/repos/marius-patrik/example/issues/9"));
});

test("readiness fails closed on doctor, gate, capacity, and missing snapshot disagreement", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { evaluateIssueReadiness } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-readiness-state-triplet-test");
  const issue = { number: 400, title: "Implement bounded readiness", body: EXECUTABLE_BODY, labels: [] };
  const doctor = evaluateIssueReadiness(issue, { currentRepoOpenIssueNumbers: new Set(), repositoryState: { observable: true, doctorPerfect: false, gatesHealthy: true }, capacityAvailable: true });
  const gates = evaluateIssueReadiness(issue, { currentRepoOpenIssueNumbers: new Set(), repositoryState: { observable: true, doctorPerfect: true, gatesHealthy: false }, capacityAvailable: true });
  const missing = evaluateIssueReadiness(issue, { currentRepoOpenIssueNumbers: new Set(), capacityAvailable: true });
  const capacity = evaluateIssueReadiness(issue, { currentRepoOpenIssueNumbers: new Set(), repositoryState: HEALTHY_EVALUATION.repositoryState, capacityAvailable: false });
  assert.ok(doctor.findings.some((finding: { id: string }) => finding.id === "doctor-not-perfect"));
  assert.ok(gates.findings.some((finding: { id: string }) => finding.id === "gates-unhealthy"));
  assert.ok(missing.findings.some((finding: { id: string }) => finding.id === "repository-state-unobservable"));
  assert.ok(capacity.findings.some((finding: { id: string }) => finding.id === "capacity-exhausted"));
});

test("readiness evaluator rejects and explains a contentless issue contract", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { evaluateIssueReadiness } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-readiness-negative-test");
  const result = evaluateIssueReadiness({
    number: 41,
    title: "Alignment",
    body: "## Goal\n\nKeep implementation aligned.",
    labels: [{ name: "df:ready" }]
  }, { currentRepoOpenIssueNumbers: new Set() });

  assert.equal(result.ready, false);
  assert.ok(result.findings.some((finding: { id: string }) => finding.id === "acceptance-missing"));
  assert.ok(result.findings.some((finding: { id: string }) => finding.id === "contentless-boilerplate"));
});

test("readiness evaluator treats df:no-dispatch as categorical even for a valid contract", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { evaluateIssueReadiness, selectDispatchableIssues, shouldAutoReadySequencedIssue } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-readiness-edge-test");
  const issue = {
    number: 42,
    title: "Owner-executed contract",
    body: EXECUTABLE_BODY,
    labels: [{ name: "df:ready" }, { name: "df:no-dispatch" }]
  };

  assert.equal(evaluateIssueReadiness(issue, { currentRepoOpenIssueNumbers: new Set() }).ready, false);
  assert.deepEqual(selectDispatchableIssues([issue], { enforceContract: true }), []);
  assert.equal(shouldAutoReadySequencedIssue({ ...issue, body: `${EXECUTABLE_BODY}\n\nBlocked-by: #1`, labels: [{ name: "df:no-dispatch" }] }, { currentRepoOpenIssueNumbers: new Set() }), false);
});

test("readiness revokes a human or near-miss ready label before any full-predicate reapplication", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { currentReadyLabelOwnership, evaluateIssueReadinessLabels } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-ready-label-reconciliation-test");
  async function run(repositoryState: Record<string, unknown>, actor: Record<string, unknown>) {
    const issue = reviewedIssue({ number: 71, title: "Trust the ready owner", body: EXECUTABLE_BODY, state: "open", labels: [{ name: "df:ready" }] });
    const timeline = [labeledEvent("df:ready", "2026-07-16T10:00:00Z", actor)];
    const calls: Array<{ method: string; path: string }> = [];
    const gh = {
      async request(method: string, path: string, body?: any) {
        calls.push({ method, path });
        if (method === "GET" && path.endsWith("/issues/71/timeline?per_page=100&page=1")) return timeline;
        if (method === "GET" && path.endsWith("/issues/71/comments?per_page=100&page=1")) return [exactReviewComment(issue)];
        if (method === "DELETE" && path.endsWith("/issues/71/labels/df%3Aready")) {
          issue.labels = issue.labels.filter((label: any) => label.name !== "df:ready");
          timeline.push({ ...labeledEvent("df:ready", "2026-07-16T10:01:00Z"), event: "unlabeled" });
          return {};
        }
        if (method === "POST" && path.endsWith("/labels") && !path.includes("/issues/")) return {};
        if (method === "POST" && path.endsWith("/issues/71/labels")) {
          issue.labels.push({ name: "df:ready" });
          timeline.push(labeledEvent("df:ready", "2026-07-16T10:02:00Z"));
          return {};
        }
        throw new Error(`Unexpected GitHub request: ${method} ${path}`);
      }
    };
    const evaluations = await evaluateIssueReadinessLabels(gh, [{
      repository: { owner: "marius-patrik", repo: "example" },
      openIssues: [issue]
    }], () => {}, {
      policy: healthyPolicy(),
      readinessByRepository: new Map([["marius-patrik/example", repositoryState]])
    });
    return { issue, timeline, calls, evaluation: evaluations[0], currentReadyLabelOwnership };
  }

  const healthy = await run({ observable: true, doctorPerfect: true, gatesHealthy: true }, { login: "marius-patrik", type: "User" });
  assert.equal(healthy.evaluation.action, "replaced-untrusted-ready");
  assert.equal(healthy.currentReadyLabelOwnership(healthy.timeline).trusted, true);
  const removal = healthy.calls.findIndex((call) => call.method === "DELETE" && call.path.endsWith("df%3Aready"));
  const reapply = healthy.calls.findIndex((call) => call.method === "POST" && call.path.endsWith("/issues/71/labels"));
  assert.ok(removal >= 0 && reapply > removal);

  const degraded = await run({ observable: true, doctorPerfect: false, gatesHealthy: true }, { login: "darkfactory-agent", type: "Bot" });
  assert.equal(degraded.evaluation.action, "revoked-untrusted-ready");
  assert.equal(degraded.issue.labels.some((label: any) => label.name === "df:ready"), false);
  assert.equal(degraded.calls.some((call) => call.method === "POST" && call.path.endsWith("/issues/71/labels")), false);
});

test("dispatch admission accepts current App ownership and rejects human or stale ready events", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { revalidateDispatchAdmission } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-ready-label-dispatch-admission-test");
  async function admit(timeline: any[]) {
    const issue = reviewedIssue({ number: 72, title: "Dispatch only trusted ready", body: EXECUTABLE_BODY, state: "open", labels: [{ name: "df:ready" }] });
    const gh = {
      async request(method: string, path: string) {
        if (method === "GET" && path.endsWith("/issues/72")) return issue;
        if (method === "GET" && path.endsWith("/issues/72/comments?per_page=100&page=1")) return [exactReviewComment(issue)];
        if (method === "GET" && path.endsWith("/issues/72/timeline?per_page=100&page=1")) return timeline;
        throw new Error(`Unexpected GitHub request: ${method} ${path}`);
      }
    };
    return await revalidateDispatchAdmission(gh, { owner: "marius-patrik", repo: "example" }, 72, {
      repositoryState: { observable: true, doctorPerfect: true, gatesHealthy: true },
      knownRepositories: new Set(["marius-patrik/example"])
    });
  }

  assert.equal((await admit([labeledEvent("df:ready", "2026-07-16T10:00:00Z")])).ready, true);
  const human = await admit([labeledEvent("df:ready", "2026-07-16T10:00:00Z", { login: "marius-patrik", type: "User" })]);
  assert.equal(human.ready, false);
  assert.ok(human.findings.some((finding: any) => finding.id === "ready-label-untrusted"));
  const stale = await admit([
    labeledEvent("df:ready", "2026-07-16T10:00:00Z"),
    { ...labeledEvent("df:ready", "2026-07-16T10:01:00Z"), event: "unlabeled" }
  ]);
  assert.equal(stale.ready, false);
  assert.ok(stale.findings.some((finding: any) => finding.id === "ready-label-untrusted"));
});

test("orchestrator holds and escalates unknown cross-repo Blocked-by references", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { selectDispatchableIssues, ownerDecisionEscalation } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-cross-repo-test");

  const repository = { full_name: "marius-patrik/example" };
  const knownRepositories = new Set(["marius-patrik/example", "marius-patrik/managed-peer"]);
  const openIssueIndex = new Set(["marius-patrik/managed-peer#5"]);

  const issues = [
    {
      number: 20,
      body: "Blocked-by: marius-patrik/managed-peer#4",
      labels: [{ name: "df:ready" }, { name: "P1" }, { name: "stream:a" }]
    },
    {
      number: 21,
      body: "Blocked-by: marius-patrik/managed-peer#5",
      labels: [{ name: "df:ready" }, { name: "P1" }, { name: "stream:b" }]
    },
    {
      number: 22,
      body: "Blocked-by: someone-else/unknown-repo#7",
      labels: [{ name: "df:ready" }, { name: "P1" }, { name: "stream:c" }]
    },
    {
      number: 27,
      body: "Blocked-by: waiting for owner",
      labels: [{ name: "df:ready" }, { name: "P1" }, { name: "stream:e" }]
    },
    {
      number: 28,
      body: "Blocked-by: #29 or ask owner",
      labels: [{ name: "df:ready" }, { name: "P1" }, { name: "stream:f" }]
    }
  ];

  const selected = selectDispatchableIssues(issues, { repository, openIssueIndex, knownRepositories });

  // Malformed dependency metadata always yields marker refs from the parser
  // (never an empty list), so ready issues with malformed or partially
  // malformed Blocked-by lines are held from dispatch.
  assert.equal(selected.some((issue: { number: number }) => issue.number === 27), false);
  assert.equal(selected.some((issue: { number: number }) => issue.number === 28), false);

  // #20: known repo, issue absent from the open index (positively observed closed) -> dispatchable.
  // #21: known repo, issue still open -> held.
  // #22: unknown repo -> held, never dispatched past an unverifiable blocker.
  assert.deepEqual(
    selected.map((issue: { number: number }) => issue.number),
    [20]
  );

  const escalation = ownerDecisionEscalation(issues[2], knownRepositories);
  assert.equal(escalation?.reason, "unknown-cross-repo-blocked-by");
  assert.ok(escalation?.detail.includes("someone-else/unknown-repo#7"));

  // Known-repo cross references and same-repo references do not escalate.
  assert.equal(ownerDecisionEscalation(issues[0], knownRepositories), null);
  const sameRepoIssue = {
    number: 23,
    body: "Blocked-by: #9",
    labels: [{ name: "df:ready" }, { name: "P1" }]
  };
  assert.equal(ownerDecisionEscalation(sameRepoIssue, knownRepositories), null);

  // A Blocked-by line with leftover text beyond refs and separators is
  // ambiguous even when it contains a parseable reference: it escalates and
  // is never dispatched on the partially-parsed dependency.
  const partiallyMalformed = {
    number: 24,
    body: "Blocked-by: #12 or ask owner",
    labels: [{ name: "df:ready" }, { name: "P1" }, { name: "stream:d" }]
  };
  assert.equal(ownerDecisionEscalation(partiallyMalformed, knownRepositories)?.reason, "ambiguous-blocked-by");
  assert.deepEqual(
    selectDispatchableIssues([partiallyMalformed], { repository, openIssueIndex, knownRepositories }),
    []
  );
});

test("sequencing pass auto-readies scoped issues only when blockers are resolved", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { autoReadySequencedIssues } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-auto-ready-test");
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const review = exactReviewHarness("marius-patrik/example", {
    number: 20,
    title: "Sequenced",
    body: `${EXECUTABLE_BODY}\n\n## Sequencing\n\nBlocked-by: #19`,
    labels: [{ name: "P0" }]
  });
  const snapshots = [
    {
      repository: { owner: "marius-patrik", repo: "example" },
      openIssues: [
        review.issue,
        { number: 21, title: "Backlog", body: "Plain backlog issue.", labels: [{ name: "P1" }] },
        { number: 22, title: "Still blocked", body: "Blocked-by: #23", labels: [{ name: "P0" }] },
        { number: 23, title: "Open predecessor", body: "", labels: [{ name: "df:running" }] },
        { number: 24, title: "Malformed", body: "Blocked-by: #19 or ask owner", labels: [{ name: "P0" }] },
        { number: 25, title: "Unknown cross repo", body: "Blocked-by: someone-else/unknown#1", labels: [{ name: "P0" }] },
        { number: 26, title: "Planned without blockers", body: "<!-- df-prd:some-item -->\nNo dependencies.", labels: [{ name: "df:planned" }, { name: "P1" }] }
      ]
    }
  ];

  const gh = {
    async request(method: string, path: string, body?: unknown) {
      calls.push({ method, path, body });
      const reviewResponse = review.respond(method, path, body);
      if (reviewResponse !== NO_REVIEW_RESPONSE) return reviewResponse;

      if (method === "GET" && path === "/repos/marius-patrik/example/issues/20/timeline?per_page=100&page=1") return [];
      if (method === "POST" && path === "/repos/marius-patrik/example/labels") return {};
      throw new Error(`Unexpected GitHub request: ${method} ${path}`);
    }
  };

  const autoReadied = await autoReadySequencedIssues(gh, snapshots, () => {}, {
    policy: healthyPolicy(),
    readinessByRepository: healthyReadiness()
  });

  assert.deepEqual(autoReadied, [{ repo: "marius-patrik/example", issue: 20 }]);
  assert.ok(snapshots[0].openIssues[0].labels.some((label: { name: string }) => label.name === "df:ready"));
  assert.equal(calls.some((call) => call.path === "/repos/marius-patrik/example/issues/21/labels"), false);
  assert.equal(calls.some((call) => call.path === "/repos/marius-patrik/example/issues/22/labels"), false);
  assert.equal(calls.some((call) => call.path === "/repos/marius-patrik/example/issues/24/labels"), false);
  assert.equal(calls.some((call) => call.path === "/repos/marius-patrik/example/issues/25/labels"), false);
  // Spec (#168): the pass is for Blocked-by successors only — planned/PRD
  // issues with no dependency references are queued by planning, never here.
  assert.equal(calls.some((call) => call.path === "/repos/marius-patrik/example/issues/26/labels"), false);
});

test("targeted sequencing runs resolve blockers against the full snapshot", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { autoReadySequencedIssues } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-auto-ready-scoped-test");
  const calls: Array<{ method: string; path: string }> = [];
  const snapshots = [
    {
      repository: { owner: "marius-patrik", repo: "example" },
      openIssues: [
        { number: 30, title: "Target", body: "Blocked-by: #31", labels: [{ name: "P0" }] },
        { number: 31, title: "Open predecessor", body: "", labels: [{ name: "df:running" }] }
      ]
    }
  ];

  const gh = {
    async request(method: string, path: string) {
      calls.push({ method, path });
      throw new Error(`Unexpected GitHub request: ${method} ${path}`);
    }
  };

  // Event-scoped run targeting #30: its predecessor #31 is open in the full
  // snapshot, so #30 must NOT be auto-readied even though the run only
  // considers #30 as a candidate.
  const autoReadied = await autoReadySequencedIssues(gh, snapshots, () => {}, {
    targetIssue: { repository: { owner: "marius-patrik", repo: "example" }, issueNumber: 30 },
    policy: healthyPolicy(),
    readinessByRepository: healthyReadiness()
  });

  assert.deepEqual(autoReadied, []);
  assert.equal(calls.length, 0);
});

test("sequencing pass does not create an owner-reset ready label over repeated failures", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { autoReadySequencedIssues } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-auto-ready-reset-test");
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const snapshots = [
    {
      repository: { owner: "marius-patrik", repo: "example" },
      openIssues: [
        { number: 31, title: "Sequenced retry", body: "Blocked-by: #30", labels: [{ name: "P0" }] }
      ]
    }
  ];

  const gh = {
    async request(method: string, path: string, body?: unknown) {
      calls.push({ method, path, body });

      if (method === "GET" && path === "/repos/marius-patrik/example/issues/31/comments?per_page=100&page=1") {
        return [
          blockedComment("2026-07-06T10:00:00Z"),
          blockedComment("2026-07-06T10:10:00Z"),
          blockedComment("2026-07-06T10:20:00Z")
        ];
      }
      if (method === "GET" && path === "/repos/marius-patrik/example/issues/31/comments?per_page=100&page=2") return [];
      if (method === "GET" && path === "/repos/marius-patrik/example/issues/31/timeline?per_page=100&page=1") return [];

      throw new Error(`Unexpected GitHub request: ${method} ${path}`);
    }
  };

  const autoReadied = await autoReadySequencedIssues(gh, snapshots, () => {}, {
    policy: healthyPolicy(),
    readinessByRepository: healthyReadiness()
  });

  assert.deepEqual(autoReadied, []);
  assert.equal(calls.some((call) => call.method === "POST" && call.path === "/repos/marius-patrik/example/issues/31/labels"), false);
  assert.equal(snapshots[0].openIssues[0].labels.some((label: { name: string }) => label.name === "df:ready"), false);
});

test("sequencing pass refuses a stale issue Autoreview even after every blocker closes", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { autoReadySequencedIssues } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-auto-ready-stale-review-test");
  const issue = reviewedIssue({
    number: 32,
    title: "Stale reviewed successor",
    body: `${EXECUTABLE_BODY}\n\n## Sequencing\n\nBlocked-by: #31`,
    labels: [{ name: "P0" }]
  });
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const gh = {
    async request(method: string, path: string, body?: any) {
      calls.push({ method, path, body });
      if (method === "GET" && path === "/repos/marius-patrik/example/issues/32/comments?per_page=100&page=1") {
        return [exactReviewComment(issue, "0".repeat(64))];
      }
      if (method === "GET" && path === "/repos/marius-patrik/example/issues/32/timeline?per_page=100&page=1") return [];
      throw new Error(`Unexpected GitHub request: ${method} ${path}`);
    }
  };
  const autoReadied = await autoReadySequencedIssues(gh, [{
    repository: { owner: "marius-patrik", repo: "example" },
    openIssues: [issue]
  }], () => {}, {
    policy: healthyPolicy(),
    readinessByRepository: healthyReadiness()
  });

  assert.deepEqual(autoReadied, []);
  assert.equal(calls.some((call) => call.method === "POST" && call.path.endsWith("/issues/32/labels")), false);
});

test("orchestration plan applies wave gates and cross-repo concurrency caps", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { buildOrchestrationPlan } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-l6-plan-test");

  const policy = {
    schemaVersion: 1,
    concurrency: { global: 2, perRepository: 1, perStream: 1 },
    waves: [
      { name: "hygiene", streams: ["hygiene"] },
      { name: "enforcement", streams: ["enforcement"] },
      { name: "features", streams: ["features", "default"] }
    ],
    dashboard: { enabled: true, issueTitle: "Dashboard" }
  };
  const plan = buildOrchestrationPlan([
    {
      repository: { owner: "marius-patrik", repo: "pkg-a" },
      openIssues: [
        { number: 1, title: "Hygiene", body: "", labels: [{ name: "roadmap" }, { name: "df:blocked" }, { name: "stream:hygiene" }] },
        { number: 2, title: "Feature", body: "", labels: [{ name: "df:ready" }, { name: "P0" }, { name: "stream:features" }] }
      ]
    },
    {
      repository: { owner: "marius-patrik", repo: "pkg-b" },
      openIssues: [
        { number: 3, title: "Enforcement", body: "", labels: [{ name: "df:ready" }, { name: "P1" }, { name: "stream:enforcement" }] },
        { number: 4, title: "Feature", body: "", labels: [{ name: "df:ready" }, { name: "P0" }, { name: "stream:features" }] },
        { number: 6, title: "Hygiene", body: "", labels: [{ name: "df:ready" }, { name: "P1" }, { name: "stream:hygiene" }] }
      ]
    },
    {
      repository: { owner: "marius-patrik", repo: "pkg-c" },
      openIssues: [
        { number: 5, title: "Feature", body: "", labels: [{ name: "df:ready" }, { name: "P0" }, { name: "stream:features" }] }
      ]
    }
  ], policy);

  assert.deepEqual(
    plan.candidates.map((candidate: { repository: { repo: string }; issue: { number: number }; wave: string }) => [
      candidate.repository.repo,
      candidate.issue.number,
      candidate.wave
    ]),
    [["pkg-b", 6, "hygiene"]]
  );
  assert.equal(plan.gate_wave, "hygiene");
  assert.deepEqual(
    plan.repositories.map((repository: { repo: string; gate_wave: string; repository_gate_wave: string }) => [
      repository.repo,
      repository.gate_wave,
      repository.repository_gate_wave
    ]),
    [
      ["marius-patrik/pkg-a", "hygiene", "features"],
      ["marius-patrik/pkg-b", "hygiene", "hygiene"],
      ["marius-patrik/pkg-c", "hygiene", "features"]
    ]
  );
});

test("orchestration plan enforces stream caps without single-lane prefiltering", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { buildOrchestrationPlan } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-stream-cap-test");

  const policy = {
    schemaVersion: 1,
    concurrency: { global: 5, perRepository: 5, perStream: 3 },
    waves: [{ name: "features", streams: ["features", "default"] }],
    dashboard: { enabled: true, issueTitle: "Dashboard" }
  };

  const plan = buildOrchestrationPlan([
    {
      repository: { owner: "marius-patrik", repo: "pkg-a" },
      openIssues: [
        { number: 1, title: "Feature A", body: "", labels: [{ name: "df:ready" }, { name: "P0" }, { name: "stream:features" }] },
        { number: 2, title: "Feature B", body: "", labels: [{ name: "df:ready" }, { name: "P0" }, { name: "stream:features" }] },
        { number: 3, title: "Feature C", body: "", labels: [{ name: "df:ready" }, { name: "P0" }, { name: "stream:features" }] }
      ]
    }
  ], policy);

  assert.deepEqual(
    plan.candidates.map((candidate: { issue: { number: number } }) => candidate.issue.number),
    [1, 2, 3]
  );
  assert.equal(plan.repositories[0].dispatchable, 3);
});

test("orchestration plan counts running stream occupancy against stream caps", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { buildOrchestrationPlan } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-running-stream-cap-test");

  const policy = {
    schemaVersion: 1,
    concurrency: { global: 5, perRepository: 5, perStream: 2 },
    waves: [{ name: "features", streams: ["features", "default"] }],
    dashboard: { enabled: true, issueTitle: "Dashboard" }
  };

  const plan = buildOrchestrationPlan([
    {
      repository: { owner: "marius-patrik", repo: "pkg-a" },
      openIssues: [
        { number: 1, title: "Running", body: "", labels: [{ name: "df:running" }, { name: "stream:features" }] },
        { number: 2, title: "Feature A", body: "", labels: [{ name: "df:ready" }, { name: "P0" }, { name: "stream:features" }] },
        { number: 3, title: "Feature B", body: "", labels: [{ name: "df:ready" }, { name: "P0" }, { name: "stream:features" }] }
      ]
    }
  ], policy);

  assert.deepEqual(
    plan.candidates.map((candidate: { issue: { number: number } }) => candidate.issue.number),
    [2]
  );
  assert.deepEqual(plan.active.byStream, { features: 1 });
});

test("orchestration plan still lets repository and global caps bind", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { buildOrchestrationPlan } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-global-repo-cap-test");

  const policy = {
    schemaVersion: 1,
    concurrency: { global: 2, perRepository: 1, perStream: 3 },
    waves: [{ name: "features", streams: ["features", "default"] }],
    dashboard: { enabled: true, issueTitle: "Dashboard" }
  };

  const plan = buildOrchestrationPlan([
    {
      repository: { owner: "marius-patrik", repo: "pkg-a" },
      openIssues: [
        { number: 1, title: "Feature A", body: "", labels: [{ name: "df:ready" }, { name: "P0" }, { name: "stream:features" }] },
        { number: 2, title: "Feature B", body: "", labels: [{ name: "df:ready" }, { name: "P0" }, { name: "stream:features" }] }
      ]
    },
    {
      repository: { owner: "marius-patrik", repo: "pkg-b" },
      openIssues: [
        { number: 3, title: "Feature C", body: "", labels: [{ name: "df:ready" }, { name: "P0" }, { name: "stream:features" }] },
        { number: 4, title: "Feature D", body: "", labels: [{ name: "df:ready" }, { name: "P0" }, { name: "stream:features" }] }
      ]
    },
    {
      repository: { owner: "marius-patrik", repo: "pkg-c" },
      openIssues: [
        { number: 5, title: "Feature E", body: "", labels: [{ name: "df:ready" }, { name: "P0" }, { name: "stream:features" }] }
      ]
    }
  ], policy);

  assert.deepEqual(
    plan.candidates.map((candidate: { repository: { repo: string }; issue: { number: number } }) => [
      candidate.repository.repo,
      candidate.issue.number
    ]),
    [
      ["pkg-a", 1],
      ["pkg-b", 3]
    ]
  );
});

test("orchestration wave gate ignores parked owner and blocked issues", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { buildOrchestrationPlan } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-parked-wave-gate-test");

  const policy = {
    schemaVersion: 1,
    concurrency: { global: 3, perRepository: 2, perStream: 2 },
    waves: [
      { name: "hygiene", streams: ["hygiene"] },
      { name: "enforcement", streams: ["enforcement"] },
      { name: "features", streams: ["features", "default"] }
    ],
    dashboard: { enabled: true, issueTitle: "Dashboard" }
  };

  const parkedPlan = buildOrchestrationPlan([
    {
      repository: { owner: "marius-patrik", repo: "pkg-a" },
      openIssues: [
        { number: 10, title: "Owner decision", body: "", labels: [{ name: "df:ask-owner" }, { name: "df:blocked" }, { name: "stream:hygiene" }] },
        { number: 11, title: "Enforcement", body: "", labels: [{ name: "df:ready" }, { name: "P0" }, { name: "stream:enforcement" }] }
      ]
    },
    {
      repository: { owner: "marius-patrik", repo: "pkg-b" },
      openIssues: [
        { number: 12, title: "Feature", body: "", labels: [{ name: "df:ready" }, { name: "P0" }, { name: "stream:features" }] }
      ]
    }
  ], policy);

  assert.equal(parkedPlan.gate_wave, "enforcement");
  assert.deepEqual(
    parkedPlan.candidates.map((candidate: { repository: { repo: string }; issue: { number: number }; wave: string }) => [
      candidate.repository.repo,
      candidate.issue.number,
      candidate.wave
    ]),
    [["pkg-a", 11, "enforcement"]]
  );

  const normalGatePlan = buildOrchestrationPlan([
    {
      repository: { owner: "marius-patrik", repo: "pkg-a" },
      openIssues: [
        { number: 20, title: "Open hygiene work", body: "", labels: [{ name: "roadmap" }, { name: "stream:hygiene" }] },
        { number: 21, title: "Enforcement", body: "", labels: [{ name: "df:ready" }, { name: "P0" }, { name: "stream:enforcement" }] }
      ]
    }
  ], policy);

  assert.equal(normalGatePlan.gate_wave, "hygiene");
  assert.deepEqual(normalGatePlan.candidates, []);
});

test("orchestrator updates the L6 dashboard issue after dispatch", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { DASHBOARD_MARKER, orchestrate } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-dashboard-test");
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const notFound = Object.assign(new Error("not found"), { status: 404 });
  const review = exactReviewHarness("marius-patrik/example", {
    number: 7,
    title: "Feature",
    body: EXECUTABLE_BODY,
    labels: [{ name: "df:ready" }, { name: "stream:features" }]
  });

  const gh = {
    async graphql() {
      return {
        repository: {
          pullRequests: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: []
          }
        }
      };
    },
    async request(method: string, path: string, body?: unknown) {
      calls.push({ method, path, body });
      const reviewResponse = review.respond(method, path, body);
      if (reviewResponse !== NO_REVIEW_RESPONSE) return reviewResponse;

      if (method === "GET" && path === "/repos/marius-patrik/example/issues?state=open&per_page=100&page=1") {
        return [review.issue];
      }
      if (method === "GET" && path === "/repos/marius-patrik/example/issues?state=open&per_page=100&page=2") return [];
      if (method === "GET" && path === "/repos/marius-patrik/example") return { default_branch: "main", allow_auto_merge: true };
      if (method === "GET" && path === "/repos/marius-patrik/example/git/ref/heads/dev") throw notFound;
      if (method === "GET" && path === "/repos/marius-patrik/example/branches/main/protection") return healthyManagedProtection();
      if (method === "POST" && path === "/repos/marius-patrik/example/issues/7/labels") return {};
      if (method === "DELETE" && path === "/repos/marius-patrik/example/issues/7/labels/df%3Aready") return {};
      if (method === "POST" && path === "/repos/marius-patrik/DarkFactory/actions/workflows/df-work.yml/dispatches") return {};
      if (method === "POST" && path === "/repos/marius-patrik/DarkFactory/labels") return {};
      if (method === "GET" && path === "/repos/marius-patrik/DarkFactory/issues?state=open&per_page=100&page=1") {
        return [{ number: 99, body: `<!-- ${DASHBOARD_MARKER} -->`, labels: [] }];
      }
      if (method === "PATCH" && path === "/repos/marius-patrik/DarkFactory/issues/99") return {};

      throw new Error(`Unexpected GitHub request: ${method} ${path}`);
    }
  };

  const result = await orchestrate({
    gh,
    controlRepo: { owner: "marius-patrik", repo: "DarkFactory" },
    readinessByRepository: healthyReadiness(),
    registry: { repositories: { "marius-patrik/example": { state: "active" } } },
    repositories: [{ full_name: "marius-patrik/example", archived: false, disabled: false }],
    policy: {
      schemaVersion: 1,
      concurrency: { global: 2, perRepository: 1, perStream: 1 },
      waves: [{ name: "features", streams: ["features", "default"] }],
      dashboard: { enabled: true, issueTitle: "Dashboard" }
    },
    loopEvidence: {},
    writeLedger: false,
    warn: () => {},
    log: () => {}
  });

  assert.deepEqual(result.dispatched.map((dispatch: { repo: string; issue: number }) => [dispatch.repo, dispatch.issue]), [
    ["marius-patrik/example", 7]
  ]);
  const dashboardUpdate = calls.find((call) => call.method === "PATCH" && call.path === "/repos/marius-patrik/DarkFactory/issues/99");
  assert.equal(dashboardUpdate?.body.title, "Dashboard");
  assert.match(dashboardUpdate?.body.body, new RegExp(DASHBOARD_MARKER));
  assert.match(dashboardUpdate?.body.body, /marius-patrik\/example#7/);
  assert.match(dashboardUpdate?.body.body, /Submodule Pointer Convergence/);
  assert.match(dashboardUpdate?.body.body, /AI tokens: 0/);
});

test("orchestrator escalates ambiguous sequencing to df:ask-owner without dispatch", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { ASK_OWNER_MARKER, orchestrate } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-ask-owner-test");
  const calls: Array<{ method: string; path: string; body?: any }> = [];

  const gh = {
    async graphql() {
      return {
        repository: {
          pullRequests: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: []
          }
        }
      };
    },
    async request(method: string, path: string, body?: unknown) {
      calls.push({ method, path, body });

      if (method === "GET" && path === "/repos/marius-patrik/example/issues?state=open&per_page=100&page=1") {
        return [
          {
            number: 17,
            title: "Needs owner",
            body: "## Sequencing\n\nBlocked-by: waiting for owner",
            labels: [{ name: "df:ready" }, { name: "P0" }, { name: "stream:core" }]
          }
        ];
      }
      if (method === "GET" && path === "/repos/marius-patrik/example/issues?state=open&per_page=100&page=2") return [];
      if (method === "POST" && path === "/repos/marius-patrik/example/labels") return {};
      if (method === "POST" && path === "/repos/marius-patrik/example/issues/17/labels") return {};
      if (method === "DELETE" && path.startsWith("/repos/marius-patrik/example/issues/17/labels/")) return {};
      if (method === "POST" && path === "/repos/marius-patrik/example/issues/17/comments") return {};
      if (method === "POST" && path === "/repos/marius-patrik/DarkFactory/labels") return {};
      if (method === "GET" && path === "/repos/marius-patrik/DarkFactory/issues?state=open&per_page=100&page=1") {
        return [{ number: 99, body: "<!-- df-dashboard:orchestration -->", labels: [] }];
      }
      if (method === "PATCH" && path === "/repos/marius-patrik/DarkFactory/issues/99") return {};

      throw new Error(`Unexpected GitHub request: ${method} ${path}`);
    }
  };

  const result = await orchestrate({
    gh,
    controlRepo: { owner: "marius-patrik", repo: "DarkFactory" },
    readinessByRepository: healthyReadiness(),
    registry: { repositories: { "marius-patrik/example": { state: "active" } } },
    repositories: [{ full_name: "marius-patrik/example", archived: false, disabled: false }],
    writeLedger: false,
    warn: () => {},
    log: () => {}
  });

  assert.deepEqual(result.dispatched, []);
  assert.deepEqual(result.escalated, [
    {
      repo: "marius-patrik/example",
      issue: 17,
      reason: "ambiguous-blocked-by",
      detail: "Blocked-by lines must reference GitHub issues as #123 or owner/repo#123."
    }
  ]);
  assert.deepEqual(
    calls.find((call) => call.method === "POST" && call.path === "/repos/marius-patrik/example/issues/17/labels")?.body,
    { labels: ["df:ask-owner", "df:blocked"] }
  );
  assert.ok(calls.some((call) => call.method === "DELETE" && call.path === "/repos/marius-patrik/example/issues/17/labels/df%3Aready"));
  assert.match(
    calls.find((call) => call.method === "POST" && call.path === "/repos/marius-patrik/example/issues/17/comments")?.body.body,
    new RegExp(ASK_OWNER_MARKER)
  );
  assert.equal(calls.some((call) => call.path.endsWith("/actions/workflows/df-work.yml/dispatches")), false);
  const dashboardUpdate = calls.find((call) => call.method === "PATCH" && call.path === "/repos/marius-patrik/DarkFactory/issues/99");
  assert.match(dashboardUpdate?.body.body, /Owner Escalations/);
  assert.match(dashboardUpdate?.body.body, /marius-patrik\/example#17/);
});

test("repeated-failure scan ignores evidence before the latest owner reset", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { repeatedFailureEscalation, repeatedFailureEvidenceSinceReset } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-reset-history-test");

  const history = {
    comments: [
      blockedComment("2026-07-06T10:00:00Z"),
      blockedComment("2026-07-06T10:10:00Z"),
      blockedComment("2026-07-06T10:20:00Z")
    ],
    timeline: [
      labeledEvent("df:blocked", "2026-07-06T10:20:01Z"),
      labeledEvent("df:ready", "2026-07-06T10:30:00Z")
    ]
  };

  assert.deepEqual(repeatedFailureEvidenceSinceReset(history), {
    count: 0,
    resetAt: "2026-07-06T10:30:00.000Z"
  });
  assert.equal(repeatedFailureEscalation(history), null);
});

test("repeated-failure scan escalates historical failures when no reset follows them", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { repeatedFailureEscalation, repeatedFailureEvidenceSinceReset } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-no-reset-history-test");

  const history = {
    comments: [
      blockedComment("2026-07-06T10:00:00Z"),
      blockedComment("2026-07-06T10:10:00Z"),
      blockedComment("2026-07-06T10:20:00Z")
    ],
    timeline: []
  };

  assert.deepEqual(repeatedFailureEvidenceSinceReset(history), { count: 3, resetAt: null });
  assert.equal(repeatedFailureEscalation(history)?.reason, "repeated-worker-failure");
});

test("repeated-failure scan counts df:fix-round timeline labels as evidence", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { repeatedFailureEscalation, repeatedFailureEvidenceSinceReset } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-fix-round-history-test");

  const history = {
    comments: [
      blockedComment("2026-07-06T10:00:00Z"),
      blockedComment("2026-07-06T10:10:00Z")
    ],
    timeline: [labeledEvent("df:fix-round:1", "2026-07-06T10:20:00Z")]
  };

  assert.deepEqual(repeatedFailureEvidenceSinceReset(history), { count: 3, resetAt: null });
  assert.equal(repeatedFailureEscalation(history)?.reason, "repeated-worker-failure");
});

test("repeated-failure scan escalates new failures after an owner reset", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { repeatedFailureEscalation, repeatedFailureEvidenceSinceReset } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-new-failures-history-test");

  const history = {
    comments: [
      blockedComment("2026-07-06T10:00:00Z"),
      blockedComment("2026-07-06T10:10:00Z"),
      blockedComment("2026-07-06T10:20:00Z"),
      blockedComment("2026-07-06T10:40:00Z"),
      blockedComment("2026-07-06T10:50:00Z"),
      blockedComment("2026-07-06T11:00:00Z")
    ],
    timeline: [labeledEvent("df:ready", "2026-07-06T10:30:00Z")]
  };

  assert.deepEqual(repeatedFailureEvidenceSinceReset(history), {
    count: 3,
    resetAt: "2026-07-06T10:30:00.000Z"
  });
  assert.equal(repeatedFailureEscalation(history)?.reason, "repeated-worker-failure");
});

test("orchestrator dispatches owner-reset issues instead of re-escalating stale failures", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { orchestrate } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-reset-dispatch-test");
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const notFound = Object.assign(new Error("not found"), { status: 404 });
  const review = exactReviewHarness("marius-patrik/example", {
    number: 30,
    title: "Reset lane",
    body: EXECUTABLE_BODY,
    labels: [{ name: "df:ready" }]
  }, [
    blockedComment("2026-07-06T10:00:00Z"),
    blockedComment("2026-07-06T10:10:00Z"),
    blockedComment("2026-07-06T10:20:00Z")
  ]);

  const gh = {
    async graphql() {
      return {
        repository: {
          pullRequests: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: []
          }
        }
      };
    },
    async request(method: string, path: string, body?: unknown) {
      calls.push({ method, path, body });
      const reviewResponse = review.respond(method, path, body);
      if (reviewResponse !== NO_REVIEW_RESPONSE) return reviewResponse;

      if (method === "GET" && path === "/repos/marius-patrik/example/issues?state=open&per_page=100&page=1") {
        return [review.issue];
      }
      if (method === "GET" && path === "/repos/marius-patrik/example/issues?state=open&per_page=100&page=2") return [];
      if (method === "GET" && path === "/repos/marius-patrik/example/issues/30/timeline?per_page=100&page=1") {
        return [labeledEvent("df:ready", "2026-07-06T10:30:00Z")];
      }
      if (method === "GET" && path === "/repos/marius-patrik/example/issues/30/timeline?per_page=100&page=2") return [];
      if (method === "GET" && path === "/repos/marius-patrik/example") return { default_branch: "main", allow_auto_merge: true };
      if (method === "GET" && path === "/repos/marius-patrik/example/git/ref/heads/dev") throw notFound;
      if (method === "GET" && path === "/repos/marius-patrik/example/branches/main/protection") return healthyManagedProtection();
      if (method === "POST" && path === "/repos/marius-patrik/example/issues/30/labels") return {};
      if (method === "DELETE" && path === "/repos/marius-patrik/example/issues/30/labels/df%3Aready") return {};
      if (method === "POST" && path === "/repos/marius-patrik/DarkFactory/actions/workflows/df-work.yml/dispatches") return {};

      throw new Error(`Unexpected GitHub request: ${method} ${path}`);
    }
  };

  const result = await orchestrate({
    gh,
    controlRepo: { owner: "marius-patrik", repo: "DarkFactory" },
    readinessByRepository: healthyReadiness(),
    registry: { repositories: { "marius-patrik/example": { state: "active" } } },
    repositories: [{ full_name: "marius-patrik/example", archived: false, disabled: false }],
    writeLedger: false,
    updateDashboard: false,
    warn: () => {},
    log: () => {}
  });

  assert.deepEqual(result.escalated, []);
  assert.deepEqual(result.dispatched, [{ repo: "marius-patrik/example", issue: 30, wave: "features", streams: ["default"] }]);
});

test("orchestrator turns trusted /df run comments into df:ready before dispatch", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { orchestrate } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-slash-run-test");
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const notFound = Object.assign(new Error("not found"), { status: 404 });
  const previousPayload = process.env.GITHUB_EVENT_PAYLOAD;
  const review = exactReviewHarness("marius-patrik/example", {
    number: 12,
    title: "Run me",
    body: EXECUTABLE_BODY,
    labels: [{ name: "df:ready" }]
  });

  process.env.GITHUB_EVENT_PAYLOAD = JSON.stringify({
    repository: { full_name: "marius-patrik/example" },
    issue: { number: 12 },
    comment: { body: "/df run", author_association: "OWNER" }
  });

  const gh = {
    async graphql() {
      return {
        repository: {
          pullRequests: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: []
          }
        }
      };
    },
    async request(method: string, path: string, body?: unknown) {
      calls.push({ method, path, body });
      const reviewResponse = review.respond(method, path, body);
      if (reviewResponse !== NO_REVIEW_RESPONSE) return reviewResponse;

      if (method === "POST" && path === "/repos/marius-patrik/example/labels") return {};
      if (method === "PATCH" && path === "/repos/marius-patrik/example/labels/df%3Aready") return {};
      if (method === "PATCH" && path === "/repos/marius-patrik/example/labels/df%3Arunning") return {};
      if (method === "PATCH" && path === "/repos/marius-patrik/example/labels/df%3Ablocked") return {};
      if (method === "PATCH" && path === "/repos/marius-patrik/example/labels/df%3Adone") return {};
      if (method === "PATCH" && path.startsWith("/repos/marius-patrik/example/labels/df%3A")) return {};
      if (method === "POST" && path === "/repos/marius-patrik/example/issues/12/labels") return {};
      if (method === "POST" && path === "/repos/marius-patrik/example/issues/12/comments") return {};
      if (method === "GET" && path === "/repos/marius-patrik/example/issues?state=open&per_page=100&page=1") {
        return [
          review.issue,
          { number: 99, title: "Do not run me", body: EXECUTABLE_BODY, labels: [{ name: "df:ready" }] }
        ];
      }
      if (method === "GET" && path === "/repos/marius-patrik/example/issues?state=open&per_page=100&page=2") return [];
      if (method === "GET" && path === "/repos/marius-patrik/example") return { default_branch: "main", allow_auto_merge: true };
      if (method === "GET" && path === "/repos/marius-patrik/example/git/ref/heads/dev") throw notFound;
      if (method === "GET" && path === "/repos/marius-patrik/example/branches/main/protection") return healthyManagedProtection();
      if (method === "DELETE" && path === "/repos/marius-patrik/example/issues/12/labels/df%3Aready") return {};
      if (method === "POST" && path === "/repos/marius-patrik/DarkFactory/actions/workflows/df-work.yml/dispatches") return {};

      throw new Error(`Unexpected GitHub request: ${method} ${path}`);
    }
  };

  try {
    const result = await orchestrate({
      gh,
      controlRepo: { owner: "marius-patrik", repo: "DarkFactory" },
      readinessByRepository: healthyReadiness(),
      registry: { repositories: { "marius-patrik/example": { state: "active" }, "marius-patrik/other": { state: "active" } } },
      repositories: [
        { full_name: "marius-patrik/example", archived: false, disabled: false },
        { full_name: "marius-patrik/other", archived: false, disabled: false }
      ],
      trigger: "issue_comment",
      writeLedger: false,
      updateDashboard: false,
      warn: () => {},
      log: () => {}
    });

    assert.deepEqual(result.dispatched, [{ repo: "marius-patrik/example", issue: 12, wave: "features", streams: ["default"] }]);
    assert.equal(calls.some((call) => call.path.includes("/issues/99/")), false);
    assert.equal(calls.some((call) => call.method === "GET" && call.path.startsWith("/repos/marius-patrik/other/")), true);
    assert.equal(calls.some((call) => call.method !== "GET" && call.path.startsWith("/repos/marius-patrik/other/")), false);
    assert.ok(calls.some((call) => call.method === "POST" && call.path === "/repos/marius-patrik/example/issues/12/comments"));
  } finally {
    if (previousPayload === undefined) delete process.env.GITHUB_EVENT_PAYLOAD;
    else process.env.GITHUB_EVENT_PAYLOAD = previousPayload;
  }
});

test("parseEventRequest ignores untrusted /df run comments", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { parseEventRequest } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-event-parse-test");

  const request = parseEventRequest(JSON.stringify({
    repository: { full_name: "marius-patrik/example" },
    issue: { number: 12 },
    comment: { body: "/df run", author_association: "NONE" }
  }), "issue_comment", () => {});

  assert.equal(request, null);
});

test("parseEventRequest accepts only the exact current App ready actor as dispatch-capable", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { parseEventRequest } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-label-event-parse-test");

  const request = parseEventRequest(JSON.stringify({
    action: "labeled",
    repository: { full_name: "marius-patrik/example" },
    issue: { number: 44 },
    label: { name: "df:ready" },
    sender: { login: "darkfactory-agent[bot]", type: "Bot" }
  }), "issues", () => {});

  assert.deepEqual(request, {
    repository: { owner: "marius-patrik", repo: "example" },
    issueNumber: 44,
    slashRun: false,
    readyLabel: true,
    readyLabelActorTrusted: true,
    evaluationOnly: false
  });
});

test("parseEventRequest scopes human and near-miss ready labels to evaluation-only cleanup", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { parseEventRequest } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-untrusted-label-event-test");
  for (const sender of [
    { login: "marius-patrik", type: "User" },
    { login: "darkfactory-agent", type: "Bot" },
    { login: "evil-darkfactory-agent[bot]", type: "Bot" },
    { login: "darkfactory-agent[bot]", type: "User" }
  ]) {
    const request = parseEventRequest(JSON.stringify({
      action: "labeled",
      repository: { full_name: "marius-patrik/example" },
      issue: { number: 44 },
      label: { name: "df:ready" },
      sender
    }), "issues", () => {});
    assert.equal(request?.readyLabelActorTrusted, false, JSON.stringify(sender));
    assert.equal(request?.evaluationOnly, true, JSON.stringify(sender));
  }
  assert.equal(parseEventRequest(JSON.stringify({
    action: "unlabeled",
    repository: { full_name: "marius-patrik/example" },
    issue: { number: 44 },
    label: { name: "df:ready" },
    sender: { login: "darkfactory-agent[bot]", type: "Bot" }
  }), "issues", () => {}), null);
});

test("current ready ownership follows the latest current event and rejects stale or near-miss actors", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { currentReadyLabelOwnership } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-ready-event-ownership-test");
  const trusted = labeledEvent("df:ready", "2026-07-16T10:00:00Z");
  assert.equal(currentReadyLabelOwnership([trusted]).trusted, true);
  assert.equal(currentReadyLabelOwnership([
    trusted,
    labeledEvent("df:ready", "2026-07-16T10:01:00Z", { login: "marius-patrik", type: "User" })
  ]).trusted, false);
  assert.equal(currentReadyLabelOwnership([
    trusted,
    labeledEvent("df:ready", "2026-07-16T10:02:00Z", { login: "darkfactory-agent", type: "Bot" })
  ]).trusted, false);
  assert.equal(currentReadyLabelOwnership([
    trusted,
    { ...labeledEvent("df:ready", "2026-07-16T10:03:00Z"), event: "unlabeled" }
  ]).reason, "latest-ready-event-is-unlabeled");
});

test("parseWorkflowDispatchRequest scopes source events", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { parseWorkflowDispatchRequest } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-dispatch-parse-test");

  assert.deepEqual(parseWorkflowDispatchRequest("marius-patrik/example", "44", "issues", () => {}), {
    repository: { owner: "marius-patrik", repo: "example" },
    issueNumber: 44,
    slashRun: false,
    readyLabel: true
  });
  assert.deepEqual(parseWorkflowDispatchRequest("marius-patrik/example", "45", "issue_comment", () => {}), {
    repository: { owner: "marius-patrik", repo: "example" },
    issueNumber: 45,
    slashRun: true,
    readyLabel: false
  });
  assert.deepEqual(parseWorkflowDispatchRequest("marius-patrik/example", "", "df-setup", () => {}), {
    repository: { owner: "marius-patrik", repo: "example" },
    issueNumber: null,
    slashRun: false,
    readyLabel: false,
    evaluationOnly: true
  });
  assert.equal(parseWorkflowDispatchRequest("marius-patrik/example", "", "workflow_dispatch", () => {}), null);
  assert.equal(parseWorkflowDispatchRequest("", "", "", () => {}), null);
});

test("setup readiness evaluation is repository-scoped and never dispatches worker or fleet mutations", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { orchestrate } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-setup-evaluation-test");
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const review = exactReviewHarness("marius-patrik/example", {
    number: 12,
    title: "Evaluate me",
    body: EXECUTABLE_BODY,
    labels: [{ name: "df:planned" }]
  });
  const gh = {
    async request(method: string, path: string, body?: unknown) {
      calls.push({ method, path, body });
      const reviewResponse = review.respond(method, path, body);
      if (reviewResponse !== NO_REVIEW_RESPONSE) return reviewResponse;
      if (method === "GET" && path === "/repos/marius-patrik/example/issues?state=open&per_page=100&page=1") {
        return [review.issue];
      }
      if (method === "GET" && path === "/repos/marius-patrik/other/issues?state=open&per_page=100&page=1") {
        return [{ number: 99, title: "Do not touch", body: EXECUTABLE_BODY, labels: [{ name: "df:ready" }] }];
      }
      if (method === "POST" && path === "/repos/marius-patrik/example/labels") return {};
      if (method === "POST" && path === "/repos/marius-patrik/example/issues/12/labels") return {};
      throw new Error(`Unexpected GitHub request: ${method} ${path}`);
    }
  };

  const result = await orchestrate({
    gh,
    controlRepo: { owner: "marius-patrik", repo: "DarkFactory" },
    readinessByRepository: healthyReadiness(),
    registry: { repositories: { "marius-patrik/example": { state: "active" }, "marius-patrik/other": { state: "active" } } },
    repositories: [
      { full_name: "marius-patrik/example", archived: false, disabled: false },
      { full_name: "marius-patrik/other", archived: false, disabled: false }
    ],
    trigger: "workflow_dispatch",
    dispatchRequest: { repo: "marius-patrik/example", issue_number: "", source_event: "df-setup" },
    writeLedger: false,
    updateDashboard: false,
    warn: () => {},
    log: () => {}
  });

  assert.deepEqual(result.dispatched, []);
  assert.deepEqual(result.autoReadied, [{ repo: "marius-patrik/example", issue: 12 }]);
  assert.equal(result.ledger.evaluation_only, true);
  assert.equal(calls.some((call) => call.path.includes("/actions/workflows/df-work.yml/dispatches")), false);
  assert.equal(calls.some((call) => call.method !== "GET" && call.path.startsWith("/repos/marius-patrik/other/")), false);
});

test("readiness clears only an exact healthy machine-owned merge-policy brake", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { evaluateIssueReadinessLabels } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-stale-brake-test");
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const machineBrakeComment = { body: "<!-- dark-factory:orchestrator-ask-owner issue=1 reason=merge-policy-blocked -->" };
  const review = exactReviewHarness("marius-patrik/example", {
    number: 1,
    title: "Machine brake",
    body: EXECUTABLE_BODY,
    labels: [{ name: "df:blocked" }, { name: "df:ask-owner" }]
  }, [machineBrakeComment]);
  const issues = [
    review.issue,
    { number: 2, title: "Owner brake", body: EXECUTABLE_BODY, labels: [{ name: "df:blocked" }, { name: "df:ask-owner" }] }
  ];
  const degraded = { number: 3, title: "Unhealthy brake", body: EXECUTABLE_BODY, labels: [{ name: "df:blocked" }, { name: "df:ask-owner" }] };
  const gh = {
    async request(method: string, path: string, body?: unknown) {
      calls.push({ method, path, body });
      const reviewResponse = review.respond(method, path, body);
      if (reviewResponse !== NO_REVIEW_RESPONSE) return reviewResponse;
      if (method === "GET" && path.includes("/issues/2/comments")) return [{ body: "Owner explicitly held this issue." }];
      if (method === "DELETE" && path.includes("/issues/1/labels/")) return {};
      if (method === "POST" && path === "/repos/marius-patrik/example/issues/1/comments") return {};
      if (method === "POST" && path === "/repos/marius-patrik/example/labels") return {};
      if (method === "POST" && path === "/repos/marius-patrik/example/issues/1/labels") return {};
      throw new Error(`Unexpected GitHub request: ${method} ${path}`);
    }
  };
  const readiness = new Map([
    ["marius-patrik/example", { observable: true, doctorPerfect: true, gatesHealthy: true }],
    ["marius-patrik/other", { observable: true, doctorPerfect: false, gatesHealthy: true }]
  ]);
  const policy = {
    schemaVersion: 1,
    concurrency: { global: 10, perRepository: 10, perStream: 10 },
    waves: [{ name: "features", streams: ["default"] }],
    dashboard: { enabled: false, issueTitle: "Dashboard" }
  };

  const evaluations: ReadinessEvaluation[] = await evaluateIssueReadinessLabels(gh, [
    { repository: { owner: "marius-patrik", repo: "example" }, openIssues: issues },
    { repository: { owner: "marius-patrik", repo: "other" }, openIssues: [degraded] }
  ], () => {}, { readinessByRepository: readiness, policy });

  assert.equal(evaluations.find((entry) => entry.issue === 1)?.ready, true);
  assert.equal(evaluations.find((entry) => entry.issue === 1)?.action, "labeled-ready");
  assert.equal(evaluations.find((entry) => entry.issue === 2)?.ready, false);
  assert.equal(evaluations.find((entry) => entry.issue === 3)?.ready, false);
  assert.equal(calls.some((call) => call.method === "DELETE" && call.path.includes("/issues/1/labels/df%3Ablocked")), true);
  assert.equal(calls.some((call) => call.method === "DELETE" && call.path.includes("/issues/2/labels/")), false);
  assert.equal(calls.some((call) => call.path.includes("/marius-patrik/other/issues/3/comments")), false);
});

test("readiness reserves bounded capacity in deterministic priority order", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { evaluateIssueReadinessLabels } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-readiness-capacity-test");
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const review = exactReviewHarness("marius-patrik/example", {
    number: 2,
    title: "Higher priority",
    body: EXECUTABLE_BODY,
    labels: [{ name: "P0" }]
  });
  const gh = {
    async request(method: string, path: string, body?: unknown) {
      calls.push({ method, path, body });
      const reviewResponse = review.respond(method, path, body);
      if (reviewResponse !== NO_REVIEW_RESPONSE) return reviewResponse;
      if (method === "POST" && path === "/repos/marius-patrik/example/labels") return {};
      if (method === "POST" && path === "/repos/marius-patrik/example/issues/2/labels") return {};
      throw new Error(`Unexpected GitHub request: ${method} ${path}`);
    }
  };
  const policy = {
    schemaVersion: 1,
    concurrency: { global: 1, perRepository: 1, perStream: 1 },
    waves: [{ name: "features", streams: ["default"] }],
    dashboard: { enabled: false, issueTitle: "Dashboard" }
  };
  const evaluations: ReadinessEvaluation[] = await evaluateIssueReadinessLabels(gh, [{
    repository: { owner: "marius-patrik", repo: "example" },
    openIssues: [
      { number: 1, title: "Lower priority", body: EXECUTABLE_BODY, labels: [{ name: "P1" }] },
      review.issue
    ]
  }], () => {}, {
    readinessByRepository: new Map([["marius-patrik/example", { observable: true, doctorPerfect: true, gatesHealthy: true }]]),
    policy
  });

  assert.deepEqual(evaluations.map((entry) => [entry.issue, entry.ready, entry.action]), [
    [2, true, "labeled-ready"],
    [1, false, "no-op"]
  ]);
  assert.ok(evaluations.find((entry) => entry.issue === 1)?.findings.includes("capacity-exhausted"));
  assert.equal(calls.some((call) => call.path.includes("/issues/1/labels")), false);
});

test("machine readiness accepts only a fresh identity-bound self-hosted doctor receipt", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { machineReadinessFromDoctorLedger } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-machine-receipt-test");
  const now = "2026-07-15T12:00:00.000Z";
  const receipt = {
    kind: "repo-doctor",
    phase: "completion",
    target_repo: "marius-patrik/DarkFactory",
    machine_evidence_schema: 1,
    created_at: "2026-07-15T11:00:00.000Z",
    source_refs: { main: "control-head" },
    findings: [{ id: "unrelated", category: "PRD drift" }]
  };

  assert.deepEqual(machineReadinessFromDoctorLedger(receipt, now), {
    observable: true,
    healthy: true,
    ageMs: 60 * 60 * 1000,
    findingIds: []
  });
  assert.deepEqual(machineReadinessFromDoctorLedger({ ...receipt, target_repo: "marius-patrik/other" }, now).findingIds, ["machine-readiness-proof-missing"]);
  assert.deepEqual(machineReadinessFromDoctorLedger(receipt, now, "marius-patrik/DarkFactory", "different-head").findingIds, ["machine-readiness-proof-missing"]);
  assert.deepEqual(machineReadinessFromDoctorLedger({ ...receipt, created_at: "2026-07-13T00:00:00.000Z" }, now).findingIds, ["machine-readiness-proof-stale"]);
  const unhealthy = machineReadinessFromDoctorLedger({ ...receipt, findings: [{ id: "df-local-runner-offline", category: "runner health" }] }, now);
  assert.equal(unhealthy.observable, true);
  assert.equal(unhealthy.healthy, false);
  assert.deepEqual(unhealthy.findingIds, ["df-local-runner-offline"]);
});

test("orchestrator turns scoped /df run dispatches into df:ready before dispatch", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { orchestrate } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-forwarded-slash-run-test");
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const notFound = Object.assign(new Error("not found"), { status: 404 });
  const review = exactReviewHarness("marius-patrik/example", {
    number: 12,
    title: "Run me",
    body: EXECUTABLE_BODY,
    labels: [{ name: "df:ready" }]
  });

  const gh = {
    async graphql() {
      return {
        repository: {
          pullRequests: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: []
          }
        }
      };
    },
    async request(method: string, path: string, body?: unknown) {
      calls.push({ method, path, body });
      const reviewResponse = review.respond(method, path, body);
      if (reviewResponse !== NO_REVIEW_RESPONSE) return reviewResponse;

      if (method === "POST" && path === "/repos/marius-patrik/example/labels") return {};
      if (method === "PATCH" && path === "/repos/marius-patrik/example/labels/df%3Aready") return {};
      if (method === "PATCH" && path === "/repos/marius-patrik/example/labels/df%3Arunning") return {};
      if (method === "PATCH" && path === "/repos/marius-patrik/example/labels/df%3Ablocked") return {};
      if (method === "PATCH" && path === "/repos/marius-patrik/example/labels/df%3Adone") return {};
      if (method === "PATCH" && path.startsWith("/repos/marius-patrik/example/labels/df%3A")) return {};
      if (method === "POST" && path === "/repos/marius-patrik/example/issues/12/labels") return {};
      if (method === "POST" && path === "/repos/marius-patrik/example/issues/12/comments") return {};
      if (method === "GET" && path === "/repos/marius-patrik/example/issues?state=open&per_page=100&page=1") {
        return [
          review.issue,
          { number: 99, title: "Do not run me", body: EXECUTABLE_BODY, labels: [{ name: "df:ready" }] }
        ];
      }
      if (method === "GET" && path === "/repos/marius-patrik/example/issues?state=open&per_page=100&page=2") return [];
      if (method === "GET" && path === "/repos/marius-patrik/example") return { default_branch: "main", allow_auto_merge: true };
      if (method === "GET" && path === "/repos/marius-patrik/example/git/ref/heads/dev") throw notFound;
      if (method === "GET" && path === "/repos/marius-patrik/example/branches/main/protection") return healthyManagedProtection();
      if (method === "DELETE" && path === "/repos/marius-patrik/example/issues/12/labels/df%3Aready") return {};
      if (method === "POST" && path === "/repos/marius-patrik/DarkFactory/actions/workflows/df-work.yml/dispatches") return {};

      throw new Error(`Unexpected GitHub request: ${method} ${path}`);
    }
  };

  const result = await orchestrate({
    gh,
    controlRepo: { owner: "marius-patrik", repo: "DarkFactory" },
    readinessByRepository: healthyReadiness(),
    registry: { repositories: { "marius-patrik/example": { state: "active" }, "marius-patrik/other": { state: "active" } } },
    repositories: [
      { full_name: "marius-patrik/example", archived: false, disabled: false },
      { full_name: "marius-patrik/other", archived: false, disabled: false }
    ],
    trigger: "workflow_dispatch",
    dispatchRequest: { repo: "marius-patrik/example", issue_number: "12", source_event: "issue_comment" },
    writeLedger: false,
    updateDashboard: false,
    warn: () => {},
    log: () => {}
  });

  assert.deepEqual(result.dispatched, [{ repo: "marius-patrik/example", issue: 12, wave: "features", streams: ["default"] }]);
  assert.equal(calls.some((call) => call.path.includes("/issues/99/")), false);
  assert.equal(calls.some((call) => call.method === "GET" && call.path.startsWith("/repos/marius-patrik/other/")), true);
  assert.equal(calls.some((call) => call.method !== "GET" && call.path.startsWith("/repos/marius-patrik/other/")), false);
  assert.ok(calls.some((call) => call.method === "POST" && call.path === "/repos/marius-patrik/example/issues/12/comments"));
});

test("orchestrator treats untrusted /df run comments as no-op events", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { orchestrate } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-untrusted-slash-run-test");
  const previousPayload = process.env.GITHUB_EVENT_PAYLOAD;

  process.env.GITHUB_EVENT_PAYLOAD = JSON.stringify({
    repository: { full_name: "marius-patrik/example" },
    issue: { number: 12 },
    comment: { body: "/df run", author_association: "NONE" }
  });

  try {
    const result = await orchestrate({
      gh: {
        request: async () => {
          throw new Error("untrusted event must not inspect or dispatch global work");
        }
      },
    controlRepo: { owner: "marius-patrik", repo: "DarkFactory" },
    readinessByRepository: healthyReadiness(),
    registry: { repositories: { "marius-patrik/example": { state: "active" } } },
      repositories: [{ full_name: "marius-patrik/example", archived: false, disabled: false }],
      trigger: "issue_comment",
      writeLedger: false,
      updateDashboard: false,
      warn: () => {},
      log: () => {}
    });

    assert.deepEqual(result.dispatched, []);
  } finally {
    if (previousPayload === undefined) delete process.env.GITHUB_EVENT_PAYLOAD;
    else process.env.GITHUB_EVENT_PAYLOAD = previousPayload;
  }
});

test("orchestrator ignores event runs for inactive managed repositories", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { orchestrate } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-inactive-event-test");
  const previousPayload = process.env.GITHUB_EVENT_PAYLOAD;
  const warnings: string[] = [];

  process.env.GITHUB_EVENT_PAYLOAD = JSON.stringify({
    repository: { full_name: "marius-patrik/example" },
    issue: { number: 12 },
    comment: { body: "/df run", author_association: "OWNER" }
  });

  try {
    const result = await orchestrate({
      gh: {
        request: async () => {
          throw new Error("inactive event must not mutate labels or dispatch work");
        }
      },
      controlRepo: { owner: "marius-patrik", repo: "DarkFactory" },
      readinessByRepository: healthyReadiness(),
      registry: { repositories: { "marius-patrik/example": { state: "parked" } } },
      repositories: [{ full_name: "marius-patrik/example", archived: false, disabled: false }],
      trigger: "issue_comment",
      writeLedger: false,
      updateDashboard: false,
      warn: (warning: string) => warnings.push(warning),
      log: () => {}
    });

    assert.deepEqual(result.dispatched, []);
    assert.ok(warnings.some((warning) => warning.includes("unmanaged repository marius-patrik/example")));
  } finally {
    if (previousPayload === undefined) delete process.env.GITHUB_EVENT_PAYLOAD;
    else process.env.GITHUB_EVENT_PAYLOAD = previousPayload;
  }
});

test("orchestrator resumes interrupted run against existing open worker PR", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { RESUME_MARKER, orchestrate } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-resume-pr-test");
  const calls: Array<{ method: string; path: string; body?: any }> = [];

  const gh = {
    async graphql() {
      return {
        repository: {
          pullRequests: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: "PR_21",
                number: 21,
                title: "Worker PR",
                body: "<!-- dark-factory:worker-pr issue=8 -->\n\nCloses #8",
                url: "https://github.com/marius-patrik/example/pull/21",
                headRefName: "df/8-worker",
                baseRefName: "main",
                headRepository: { owner: { login: "marius-patrik" }, name: "example" },
                author: { __typename: "Bot", login: "darkfactory-agent" }
              }
            ]
          }
        }
      };
    },
    async request(method: string, path: string, body?: unknown) {
      calls.push({ method, path, body });

      if (method === "GET" && path === "/repos/marius-patrik/example/issues?state=open&per_page=100&page=1") {
        return [{ number: 8, labels: [{ name: "df:running" }] }];
      }
      if (method === "GET" && path === "/repos/marius-patrik/example/issues?state=open&per_page=100&page=2") return [];
      if (method === "GET" && path === "/repos/marius-patrik/example/issues/8/comments?per_page=100&page=1") {
        return [
          { body: "DarkFactory worker started for `marius-patrik/example#8` from `workflow_dispatch`.", created_at: "2026-07-06T10:00:00Z" }
        ];
      }
      if (method === "GET" && path === "/repos/marius-patrik/example/issues/8/comments?per_page=100&page=2") return [];
      if (method === "POST" && path === "/repos/marius-patrik/example/issues/8/comments") return {};
      if (method === "POST" && path === "/repos/marius-patrik/DarkFactory/actions/workflows/df-work.yml/dispatches") return {};

      throw new Error(`Unexpected GitHub request: ${method} ${path}`);
    }
  };

  const result = await orchestrate({
    gh,
    controlRepo: { owner: "marius-patrik", repo: "DarkFactory" },
    readinessByRepository: healthyReadiness(),
    registry: { repositories: { "marius-patrik/example": { state: "active" } } },
    repositories: [{ full_name: "marius-patrik/example", archived: false, disabled: false }],
    policy: {
      schemaVersion: 1,
      concurrency: { global: 2, perRepository: 1, perStream: 1 },
      waves: [{ name: "features", streams: ["features", "default"] }],
      dashboard: { enabled: false, issueTitle: "Dashboard" }
    },
    writeLedger: false,
    updateDashboard: false,
    warn: () => {},
    log: () => {}
  });

  assert.deepEqual(result.recoveries, [
    { repo: "marius-patrik/example", issue: 8, type: "pr", action: "resume-pr", reason: "", pr: 21, branch: "df/8-worker" }
  ]);
  assert.deepEqual(result.dispatched, []);
  const dispatch = calls.find(
    (call) => call.method === "POST" && call.path === "/repos/marius-patrik/DarkFactory/actions/workflows/df-work.yml/dispatches"
  )?.body;
  assert.deepEqual(dispatch, {
    ref: "main",
    inputs: {
      repo: "marius-patrik/example",
      issue_number: "8",
      base_ref: "main",
      resume_pr: "21",
      resume_branch: "",
      resume_head: ""
    }
  });
  const comment = calls.find(
    (call) => call.method === "POST" && call.path === "/repos/marius-patrik/example/issues/8/comments"
  )?.body;
  assert.ok(String(comment?.body).includes(RESUME_MARKER));
});

test("orchestrator resumes interrupted run from pushed branch when no PR exists", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { RESUME_MARKER, orchestrate } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-resume-branch-test");
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const notFound = Object.assign(new Error("not found"), { status: 404 });
  const resumeHead = "9".repeat(40);

  const gh = {
    async graphql() {
      return {
        repository: {
          pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] }
        }
      };
    },
    async request(method: string, path: string, body?: unknown) {
      calls.push({ method, path, body });

      if (method === "GET" && path === "/repos/marius-patrik/example/issues?state=open&per_page=100&page=1") {
        return [{ number: 9, labels: [{ name: "df:running" }] }];
      }
      if (method === "GET" && path === "/repos/marius-patrik/example/issues?state=open&per_page=100&page=2") return [];
      if (method === "GET" && path === "/repos/marius-patrik/example/issues/9/comments?per_page=100&page=1") {
        return [
          { body: "DarkFactory worker started for `marius-patrik/example#9`.", created_at: "2026-07-06T10:00:00Z" }
        ];
      }
      if (method === "GET" && path === "/repos/marius-patrik/example/issues/9/comments?per_page=100&page=2") return [];
      if (method === "GET" && path === "/repos/marius-patrik/example/git/matching-refs/heads/df%2F9-") {
        return [{ ref: "refs/heads/df/9-resume-test", object: { sha: resumeHead } }];
      }
      if (method === "GET" && path === "/repos/marius-patrik/example/git/ref/heads/dev") throw notFound;
      if (method === "GET" && path === "/repos/marius-patrik/example") return { default_branch: "main", allow_auto_merge: true };
      if (method === "POST" && path === "/repos/marius-patrik/example/issues/9/comments") return {};
      if (method === "POST" && path === "/repos/marius-patrik/DarkFactory/actions/workflows/df-work.yml/dispatches") return {};

      throw new Error(`Unexpected GitHub request: ${method} ${path}`);
    }
  };

  const result = await orchestrate({
    gh,
    controlRepo: { owner: "marius-patrik", repo: "DarkFactory" },
    readinessByRepository: healthyReadiness(),
    registry: { repositories: { "marius-patrik/example": { state: "active" } } },
    repositories: [{ full_name: "marius-patrik/example", archived: false, disabled: false }],
    policy: {
      schemaVersion: 1,
      concurrency: { global: 2, perRepository: 1, perStream: 1 },
      waves: [{ name: "features", streams: ["features", "default"] }],
      dashboard: { enabled: false, issueTitle: "Dashboard" }
    },
    writeLedger: false,
    updateDashboard: false,
    warn: () => {},
    log: () => {}
  });

  assert.deepEqual(result.recoveries, [
    { repo: "marius-patrik/example", issue: 9, type: "branch", action: "resume-branch", reason: "", branch: "df/9-resume-test", head: resumeHead }
  ]);
  const dispatch = calls.find(
    (call) => call.method === "POST" && call.path === "/repos/marius-patrik/DarkFactory/actions/workflows/df-work.yml/dispatches"
  )?.body;
  assert.equal(dispatch.inputs.resume_branch, "df/9-resume-test");
  assert.equal(dispatch.inputs.resume_head, resumeHead);
  assert.equal(dispatch.inputs.base_ref, "main");
  assert.equal(dispatch.inputs.resume_pr, "");
  const comment = calls.find(
    (call) => call.method === "POST" && call.path === "/repos/marius-patrik/example/issues/9/comments"
  )?.body;
  assert.ok(String(comment?.body).includes(RESUME_MARKER));
});

test("interrupted recovery escalates multiple pushed branches without dispatching either", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { classifyResumeTarget, resumeInterruptedWorker } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-resume-ambiguous-test");
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const gh = {
    async graphql() {
      return { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } };
    },
    async request(method: string, path: string, body?: any) {
      calls.push({ method, path, body });
      if (method === "GET" && path.endsWith("/git/matching-refs/heads/df%2F77-")) {
        return [
          { ref: "refs/heads/df/77-first", object: { sha: "1".repeat(40) } },
          { ref: "refs/heads/df/77-second", object: { sha: "2".repeat(40) } }
        ];
      }
      if (method === "POST" && path === "/repos/marius-patrik/example/issues/77/labels") return {};
      if (method === "DELETE" && path.startsWith("/repos/marius-patrik/example/issues/77/labels/")) return {};
      if (method === "POST" && path === "/repos/marius-patrik/example/issues/77/comments") return {};
      throw new Error(`Unexpected GitHub request: ${method} ${path}`);
    }
  };
  const repository = { owner: "marius-patrik", repo: "example" };
  const issue = { number: 77 };
  const classification = await classifyResumeTarget(gh, repository, issue);
  assert.equal(classification.type, "ambiguous");
  assert.deepEqual(classification.candidates.map((candidate: { branch: string }) => candidate.branch), ["df/77-first", "df/77-second"]);

  const recovery = await resumeInterruptedWorker(gh, { owner: "marius-patrik", repo: "DarkFactory" }, repository, issue, classification);
  assert.equal(recovery.action, "ask-owner");
  assert.equal(recovery.reason, "ambiguous-worker-branches");
  assert.equal(calls.some((call) => call.path.endsWith("/actions/workflows/df-work.yml/dispatches")), false);
});

test("orchestrator requeues interrupted run with no usable branch", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { RESUME_MARKER, orchestrate } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-resume-requeue-test");
  const calls: Array<{ method: string; path: string; body?: any }> = [];

  const gh = {
    async graphql() {
      return {
        repository: {
          pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] }
        }
      };
    },
    async request(method: string, path: string, body?: unknown) {
      calls.push({ method, path, body });

      if (method === "GET" && path === "/repos/marius-patrik/example/issues?state=open&per_page=100&page=1") {
        return [{ number: 10, labels: [{ name: "df:running" }] }];
      }
      if (method === "GET" && path === "/repos/marius-patrik/example/issues?state=open&per_page=100&page=2") return [];
      if (method === "GET" && path === "/repos/marius-patrik/example/issues/10/comments?per_page=100&page=1") {
        return [
          { body: "DarkFactory worker started for `marius-patrik/example#10`.", created_at: "2026-07-06T10:00:00Z" }
        ];
      }
      if (method === "GET" && path === "/repos/marius-patrik/example/issues/10/comments?per_page=100&page=2") return [];
      if (method === "GET" && path === "/repos/marius-patrik/example/git/matching-refs/heads/df%2F10-") return [];
      if (method === "POST" && path === "/repos/marius-patrik/example/issues/10/labels") return {};
      if (method === "DELETE" && path === "/repos/marius-patrik/example/issues/10/labels/df%3Arunning") return {};
      if (method === "DELETE" && path === "/repos/marius-patrik/example/issues/10/labels/df%3Ablocked") return {};
      if (method === "DELETE" && path === "/repos/marius-patrik/example/issues/10/labels/df%3Adone") return {};
      if (method === "POST" && path === "/repos/marius-patrik/example/issues/10/comments") return {};

      throw new Error(`Unexpected GitHub request: ${method} ${path}`);
    }
  };

  const result = await orchestrate({
    gh,
    controlRepo: { owner: "marius-patrik", repo: "DarkFactory" },
    readinessByRepository: healthyReadiness(),
    registry: { repositories: { "marius-patrik/example": { state: "active" } } },
    repositories: [{ full_name: "marius-patrik/example", archived: false, disabled: false }],
    policy: {
      schemaVersion: 1,
      concurrency: { global: 2, perRepository: 1, perStream: 1 },
      waves: [{ name: "features", streams: ["features", "default"] }],
      dashboard: { enabled: false, issueTitle: "Dashboard" }
    },
    writeLedger: false,
    updateDashboard: false,
    warn: () => {},
    log: () => {}
  });

  assert.deepEqual(result.recoveries, [
    { repo: "marius-patrik/example", issue: 10, type: "none", action: "request-evaluation", reason: "no-usable-branch" }
  ]);
  const labelUpdate = calls.find(
    (call) => call.method === "POST" && call.path === "/repos/marius-patrik/example/issues/10/labels"
  )?.body;
  assert.equal(labelUpdate, undefined);
  const comment = calls.find(
    (call) => call.method === "POST" && call.path === "/repos/marius-patrik/example/issues/10/comments"
  )?.body;
  assert.ok(String(comment?.body).includes(RESUME_MARKER));
  assert.ok(String(comment?.body).includes("no usable branch"));
  assert.equal(calls.some((call) => call.path.endsWith("/actions/workflows/df-work.yml/dispatches")), false);
});

test("orchestrator does not resume running issue with terminal comment", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { orchestrate } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-no-resume-test");
  const calls: Array<{ method: string; path: string }> = [];

  const gh = {
    async graphql() {
      return {
        repository: {
          pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] }
        }
      };
    },
    async request(method: string, path: string) {
      calls.push({ method, path });

      if (method === "GET" && path === "/repos/marius-patrik/example/issues?state=open&per_page=100&page=1") {
        return [{ number: 11, labels: [{ name: "df:running" }] }];
      }
      if (method === "GET" && path === "/repos/marius-patrik/example/issues?state=open&per_page=100&page=2") return [];
      if (method === "GET" && path === "/repos/marius-patrik/example/issues/11/comments?per_page=100&page=1") {
        return [
          { body: "DarkFactory worker started for `marius-patrik/example#11`.", created_at: "2026-07-06T10:00:00Z" },
          { body: "DarkFactory worker opened https://github.com/marius-patrik/example/pull/30.", created_at: "2026-07-06T10:05:00Z" }
        ];
      }
      if (method === "GET" && path === "/repos/marius-patrik/example/issues/11/comments?per_page=100&page=2") return [];

      throw new Error(`Unexpected GitHub request: ${method} ${path}`);
    }
  };

  const result = await orchestrate({
    gh,
    controlRepo: { owner: "marius-patrik", repo: "DarkFactory" },
    readinessByRepository: healthyReadiness(),
    registry: { repositories: { "marius-patrik/example": { state: "active" } } },
    repositories: [{ full_name: "marius-patrik/example", archived: false, disabled: false }],
    policy: {
      schemaVersion: 1,
      concurrency: { global: 2, perRepository: 1, perStream: 1 },
      waves: [{ name: "features", streams: ["features", "default"] }],
      dashboard: { enabled: false, issueTitle: "Dashboard" }
    },
    writeLedger: false,
    updateDashboard: false,
    warn: () => {},
    log: () => {}
  });

  assert.deepEqual(result.recoveries, []);
  assert.equal(calls.some((call) => call.path.includes("/git/matching-refs/")), false);
  assert.equal(calls.some((call) => call.path.endsWith("/actions/workflows/df-work.yml/dispatches")), false);
});

test("orchestrator surfaces recovery decisions in ledger and dashboard", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { DASHBOARD_MARKER, orchestrate } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-resume-dashboard-test");
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const notFound = Object.assign(new Error("not found"), { status: 404 });

  const gh = {
    async graphql() {
      return {
        repository: {
          pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] }
        }
      };
    },
    async request(method: string, path: string, body?: unknown) {
      calls.push({ method, path, body });

      if (method === "GET" && path === "/repos/marius-patrik/example/issues?state=open&per_page=100&page=1") {
        return [{ number: 12, labels: [{ name: "df:running" }] }];
      }
      if (method === "GET" && path === "/repos/marius-patrik/example/issues?state=open&per_page=100&page=2") return [];
      if (method === "GET" && path === "/repos/marius-patrik/example/issues/12/comments?per_page=100&page=1") {
        return [
          { body: "DarkFactory worker started for `marius-patrik/example#12`.", created_at: "2026-07-06T10:00:00Z" }
        ];
      }
      if (method === "GET" && path === "/repos/marius-patrik/example/issues/12/comments?per_page=100&page=2") return [];
      if (method === "GET" && path === "/repos/marius-patrik/example/git/matching-refs/heads/df%2F12-") {
        return [{ ref: "refs/heads/df/12-resume-test", object: { sha: "1".repeat(40) } }];
      }
      if (method === "GET" && path === "/repos/marius-patrik/example/git/ref/heads/dev") throw notFound;
      if (method === "GET" && path === "/repos/marius-patrik/example") return { default_branch: "main", allow_auto_merge: true };
      if (method === "POST" && path === "/repos/marius-patrik/example/issues/12/comments") return {};
      if (method === "POST" && path === "/repos/marius-patrik/DarkFactory/actions/workflows/df-work.yml/dispatches") return {};
      if (method === "POST" && path === "/repos/marius-patrik/DarkFactory/labels") return {};
      if (method === "GET" && path === "/repos/marius-patrik/DarkFactory/issues?state=open&per_page=100&page=1") {
        return [{ number: 99, body: `<!-- ${DASHBOARD_MARKER} -->`, labels: [] }];
      }
      if (method === "PATCH" && path === "/repos/marius-patrik/DarkFactory/issues/99") return {};

      throw new Error(`Unexpected GitHub request: ${method} ${path}`);
    }
  };

  const result = await orchestrate({
    gh,
    controlRepo: { owner: "marius-patrik", repo: "DarkFactory" },
    readinessByRepository: healthyReadiness(),
    registry: { repositories: { "marius-patrik/example": { state: "active" } } },
    repositories: [{ full_name: "marius-patrik/example", archived: false, disabled: false }],
    policy: {
      schemaVersion: 1,
      concurrency: { global: 2, perRepository: 1, perStream: 1 },
      waves: [{ name: "features", streams: ["features", "default"] }],
      dashboard: { enabled: true, issueTitle: "Dashboard" }
    },
    writeLedger: false,
    updateDashboard: true,
    warn: () => {},
    log: () => {}
  });

  assert.deepEqual(result.ledger.recovery, [
    { repo: "marius-patrik/example", issue: 12, type: "branch", action: "resume-branch", reason: "", branch: "df/12-resume-test", head: "1".repeat(40) }
  ]);
  const dashboardUpdate = calls.find(
    (call) => call.method === "PATCH" && call.path === "/repos/marius-patrik/DarkFactory/issues/99"
  );
  assert.ok(String(dashboardUpdate?.body.body).includes("## Worker Recoveries"));
  assert.ok(String(dashboardUpdate?.body.body).includes("## Automation Loop Health"));
  assert.ok(String(dashboardUpdate?.body.body).includes("marius-patrik/example#12"));
});
