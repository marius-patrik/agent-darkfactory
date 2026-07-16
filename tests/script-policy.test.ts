import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
const dfLib: any = await import("../.github/scripts/df-lib.mjs");
// @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
const dfFix: any = await import("../.github/scripts/df-fix.mjs");
// @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
const dfSweep: any = await import("../.github/scripts/df-sweep.mjs");
// @ts-ignore js-yaml does not ship types in this package; tests only need load().
const { load: loadYaml }: any = await import("js-yaml");

const {
  assertAllowedRepo,
  auditIssueBody,
  checksAreGreen,
  classifyWorkerBranchRefs,
  cleanupTempRoot,
  AUTOREVIEW_REQUIRED_CONTEXT,
  extractClosingIssueNumbers,
  extractReadmeFirstParagraph,
  findAuditMarker,
  getBranchProtection,
  getRequiredStatusCheckContexts,
  darkFactoryWorkerIssueNumber,
  isIgnorableCleanupError,
  isDarkFactoryWorkerPullRequest,
  isParkedRepo,
  isVerifiedWorkerIssue,
  listActiveManagedRepos,
  listInstallationRepositories,
  listPackagePaths,
  normalizeWorkerPullRequestActor,
  parsePrdItems,
  parseWorkerClaim,
  plannedIssueLabelDiff,
  preflightMergePolicy,
  prdIssueBody,
  prdScaffoldPullRequestBody,
  readManagedRepoRegistry,
  readLatestRunLedger,
  reconcileLabelDiff,
  repoName,
  scaffoldPackagePrd,
  taskClassFromLabels,
  withAutoreviewRequiredContext
} = dfLib;

const {
  classifyFixCandidate,
  fixTrustFailure,
  fixPullRequestByRedispatch,
  parseFixRound
} = dfFix;
const {
  closeIssuesIfDevMerge,
  closeVerifiedDevMergeIssues,
  configureSweepRuntime,
  considerPullRequest: considerSweepPullRequest,
  verifyDevMergeRequest
} = dfSweep;

function managedProtection(overrides: Record<string, unknown> = {}) {
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
    allow_deletions: { enabled: false },
    ...overrides
  };
}

test("worker branch recovery classifies zero, one, and multiple exact candidates deterministically", () => {
  assert.deepEqual(classifyWorkerBranchRefs([], 9), { type: "none" });
  assert.deepEqual(
    classifyWorkerBranchRefs([{ ref: "refs/heads/df/9-only", object: { sha: "a".repeat(40) } }], 9),
    { type: "branch", branch: "df/9-only", head: "a".repeat(40) }
  );
  const ambiguous = classifyWorkerBranchRefs([
    { ref: "refs/heads/df/9-one", object: { sha: "1".repeat(40) } },
    { ref: "refs/heads/df/9-two", object: { sha: "2".repeat(40) } }
  ], 9);
  assert.equal(ambiguous.type, "ambiguous");
  assert.equal(ambiguous.candidates.length, 2);
});

test("parsePrdItems creates stable df-prd markers from PRD milestones and loops", () => {
  const items = parsePrdItems([
    "## Core loops",
    "",
    "- **L4 Planning**: PRD reconciliation. Acceptance: editing PRD.md files issues automatically.",
    "",
    "## Milestones",
    "",
    "- **M2 — Planning loop / PRD enforcement**: PRD -> backlog. Acceptance: drift report issue when code contradicts PRD."
  ].join("\n"));

  assert.deepEqual(items.map((item: { marker: string }) => item.marker), [
    "df-prd:core-loops-l4",
    "df-prd:milestones-m2"
  ]);
  assert.equal(items[0].priority, "P1");
  assert.equal(items[1].acceptance, "drift report issue when code contradicts PRD.");
});

test("parsePrdItems includes nested PRD paths in stable markers", () => {
  const [rootItem] = parsePrdItems("## Milestones\n\n- **M2 — Planning**: Reconcile.");
  const [packageItem] = parsePrdItems("## Milestones\n\n- **M2 — Planning**: Reconcile.", "packages/example/PRD.md");

  assert.equal(rootItem.marker, "df-prd:milestones-m2");
  assert.equal(packageItem.marker, "df-prd:packages-example-prd-md-milestones-m2");
  assert.equal(packageItem.sourcePath, "packages/example/PRD.md");
});

test("parsePrdItems treats checked PRD checkboxes as a completion signal", () => {
  const [openItem] = parsePrdItems("## Milestones\n\n- **M2 — Planning**: Reconcile.");
  const [doneItem] = parsePrdItems("## Milestones\n\n- [x] **M2 — Planning**: Reconcile.");

  assert.equal(openItem.completed, false);
  assert.equal(doneItem.completed, true);
  assert.equal(doneItem.marker, openItem.marker);
});

test("listPackagePaths excludes dependencies and non-product template/example/test trees", () => {
  const paths = listPackagePaths([
    { type: "blob", path: "package.json" },
    { type: "blob", path: "packages/core/package.json" },
    { type: "blob", path: "packages/ui/package.json" },
    { type: "blob", path: "node_modules/lib/package.json" },
    { type: "blob", path: "templates/sample/package.json" },
    { type: "blob", path: "examples/demo/package.json" },
    { type: "blob", path: "fixtures/repo/package.json" },
    { type: "blob", path: "tests/fake/package.json" },
    { type: "blob", path: "archive/old/package.json" },
    { type: "blob", path: "packages/core/index.ts" }
  ]);

  assert.deepEqual(paths, ["packages/core", "packages/ui"]);
});

