import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  applyCleanPlan,
  collectCleanEvidence,
  type OperatorGitHubRequester
} from "../src/clean-evidence.js";
import { buildCleanPlan, type CleanEvidence } from "../src/operator.js";

test("clean evidence binds the checkout identity and preserves detached worktrees and non-cleanup refs", async () => {
  const parent = await mkdtemp(join(tmpdir(), "df-clean-evidence-"));
  const root = join(parent, "repo");
  const detached = join(parent, "detached");
  await mkdir(root);

  try {
    git(root, ["init", "--initial-branch=main"]);
    git(root, ["config", "user.name", "DarkFactory Test"]);
    git(root, ["config", "user.email", "darkfactory@example.invalid"]);
    await writeFile(join(root, "README.md"), "# fixture\n");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-m", "fixture"]);
    git(root, ["remote", "add", "origin", "https://github.com/marius-patrik/example.git"]);
    git(root, ["branch", "dev"]);
    const head = git(root, ["rev-parse", "HEAD"]).trim();
    const tree = git(root, ["rev-parse", "HEAD^{tree}"]).trim();
    git(root, ["update-ref", "refs/df/export", head]);
    git(root, ["update-ref", "refs/remotes/origin/main", head]);
    git(root, ["tag", "v1"]);
    git(root, ["worktree", "add", "--detach", detached, head]);

    const github = cleanEvidenceGithub(head, tree);
    const evidence = await collectCleanEvidence(github, { owner: "marius-patrik", repo: "example" }, root);
    const plan = buildCleanPlan(evidence, new Date("2026-07-15T00:00:00Z"));

    assert.equal(evidence.detachedWorktrees.length, 1);
    assert.equal(evidence.detachedWorktrees[0]?.head, head);
    assert.equal(plan.entries.some((entry) => entry.kind === "worktree" && entry.target === evidence.detachedWorktrees[0]?.pathId && entry.action === "preserve"), true);
    assert.equal(plan.entries.some((entry) => entry.kind === "local-branch" && entry.target === "dev" && entry.classification === "protected-policy" && entry.action === "preserve"), true);
    assert.equal(plan.entries.some((entry) => entry.kind === "orphan-ref" && entry.target === "refs/df/export" && entry.action === "delete"), true);
    assert.equal(plan.entries.some((entry) => entry.kind === "orphan-ref" && entry.target === "refs/tags/v1" && entry.action === "preserve"), true);
    assert.equal(plan.entries.some((entry) => entry.kind === "orphan-ref" && entry.target === "refs/remotes/origin/main" && entry.action === "preserve"), true);

    await assert.rejects(
      collectCleanEvidence(github, { owner: "marius-patrik", repo: "wrong" }, root),
      /local checkout identity mismatch/
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("clean apply records an admission before each mutation and a completion only afterward", async () => {
  const evidence = remoteDeletionEvidence();
  const plan = buildCleanPlan(evidence, new Date("2026-07-15T00:00:00Z"));
  const events: string[] = [];
  const github: OperatorGitHubRequester = {
    async request(route) {
      if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") {
        events.push("refetch");
        return { data: { object: { sha: "feature-sha" } } };
      }
      if (route === "DELETE /repos/{owner}/{repo}/git/refs/{ref}") {
        events.push("delete");
        return { data: {} };
      }
      throw new Error(`unexpected route ${route}`);
    }
  };

  await applyCleanPlan(github, { owner: "marius-patrik", repo: "example" }, plan, evidence, {
    onAdmission: async () => { events.push("admission"); },
    onCompletion: async () => { events.push("completion"); }
  });

  assert.deepEqual(events, ["refetch", "admission", "delete", "completion"]);
});

test("clean apply aborts before mutation when durable admission cannot be written", async () => {
  const evidence = remoteDeletionEvidence();
  const plan = buildCleanPlan(evidence, new Date("2026-07-15T00:00:00Z"));
  let deleted = false;
  const github: OperatorGitHubRequester = {
    async request(route) {
      if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") return { data: { object: { sha: "feature-sha" } } };
      if (route === "DELETE /repos/{owner}/{repo}/git/refs/{ref}") {
        deleted = true;
        return { data: {} };
      }
      throw new Error(`unexpected route ${route}`);
    }
  };

  await assert.rejects(
    applyCleanPlan(github, { owner: "marius-patrik", repo: "example" }, plan, evidence, {
      onAdmission: async () => { throw new Error("ledger unavailable"); }
    }),
    /ledger unavailable/
  );
  assert.equal(deleted, false);
});

function cleanEvidenceGithub(head: string, tree: string): OperatorGitHubRequester {
  return {
    async request(route, parameters) {
      if (route === "GET /repos/{owner}/{repo}") return { data: { default_branch: "main" } };
      if (route === "GET /repos/{owner}/{repo}/branches") {
        return { data: parameters.page === 1 ? [{ name: "main", protected: true, commit: { sha: head } }] : [] };
      }
      if (route === "GET /repos/{owner}/{repo}/pulls") return { data: [] };
      if (route === "GET /repos/{owner}/{repo}/issues") return { data: [] };
      if (route === "GET /repos/{owner}/{repo}/git/commits/{commit_sha}") return { data: { tree: { sha: tree } } };
      if (route === "GET /repos/{owner}/{repo}/contents/{path}") throw Object.assign(new Error("missing"), { status: 404 });
      throw new Error(`unexpected route ${route}`);
    }
  };
}

function remoteDeletionEvidence(): CleanEvidence {
  return {
    repository: "marius-patrik/example",
    defaultBranch: "main",
    observedRefs: { main: "main-sha" },
    branches: [{
      name: "feature",
      head: "feature-sha",
      tree: "feature-tree",
      protected: false,
      policyBranch: false,
      openPullRequest: null,
      mergedPullRequest: null,
      mergedPullHead: null,
      containedBy: ["main"],
      treeEquivalentTo: [],
      localAhead: null,
      localUnpublished: false,
      worktrees: []
    }],
    localBranches: [],
    orphanRefs: [],
    detachedWorktrees: [],
    pullRequests: [],
    issues: [],
    reviewFindings: [],
    pullRequestFingerprint: "prs-v1",
    issueLaneFingerprint: "issues-v1",
    prdFingerprint: "prd-v1"
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
}
