import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
const dfLib: any = await import("../.github/scripts/df-lib.mjs");
// @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
const dfFix: any = await import("../.github/scripts/df-fix.mjs");

const {
  assertAllowedRepo,
  checksAreGreen,
  cleanupTempRoot,
  extractClosingIssueNumbers,
  getBranchProtection,
  getRequiredStatusCheckContexts,
  darkFactoryWorkerIssueNumber,
  isIgnorableCleanupError,
  isDarkFactoryWorkerPullRequest,
  isParkedRepo,
  listActiveManagedRepos,
  parsePrdItems,
  plannedIssueLabelDiff,
  preflightMergePolicy,
  prdIssueBody,
  reconcileLabelDiff,
  repoName,
  taskClassFromLabels
} = dfLib;

const {
  classifyFixCandidate,
  fixPullRequestByRedispatch,
  getMergeBranchProtectionState,
  mergeGateTrustFailure,
  mergeGreenPullRequest,
  parseFixRound
} = dfFix;

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

test("cleanupTempRoot ignores expected temp cleanup races", () => {
  assert.equal(isIgnorableCleanupError({ code: "EACCES" }), true);
  assert.equal(isIgnorableCleanupError({ code: "ENOENT" }), true);
  assert.equal(isIgnorableCleanupError({ code: "EPERM" }), false);
});

