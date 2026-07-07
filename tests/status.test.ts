import test from "node:test";
import assert from "node:assert/strict";

import {
  buildStatusReport,
  fetchBlockedIssues,
  fetchLatestLedger,
  fetchManagedRepos,
  fetchRecentRuns,
  fetchRepoLoopState,
  formatStatusReport,
  parseManagedReposJson,
  type GitHubRequester,
  type RepositoryRef
} from "../src/status.js";

function createRequester(
  handlers: Record<string, (parameters: Record<string, unknown>) => { data: unknown; headers?: Record<string, string> } | unknown>
): GitHubRequester {
  return {
    async request(route, parameters) {
      const handler = handlers[route];
      if (!handler) {
        throw new Error(`Unexpected route: ${route}`);
      }
      const result = handler(parameters);
      if (result && typeof result === "object" && "data" in result) {
        return result as { data: unknown; headers?: Record<string, string> };
      }
      return { data: result };
    }
  };
}

function issuesResponse(counts: Record<string, number>, label: string) {
  const count = counts[label] ?? 0;
  return Array.from({ length: count }, (_, index) => ({
    number: 100 + index,
    title: `${label} issue ${index + 1}`,
    html_url: `https://github.com/marius-patrik/dream/issues/${100 + index}`,
    labels: [{ name: label }]
  }));
}

function workflowRunsResponse(runs: Array<Partial<{ id: number; name: string; status: string; conclusion: string | null; created_at: string; updated_at: string; html_url: string }>>) {
  return {
    total_count: runs.length,
    workflow_runs: runs.map((run) => ({
      id: run.id ?? 1,
      name: run.name ?? "workflow",
      workflow_id: 123,
      status: run.status ?? "completed",
      conclusion: run.conclusion ?? "success",
      created_at: run.created_at ?? "2026-07-01T00:00:00Z",
      updated_at: run.updated_at ?? "2026-07-01T00:00:00Z",
      html_url: run.html_url ?? "https://github.com/marius-patrik/agent-darkfactory/actions/runs/1",
      ...run
    }))
  };
}

function encodedJsonFile(content: unknown): { type: "file"; encoding: "base64"; content: string } {
  return {
    type: "file",
    encoding: "base64",
    content: Buffer.from(JSON.stringify(content), "utf8").toString("base64")
  };
}

function managedReposContent(repositories: Record<string, unknown>): { type: "file"; encoding: "base64"; content: string } {
  return encodedJsonFile({ schemaVersion: 1, repositories });
}

test("parseManagedReposJson filters active repositories for the control owner", () => {
  const repos = parseManagedReposJson(
    {
      schemaVersion: 1,
      repositories: {
        "marius-patrik/agent-darkfactory": { state: "active" },
        "marius-patrik/dream": { state: "active" },
        "marius-patrik/skyblock-agent": { state: "parked" },
        "other-owner/project": { state: "active" },
        "marius-patrik/citizen": { state: "archived" }
      }
    },
    "marius-patrik"
  );

  assert.deepEqual(repos, [
    { owner: "marius-patrik", repo: "agent-darkfactory", state: "active" },
    { owner: "marius-patrik", repo: "dream", state: "active" }
  ]);
});

test("fetchManagedRepos reads managed repositories from the control repo via GitHub API", async () => {
  const github = createRequester({
    "GET /repos/{owner}/{repo}/contents/{path}": () =>
      managedReposContent({
        "marius-patrik/agent-darkfactory": { state: "active" },
        "marius-patrik/dream": { state: "active" }
      })
  });

  const repos = await fetchManagedRepos(github, { owner: "marius-patrik", repo: "agent-darkfactory" }, "marius-patrik");

  assert.deepEqual(repos, [
    { owner: "marius-patrik", repo: "agent-darkfactory", state: "active" },
    { owner: "marius-patrik", repo: "dream", state: "active" }
  ]);
});

