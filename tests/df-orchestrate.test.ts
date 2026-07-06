import assert from "node:assert/strict";
import test from "node:test";

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
    }
  ]);

  assert.deepEqual(
    selected.map((issue: { number: number }) => issue.number),
    [13, 14, 16, 12]
  );
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
        return [{ number: 12, title: "Run me", body: "", labels: [{ name: "df:ready" }] }];
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
      registry: { repositories: { "marius-patrik/example": { state: "active" } } },
      repositories: [{ full_name: "marius-patrik/example", archived: false, disabled: false }],
      trigger: "issue_comment",
      writeLedger: false,
      updateDashboard: false,
      warn: () => {},
      log: () => {}
    });

    assert.deepEqual(result.dispatched, [{ repo: "marius-patrik/example", issue: 12, wave: "features", streams: ["default"] }]);
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

  assert.deepEqual(request, {
    repository: { owner: "marius-patrik", repo: "example" },
    issueNumber: 12,
    slashRun: false
  });
});
