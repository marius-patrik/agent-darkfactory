import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCleanPlan,
  planSetupConvergence,
  verifyCleanPlanAdmission,
  type CleanBranchEvidence,
  type CleanEvidence,
  type DoctorReport
} from "../src/operator.js";

function report(findings: DoctorReport["findings"]): DoctorReport {
  return {
    schema_version: 2,
    target_repository: "marius-patrik/example",
    lifecycle: "active",
    source_refs: { main: "main-sha", dev: "dev-sha" },
    findings
  };
}

test("setup plan orders trusted convergence stages and preserves owner residue", () => {
  const plan = planSetupConvergence([report([
    { id: "root-prd-missing", category: "PRD drift", message: "missing", severity: "error", repair_class: "pr" },
    { id: "runner-health", category: "runner health", message: "offline", severity: "critical", repair_class: "auto" },
    { id: "required-secret-key-missing", category: "configuration prerequisites", message: "owner secret", severity: "critical", repair_class: "owner" },
    { id: "label-df-ready-missing", category: "configuration prerequisites", message: "label", severity: "error", repair_class: "auto" },
    { id: "protection-main-strict-missing", category: "branch protection", message: "strict", severity: "critical", repair_class: "auto" }
  ])]);

  assert.deepEqual(plan.actions.map((action) => action.stage), [
    "machine-wiring",
    "settings-enforcement",
    "settings-enforcement",
    "issue-lane-cut"
  ]);
  assert.deepEqual(plan.residue.map((item) => [item.findingId, item.repairClass]), [
    ["required-secret-key-missing", "owner"],
    ["runner-health", "blocked"]
  ]);
});

test("setup routes all machine-runtime deltas to the blocked machine-wiring boundary", () => {
  const plan = planSetupConvergence([report([{
    id: "provider-route-probe-unavailable",
    category: "machine runtime",
    message: "route probe missing",
    severity: "critical",
    repair_class: "auto"
  }])]);

  assert.deepEqual(plan.actions.map((action) => ({
    stage: action.stage,
    operation: action.operation,
    supported: action.supported
  })), [{ stage: "machine-wiring", operation: "converge-machine-runtime", supported: false }]);
  assert.deepEqual(plan.residue.map((item) => [item.findingId, item.repairClass]), [["provider-route-probe-unavailable", "blocked"]]);
});

test("clean plan deletes only exact independently preserved branch heads", () => {
  const safe = branch({
    name: "merged-feature",
    head: "feature-sha",
    tree: "feature-tree",
    containedBy: ["main"],
    treeEquivalentTo: []
  });
  const plan = buildCleanPlan(evidence([safe]), new Date("2026-07-15T00:00:00Z"));

  assert.deepEqual(plan.entries.map((entry) => [entry.target, entry.classification, entry.action]), [
    ["merged-feature", "proven-merged", "delete"]
  ]);
});

test("clean plan removes a clean worktree only when its exact head is independently preserved", () => {
  const safe = branch({
    name: "merged-worktree",
    containedBy: ["dev"],
    worktrees: [{ pathId: "wt-safe", branch: "merged-worktree", head: "merged-worktree-sha", dirty: false, untracked: false, submoduleDirty: false }]
  });
  const plan = buildCleanPlan(evidence([safe]), new Date("2026-07-15T00:00:00Z"));

  assert.deepEqual(plan.entries.map((entry) => [entry.kind, entry.action]), [
    ["remote-branch", "delete"],
    ["worktree", "remove"]
  ]);
});

test("clean plan never targets the explicitly supplied root checkout", () => {
  const safe = branch({
    name: "merged-root",
    containedBy: ["dev"],
    worktrees: [{ pathId: "wt-root", branch: "merged-root", head: "merged-root-sha", dirty: false, untracked: false, submoduleDirty: false, rootCheckout: true }]
  });
  const plan = buildCleanPlan(evidence([safe], {
    orphanRefs: [{
      ref: "refs/df/root-evidence",
      head: "merged-root-sha",
      tree: "merged-root-tree",
      independentlyPreservedBy: ["branch:dev"],
      worktree: safe.worktrees[0],
      cleanupCandidate: true
    }]
  }), new Date("2026-07-15T00:00:00Z"));

  assert.ok(plan.entries.some((entry) => entry.kind === "remote-branch" && entry.target === "merged-root" && entry.action === "preserve" && entry.classification === "active-worktree"));
  assert.ok(plan.entries.some((entry) => entry.kind === "worktree" && entry.target === "wt-root" && entry.action === "preserve" && entry.classification === "active-worktree"));
  assert.ok(plan.entries.some((entry) => entry.kind === "orphan-ref" && entry.target === "refs/df/root-evidence" && entry.action === "preserve"));
});

