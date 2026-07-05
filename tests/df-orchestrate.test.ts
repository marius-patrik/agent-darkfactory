import assert from "node:assert/strict";
import test from "node:test";

test("orchestrator dispatches open df:ready issues in active managed repos", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { orchestrate } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-test");
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const notFound = Object.assign(new Error("not found"), { status: 404 });

  const gh = baseGithubMock(calls, {
    issues: [
      {
        number: 42,
        title: "Queued worker",
        body: "Directly queued issue without a PRD marker.",
        state: "open",
        labels: [{ name: "df:ready" }, { name: "roadmap" }]
      }
    ],
    graphql: async () => emptyPullRequestConnection()
  });

  gh.request = async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });

    const common = await baseResponse(method, path, body, {
      issues: [
        {
          number: 42,
          title: "Queued worker",
          body: "Directly queued issue without a PRD marker.",
          state: "open",
          labels: [{ name: "df:ready" }, { name: "roadmap" }]
        }
      ]
    });
    if (common.handled) return common.value;

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

  assert.deepEqual(result.dispatched, [{ repo: "marius-patrik/example", issue: 42, streams: ["default"] }]);
  assert.deepEqual(
    calls.find((call) => call.method === "POST" && call.path === "/repos/marius-patrik/example/issues/42/labels")?.body,
    { labels: ["df:running"] }
  );
  assert.ok(calls.some((call) => call.method === "DELETE" && call.path === "/repos/marius-patrik/example/issues/42/labels/df%3Aready"));
  assert.deepEqual(
    calls.find((call) => call.method === "POST" && call.path.endsWith("/actions/workflows/df-work.yml/dispatches"))?.body,
    { ref: "main", inputs: { repo: "marius-patrik/example", issue_number: "42" } }
  );
  assert.match(result.brief, /Token use: 0 model calls/);
});

test("orchestrator does not dispatch issues that already have an open worker PR", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { orchestrate } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-existing-pr-test");
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];

  const gh = baseGithubMock(calls, {
    issues: [{ number: 8, title: "Existing worker", body: "", state: "open", labels: [{ name: "df:ready" }, { name: "roadmap" }] }],
    graphql: async () => ({
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
    })
  });

  const baseRequest = gh.request;
  gh.request = async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    if (method === "POST" && path === "/repos/marius-patrik/example/issues/8/labels") return {};
    if (method === "DELETE" && path === "/repos/marius-patrik/example/issues/8/labels/df%3Aready") return null;
    return baseRequest(method, path, body);
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

test("orchestrator sequences Blocked-by issues before dispatch", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { orchestrate } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-blocked-by-test");
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const issues = [
    { number: 1, title: "Predecessor", body: "", state: "open", labels: [{ name: "roadmap" }, { name: "df:running" }] },
    { number: 2, title: "Successor", body: "## Sequencing\n\nBlocked-by: #1", state: "open", labels: [{ name: "df:ready" }, { name: "roadmap" }] }
  ];
  const gh = baseGithubMock(calls, { issues, graphql: async () => emptyPullRequestConnection() });
  const baseRequest = gh.request;
  gh.request = async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    if (method === "DELETE" && path === "/repos/marius-patrik/example/issues/2/labels/df%3Aready") return null;
    return baseRequest(method, path, body);
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
  assert.ok(calls.some((call) => call.method === "DELETE" && call.path === "/repos/marius-patrik/example/issues/2/labels/df%3Aready"));
  assert.ok(result.ledger.actions.some((action: any) => action.action === "remove-ready-blocked-by" && action.issue === "#2"));
});

test("orchestrator marks resolved sequenced work ready and respects stream caps", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { orchestrate } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-stream-cap-test");
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const notFound = Object.assign(new Error("not found"), { status: 404 });
  const issues = [
    { number: 1, title: "Closed predecessor", body: "", state: "closed", labels: [{ name: "roadmap" }] },
    { number: 2, title: "Stream item A", body: "Blocked-by: #1", state: "open", labels: [{ name: "roadmap" }, { name: "stream:core" }] },
    { number: 3, title: "Stream item B", body: "", state: "open", labels: [{ name: "df:ready" }, { name: "roadmap" }, { name: "stream:core" }] }
  ];

  const gh = baseGithubMock(calls, {
    issues: issues.filter((issue) => issue.state === "open"),
    graphql: async () => emptyPullRequestConnection()
  });

  gh.request = async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });

    if (method === "GET" && path === "/repos/marius-patrik/example/issues/1") {
      return issues[0];
    }
    const common = await baseResponse(method, path, body, {
      issues: issues.filter((issue) => issue.state === "open")
    });
    if (common.handled) return common.value;
    if (method === "GET" && path === "/repos/marius-patrik/example/git/ref/heads/dev") throw notFound;
    if (method === "GET" && path === "/repos/marius-patrik/example/branches/main/protection") throw notFound;
    if (method === "POST" && path === "/repos/marius-patrik/example/issues/2/labels") return {};
    if (method === "POST" && path === "/repos/marius-patrik/example/issues/3/labels") return {};
    if (method === "DELETE" && path === "/repos/marius-patrik/example/issues/2/labels/df%3Adone") return null;
    if (method === "DELETE" && path === "/repos/marius-patrik/example/issues/2/labels/df%3Aready") return null;
    if (method === "DELETE" && path === "/repos/marius-patrik/example/issues/3/labels/df%3Aready") return null;
    if (method === "POST" && path === "/repos/marius-patrik/agent-darkfactory/actions/workflows/df-work.yml/dispatches") return null;
    throw new Error(`Unexpected GitHub request: ${method} ${path}`);
  };

  const result = await orchestrate({
    gh,
    controlRepo: { owner: "marius-patrik", repo: "agent-darkfactory" },
    registry: { repositories: { "marius-patrik/example": { state: "active" } } },
    repositories: [{ full_name: "marius-patrik/example", archived: false, disabled: false }],
    writeLedger: false,
    updateDashboard: false,
    limits: { global: 5, perRepo: 5, perStream: 1 },
    warn: () => {},
    log: () => {}
  });

  assert.equal(result.dispatched.length, 1);
  assert.equal(result.dispatched[0].streams[0], "core");
  assert.ok(result.ledger.actions.some((action: any) => action.action === "mark-ready" && action.issue === "#2"));
  assert.ok(result.ledger.actions.some((action: any) => action.action === "defer-capacity" && action.reason === "concurrency-cap"));
});