test("fetchRepoLoopState counts issues by DarkFactory loop labels", async () => {
  const repo: RepositoryRef = { owner: "marius-patrik", repo: "dream" };
  const github = createRequester({
    "GET /repos/{owner}/{repo}/issues": (parameters) => {
      const label = String(parameters.labels);
      const counts: Record<string, number> = { "df:ready": 2, "df:running": 1, "df:ask-owner": 3 };
      return issuesResponse(counts, label);
    }
  });

  const state = await fetchRepoLoopState(github, repo);

  assert.deepEqual(state, {
    owner: "marius-patrik",
    repo: "dream",
    ready: 2,
    running: 1,
    askOwner: 3
  });
});

test("fetchRepoLoopState excludes pull requests from issue counts", async () => {
  const repo: RepositoryRef = { owner: "marius-patrik", repo: "dream" };
  const github = createRequester({
    "GET /repos/{owner}/{repo}/issues": (parameters) => {
      if (parameters.labels === "df:ready") {
        return [
          { number: 1, title: "issue", html_url: "https://example/1" },
          { number: 2, title: "pr", html_url: "https://example/2", pull_request: {} }
        ];
      }
      return [];
    }
  });

  const state = await fetchRepoLoopState(github, repo);

  assert.equal(state.ready, 1);
  assert.equal(state.running, 0);
  assert.equal(state.askOwner, 0);
});

test("fetchRepoLoopState skips malformed issue records instead of failing", async () => {
  const repo: RepositoryRef = { owner: "marius-patrik", repo: "dream" };
  const github = createRequester({
    "GET /repos/{owner}/{repo}/issues": (parameters) => {
      if (parameters.labels === "df:ready") {
        return [
          { number: 1, title: "valid", html_url: "https://example/1" },
          "not-an-object",
          { number: 2, title: "missing-url" },
          { title: "missing-number", html_url: "https://example/4" }
        ];
      }
      return [];
    }
  });

  const state = await fetchRepoLoopState(github, repo);

  assert.equal(state.ready, 1);
});

test("fetchRepoLoopState follows Link headers to paginate issue lists", async () => {
  const repo: RepositoryRef = { owner: "marius-patrik", repo: "dream" };
  const github = createRequester({
    "GET /repos/{owner}/{repo}/issues": (parameters) => {
      const page = Number(parameters.page);
      if (page === 1) {
        return {
          data: [{ number: 1, title: "page-1", html_url: "https://example/1" }],
          headers: { link: '<https://api.github.com/repos/marius-patrik/dream/issues?page=2>; rel="next"' }
        };
      }
      return {
        data: [{ number: 2, title: "page-2", html_url: "https://example/2" }],
        headers: {}
      };
    }
  });

  const state = await fetchRepoLoopState(github, repo);

  assert.equal(state.ready, 2);
});

test("fetchRecentRuns returns latest plan, orchestrate, and in-flight work runs", async () => {
  const repo: RepositoryRef = { owner: "marius-patrik", repo: "agent-darkfactory" };
  const github = createRequester({
    "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs": (parameters) => {
      const workflowId = String(parameters.workflow_id);
      if (workflowId === "df-plan.yml") {
        return workflowRunsResponse([
          { id: 10, name: "plan-latest", status: "completed", conclusion: "success", created_at: "2026-07-05T08:00:00Z" }
        ]);
      }
      if (workflowId === "df-orchestrate.yml") {
        return workflowRunsResponse([
          { id: 20, name: "orchestrate-latest", status: "completed", conclusion: "failure", created_at: "2026-07-05T07:00:00Z" }
        ]);
      }
      if (workflowId === "df-work.yml") {
        return workflowRunsResponse([
          { id: 31, name: "work-in-flight", status: "in_progress", conclusion: null, created_at: "2026-07-05T06:00:00Z" },
          { id: 32, name: "work-completed", status: "completed", conclusion: "success", created_at: "2026-07-05T05:00:00Z" }
        ]);
      }
      throw new Error(`unexpected workflow: ${workflowId}`);
    }
  });

  const runs = await fetchRecentRuns(github, repo);

  assert.equal(runs.plan?.id, 10);
  assert.equal(runs.orchestrate?.id, 20);
  assert.equal(runs.inFlightWork.length, 1);
  assert.equal(runs.inFlightWork[0]?.id, 31);
});

