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
  handleClosedIncompletePrdIssue,
  listPrdPaths,
  normalizePlannerBotActor,
  assertOwnedPlannerIssue,
  indexOwnedPrdIssues,
  findOpenPrdScaffoldPullRequest,
  createPrdScaffoldPullRequest,
  assertTrustedPrdScaffoldPullRequest,
  armPrdScaffoldAutoMerge,
  scaffoldContentDigest
} = dfPlan;

const repository = { owner: "marius-patrik", repo: "example" };
const controlRepo = { owner: "marius-patrik", repo: "DarkFactory" };
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
const labels = [item.priority, "roadmap", `df:class:${item.taskClass}`];

test("planner discovers product PRDs but excludes template, example, fixture, test, archive, and hidden trees", async () => {
  const paths = await listPrdPaths(repository, "main", {
    tree: [
      { type: "blob", path: "PRD.md" },
      { type: "blob", path: "packages/core/PRD.md" },
      { type: "blob", path: "templates/cli/PRD.md" },
      { type: "blob", path: "examples/demo/PRD.md" },
      { type: "blob", path: "fixtures/repo/PRD.md" },
      { type: "blob", path: "tests/fake/PRD.md" },
      { type: "blob", path: "archive/old/PRD.md" },
      { type: "blob", path: ".agents/.project/PRD.md" }
    ]
  });
  assert.deepEqual(paths, ["PRD.md", "packages/core/PRD.md"]);
});

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
  assert.ok(PLANNER_BOT_LOGINS.has("darkfactory-agent[bot]"));
  assert.ok(PLANNER_BOT_LOGINS.has("github-actions[bot]"));
  assert.ok(PLANNER_BOT_LOGINS.has("mp-agents[bot]"));
});

test("planner actor normalization admits the current App and exact proven legacy surfaces", () => {
  assert.equal(normalizePlannerBotActor({ login: "darkfactory-agent[bot]", type: "Bot" }), "current-app");
  assert.equal(normalizePlannerBotActor({ login: "github-actions[bot]", type: "Bot" }), "repository-actions");
  assert.equal(normalizePlannerBotActor({ login: "mp-agents[bot]", type: "Bot" }), "legacy-app");
});

test("isPlannerBotClosure identifies current and legacy DarkFactory bot closures", () => {
  assert.equal(isPlannerBotClosure({ closed_by: { login: "darkfactory-agent[bot]", type: "Bot" } }), true);
  assert.equal(isPlannerBotClosure({ closed_by: { login: "mp-agents[bot]", type: "Bot" } }), true);
  assert.equal(isPlannerBotClosure({ closed_by: { login: "github-actions[bot]", type: "Bot" } }), true);
});

test("isPlannerBotClosure treats human and unknown closures as non-bot", () => {
  assert.equal(isPlannerBotClosure({ closed_by: { login: "marius-patrik", type: "User" } }), false);
  assert.equal(isPlannerBotClosure({ closed_by: { login: "dependabot[bot]", type: "Bot" } }), false);
  assert.equal(isPlannerBotClosure({ state: "closed" }), false);
  assert.equal(isPlannerBotClosure({ closed_by: null }), false);
  assert.equal(isPlannerBotClosure({ closed_by: { login: "darkfactory-agent", type: "Bot" } }), false);
  assert.equal(isPlannerBotClosure({ closed_by: { login: "darkfactory-agent[bot]", type: "User" } }), false);
});

test("PRD issue ownership accepts one exact planner Bot and rejects spoofed or near-miss actors", () => {
  const body = `<!-- ${item.marker} -->`;
  const trusted = { number: 1, body, user: { login: "darkfactory-agent[bot]", type: "Bot" } };
  assert.equal(indexOwnedPrdIssues([trusted]).get(item.marker), trusted);
  for (const user of [
    { login: "marius-patrik", type: "User" },
    { login: "darkfactory-agent", type: "Bot" },
    { login: "darkfactory-agent[bot]", type: "User" },
    { login: "darkfactory-agent[bot]", type: "Bot", __typename: "Bot" }
  ]) {
    assert.throws(() => indexOwnedPrdIssues([{ ...trusted, user }]), /not owned by one exact trusted planner Bot/);
  }
  assert.throws(() => assertOwnedPlannerIssue({ ...trusted, body: item.marker }, item.marker), /not owned/);
});