test("orchestrator writes dashboard digest and escalates repeated failures to df:ask-owner issues", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { orchestrate } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-dashboard-test");
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const issue = {
    number: 9,
    title: "Repeated failure",
    body: "",
    state: "open",
    labels: [{ name: "roadmap" }, { name: "df:blocked" }]
  };

  const gh = baseGithubMock(calls, {
    issues: [issue],
    controlIssues: [],
    graphql: async () => emptyPullRequestConnection()
  });

  gh.request = async (method: string, path: string, body?: any) => {
    calls.push({ method, path, body });
    const common = await baseResponse(method, path, body, { issues: [issue], controlIssues: [] });
    if (common.handled) return common.value;
    if (method === "GET" && path === "/repos/marius-patrik/example/issues/9/comments?per_page=100") {
      return [
        { body: "DarkFactory worker blocked." },
        { body: "DarkFactory follow-through blocked this worker PR." },
        { body: "DarkFactory worker blocked." }
      ];
    }
    if (method === "POST" && path === "/repos/marius-patrik/example/labels") return {};
    if (method === "PATCH" && path.startsWith("/repos/marius-patrik/example/labels/")) return {};
    if (method === "POST" && path === "/repos/marius-patrik/example/issues") return { number: 100, ...body };
    if (method === "POST" && path === "/repos/marius-patrik/agent-darkfactory/issues") return { number: 200, ...body };
    throw new Error(`Unexpected GitHub request: ${method} ${path}`);
  };

  const result = await orchestrate({
    gh,
    controlRepo: { owner: "marius-patrik", repo: "agent-darkfactory" },
    registry: { repositories: { "marius-patrik/example": { state: "active" } } },
    repositories: [{ full_name: "marius-patrik/example", archived: false, disabled: false }],
    writeLedger: false,
    updateDashboard: true,
    warn: () => {},
    log: () => {}
  });

  assert.ok(calls.some((call) => call.method === "POST" && call.path === "/repos/marius-patrik/example/issues" && call.body.labels.includes("df:ask-owner")));
  assert.ok(calls.some((call) => call.method === "POST" && call.path === "/repos/marius-patrik/agent-darkfactory/issues" && String(call.body.body).includes("orchestrator-dashboard")));
  assert.ok(result.ledger.escalations.some((action: any) => action.reason === "repeated-worker-failure"));
});

function baseGithubMock(calls: Array<{ method: string; path: string; body?: unknown }>, options: any) {
  return {
    graphql: options.graphql ?? (async () => emptyPullRequestConnection()),
    async request(method: string, path: string, body?: unknown) {
      calls.push({ method, path, body });
      const response = await baseResponse(method, path, body, options);
      if (response.handled) return response.value;
      throw new Error(`Unexpected GitHub request: ${method} ${path}`);
    }
  };
}

async function baseResponse(method: string, path: string, _body: unknown, options: any) {
  const issues = options.issues ?? [];
  const controlIssues = options.controlIssues ?? [];

  if (method === "GET" && path === "/repos/marius-patrik/example") {
    return { handled: true, value: { default_branch: "main", allow_auto_merge: true } };
  }
  if (method === "GET" && path === "/repos/marius-patrik/example/issues?state=open&per_page=100&page=1") {
    return { handled: true, value: issues };
  }
  if (method === "GET" && path === "/repos/marius-patrik/example/issues?state=open&per_page=100&page=2") {
    return { handled: true, value: [] };
  }
  if (method === "GET" && path === "/repos/marius-patrik/example/branches/main") {
    return { handled: true, value: { commit: { sha: "abc123" }, protected: false } };
  }
  if (method === "GET" && path === "/repos/marius-patrik/example/contents/PRD.md?ref=main") {
    return {
      handled: true,
      value: {
        type: "file",
        encoding: "base64",
        sha: "prd123",
        content: Buffer.from("# PRD\n", "utf8").toString("base64")
      }
    };
  }
  if (method === "GET" && path === "/repos/marius-patrik/example/actions/runs?branch=main&per_page=10") {
    return { handled: true, value: { workflow_runs: [{ name: "validate", status: "completed", conclusion: "success" }] } };
  }
  if (method === "GET" && path === "/repos/marius-patrik/agent-darkfactory/issues?state=open&per_page=100&page=1") {
    return { handled: true, value: controlIssues };
  }
  if (method === "GET" && path === "/repos/marius-patrik/agent-darkfactory/issues?state=open&per_page=100&page=2") {
    return { handled: true, value: [] };
  }

  return { handled: false, value: undefined };
}

function emptyPullRequestConnection() {
  return {
    repository: {
      pullRequests: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: []
      }
    }
  };
}