test("clean plan preserves dirty, unpublished, open-PR, and ambiguous human work", () => {
  const branches = [
    branch({ name: "dirty", worktrees: [{ pathId: "wt-dirty", branch: "dirty", head: "dirty-sha", dirty: true, untracked: false, submoduleDirty: false }] }),
    branch({ name: "unpublished", localUnpublished: true }),
    branch({ name: "review", openPullRequest: 7 }),
    branch({ name: "unknown" })
  ];
  const plan = buildCleanPlan(evidence(branches), new Date("2026-07-15T00:00:00Z"));
  const remoteEntries = plan.entries.filter((entry) => entry.kind === "remote-branch");

  assert.deepEqual(remoteEntries.map((entry) => [entry.target, entry.classification, entry.action]), [
    ["dirty", "dirty-worktree", "preserve"],
    ["review", "open-pr", "preserve"],
    ["unknown", "ambiguous", "preserve"],
    ["unpublished", "unpublished", "preserve"]
  ]);
});

test("clean plan enumerates and removes only independently preserved local branches", () => {
  const plan = buildCleanPlan(evidence([], {
    localBranches: [
      branch({ name: "merged-local", containedBy: ["dev"] }),
      branch({ name: "unpublished-local", localUnpublished: true }),
      branch({ name: "dirty-local", worktrees: [{ pathId: "wt-local", branch: "dirty-local", head: "dirty-local-sha", dirty: false, untracked: true, submoduleDirty: false }] })
    ]
  }), new Date("2026-07-15T00:00:00Z"));

  assert.deepEqual(plan.entries.filter((entry) => entry.kind === "local-branch").map((entry) => [entry.target, entry.classification, entry.action]), [
    ["dirty-local", "dirty-worktree", "preserve"],
    ["merged-local", "proven-merged", "delete"],
    ["unpublished-local", "unpublished", "preserve"]
  ]);
  assert.ok(plan.entries.some((entry) => entry.kind === "worktree" && entry.target === "wt-local" && entry.action === "preserve"));
});

test("clean plan classifies every open PR and issue while preserving review records", () => {
  const plan = buildCleanPlan(evidence([], {
    pullRequests: [
      { number: 3, head: "pr-3", classification: "active", findingIds: [] },
      { number: 4, head: "pr-4", classification: "red", findingIds: ["pr-4-red"] }
    ],
    issues: [
      { number: 7, fingerprint: "issue-7", classification: "current", findingIds: [] },
      { number: 8, fingerprint: "issue-8", classification: "finding", findingIds: ["issue-8-blocker-2-missing"] }
    ],
    reviewFindings: [{ id: "issue-8-blocker-2-missing", category: "issue lane", severity: "error", repairClass: "pr", message: "Issue #8 names a missing blocker.", evidence: [], fingerprint: "finding-8" }]
  }), new Date("2026-07-15T00:00:00Z"));

  assert.deepEqual(plan.entries.filter((entry) => entry.kind === "pull-request").map((entry) => [entry.target, entry.classification, entry.action]), [
    ["#3", "active", "preserve"],
    ["#4", "red", "preserve"]
  ]);
  assert.deepEqual(plan.entries.filter((entry) => entry.kind === "issue").map((entry) => [entry.target, entry.classification]), [
    ["#7", "current"],
    ["#8", "finding"]
  ]);
  assert.ok(plan.entries.some((entry) => entry.kind === "lane-finding" && entry.target === "issue-8-blocker-2-missing"));
  assert.equal(plan.entries.every((entry) => !["pull-request", "issue", "lane-finding"].includes(entry.kind) || entry.action === "preserve"), true);
});

test("clean apply admission aborts when any observed fact drifts", () => {
  const original = buildCleanPlan(evidence([branch({ name: "merged", containedBy: ["main"] })]), new Date("2026-07-15T00:00:00Z"));
  const drifted = buildCleanPlan(evidence([branch({ name: "merged", head: "new-head", containedBy: ["main"] })]), new Date("2026-07-15T00:01:00Z"));

  assert.throws(() => verifyCleanPlanAdmission(original, drifted), /evidence drifted/);
});

function branch(overrides: Partial<CleanBranchEvidence>): CleanBranchEvidence {
  return {
    name: "feature",
    head: `${overrides.name || "feature"}-sha`,
    tree: `${overrides.name || "feature"}-tree`,
    protected: false,
    policyBranch: false,
    openPullRequest: null,
    mergedPullRequest: null,
    mergedPullHead: null,
    containedBy: [],
    treeEquivalentTo: [],
    localAhead: null,
    localUnpublished: false,
    worktrees: [],
    ...overrides
  };
}

function evidence(branches: CleanBranchEvidence[], overrides: Partial<CleanEvidence> = {}): CleanEvidence {
  return {
    repository: "marius-patrik/example",
    defaultBranch: "main",
    observedRefs: { main: "main-sha", dev: "dev-sha" },
    branches,
    localBranches: [],
    orphanRefs: [],
    detachedWorktrees: [],
    pullRequests: [],
    issues: [],
    reviewFindings: [],
    pullRequestFingerprint: "prs-v1",
    issueLaneFingerprint: "issues-v1",
    prdFingerprint: "prd-v1",
    ...overrides
  };
}