test("fetchLatestLedger reads the most recent df-orchestrate ledger", async () => {
  const dataRepo: RepositoryRef = { owner: "marius-patrik", repo: "data-agentos" };
  const controlRepo: RepositoryRef = { owner: "marius-patrik", repo: "agent-darkfactory" };
  const github = createRequester({
    "GET /repos/{owner}/{repo}/contents/{path}": (parameters) => {
      const path = String(parameters.path);
      if (path === "runs/marius-patrik/agent-darkfactory") {
        return [
          { name: "2026-07-05T08-00-00Z-df-orchestrate.json", type: "file" },
          { name: "2026-07-04T08-00-00Z-df-orchestrate.json", type: "file" },
          { name: "2026-07-05T07-00-00Z-df-plan.json", type: "file" }
        ];
      }
      if (path === "runs/marius-patrik/agent-darkfactory/2026-07-05T08-00-00Z-df-orchestrate.json") {
        return {
          type: "file",
          encoding: "base64",
          content: Buffer.from(
            JSON.stringify({
              kind: "df-orchestrate",
              target_repo: "marius-patrik/agent-darkfactory",
              created_at: "2026-07-05T08:00:00Z",
              dispatched: [{ repo: "marius-patrik/dream", issue: 1 }, { repo: "marius-patrik/dream", issue: 2 }]
            }),
            "utf8"
          ).toString("base64")
        };
      }
      throw new Error(`unexpected path: ${path}`);
    }
  });

  const ledger = await fetchLatestLedger(github, dataRepo, controlRepo);

  assert.deepEqual(ledger, { dispatchCount: 2, timestamp: "2026-07-05T08:00:00Z" });
});

test("fetchBlockedIssues aggregates ask-owner issues across managed repos", async () => {
  const repos: RepositoryRef[] = [
    { owner: "marius-patrik", repo: "dream" },
    { owner: "marius-patrik", repo: "agents-plugin" }
  ];
  const github = createRequester({
    "GET /repos/{owner}/{repo}/issues": (parameters) => {
      const repo = String(parameters.repo);
      if (repo === "dream") {
        return [{ number: 5, title: "Need owner decision", html_url: "https://github.com/marius-patrik/dream/issues/5" }];
      }
      if (repo === "agents-plugin") {
        return [
          { number: 8, title: "Clarify scope", html_url: "https://github.com/marius-patrik/agents-plugin/issues/8" },
          { number: 12, title: "Budget approval", html_url: "https://github.com/marius-patrik/agents-plugin/issues/12" }
        ];
      }
      return [];
    }
  });

  const blocked = await fetchBlockedIssues(github, repos);

  assert.deepEqual(blocked, [
    { repo: "marius-patrik/agents-plugin", number: 8, title: "Clarify scope", url: "https://github.com/marius-patrik/agents-plugin/issues/8" },
    { repo: "marius-patrik/agents-plugin", number: 12, title: "Budget approval", url: "https://github.com/marius-patrik/agents-plugin/issues/12" },
    { repo: "marius-patrik/dream", number: 5, title: "Need owner decision", url: "https://github.com/marius-patrik/dream/issues/5" }
  ]);
});

function createStatusRequester(): GitHubRequester {
  return createRequester({
    "GET /repos/{owner}/{repo}/contents/{path}": (parameters) => {
      const path = String(parameters.path);
      if (path === ".darkfactory/managed-repos.json") {
        return managedReposContent({ "marius-patrik/dream": { state: "active" } });
      }
      if (path === "PRD.md") {
        return { type: "file" };
      }
      if (path === "runs/marius-patrik/agent-darkfactory") {
        return [{ name: "2026-07-05T08-00-00Z-df-orchestrate.json", type: "file" }];
      }
      if (path === "runs/marius-patrik/agent-darkfactory/2026-07-05T08-00-00Z-df-orchestrate.json") {
        return encodedJsonFile({
          created_at: "2026-07-05T08:00:00Z",
          dispatched: [{ repo: "marius-patrik/dream", issue: 1 }]
        });
      }
      throw new Error(`unexpected path: ${path}`);
    },
    "GET /repos/{owner}/{repo}": () => ({ default_branch: "main" }),
    "GET /repos/{owner}/{repo}/git/trees/{tree_sha}": () => ({
      tree: [
        { type: "blob", path: "PRD.md" },
        { type: "blob", path: "packages/core/package.json" },
        { type: "blob", path: "packages/core/PRD.md" }
      ]
    }),
    "GET /repos/{owner}/{repo}/issues": () => [],
    "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs": (parameters) => {
      const workflowId = String(parameters.workflow_id);
      if (workflowId === "df-plan.yml") {
        return workflowRunsResponse([{ id: 1, name: "plan", status: "completed", conclusion: "success" }]);
      }
      if (workflowId === "df-orchestrate.yml") {
        return workflowRunsResponse([{ id: 2, name: "orchestrate", status: "completed", conclusion: "success" }]);
      }
      return workflowRunsResponse([]);
    }
  });
}

