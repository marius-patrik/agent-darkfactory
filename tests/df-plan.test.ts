// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";

// @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
const dfPlan: any = await import("../.github/scripts/df-plan.mjs?unit=df-plan-test");

const {
  PLANNER_BOT_LOGINS,
  isPlannerBotClosure,
  humanClosedPrdComment,
  askOwnerIssueMarker,
  askOwnerIssueTitle,
  askOwnerIssueBody,
  escalateHumanClosedPrdIssue,
  handleClosedIncompletePrdIssue
} = dfPlan;

const repository = { owner: "marius-patrik", repo: "example" };
const controlRepo = { owner: "marius-patrik", repo: "agent-darkfactory" };
const item = {
  marker: "df-prd:core-loops-l3-work",
  slug: "core-loops-l3-work",
  sourcePath: "PRD.md",
  section: "Core loops",
  name: "L3 Work",
  title: "PRD - L3 Work",
  description: "Ready issues become branches, PRs, and merged code.",
  acceptance: "One issue goes label-to-merged with zero terminal use.",
  completed: false,
  priority: "P1",
  taskClass: "standard"
};
const labels = [item.priority, "roadmap", `df:class:${item.taskClass}`, "df:ready"];

function mockGh(routes: Record<string, unknown | (() => unknown)>) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const gh = {
    async request(method: string, path: string, body?: unknown) {
      calls.push({ method, path, body });
      const key = `${method} ${path}`;
      if (key in routes) {
        const value = routes[key];
        return typeof value === "function" ? value() : value;
      }
      throw new Error(`Unexpected mock request: ${key}`);
    }
  };
  return { gh, calls };
}

test("PLANNER_BOT_LOGINS covers the expected DarkFactory planning actors", () => {
  assert.ok(PLANNER_BOT_LOGINS.has("github-actions[bot]"));
  assert.ok(PLANNER_BOT_LOGINS.has("mp-agents[bot]"));
});

test("isPlannerBotClosure identifies bot closures from DarkFactory actors", () => {
  assert.equal(isPlannerBotClosure({ closed_by: { login: "mp-agents[bot]", type: "Bot" } }), true);
  assert.equal(isPlannerBotClosure({ closed_by: { login: "github-actions[bot]", type: "Bot" } }), true);
});

test("isPlannerBotClosure treats human and unknown closures as non-bot", () => {
  assert.equal(isPlannerBotClosure({ closed_by: { login: "marius-patrik", type: "User" } }), false);
  assert.equal(isPlannerBotClosure({ closed_by: { login: "dependabot[bot]", type: "Bot" } }), false);
  assert.equal(isPlannerBotClosure({ state: "closed" }), false);
  assert.equal(isPlannerBotClosure({ closed_by: null }), false);
});

test("humanClosedPrdComment explains the PRD disagreement and escalation", () => {
  const comment = humanClosedPrdComment(item);
  assert.match(comment, /PRD item is still marked as incomplete/);
  assert.match(comment, /PRD source: PRD\.md > Core loops > L3 Work/);
  assert.match(comment, /edit the PRD to mark the item `?\[x\]`?/);
  assert.match(comment, /escalated to a `df:ask-owner` planning issue/);
});

test("ask owner issue helpers produce a marker-idempotent issue", () => {
  const marker = askOwnerIssueMarker(repository, item);
  assert.match(marker, /df-ask-owner:human-closed-prd:/);
  const title = askOwnerIssueTitle(repository, item);
  assert.match(title, /Human-closed PRD item - marius-patrik\/example > L3 Work/);
  const body = askOwnerIssueBody(repository, item, { number: 7, html_url: "https://github.com/marius-patrik/example/issues/7" });
  assert.match(body, new RegExp(`<!-- ${marker} -->`));
  assert.match(body, /Closed issue: https:\/\/github\.com\/marius-patrik\/example\/issues\/7/);
  assert.match(body, /Mark the PRD item as completed by editing it to `?\[x\]`?/);
  assert.match(body, /Reopen the issue so the loop continues to track it/);
});

test("escalateHumanClosedPrdIssue creates ask-owner issue and comments once", async () => {
  const issue = {
    number: 7,
    html_url: "https://github.com/marius-patrik/example/issues/7",
    closed_by: { login: "marius-patrik", type: "User" }
  };
  const { gh, calls } = mockGh({
    "GET /repos/marius-patrik/agent-darkfactory/issues?state=all&per_page=100&page=1": [],
    "POST /repos/marius-patrik/agent-darkfactory/labels": {},
    "POST /repos/marius-patrik/example/issues/7/comments": { id: 100 },
    "POST /repos/marius-patrik/agent-darkfactory/issues": {
      number: 99,
      html_url: "https://github.com/marius-patrik/agent-darkfactory/issues/99"
    }
  });

  const result = await escalateHumanClosedPrdIssue(gh, controlRepo, repository, item, issue);

  assert.equal(result.action, "escalate-human-closed-prd-issue");
  assert.equal(result.issue.number, 7);
  assert.equal(result.ask_owner_issue.number, 99);
  assert.equal(result.comment, true);

  const commentCall = calls.find(
    (call) => call.method === "POST" && call.path === "/repos/marius-patrik/example/issues/7/comments"
  );
  assert.ok(commentCall);
  assert.match(commentCall.body.body, /PRD item is still marked as incomplete/);

  const createCall = calls.find(
    (call) => call.method === "POST" && call.path === "/repos/marius-patrik/agent-darkfactory/issues"
  );
  assert.ok(createCall);
  assert.deepEqual(createCall.body.labels, ["P1", "df:ask-owner", "df:class:standard"]);
  assert.match(createCall.body.body, new RegExp(askOwnerIssueMarker(repository, item)));
});