test("PRD issue ownership fails closed on duplicate marker owners before mutation", () => {
  const make = (number: number) => ({ number, body: `<!-- ${item.marker} -->`, user: { login: "darkfactory-agent[bot]", type: "Bot" } });
  assert.throws(() => indexOwnedPrdIssues([make(1), make(2)]), /Multiple issues claim PRD marker/);
  assert.throws(
    () => indexOwnedPrdIssues([{ ...make(1), body: `<!-- ${item.marker} -->\n<!-- df-prd:second-owner -->` }]),
    /does not carry one exact marker comment/
  );
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
    "GET /repos/marius-patrik/DarkFactory/issues?state=all&per_page=100&page=1": [],
    "POST /repos/marius-patrik/DarkFactory/labels": {},
    "POST /repos/marius-patrik/example/issues/7/comments": { id: 100 },
    "POST /repos/marius-patrik/DarkFactory/issues": {
      number: 99,
      html_url: "https://github.com/marius-patrik/DarkFactory/issues/99"
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
    (call) => call.method === "POST" && call.path === "/repos/marius-patrik/DarkFactory/issues"
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
    html_url: "https://github.com/marius-patrik/DarkFactory/issues/99",
    body: `<!-- ${marker} -->`,
    state: "closed",
    labels: [],
    user: { login: "darkfactory-agent[bot]", type: "Bot" }
  };
  const { gh, calls } = mockGh({
    "GET /repos/marius-patrik/DarkFactory/issues?state=all&per_page=100&page=1": [existing],
    "GET /repos/marius-patrik/DarkFactory/issues/99": existing,
    "POST /repos/marius-patrik/DarkFactory/labels": {},
    "PATCH /repos/marius-patrik/DarkFactory/issues/99": {
      number: 99,
      html_url: "https://github.com/marius-patrik/DarkFactory/issues/99"
    },
    "POST /repos/marius-patrik/DarkFactory/issues/99/labels": {}
  });

  const result = await escalateHumanClosedPrdIssue(gh, controlRepo, repository, item, issue);

  assert.equal(result.ask_owner_issue.number, 99);
  assert.equal(result.comment, undefined);
  assert.equal(
    calls.some((call) => call.path === "/repos/marius-patrik/example/issues/7/comments"),
    false
  );

  const patch = calls.find(
    (call) => call.method === "PATCH" && call.path === "/repos/marius-patrik/DarkFactory/issues/99"
  );
  assert.ok(patch);
  assert.equal(patch.body.state, "open");
});