test("scaffoldPackagePrd generates a minimal PRD with vision and product name", () => {
  const prd = scaffoldPackagePrd("marius-patrik/example", {
    vision: "Example product vision.",
    packageName: "core",
    isRoot: false
  });

  assert.match(prd, /# core PRD/);
  assert.match(prd, /Example product vision\./);
  assert.match(prd, /## Core loops/);
  assert.match(prd, /## Milestones/);
});

test("extractReadmeFirstParagraph skips headings and returns first text paragraph", () => {
  const readme = "# Example\n\nFirst paragraph.\nMore first.\n\nSecond paragraph.";
  assert.equal(extractReadmeFirstParagraph(readme), "First paragraph. More first.");
  assert.equal(extractReadmeFirstParagraph(""), "");
  assert.equal(extractReadmeFirstParagraph(null), "");
});

test("prdScaffoldPullRequestBody includes the scaffold marker and file list", () => {
  const body = prdScaffoldPullRequestBody("marius-patrik/example", ["PRD.md", "packages/core/PRD.md"]);

  assert.match(body, /<!-- dark-factory:prd-scaffold -->/);
  assert.match(body, /- `PRD.md`/);
  assert.match(body, /- `packages\/core\/PRD.md`/);
});

test("task class labels classify work without selecting model settings", () => {
  assert.deepEqual(taskClassFromLabels([{ name: "df:class:mechanical" }]), {
    taskClass: "mechanical"
  });
  assert.deepEqual(taskClassFromLabels([{ name: "df:class:hard" }]), {
    taskClass: "hard"
  });
  assert.deepEqual(taskClassFromLabels([]), {
    taskClass: "standard"
  });
});

test("prdIssueBody records deterministic Blocked-by sequencing", () => {
  const [item] = parsePrdItems("## Milestones\n\n- **M2 — Planning**: Reconcile. Acceptance: update issues.");
  const body = prdIssueBody(item, [10]);

  assert.match(body, /Blocked-by: #10/);
  assert.match(body, /df-prd:milestones-m2/);
});

test("auditIssueBody records deterministic L5 audit findings", () => {
  const body = auditIssueBody(
    "marius-patrik/example",
    [{ category: "health", message: "Workflow `ci` concluded `failure`." }],
    { auditedAt: "2026-07-06T00:00:00.000Z" }
  );

  assert.match(body, /df-audit:marius-patrik-example/);
  assert.equal(findAuditMarker(body), "df-audit:marius-patrik-example");
  assert.match(body, /Git state/);
  assert.match(body, /Health/);
  assert.match(body, /PRD drift/);
  assert.match(body, /Doc staleness/);
  assert.match(body, /AI tokens: 0/);
});

test("label reconciliation removes stale df:ready when PRD sequencing blocks an issue", () => {
  const diff = reconcileLabelDiff(
    ["P1", "roadmap", "df:class:standard", "df:ready"],
    ["P1", "roadmap", "df:class:standard"],
    [
      "df:ready",
      "df:running",
      "df:blocked",
      "df:done",
      "df:class:mechanical",
      "df:class:standard",
      "df:class:hard",
      "roadmap",
      "P0",
      "P1",
      "P2"
    ]
  );

  assert.deepEqual(diff, { add: [], remove: ["df:ready"] });
});

test("planner label reconciliation preserves worker state labels on open issues", () => {
  assert.deepEqual(
    plannedIssueLabelDiff(
      ["P1", "roadmap", "df:class:standard", "df:blocked", "df:ready"],
      ["P1", "roadmap", "df:class:standard", "df:ready"]
    ),
    { add: [], remove: ["df:ready"] }
  );

  assert.deepEqual(
    plannedIssueLabelDiff(
      ["P1", "roadmap", "df:class:standard", "df:done"],
      ["P1", "roadmap", "df:class:standard", "df:ready"]
    ),
    { add: [], remove: [] }
  );

  assert.deepEqual(
    plannedIssueLabelDiff(
      ["P1", "roadmap", "df:class:standard", "df:done"],
      ["P1", "roadmap", "df:class:standard", "df:ready"],
      { preserveWorkerState: false }
    ),
    { add: ["df:ready"], remove: ["df:done"] }
  );
});

test("cleanupTempRoot reports cleanup failures without throwing", async () => {
  const warnings: string[] = [];
  const result = await cleanupTempRoot("\0", (warning: string) => warnings.push(warning));

  assert.equal(result.ok, false);
  assert.equal(warnings.length, 1);
  assert.match(result.warning, /cleanup warning/i);
});

test("cleanupTempRoot ignores only ENOENT cleanup races", () => {
  assert.equal(isIgnorableCleanupError({ code: "ENOENT" }), true);
  assert.equal(isIgnorableCleanupError({ code: "EACCES" }), false);
  assert.equal(isIgnorableCleanupError({ code: "EPERM" }), false);
});

test("cleanupTempRoot reports EACCES cleanup failures without throwing", async (t) => {
  const warnings: string[] = [];
  const eaccesError = Object.assign(new Error("permission denied"), { code: "EACCES" });
  const rmMock = t.mock.fn(async () => { throw eaccesError; });
  t.mock.module("node:fs/promises", { namedExports: { rm: rmMock, readFile: async () => "" } });

  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { cleanupTempRoot: cleanupTempRootUnderTest } = await import("../.github/scripts/df-lib.mjs?mock=eacces");
  const result = await cleanupTempRootUnderTest("/some/temp/root", (warning: string) => warnings.push(warning));

  assert.equal(result.ok, false);
  assert.equal(warnings.length, 1);
  assert.match(result.warning, /permission denied/);
});

test("checksAreGreen rejects pending or failing checks without requiring fixed check names", () => {
  assert.equal(checksAreGreen([]), true);
  assert.equal(checksAreGreen([], ["ci"]), false);
  assert.equal(checksAreGreen([{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }]), true);
  assert.equal(checksAreGreen([{ __typename: "CheckRun", status: "COMPLETED", conclusion: "NEUTRAL" }]), false);
  assert.equal(checksAreGreen([{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SKIPPED" }]), false);
  assert.equal(
    checksAreGreen(
      [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
      ["ci"]
    ),
    true
  );
  assert.equal(
    checksAreGreen(
      [{ __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SUCCESS" }],
      ["ci"]
    ),
    false
  );
  assert.equal(checksAreGreen([{ __typename: "CheckRun", status: "IN_PROGRESS", conclusion: null }]), false);
  assert.equal(checksAreGreen([{ __typename: "StatusContext", state: "FAILURE" }]), false);
});

test("DarkFactory Autoreview is added to required contexts only after provisioning is detected", () => {
  assert.equal(AUTOREVIEW_REQUIRED_CONTEXT, "DarkFactory Autoreview");
  assert.deepEqual(withAutoreviewRequiredContext(["Validate", "DarkFactory Autoreview"]), ["Validate", "DarkFactory Autoreview"]);
  assert.equal(
    checksAreGreen(
      [{ __typename: "CheckRun", name: "Validate", status: "COMPLETED", conclusion: "SUCCESS" }],
      withAutoreviewRequiredContext(["Validate"])
    ),
    false
  );
  assert.equal(
    checksAreGreen(
      [
        { __typename: "CheckRun", name: "Validate", status: "COMPLETED", conclusion: "SUCCESS" },
        { __typename: "CheckRun", name: "DarkFactory Autoreview", status: "COMPLETED", conclusion: "SUCCESS" }
      ],
      withAutoreviewRequiredContext(["Validate"])
    ),
    true
  );
});

test("getRequiredStatusCheckContexts distinguishes healthy, absent, and inaccessible protection", async () => {
  const healthy = await getRequiredStatusCheckContexts(
    { request: async () => managedProtection() },
    { owner: "marius-patrik", repo: "example" },
    "main"
  );
  assert.equal(healthy.observable, true);
  assert.equal(healthy.configured, true);
  assert.equal(healthy.healthy, true);
  assert.deepEqual([...healthy.contexts], ["Validate", "DarkFactory Autoreview"]);

  for (const [status, observable, configured] of [[403, false, null], [404, true, false]] as const) {
    const result = await getRequiredStatusCheckContexts(
      {
        request: async () => {
          const error: Error & { status?: number } = new Error(`${status} protection unavailable`);
          error.status = status;
          throw error;
        }
      },
      { owner: "marius-patrik", repo: "example" },
      "main"
    );
    assert.equal(result.observable, observable);
    assert.equal(result.configured, configured);
    assert.equal(result.healthy, false);
    assert.deepEqual([...result.contexts], []);
  }
});

test("getBranchProtection treats 403 and 404 as not configured without swallowing other errors", async () => {
  for (const status of [403, 404]) {
    const result = await getBranchProtection(
      {
        request: async () => {
          const error: Error & { status?: number } = new Error(`${status} branch protection unavailable`);
          error.status = status;
          throw error;
        }
      },
      { owner: "marius-patrik", repo: "example" },
      "dev"
    );

    assert.equal(result.configured, false);
    assert.equal(result.status, status);
  }

  const serverError: Error & { status?: number } = new Error("server error");
  serverError.status = 500;
  await assert.rejects(
    () => getBranchProtection(
      {
        request: async () => {
          throw serverError;
        }
      },
      { owner: "marius-patrik", repo: "example" },
      "dev"
    ),
    /server error/
  );
});

test("extractClosingIssueNumbers deduplicates close references", () => {
  assert.deepEqual(
    extractClosingIssueNumbers(
      "Closes #10, fixes marius-patrik/example#10, resolves marius-patrik/example#22, closes other/repo#99.",
      "marius-patrik/example"
    ),
    [10, 22]
  );
});

test("parked repositories include the current owner exclusions", () => {
  assert.equal(isParkedRepo({ owner: "marius-patrik", repo: "skyblock-agent" }), true);
  assert.equal(isParkedRepo({ owner: "marius-patrik", repo: "SkyAgent" }), true);
  assert.equal(isParkedRepo({ owner: "marius-patrik", repo: "fabrica" }), true);
  assert.equal(isParkedRepo({ owner: "marius-patrik", repo: "LifeQuest" }), true);
  assert.throws(() => assertAllowedRepo({ owner: "marius-patrik", repo: "singularity" }), /parked/);
  assert.throws(() => assertAllowedRepo({ owner: "marius-patrik", repo: "life-support" }), /parked/);
  assert.throws(() => assertAllowedRepo({ owner: "marius-patrik", repo: "LifeQuest" }), /parked/);
});

test("listActiveManagedRepos excludes archived, disabled, and non-active lifecycle repos", async () => {
  const warnings: string[] = [];
  const registry = {
    repositories: {
      "marius-patrik/active": { state: "active" },
      "marius-patrik/parked": { state: "parked" },
      "marius-patrik/completed": { state: "completed" },
      "marius-patrik/removed": { state: "removed" },
      "marius-patrik/archived-by-registry": { state: "archived" },
      "marius-patrik/archived-by-github": { state: "active" },
      "marius-patrik/disabled-by-github": { state: "active" },
      "other-owner/active": { state: "active" }
    }
  };
  const repositories = [
    { full_name: "marius-patrik/active", archived: false, disabled: false },
    { full_name: "marius-patrik/parked", archived: false, disabled: false },
    { full_name: "marius-patrik/completed", archived: false, disabled: false },
    { full_name: "marius-patrik/removed", archived: false, disabled: false },
    { full_name: "marius-patrik/archived-by-registry", archived: false, disabled: false },
    { full_name: "marius-patrik/archived-by-github", archived: true, disabled: false },
    { full_name: "marius-patrik/disabled-by-github", archived: false, disabled: true },
    { full_name: "marius-patrik/unlisted", archived: false, disabled: false },
    { full_name: "other-owner/active", archived: false, disabled: false }
  ];

  const active = await listActiveManagedRepos(
    { request: async () => ({ repositories: [] }) },
    { owner: "marius-patrik", repo: "DarkFactory" },
    { repositories, registry, warn: (warning: string) => warnings.push(warning) }
  );

  assert.deepEqual(active, [{ owner: "marius-patrik", repo: "active" }]);
  assert.ok(warnings.some((warning) => warning.includes("archived=true")));
  assert.ok(warnings.some((warning) => warning.includes("disabled=true")));
  assert.ok(warnings.some((warning) => warning.includes("managed lifecycle state is 'parked'")));
  assert.ok(warnings.some((warning) => warning.includes("managed lifecycle state is 'removed'")));
});

test("installation repository enumeration is total-bound, strict, and fail-closed", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    full_name: `marius-patrik/repo-${index}`,
    archived: false,
    disabled: false
  }));
  const secondPage = [{ full_name: "marius-patrik/repo-100", archived: false, disabled: false }];
  const calls: string[] = [];
  const repositories = await listInstallationRepositories({
    async request(_method: string, requestPath: string) {
      calls.push(requestPath);
      return requestPath.endsWith("page=1")
        ? { total_count: 101, repositories: firstPage }
        : { total_count: 101, repositories: secondPage };
    }
  });
  assert.equal(repositories.length, 101);
  assert.equal(calls.length, 2);

  await assert.rejects(
    () => listInstallationRepositories({ request: async () => ({ repositories: [] }) }),
    /malformed installation repository enumeration evidence/
  );
  await assert.rejects(
    () => listInstallationRepositories({
      request: async (_method: string, requestPath: string) => requestPath.endsWith("page=1")
        ? { total_count: 101, repositories: firstPage }
        : { total_count: 101, repositories: [] }
    }),
    /incomplete installation repository enumeration/
  );
  let cappedPage = 0;
  await assert.rejects(
    () => listInstallationRepositories({
      async request() {
        cappedPage += 1;
        return {
          total_count: 2001,
          repositories: Array.from({ length: 100 }, (_, index) => ({
            full_name: `marius-patrik/capped-${cappedPage}-${index}`
          }))
        };
      }
    }),
    /cannot prove complete installation repository enumeration/
  );
  assert.equal(cappedPage, 20);
  await assert.rejects(
    () => listActiveManagedRepos(
      { request: async () => ({ total_count: 0, repositories: [] }) },
      { owner: "marius-patrik", repo: "DarkFactory" },
      { repositories: [{ full_name: "marius-patrik/valid" }, { unexpected: true }], registry: { repositories: {} } }
    ),
    /malformed installation repository entry/
  );
});

test("canonical Andromeda installation names resolve through the live managed registry", async () => {
  const warnings: string[] = [];
  const registry = await readManagedRepoRegistry();
  const active = await listActiveManagedRepos(
    { request: async () => ({ repositories: [] }) },
    { owner: "marius-patrik", repo: "DarkFactory" },
    {
      registry,
      repositories: [
        { full_name: "marius-patrik/Andromeda", archived: false, disabled: false },
        { full_name: "marius-patrik/Andromeda-data", archived: false, disabled: false },
        { full_name: "marius-patrik/DarkFactory", archived: false, disabled: false },
        { full_name: "marius-patrik/skyblock-agent", archived: false, disabled: false }
      ],
      warn: (warning: string) => warnings.push(warning)
    }
  );

  assert.deepEqual(active, [
    { owner: "marius-patrik", repo: "Andromeda" },
    { owner: "marius-patrik", repo: "Andromeda-data" }
  ]);
  assert.ok(warnings.some((warning) => warning.includes("marius-patrik/DarkFactory") && warning.includes("'removed'")));
  assert.ok(warnings.some((warning) => warning.includes("marius-patrik/skyblock-agent") && warning.includes("'removed'")));
});

test("df-sweep dev-merge closure uses worker PR provenance instead of issue labels or comments", async () => {
  const source = await readFile(new URL("../.github/scripts/df-sweep.mjs", import.meta.url), "utf8");

  assert.match(source, /reason: "parked"/);
  assert.match(source, /if \(!isWorkerPullRequest\(pull, repository\)\)/);
  assert.doesNotMatch(source, /issueWasOpenedByDarkFactoryWorker/);
  assert.match(source, /extractClosingIssueNumbers\(pull\.body \|\| "", repoName\(repository\)\)/);
});

test("worker actor normalization accepts the exact installed App actor from REST and GraphQL", () => {
  assert.equal(
    normalizeWorkerPullRequestActor({ type: "Bot", login: "darkfactory-agent[bot]" }),
    "darkfactory-agent"
  );
  assert.equal(
    normalizeWorkerPullRequestActor({ __typename: "Bot", login: "darkfactory-agent" }),
    "darkfactory-agent"
  );
});

test("worker actor normalization rejects REST near-miss identities", () => {
  for (const login of [
    "darkfactory-agent",
    "app/darkfactory-agent",
    "evil-darkfactory-agent[bot]",
    "darkfactory-agent[bot] ",
    "DarkFactory-agent[bot]"
  ]) {
    assert.equal(normalizeWorkerPullRequestActor({ type: "Bot", login }), null, login);
  }
});

test("worker actor normalization rejects stale producers and ambiguous actor shapes", () => {
  assert.equal(normalizeWorkerPullRequestActor({ type: "Bot", login: "github-actions[bot]" }), null);
  assert.equal(normalizeWorkerPullRequestActor({ type: "Bot", login: "mp-agents[bot]" }), null);
  assert.equal(normalizeWorkerPullRequestActor({ type: "User", login: "darkfactory-agent[bot]" }), null);
  assert.equal(normalizeWorkerPullRequestActor({ login: "darkfactory-agent[bot]" }), null);
  assert.equal(
    normalizeWorkerPullRequestActor({ type: "Bot", __typename: "Bot", login: "darkfactory-agent[bot]" }),
    null
  );
});

test("df-sweep recognizes worker PRs only from the canonical App actor", () => {
  const repository = { owner: "marius-patrik", repo: "example" };
  const workerPull = {
    title: "Implement issue #23",
    body: "<!-- dark-factory:worker-pr issue=23 -->\n\nCloses #23",
    author: { __typename: "Bot", login: "darkfactory-agent" },
    headRefName: "df/23-add-worker",
    headRepository: { owner: { login: "marius-patrik" }, name: "example" }
  };

  assert.equal(isDarkFactoryWorkerPullRequest(workerPull, repository), true);
  assert.equal(
    isDarkFactoryWorkerPullRequest(
      { ...workerPull, author: { type: "Bot", login: "darkfactory-agent[bot]" } },
      repository
    ),
    true
  );
  assert.equal(isDarkFactoryWorkerPullRequest({ ...workerPull, author: { type: "User", login: "marius-patrik" } }, repository), false);
  assert.equal(isDarkFactoryWorkerPullRequest({ ...workerPull, headRefName: "feature/23-add-worker" }, repository), false);
  assert.equal(isDarkFactoryWorkerPullRequest({ ...workerPull, body: "<!-- dark-factory:worker-pr issue=23 -->" }, repository), false);
  assert.equal(darkFactoryWorkerIssueNumber(workerPull), 23);
});

test("df-sweep marks blocked worker issues when follow-through cannot merge", async () => {
  const source = await readFile(new URL("../.github/scripts/df-sweep.mjs", import.meta.url), "utf8");

  assert.match(source, /markWorkerIssueBlocked\(repository, pull, "merge-policy-blocked"/);
  assert.match(source, /markWorkerIssueBlocked\(repository, pull, reason/);
  assert.doesNotMatch(source, /checksSummary\(pull\.statusCheckRollup\)\.join/);
  assert.match(source, /replaceIssueLabels\(repository, issueNumber, \["df:blocked"\], \["df:ready", "df:running", "df:done"\]\)/);
  assert.match(source, /dark-factory:sweep-blocked/);
});

test("df-sweep dev-merge backstop preserves REST merged_at in normalized PRs", async () => {
  const source = await readFile(new URL("../.github/scripts/df-sweep.mjs", import.meta.url), "utf8");

  assert.match(source, /const mergedAt = pull\.merged_at \|\| null/);
  assert.match(source, /mergedAt\s*\n\s*\};/);
  assert.match(source, /if \(!normalized\.mergedAt \|\| normalized\.baseRefName !== "dev"/);
  assert.match(source, /GET.*\/repos\/\$\{repoName\(repository\)\}\/pulls\/\$\{pull\.number\}/);
  assert.doesNotMatch(source, /pull\.merged !== true/);
});

test("dev-merge event closure re-fetches exact managed repository, PR, and merge commit identities", async () => {
  const calls: string[] = [];
  configureSweepRuntime({
    controlRepo: { owner: "marius-patrik", repo: "DarkFactory" },
    gh: {
      request: async (method: string, pathName: string) => {
        calls.push(`${method} ${pathName}`);
        if (pathName === "/repos/marius-patrik/Andromeda") {
          return { full_name: "marius-patrik/Andromeda", archived: false, disabled: false };
        }
        if (pathName === "/repos/marius-patrik/Andromeda/pulls/42") {
          return trustedMergedDevPull();
        }
        if (pathName.endsWith("/commits/0123456789abcdef0123456789abcdef01234567")) {
          return { sha: "0123456789abcdef0123456789abcdef01234567" };
        }
        throw new Error(`unexpected mocked request: ${method} ${pathName}`);
      }
    }
  });

  const result = await verifyDevMergeRequest({
    repositoryName: "marius-patrik/Andromeda",
    pullNumber: "42",
    mergeSha: "0123456789abcdef0123456789abcdef01234567"
  });

  assert.equal(result.pull.number, 42);
  assert.equal(result.pull.baseRefName, "dev");
  assert.deepEqual(result.closingIssues, [42]);
  assert.deepEqual(calls, [
    "GET /repos/marius-patrik/Andromeda",
    "GET /repos/marius-patrik/Andromeda/pulls/42",
    "GET /repos/marius-patrik/Andromeda/commits/0123456789abcdef0123456789abcdef01234567"
  ]);
});

test("dev-merge event closure fails closed before mutation on identity or lifecycle mismatch", async () => {
  const mutations: string[] = [];
  configureSweepRuntime({
    controlRepo: { owner: "marius-patrik", repo: "DarkFactory" },
    gh: {
      request: async (method: string, pathName: string) => {
        if (method === "POST" || method === "PATCH" || method === "PUT") mutations.push(`${method} ${pathName}`);
        if (pathName === "/repos/marius-patrik/Andromeda") {
          return { full_name: "marius-patrik/Andromeda", archived: false, disabled: false };
        }
        if (pathName === "/repos/marius-patrik/Andromeda/pulls/42") {
          return trustedMergedDevPull();
        }
        throw new Error(`unexpected mocked request: ${method} ${pathName}`);
      }
    }
  });

  await assert.rejects(
    verifyDevMergeRequest({
      repositoryName: "marius-patrik/Andromeda",
      pullNumber: "42",
      mergeSha: "ffffffffffffffffffffffffffffffffffffffff"
    }),
    /commit SHA does not match/
  );
  await assert.rejects(
    verifyDevMergeRequest({
      repositoryName: "marius-patrik/DarkFactory",
      pullNumber: "42",
      mergeSha: "0123456789abcdef0123456789abcdef01234567"
    }),
    /managed lifecycle state 'removed'/
  );
  assert.deepEqual(mutations, []);
});

test("dev-merge closure recovers partial issue mutation and is idempotent after convergence", async () => {
  const mutations: string[] = [];
  let issueState = "open";
  configureSweepRuntime({
    controlRepo: { owner: "marius-patrik", repo: "DarkFactory" },
    gh: {
      request: async (method: string, pathName: string) => {
        if (method === "GET" && pathName.endsWith("/issues/42")) return { number: 42, state: issueState };
        if (method === "GET" && pathName.endsWith("/issues/42/comments?per_page=100")) {
          return [{ body: "merged to dev in https://github.com/marius-patrik/Andromeda/pull/42" }];
        }
        if (method === "PATCH" && pathName.endsWith("/issues/42")) {
          mutations.push(`${method} ${pathName}`);
          issueState = "closed";
          return { number: 42, state: issueState };
        }
        if (method === "POST" || method === "PATCH") mutations.push(`${method} ${pathName}`);
        throw new Error(`unexpected mocked request: ${method} ${pathName}`);
      }
    }
  });
  const pull = normalizeTrustedMergedDevPull();

  const recovered = await closeIssuesIfDevMerge({ owner: "marius-patrik", repo: "Andromeda" }, pull);
  const duplicate = await closeIssuesIfDevMerge({ owner: "marius-patrik", repo: "Andromeda" }, pull);

  assert.deepEqual(recovered.issues, [42]);
  assert.deepEqual(duplicate.issues, []);
  assert.deepEqual(mutations, ["PATCH /repos/marius-patrik/Andromeda/issues/42"]);
});

test("successful dev-merge issue convergence is not undone by ledger failure", async () => {
  const mutations: string[] = [];
  configureSweepRuntime({
    controlRepo: { owner: "marius-patrik", repo: "DarkFactory" },
    gh: {
      request: async (method: string, pathName: string) => {
        if (pathName === "/repos/marius-patrik/Andromeda") {
          return { full_name: "marius-patrik/Andromeda", archived: false, disabled: false };
        }
        if (pathName === "/repos/marius-patrik/Andromeda/pulls/42") return trustedMergedDevPull();
        if (pathName.endsWith("/commits/0123456789abcdef0123456789abcdef01234567")) {
          return { sha: "0123456789abcdef0123456789abcdef01234567" };
        }
        if (method === "GET" && pathName.endsWith("/issues/42")) return { number: 42, state: "open" };
        if (method === "GET" && pathName.endsWith("/issues/42/comments?per_page=100")) return [];
        if ((method === "POST" || method === "PATCH") && pathName.includes("/issues/42")) {
          mutations.push(`${method} ${pathName}`);
          return {};
        }
        if (pathName.includes("/repos/marius-patrik/darkfactory-data/contents/")) {
          throw new Error("ledger unavailable");
        }
        throw new Error(`unexpected mocked request: ${method} ${pathName}`);
      }
    }
  });

  await assert.doesNotReject(() => closeVerifiedDevMergeIssues({
    repositoryName: "marius-patrik/Andromeda",
    pullNumber: "42",
    mergeSha: "0123456789abcdef0123456789abcdef01234567"
  }));
  assert.deepEqual(mutations, [
    "POST /repos/marius-patrik/Andromeda/issues/42/comments",
    "PATCH /repos/marius-patrik/Andromeda/issues/42"
  ]);
});

function trustedMergedDevPull() {
  return {
    number: 42,
    state: "closed",
    merged: true,
    merged_at: "2026-07-15T06:00:00Z",
    merge_commit_sha: "0123456789abcdef0123456789abcdef01234567",
    title: "Implement issue #42",
    body: "<!-- dark-factory:worker-pr issue=42 -->\n\nCloses #42",
    html_url: "https://github.com/marius-patrik/Andromeda/pull/42",
    user: { login: "darkfactory-agent[bot]", type: "Bot" },
    base: {
      ref: "dev",
      sha: "1111111111111111111111111111111111111111",
      repo: { full_name: "marius-patrik/Andromeda" }
    },
    head: {
      ref: "df/42-trusted-closure",
      sha: "2222222222222222222222222222222222222222",
      repo: { name: "Andromeda", owner: { login: "marius-patrik" } }
    }
  };
}

function normalizeTrustedMergedDevPull() {
  const pull = trustedMergedDevPull();
  return {
    number: pull.number,
    title: pull.title,
    body: pull.body,
    url: pull.html_url,
    author: { login: pull.user.login, type: pull.user.type },
    headRefName: pull.head.ref,
    headRepository: { name: pull.head.repo.name, owner: { login: pull.head.repo.owner.login } },
    baseRefName: pull.base.ref,
    mergedAt: pull.merged_at,
    mergeCommitSha: pull.merge_commit_sha
  };
}

test("df-work cleanup remains a warning path after successful PR handoff", async () => {
  const source = await readFile(new URL("../.github/scripts/df-work.mjs", import.meta.url), "utf8");
  const successBeforeFinally = /ledger\.status = "success";[\s\S]+finally \{/.test(source);
  const finallyBlock = source.slice(source.indexOf("finally {"));

  assert.equal(successBeforeFinally, true);
  assert.doesNotMatch(source, /action: "post-pr-warning"/);
  assert.match(source, /if \(pullRequest\)/);
  assert.match(source, /ledger\.pull_request = pullRequest\.html_url/);
  assert.match(finallyBlock, /const cleanup = await cleanupTempRoot/);
  assert.match(finallyBlock, /ledger\.cleanup = cleanup/);
  assert.doesNotMatch(finallyBlock, /throw\s+cleanup|if\s*\(\s*!cleanup\.ok/);
});

test("df-plan reopens PRD-tracked issues when the PRD item still exists", async () => {
  const source = await readFile(new URL("../.github/scripts/df-plan.mjs", import.meta.url), "utf8");

  assert.match(source, /action: "keep-closed"/);
  assert.match(source, /action: "reopen-prd-issue"/);
  assert.match(source, /state: "open"/);
  assert.match(source, /listPrdPaths/);
  assert.match(source, /getRecursiveTree/);
  assert.match(source, /git\/commits\/\$\{encodeURIComponent\(ref\)\}/);
  assert.match(source, /commit\?\.tree\?\.sha/);
  assert.match(source, /tracked `PRD\.md` file/);
});

test("df-plan drift detection covers untracked open issues and PRs", async () => {
  const source = await readFile(new URL("../.github/scripts/df-plan.mjs", import.meta.url), "utf8");

  assert.match(source, /not tracked by any PRD item/);
  assert.match(source, /isDarkFactoryManagedIssue\(labels\)/);
  assert.match(source, /\^df:\(ready\|running\|blocked\|done\|class:\)/);
  assert.match(source, /not linked to a PRD-tracked issue/);
  assert.match(source, /extractClosingIssueNumbers/);
  assert.match(source, /listOpenPullRequests/);
});

test("df-plan drift detection maps M2 PRD commitments to code artifacts", async () => {
  const source = await readFile(new URL("../.github/scripts/df-plan.mjs", import.meta.url), "utf8");

  assert.match(source, /detectPrdArtifactDrift/);
  assert.match(source, /PRD editing to automatically reconcile sequenced backlog issues/);
  assert.match(source, /PRD drift reporting when code or backlog contradicts the PRD/);
  assert.match(source, /prd\\W\*backlog/);
  assert.match(source, /\.github\/workflows\/df-plan\.yml/);
  assert.match(source, /\.github\/scripts\/df-plan\.mjs/);
  assert.match(source, /listen for PRD file changes/);
  assert.match(source, /maintain sequencing references/);
  assert.match(source, /file or update a drift report issue/);
  assert.match(source, /does not \$\{check\.reason\}/);
  assert.match(source, /artifactContentForChecks/);
  assert.match(source, /detectPrdArtifactDrift\[\\s\\S\]\*\?/);
});

test("df-plan workflow reacts safely to PRD edits on the trusted default branch", async () => {
  const workflow = await readFile(new URL("../.github/workflows/df-plan.yml", import.meta.url), "utf8");
  const parsed = loadYaml(workflow);
  const gate = workflow.indexOf("Validate trusted control ref");
  const pushCheckout = workflow.indexOf("Checkout target repository scripts");
  const checkout = workflow.indexOf("Checkout DarkFactory control scripts");
  const token = workflow.indexOf("Mint mp-agents installation token");

  assert.match(workflow, /^\s+push:\s*$/m);
  assert.match(workflow, /^\s+branches:\s*$/m);
  assert.match(workflow, /^\s+-\s+main\s*$/m);
  assert.doesNotMatch(workflow, /^\s+-\s+dev\s*$/m);
  assert.match(workflow, /PRD\.md/);
  assert.doesNotMatch(workflow, /raw\.githubusercontent\.com|commits\/main|method:\s*'HEAD'/);
  assert.match(workflow, /^\s+workflow_dispatch:\s*$/m);
  assert.match(workflow, /^\s+schedule:\s*$/m);
  assert.match(workflow, /^\s+push:\s*$/m);
  assert.match(workflow, /push:\s*\n\s+branches:\s*\n\s+- main/);
  assert.match(workflow, /github\.event_name == 'schedule'.*github\.repository == 'marius-patrik\/DarkFactory'/);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch'.*github\.repository == 'marius-patrik\/DarkFactory'/);
  assert.doesNotMatch(workflow, /actions:\s+write/);
  assert.notEqual(gate, -1);
  assert.notEqual(pushCheckout, -1);
  assert.notEqual(checkout, -1);
  assert.notEqual(token, -1);
  assert.ok(gate < pushCheckout);
  assert.ok(pushCheckout < token);
  assert.ok(gate < checkout);
  assert.ok(checkout < token);
  assert.match(workflow, /Resolve DarkFactory script path/);
  assert.match(workflow, /Checkout target repository scripts/);
  assert.match(workflow, /if:\s*github\.event_name == 'push'/);
  assert.match(workflow, /persist-credentials:\s+false/);
  assert.match(workflow, /Checkout DarkFactory control scripts/);
  assert.match(workflow, /repository:\s+marius-patrik\/DarkFactory/);
  assert.match(workflow, /GITHUB_REPOSITORY_OWNER/);
  assert.match(workflow, /GITHUB_REF_NAME.*main/);
  assert.match(workflow, /GITHUB_REF.*refs\/heads\/main/);
  assert.doesNotMatch(workflow, /GITHUB_REF_NAME.*dev/);
  assert.doesNotMatch(workflow, /GITHUB_REF.*refs\/heads\/dev/);
  assert.doesNotMatch(workflow, /path:\s+darkfactory-control/);
  assert.match(workflow, /ref:\s+\$\{\{\s*github\.sha\s*\}\}/);
  assert.match(workflow, /if:\s*github\.event_name != 'push'/);
  assert.match(workflow, /path=\.github\/scripts\/df-plan\.mjs/);
  assert.doesNotMatch(workflow, /ref:\s*\$\{\{.*'main'.*\}\}/);
  assert.doesNotMatch(workflow, /steps\.control-ref\.outputs\.sha|Resolve canonical control ref/);
  assert.match(workflow, /Validate manual planning target ref/);
  assert.match(workflow, /Validate manual planning target repository/);
  assert.match(workflow, /DF_INPUT_REF:\s*\$\{\{ inputs\.ref \}\}/);
  assert.match(workflow, /DF_INPUT_REPO:\s*\$\{\{ inputs\.repo \}\}/);
  for (const step of parsed.jobs["df-plan"].steps.filter((item: any) => typeof item.run === "string")) {
    assert.doesNotMatch(step.run, /\$\{\{\s*inputs\./, step.name);
  }
  assert.match(workflow, /marius-patrik\/fabrica/);
  assert.match(workflow, /must be a marius-patrik repository/);
  assert.match(workflow, /permission-issues:\s+write/);
  assert.match(workflow, /permission-pull-requests:\s+write/);
  assert.match(workflow, /permission-contents:\s+write/);
  assert.doesNotMatch(workflow, /DARK_FACTORY_CONTROL_REF/);
});

test("df-plan never publishes or queues readiness without exact issue Autoreview", async () => {
  const source = await readFile(new URL("../.github/scripts/df-plan.mjs", import.meta.url), "utf8");

  assert.doesNotMatch(source, /dispatchIfNewlyReady|dispatchReadyWorker|await-control-orchestrator/);
  assert.doesNotMatch(source, /labels\.push\("df:ready"\)/);
  assert.match(source, /Planning owns sequencing, never readiness/);
  assert.match(source, /invalidateReadiness/);
  assert.match(source, /\["df:ready", "df:reviewed"\]/);
  assert.doesNotMatch(source, /actions\/workflows\/df-work\.yml\/dispatches/);
});

test("df-plan preserves PRD sequence references across completed predecessors", async () => {
  const source = await readFile(new URL("../.github/scripts/df-plan.mjs", import.meta.url), "utf8");

  assert.match(source, /let previousIssueNumber = null/);
  assert.doesNotMatch(source, /previousOpenIssueNumber/);
  assert.match(source, /const blockedBy = previousIssueNumber \? \[previousIssueNumber\] : \[\]/);
  assert.doesNotMatch(source, /previousOpenIssueNumber === null\) labels\.push\("df:ready"\)/);
  assert.match(source, /previousIssueNumber = closed\.number/);
  assert.match(source, /previousIssueNumber = existing\.number/);
  assert.match(source, /create-closed-completed-prd-issue/);
});

test("repository doctor performs deterministic diagnosis and explicit per-finding reporting", async () => {
  const source = await readFile(new URL("../.github/scripts/df-audit.mjs", import.meta.url), "utf8");

  assert.match(source, /runRepositoryDoctor/);
  assert.match(source, /auditBranchAndReleaseState/);
  assert.match(source, /auditManagedFileDrift/);
  assert.match(source, /auditRepositoryTree/);
  assert.match(source, /auditHealth/);
  assert.match(source, /auditPrdDrift/);
  assert.match(source, /auditDocStaleness/);
  assert.match(source, /auditWorkerSessionIsolation/);
  assert.match(source, /reconcileDoctorIssues/);
  assert.match(source, /df-doctor/);
  assert.match(source, /df:doctor/);
  assert.match(source, /parseDoctorMode/);
  assert.match(source, /mode === "report"/);
  assert.match(source, /mode === "report"[\s\S]+requiredEnv\("DF_LEDGER_TOKEN"\)/);
  assert.match(source, /ledgerToken === token/);
  assert.match(source, /publishDoctorReport\(github, options\.ledgerGithub/);
  assert.match(source, /writeDoctorLedger\(ledgerGithub/);
  assert.doesNotMatch(source, /writeDoctorLedger\((?:github|options\.github)/);
  assert.doesNotMatch(source, /ensureLabels/);
  assert.match(source, /repair mode is not implemented/);
  assert.match(source, /writeRunLedger/);
  assert.match(source, /model_calls:\s*0/);
  assert.match(source, /listActiveManagedRepos/);
  assert.match(source, /auditSubmoduleState/);
  assert.doesNotMatch(source, /\bcodex\s+exec\b|CODEX_AUTH_JSON|DF_WORKER_IMAGE|docker\s+run/);
});

test("repository doctor workflow schedules trusted diagnosis with explicit report authority", async () => {
  const workflow = await readFile(new URL("../.github/workflows/df-audit.yml", import.meta.url), "utf8");
  const parsed = loadYaml(workflow);
  const steps = parsed.jobs["repository-doctor"].steps;
  const targetToken = steps.find((step: any) => step.name === "Mint least-privilege target doctor token");
  const ledgerToken = steps.find((step: any) => step.name === "Mint repository-scoped ledger token");
  const doctorStep = steps.find((step: any) => step.name === "Run deterministic repository doctor");
  const gate = workflow.indexOf("Validate trusted control ref");
  const checkout = workflow.indexOf("Checkout trusted doctor source");
  const token = workflow.indexOf("Mint least-privilege target doctor token");

  assert.match(workflow, /name: DarkFactory Repository Doctor/);
  assert.match(workflow, /^\s+schedule:\s*$/m);
  assert.match(workflow, /^\s+workflow_dispatch:\s*$/m);
  assert.match(workflow, /github\.repository == 'marius-patrik\/DarkFactory'/);
  assert.notEqual(gate, -1);
  assert.notEqual(checkout, -1);
  assert.notEqual(token, -1);
  assert.ok(gate < checkout);
  assert.ok(checkout < token);
  assert.match(workflow, /GITHUB_REF.*refs\/heads\/main/);
  assert.doesNotMatch(workflow, /GITHUB_REF.*refs\/heads\/dev/);
  assert.match(workflow, /Validate manual target/);
  assert.match(workflow, /DF_MANUAL_DOCTOR_REPO: \$\{\{ inputs\.repo \}\}/);
  assert.match(workflow, /write_issues:/);
  assert.equal(targetToken.with["permission-administration"], "read");
  assert.equal(targetToken.with["permission-actions"], "read");
  assert.equal(targetToken.with["permission-checks"], "read");
  assert.equal(targetToken.with["permission-contents"], "read");
  assert.match(targetToken.with["permission-issues"], /write.*read/);
  assert.equal(targetToken.with["permission-pull-requests"], "read");
  assert.equal(targetToken.with["permission-secrets"], "read");
  assert.equal(targetToken.with["permission-statuses"], "read");
  assert.equal(ledgerToken.with.repositories, "darkfactory-data");
  assert.equal(ledgerToken.with["permission-contents"], "write");
  assert.match(ledgerToken.if, /schedule.*push.*write_issues/);
  assert.match(doctorStep.env.DF_LEDGER_TOKEN, /ledger-token\.outputs\.token/);
  assert.equal(steps.some((step: any) => /label/i.test(step.name || "") && /POST|PATCH/.test(step.run || "")), false);
  assert.match(workflow, /DF_DOCTOR_ALL/);
  assert.match(workflow, /DF_DOCTOR_MODE/);
  assert.match(workflow, /repository-doctor-report\.json/);
  assert.match(workflow, /model_calls=0/);
  assert.doesNotMatch(workflow, /DF_DATA_REPO/);
});

test("managed repository sync binds the canonical Andromeda-data checkout to AGENTS_HOME", async () => {
  const workflow = await readFile(new URL("../.github/workflows/sync-managed-repos.yml", import.meta.url), "utf8");
  const gate = workflow.indexOf("Validate trusted control ref");
  const checkout = workflow.indexOf("Check out trusted DarkFactory control");
  const token = workflow.indexOf("Create scoped Andromeda-data read token");

  assert.notEqual(gate, -1);
  assert.notEqual(checkout, -1);
  assert.notEqual(token, -1);
  assert.ok(gate < checkout && checkout < token);
  assert.match(workflow, /github\.repository == 'marius-patrik\/DarkFactory'/);
  assert.match(workflow, /GITHUB_REPOSITORY/);
  assert.match(workflow, /GITHUB_REF.*refs\/heads\/main/);
  assert.match(workflow, /GITHUB_REF_NAME.*main/);
  assert.match(workflow, /repository:\s+marius-patrik\/DarkFactory/);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /persist-credentials:\s+false/);
  assert.match(workflow, /repositories:\s+Andromeda-data/);
  assert.match(workflow, /permission-contents:\s+read/);
  assert.match(workflow, /repository:\s+marius-patrik\/Andromeda-data\b/);
  assert.match(workflow, /AGENTS_HOME:\s+\$\{\{ github\.workspace \}\}\/\.andromeda-data/);
  assert.match(workflow, /repo:'marius-patrik\/Andromeda-data'/);
  assert.match(workflow, /path:process\.env\.AGENTS_HOME/);
  assert.doesNotMatch(workflow, /repository:\s+marius-patrik\/agents-data\b/);
  assert.doesNotMatch(workflow, /process\.env\.AGENTS_ROOT\s*\+\s*['"]\/data\/agent-os/);
});

test("active deterministic ledgers use provider-agnostic model call accounting", async () => {
  for (const script of ["df-orchestrate.mjs", "df-plan.mjs", "df-fix.mjs", "df-sweep.mjs", "df-verify.mjs"]) {
    const source = await readFile(new URL(`../.github/scripts/${script}`, import.meta.url), "utf8");
    assert.match(source, /token_usage:\s*\{[\s\S]*?model_calls:\s*0/, script);
    assert.doesNotMatch(source, /\bcodex_calls\b/, script);
  }
});

test("df-follow-through workflow validates trusted refs before privileged tokens", async () => {
  const workflow = await readFile(new URL("../.github/workflows/df-follow-through.yml", import.meta.url), "utf8");
  const gate = workflow.indexOf("Validate trusted control ref");
  const checkout = workflow.indexOf("Checkout DarkFactory from this repository");
  const token = workflow.indexOf("Mint mp-agents installation token");

  assert.notEqual(gate, -1);
  assert.notEqual(checkout, -1);
  assert.notEqual(token, -1);
  assert.ok(gate < token);
  assert.ok(checkout < token);
  assert.match(workflow, /github\.repository == 'marius-patrik\/DarkFactory'/);
  assert.match(workflow, /GITHUB_REPOSITORY/);
  assert.match(workflow, /GITHUB_REF_NAME.*main/);
  assert.match(workflow, /GITHUB_REF.*refs\/heads\/main/);
  assert.match(workflow, /permission-contents:\s+write/);
  assert.match(workflow, /permission-issues:\s+write/);
  assert.match(workflow, /permission-pull-requests:\s+write/);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /^\s+workflow_run:\s*$/m);
  assert.match(workflow, /workflows:\s*\n\s+-\s+DarkFactory Verify Worker Claim/);
  assert.match(workflow, /types:\s*\n\s+-\s+completed/);
  assert.match(workflow, /github\.event_name == 'workflow_run'/);
  assert.match(workflow, /github\.event\.workflow_run\.head_branch == 'main'/);
  assert.match(workflow, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.doesNotMatch(workflow, /github\.ref_name|DARK_FACTORY_CONTROL_REF/);
});

test("df-release runs immutable control code and exposes no force or default-branch write path", async () => {
  const workflow = await readFile(new URL("../.github/workflows/df-release.yml", import.meta.url), "utf8");
  const source = await readFile(new URL("../.github/scripts/df-release.mjs", import.meta.url), "utf8");
  const gate = workflow.indexOf("Validate trusted control ref and input");
  const checkout = workflow.indexOf("Checkout immutable trusted release controller");
  const token = workflow.indexOf("Mint read-only release observation token");
  const writeToken = workflow.indexOf("Mint bounded release mutation token");

  assert.ok(gate >= 0 && checkout > gate && token > checkout && writeToken > token);
  assert.match(workflow, /^  schedule:/m);
  assert.match(workflow, /^  workflow_dispatch:/m);
  assert.match(workflow, /GITHUB_REPOSITORY.*marius-patrik\/DarkFactory/);
  assert.match(workflow, /GITHUB_REF.*refs\/heads\/main/);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /permission-administration:\s+read/);
  assert.match(workflow, /Mint read-only release observation token[\s\S]+permission-contents:\s+read/);
  assert.match(workflow, /Mint bounded release mutation token[\s\S]+permission-contents:\s+write/);
  assert.match(workflow, /Mint bounded release mutation token[\s\S]+permission-actions:\s+write/);
  assert.match(workflow, /permission-contents:\s+write/);
  assert.match(workflow, /node \.github\/scripts\/df-release\.mjs/);
  assert.doesNotMatch(workflow, /repository:\s*\$\{\{ inputs\.repo/);
  assert.match(workflow, /group:\s+darkfactory-release-mutation/);

  assert.match(source, /enablePullRequestAutoMerge/);
  assert.doesNotMatch(source, /git\/refs\/heads\/dev/);
  assert.doesNotMatch(source, /PATCH.*git\/refs\/heads\/main/s);
  assert.doesNotMatch(source, /force:\s*true|admin[_-]bypass/i);
  assert.match(source, /reviewed-pr-tree-converged/);
  assert.match(source, /review-main-into-dev/);
  assert.match(source, /reviewed-ancestry-and-exact-tree-identity/);
  assert.match(source, /darkfactory:release plan=/);
  assert.match(source, /darkfactory:reconcile plan=/);
  assert.match(source, /df:ask-owner/);
  assert.match(source, /writeReleaseLedger\(repository, "df-release"/);
});

test("df-fix workflow validates trusted refs before privileged tokens", async () => {
  const workflow = await readFile(new URL("../.github/workflows/df-fix.yml", import.meta.url), "utf8");
  const gate = workflow.indexOf("Validate trusted control ref");
  const checkout = workflow.indexOf("Checkout installed DarkFactory fix cycle");
  const token = workflow.indexOf("Mint mp-agents installation token");

  assert.notEqual(gate, -1);
  assert.notEqual(checkout, -1);
  assert.notEqual(token, -1);
  assert.ok(gate < token);
  assert.ok(checkout < token);
  assert.match(workflow, /^\s+schedule:\s*$/m);
  assert.match(workflow, /^\s+workflow_dispatch:\s*$/m);
  assert.match(workflow, /github\.repository == 'marius-patrik\/DarkFactory'/);
  assert.match(workflow, /GITHUB_REPOSITORY/);
  assert.match(workflow, /GITHUB_REF.*refs\/heads\/main/);
  assert.match(workflow, /Manual runs must use --ref main/);
  assert.match(workflow, /actions:\s+write/);
  assert.match(workflow, /permission-contents:\s+write/);
  assert.match(workflow, /permission-issues:\s+write/);
  assert.match(workflow, /permission-pull-requests:\s+write/);
  assert.doesNotMatch(workflow, /^\s+workflows:\s+write\s*$/m);
  assert.match(workflow, /permission-actions:\s+write/);
  assert.match(workflow, /permission-workflows:\s+write/);
  assert.doesNotMatch(workflow, /CODEX_AUTH_JSON/);
  assert.doesNotMatch(workflow, /docker|DF_WORKER_IMAGE/);
  assert.match(workflow, /path:\s+darkfactory-control/);
  assert.match(workflow, /ref:\s+main/);
  assert.match(workflow, /darkfactory-control\/\.github\/scripts\/df-fix\.mjs/);
});

test("df-fix is deterministic and routes red worker PR recovery through the orchestrator", async () => {
  const source = await readFile(new URL("../.github/scripts/df-fix.mjs", import.meta.url), "utf8");

  assert.match(source, /listActiveManagedRepos\(gh, controlRepo, \{ root: CONTROL_ROOT \}\)/);
  assert.match(source, /isDarkFactoryWorkerPullRequest/);
  assert.match(source, /df:fix-round:/);
  assert.match(source, /df:ask-owner/);
  assert.match(source, /df-fix-revision/);
  assert.match(source, /\/actions\/workflows\/df-orchestrate\.yml\/dispatches/);
  assert.match(source, /source_event: "df-fix"/);
  assert.doesNotMatch(source, /\/actions\/workflows\/df-work\.yml\/dispatches/);
  assert.doesNotMatch(source, /\["df:ready"\]/);
  assert.match(source, /pageInfo/);
  assert.match(source, /hasNextPage/);
  assert.match(source, /while \(cursor\)/);
  assert.match(source, /deleteHeadBranch/);
  assert.match(source, /error\.status === 404 \|\| error\.status === 422/);
  assert.match(source, /closeSupersededPullRequest/);
  assert.match(source, /const freshPull = await getPullRequestForFix/);
  assert.match(source, /checksAreGreen\(freshPull\.statusCheckRollup, requiredContexts\)/);
  assert.match(source, /reason: "checks-green"/);
  assert.doesNotMatch(source, /--admin/);
  assert.doesNotMatch(source, /danger-full-access/);
  assert.doesNotMatch(source, /mergeGreenPullRequest|getMergeBranchProtectionState|enableAutoMerge|enablePullRequestAutoMerge/i);
  assert.doesNotMatch(source, /merge_method|\/pulls\/\$\{[^}]+\}\/merge|action: "merge"|enable-automerge/i);
  assert.doesNotMatch(source, /\bcodex\s+exec\b|CODEX_AUTH_JSON|DF_WORKER_IMAGE|codex-home|runCodex|writeCodexAuth|docker\s+run/);
});

test("df-work merge-policy preflight blocks absent or unreadable protection", async () => {
  const repository = { owner: "marius-patrik", repo: "example" };
  const unreadablePolicy = await preflightMergePolicy(
    {
      request: async () => {
        const error: Error & { status?: number } = new Error("Resource not accessible by integration");
        error.status = 403;
        throw error;
      }
    },
    repository,
    "dev",
    { allow_auto_merge: true }
  );

  assert.equal(unreadablePolicy.blocked, true);
  assert.equal(unreadablePolicy.useAutomerge, false);
  assert.equal(unreadablePolicy.autoMergeSupported, true);
  assert.equal(unreadablePolicy.branchProtection.configured, false);
  assert.match(unreadablePolicy.summary, /missing, inaccessible, or incomplete/);
  assert.match(unreadablePolicy.reason, /HTTP 403/);

  const protectedPolicy = await preflightMergePolicy(
    {
      request: async () => managedProtection()
    },
    repository,
    "dev",
    { allow_auto_merge: true }
  );

  assert.equal(protectedPolicy.blocked, false);
  assert.equal(protectedPolicy.useAutomerge, true);
  assert.equal(protectedPolicy.branchProtection.configured, true);
});

test("df-work merge-policy preflight blocks protected branches when target auto-merge is disabled", async () => {
  const repository = { owner: "marius-patrik", repo: "example" };
  const policy = await preflightMergePolicy(
    {
      request: async () => managedProtection()
    },
    repository,
    "dev",
    { allow_auto_merge: false }
  );

  assert.equal(policy.blocked, true);
  assert.equal(policy.useAutomerge, false);
  assert.equal(policy.autoMergeSupported, false);
  assert.match(policy.summary, /auto-merge is disabled/);
  assert.match(policy.reason, /requires GitHub auto-merge before dispatching a worker/);
});

test("df-work merge-policy preflight blocks protection without exact app-bound gates", async () => {
  const repository = { owner: "marius-patrik", repo: "example" };
  const policy = await preflightMergePolicy(
    {
      request: async (method: string, pathName: string) => {
        if (method === "GET" && pathName.endsWith("/protection")) {
          return { required_status_checks: null };
        }
        throw new Error(`unexpected mocked request: ${method} ${pathName}`);
      }
    },
    repository,
    "dev",
    { allow_auto_merge: false }
  );

  assert.equal(policy.blocked, true);
  assert.equal(policy.useAutomerge, false);
  assert.equal(policy.autoMergeSupported, false);
  assert.deepEqual(policy.requiredChecks, []);
  assert.match(policy.summary, /missing, inaccessible, or incomplete/);
  assert.match(policy.reason, /required status checks are missing/);
});

test("df-work blocks target auto-merge setup failures before clone or Agent OS worker", async () => {
  const source = await readFile(new URL("../.github/scripts/df-work.mjs", import.meta.url), "utf8");

  const blockIndex = source.indexOf("if (mergePolicy.blocked)");
  const cloneIndex = source.indexOf("await cloneRepository");
  const workerIndex = source.indexOf("await runAgentWorker");
  assert.notEqual(blockIndex, -1);
  assert.notEqual(cloneIndex, -1);
  assert.notEqual(workerIndex, -1);
  assert.ok(blockIndex < cloneIndex);
  assert.ok(blockIndex < workerIndex);
  assert.match(source, /before cloning or running/);
  assert.match(source, /not a code implementation failure/);
});

test("df-work delegates local model execution exclusively to canonical Agent OS state", async () => {
  const workflow = await readFile(new URL("../.github/workflows/df-work.yml", import.meta.url), "utf8");
  const source = await readFile(new URL("../.github/scripts/df-work.mjs", import.meta.url), "utf8");
  const modelTurnSource = await readFile(new URL("../src/model-turn.ts", import.meta.url), "utf8");
  const modelPolicySource = await readFile(new URL("../.github/scripts/df-model-policy.mjs", import.meta.url), "utf8");

  assert.match(workflow, /runs-on: \[self-hosted, df-local\]/);
  assert.match(workflow, /pwsh -NoLogo -NoProfile -File \$agentsLauncher state doctor --json/);
  assert.doesNotMatch(workflow, /CODEX_AUTH_JSON|KIMI_AUTH_JSON|AGY_AUTH_JSON/);
  assert.match(source, /executeModelTurn/);
  assert.match(source, /profile\/implementer/);
  assert.match(modelTurnSource, /adapters\.agentRunArguments/);
  assert.match(modelPolicySource, /"--model-tier"/);
  assert.match(modelPolicySource, /"--effort"/);
  assert.doesNotMatch(`${source}\n${modelTurnSource}\n${modelPolicySource}`, /["']--provider["']|["']--model["']|runWithFailover|loadProviderRegistry/);
  assert.match(source, /validateAgentExecutionReceipt/);
  assert.match(modelTurnSource, /AGENT_PROCESS_ENVIRONMENT_ALLOWLIST/);
  assert.match(source, /agentProcessEnvironment\(process\.env\)/);
  assert.doesNotMatch(source, /df-task-brief|df-worker-summary|writeTaskBrief/);
});

test("df-work runs every Windows worker script through native PowerShell", async () => {
  const workflow = await readFile(new URL("../.github/workflows/df-work.yml", import.meta.url), "utf8");
  const parsed = loadYaml(workflow);
  const job = parsed.jobs["df-work"];
  const runSteps = job.steps.filter((step: any) => typeof step.run === "string");

  assert.deepEqual(job["runs-on"], ["self-hosted", "df-local"]);
  assert.equal(job.defaults.run.shell, "pwsh");
  assert.deepEqual(runSteps.map((step: any) => step.name), [
    "Validate trusted control ref",
    "Verify canonical Agent OS",
    "Run worker",
    "Record verification target"
  ]);
  assert.ok(runSteps.every((step: any) => step.shell === undefined));
});

test("df-work Windows bootstrap avoids POSIX shell and path assumptions", async () => {
  const workflow = await readFile(new URL("../.github/workflows/df-work.yml", import.meta.url), "utf8");

  assert.doesNotMatch(workflow, /\b(?:bash|sh)\b/i);
  assert.doesNotMatch(workflow, /\[\[|command -v|mkdir -p|cygpath|wslpath/);
  assert.match(workflow, /New-Item -ItemType Directory -Path \.darkfactory-verification -Force/);
  assert.match(workflow, /node --experimental-strip-types darkfactory-control\/\.github\/scripts\/df-work\.mjs/);
});

test("df-work native gate remains fail closed before checkout and worker execution", async () => {
  const workflow = await readFile(new URL("../.github/workflows/df-work.yml", import.meta.url), "utf8");
  const parsed = loadYaml(workflow);
  const steps = parsed.jobs["df-work"].steps;
  const gate = steps.find((step: any) => step.name === "Validate trusted control ref").run;
  const agentOs = steps.find((step: any) => step.name === "Verify canonical Agent OS").run;
  const verificationTarget = steps.find((step: any) => step.name === "Record verification target").run;

  assert.match(gate, /\$env:GITHUB_REPOSITORY_OWNER -ne "marius-patrik"/);
  assert.match(gate, /\$env:GITHUB_EVENT_NAME -eq "workflow_dispatch" -and \$env:GITHUB_REF -ne "refs\/heads\/main"/);
  assert.equal((gate.match(/exit 1/g) ?? []).length, 2);
  assert.match(agentOs, /\[string\]::IsNullOrWhiteSpace\(\$env:AGENTS_HOME\)/);
  assert.match(agentOs, /\[System\.IO\.Path\]::IsPathFullyQualified\(\$env:AGENTS_HOME\)/);
  assert.match(agentOs, /Join-Path -Path \$env:AGENTS_HOME -ChildPath "bin\\agents\.ps1"/);
  assert.match(agentOs, /Test-Path -LiteralPath \$agentsLauncher -PathType Leaf/);
  assert.equal((agentOs.match(/exit 1/g) ?? []).length, 3);
  assert.match(agentOs, /pwsh -NoLogo -NoProfile -File \$agentsLauncher state doctor --json/);
  assert.doesNotMatch(agentOs, /&\s+\$agentsLauncher/);
  assert.match(agentOs, /if \(\$LASTEXITCODE -ne 0\)\s*\{\s*exit \$LASTEXITCODE/);
  assert.match(verificationTarget, /node -e/);
  assert.match(verificationTarget, /if \(\$LASTEXITCODE -ne 0\)\s*\{\s*exit \$LASTEXITCODE/);
  assert.ok(workflow.indexOf("Validate trusted control ref") < workflow.indexOf("Checkout installed DarkFactory worker"));
  assert.ok(workflow.indexOf("Verify canonical Agent OS") < workflow.indexOf("Run worker"));
});

test("df-work binds Agent OS execution to the canonical launcher", async () => {
  const source = await readFile(new URL("../.github/scripts/df-work.mjs", import.meta.url), "utf8");
  const modelTurnSource = await readFile(new URL("../src/model-turn.ts", import.meta.url), "utf8");

  assert.match(source, /const agentsHome = requiredEnv\("AGENTS_HOME"\)/);
  assert.match(source, /if \(!path\.isAbsolute\(agentsHome\)\)/);
  assert.match(source, /const agentsLauncher = path\.join\(agentsHome, "bin", "agents\.ps1"\)/);
  assert.match(source, /runAgentCommand\(\["state", "doctor", "--json"\], CONTROL_ROOT\)/);
  assert.match(source, /executeModelTurn/);
  assert.match(modelTurnSource, /adapters\.agentRunArguments/);
  assert.match(modelTurnSource, /canonicalLauncher\(environment\)/);
  assert.match(source, /if \(!existsSync\(agentsLauncher\)\)/);
  assert.match(source, /\["-NoLogo", "-NoProfile", "-File", agentsLauncher, \.\.\.args\]/);
  assert.ok(source.indexOf("canonicalAgentsLauncher();") < source.indexOf("await getIssue"));
});

test("df-work never falls back to a PATH-selected agents executable", async () => {
  const workflow = await readFile(new URL("../.github/workflows/df-work.yml", import.meta.url), "utf8");
  const source = await readFile(new URL("../.github/scripts/df-work.mjs", import.meta.url), "utf8");

  assert.doesNotMatch(workflow, /Get-Command\s+agents|^\s*agents\s+/m);
  assert.doesNotMatch(source, /runCommand\("agents"|spawnSync\("agents"/);
  assert.doesNotMatch(source, /Get-Command|command -v|\.bun[\\/]install[\\/]global/);
});

test("df-work failure path comments blocker, marks blocked, and releases the lane", async () => {
  const source = await readFile(new URL("../.github/scripts/df-work.mjs", import.meta.url), "utf8");

  assert.match(source, /ledger\.status = "blocked"/);
  assert.match(source, /markWorkerBlocked\(TARGET_REPO, TARGET_ISSUE_NUMBER, ledger\.error\)/);
  assert.match(source, /function markWorkerBlocked\(repository, issueNumber, blocker\)/);
  assert.match(source, /Removing df:running releases the stream lane/);
  assert.match(source, /replaceIssueLabels\(repository, issueNumber, \["df:blocked"\], \["df:ready", "df:running", "df:done"\]\)/);
  assert.match(source, /DarkFactory worker blocked\./);
  assert.match(source, /Blocker:/);
  assert.match(source, /truncate\(blocker, 6000\)/);
});

test("df-work workflow does not expose privileged worker triggers in managed repositories", async () => {
  const workflow = await readFile(new URL("../.github/workflows/df-work.yml", import.meta.url), "utf8");

  assert.doesNotMatch(workflow, /^  issues:/m);
  assert.doesNotMatch(workflow, /^  issue_comment:/m);
  assert.doesNotMatch(workflow, /author_association/);
  assert.match(workflow, /github\.repository == 'marius-patrik\/DarkFactory'/);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch'/);
});

test("df-work workflow restricts privileged workers to the control repository", async () => {
  const workflow = await readFile(new URL("../.github/workflows/df-work.yml", import.meta.url), "utf8");

  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /github\.repository == 'marius-patrik\/DarkFactory'/);
  assert.doesNotMatch(workflow, /inputs\.repo == github\.repository/);
  assert.match(workflow, /if:\s*github\.event_name == 'workflow_dispatch'/);
  assert.match(workflow, /concurrency:\s*$/m);
  assert.match(workflow, /group:\s+df-work-\$\{\{ inputs\.repo \}\}-\$\{\{ inputs\.issue_number \}\}/);
  assert.match(workflow, /cancel-in-progress:\s+false/);
});

test("df-work workflow uses the installed control worker payload", async () => {
  const workflow = await readFile(new URL("../.github/workflows/df-work.yml", import.meta.url), "utf8");

  assert.match(workflow, /Checkout installed DarkFactory worker/);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /darkfactory-control\/\.github\/scripts\/df-work\.mjs/);
  assert.doesNotMatch(workflow, /raw\.githubusercontent\.com|commits\/main/);
});

test("df-work workflow uses the app token for control-dispatched workers", async () => {
  const workflow = await readFile(new URL("../.github/workflows/df-work.yml", import.meta.url), "utf8");
  const source = await readFile(new URL("../.github/scripts/df-work.mjs", import.meta.url), "utf8");

  assert.match(workflow, /if:\s*github\.event_name == 'workflow_dispatch'/);
  assert.match(workflow, /DARK_FACTORY_TOKEN: \$\{\{ steps\.app-token\.outputs\.token \}\}/);
  assert.match(workflow, /permission-contents:\s+write/);
  assert.match(workflow, /permission-issues:\s+write/);
  assert.match(workflow, /permission-pull-requests:\s+write/);
  assert.match(workflow, /permission-workflows:\s+write/);
  assert.doesNotMatch(workflow, /steps\.app-token\.outputs\.token \|\| github\.token/);
  assert.match(workflow, /DF_TARGET_REPO: \$\{\{ inputs\.repo \}\}/);
  assert.match(workflow, /DF_TARGET_ISSUE_NUMBER: \$\{\{ inputs\.issue_number \}\}/);
  assert.match(workflow, /base_ref:/);
  assert.match(workflow, /DF_TARGET_BASE_REF: \$\{\{ inputs\.base_ref \}\}/);
  assert.match(source, /const TOKEN = requiredEnv\("DARK_FACTORY_TOKEN"\)/);
  assert.match(source, /const TARGET_BASE_REF = process\.env\.DF_TARGET_BASE_REF/);
  assert.match(source, /resolveWorkBaseBranch\(TARGET_REPO, repo\.default_branch, TARGET_BASE_REF\)/);
  assert.match(source, /\/git\/ref\/heads\/\$\{encodeRefPath\(branch\)\}/);
  assert.match(source, /split\("\/"\)\.map\(encodeURIComponent\)\.join\("\/"\)/);
  assert.match(source, /runGit\(\["push", "origin", `HEAD:refs\/heads\/\$\{branch\}`\], worktree\)/);
  assert.match(source, /function runGit\(args, cwd\) \{\s+return runGitWithAuth\(args, cwd\);/);
  assert.match(source, /function runGitWithAuth\(args, cwd\) \{\s+return runCommand\("git", \["-c", authHeader\(\), \.\.\.args\], cwd\);/);
});

test("df-fix selects only red worker PRs from active repositories", async () => {
  const activeRepository = { owner: "marius-patrik", repo: "active" };
  const parkedRepository = { owner: "marius-patrik", repo: "skyblock-agent" };
  const candidates = [
    { repository: activeRepository, pull: workerPull({ number: 10, checkConclusion: "FAILURE" }) },
    { repository: activeRepository, pull: workerPull({ number: 11, checkConclusion: "SUCCESS" }) },
    { repository: activeRepository, pull: { ...workerPull({ number: 12, checkConclusion: "FAILURE" }), author: { __typename: "User", login: "marius-patrik" } } },
    { repository: parkedRepository, pull: workerPull({ number: 13, checkConclusion: "FAILURE" }) }
  ];

  const fixable = candidates
    .map(({ repository, pull }) => ({ repository, result: classifyFixCandidate(pull, repository, ["Validate"], { maxRounds: 3 }) }))
    .filter(({ result }) => result.action === "fix")
    .map(({ repository, result }) => `${repoName(repository)}:${result.pr}`);

  assert.deepEqual(fixable, ["marius-patrik/active:marius-patrik/active#10"]);
});

test("df-fix posts a trusted revision request, closes the red PR, deletes the branch, and requests orchestrator re-evaluation", async () => {
  const controlRepo = { owner: "marius-patrik", repo: "DarkFactory" };
  const repository = { owner: "marius-patrik", repo: "active" };
  const pull = workerPull({ number: 10, checkConclusion: "FAILURE" });
  const calls: Array<{ method: string; pathName: string; body?: any }> = [];
  const gh = {
    graphql: async () => ({
      repository: {
        pullRequest: {
          ...pull,
          mergeable: "MERGEABLE",
          url: "https://github.com/marius-patrik/active/pull/10",
          statusCheckRollup: { contexts: { nodes: pull.statusCheckRollup } }
        }
      }
    }),
    request: async (method: string, pathName: string, body?: any) => {
      calls.push({ method, pathName, body });
      if (method === "GET" && pathName === "/repos/marius-patrik/active/issues/10") {
        return { data: { number: 10, body: "Issue body", labels: [] } };
      }
      if (method === "GET" && pathName === "/repos/marius-patrik/active/issues/10/comments?per_page=100") {
        return {
          data: [
            {
              body: [
                "<!-- darkfactory-autoreview -->",
                "### Blocking Findings",
                "- fix the trust boundary"
              ].join("\n"),
              updated_at: "2026-07-05T00:00:00Z"
            }
          ]
        };
      }
      if (method === "POST" && pathName === "/repos/marius-patrik/active/labels") return {};
      if (method === "POST" && pathName === "/repos/marius-patrik/active/issues/10/labels") return {};
      if (method === "DELETE" && pathName.startsWith("/repos/marius-patrik/active/issues/10/labels/")) return {};
      if (method === "POST" && pathName === "/repos/marius-patrik/active/issues/10/comments") return {};
      if (method === "PATCH" && pathName === "/repos/marius-patrik/active/pulls/10") return {};
      if (method === "DELETE" && pathName === "/repos/marius-patrik/active/git/refs/heads/df/10-worker") return {};
      if (method === "POST" && pathName === "/repos/marius-patrik/DarkFactory/actions/workflows/df-orchestrate.yml/dispatches") return {};
      throw new Error(`unexpected mocked request: ${method} ${pathName}`);
    }
  };

  assert.equal(
    fixTrustFailure(pull, { ...pull, headRepository: { owner: { login: "other-owner" }, name: "active" } }, repository),
    "head-repository-changed"
  );

  const result = await fixPullRequestByRedispatch(
    gh,
    controlRepo,
    repository,
    pull,
    { action: "fix", reason: "checks-failing", round: 1, maxRounds: 3 },
    ["Validate"],
    { maxRounds: 3, token: "token" }
  );

  assert.equal(result.action, "reevaluate");
  assert.equal(result.round, 1);
  assert.ok(calls.some((call) => call.method === "POST" && call.pathName === "/repos/marius-patrik/active/issues/10/comments" && call.body.body.includes("<!-- df-fix-revision -->")));
  assert.ok(calls.some((call) => call.method === "PATCH" && call.pathName === "/repos/marius-patrik/active/pulls/10" && call.body.state === "closed"));
  assert.ok(calls.some((call) => call.method === "DELETE" && call.pathName === "/repos/marius-patrik/active/git/refs/heads/df/10-worker"));
  assert.equal(calls.some((call) => call.method === "POST" && call.pathName.endsWith("/df-work.yml/dispatches")), false);
  assert.equal(calls.some((call) => call.method === "POST" && call.pathName === "/repos/marius-patrik/active/issues/10/labels" && call.body.labels?.includes("df:ready")), false);
  assert.ok(calls.some((call) => call.method === "POST" && call.pathName === "/repos/marius-patrik/DarkFactory/actions/workflows/df-orchestrate.yml/dispatches" && call.body.inputs.repo === "marius-patrik/active" && call.body.inputs.issue_number === "10" && call.body.inputs.source_event === "df-fix"));
});

test("df-fix does not close, delete, or redispatch when the fresh PR head trust check fails", async () => {
  const controlRepo = { owner: "marius-patrik", repo: "DarkFactory" };
  const repository = { owner: "marius-patrik", repo: "active" };
  const pull = workerPull({ number: 15, checkConclusion: "FAILURE" });
  const calls: Array<{ method: string; pathName: string; body?: any }> = [];
  const gh = {
    graphql: async () => ({
      repository: {
        pullRequest: {
          ...pull,
          headRepository: { owner: { login: "other-owner" }, name: "active" },
          mergeable: "MERGEABLE",
          url: "https://github.com/marius-patrik/active/pull/15",
          statusCheckRollup: { contexts: { nodes: pull.statusCheckRollup } }
        }
      }
    }),
    request: async (method: string, pathName: string, body?: any) => {
      calls.push({ method, pathName, body });
      if (method === "GET" && pathName === "/repos/marius-patrik/active/issues/15") {
        return { data: { number: 15, body: "", labels: [] } };
      }
      if (method === "GET" && pathName === "/repos/marius-patrik/active/issues/15/comments?per_page=100") return { data: [] };
      throw new Error(`unexpected mocked request: ${method} ${pathName}`);
    }
  };

  const result = await fixPullRequestByRedispatch(
    gh,
    controlRepo,
    repository,
    pull,
    { action: "fix", reason: "checks-failing", round: 1, maxRounds: 3 },
    ["Validate"],
    { maxRounds: 3, token: "token" }
  );

  assert.equal(result.action, "skip");
  assert.equal(result.reason, "fix-trust-failed");
  assert.equal(result.trust_failure, "head-repository-changed");
  assert.equal(calls.some((call) => call.method === "PATCH" && call.pathName === "/repos/marius-patrik/active/pulls/15"), false);
  assert.equal(calls.some((call) => call.method === "DELETE" && call.pathName.includes("/git/refs/heads/")), false);
  assert.equal(calls.some((call) => call.pathName.includes("df-work.yml/dispatches")), false);
});

test("df-fix round cap escalates instead of looping forever", () => {
  const repository = { owner: "marius-patrik", repo: "active" };
  const roundTwo = classifyFixCandidate(
    workerPull({ number: 20, checkConclusion: "FAILURE", labels: [{ name: "df:fix-round:2" }] }),
    repository,
    ["Validate"],
    { maxRounds: 3 }
  );
  const roundThree = classifyFixCandidate(
    workerPull({ number: 21, checkConclusion: "FAILURE", labels: [{ name: "df:fix-round:3" }] }),
    repository,
    ["Validate"],
    { maxRounds: 3 }
  );

  assert.equal(parseFixRound([{ name: "df:fix-round:2" }], "<!-- df:fix-round:1 -->"), 2);
  assert.equal(roundTwo.action, "fix");
  assert.equal(roundTwo.round, 3);
  assert.equal(roundThree.action, "escalate");
  assert.equal(roundThree.reason, "max-rounds");
});

test("df-fix round cap adds df:ask-owner and does not redispatch", async () => {
  const controlRepo = { owner: "marius-patrik", repo: "DarkFactory" };
  const repository = { owner: "marius-patrik", repo: "active" };
  const pull = workerPull({ number: 20, checkConclusion: "FAILURE" });
  const calls: Array<{ method: string; pathName: string; body?: any }> = [];
  const gh = {
    request: async (method: string, pathName: string, body?: any) => {
      calls.push({ method, pathName, body });
      if (method === "GET" && pathName === "/repos/marius-patrik/active/issues/20") {
        return { data: { number: 20, body: "", labels: [{ name: "df:fix-round:3" }] } };
      }
      if (method === "GET" && pathName === "/repos/marius-patrik/active/issues/20/comments?per_page=100") return { data: [] };
      if (method === "POST" && pathName === "/repos/marius-patrik/active/labels") return {};
      if (method === "POST" && pathName === "/repos/marius-patrik/active/issues/20/labels") return {};
      if (method === "POST" && pathName === "/repos/marius-patrik/active/issues/20/comments") return {};
      throw new Error(`unexpected mocked request: ${method} ${pathName}`);
    }
  };

  const result = await fixPullRequestByRedispatch(
    gh,
    controlRepo,
    repository,
    pull,
    { action: "fix", reason: "checks-failing", round: 1, maxRounds: 3 },
    ["Validate"],
    { maxRounds: 3, token: "token" }
  );

  assert.equal(result.action, "escalate");
  assert.ok(calls.some((call) => call.method === "POST" && call.pathName === "/repos/marius-patrik/active/issues/20/labels" && call.body.labels.includes("df:ask-owner")));
  assert.equal(calls.some((call) => call.pathName.includes("df-work.yml/dispatches")), false);
  assert.equal(calls.some((call) => call.method === "PATCH" && call.pathName === "/repos/marius-patrik/active/pulls/20"), false);
});

test("df-fix skips all-green PRs and fixes red PRs", () => {
  const repository = { owner: "marius-patrik", repo: "active" };
  const green = classifyFixCandidate(workerPull({ number: 30, checkConclusion: "SUCCESS" }), repository, ["Validate"]);
  const red = classifyFixCandidate(workerPull({ number: 31, checkConclusion: "FAILURE" }), repository, ["Validate"]);
  const pending = classifyFixCandidate(
    workerPull({ number: 32, checkStatus: "IN_PROGRESS", checkConclusion: null }),
    repository,
    ["Validate"]
  );

  assert.equal(green.action, "skip");
  assert.equal(green.reason, "checks-green");
  assert.equal(red.action, "fix");
  assert.equal(pending.action, "skip");
  assert.equal(pending.reason, "checks-pending");
});

test("df-sweep waits before treating empty check rollups as no-checks-configured", async () => {
  const source = await readFile(new URL("../.github/scripts/df-sweep.mjs", import.meta.url), "utf8");

  assert.match(source, /EMPTY_CHECK_SETTLE_MS/);
  assert.match(source, /emptyCheckRollupHasSettled\(pull\)/);
  assert.match(source, /checks-not-reported-yet/);
});

test("df-sweep verifies branch protection before merging empty check rollups", async () => {
  const source = await readFile(new URL("../.github/scripts/df-sweep.mjs", import.meta.url), "utf8");

  assert.match(source, /getBranchProtection/);
  assert.match(source, /inspectManagedBranchProtection/);
  assert.match(source, /required_checks/);
  assert.match(source, /required-checks-missing/);
  assert.match(source, /checksAreGreen\(pull\.statusCheckRollup, requiredContexts\)/);
});

test("df-sweep re-fetches checks immediately before direct merge and blocks red or pending checks", async () => {
  const source = await readFile(new URL("../.github/scripts/df-sweep.mjs", import.meta.url), "utf8");
  const gateIndex = source.indexOf("const mergeGate = await getPullRequestMergeGate");
  const mergeIndex = source.indexOf("await mergePullRequest(repository, mergeGate)");

  assert.notEqual(gateIndex, -1);
  assert.notEqual(mergeIndex, -1);
  assert.ok(gateIndex < mergeIndex);
  assert.match(source, /getPullRequestMergeGate/);
  assert.match(source, /statusCheckRollup/);
  assert.match(source, /merge-checks-not-green/);
  assert.match(source, /hasMergeGateChecks/);
  assert.doesNotMatch(source, /NO_CHECK_ALLOWLIST|DF_ALLOW_NO_CHECK_REPOS/);
  assert.match(source, /Fresh merge gate check failed immediately before merge/);
  assert.match(source, /checksAreGreen\(mergeGate\.statusCheckRollup, requiredContexts\)/);
  assert.doesNotMatch(source, /--admin/);
});

test("DarkFactory Autoreview workflow binds the exact gate to trusted Agent OS execution", async () => {
  const workflow = await readFile(new URL("../.github/workflows/darkfactory-autoreview.yml", import.meta.url), "utf8");
  const parsedWorkflow = loadYaml(workflow);
  const job = parsedWorkflow.jobs["darkfactory-autoreview"];

  assert.equal(parsedWorkflow.name, AUTOREVIEW_REQUIRED_CONTEXT);
  assert.equal(job.name, AUTOREVIEW_REQUIRED_CONTEXT);
  assert.deepEqual(job["runs-on"], ["self-hosted", "df-local"]);
  assert.match(workflow, /pull_request_target:/);
  assert.match(workflow, /repository: marius-patrik\/DarkFactory/);
  assert.match(workflow, /ref: main/);
  assert.match(workflow, /DF_CONTROL_REVISION: \$\{\{ steps\.control\.outputs\.revision \}\}/);
  assert.match(workflow, /bin\\agents\.ps1/);
  assert.match(workflow, /state doctor --json/);
  assert.doesNotMatch(workflow, /CODEX_AUTH_JSON|KIMI_AUTH_JSON|codex exec|kimi|claude|agy/);
});

test("DarkFactory Autoreview never checks out or executes the untrusted PR head", async () => {
  const workflow = await readFile(new URL("../.github/workflows/darkfactory-autoreview.yml", import.meta.url), "utf8");
  const runner = await readFile(new URL("../.github/scripts/run-darkfactory-autoreview.mjs", import.meta.url), "utf8");

  assert.match(workflow, /Checkout protected DarkFactory control runtime/);
  assert.match(workflow, /repository: marius-patrik\/DarkFactory/);
  assert.match(workflow, /ref: main/);
  assert.match(workflow, /rev-parse HEAD/);
  assert.doesNotMatch(workflow, /Checkout PR head|docker build|docker run/);
  assert.match(runner, /executionPolicy: "read-only"/);
  assert.match(runner, /executeModelTurn/);
  assert.match(runner, /validationCommandsForRepository/);
  assert.match(runner, /core\.hooksPath/);
  assert.match(runner, /--no-ext-diff/);
  assert.match(runner, /Autoreview requires a protected main or dev base/);
  assert.match(runner, /TextDecoder\("utf-8", \{ fatal: true \}\)/);
  assert.doesNotMatch(runner, /npm test|npm run|bun test|dangerously-bypass|--force-with-lease|\["push"[^\]]*"--force"/);
});

test("DarkFactory Autoreview applies only hash-bound proposals after fresh target checks", async () => {
  const runner = await readFile(new URL("../.github/scripts/run-darkfactory-autoreview.mjs", import.meta.url), "utf8");
  const protocol = await readFile(new URL("../.github/scripts/df-autoreview.mjs", import.meta.url), "utf8");

  assert.match(runner, /validateAutofixProposal/);
  assert.match(runner, /immediately before autofix push/);
  assert.match(runner, /same-repository pull request head/);
  assert.match(protocol, /existing test file/);
  assert.match(protocol, /protected path/);
  assert.match(protocol, /receipt_persistence_failed/);
  assert.match(protocol, /case-collides path/);
});

test("DarkFactory Autoreview supports explicit issue review and only auditable owner override", async () => {
  const workflow = await readFile(new URL("../.github/workflows/darkfactory-autoreview.yml", import.meta.url), "utf8");
  const runner = await readFile(new URL("../.github/scripts/run-darkfactory-autoreview.mjs", import.meta.url), "utf8");

  assert.match(workflow, /target_kind:/);
  assert.match(workflow, /owner_override_comment:/);
  assert.match(runner, /\/df autoreview override/);
  assert.match(runner, /comment\.author_association !== "OWNER"/);
  assert.match(runner, /owner-text-history/);
  assert.match(runner, /Issue changed immediately before autofix publication/);
  assert.match(runner, /renderIssueAutofixComment/);
  assert.doesNotMatch(runner, /"PATCH", `\/repos\/\$\{repoName\(repository\)\}\/issues\/\$\{number\}`/);
});

test("df-sweep has no no-check direct-merge escape", async () => {
  const source = await readFile(new URL("../.github/scripts/df-sweep.mjs", import.meta.url), "utf8");

  assert.doesNotMatch(source, /DF_ALLOW_NO_CHECK_REPOS|NO_CHECK_ALLOWLIST|no-checks-not-allowed/);
  assert.match(source, /merge-policy-blocked/);
});

test("df-sweep filters explicit sweep repositories through lifecycle and GitHub writability", async () => {
  const source = await readFile(new URL("../.github/scripts/df-sweep.mjs", import.meta.url), "utf8");

  assert.doesNotMatch(source, /if \(configured\.length\) return configured/);
  assert.match(source, /filterConfiguredActiveManagedRepos\(configured\)/);
  assert.match(source, /readManagedRepoRegistry/);
  assert.match(source, /managedRepoLifecycleState/);
  assert.match(source, /getRepository\(gh, repository\)/);
  assert.match(source, /repo\.archived === true \|\| repo\.disabled === true/);
});

test("df-sweep considers default-branch worker PRs when no explicit work branch is configured", async () => {
  const source = await readFile(new URL("../.github/scripts/df-sweep.mjs", import.meta.url), "utf8");

  assert.match(source, /const WORK_BRANCH = process\.env\.DF_WORK_BRANCH \|\| ""/);
  assert.match(source, /const baseBranches = await sweepBaseBranches\(repository\)/);
  assert.match(source, /getRepository\(gh, repository\)/);
  assert.match(source, /new Set\(\["dev", repo\.default_branch\]\.filter\(Boolean\)\)/);
  assert.match(source, /baseBranches\.has\(pull\.baseRefName\)/);
});

test("df-work no-ops instead of blocking when an open worker PR already exists", async () => {
  const source = await readFile(new URL("../.github/scripts/df-work.mjs", import.meta.url), "utf8");

  assert.match(source, /findOpenWorkerPullRequestForIssue\(gh, TARGET_REPO, TARGET_ISSUE_NUMBER\)/);
  assert.match(source, /action: "existing-worker-pr"/);
  assert.match(source, /result: "noop"/);
  assert.match(source, /replaceIssueLabels\(TARGET_REPO, TARGET_ISSUE_NUMBER, \["df:running"\], \["df:ready", "df:blocked", "df:done"\]\)/);
  assert.match(source, /No new worker run is needed; follow-through will evaluate the existing PR/);
});

test("df-work blocks stale remote branches without open worker PRs", async () => {
  const source = await readFile(new URL("../.github/scripts/df-work.mjs", import.meta.url), "utf8");

  const openPrIndex = source.indexOf("const existingPullRequest = await findOpenWorkerPullRequestForIssue(gh, TARGET_REPO, TARGET_ISSUE_NUMBER)");
  const remoteBranchIndex = source.indexOf("if (await remoteBranchExists(TARGET_REPO, branch))");

  assert.notEqual(openPrIndex, -1);
  assert.notEqual(remoteBranchIndex, -1);
  assert.ok(openPrIndex < remoteBranchIndex);
  assert.match(source, /action: "stale-worker-branch"/);
  assert.match(source, /result: "blocked"/);
  assert.match(source, /Stale worker branch exists without an open worker PR\. Owner\/manual recovery is required\./);
  assert.match(source, /upsertStaleBranchAskOwnerIssue\(branch\)/);
  assert.match(source, /replaceIssueLabels\(TARGET_REPO, TARGET_ISSUE_NUMBER, \["df:ask-owner", "df:blocked"\], \["df:ready", "df:running", "df:done"\]\)/);
  // Recovery issues are upserted in the CONTROL repository (central owner
  // queue), keyed by a marker that includes the target repo and issue.
  assert.match(source, /dark-factory:stale-worker-branch repo=\$\{repoName\(TARGET_REPO\)\} issue=\$\{TARGET_ISSUE_NUMBER\} branch=\$\{slug\(branch\)\}/);
  assert.match(source, /findOpenIssueByMarker\(CONTROL_REPO, marker\)/);
  assert.match(source, /gh\.request\("PATCH", `\/repos\/\$\{repoName\(CONTROL_REPO\)\}\/issues\/\$\{existing\.number\}`/);
  // The update path re-applies df:ask-owner so a recovery issue that lost the
  // label reappears on label-driven queues.
  assert.match(source, /gh\.request\("POST", `\/repos\/\$\{repoName\(CONTROL_REPO\)\}\/issues\/\$\{existing\.number\}\/labels`/);
  assert.match(source, /reason: "stale-worker-branch"/);
  assert.match(source, /no open worker PR was found/);
  assert.doesNotMatch(source, /action: "remote-branch-exists"/);
});

test("df-work independently revalidates one exact resume branch and head", async () => {
  const workflow = await readFile(new URL("../.github/workflows/df-work.yml", import.meta.url), "utf8");
  const source = await readFile(new URL("../.github/scripts/df-work.mjs", import.meta.url), "utf8");

  assert.match(workflow, /resume_head:/);
  assert.match(workflow, /DF_RESUME_HEAD:\s*\$\{\{ inputs\.resume_head \}\}/);
  assert.match(source, /classifyWorkerBranchRefs\(refs, issueNumber\)/);
  assert.match(source, /candidate\.branch !== RESUME_BRANCH \|\| candidate\.head !== RESUME_HEAD/);
  assert.match(source, /refs\/heads\/\$\{branch\}:\$\{remoteRef\}/);
  assert.match(source, /fetchedHead !== resumeInfo\.head/);
});

test("df-sweep does not skip green worker PRs solely because the issue is blocked", async () => {
  const source = await readFile(new URL("../.github/scripts/df-sweep.mjs", import.meta.url), "utf8");

  assert.doesNotMatch(source, /isWorkerIssueBlocked\(repository, issueNumber\)/);
  assert.doesNotMatch(source, /worker-issue-blocked/);
});

test("df-sweep arms automerge for green protected worker PRs and blocks red ones", async () => {
  const repository = { owner: "marius-patrik", repo: "active" };
  const green = workerPull({ number: 40, checkConclusion: "SUCCESS", author: "darkfactory-agent" });
  const red = workerPull({ number: 41, checkConclusion: "FAILURE", author: "darkfactory-agent" });
  const calls: Array<{ method: string; pathName: string; body?: any }> = [];

  configureSweepRuntime({
    controlRepo: { owner: "marius-patrik", repo: "DarkFactory" },
    dataRepo: "marius-patrik/agents-data",
    gh: {
      graphql: async (_query: string, variables: { number: number }) => ({
        repository: {
          pullRequest: {
            ...(variables.number === 40 ? green : red),
            id: `PR_${variables.number}`,
            mergeable: "MERGEABLE",
            statusCheckRollup: {
              contexts: {
                nodes: (variables.number === 40 ? green : red).statusCheckRollup
              }
            }
          }
        }
      }),
      request: async (method: string, pathName: string, body?: any) => {
        calls.push({ method, pathName, body });
        if (method === "GET" && pathName.endsWith("/protection")) {
          return managedProtection();
        }
        if (method === "GET" && pathName === "/repos/marius-patrik/active/issues/40") {
          return { labels: [{ name: "df:done" }] };
        }
        if (method === "GET" && pathName === "/repos/marius-patrik/active/issues/41") {
          return { labels: [] };
        }
        if (method === "GET" && /^\/repos\/marius-patrik\/active\/issues\/4[01]\/comments\?per_page=100$/.test(pathName)) {
          return [];
        }
        if (method === "PUT" && pathName === "/repos/marius-patrik/active/pulls/40/merge") {
          return { sha: "merged-sha" };
        }
        if (method === "POST" && pathName === "/repos/marius-patrik/active/issues/40/comments") return {};
        if (method === "PATCH" && pathName === "/repos/marius-patrik/active/issues/40") return {};
        if (method === "POST" && pathName === "/repos/marius-patrik/active/issues/41/labels") return {};
        if (method === "DELETE" && pathName.startsWith("/repos/marius-patrik/active/issues/41/labels/")) return {};
        if (method === "POST" && pathName === "/repos/marius-patrik/active/issues/41/comments") return {};
        throw new Error(`unexpected mocked request: ${method} ${pathName}`);
      }
    }
  });

  const greenResult = await considerSweepPullRequest(repository, green, { rules: [] });
  const redResult = await considerSweepPullRequest(repository, red, { rules: [] });

  assert.equal(greenResult.action, "enable-automerge");
  assert.equal(redResult.action, "skip");
  assert.equal(redResult.reason, "checks-not-green");
  assert.equal(calls.some((call) => call.method === "PUT" && call.pathName === "/repos/marius-patrik/active/pulls/40/merge"), false);
  assert.equal(calls.some((call) => call.method === "PUT" && call.pathName === "/repos/marius-patrik/active/pulls/41/merge"), false);
});

test("df-sweep holds worker PRs when the DarkFactory Autoreview context is present and red", async () => {
  const repository = { owner: "marius-patrik", repo: "active" };
  const pull = workerPull({
    number: 42,
    checkConclusion: "SUCCESS",
    autoreviewConclusion: "FAILURE",
    author: "darkfactory-agent"
  });
  const calls: Array<{ method: string; pathName: string; body?: any }> = [];

  configureSweepRuntime({
    controlRepo: { owner: "marius-patrik", repo: "DarkFactory" },
    dataRepo: "marius-patrik/agents-data",
    gh: {
      request: async (method: string, pathName: string, body?: any) => {
        calls.push({ method, pathName, body });
        if (method === "GET" && pathName.endsWith("/protection")) {
          return managedProtection();
        }
        if (method === "POST" && pathName === "/repos/marius-patrik/active/issues/42/labels") return {};
        if (method === "DELETE" && pathName.startsWith("/repos/marius-patrik/active/issues/42/labels/")) return {};
        if (method === "GET" && pathName === "/repos/marius-patrik/active/issues/42/comments?per_page=100") return [];
        if (method === "POST" && pathName === "/repos/marius-patrik/active/issues/42/comments") return {};
        throw new Error(`unexpected mocked request: ${method} ${pathName}`);
      }
    }
  });

  const result = await considerSweepPullRequest(repository, pull, { rules: [] });

  assert.equal(result.action, "skip");
  assert.equal(result.reason, "checks-not-green");
  assert.deepEqual(result.required_checks, ["Validate", "DarkFactory Autoreview"]);
  assert.equal(calls.some((call) => call.method === "PUT" && call.pathName === "/repos/marius-patrik/active/pulls/42/merge"), false);
  assert.equal(calls.some((call) => call.pathName.includes("managed-repository.json")), false);
});

test("df-sweep blocks when exact managed branch protection is not provisioned", async () => {
  const repository = { owner: "marius-patrik", repo: "active" };
  const pull = workerPull({
    number: 43,
    checkConclusion: "SUCCESS",
    includeAutoreview: false,
    author: "darkfactory-agent"
  });
  const calls: Array<{ method: string; pathName: string; body?: any }> = [];
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: any) => warnings.push(String(message));

  try {
    configureSweepRuntime({
      controlRepo: { owner: "marius-patrik", repo: "DarkFactory" },
      dataRepo: "marius-patrik/agents-data",
      gh: {
        graphql: async () => ({
          repository: {
            pullRequest: {
              ...pull,
              id: "PR_43",
              mergeable: "MERGEABLE",
              statusCheckRollup: { contexts: { nodes: pull.statusCheckRollup } }
            }
          }
        }),
        request: async (method: string, pathName: string, body?: any) => {
          calls.push({ method, pathName, body });
          if (method === "GET" && pathName.endsWith("/protection")) {
            const error: Error & { status?: number } = new Error("Branch not protected");
            error.status = 404;
            throw error;
          }
          if (method === "GET" && pathName.includes("/contents/.darkfactory/managed-repository.json")) {
            const error: Error & { status?: number } = new Error("Missing managed config");
            error.status = 404;
            throw error;
          }
          if (method === "GET" && pathName === "/repos/marius-patrik/active/issues/43") {
            return { labels: [{ name: "df:done" }] };
          }
          if (method === "PUT" && pathName === "/repos/marius-patrik/active/pulls/43/merge") {
            return { sha: "merged-without-autoreview-sha" };
          }
          if (method === "GET" && pathName === "/repos/marius-patrik/active/issues/43/comments?per_page=100") return [];
          if (method === "POST" && pathName === "/repos/marius-patrik/active/issues/43/labels") return {};
          if (method === "DELETE" && pathName.startsWith("/repos/marius-patrik/active/issues/43/labels/")) return {};
          if (method === "POST" && pathName === "/repos/marius-patrik/active/issues/43/comments") return {};
          if (method === "PATCH" && pathName === "/repos/marius-patrik/active/issues/43") return {};
          throw new Error(`unexpected mocked request: ${method} ${pathName}`);
        }
      }
    });

    const result = await considerSweepPullRequest(repository, pull);

    assert.equal(result.action, "skip");
    assert.equal(result.reason, "merge-policy-blocked");
    assert.equal(warnings.length, 0);
    assert.equal(calls.some((call) => call.method === "PUT" && call.pathName === "/repos/marius-patrik/active/pulls/43/merge"), false);
  } finally {
    console.warn = originalWarn;
  }
});

test("df-sweep holds worker PRs when managed config declares DarkFactory Autoreview but the context is absent", async () => {
  const repository = { owner: "marius-patrik", repo: "active" };
  const pull = workerPull({
    number: 44,
    checkConclusion: "SUCCESS",
    includeAutoreview: false,
    author: "darkfactory-agent"
  });
  const calls: Array<{ method: string; pathName: string; body?: any }> = [];
  const managedConfig = {
    schemaVersion: 1,
    requiredFiles: [".github/workflows/darkfactory-autoreview.yml"]
  };

  configureSweepRuntime({
    controlRepo: { owner: "marius-patrik", repo: "DarkFactory" },
    dataRepo: "marius-patrik/agents-data",
    gh: {
      request: async (method: string, pathName: string, body?: any) => {
        calls.push({ method, pathName, body });
        if (method === "GET" && pathName.endsWith("/protection")) {
          return managedProtection();
        }
        if (method === "GET" && pathName.includes("/contents/.darkfactory/managed-repository.json")) {
          return {
            type: "file",
            encoding: "base64",
            content: Buffer.from(JSON.stringify(managedConfig), "utf8").toString("base64")
          };
        }
        if (method === "POST" && pathName === "/repos/marius-patrik/active/issues/44/labels") return {};
        if (method === "DELETE" && pathName.startsWith("/repos/marius-patrik/active/issues/44/labels/")) return {};
        if (method === "GET" && pathName === "/repos/marius-patrik/active/issues/44/comments?per_page=100") return [];
        if (method === "POST" && pathName === "/repos/marius-patrik/active/issues/44/comments") return {};
        throw new Error(`unexpected mocked request: ${method} ${pathName}`);
      }
    }
  });

  const result = await considerSweepPullRequest(repository, pull, { rules: [] });

  assert.equal(result.action, "skip");
  assert.equal(result.reason, "checks-not-green");
  assert.deepEqual(result.required_checks, ["Validate", "DarkFactory Autoreview"]);
  assert.equal(calls.some((call) => call.method === "PUT" && call.pathName === "/repos/marius-patrik/active/pulls/44/merge"), false);
});

test("df-sweep arms automerge for a green worker PR even when the worker issue is done", async () => {
  const repository = { owner: "marius-patrik", repo: "active" };
  const pull = workerPull({ number: 1349, checkConclusion: "SUCCESS", author: "darkfactory-agent" });
  const calls: Array<{ method: string; pathName: string; body?: any }> = [];

  configureSweepRuntime({
    controlRepo: { owner: "marius-patrik", repo: "DarkFactory" },
    dataRepo: "marius-patrik/agents-data",
    gh: {
      graphql: async () => ({
        repository: {
          pullRequest: {
            ...pull,
            id: "PR_1349",
            mergeable: "MERGEABLE",
            statusCheckRollup: {
              contexts: {
                nodes: pull.statusCheckRollup
              }
            }
          }
        }
      }),
      request: async (method: string, pathName: string, body?: any) => {
        calls.push({ method, pathName, body });
        if (method === "GET" && pathName.endsWith("/protection")) {
          return managedProtection();
        }
        if (method === "GET" && pathName === "/repos/marius-patrik/active/issues/1349") {
          return { labels: [{ name: "df:done" }] };
        }
        if (method === "GET" && pathName === "/repos/marius-patrik/active/issues/1349/comments?per_page=100") {
          return [];
        }
        if (method === "PUT" && pathName === "/repos/marius-patrik/active/pulls/1349/merge") {
          return { sha: "merged-done-issue-sha" };
        }
        if (method === "POST" && pathName === "/repos/marius-patrik/active/issues/1349/comments") return {};
        if (method === "PATCH" && pathName === "/repos/marius-patrik/active/issues/1349") return {};
        throw new Error(`unexpected mocked request: ${method} ${pathName}`);
      }
    }
  });

  const result = await considerSweepPullRequest(repository, pull);

  assert.equal(result.action, "enable-automerge");
  assert.equal(calls.some((call) => call.method === "PUT" && call.pathName === "/repos/marius-patrik/active/pulls/1349/merge"), false);
  assert.equal(calls.some((call) => call.method === "POST" && call.pathName === "/repos/marius-patrik/active/issues/1349/labels"), false);
});

test("df-sweep skips green worker PRs when the worker issue is not verified", async () => {
  const repository = { owner: "marius-patrik", repo: "active" };
  const pull = workerPull({ number: 8, checkConclusion: "SUCCESS", author: "darkfactory-agent" });
  const calls: Array<{ method: string; pathName: string; body?: any }> = [];

  configureSweepRuntime({
    controlRepo: { owner: "marius-patrik", repo: "DarkFactory" },
    dataRepo: "marius-patrik/agents-data",
    gh: {
      graphql: async () => ({
        repository: {
          pullRequest: {
            ...pull,
            id: "PR_8",
            mergeable: "MERGEABLE",
            statusCheckRollup: {
              contexts: {
                nodes: pull.statusCheckRollup
              }
            }
          }
        }
      }),
      request: async (method: string, pathName: string, body?: any) => {
        calls.push({ method, pathName, body });
        if (method === "GET" && pathName.endsWith("/protection")) {
          return managedProtection();
        }
        if (method === "GET" && pathName === "/repos/marius-patrik/active/issues/8") {
          return { labels: [{ name: "df:blocked" }] };
        }
        if (method === "GET" && pathName === "/repos/marius-patrik/active/issues/8/comments?per_page=100") {
          return [];
        }
        if (method === "PUT" && pathName === "/repos/marius-patrik/active/pulls/8/merge") {
          return { sha: "merged-blocked-issue-sha" };
        }
        if (method === "POST" && pathName === "/repos/marius-patrik/active/issues/8/comments") return {};
        if (method === "PATCH" && pathName === "/repos/marius-patrik/active/issues/8") return {};
        throw new Error(`unexpected mocked request: ${method} ${pathName}`);
      }
    }
  });

  const result = await considerSweepPullRequest(repository, pull);

  assert.equal(result.action, "skip");
  assert.equal(result.reason, "not-verified");
  assert.equal(calls.some((call) => call.method === "PUT" && call.pathName === "/repos/marius-patrik/active/pulls/8/merge"), false);
  assert.equal(calls.some((call) => call.method === "POST" && call.pathName === "/repos/marius-patrik/active/issues/8/labels"), false);
});

test("df-verify workflow chains worker completion into trusted verification", async () => {
  const workflow = await readFile(new URL("../.github/workflows/df-verify.yml", import.meta.url), "utf8");

  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /workflows:\s*\n\s+-\s+DarkFactory Work/);
  assert.match(workflow, /github\.repository == 'marius-patrik\/DarkFactory'/);
  assert.match(workflow, /github\.event\.workflow_run\.head_branch == 'main'/);
  assert.match(workflow, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(workflow, /actions\/download-artifact@v4/);
  assert.match(workflow, /run-id: \$\{\{ github\.event\.workflow_run\.id \}\}/);
  assert.match(workflow, /DF_VERIFICATION_TARGET_FILE: \.darkfactory-verification\/target\.json/);
  assert.doesNotMatch(workflow, /workflow_run\.inputs/);
  assert.match(workflow, /DF_DATA_REPO: marius-patrik\/darkfactory-data/);
  assert.match(workflow, /node \.github\/scripts\/df-verify\.mjs/);
});

test("df-follow-through triggers only after verified worker claims", async () => {
  const workflow = await readFile(new URL("../.github/workflows/df-follow-through.yml", import.meta.url), "utf8");

  assert.match(workflow, /workflows:\s*\n\s+-\s+DarkFactory Verify Worker Claim/);
  assert.match(workflow, /github\.event\.workflow_run\.workflow_name == 'DarkFactory Verify Worker Claim'/);
});

test("df-work keeps issue running until verification confirms the claim", async () => {
  const source = await readFile(new URL("../.github/scripts/df-work.mjs", import.meta.url), "utf8");

  assert.doesNotMatch(source, /replaceIssueLabels\(TARGET_REPO, TARGET_ISSUE_NUMBER, \["df:done"\]/);
  assert.match(source, /The issue stays `df:running` until DarkFactory verifies the worker claim against GitHub reality\./);
  assert.match(source, /ledger\.base_branch = workBaseBranch/);
});

test("parseWorkerClaim normalizes provider ledger fields", () => {
  const receipt = {
    schemaVersion: 2,
    requested: { modelTier: "high", effort: "medium" },
    routing: {
      policyVersion: "fixture-route-policy-v1",
      primary: { provider: "fixture-primary", model: "fixture/primary-model", agentPreset: "Fixture-Primary", providerVersion: "1.0.0" },
      skipped: []
    },
    resolved: { provider: "codex", model: "gpt-5.5", agentPreset: "Sol", providerVersion: "1.2.3" },
    attempts: [{ number: 1, outcome: "success", reason: null }],
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    outcome: "success",
    blockReason: null
  };
  const claim = parseWorkerClaim({
    issue: "marius-patrik/example#42",
    branch: "df/42-slug",
    base_branch: "dev",
    pull_request: "https://github.com/marius-patrik/example/pull/99",
    status: "success",
    model_request: { schemaVersion: 1, modelTier: "high", effort: "medium" },
    agent_os: { receipt }
  });

  assert.equal(claim.repo, "marius-patrik/example");
  assert.equal(claim.issueNumber, 42);
  assert.equal(claim.branch, "df/42-slug");
  assert.equal(claim.baseBranch, "dev");
  assert.equal(claim.provider, "codex");
  assert.equal(claim.model, "gpt-5.5");
  assert.equal(claim.requestedModelTier, "high");
  assert.equal(claim.requestedEffort, "medium");
  assert.equal(claim.agentPreset, "Sol");
  assert.equal(claim.attempts, 1);
  assert.deepEqual(claim.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
});

test("verified worker state is explicit and ledger reads reject Agent OS state", async () => {
  assert.equal(isVerifiedWorkerIssue({ labels: [{ name: "df:done" }] }), true);
  assert.equal(isVerifiedWorkerIssue({ labels: [{ name: "df:running" }] }), false);

  await assert.rejects(
    readLatestRunLedger({}, "marius-patrik/agents-data", "df-work", "marius-patrik/example"),
    /marius-patrik\/darkfactory-data/
  );
});

test("latest ledger switches from the capped Contents listing to exact Git-tree evidence", async () => {
  const stale = Array.from({ length: 1000 }, (_, index) => ({
    name: `2026-07-15T00-00-${String(index).padStart(4, "0")}Z-df-work.json`,
    type: "file"
  }));
  const trees = new Map([
    ["root-tree", [{ path: "runs", type: "tree", sha: "runs-tree" }]],
    ["runs-tree", [{ path: "marius-patrik", type: "tree", sha: "owner-tree" }]],
    ["owner-tree", [{ path: "example", type: "tree", sha: "repo-tree" }]],
    ["repo-tree", [{ path: "2026-07-16T12-00-00-000Z-df-work.json", type: "blob", sha: "ledger-blob" }]]
  ]);
  const gh = {
    request: async (method: string, requestPath: string) => {
      assert.equal(method, "GET");
      if (requestPath.endsWith("/contents/runs/marius-patrik/example")) return stale;
      if (requestPath.endsWith("/git/ref/heads/main")) return { object: { sha: "main-commit" } };
      if (requestPath.endsWith("/git/commits/main-commit")) return { tree: { sha: "root-tree" } };
      const treeSha = requestPath.split("/git/trees/")[1];
      if (treeSha && trees.has(treeSha)) return { truncated: false, tree: trees.get(treeSha) };
      if (requestPath.endsWith("/contents/runs/marius-patrik/example/2026-07-16T12-00-00-000Z-df-work.json")) {
        return { type: "file", encoding: "base64", content: Buffer.from(JSON.stringify({ status: "fresh" })).toString("base64") };
      }
      throw new Error(`unexpected ${method} ${requestPath}`);
    }
  };

  assert.deepEqual(
    await readLatestRunLedger(gh, "marius-patrik/darkfactory-data", "df-work", "marius-patrik/example"),
    { status: "fresh" }
  );
});

test("latest ledger fails closed when capped directory tree evidence is truncated", async () => {
  const gh = {
    request: async (_method: string, requestPath: string) => {
      if (requestPath.includes("/contents/")) return Array.from({ length: 1000 }, () => ({ name: "stale.json", type: "file" }));
      if (requestPath.endsWith("/git/ref/heads/main")) return { object: { sha: "main-commit" } };
      if (requestPath.endsWith("/git/commits/main-commit")) return { tree: { sha: "root-tree" } };
      if (requestPath.endsWith("/git/trees/root-tree")) return { truncated: true, tree: [] };
      throw new Error(`unexpected ${requestPath}`);
    }
  };

  await assert.rejects(
    readLatestRunLedger(gh, "marius-patrik/darkfactory-data", "df-work", "marius-patrik/example"),
    /truncated or malformed/
  );
});

test("df-sweep blocks protected branches that have no required checks", async () => {
  const repository = { owner: "marius-patrik", repo: "active" };
  const pull = workerPull({
    number: 50,
    checkConclusion: "SUCCESS",
    includeAutoreview: false,
    author: "darkfactory-agent"
  });
  const calls: Array<{ method: string; pathName: string; body?: any }> = [];
  const graphqlCalls: string[] = [];

  configureSweepRuntime({
    controlRepo: { owner: "marius-patrik", repo: "DarkFactory" },
    dataRepo: "marius-patrik/agents-data",
    gh: {
      graphql: async (query: string, variables: { number: number }) => {
        graphqlCalls.push(query);
        return {
          repository: {
            pullRequest: {
              ...(variables.number === 50 ? pull : {}),
              id: `PR_${variables.number}`,
              mergeable: "MERGEABLE",
              statusCheckRollup: {
                contexts: {
                  nodes: (variables.number === 50 ? pull : { statusCheckRollup: [] }).statusCheckRollup
                }
              }
            }
          }
        };
      },
      request: async (method: string, pathName: string, body?: any) => {
        calls.push({ method, pathName, body });
        if (method === "GET" && pathName.endsWith("/protection")) {
          return { required_status_checks: null };
        }
        if (method === "GET" && pathName.includes("/contents/.darkfactory/managed-repository.json")) {
          const error: Error & { status?: number } = new Error("Missing managed config");
          error.status = 404;
          throw error;
        }
        if (method === "GET" && pathName === "/repos/marius-patrik/active/issues/50") {
          return { labels: [{ name: "df:done" }] };
        }
        if (method === "GET" && pathName === "/repos/marius-patrik/active/issues/50/comments?per_page=100") {
          return [];
        }
        if (method === "PUT" && pathName === "/repos/marius-patrik/active/pulls/50/merge") {
          return { sha: "direct-merged-protected-no-checks-sha" };
        }
        if (method === "POST" && pathName === "/repos/marius-patrik/active/issues/50/comments") return {};
        if (method === "POST" && pathName === "/repos/marius-patrik/active/issues/50/labels") return {};
        if (method === "DELETE" && pathName.includes("/repos/marius-patrik/active/issues/50/labels/")) return {};
        if (method === "PATCH" && pathName === "/repos/marius-patrik/active/issues/50") return {};
        throw new Error(`unexpected mocked request: ${method} ${pathName}`);
      }
    }
  });

  const result = await considerSweepPullRequest(repository, pull);

  assert.equal(result.action, "skip");
  assert.equal(result.reason, "merge-policy-blocked");
  assert.equal(calls.some((call) => call.method === "PUT" && call.pathName === "/repos/marius-patrik/active/pulls/50/merge"), false);
  assert.equal(graphqlCalls.some((query) => query.includes("enablePullRequestAutoMerge")), false);
});

test("df-orchestrate workflow validates trusted refs before privileged tokens", async () => {
  const workflow = await readFile(new URL("../.github/workflows/df-orchestrate.yml", import.meta.url), "utf8");
  const gate = workflow.indexOf("Validate trusted control ref");
  const checkout = workflow.indexOf("Checkout DarkFactory control repository");
  const token = workflow.indexOf("Mint mp-agents installation token");

  assert.notEqual(gate, -1);
  assert.notEqual(checkout, -1);
  assert.notEqual(token, -1);
  assert.ok(gate < token);
  assert.ok(checkout < token);
  assert.match(workflow, /GITHUB_REPOSITORY/);
  assert.match(workflow, /GITHUB_REF.*refs\/heads\/main/);
  assert.match(workflow, /GITHUB_REF_NAME.*main/);
  assert.doesNotMatch(workflow, /GITHUB_REF.*refs\/heads\/dev/);
  assert.doesNotMatch(workflow, /GITHUB_REF_NAME.*dev/);
  assert.match(workflow, /repository:\s+marius-patrik\/DarkFactory/);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /uses:\s+actions\/setup-node@v4[\s\S]+node-version:\s+22/);
  assert.match(workflow, /node --experimental-strip-types \$\{\{ steps\.script-path\.outputs\.path \}\}/);
  assert.match(workflow, /github\.repository == 'marius-patrik\/DarkFactory'[\s\S]+github\.event_name == 'schedule'/);
  assert.doesNotMatch(workflow, /^\s+issues:\s*$/m);
  assert.doesNotMatch(workflow, /^\s+issue_comment:\s*$/m);
  assert.doesNotMatch(workflow, /github\.repository_owner == 'marius-patrik'[\s\S]+github\.event_name == 'issues'/);
  assert.doesNotMatch(workflow, /github\.repository_owner == 'marius-patrik'[\s\S]+github\.event_name == 'issue_comment'/);
  assert.match(workflow, /permission-actions:\s+write/);
  assert.match(workflow, /permission-administration:\s+read/);
  assert.match(workflow, /permission-checks:\s+read/);
  assert.match(workflow, /permission-workflows:\s+write/);
  assert.match(workflow, /permission-contents:\s+write/);
  assert.match(workflow, /permission-issues:\s+write/);
  assert.match(workflow, /permission-pull-requests:\s+read/);
  assert.match(workflow, /permission-secrets:\s+read/);
  assert.match(workflow, /permission-statuses:\s+read/);
  assert.match(workflow, /DARK_FACTORY_TOKEN: \$\{\{ steps\.app-token\.outputs\.token \}\}/);
  assert.match(workflow, /DF_CONTROL_REPO: marius-patrik\/DarkFactory/);
  assert.match(workflow, /repo:\s*\n\s+description: Optional managed repository/);
  assert.match(workflow, /issue_number:\s*\n\s+description: Optional managed issue number/);
  assert.match(workflow, /source_event:\s*\n\s+description: Optional source event name for a scoped control dispatch/);
  assert.match(workflow, /DF_TARGET_REPO: \$\{\{ inputs\.repo \}\}/);
  assert.match(workflow, /DF_TARGET_ISSUE_NUMBER: \$\{\{ inputs\.issue_number \}\}/);
  assert.match(workflow, /DF_SOURCE_EVENT: \$\{\{ inputs\.source_event \}\}/);
  assert.match(workflow, /^\s+workflow_run:\s*$/m);
  assert.match(workflow, /workflows:\s*\n\s+-\s+DarkFactory Plan\s*\n\s+-\s+DarkFactory Work\s*\n\s+-\s+DarkFactory Follow Through/);
  assert.match(workflow, /types:\s*\n\s+-\s+completed/);
  assert.match(workflow, /github\.event_name == 'workflow_run'/);
  assert.match(workflow, /github\.event\.workflow_run\.head_branch == 'main'/);
  assert.match(workflow, /github\.event\.workflow_run\.conclusion == 'success'/);
});

test("control df-event-forward workflow safely dispatches local events to orchestrate", async () => {
  const workflow = await readFile(new URL("../.github/workflows/df-event-forward.yml", import.meta.url), "utf8");

  assert.match(workflow, /^\s+issues:\s*$/m);
  assert.match(workflow, /^\s+issue_comment:\s*$/m);
  assert.match(workflow, /permissions:\s*\{\}/);
  assert.match(workflow, /github\.repository == 'marius-patrik\/DarkFactory'/);
  assert.match(workflow, /github\.event\.label\.name == 'df:ready'/);
  assert.match(workflow, /github\.event\.comment\.body == '\/df run'/);
  assert.match(workflow, /startsWith\(github\.event\.comment\.body, '\/df run '\)/);
  assert.match(workflow, /github\.event\.comment\.author_association == 'OWNER'/);
  assert.match(workflow, /github\.event\.comment\.author_association == 'MEMBER'/);
  assert.match(workflow, /github\.event\.comment\.author_association == 'COLLABORATOR'/);
  assert.match(workflow, /actions\/create-github-app-token@v2/);
  assert.match(workflow, /repositories:\s+DarkFactory/);
  assert.match(workflow, /permission-actions:\s+write/);
  assert.doesNotMatch(workflow, /permission-contents:\s+write/);
  assert.doesNotMatch(workflow, /permission-issues:\s+write/);
  assert.doesNotMatch(workflow, /actions\/checkout/);
  assert.doesNotMatch(workflow, /\.github\/scripts|npm\s|node\s/);
  assert.match(workflow, /createWorkflowDispatch/);
  assert.match(workflow, /workflow_id: "df-orchestrate\.yml"/);
  assert.match(workflow, /ref: "main"/);
  assert.match(workflow, /repo: `\$\{context\.repo\.owner\}\/\$\{context\.repo\.repo\}`/);
  assert.match(workflow, /issue_number: String\(context\.payload\.issue\.number\)/);
  assert.match(workflow, /source_event: context\.eventName/);
});

test("df-orchestrate source requires the app token for cross-repo writes", async () => {
  const source = await readFile(new URL("../.github/scripts/df-orchestrate.mjs", import.meta.url), "utf8");

  assert.match(source, /const appInstallationToken = requiredEnv\("DARK_FACTORY_TOKEN"\)/);
  assert.match(source, /createGithubClient\(appInstallationToken, "darkfactory-orchestrate"\)/);
  assert.match(source, /GITHUB_TOKEN[\s\S]+cannot perform cross-repo issue writes/);
  assert.doesNotMatch(source, /process\.env\.GITHUB_TOKEN|github\.token/);
});

test("df-orchestrate uses machine readiness evaluation and dispatches via workflow_dispatch", async () => {
  const source = await readFile(new URL("../.github/scripts/df-orchestrate.mjs", import.meta.url), "utf8");
  const mainStart = source.indexOf("async function main()");
  const orchestrateStart = source.indexOf("export async function orchestrate");
  const mainSource = source.slice(mainStart, orchestrateStart);
  const requestSource = source.slice(orchestrateStart, source.indexOf("const policy =", orchestrateStart));

  assert.match(source, /const CONTROL_ROOT = path\.resolve/);
  assert.match(source, /listActiveManagedRepos\(gh, controlRepo, options\)/);
  assert.match(source, /parseEventRequest\(process\.env\.GITHUB_EVENT_PAYLOAD/);
  assert.match(mainSource, /const rawRepo = process\.env\.DF_TARGET_REPO/);
  assert.match(mainSource, /parseWorkflowDispatchRequest\(\s*rawRepo,\s*rawIssue,\s*rawSource/);
  assert.match(mainSource, /orchestrate\(\{ gh, controlRepo, trigger, root: CONTROL_ROOT, dispatchRequest \}\)/);
  assert.doesNotMatch(requestSource, /process\.env\.DF_TARGET_|parseWorkflowDispatchRequest/);
  assert.match(source, /evaluateIssueReadinessLabels/);
  assert.match(source, /DarkFactory received `\/df run` and performed the machine readiness evaluation\./);
  assert.match(source, /dispatch still recomputes the predicate/);
  assert.doesNotMatch(source, /readySlashRunIssue|queued this issue with `df:ready`/);
  assert.match(source, /\/repos\/\$\{repoName\(controlRepo\)\}\/actions\/workflows\/df-work\.yml\/dispatches/);
  assert.doesNotMatch(source, /df-prd:\[a-z0-9-\]\+/);
  assert.match(source, /df:running/);
  assert.match(source, /df:blocked/);
  assert.match(source, /df:done/);
});

test("df-orchestrate claims ready issues before dispatching workers", async () => {
  const source = await readFile(new URL("../.github/scripts/df-orchestrate.mjs", import.meta.url), "utf8");

  const preflightIndex = source.indexOf("const mergePolicy = await preflightMergePolicy");
  const claimIndex = source.indexOf("replaceIssueLabels(gh, repository, issueNumber, [\"df:running\"], [\"df:ready\"])", preflightIndex);
  const dispatchIndex = source.indexOf("/actions/workflows/df-work.yml/dispatches");
  assert.notEqual(preflightIndex, -1);
  assert.notEqual(claimIndex, -1);
  assert.notEqual(dispatchIndex, -1);
  assert.ok(preflightIndex < claimIndex);
  assert.ok(claimIndex < dispatchIndex);
});

test("df-orchestrate escalates decisions then evaluates readiness before plan building", async () => {
  const source = await readFile(new URL("../.github/scripts/df-orchestrate.mjs", import.meta.url), "utf8");

  const escalationIndex = source.indexOf("await escalateOwnerDecisionIssues(gh, scopedSnapshots, warn)");
  const readinessIndex = source.indexOf("await evaluateIssueReadinessLabels(gh, snapshots, warn");
  const planIndex = source.indexOf("buildOrchestrationPlan(scopedSnapshots");
  assert.notEqual(escalationIndex, -1);
  assert.notEqual(readinessIndex, -1);
  assert.notEqual(planIndex, -1);
  assert.ok(escalationIndex < readinessIndex);
  assert.ok(readinessIndex < planIndex);
  assert.match(source, /enforceReadinessContract: true/);
  assert.match(source, /names\.has\("df:no-dispatch"\)/);
});

test("df-orchestrate blocks target auto-merge setup failures before worker dispatch", async () => {
  const source = await readFile(new URL("../.github/scripts/df-orchestrate.mjs", import.meta.url), "utf8");

  const blockIndex = source.indexOf("await blockIssueBeforeDispatch");
  const dispatchIndex = source.indexOf("/actions/workflows/df-work.yml/dispatches");
  assert.notEqual(blockIndex, -1);
  assert.notEqual(dispatchIndex, -1);
  assert.ok(blockIndex < dispatchIndex);
  assert.match(source, /if \(mergePolicy\.blocked\)/);
  // Merge-policy blockers escalate for owner input (df:ask-owner + df:blocked)
  // so the lane stays on the owner-decision queue instead of stalling silently.
  assert.match(source, /replaceIssueLabels\(gh, repository, issueNumber, \["df:ask-owner", "df:blocked"\], \["df:ready", "df:running", "df:done"\]\)/);
  assert.match(source, /reason=merge-policy-blocked/);
  assert.match(source, /DarkFactory blocked this issue before worker dispatch and escalated it for owner input/);
  assert.match(source, /not a code implementation failure/);
});

test("df-orchestrate clears a failed claim and requires fresh readiness evaluation", async () => {
  const source = await readFile(new URL("../.github/scripts/df-orchestrate.mjs", import.meta.url), "utf8");

  const dispatchIndex = source.indexOf("/actions/workflows/df-work.yml/dispatches");
  const clearIndex = source.indexOf("replaceIssueLabels(gh, repository, issueNumber, [], [\"df:running\"])", dispatchIndex);
  assert.notEqual(dispatchIndex, -1);
  assert.notEqual(clearIndex, -1);
  assert.ok(dispatchIndex < clearIndex);
  assert.doesNotMatch(source, /replaceIssueLabels\(gh, repository, issueNumber, \["df:ready"\], \["df:running"\]\)/);
  assert.match(source, /never restore df:ready from a past snapshot/);
});

test("product truth forbids manual readiness and unprotected direct-merge fallbacks", async () => {
  const prd = await readFile(new URL("../PRD.md", import.meta.url), "utf8");

  assert.match(prd, /evaluator alone applies or revokes managed-repository `df:ready`/);
  assert.match(prd, /Humans never apply the readiness label/);
  assert.match(prd, /`\/df run` is an evaluation request bound to the current issue version/);
  assert.match(prd, /No no-check allowlist or direct-merge fallback exists/);
  assert.doesNotMatch(prd, /Label an issue `df:ready`|represented by `df:ready`/);
  assert.doesNotMatch(prd, /On unprotected branches|no required checks exist|may directly merge a green worker PR/);
});

test("df-sweep evaluates enforcement rules before merge", async () => {
  const repository = { owner: "marius-patrik", repo: "active" };
  const pull = workerPull({ number: 200, checkConclusion: "SUCCESS", author: "darkfactory-agent" });
  const enforcementRules = {
    schemaVersion: 1,
    rules: [{ id: "work-PRs-target-dev", enabled: true, severity: "block", parameters: { defaultBranch: "main" } }]
  };
  const calls: Array<{ method: string; pathName: string; body?: any }> = [];

  configureSweepRuntime({
    controlRepo: { owner: "marius-patrik", repo: "DarkFactory" },
    dataRepo: "marius-patrik/agents-data",
    gh: {
      request: async (method: string, pathName: string, body?: any) => {
        calls.push({ method, pathName, body });
        if (method === "GET" && pathName.endsWith("/protection")) {
          return managedProtection();
        }
        if (method === "POST" && pathName === "/repos/marius-patrik/active/issues/200/labels") return {};
        if (method === "DELETE" && pathName.startsWith("/repos/marius-patrik/active/issues/200/labels/")) return {};
        if (method === "GET" && pathName === "/repos/marius-patrik/active/issues/200/comments?per_page=100") return [];
        if (method === "POST" && pathName === "/repos/marius-patrik/active/issues/200/comments") return {};
        throw new Error(`unexpected mocked request: ${method} ${pathName}`);
      }
    }
  });

  const result = await considerSweepPullRequest(repository, pull, enforcementRules);

  assert.equal(result.action, "skip");
  assert.equal(result.reason, "enforcement-rules");
  assert.ok(result.findings.some((finding: { rule: string }) => finding.rule === "work-PRs-target-dev"));
  assert.equal(calls.some((call) => call.method === "PUT" && call.pathName === "/repos/marius-patrik/active/pulls/200/merge"), false);
});

test("df-work loads and evaluates enforcement rules before clone or Agent OS execution", async () => {
  const source = await readFile(new URL("../.github/scripts/df-work.mjs", import.meta.url), "utf8");

  assert.match(source, /import \{ evaluateEnforcementRules, loadEnforcementRules \} from "\.\/df-enforcement\.mjs"/);
  assert.match(source, /loadEnforcementRules\(CONTROL_ROOT\)/);
  assert.match(source, /evaluateEnforcementRules\(enforcementRules,/);
  assert.match(source, /enforcementBlockedComment\(/);
  const enforcementIndex = source.indexOf("evaluateEnforcementRules(enforcementRules");
  const cloneIndex = source.indexOf("await cloneRepository");
  assert.notEqual(enforcementIndex, -1);
  assert.notEqual(cloneIndex, -1);
  assert.ok(enforcementIndex < cloneIndex);
});

function workerPull(options: {
  number: number;
  checkConclusion: string | null;
  checkStatus?: string;
  autoreviewConclusion?: string | null;
  autoreviewStatus?: string;
  includeAutoreview?: boolean;
  labels?: Array<{ name: string }>;
  author?: string;
}) {
  const statusCheckRollup = [
    {
      __typename: "CheckRun",
      name: "Validate",
      status: options.checkStatus || "COMPLETED",
      conclusion: options.checkConclusion
    }
  ];
  if (options.includeAutoreview !== false) {
    statusCheckRollup.push({
      __typename: "CheckRun",
      name: "DarkFactory Autoreview",
      status: options.autoreviewStatus || "COMPLETED",
      conclusion: options.autoreviewConclusion === undefined ? "SUCCESS" : options.autoreviewConclusion
    });
  }

  return {
    id: `PR_${options.number}`,
    number: options.number,
    title: `Worker PR ${options.number}`,
    body: `<!-- dark-factory:worker-pr issue=${options.number} -->\n\nCloses #${options.number}`,
    author: { __typename: "Bot", login: options.author || "darkfactory-agent" },
    headRefName: `df/${options.number}-worker`,
    headRepository: { owner: { login: "marius-patrik" }, name: "active" },
    baseRefName: "dev",
    mergeable: "MERGEABLE",
    isDraft: false,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    labels: options.labels || [],
    statusCheckRollup
  };
}
