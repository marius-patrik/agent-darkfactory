import assert from "node:assert/strict";
import test from "node:test";

function blockedComment(createdAt: string) {
  return {
    body: "DarkFactory worker blocked.\n\nBlocker:\n\n```text\nfailure\n```",
    created_at: createdAt
  };
}

function labeledEvent(label: string, createdAt: string) {
  return {
    event: "labeled",
    label: { name: label },
    created_at: createdAt
  };
}

test("orchestrator dispatches open df:ready issues in active managed repos", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { orchestrate } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-test");
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const notFound = Object.assign(new Error("not found"), { status: 404 });

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
            number: 42,
            body: "Directly queued issue without a PRD marker.",
            labels: [{ name: "df:ready" }]
          }
        ];
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
        throw notFound;
      }
      if (method === "POST" && path === "/repos/marius-patrik/example/issues/42/labels") {
        return {};
      }
      if (method === "DELETE" && path === "/repos/marius-patrik/example/issues/42/labels/df%3Aready") {
        return null;
      }
      if (method === "POST" && path === "/repos/marius-patrik/agent-darkfactory/actions/workflows/df-work.yml/dispatches") {
        return null;
      }

      throw new Error(`Unexpected GitHub request: ${method} ${path}`);
    }
  };

  const result = await orchestrate({
    gh,
    controlRepo: { owner: "marius-patrik", repo: "agent-darkfactory" },
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

test("orchestrator does not dispatch issues that already have an open worker PR", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { orchestrate } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-existing-pr-test");
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];

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
                author: { login: "mp-agents[bot]" }
              }
            ]
          }
        }
      };
    },
    async request(method: string, path: string, body?: unknown) {
      calls.push({ method, path, body });

      if (method === "GET" && path === "/repos/marius-patrik/example/issues?state=open&per_page=100&page=1") {
        return [{ number: 8, labels: [{ name: "df:ready" }] }];
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
    controlRepo: { owner: "marius-patrik", repo: "agent-darkfactory" },
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

test("orchestrator selects next ready issues by priority, blocked-by, and stream lane", async () => {
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
    [13, 14, 12]
  );
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
    }
  ];

  const selected = selectDispatchableIssues(issues, { repository, openIssueIndex, knownRepositories });

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
  const snapshots = [
    {
      repository: { owner: "marius-patrik", repo: "example" },
      openIssues: [
        { number: 20, title: "Sequenced", body: "Blocked-by: #19", labels: [{ name: "P0" }] },
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

      if (method === "GET" && path === "/repos/marius-patrik/example/issues/20/comments?per_page=100&page=1") return [];
      if (method === "GET" && path === "/repos/marius-patrik/example/issues/20/timeline?per_page=100&page=1") return [];
      if (method === "POST" && path === "/repos/marius-patrik/example/issues/20/labels") return {};
      if (method === "GET" && path === "/repos/marius-patrik/example/issues/26/comments?per_page=100&page=1") return [];
      if (method === "GET" && path === "/repos/marius-patrik/example/issues/26/timeline?per_page=100&page=1") return [];
      if (method === "POST" && path === "/repos/marius-patrik/example/issues/26/labels") return {};

      throw new Error(`Unexpected GitHub request: ${method} ${path}`);
    }
  };

  const autoReadied = await autoReadySequencedIssues(gh, snapshots, () => {});

  assert.deepEqual(autoReadied, [
    { repo: "marius-patrik/example", issue: 20 },
    { repo: "marius-patrik/example", issue: 26 }
  ]);
  assert.ok(snapshots[0].openIssues[0].labels.some((label: { name: string }) => label.name === "df:ready"));
  assert.equal(calls.some((call) => call.path === "/repos/marius-patrik/example/issues/21/labels"), false);
  assert.equal(calls.some((call) => call.path === "/repos/marius-patrik/example/issues/22/labels"), false);
  assert.equal(calls.some((call) => call.path === "/repos/marius-patrik/example/issues/24/labels"), false);
  assert.equal(calls.some((call) => call.path === "/repos/marius-patrik/example/issues/25/labels"), false);
  // Spec (#168): planning signals (df:planned / df-prd:) make an issue
  // eligible even without Blocked-by refs; refs gate only when present.
  assert.ok(calls.some((call) => call.method === "POST" && call.path === "/repos/marius-patrik/example/issues/26/labels"));
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
    targetIssue: { repository: { owner: "marius-patrik", repo: "example" }, issueNumber: 30 }
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

  const autoReadied = await autoReadySequencedIssues(gh, snapshots, () => {});

  assert.deepEqual(autoReadied, []);
  assert.equal(calls.some((call) => call.method === "POST" && call.path === "/repos/marius-patrik/example/issues/31/labels"), false);
  assert.equal(snapshots[0].openIssues[0].labels.some((label: { name: string }) => label.name === "df:ready"), false);
});