test("handleClosedIncompletePrdIssue escalates human-closed issue without reopening", async () => {
  const issue = {
    number: 7,
    state: "closed",
    html_url: "https://github.com/marius-patrik/example/issues/7",
    closed_by: { login: "marius-patrik", type: "User" },
    body: `<!-- ${item.marker} -->`,
    user: { login: "darkfactory-agent[bot]", type: "Bot" }
  };
  const { gh, calls } = mockGh({
    "GET /repos/marius-patrik/example/issues?state=all&per_page=100&page=1": [issue],
    "GET /repos/marius-patrik/example/issues/7": issue,
    "GET /repos/marius-patrik/DarkFactory/issues?state=all&per_page=100&page=1": [],
    "POST /repos/marius-patrik/DarkFactory/labels": {},
    "POST /repos/marius-patrik/example/issues/7/comments": { id: 100 },
    "POST /repos/marius-patrik/DarkFactory/issues": {
      number: 99,
      html_url: "https://github.com/marius-patrik/DarkFactory/issues/99"
    }
  });

  const result = await handleClosedIncompletePrdIssue(gh, repository, controlRepo, item, issue, labels, []);

  assert.equal(result.action.action, "escalate-human-closed-prd-issue");
  assert.equal(result.previousIssueNumber, 7);
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
    closed_by: { login: "darkfactory-agent[bot]", type: "Bot" },
    body: `<!-- ${item.marker} -->`,
    user: { login: "darkfactory-agent[bot]", type: "Bot" }
  };
  const { gh, calls } = mockGh({
    "GET /repos/marius-patrik/example/issues?state=all&per_page=100&page=1": [issue],
    "PATCH /repos/marius-patrik/example/issues/7": { number: 7, html_url: "https://github.com/marius-patrik/example/issues/7", state: "open" },
    "GET /repos/marius-patrik/example/issues/7": { ...issue, labels: [{ name: "df:ready" }, { name: "df:reviewed" }] },
    "POST /repos/marius-patrik/example/issues/7/labels": {},
    "DELETE /repos/marius-patrik/example/issues/7/labels/df%3Aready": {},
    "DELETE /repos/marius-patrik/example/issues/7/labels/df%3Areviewed": {},
    "POST /repos/marius-patrik/example/labels": {}
  });

  const result = await handleClosedIncompletePrdIssue(gh, repository, controlRepo, item, issue, labels, []);

  assert.equal(result.action.action, "reopen-prd-issue");
  assert.equal(result.previousIssueNumber, 7);
  assert.equal(result.action.dispatch, undefined);

  const patch = calls.find(
    (call) => call.method === "PATCH" && call.path === "/repos/marius-patrik/example/issues/7"
  );
  assert.ok(patch);
  assert.equal(patch.body.state, "open");
  assert.ok(calls.some((call) => call.path.endsWith("/labels/df%3Aready")));
  assert.ok(calls.some((call) => call.path.endsWith("/labels/df%3Areviewed")));
});

const SCAFFOLD_SOURCE = "a".repeat(40);
const SCAFFOLD_HEAD = "b".repeat(40);
const scaffoldFiles = [{ path: "PRD.md", content: "# Product requirements\n" }];

function scaffoldPull(overrides: Record<string, unknown> = {}) {
  const contentDigest = scaffoldContentDigest(scaffoldFiles);
  return {
    number: 17,
    node_id: "PR_node",
    state: "open",
    html_url: "https://github.com/marius-patrik/example/pull/17",
    user: { login: "darkfactory-agent[bot]", type: "Bot" },
    base: { ref: "dev", sha: SCAFFOLD_SOURCE },
    head: { ref: "dark-factory/prd-scaffold-1", sha: SCAFFOLD_HEAD, repo: { full_name: "marius-patrik/example" } },
    body: `<!-- dark-factory:prd-scaffold schema=1 repo=marius-patrik/example base=dev source=${SCAFFOLD_SOURCE} head=${SCAFFOLD_HEAD} content=${contentDigest} -->`,
    auto_merge: null,
    ...overrides
  };
}

function scaffoldRuntime(initialPull = scaffoldPull(), protectionAppId = 15368) {
  let pull = initialPull;
  let graphqlCalls = 0;
  const calls: string[] = [];
  const github = {
    async request(method: string, requestPath: string) {
      calls.push(`${method} ${requestPath}`);
      if (requestPath === "/repos/marius-patrik/example/pulls?state=open&per_page=100&page=1") return [pull];
      if (requestPath === "/repos/marius-patrik/example/pulls/17") return pull;
      if (requestPath === "/repos/marius-patrik/example/git/ref/heads/dev") return { object: { sha: SCAFFOLD_SOURCE } };
      if (requestPath === "/repos/marius-patrik/example/git/ref/heads/dark-factory%2Fprd-scaffold-1") return { object: { sha: SCAFFOLD_HEAD } };
      if (requestPath === `/repos/marius-patrik/example/git/commits/${SCAFFOLD_HEAD}`) return { sha: SCAFFOLD_HEAD, parents: [{ sha: SCAFFOLD_SOURCE }] };
      if (requestPath === "/repos/marius-patrik/example/pulls/17/files?per_page=100&page=1") return [{ filename: "PRD.md" }];
      if (requestPath === `/repos/marius-patrik/example/contents/PRD.md?ref=${SCAFFOLD_HEAD}`) return { type: "file", encoding: "base64", content: Buffer.from(scaffoldFiles[0].content).toString("base64") };
      if (requestPath === "/repos/marius-patrik/example/branches/dev/protection") return {
        required_status_checks: { strict: true, checks: [
          { context: "Validate", app_id: protectionAppId },
          { context: "DarkFactory Autoreview", app_id: protectionAppId }
        ] },
        enforce_admins: { enabled: true },
        allow_force_pushes: { enabled: false },
        allow_deletions: { enabled: false }
      };
      throw new Error(`Unexpected scaffold request: ${method} ${requestPath}`);
    },
    async graphql() {
      graphqlCalls += 1;
      pull = { ...pull, auto_merge: { enabled_at: "2026-07-16T00:00:00Z" } };
      return { enablePullRequestAutoMerge: { pullRequest: { number: 17, autoMergeRequest: { enabledAt: "2026-07-16T00:00:00Z" } } } };
    }
  };
  return { github, calls, get graphqlCalls() { return graphqlCalls; } };
}

