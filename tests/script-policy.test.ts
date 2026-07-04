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
  isParkedRepo,
  parsePrdItems,
  prdIssueBody,
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

test("cleanupTempRoot reports cleanup failures without throwing", async () => {
  const warnings: string[] = [];
  const result = await cleanupTempRoot("\0", (warning: string) => warnings.push(warning));

  assert.equal(result.ok, false);
  assert.equal(warnings.length, 1);
  assert.match(result.warning, /cleanup warning/i);
});

test("checksAreGreen allows no checks and rejects pending or failing checks", () => {
  assert.equal(checksAreGreen([]), true);
  assert.equal(checksAreGreen([{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }]), true);
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
  assert.match(source, /dark-factory:worker-pr\\s\+issue=/);
  assert.match(source, /botAuthor/);
  assert.match(source, /branchMatchesIssue/);
  assert.match(source, /bodyClosesIssue/);
  assert.match(source, /extractClosingIssueNumbers\(pull\.body \|\| "", repoName\(repository\)\)/);
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

test("df-plan workflow avoids push-triggered write-token execution", async () => {
  const workflow = await readFile(new URL("../.github/workflows/df-plan.yml", import.meta.url), "utf8");
  const gate = workflow.indexOf("Validate trusted control ref");
  const checkout = workflow.indexOf("Checkout DarkFactory from this repository");
  const token = workflow.indexOf("Mint mp-agents installation token");

  assert.doesNotMatch(workflow, /^\s+push:\s*$/m);
  assert.match(workflow, /^\s+workflow_dispatch:\s*$/m);
  assert.match(workflow, /^\s+schedule:\s*$/m);
  assert.notEqual(gate, -1);
  assert.notEqual(checkout, -1);
  assert.notEqual(token, -1);
  assert.ok(gate < token);
  assert.ok(checkout < token);
  assert.match(workflow, /GITHUB_REPOSITORY/);
  assert.match(workflow, /GITHUB_REF_NAME.*main/);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(workflow, /\bdev\b|github\.ref_name|DARK_FACTORY_CONTROL_REF/);
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
  assert.match(workflow, /GITHUB_REPOSITORY/);
  assert.match(workflow, /GITHUB_REF_NAME.*main/);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(workflow, /\bdev\b|github\.ref_name|DARK_FACTORY_CONTROL_REF/);
});

test("df-work records auto-merge support during merge-policy preflight", async () => {
  const source = await readFile(new URL("../.github/scripts/df-work.mjs", import.meta.url), "utf8");

  assert.match(source, /const autoMergeSupported = repo\.allow_auto_merge === true/);
  assert.match(source, /autoMergeSupported/);
  assert.match(source, /repository auto-merge is disabled/);
});

test("df-sweep waits before treating empty check rollups as no-checks-configured", async () => {
  const source = await readFile(new URL("../.github/scripts/df-sweep.mjs", import.meta.url), "utf8");

  assert.match(source, /EMPTY_CHECK_SETTLE_MS/);
  assert.match(source, /emptyCheckRollupHasSettled\(pull\)/);
  assert.match(source, /checks-not-reported-yet/);
});