test("formatStatusReport renders a human-readable summary", async () => {
  const report = await buildStatusReport(createStatusRequester());
  const formatted = formatStatusReport(report);

  assert.match(formatted, /DarkFactory orchestration status/);
  assert.match(formatted, /marius-patrik\/dream/);
  assert.match(formatted, /df-plan:/);
  assert.match(formatted, /df-orchestrate:/);
  assert.match(formatted, /Latest ledger: 1 dispatched at 2026-07-05T08:00:00Z/);
  assert.match(formatted, /Blocked: none/);
  assert.match(formatted, /PRD coverage:/);
  assert.match(formatted, /Backlog coverage:/);
});

test("buildStatusReport produces serializable JSON output", async () => {
  const report = await buildStatusReport(createStatusRequester());
  const json = JSON.parse(JSON.stringify(report));

  assert.ok(Array.isArray(json.managedRepos));
  assert.ok(Array.isArray(json.loopState));
  assert.ok(typeof json.recentRuns === "object");
  assert.ok(typeof json.latestLedger === "object" || json.latestLedger === null);
  assert.ok(Array.isArray(json.blocked));
  assert.ok(Array.isArray(json.prdCoverage));
  assert.ok(Array.isArray(json.backlogCoverage));
});

test("fetchPrdCoverage reports root and package PRD presence", async () => {
  const github = createRequester({
    "GET /repos/{owner}/{repo}": () => ({ default_branch: "main" }),
    "GET /repos/{owner}/{repo}/contents/{path}": (parameters) => {
      if (parameters.path === "PRD.md") {
        return { type: "file" };
      }
      throw { status: 404 };
    },
    "GET /repos/{owner}/{repo}/git/trees/{tree_sha}": () => ({
      tree: [
        { type: "blob", path: "PRD.md" },
        { type: "blob", path: "packages/core/package.json" },
        { type: "blob", path: "packages/core/PRD.md" },
        { type: "blob", path: "packages/ui/package.json" }
      ]
    })
  });

  const { fetchPrdCoverage } = await import("../src/status.js");
  const coverage = await fetchPrdCoverage(github, [{ owner: "marius-patrik", repo: "dream" }]);

  assert.deepEqual(coverage, [
    { owner: "marius-patrik", repo: "dream", rootPrd: true, packagePrds: 1, totalPackages: 2 }
  ]);
});

test("fetchBacklogCoverage counts PRD-tracked open issues", async () => {
  const github = createRequester({
    "GET /repos/{owner}/{repo}/issues": () => [
      { number: 1, title: "Tracked", html_url: "https://example/1", body: "<!-- df-prd:milestones-m1 -->" },
      { number: 2, title: "Untracked", html_url: "https://example/2", body: "Plain issue." },
      { number: 3, title: "PR", html_url: "https://example/3", pull_request: {} }
    ]
  });

  const { fetchBacklogCoverage } = await import("../src/status.js");
  const coverage = await fetchBacklogCoverage(github, [{ owner: "marius-patrik", repo: "dream" }]);

  assert.deepEqual(coverage, [
    { owner: "marius-patrik", repo: "dream", openIssues: 2, prdTrackedIssues: 1 }
  ]);
});