test("PRD scaffold ownership binds exact App, dev base, same-repo head, and generated content", async () => {
  const runtime = scaffoldRuntime();
  await assert.doesNotReject(() => assertTrustedPrdScaffoldPullRequest(runtime.github, repository, scaffoldPull(), { baseRef: "dev", sourceSha: SCAFFOLD_SOURCE, files: scaffoldFiles }));
  await assert.rejects(
    () => assertTrustedPrdScaffoldPullRequest(runtime.github, repository, scaffoldPull({ user: { login: "marius-patrik", type: "User" } }), { baseRef: "dev", sourceSha: SCAFFOLD_SOURCE, files: scaffoldFiles }),
    /exact current DarkFactory App actor/
  );
  await assert.rejects(
    () => assertTrustedPrdScaffoldPullRequest(runtime.github, repository, scaffoldPull({ base: { ref: "main", sha: SCAFFOLD_SOURCE } }), { baseRef: "dev", sourceSha: SCAFFOLD_SOURCE, files: scaffoldFiles }),
    /same-repository dev\/base\/head/
  );
});

test("PRD scaffold marker collisions fail closed before an existing PR is selected", async () => {
  const duplicate = scaffoldPull({ number: 18 });
  const github = { async request(method: string, requestPath: string) {
    if (requestPath.endsWith("pulls?state=open&per_page=100&page=1")) return [scaffoldPull(), duplicate];
    throw new Error(`unexpected mutation or detail request ${method} ${requestPath}`);
  } };
  await assert.rejects(
    () => findOpenPrdScaffoldPullRequest(github, repository, { baseRef: "dev", sourceSha: SCAFFOLD_SOURCE, files: scaffoldFiles }),
    /Multiple pull requests claim/
  );
});

test("PRD scaffold creation refuses default/main and accepts only the admitted dev base", async () => {
  let calls = 0;
  const github = { async request() { calls += 1; throw new Error("must not call GitHub"); } };
  await assert.rejects(
    () => createPrdScaffoldPullRequest(github, repository, "main", SCAFFOLD_SOURCE, scaffoldFiles),
    /restricted to the admitted dev source and base/
  );
  assert.equal(calls, 0);
});

test("PRD scaffold arming is App-gated and resumes as a no-op once already armed", async () => {
  const runtime = scaffoldRuntime();
  const expected = { baseRef: "dev", sourceSha: SCAFFOLD_SOURCE, files: scaffoldFiles };
  assert.equal((await armPrdScaffoldAutoMerge(runtime.github, repository, scaffoldPull(), expected)).status, "automerge-armed");
  assert.equal(runtime.graphqlCalls, 1);
  assert.equal((await armPrdScaffoldAutoMerge(runtime.github, repository, scaffoldPull({ auto_merge: { enabled_at: "2026-07-16T00:00:00Z" } }), expected)).status, "automerge-armed");
  assert.equal(runtime.graphqlCalls, 1);

  const wrongApp = scaffoldRuntime(scaffoldPull(), 7);
  await assert.rejects(() => armPrdScaffoldAutoMerge(wrongApp.github, repository, scaffoldPull(), expected), /lacks exact App-bound/);
  assert.equal(wrongApp.graphqlCalls, 0);
});