test("checksAreGreen respects required checks and rejects pending or failing checks", () => {
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

test("getRequiredStatusCheckContexts treats inaccessible branch protection as no native requirements", async () => {
  const error: Error & { status?: number } = new Error("Resource not accessible by integration");
  error.status = 403;

  const contexts = await getRequiredStatusCheckContexts(
    {
      request: async () => {
        throw error;
      }
    },
    { owner: "marius-patrik", repo: "example" },
    "main"
  );

  assert.deepEqual(contexts, []);
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
  assert.equal(isParkedRepo({ owner: "marius-patrik", repo: "fabrica" }), true);
  assert.throws(() => assertAllowedRepo({ owner: "marius-patrik", repo: "singularity" }), /parked/);
  assert.throws(() => assertAllowedRepo({ owner: "marius-patrik", repo: "life-support" }), /parked/);
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
    { owner: "marius-patrik", repo: "agent-darkfactory" },
    { repositories, registry, warn: (warning: string) => warnings.push(warning) }
  );

  assert.deepEqual(active, [{ owner: "marius-patrik", repo: "active" }]);
  assert.ok(warnings.some((warning) => warning.includes("archived=true")));
  assert.ok(warnings.some((warning) => warning.includes("disabled=true")));
  assert.ok(warnings.some((warning) => warning.includes("managed lifecycle state is 'parked'")));
  assert.ok(warnings.some((warning) => warning.includes("managed lifecycle state is 'removed'")));
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

test("df-sweep dev-merge backstop preserves REST merged_at in normalized PRs", async () => {
  const source = await readFile(new URL("../.github/scripts/df-sweep.mjs", import.meta.url), "utf8");

  assert.match(source, /const mergedAt = pull\.merged_at \|\| null/);
  assert.match(source, /mergedAt\s*\n\s*\};/);
  assert.match(source, /if \(!normalized\.mergedAt \|\| normalized\.baseRefName !== "dev"/);
  assert.match(source, /GET.*\/repos\/\$\{repoName\(repository\)\}\/pulls\/\$\{pull\.number\}/);
  assert.doesNotMatch(source, /pull\.merged !== true/);
});

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

test("df-plan workflow reacts safely to PRD edits on main", async () => {
  const workflow = await readFile(new URL("../.github/workflows/df-plan.yml", import.meta.url), "utf8");
  const gate = workflow.indexOf("Validate trusted control ref");
  const checkout = workflow.indexOf("Checkout DarkFactory control scripts");
  const token = workflow.indexOf("Mint mp-agents installation token");

  assert.match(workflow, /^\s+push:\s*$/m);
  assert.match(workflow, /^\s+branches:\s*$/m);
  assert.match(workflow, /^\s+-\s+main\s*$/m);
  assert.match(workflow, /PRD\.md/);
  assert.doesNotMatch(workflow, /raw\.githubusercontent\.com|commits\/main|method:\s*'HEAD'/);
  assert.match(workflow, /^\s+workflow_dispatch:\s*$/m);
  assert.match(workflow, /^\s+schedule:\s*$/m);
  assert.match(workflow, /github\.event_name == 'schedule'.*github\.repository == 'marius-patrik\/agent-darkfactory'/);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch'.*github\.repository == 'marius-patrik\/agent-darkfactory'/);
  assert.doesNotMatch(workflow, /actions:\s+write/);
  assert.notEqual(gate, -1);
  assert.notEqual(checkout, -1);
  assert.notEqual(token, -1);
  assert.ok(gate < checkout);
  assert.ok(checkout < token);
  assert.match(workflow, /Resolve DarkFactory script path/);
  assert.match(workflow, /Checkout DarkFactory control scripts/);
  assert.match(workflow, /repository:\s+marius-patrik\/agent-darkfactory/);
  assert.match(workflow, /GITHUB_REPOSITORY_OWNER/);
  assert.match(workflow, /GITHUB_REF_NAME.*main/);
  assert.match(workflow, /GITHUB_REF.*refs\/heads\/main/);
  assert.match(workflow, /path:\s+darkfactory-control/);
  assert.match(workflow, /ref:\s+\$\{\{\s*github\.sha\s*\}\}/);
  assert.match(workflow, /if:\s*github\.event_name != 'push'/);
  assert.match(workflow, /path=\.github\/scripts\/df-plan\.mjs/);
  assert.doesNotMatch(workflow, /ref:\s*\$\{\{.*'main'.*\}\}/);
  assert.doesNotMatch(workflow, /steps\.control-ref\.outputs\.sha|Resolve canonical control ref/);
  assert.match(workflow, /Validate manual planning target ref/);
  assert.match(workflow, /Validate manual planning target repository/);
  assert.match(workflow, /marius-patrik\/fabrica/);
  assert.match(workflow, /must be a marius-patrik repository/);
  assert.match(workflow, /permission-issues:\s+write/);
  assert.doesNotMatch(workflow, /permission-pull-requests:\s+write/);
  assert.doesNotMatch(workflow, /DARK_FACTORY_CONTROL_REF/);
});

test("df-plan queues newly ready PRD issues for the control orchestrator", async () => {
  const source = await readFile(new URL("../.github/scripts/df-plan.mjs", import.meta.url), "utf8");

  assert.match(source, /dispatchIfNewlyReady/);
  assert.match(source, /labelUpdate\.add\.includes\("df:ready"\)/);
  assert.match(source, /await-control-orchestrator/);
  assert.doesNotMatch(source, /actions\/workflows\/df-work\.yml\/dispatches/);
});

test("df-plan preserves PRD sequence references across completed predecessors", async () => {
  const source = await readFile(new URL("../.github/scripts/df-plan.mjs", import.meta.url), "utf8");

  assert.match(source, /let previousIssueNumber = null/);
  assert.match(source, /let previousOpenIssueNumber = null/);
  assert.match(source, /const blockedBy = previousIssueNumber \? \[previousIssueNumber\] : \[\]/);
  assert.match(source, /if \(previousOpenIssueNumber === null\) labels\.push\("df:ready"\)/);
  assert.match(source, /previousIssueNumber = closed\.number/);
  assert.match(source, /previousIssueNumber = existing\.number/);
  assert.match(source, /create-closed-completed-prd-issue/);
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
  assert.match(workflow, /github\.repository == 'marius-patrik\/agent-darkfactory'/);
  assert.match(workflow, /GITHUB_REPOSITORY/);
  assert.match(workflow, /GITHUB_REF_NAME.*main/);
  assert.match(workflow, /GITHUB_REF.*refs\/heads\/main/);
  assert.match(workflow, /permission-contents:\s+write/);
  assert.match(workflow, /permission-issues:\s+write/);
  assert.match(workflow, /permission-pull-requests:\s+write/);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(workflow, /github\.ref_name|DARK_FACTORY_CONTROL_REF/);
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
  assert.match(workflow, /github\.repository == 'marius-patrik\/agent-darkfactory'/);
  assert.match(workflow, /GITHUB_REPOSITORY/);
  assert.match(workflow, /GITHUB_REF_NAME.*main/);
  assert.match(workflow, /GITHUB_REF.*refs\/heads\/main/);
  assert.match(workflow, /actions:\s+write/);
  assert.match(workflow, /permission-contents:\s+write/);
  assert.match(workflow, /permission-issues:\s+write/);
  assert.match(workflow, /permission-pull-requests:\s+write/);
  assert.match(workflow, /permission-actions:\s+write/);
  assert.match(workflow, /permission-workflows:\s+write/);
  assert.doesNotMatch(workflow, /CODEX_AUTH_JSON/);
  assert.doesNotMatch(workflow, /docker|DF_WORKER_IMAGE/);
  assert.match(workflow, /path:\s+darkfactory-control/);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /darkfactory-control\/\.github\/scripts\/df-fix\.mjs/);
});

test("df-fix script is deterministic and uses active managed repos, df-work redispatch, and fresh merge gates", async () => {
  const source = await readFile(new URL("../.github/scripts/df-fix.mjs", import.meta.url), "utf8");

  assert.match(source, /listActiveManagedRepos\(gh, controlRepo, \{ root: CONTROL_ROOT \}\)/);
  assert.match(source, /isDarkFactoryWorkerPullRequest/);
  assert.match(source, /df:fix-round:/);
  assert.match(source, /df:ask-owner/);
  assert.match(source, /df-fix-revision/);
  assert.match(source, /\/actions\/workflows\/df-work\.yml\/dispatches/);
  assert.match(source, /deleteHeadBranch/);
  assert.match(source, /closeSupersededPullRequest/);
  assert.match(source, /const mergeGate = await getPullRequestMergeGate/);
  assert.match(source, /checksAreGreen\(mergeGate\.statusCheckRollup, requiredContexts\)/);
  assert.match(source, /sha: mergeGate\.headRefOid/);
  assert.match(source, /merge_method: "squash"/);
  assert.doesNotMatch(source, /--admin/);
  assert.doesNotMatch(source, /danger-full-access/);
  assert.doesNotMatch(source, /\bcodex\s+exec\b|CODEX_AUTH_JSON|DF_WORKER_IMAGE|codex-home|runCodex|writeCodexAuth|docker\s+run/);
});

test("df-fix merge gate skips when fresh trust predicates fail", async () => {
  const repository = { owner: "marius-patrik", repo: "active" };
  const originalPull = workerPull({ number: 40, checkConclusion: "SUCCESS" });
  const freshPull = {
    ...originalPull,
    isDraft: true,
    mergeable: "MERGEABLE",
    url: "https://github.com/marius-patrik/active/pull/40",
    statusCheckRollup: { contexts: { nodes: originalPull.statusCheckRollup } }
  };
  const gh = {
    graphql: async () => ({ repository: { pullRequest: freshPull } }),
    request: async (method: string, pathName: string) => {
      throw new Error(`unexpected merge-gate request: ${method} ${pathName}`);
    }
  };

  assert.equal(mergeGateTrustFailure(originalPull, { ...originalPull, isDraft: true }, repository), "draft");

  const result = await mergeGreenPullRequest(gh, repository, originalPull, ["ci"], new Set(), "token");
  assert.equal(result.action, "skip");
  assert.equal(result.reason, "merge-trust-failed");
  assert.equal(result.trust_failure, "draft");
});

test("df-fix merge gate fails closed when branch protection is unreadable", async () => {
  const repository = { owner: "marius-patrik", repo: "active" };
  const originalPull = workerPull({ number: 41, checkConclusion: "SUCCESS" });
  const freshPull = {
    ...originalPull,
    mergeable: "MERGEABLE",
    url: "https://github.com/marius-patrik/active/pull/41",
    statusCheckRollup: { contexts: { nodes: originalPull.statusCheckRollup } }
  };
  const gh = {
    graphql: async () => ({ repository: { pullRequest: freshPull } }),
    request: async (method: string, pathName: string) => {
      if (method === "GET" && pathName.endsWith("/branches/dev/protection")) {
        const error: Error & { status?: number } = new Error("Resource not accessible by integration");
        error.status = 403;
        throw error;
      }
      throw new Error(`unexpected merge request: ${method} ${pathName}`);
    }
  };

  assert.deepEqual(
    await getMergeBranchProtectionState(gh, repository, "dev"),
    {
      protected: null,
      unreadable: true,
      status: 403,
      reason: "Resource not accessible by integration"
    }
  );

  const result = await mergeGreenPullRequest(gh, repository, originalPull, ["ci"], new Set(), "token");
  assert.equal(result.action, "skip");
  assert.equal(result.reason, "branch-protection-unreadable");
});

test("df-fix protected branch direct-merges after automerge failure when checks are green", async () => {
  const repository = { owner: "marius-patrik", repo: "active" };
  const originalPull = workerPull({ number: 42, checkConclusion: "SUCCESS" });
  const freshPull = {
    ...originalPull,
    mergeable: "MERGEABLE",
    url: "https://github.com/marius-patrik/active/pull/42",
    statusCheckRollup: { contexts: { nodes: originalPull.statusCheckRollup } }
  };
  const gh = {
    graphql: async (query: string) => {
      if (query.includes("EnableAutoMerge")) {
        throw new Error("Pull request is in clean status");
      }
      return { repository: { pullRequest: freshPull } };
    },
    request: async (method: string, pathName: string) => {
      if (method === "GET" && pathName.endsWith("/branches/dev/protection")) return {};
      if (method === "PUT" && pathName === "/repos/marius-patrik/active/pulls/42/merge") {
        return { sha: "defabc" };
      }
      if (method === "POST" && pathName === "/repos/marius-patrik/active/issues/42/comments") return {};
      if (method === "PATCH" && pathName === "/repos/marius-patrik/active/issues/42") return {};
      throw new Error(`unexpected protected-branch merge request: ${method} ${pathName}`);
    }
  };

  const result = await mergeGreenPullRequest(gh, repository, originalPull, ["ci"], new Set(), "token");
  assert.equal(result.action, "merge");
  assert.equal(result.sha, "defabc");
  assert.notEqual(result.reason, "protected-branch-automerge-failed");
});

test("df-work merge-policy preflight uses direct sweep when branch protection is absent or unreadable", async () => {
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

  assert.equal(unreadablePolicy.useAutomerge, false);
  assert.equal(unreadablePolicy.autoMergeSupported, true);
  assert.equal(unreadablePolicy.branchProtection.configured, false);
  assert.match(unreadablePolicy.summary, /no branch protection on `dev`/);
  assert.match(unreadablePolicy.summary, /green-PR sweep will squash-merge directly after checks/);

  const protectedPolicy = await preflightMergePolicy(
    {
      request: async () => ({ required_status_checks: { contexts: ["validate"] } })
    },
    repository,
    "dev",
    { allow_auto_merge: true }
  );

  assert.equal(protectedPolicy.useAutomerge, true);
  assert.equal(protectedPolicy.branchProtection.configured, true);
});

test("df-work workflow does not expose privileged worker triggers in managed repositories", async () => {
  const workflow = await readFile(new URL("../.github/workflows/df-work.yml", import.meta.url), "utf8");

  assert.doesNotMatch(workflow, /^  issues:/m);
  assert.doesNotMatch(workflow, /^  issue_comment:/m);
  assert.doesNotMatch(workflow, /author_association/);
  assert.match(workflow, /github\.repository == 'marius-patrik\/agent-darkfactory'/);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch'/);
});

test("df-work workflow restricts privileged workers to the control repository", async () => {
  const workflow = await readFile(new URL("../.github/workflows/df-work.yml", import.meta.url), "utf8");

  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /github\.repository == 'marius-patrik\/agent-darkfactory'/);
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
  assert.match(source, /const TOKEN = requiredEnv\("DARK_FACTORY_TOKEN"\)/);
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
    { repository: activeRepository, pull: { ...workerPull({ number: 12, checkConclusion: "FAILURE" }), author: { login: "marius-patrik" } } },
    { repository: parkedRepository, pull: workerPull({ number: 13, checkConclusion: "FAILURE" }) }
  ];

  const fixable = candidates
    .map(({ repository, pull }) => ({ repository, result: classifyFixCandidate(pull, repository, ["ci"], { maxRounds: 3 }) }))
    .filter(({ result }) => result.action === "fix")
    .map(({ repository, result }) => `${repoName(repository)}:${result.pr}`);

  assert.deepEqual(fixable, ["marius-patrik/active:marius-patrik/active#10"]);
});