test("orchestration plan applies wave gates and cross-repo concurrency caps", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { buildOrchestrationPlan } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-l6-plan-test");

  const policy = {
    concurrency: { global: 2, perRepository: 1, perStream: 1 },
    waves: [
      { name: "hygiene", streams: ["hygiene"] },
      { name: "enforcement", streams: ["enforcement"] },
      { name: "features", streams: ["features", "default"] }
    ],
    dashboard: { enabled: true }
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
      ["marius-patrik/pkg-a", "hygiene", "hygiene"],
      ["marius-patrik/pkg-b", "hygiene", "hygiene"],
      ["marius-patrik/pkg-c", "hygiene", "features"]
    ]
  );
});

test("orchestrator updates the L6 dashboard issue after dispatch", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { DASHBOARD_MARKER, orchestrate } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-dashboard-test");
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const notFound = Object.assign(new Error("not found"), { status: 404 });

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
        return [{ number: 7, title: "Feature", body: "", labels: [{ name: "df:ready" }, { name: "stream:features" }] }];
      }
      if (method === "GET" && path === "/repos/marius-patrik/example/issues?state=open&per_page=100&page=2") return [];
      if (method === "GET" && path === "/repos/marius-patrik/example") return { default_branch: "main", allow_auto_merge: true };
      if (method === "GET" && path === "/repos/marius-patrik/example/git/ref/heads/dev") throw notFound;
      if (method === "GET" && path === "/repos/marius-patrik/example/branches/main/protection") throw notFound;
      if (method === "POST" && path === "/repos/marius-patrik/example/issues/7/labels") return {};
      if (method === "DELETE" && path === "/repos/marius-patrik/example/issues/7/labels/df%3Aready") return {};
      if (method === "POST" && path === "/repos/marius-patrik/agent-darkfactory/actions/workflows/df-work.yml/dispatches") return {};
      if (method === "POST" && path === "/repos/marius-patrik/agent-darkfactory/labels") return {};
      if (method === "GET" && path === "/repos/marius-patrik/agent-darkfactory/issues?state=open&per_page=100&page=1") {
        return [{ number: 99, body: `<!-- ${DASHBOARD_MARKER} -->`, labels: [] }];
      }
      if (method === "PATCH" && path === "/repos/marius-patrik/agent-darkfactory/issues/99") return {};

      throw new Error(`Unexpected GitHub request: ${method} ${path}`);
    }
  };

  const result = await orchestrate({
    gh,
    controlRepo: { owner: "marius-patrik", repo: "agent-darkfactory" },
    registry: { repositories: { "marius-patrik/example": { state: "active" } } },
    repositories: [{ full_name: "marius-patrik/example", archived: false, disabled: false }],
    policy: {
      concurrency: { global: 2, perRepository: 1, perStream: 1 },
      waves: [{ name: "features", streams: ["features", "default"] }],
      dashboard: { enabled: true, issueTitle: "Dashboard" }
    },
    writeLedger: false,
    warn: () => {},
    log: () => {}
  });

  assert.deepEqual(result.dispatched.map((dispatch: { repo: string; issue: number }) => [dispatch.repo, dispatch.issue]), [
    ["marius-patrik/example", 7]
  ]);
  const dashboardUpdate = calls.find((call) => call.method === "PATCH" && call.path === "/repos/marius-patrik/agent-darkfactory/issues/99");
  assert.equal(dashboardUpdate?.body.title, "Dashboard");
  assert.match(dashboardUpdate?.body.body, new RegExp(DASHBOARD_MARKER));
  assert.match(dashboardUpdate?.body.body, /marius-patrik\/example#7/);
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
      if (method === "POST" && path === "/repos/marius-patrik/agent-darkfactory/labels") return {};
      if (method === "GET" && path === "/repos/marius-patrik/agent-darkfactory/issues?state=open&per_page=100&page=1") {
        return [{ number: 99, body: "<!-- df-dashboard:orchestration -->", labels: [] }];
      }
      if (method === "PATCH" && path === "/repos/marius-patrik/agent-darkfactory/issues/99") return {};

      throw new Error(`Unexpected GitHub request: ${method} ${path}`);
    }
  };

  const result = await orchestrate({
    gh,
    controlRepo: { owner: "marius-patrik", repo: "agent-darkfactory" },
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
  const dashboardUpdate = calls.find((call) => call.method === "PATCH" && call.path === "/repos/marius-patrik/agent-darkfactory/issues/99");
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
        return [{ number: 30, title: "Reset lane", body: "", labels: [{ name: "df:ready" }] }];
      }
      if (method === "GET" && path === "/repos/marius-patrik/example/issues?state=open&per_page=100&page=2") return [];
      if (method === "GET" && path === "/repos/marius-patrik/example/issues/30/comments?per_page=100&page=1") {
        return [
          blockedComment("2026-07-06T10:00:00Z"),
          blockedComment("2026-07-06T10:10:00Z"),
          blockedComment("2026-07-06T10:20:00Z")
        ];
      }
      if (method === "GET" && path === "/repos/marius-patrik/example/issues/30/comments?per_page=100&page=2") return [];
      if (method === "GET" && path === "/repos/marius-patrik/example/issues/30/timeline?per_page=100&page=1") {
        return [labeledEvent("df:ready", "2026-07-06T10:30:00Z")];
      }
      if (method === "GET" && path === "/repos/marius-patrik/example/issues/30/timeline?per_page=100&page=2") return [];
      if (method === "GET" && path === "/repos/marius-patrik/example") return { default_branch: "main", allow_auto_merge: true };
      if (method === "GET" && path === "/repos/marius-patrik/example/git/ref/heads/dev") throw notFound;
      if (method === "GET" && path === "/repos/marius-patrik/example/branches/main/protection") throw notFound;
      if (method === "POST" && path === "/repos/marius-patrik/example/issues/30/labels") return {};
      if (method === "DELETE" && path === "/repos/marius-patrik/example/issues/30/labels/df%3Aready") return {};
      if (method === "POST" && path === "/repos/marius-patrik/agent-darkfactory/actions/workflows/df-work.yml/dispatches") return {};

      throw new Error(`Unexpected GitHub request: ${method} ${path}`);
    }
  };

  const result = await orchestrate({
    gh,
    controlRepo: { owner: "marius-patrik", repo: "agent-darkfactory" },
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
          { number: 12, title: "Run me", body: "", labels: [{ name: "df:ready" }] },
          { number: 99, title: "Do not run me", body: "", labels: [{ name: "df:ready" }] }
        ];
      }
      if (method === "GET" && path === "/repos/marius-patrik/example/issues?state=open&per_page=100&page=2") return [];
      if (method === "GET" && path === "/repos/marius-patrik/example") return { default_branch: "main", allow_auto_merge: true };
      if (method === "GET" && path === "/repos/marius-patrik/example/git/ref/heads/dev") throw notFound;
      if (method === "GET" && path === "/repos/marius-patrik/example/branches/main/protection") throw notFound;
      if (method === "DELETE" && path === "/repos/marius-patrik/example/issues/12/labels/df%3Aready") return {};
      if (method === "POST" && path === "/repos/marius-patrik/agent-darkfactory/actions/workflows/df-work.yml/dispatches") return {};

      throw new Error(`Unexpected GitHub request: ${method} ${path}`);
    }
  };

  try {
    const result = await orchestrate({
      gh,
      controlRepo: { owner: "marius-patrik", repo: "agent-darkfactory" },
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
    assert.equal(calls.some((call) => call.path.startsWith("/repos/marius-patrik/other/")), false);
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

test("parseEventRequest accepts df:ready label events for one issue", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { parseEventRequest } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-label-event-parse-test");

  const request = parseEventRequest(JSON.stringify({
    repository: { full_name: "marius-patrik/example" },
    issue: { number: 44 },
    label: { name: "df:ready" }
  }), "issues", () => {});

  assert.deepEqual(request, {
    repository: { owner: "marius-patrik", repo: "example" },
    issueNumber: 44,
    slashRun: false,
    readyLabel: true
  });
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
  assert.equal(parseWorkflowDispatchRequest("", "", "", () => {}), null);
});

test("orchestrator turns scoped /df run dispatches into df:ready before dispatch", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { orchestrate } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-forwarded-slash-run-test");
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const notFound = Object.assign(new Error("not found"), { status: 404 });

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
          { number: 12, title: "Run me", body: "", labels: [{ name: "df:ready" }] },
          { number: 99, title: "Do not run me", body: "", labels: [{ name: "df:ready" }] }
        ];
      }
      if (method === "GET" && path === "/repos/marius-patrik/example/issues?state=open&per_page=100&page=2") return [];
      if (method === "GET" && path === "/repos/marius-patrik/example") return { default_branch: "main", allow_auto_merge: true };
      if (method === "GET" && path === "/repos/marius-patrik/example/git/ref/heads/dev") throw notFound;
      if (method === "GET" && path === "/repos/marius-patrik/example/branches/main/protection") throw notFound;
      if (method === "DELETE" && path === "/repos/marius-patrik/example/issues/12/labels/df%3Aready") return {};
      if (method === "POST" && path === "/repos/marius-patrik/agent-darkfactory/actions/workflows/df-work.yml/dispatches") return {};

      throw new Error(`Unexpected GitHub request: ${method} ${path}`);
    }
  };

  const result = await orchestrate({
    gh,
    controlRepo: { owner: "marius-patrik", repo: "agent-darkfactory" },
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
  assert.equal(calls.some((call) => call.path.startsWith("/repos/marius-patrik/other/")), false);
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
      controlRepo: { owner: "marius-patrik", repo: "agent-darkfactory" },
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
      controlRepo: { owner: "marius-patrik", repo: "agent-darkfactory" },
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