test("escalateHumanClosedPrdIssue updates existing ask-owner issue and does not duplicate comment", async () => {
  const issue = {
    number: 7,
    html_url: "https://github.com/marius-patrik/example/issues/7",
    closed_by: { login: "marius-patrik", type: "User" }
  };
  const marker = askOwnerIssueMarker(repository, item);
  const existing = {
    number: 99,
    html_url: "https://github.com/marius-patrik/agent-darkfactory/issues/99",
    body: `<!-- ${marker} -->`,
    state: "closed",
    labels: []
  };
  const { gh, calls } = mockGh({
    "GET /repos/marius-patrik/agent-darkfactory/issues?state=all&per_page=100&page=1": [existing],
    "GET /repos/marius-patrik/agent-darkfactory/issues/99": { number: 99, labels: [] },
    "POST /repos/marius-patrik/agent-darkfactory/labels": {},
    "PATCH /repos/marius-patrik/agent-darkfactory/issues/99": {
      number: 99,
      html_url: "https://github.com/marius-patrik/agent-darkfactory/issues/99"
    },
    "POST /repos/marius-patrik/agent-darkfactory/issues/99/labels": {}
  });

  const result = await escalateHumanClosedPrdIssue(gh, controlRepo, repository, item, issue);

  assert.equal(result.ask_owner_issue.number, 99);
  assert.equal(result.comment, undefined);
  assert.equal(
    calls.some((call) => call.path === "/repos/marius-patrik/example/issues/7/comments"),
    false
  );

  const patch = calls.find(
    (call) => call.method === "PATCH" && call.path === "/repos/marius-patrik/agent-darkfactory/issues/99"
  );
  assert.ok(patch);
  assert.equal(patch.body.state, "open");
});

test("handleClosedIncompletePrdIssue escalates human-closed issue without reopening", async () => {
  const issue = {
    number: 7,
    state: "closed",
    html_url: "https://github.com/marius-patrik/example/issues/7",
    closed_by: { login: "marius-patrik", type: "User" }
  };
  const { gh, calls } = mockGh({
    "GET /repos/marius-patrik/agent-darkfactory/issues?state=all&per_page=100&page=1": [],
    "POST /repos/marius-patrik/agent-darkfactory/labels": {},
    "POST /repos/marius-patrik/example/issues/7/comments": { id: 100 },
    "POST /repos/marius-patrik/agent-darkfactory/issues": {
      number: 99,
      html_url: "https://github.com/marius-patrik/agent-darkfactory/issues/99"
    }
  });

  const result = await handleClosedIncompletePrdIssue(gh, repository, controlRepo, item, issue, labels, []);

  assert.equal(result.action.action, "escalate-human-closed-prd-issue");
  assert.equal(result.previousIssueNumber, 7);
  assert.equal(result.previousOpenIssueNumber, null);
  assert.equal(
    calls.some((call) => call.method === "PATCH" && call.path === "/repos/marius-patrik/example/issues/7"),
    false
  );
});

test("handleClosedIncompletePrdIssue reopens bot-closed issue as today", async () => {
  const issue = {
    number: 7,
    state: "closed",
    html_url: "https://github.com/marius-patrik/example/issues/7",
    closed_by: { login: "mp-agents[bot]", type: "Bot" }
  };
  const { gh, calls } = mockGh({
    "PATCH /repos/marius-patrik/example/issues/7": { number: 7, html_url: "https://github.com/marius-patrik/example/issues/7", state: "open" },
    "GET /repos/marius-patrik/example/issues/7": { number: 7, labels: [] },
    "POST /repos/marius-patrik/example/issues/7/labels": {},
    "POST /repos/marius-patrik/example/labels": {}
  });

  const result = await handleClosedIncompletePrdIssue(gh, repository, controlRepo, item, issue, labels, []);

  assert.equal(result.action.action, "reopen-prd-issue");
  assert.equal(result.previousIssueNumber, 7);
  assert.equal(result.previousOpenIssueNumber, 7);
  assert.equal(result.action.dispatch.action, "queue-worker");

  const patch = calls.find(
    (call) => call.method === "PATCH" && call.path === "/repos/marius-patrik/example/issues/7"
  );
  assert.ok(patch);
  assert.equal(patch.body.state, "open");
});