test("df-fix posts a trusted revision request, closes the red PR, deletes the branch, and redispatches df-work", async () => {
  const controlRepo = { owner: "marius-patrik", repo: "agent-darkfactory" };
  const repository = { owner: "marius-patrik", repo: "active" };
  const pull = workerPull({ number: 10, checkConclusion: "FAILURE" });
  const calls: Array<{ method: string; pathName: string; body?: any }> = [];
  const gh = {
    request: async (method: string, pathName: string, body?: any) => {
      calls.push({ method, pathName, body });
      if (method === "GET" && pathName === "/repos/marius-patrik/active/issues/10") {
        return { number: 10, body: "Issue body", labels: [] };
      }
      if (method === "GET" && pathName === "/repos/marius-patrik/active/issues/10/comments?per_page=100") {
        return [
          {
            body: [
              "<!-- darkfactory-codex-review -->",
              "### Blocking Findings",
              "- fix the trust boundary"
            ].join("\n"),
            updated_at: "2026-07-05T00:00:00Z"
          }
        ];
      }
      if (method === "POST" && pathName === "/repos/marius-patrik/active/labels") return {};
      if (method === "POST" && pathName === "/repos/marius-patrik/active/issues/10/labels") return {};
      if (method === "DELETE" && pathName.startsWith("/repos/marius-patrik/active/issues/10/labels/")) return {};
      if (method === "POST" && pathName === "/repos/marius-patrik/active/issues/10/comments") return {};
      if (method === "PATCH" && pathName === "/repos/marius-patrik/active/pulls/10") return {};
      if (method === "DELETE" && pathName === "/repos/marius-patrik/active/git/refs/heads/df/10-worker") return {};
      if (method === "POST" && pathName === "/repos/marius-patrik/agent-darkfactory/actions/workflows/df-work.yml/dispatches") return {};
      throw new Error(`unexpected mocked request: ${method} ${pathName}`);
    }
  };

  const result = await fixPullRequestByRedispatch(
    gh,
    controlRepo,
    repository,
    pull,
    { action: "fix", reason: "checks-failing", round: 1, maxRounds: 3 },
    ["ci"],
    { maxRounds: 3, token: "token" }
  );

  assert.equal(result.action, "redispatch");
  assert.equal(result.round, 1);
  assert.ok(calls.some((call) => call.method === "POST" && call.pathName === "/repos/marius-patrik/active/issues/10/comments" && call.body.body.includes("<!-- df-fix-revision -->")));
  assert.ok(calls.some((call) => call.method === "PATCH" && call.pathName === "/repos/marius-patrik/active/pulls/10" && call.body.state === "closed"));
  assert.ok(calls.some((call) => call.method === "DELETE" && call.pathName === "/repos/marius-patrik/active/git/refs/heads/df/10-worker"));
  assert.ok(calls.some((call) => call.method === "POST" && call.pathName === "/repos/marius-patrik/agent-darkfactory/actions/workflows/df-work.yml/dispatches" && call.body.inputs.repo === "marius-patrik/active" && call.body.inputs.issue_number === "10"));
});

