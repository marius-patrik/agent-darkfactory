import assert from "node:assert/strict";
import test from "node:test";

function encodedContent(value: string) {
  return {
    type: "file",
    encoding: "base64",
    content: Buffer.from(value, "utf8").toString("base64")
  };
}

test("orchestrator synthesizes state and dispatches ready issues within caps", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { orchestrate } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-dispatch-test");
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const notFound = Object.assign(new Error("not found"), { status: 404 });

  const gh = {
    async request(method: string, path: string, body?: unknown) {
      calls.push({ method, path, body });

      if (method === "GET" && path === "/repos/marius-patrik/example") {
        return { default_branch: "main", allow_auto_merge: true, archived: false, disabled: false };
      }
      if (method === "GET" && path === "/repos/marius-patrik/example/issues?state=open&per_page=100&page=1") {
        return [
          {
            number: 42,
            title: "Ready task",
            body: "Directly queued issue without a PRD marker.",
            labels: [{ name: "P1" }, { name: "roadmap" }, { name: "df:ready" }]
          }
        ];
      }
      if (method === "GET" && path === "/repos/marius-patrik/example/issues?state=open&per_page=100&page=2") {
        return [];
      }
      if (method === "GET" && path === "/repos/marius-patrik/example/pulls?state=open&per_page=100&page=1") {
        return [];
      }
      if (method === "GET" && path === "/repos/marius-patrik/example/actions/runs?per_page=20") {
        return {
          workflow_runs: [
            {
              name: "validate",
              status: "completed",
              conclusion: "success",
              created_at: "2026-07-05T00:00:00Z",
              html_url: "https://github.com/marius-patrik/example/actions/runs/1"
            }
          ]
        };
      }
      if (method === "GET" && path === "/repos/marius-patrik/example/contents/PRD.md?ref=main") {
        return encodedContent("# PRD\n\n## Core loops\n\n- **L0 Orchestrator**: Run.");
      }
      if (method === "GET" && path === "/repos/marius-patrik/example/git/ref/heads/dev") {
        throw notFound;
      }
      if (method === "GET" && path === "/repos/marius-patrik/example/branches/main/protection") {
        throw notFound;
      }
      if (method === "POST" && path === "/repos/marius-patrik/example/labels") {
        return {};
      }
      if (method === "PATCH" && path.startsWith("/repos/marius-patrik/example/labels/")) {
        return {};
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
    concurrency: { global: 1, perRepo: 1, perStream: 1 },
    writeLedger: false,
    updateDashboard: false,
    warn: () => {},
    log: () => {}
  });

  assert.deepEqual(result.dispatched, [{ repo: "marius-patrik/example", issue: 42, lane: "marius-patrik/example:default" }]);
  assert.equal(result.ledger.token_usage.codex_calls, 0);
  assert.equal(result.ledger.state.ready, 1);
  assert.ok(calls.some((call) => call.method === "POST" && call.path === "/repos/marius-patrik/example/issues/42/labels"));
  assert.ok(calls.some((call) => call.method === "DELETE" && call.path === "/repos/marius-patrik/example/issues/42/labels/df%3Aready"));
  assert.deepEqual(
    calls.find((call) => call.method === "POST" && call.path.endsWith("/actions/workflows/df-work.yml/dispatches"))?.body,
    { ref: "main", inputs: { repo: "marius-patrik/example", issue_number: "42" } }
  );
});

test("orchestrator readies managed issues once Blocked-by dependencies are closed", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { reconcileRepositoryReadiness } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-ready-test");
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const issue = {
    number: 11,
    title: "Next sequenced task",
    body: "## Sequencing\n\nBlocked-by: #10",
    labels: new Set(["P1", "roadmap"]),
    blockedBy: [10],
    priority: "P1",
    stream: "",
    prdMarker: "df-prd:core-loops-l1"
  };
  const gh = {
    async request(method: string, path: string, body?: unknown) {
      calls.push({ method, path, body });
      if (method === "POST" && path === "/repos/marius-patrik/example/labels") return {};
      if (method === "PATCH" && path.startsWith("/repos/marius-patrik/example/labels/")) return {};
      if (method === "POST" && path === "/repos/marius-patrik/example/issues/11/labels") return {};
      throw new Error(`Unexpected GitHub request: ${method} ${path}`);
    }
  };

  const actions = await reconcileRepositoryReadiness(gh, {
    repository: { owner: "marius-patrik", repo: "example" },
    issues: [issue]
  });

  assert.deepEqual(actions, [{ repo: "marius-patrik/example", issue: 11, action: "ready-issue", reason: "blockers-clear" }]);
  assert.equal(issue.labels.has("df:ready"), true);
  assert.ok(calls.some((call) => call.path === "/repos/marius-patrik/example/issues/11/labels" && call.body.labels.includes("df:ready")));
});

