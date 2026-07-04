import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
const dfLib: any = await import("../.github/scripts/df-lib.mjs");

const {
  assertAllowedRepo,
  checksAreGreen,
  cleanupTempRoot,
  extractClosingIssueNumbers,
  getRequiredStatusCheckContexts,
  darkFactoryWorkerIssueNumber,
  isDarkFactoryWorkerPullRequest,
  isParkedRepo,
  parsePrdItems,
  plannedIssueLabelDiff,
  prdIssueBody,
  reconcileLabelDiff,
  taskClassFromLabels
} = dfLib;

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

test("task class labels map to Codex reasoning effort", () => {
  assert.deepEqual(taskClassFromLabels([{ name: "df:class:mechanical" }]), {
    taskClass: "mechanical",
    effort: "low"
  });
  assert.deepEqual(taskClassFromLabels([{ name: "df:class:hard" }]), {
    taskClass: "hard",
    effort: "high"
  });
  assert.deepEqual(taskClassFromLabels([]), {
    taskClass: "standard",
    effort: "medium"
  });
});

test("prdIssueBody records deterministic Blocked-by sequencing", () => {
  const [item] = parsePrdItems("## Milestones\n\n- **M2 — Planning**: Reconcile. Acceptance: update issues.");
  const body = prdIssueBody(item, [10]);

  assert.match(body, /Blocked-by: #10/);
  assert.match(body, /df-prd:milestones-m2/);
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

test("checksAreGreen respects required checks and rejects pending or failing checks", () => {
  assert.equal(checksAreGreen([]), true);
  assert.equal(checksAreGreen([], ["ci"]), false);
  assert.equal(checksAreGreen([{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }]), true);
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
  assert.equal(isParkedRepo({ owner: "marius-patrik", repo: "fabrica" }), true);
  assert.throws(() => assertAllowedRepo({ owner: "marius-patrik", repo: "singularity" }), /parked/);
  assert.throws(() => assertAllowedRepo({ owner: "marius-patrik", repo: "life-support" }), /parked/);
});

test("df-sweep dev-merge closure uses worker PR provenance instead of issue labels or comments", async () => {
  const source = await readFile(new URL("../.github/scripts/df-sweep.mjs", import.meta.url), "utf8");

  assert.match(source, /reason: "parked"/);
  assert.match(source, /if \(!isWorkerPullRequest\(pull, repository\)\)/);
  assert.doesNotMatch(source, /issueWasOpenedByDarkFactoryWorker/);
  assert.match(source, /extractClosingIssueNumbers\(pull\.body \|\| "", repoName\(repository\)\)/);
});

test("df-sweep recognizes worker PRs from managed and app-token paths", () => {
  const repository = { owner: "marius-patrik", repo: "example" };
  const workerPull = {
    title: "Implement issue #23",
    body: "<!-- dark-factory:worker-pr issue=23 -->\n\nCloses #23",
    author: { login: "github-actions[bot]" },
    headRefName: "df/23-add-worker",
    headRepository: { owner: { login: "marius-patrik" }, name: "example" }
  };

  assert.equal(isDarkFactoryWorkerPullRequest(workerPull, repository), true);
  assert.equal(isDarkFactoryWorkerPullRequest({ ...workerPull, author: { login: "mp-agents[bot]" } }, repository), true);
  assert.equal(isDarkFactoryWorkerPullRequest({ ...workerPull, author: { login: "marius-patrik" } }, repository), false);
  assert.equal(isDarkFactoryWorkerPullRequest({ ...workerPull, headRefName: "feature/23-add-worker" }, repository), false);
  assert.equal(isDarkFactoryWorkerPullRequest({ ...workerPull, body: "<!-- dark-factory:worker-pr issue=23 -->" }, repository), false);
  assert.equal(darkFactoryWorkerIssueNumber(workerPull), 23);
});

test("df-sweep marks blocked worker issues when follow-through cannot merge", async () => {
  const source = await readFile(new URL("../.github/scripts/df-sweep.mjs", import.meta.url), "utf8");

  assert.match(source, /markWorkerIssueBlocked\(repository, pull, "no-checks-not-allowed"/);
  assert.match(source, /markWorkerIssueBlocked\(repository, pull, reason/);
  assert.doesNotMatch(source, /checksSummary\(pull\.statusCheckRollup\)\.join/);
  assert.match(source, /replaceIssueLabels\(repository, issueNumber, \["df:blocked"\], \["df:ready", "df:running", "df:done"\]\)/);
  assert.match(source, /dark-factory:sweep-blocked/);
});

test("df-work cleanup remains a warning path after successful PR handoff", async () => {
  const source = await readFile(new URL("../.github/scripts/df-work.mjs", import.meta.url), "utf8");
  const successBeforeFinally = /ledger\.status = "success";[\s\S]+finally \{/.test(source);
  const finallyBlock = source.slice(source.indexOf("finally {"));

  assert.equal(successBeforeFinally, true);
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
  assert.match(source, /tracked `PRD\.md` file/);
});

test("df-plan drift detection covers untracked open issues and PRs", async () => {
  const source = await readFile(new URL("../.github/scripts/df-plan.mjs", import.meta.url), "utf8");

  assert.match(source, /not tracked by any PRD item/);
  assert.match(source, /not linked to a PRD-tracked issue/);
  assert.match(source, /extractClosingIssueNumbers/);
  assert.match(source, /listOpenPullRequests/);
});

test("df-plan workflow reacts safely to PRD edits on main", async () => {
  const workflow = await readFile(new URL("../.github/workflows/df-plan.yml", import.meta.url), "utf8");
  const gate = workflow.indexOf("Validate trusted control ref");
  const checkout = workflow.indexOf("Checkout DarkFactory control scripts");
  const token = workflow.indexOf("Mint mp-agents installation token");

  assert.match(workflow, /^\s+push:\s*$/m);
  assert.match(workflow, /^\s+branches:\s*$/m);
  assert.match(workflow, /^\s+-\s+main\s*$/m);
  assert.match(workflow, /PRD\.md/);
  assert.match(workflow, /^\s+workflow_dispatch:\s*$/m);
  assert.match(workflow, /^\s+schedule:\s*$/m);
  assert.match(workflow, /actions:\s+write/);
  assert.notEqual(gate, -1);
  assert.notEqual(checkout, -1);
  assert.notEqual(token, -1);
  assert.ok(gate < token);
  assert.ok(checkout < token);
  assert.match(workflow, /GITHUB_REPOSITORY_OWNER/);
  assert.match(workflow, /GITHUB_REF_NAME.*main/);
  assert.match(workflow, /GITHUB_REF.*refs\/heads\/main/);
  assert.match(workflow, /repository:\s+marius-patrik\/darkfactory-agent/);
  assert.match(workflow, /path:\s+darkfactory-control/);
  assert.match(workflow, /steps\.control-ref\.outputs\.sha/);
  assert.match(workflow, /Resolve canonical control ref/);
  assert.match(workflow, /Validate manual planning target ref/);
  assert.doesNotMatch(workflow, /DARK_FACTORY_CONTROL_REF/);
});

test("df-plan explicitly dispatches workers for newly ready PRD issues", async () => {
  const source = await readFile(new URL("../.github/scripts/df-plan.mjs", import.meta.url), "utf8");

  assert.match(source, /dispatchIfNewlyReady/);
  assert.match(source, /labelUpdate\.add\.includes\("df:ready"\)/);
  assert.match(source, /actions\/workflows\/df-work\.yml\/dispatches/);
  assert.match(source, /await-control-orchestrator/);
  assert.match(source, /repos\/\$\{repoName\(CONTROL_REPO\)\}\/actions\/workflows\/df-work\.yml\/dispatches/);
});

test("df-plan preserves PRD sequence references across completed predecessors", async () => {
  const source = await readFile(new URL("../.github/scripts/df-plan.mjs", import.meta.url), "utf8");

  assert.match(source, /let previousIssueNumber = null/);
  assert.match(source, /let previousOpenIssueNumber = null/);
  assert.match(source, /const blockedBy = previousIssueNumber \? \[previousIssueNumber\] : \[\]/);
  assert.match(source, /if \(previousOpenIssueNumber === null\) labels\.push\("df:ready"\)/);
  assert.match(source, /previousIssueNumber = closed\.number/);
  assert.match(source, /previousIssueNumber = existing\.number/);
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
  assert.match(workflow, /github\.repository == 'marius-patrik\/darkfactory-agent'/);
  assert.match(workflow, /GITHUB_REPOSITORY/);
  assert.match(workflow, /GITHUB_REF_NAME.*main/);
  assert.match(workflow, /GITHUB_REF.*refs\/heads\/main/);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(workflow, /github\.ref_name|DARK_FACTORY_CONTROL_REF/);
});

test("df-work records auto-merge support during merge-policy preflight", async () => {
  const source = await readFile(new URL("../.github/scripts/df-work.mjs", import.meta.url), "utf8");

  assert.match(source, /const autoMergeSupported = repo\.allow_auto_merge === true/);
  assert.match(source, /autoMergeSupported/);
  assert.match(source, /does not allow auto-merge/);
  assert.match(source, /green-PR sweep will squash-merge directly after checks/);
});

test("df-work workflow does not expose privileged worker triggers in managed repositories", async () => {
  const workflow = await readFile(new URL("../.github/workflows/df-work.yml", import.meta.url), "utf8");

  assert.doesNotMatch(workflow, /^  issues:/m);
  assert.doesNotMatch(workflow, /^  issue_comment:/m);
  assert.doesNotMatch(workflow, /author_association/);
  assert.match(workflow, /github\.repository == 'marius-patrik\/darkfactory-agent'/);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch'/);
});

test("df-work workflow restricts privileged workers to the control repository", async () => {
  const workflow = await readFile(new URL("../.github/workflows/df-work.yml", import.meta.url), "utf8");

  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /github\.repository == 'marius-patrik\/darkfactory-agent'/);
  assert.doesNotMatch(workflow, /inputs\.repo == github\.repository/);
  assert.match(workflow, /if:\s*github\.event_name == 'workflow_dispatch'/);
});

test("df-work workflow downloads canonical scripts for managed-repo triggers", async () => {
  const workflow = await readFile(new URL("../.github/workflows/df-work.yml", import.meta.url), "utf8");

  assert.match(workflow, /raw\.githubusercontent\.com/);
  assert.match(workflow, /darkfactory-control\/\.github\/scripts\/df-work\.mjs/);
  assert.doesNotMatch(workflow, /actions\/checkout/);
});

test("df-work workflow uses the app token for control-dispatched workers", async () => {
  const workflow = await readFile(new URL("../.github/workflows/df-work.yml", import.meta.url), "utf8");

  assert.match(workflow, /if:\s*github\.event_name == 'workflow_dispatch'/);
  assert.match(workflow, /DARK_FACTORY_TOKEN: \$\{\{ steps\.app-token\.outputs\.token \}\}/);
  assert.doesNotMatch(workflow, /steps\.app-token\.outputs\.token \|\| github\.token/);
  assert.match(workflow, /DF_TARGET_REPO: \$\{\{ inputs\.repo \}\}/);
  assert.match(workflow, /DF_TARGET_ISSUE_NUMBER: \$\{\{ inputs\.issue_number \}\}/);
});

test("df-sweep waits before treating empty check rollups as no-checks-configured", async () => {
  const source = await readFile(new URL("../.github/scripts/df-sweep.mjs", import.meta.url), "utf8");

  assert.match(source, /EMPTY_CHECK_SETTLE_MS/);
  assert.match(source, /emptyCheckRollupHasSettled\(pull\)/);
  assert.match(source, /checks-not-reported-yet/);
});

test("df-sweep verifies branch protection before merging empty check rollups", async () => {
  const source = await readFile(new URL("../.github/scripts/df-sweep.mjs", import.meta.url), "utf8");

  assert.match(source, /getRequiredStatusCheckContexts/);
  assert.match(source, /required_checks/);
  assert.match(source, /required-checks-missing/);
  assert.match(source, /checksAreGreen\(pull\.statusCheckRollup, requiredContexts\)/);
});

test("df-sweep requires explicit allowlist before merging PRs with no checks", async () => {
  const source = await readFile(new URL("../.github/scripts/df-sweep.mjs", import.meta.url), "utf8");

  assert.match(source, /DF_ALLOW_NO_CHECK_REPOS/);
  assert.match(source, /NO_CHECK_ALLOWLIST/);
  assert.match(source, /no-checks-not-allowed/);
});

test("df-orchestrate workflow validates trusted refs before privileged tokens", async () => {
  const workflow = await readFile(new URL("../.github/workflows/df-orchestrate.yml", import.meta.url), "utf8");
  const gate = workflow.indexOf("Validate trusted control ref");
  const checkout = workflow.indexOf("Checkout DarkFactory from this repository");
  const token = workflow.indexOf("Mint mp-agents installation token");

  assert.notEqual(gate, -1);
  assert.notEqual(checkout, -1);
  assert.notEqual(token, -1);
  assert.ok(gate < token);
  assert.ok(checkout < token);
  assert.match(workflow, /GITHUB_REPOSITORY/);
  assert.match(workflow, /GITHUB_REF.*refs\/heads\/main/);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
});

test("df-orchestrate script skips parked repositories and dispatches via workflow_dispatch", async () => {
  const source = await readFile(new URL("../.github/scripts/df-orchestrate.mjs", import.meta.url), "utf8");

  assert.match(source, /if \(isParkedRepo\(target\)\) continue/);
  assert.match(source, /\/repos\/\$\{repoName\(CONTROL_REPO\)\}\/actions\/workflows\/df-work\.yml\/dispatches/);
  assert.match(source, /\/df-prd:/);
  assert.match(source, /df:running/);
  assert.match(source, /df:blocked/);
  assert.match(source, /df:done/);
});