test("df-fix round cap escalates instead of looping forever", () => {
  const repository = { owner: "marius-patrik", repo: "active" };
  const roundTwo = classifyFixCandidate(
    workerPull({ number: 20, checkConclusion: "FAILURE", labels: [{ name: "df:fix-round:2" }] }),
    repository,
    ["ci"],
    { maxRounds: 3 }
  );
  const roundThree = classifyFixCandidate(
    workerPull({ number: 21, checkConclusion: "FAILURE", labels: [{ name: "df:fix-round:3" }] }),
    repository,
    ["ci"],
    { maxRounds: 3 }
  );

  assert.equal(parseFixRound([{ name: "df:fix-round:2" }], "<!-- df:fix-round:1 -->"), 2);
  assert.equal(roundTwo.action, "fix");
  assert.equal(roundTwo.round, 3);
  assert.equal(roundThree.action, "escalate");
  assert.equal(roundThree.reason, "max-rounds");
});

test("df-fix round cap adds df:ask-owner and does not redispatch", async () => {
  const controlRepo = { owner: "marius-patrik", repo: "agent-darkfactory" };
  const repository = { owner: "marius-patrik", repo: "active" };
  const pull = workerPull({ number: 20, checkConclusion: "FAILURE" });
  const calls: Array<{ method: string; pathName: string; body?: any }> = [];
  const gh = {
    request: async (method: string, pathName: string, body?: any) => {
      calls.push({ method, pathName, body });
      if (method === "GET" && pathName === "/repos/marius-patrik/active/issues/20") {
        return { number: 20, body: "", labels: [{ name: "df:fix-round:3" }] };
      }
      if (method === "GET" && pathName === "/repos/marius-patrik/active/issues/20/comments?per_page=100") return [];
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
    ["ci"],
    { maxRounds: 3, token: "token" }
  );

  assert.equal(result.action, "escalate");
  assert.ok(calls.some((call) => call.method === "POST" && call.pathName === "/repos/marius-patrik/active/issues/20/labels" && call.body.labels.includes("df:ask-owner")));
  assert.equal(calls.some((call) => call.pathName.includes("df-work.yml/dispatches")), false);
  assert.equal(calls.some((call) => call.method === "PATCH" && call.pathName === "/repos/marius-patrik/active/pulls/20"), false);
});

test("df-fix classifies all-green PRs for merge and red PRs for fixing", () => {
  const repository = { owner: "marius-patrik", repo: "active" };
  const green = classifyFixCandidate(workerPull({ number: 30, checkConclusion: "SUCCESS" }), repository, ["ci"]);
  const red = classifyFixCandidate(workerPull({ number: 31, checkConclusion: "FAILURE" }), repository, ["ci"]);
  const pending = classifyFixCandidate(
    workerPull({ number: 32, checkStatus: "IN_PROGRESS", checkConclusion: null }),
    repository,
    ["ci"]
  );

  assert.equal(green.action, "merge");
  assert.equal(red.action, "fix");
  assert.notEqual(red.action, "merge");
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

  assert.match(source, /getRequiredStatusCheckContexts/);
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
  assert.match(source, /NO_CHECK_ALLOWLIST/);
  assert.match(source, /Fresh merge gate check failed immediately before merge/);
  assert.match(source, /checksAreGreen\(mergeGate\.statusCheckRollup\)/);
  assert.doesNotMatch(source, /--admin/);
});

test("df-sweep requires explicit allowlist before merging PRs with no checks", async () => {
  const source = await readFile(new URL("../.github/scripts/df-sweep.mjs", import.meta.url), "utf8");

  assert.match(source, /DF_ALLOW_NO_CHECK_REPOS/);
  assert.match(source, /NO_CHECK_ALLOWLIST/);
  assert.match(source, /no-checks-not-allowed/);
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

test("df-sweep skips open worker PRs whose linked issue is already blocked", async () => {
  const source = await readFile(new URL("../.github/scripts/df-sweep.mjs", import.meta.url), "utf8");

  assert.match(source, /isWorkerIssueBlocked\(repository, issueNumber\)/);
  assert.match(source, /worker-issue-blocked/);
  assert.match(source, /labels\.includes\("df:blocked"\)/);
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
  assert.match(workflow, /permission-actions:\s+write/);
  assert.doesNotMatch(workflow, /permission-workflows:\s+write/);
  assert.match(workflow, /permission-contents:\s+write/);
  assert.match(workflow, /permission-issues:\s+write/);
});

test("df-orchestrate script uses the active managed registry and dispatches via workflow_dispatch", async () => {
  const source = await readFile(new URL("../.github/scripts/df-orchestrate.mjs", import.meta.url), "utf8");

  assert.match(source, /const CONTROL_ROOT = path\.resolve/);
  assert.match(source, /listActiveManagedRepos\(gh, CONTROL_REPO, \{ root: CONTROL_ROOT \}\)/);
  assert.match(source, /\/repos\/\$\{repoName\(CONTROL_REPO\)\}\/actions\/workflows\/df-work\.yml\/dispatches/);
  assert.match(source, /\/df-prd:/);
  assert.match(source, /df:running/);
  assert.match(source, /df:blocked/);
  assert.match(source, /df:done/);
});

test("df-orchestrate claims ready issues before dispatching workers", async () => {
  const source = await readFile(new URL("../.github/scripts/df-orchestrate.mjs", import.meta.url), "utf8");

  const claimIndex = source.indexOf("replaceIssueLabels(repository, issueNumber, [\"df:running\"], [\"df:ready\"])");
  const dispatchIndex = source.indexOf("/actions/workflows/df-work.yml/dispatches");
  assert.notEqual(claimIndex, -1);
  assert.notEqual(dispatchIndex, -1);
  assert.ok(claimIndex < dispatchIndex);
});

test("df-orchestrate restores df:ready when workflow dispatch fails", async () => {
  const source = await readFile(new URL("../.github/scripts/df-orchestrate.mjs", import.meta.url), "utf8");

  const dispatchIndex = source.indexOf("/actions/workflows/df-work.yml/dispatches");
  const restoreIndex = source.indexOf("replaceIssueLabels(repository, issueNumber, [\"df:ready\"], [\"df:running\"])");
  assert.notEqual(dispatchIndex, -1);
  assert.notEqual(restoreIndex, -1);
  assert.ok(dispatchIndex < restoreIndex);
});

function workerPull(options: {
  number: number;
  checkConclusion: string | null;
  checkStatus?: string;
  labels?: Array<{ name: string }>;
}) {
  return {
    id: `PR_${options.number}`,
    number: options.number,
    title: `Worker PR ${options.number}`,
    body: `<!-- dark-factory:worker-pr issue=${options.number} -->\n\nCloses #${options.number}`,
    author: { login: "mp-agents[bot]" },
    headRefName: `df/${options.number}-worker`,
    headRepository: { owner: { login: "marius-patrik" }, name: "active" },
    baseRefName: "dev",
    isDraft: false,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    labels: options.labels || [],
    statusCheckRollup: [
      {
        __typename: "CheckRun",
        name: "ci",
        status: options.checkStatus || "COMPLETED",
        conclusion: options.checkConclusion
      }
    ]
  };
}