test("dispatch candidate selection skips blocked issues and sorts by priority", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { selectDispatchCandidates } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-candidates-test");
  const repository = { owner: "marius-patrik", repo: "example" };
  const issue = (number: number, labels: string[], blockedBy: number[] = []) => ({
    number,
    title: `Issue ${number}`,
    body: "",
    labels: new Set(labels),
    blockedBy,
    priority: labels.find((label) => /^P[0-2]$/.test(label)) || "P2",
    stream: "",
    prdMarker: "df-prd:item"
  });

  const candidates = selectDispatchCandidates([
    {
      repository,
      issues: [
        issue(3, ["P2", "roadmap", "df:ready"]),
        issue(2, ["P0", "roadmap", "df:ready"]),
        issue(4, ["P1", "roadmap", "df:ready"], [1]),
        issue(1, ["P1", "roadmap"])
      ]
    }
  ]);

  assert.deepEqual(candidates.map((candidate: { issue: { number: number } }) => candidate.issue.number), [2, 3]);
});

test("orchestrator escalates owner-only blockers to df:ask-owner", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { escalateOwnerOnlyBlockers } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-escalate-test");
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const issue = {
    number: 5,
    title: "Repository setting needed",
    body: "Blocked until an owner can enable repository auto-merge.",
    labels: new Set(["df:blocked", "roadmap"]),
    blockedBy: [],
    priority: "P1",
    stream: "",
    prdMarker: "df-prd:item"
  };
  const gh = {
    async request(method: string, path: string, body?: unknown) {
      calls.push({ method, path, body });
      if (method === "POST" && path === "/repos/marius-patrik/example/labels") return {};
      if (method === "PATCH" && path.startsWith("/repos/marius-patrik/example/labels/")) return {};
      if (method === "GET" && path === "/repos/marius-patrik/example/issues/5/comments?per_page=100&page=1") return [];
      if (method === "POST" && path === "/repos/marius-patrik/example/issues/5/labels") return {};
      if (method === "DELETE" && path.startsWith("/repos/marius-patrik/example/issues/5/labels/")) return {};
      if (method === "POST" && path === "/repos/marius-patrik/example/issues/5/comments") return {};
      throw new Error(`Unexpected GitHub request: ${method} ${path}`);
    }
  };

  const actions = await escalateOwnerOnlyBlockers(gh, {
    repository: { owner: "marius-patrik", repo: "example" },
    issues: [issue]
  });

  assert.deepEqual(actions, [{ repo: "marius-patrik/example", issue: 5, action: "escalate-owner", reason: "owner-only-blocker" }]);
  assert.equal(issue.labels.has("df:ask-owner"), true);
  assert.equal(issue.labels.has("df:blocked"), false);
  assert.ok(calls.some((call) => call.path === "/repos/marius-patrik/example/issues/5/comments" && String(call.body.body).includes("dark-factory:l0-owner-escalation")));
});

test("dashboard digest renders global state, dispatches, owner questions, and token use", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { formatDashboardBody } = await import("../.github/scripts/df-orchestrate.mjs?unit=df-orchestrate-dashboard-test");
  const body = formatDashboardBody(
    {
      control_repo: "marius-patrik/agent-darkfactory",
      generated_at: "2026-07-05T00:00:00.000Z",
      repositories: [
        {
          repository: { owner: "marius-patrik", repo: "example" },
          prd: { present: true },
          ci: { available: true, latest: { status: "completed", conclusion: "success" } },
          pulls: [{ number: 7 }],
          issues: [
            { number: 5, title: "Need owner approval", labels: new Set(["df:ask-owner"]) },
            { number: 6, title: "Ready", labels: new Set(["df:ready"]) }
          ]
        }
      ]
    },
    {
      trigger: "schedule",
      concurrency: { global: 4, perRepo: 1, perStream: 1 },
      dispatched: [{ repo: "marius-patrik/example", issue: 6, lane: "marius-patrik/example:default" }]
    }
  );

  assert.match(body, /dark-factory:l0-dashboard/);
  assert.match(body, /marius-patrik\/example/);
  assert.match(body, /marius-patrik\/example#6/);
  assert.match(body, /Need owner approval/);
  assert.match(body, /AI tokens: 0/);
  assert.match(body, /agents-harness scheduler/);
});
