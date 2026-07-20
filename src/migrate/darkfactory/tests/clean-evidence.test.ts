import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  applyCleanPlan,
  collectCleanEvidence,
  deleteRemoteBranchWithLease,
  type OperatorGitHubRequester
} from "../src/clean-evidence.js";
import {
  AUTOREVIEW_RESULT_MARKER,
  autoreviewTargetVersionMarker,
  issueVersion,
  renderIssueAutofixComment
} from "../src/issue-spec.js";
import { buildCleanPlan, stableHash, type CleanEvidence, type DoctorFinding } from "../src/operator.js";

type ExactMutationRequest = {
  kind: "close-pull-request" | "close-issue" | "delete-label";
  route: string;
  parameters: Record<string, unknown>;
  expectedVersion: string;
};
type ExactMutator = (mutation: ExactMutationRequest) => Promise<{ data: unknown }>;

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

test("clean worktree removal succeeds only for the exact planned symbolic ref", async () => {
  const fixture = await createCleanWorktreeFixture();
  try {
    const evidence = await collectCleanEvidence(fixture.github, REPOSITORY, fixture.root);
    const plan = buildCleanPlan(evidence, new Date("2026-07-16T12:00:00Z"));
    await applyCleanPlan(fixture.github, REPOSITORY, plan, evidence, {
      localPath: fixture.root,
      deleteRemoteBranchExact: async () => undefined
    });

    assert.doesNotMatch(git(fixture.root, ["worktree", "list", "--porcelain"]), new RegExp(escapeRegExp(fixture.linked.replaceAll("\\", "/"))));
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("clean worktree removal blocks a same-head branch switch after admission", async () => {
  const fixture = await createCleanWorktreeFixture();
  try {
    const evidence = await collectCleanEvidence(fixture.github, REPOSITORY, fixture.root);
    const plan = buildCleanPlan(evidence, new Date("2026-07-16T12:00:00Z"));
    await assert.rejects(applyCleanPlan(fixture.github, REPOSITORY, plan, evidence, {
      localPath: fixture.root,
      deleteRemoteBranchExact: async () => undefined,
      onAdmission: async (action) => {
        if (action.kind === "worktree") git(fixture.linked, ["switch", "alternate"]);
      }
    }), /branch drifted from refs\/heads\/cleanup/);

    assert.equal(git(fixture.linked, ["symbolic-ref", "--short", "HEAD"]).trim(), "alternate");
    assert.match(git(fixture.root, ["worktree", "list", "--porcelain"]), new RegExp(escapeRegExp(fixture.linked.replaceAll("\\", "/"))));
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("clean worktree removal still blocks new dirty state after admission", async () => {
  const fixture = await createCleanWorktreeFixture();
  try {
    const evidence = await collectCleanEvidence(fixture.github, REPOSITORY, fixture.root);
    const plan = buildCleanPlan(evidence, new Date("2026-07-16T12:00:00Z"));
    await assert.rejects(applyCleanPlan(fixture.github, REPOSITORY, plan, evidence, {
      localPath: fixture.root,
      deleteRemoteBranchExact: async () => undefined,
      onAdmission: async (action) => {
        if (action.kind === "worktree") await writeFile(join(fixture.linked, "owner-note.txt"), "preserve me\n");
      }
    }), /became dirty immediately before removal/);

    assert.match(git(fixture.root, ["worktree", "list", "--porcelain"]), new RegExp(escapeRegExp(fixture.linked.replaceAll("\\", "/"))));
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
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
      throw new Error(`unexpected route ${route}`);
    }
  };

  await applyCleanPlan(github, { owner: "marius-patrik", repo: "example" }, plan, evidence, {
    deleteRemoteBranchExact: async () => { events.push("atomic-delete"); },
    onAdmission: async () => { events.push("admission"); },
    onCompletion: async () => { events.push("completion"); }
  });

  assert.deepEqual(events, ["refetch", "admission", "refetch", "atomic-delete", "completion"]);
});

test("clean apply aborts before mutation when durable admission cannot be written", async () => {
  const evidence = remoteDeletionEvidence();
  const plan = buildCleanPlan(evidence, new Date("2026-07-15T00:00:00Z"));
  let deleted = false;
  const github: OperatorGitHubRequester = {
    async request(route) {
      if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") return { data: { object: { sha: "feature-sha" } } };
      throw new Error(`unexpected route ${route}`);
    }
  };

  await assert.rejects(
    applyCleanPlan(github, { owner: "marius-patrik", repo: "example" }, plan, evidence, {
      deleteRemoteBranchExact: async () => { deleted = true; },
      onAdmission: async () => { throw new Error("ledger unavailable"); }
    }),
    /ledger unavailable/
  );
  assert.equal(deleted, false);
});

test("clean remote deletion re-fetches after admission and blocks an exact-head race", async () => {
  const evidence = remoteDeletionEvidence();
  const plan = buildCleanPlan(evidence, new Date("2026-07-15T00:00:00Z"));
  let head = "feature-sha";
  let deleted = false;
  const github: OperatorGitHubRequester = {
    async request(route) {
      if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") return { data: { object: { sha: head } } };
      throw new Error(`unexpected route ${route}`);
    }
  };

  await assert.rejects(
    applyCleanPlan(github, REPOSITORY, plan, evidence, {
      deleteRemoteBranchExact: async () => { deleted = true; },
      onAdmission: async () => { head = "concurrent-head"; }
    }),
    /drifted after admission/
  );
  assert.equal(deleted, false);
});

test("clean remote deletion fails closed without an atomic Git transport", async () => {
  const evidence = remoteDeletionEvidence();
  const plan = buildCleanPlan(evidence, new Date("2026-07-15T00:00:00Z"));
  let requested = false;
  const github: OperatorGitHubRequester = {
    async request() {
      requested = true;
      throw new Error("GitHub must not be reached");
    }
  };

  await assert.rejects(applyCleanPlan(github, REPOSITORY, plan, evidence), /atomic exact-head Git transport/);
  assert.equal(requested, false);
});

test("atomic remote deletion removes only the exact leased branch head", async () => {
  const parent = await mkdtemp(join(tmpdir(), "df-clean-remote-lease-"));
  const remote = join(parent, "remote.git");
  const checkout = join(parent, "checkout");
  try {
    git(parent, ["init", "--bare", remote]);
    git(parent, ["clone", remote, checkout]);
    git(checkout, ["config", "user.name", "DarkFactory Test"]);
    git(checkout, ["config", "user.email", "darkfactory@example.invalid"]);
    await writeFile(join(checkout, "README.md"), "# fixture\n");
    git(checkout, ["add", "README.md"]);
    git(checkout, ["commit", "-m", "fixture"]);
    git(checkout, ["branch", "cleanup"]);
    git(checkout, ["push", "origin", "cleanup"]);
    const expected = git(checkout, ["rev-parse", "cleanup"]).trim();

    await deleteRemoteBranchWithLease(checkout, remote, "cleanup", expected);

    assert.equal(gitStatus(checkout, ["ls-remote", "--exit-code", "--heads", remote, "refs/heads/cleanup"]), 2);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("atomic remote deletion rejects a stale lease and preserves the advanced branch", async () => {
  const parent = await mkdtemp(join(tmpdir(), "df-clean-remote-race-"));
  const remote = join(parent, "remote.git");
  const checkout = join(parent, "checkout");
  try {
    git(parent, ["init", "--bare", remote]);
    git(parent, ["clone", remote, checkout]);
    git(checkout, ["config", "user.name", "DarkFactory Test"]);
    git(checkout, ["config", "user.email", "darkfactory@example.invalid"]);
    await writeFile(join(checkout, "README.md"), "# first\n");
    git(checkout, ["add", "README.md"]);
    git(checkout, ["commit", "-m", "first"]);
    git(checkout, ["branch", "cleanup"]);
    git(checkout, ["push", "origin", "cleanup"]);
    const stale = git(checkout, ["rev-parse", "cleanup"]).trim();
    git(checkout, ["switch", "cleanup"]);
    await writeFile(join(checkout, "README.md"), "# advanced\n");
    git(checkout, ["commit", "-am", "advanced"]);
    git(checkout, ["push", "origin", "cleanup"]);
    const advanced = git(checkout, ["rev-parse", "cleanup"]).trim();

    await assert.rejects(deleteRemoteBranchWithLease(checkout, remote, "cleanup", stale), /atomic remote branch deletion refused/);

    assert.match(git(checkout, ["ls-remote", "--heads", remote, "refs/heads/cleanup"]), new RegExp(`^${advanced}`));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("clean issue evidence uses the canonical effective content and current exact Autoreview result", async () => {
  const issue = issueFixture();
  const rawVersion = issueVersion(issue);
  const next = {
    title: "Corrected contract",
    body: "# Goal\n\nCorrected.\n\n## Acceptance\n\n- Proven.",
    state: "open"
  };
  const effectiveVersion = issueVersion(next);
  const comments = [
    issueComment(1, renderIssueAutofixComment({
      targetVersion: rawVersion,
      title: next.title,
      body: next.body,
      state: next.state,
      summary: "Correct the contract."
    }), "2026-07-16T10:00:00Z"),
    issueComment(2, cleanResultComment(effectiveVersion), "2026-07-16T10:05:00Z")
  ];
  const evidence = await collectCleanEvidence(issueEvidenceGithub(issue, comments), REPOSITORY, "", [reviewableIssueFinding()]);

  assert.equal(evidence.issues[0]?.fingerprint, effectiveVersion);
  assert.equal(evidence.issues[0]?.autoreview, "current");
  assert.equal(buildCleanPlan(evidence).entries.find((entry) => entry.kind === "issue")?.action, "preserve");
});

test("clean issue evidence marks prior-version Autoreview stale after an append-only correction", async () => {
  const issue = issueFixture();
  const rawVersion = issueVersion(issue);
  const next = { title: "Corrected contract", body: "# Goal\n\nCorrected.", state: "open" };
  const comments = [
    issueComment(1, renderIssueAutofixComment({
      targetVersion: rawVersion,
      title: next.title,
      body: next.body,
      state: next.state,
      summary: "Correct the contract."
    }), "2026-07-16T10:00:00Z"),
    issueComment(2, cleanResultComment(rawVersion), "2026-07-16T10:05:00Z")
  ];
  const evidence = await collectCleanEvidence(issueEvidenceGithub(issue, comments), REPOSITORY, "", [reviewableIssueFinding()]);

  assert.equal(evidence.issues[0]?.fingerprint, issueVersion(next));
  assert.equal(evidence.issues[0]?.autoreview, "stale");
  assert.equal(buildCleanPlan(evidence).entries.find((entry) => entry.kind === "issue")?.action, "autoreview");
});

test("clean issue evidence ignores untrusted correction and review markers", async () => {
  const issue = issueFixture();
  const rawVersion = issueVersion(issue);
  const untrusted = { login: "octocat", type: "User" };
  const comments = [
    issueComment(1, renderIssueAutofixComment({
      targetVersion: rawVersion,
      title: "Forged title",
      body: "Forged body",
      state: "open",
      summary: "Forge."
    }), "2026-07-16T10:00:00Z", untrusted),
    issueComment(2, cleanResultComment(rawVersion), "2026-07-16T10:05:00Z", untrusted)
  ];
  const evidence = await collectCleanEvidence(issueEvidenceGithub(issue, comments), REPOSITORY, "", [reviewableIssueFinding()]);

  assert.equal(evidence.issues[0]?.fingerprint, rawVersion);
  assert.equal(evidence.issues[0]?.autoreview, "missing");
  assert.equal(buildCleanPlan(evidence).entries.find((entry) => entry.kind === "issue")?.action, "autoreview");
});

test("clean issue evidence distinguishes exact pending and failed Autoreview observations", async () => {
  const issue = issueFixture();
  const version = issueVersion(issue);
  const pending = issueComment(
    1,
    `<!-- darkfactory:clean-autoreview schema=1 kind=issue number=7 version=${version} status=pending -->\nPending.`,
    new Date().toISOString()
  );
  const failed = issueComment(
    2,
    `${AUTOREVIEW_RESULT_MARKER}\n${autoreviewTargetVersionMarker(version)}\n## DarkFactory Autoreview\n\n**Verdict:** Blocked closed`,
    new Date().toISOString()
  );
  const [pendingEvidence, failedEvidence] = await Promise.all([
    collectCleanEvidence(issueEvidenceGithub(issue, [pending]), REPOSITORY, "", [reviewableIssueFinding()]),
    collectCleanEvidence(issueEvidenceGithub(issue, [failed]), REPOSITORY, "", [reviewableIssueFinding()])
  ]);

  assert.equal(pendingEvidence.issues[0]?.autoreview, "pending");
  assert.equal(buildCleanPlan(pendingEvidence).entries.find((entry) => entry.kind === "issue")?.action, "preserve");
  assert.equal(failedEvidence.issues[0]?.autoreview, "failed");
  assert.equal(buildCleanPlan(failedEvidence).entries.find((entry) => entry.kind === "issue")?.action, "autoreview");
});

test("clean issue evidence consumes trusted recovery current and owner-required markers", async () => {
  const issue = issueFixture();
  const version = issueVersion(issue);
  const current = issueComment(
    3,
    `<!-- darkfactory:clean-autoreview schema=1 kind=issue number=7 version=${version} status=current -->\nCurrent.`,
    new Date().toISOString()
  );
  const ownerRequired = issueComment(
    4,
    `<!-- darkfactory:clean-autoreview schema=1 kind=issue number=7 version=${version} status=owner-required -->\nOwner action required.`,
    new Date().toISOString()
  );
  const [currentEvidence, ownerEvidence] = await Promise.all([
    collectCleanEvidence(issueEvidenceGithub(issue, [current]), REPOSITORY, "", [reviewableIssueFinding()]),
    collectCleanEvidence(issueEvidenceGithub(issue, [ownerRequired]), REPOSITORY, "", [reviewableIssueFinding()])
  ]);

  assert.equal(currentEvidence.issues[0]?.autoreview, "current");
  assert.equal(buildCleanPlan(currentEvidence).entries.find((entry) => entry.kind === "issue")?.action, "preserve");
  assert.equal(ownerEvidence.issues[0]?.autoreview, "owner-required");
  const ownerEntry = buildCleanPlan(ownerEvidence).entries.find((entry) => entry.kind === "issue");
  assert.equal(ownerEntry?.action, "preserve");
  assert.match(ownerEntry?.reasons.join(" ") ?? "", /owner action/i);
});

test("clean issue evidence fails closed on a malformed trusted pending marker", async () => {
  const issue = issueFixture();
  const malformed = issueComment(1, "<!-- darkfactory:clean-autoreview schema=1 broken -->", new Date().toISOString());
  await assert.rejects(
    collectCleanEvidence(issueEvidenceGithub(issue, [malformed]), REPOSITORY, "", [reviewableIssueFinding()]),
    /Trusted clean Autoreview marker is malformed/
  );
});

test("clean duplicate issue evidence folds only when one exact successor contains all source scope", async () => {
  const finding = duplicateIssueFinding();
  const safe = duplicateIssueState(false);
  const unique = duplicateIssueState(true);
  const safeEvidence = await collectCleanEvidence(duplicateIssueGithub(safe), REPOSITORY, "", [finding]);
  const uniqueEvidence = await collectCleanEvidence(duplicateIssueGithub(unique), REPOSITORY, "", [finding]);

  assert.equal(safeEvidence.issues.find((issue) => issue.number === 7)?.fold?.successorNumber, 8);
  assert.equal(buildCleanPlan(safeEvidence).entries.find((entry) => entry.target === "#7")?.action, "fold");
  assert.equal(buildCleanPlan(safeEvidence).entries.some((entry) => entry.kind === "lane-finding" && entry.target === finding.id), false);
  assert.equal(uniqueEvidence.issues.some((issue) => issue.fold !== undefined), false);
  assert.equal(buildCleanPlan(uniqueEvidence).entries.some((entry) => entry.kind === "lane-finding" && entry.target === finding.id), true);
});

test("clean duplicate issue fold publishes an exact receipt and revalidates before closure", async () => {
  const state = duplicateIssueState(false);
  const github = duplicateIssueGithub(state);
  const evidence = await collectCleanEvidence(github, REPOSITORY, "", [duplicateIssueFinding()]);
  const plan = buildCleanPlan(evidence, new Date("2026-07-16T11:30:00Z"));
  const receipt = await applyCleanPlan(github, REPOSITORY, plan, evidence, {
    mutateExact: duplicateIssueMutator(state)
  });

  assert.equal(state.issues[0]!.state, "closed");
  assert.equal(state.comments.some((comment) => String(comment.body).startsWith("<!-- darkfactory:clean-issue-fold schema=1")), true);
  assert.match(receipt.actions.find((action) => action.target === "#7")?.reason ?? "", /complete source scope/);
});

test("clean duplicate issue fold blocks successor scope drift after admission", async () => {
  const state = duplicateIssueState(false);
  const github = duplicateIssueGithub(state);
  const evidence = await collectCleanEvidence(github, REPOSITORY, "", [duplicateIssueFinding()]);
  const plan = buildCleanPlan(evidence, new Date("2026-07-16T11:30:00Z"));

  await assert.rejects(applyCleanPlan(github, REPOSITORY, plan, evidence, {
    onAdmission: async () => { state.issues[1]!.body = "# Goal\n\nConcurrent owner replacement."; },
    mutateExact: duplicateIssueMutator(state)
  }), /drifted from its exact version/);
  assert.equal(state.issues[0]!.state, "open");
  assert.equal(state.comments.length, 0);
});

test("clean destructive GitHub actions fail closed before admission without an atomic mutator", async () => {
  const state = duplicateIssueState(false);
  const github = duplicateIssueGithub(state);
  const evidence = await collectCleanEvidence(github, REPOSITORY, "", [duplicateIssueFinding()]);
  const plan = buildCleanPlan(evidence, new Date("2026-07-16T11:30:00Z"));
  let admitted = false;

  await assert.rejects(applyCleanPlan(github, REPOSITORY, plan, evidence, {
    onAdmission: async () => { admitted = true; }
  }), /requires an atomic conditional mutator.*target preserved/);
  assert.equal(admitted, false);
  assert.equal(state.issues[0]!.state, "open");
  assert.deepEqual(state.comments, []);
});

test("clean issue fold rejects a race at the atomic mutation boundary", async () => {
  const state = duplicateIssueState(false);
  const github = duplicateIssueGithub(state);
  const evidence = await collectCleanEvidence(github, REPOSITORY, "", [duplicateIssueFinding()]);
  const plan = buildCleanPlan(evidence, new Date("2026-07-16T11:30:00Z"));

  await assert.rejects(applyCleanPlan(github, REPOSITORY, plan, evidence, {
    mutateExact: duplicateIssueMutator(state, { raceAtMutation: true })
  }), /atomic issue version precondition failed/);
  assert.equal(state.issues[0]!.state, "open");
  assert.equal(state.comments.some((comment) => String(comment.body).startsWith("<!-- darkfactory:clean-issue-fold schema=1")), true);
});

test("clean successor proof admits same-repository same-base head ancestry", async () => {
  const evidence = await collectCleanEvidence(successorEvidenceGithub("ancestry"), REPOSITORY);
  const source = evidence.pullRequests.find((pull) => pull.number === 1);

  assert.equal(source?.successor?.proof, "head-ancestry");
  assert.equal(source?.autoreview, "current");
  assert.equal(source?.version, `${BASE_SHA}:${SOURCE_SHA}`);
  assert.equal(buildCleanPlan(evidence).entries.find((entry) => entry.target === "#1")?.action, "close");
});

test("clean successor proof admits exact tree identity when squash history breaks ancestry", async () => {
  const evidence = await collectCleanEvidence(successorEvidenceGithub("tree"), REPOSITORY);
  const source = evidence.pullRequests.find((pull) => pull.number === 1);

  assert.equal(source?.successor?.proof, "tree-equivalence");
  assert.equal(buildCleanPlan(evidence).entries.find((entry) => entry.target === "#1")?.action, "close");
});

test("clean successor proof denies cross-base and cross-repository claims", async () => {
  for (const mode of ["cross-base", "fork"] as const) {
    const evidence = await collectCleanEvidence(successorEvidenceGithub(mode), REPOSITORY);
    const source = evidence.pullRequests.find((pull) => pull.number === 1);
    const entry = buildCleanPlan(evidence).entries.find((candidate) => candidate.target === "#1");
    assert.equal(source?.successor, null);
    assert.notEqual(entry?.action, "close");
  }
});

test("clean Autoreview apply binds the exact issue version and records admission before dispatch completion", async () => {
  const issue = issueFixture();
  const version = issueVersion(issue);
  const evidence = issueActionEvidence(version, "missing");
  const plan = buildCleanPlan(evidence, new Date("2026-07-16T11:00:00Z"));
  const events: string[] = [];
  const github = issueAutoreviewApplyGithub(issue, [], events);

  const receipt = await applyCleanPlan(github, REPOSITORY, plan, evidence, {
    onAdmission: async (action) => { events.push(`admission:${action.version}`); },
    onCompletion: async (action) => { events.push(`completion:${action.kind}:${action.status}`); }
  });

  const pendingIndex = events.indexOf("comment:pending");
  const dispatchIndex = events.indexOf("dispatch");
  assert.ok(events.indexOf(`admission:${version}`) < pendingIndex);
  assert.ok(pendingIndex < dispatchIndex);
  assert.ok(dispatchIndex < events.indexOf("completion:issue:applied"));
  const issueReceipt = receipt.actions.find((action) => action.kind === "issue");
  assert.equal(issueReceipt?.target, "#7");
  assert.equal(issueReceipt?.head, version);
  assert.equal(issueReceipt?.version, version);
  assert.equal(issueReceipt?.status, "applied");
  assert.match(issueReceipt?.reason ?? "", new RegExp(`accepted darkfactory-autoreview\\.yml.*${version}`, "i"));
});

test("clean Autoreview apply deduplicates an exact pending observation without admission or dispatch", async () => {
  const issue = issueFixture();
  const version = issueVersion(issue);
  const pending = issueComment(
    9,
    `<!-- darkfactory:clean-autoreview schema=1 kind=issue number=7 version=${version} status=pending -->\nPending.`,
    new Date().toISOString()
  );
  const evidence = issueActionEvidence(version, "missing");
  const plan = buildCleanPlan(evidence, new Date("2026-07-16T11:00:00Z"));
  const events: string[] = [];
  const receipt = await applyCleanPlan(issueAutoreviewApplyGithub(issue, [pending], events), REPOSITORY, plan, evidence, {
    onAdmission: async () => { events.push("admission"); },
    onCompletion: async (action) => { events.push(`completion:${action.kind}:${action.status}`); }
  });

  assert.equal(events.includes("admission"), false);
  assert.equal(events.includes("dispatch"), false);
  assert.equal(events.some((event) => event.startsWith("comment:")), false);
  assert.equal(receipt.actions.find((action) => action.kind === "issue")?.status, "skipped");
});

test("clean Autoreview apply preserves a stale plan when trusted recovery becomes owner-required", async () => {
  const issue = issueFixture();
  const version = issueVersion(issue);
  const ownerRequired = issueComment(
    10,
    `<!-- darkfactory:clean-autoreview schema=1 kind=issue number=7 version=${version} status=owner-required -->\nOwner action required.`,
    new Date().toISOString()
  );
  const evidence = issueActionEvidence(version, "missing");
  const plan = buildCleanPlan(evidence, new Date("2026-07-16T11:00:00Z"));
  const events: string[] = [];
  const receipt = await applyCleanPlan(
    issueAutoreviewApplyGithub(issue, [ownerRequired], events),
    REPOSITORY,
    plan,
    evidence,
    {
      onAdmission: async () => { events.push("admission"); },
      onCompletion: async (action) => { events.push(`completion:${action.kind}:${action.status}`); }
    }
  );

  assert.equal(events.includes("admission"), false);
  assert.equal(events.includes("dispatch"), false);
  assert.equal(events.some((event) => event.startsWith("comment:")), false);
  const action = receipt.actions.find((entry) => entry.kind === "issue");
  assert.equal(action?.status, "skipped");
  assert.match(action?.reason ?? "", /owner-required/);
});

test("clean Autoreview apply re-fetches after admission and blocks a concurrent issue edit before mutation", async () => {
  const issue = issueFixture();
  const version = issueVersion(issue);
  const evidence = issueActionEvidence(version, "missing");
  const plan = buildCleanPlan(evidence, new Date("2026-07-16T11:00:00Z"));
  const events: string[] = [];
  const github = issueAutoreviewApplyGithub(issue, [], events);

  await assert.rejects(
    applyCleanPlan(github, REPOSITORY, plan, evidence, {
      onAdmission: async () => {
        issue.title = "Concurrent owner edit";
        events.push("admission");
      },
      onCompletion: async () => { events.push("completion"); }
    }),
    /drifted from exact version/
  );
  assert.equal(events.includes("admission"), true);
  assert.equal(events.includes("dispatch"), false);
  assert.equal(events.some((event) => event.startsWith("comment:")), false);
  assert.equal(events.includes("completion"), false);
});

test("clean PR closure re-proves the exact successor before its pointer comment and close mutation", async () => {
  const evidence = pullClosureEvidence();
  const plan = buildCleanPlan(evidence, new Date("2026-07-16T11:00:00Z"));
  const events: string[] = [];
  const state = { sourceHead: SOURCE_SHA, sourceState: "open" };
  const receipt = await applyCleanPlan(pullClosureGithub(state, events), REPOSITORY, plan, evidence, {
    onAdmission: async (action) => { events.push(`admission:${action.target}`); },
    onCompletion: async (action) => { events.push(`completion:${action.target}:${action.status}`); },
    mutateExact: pullClosureMutator(state, events)
  });

  const admission = events.indexOf("admission:#1");
  const comment = events.indexOf("closure-comment");
  const close = events.indexOf("close");
  const completion = events.indexOf("completion:#1:applied");
  assert.ok(admission >= 0 && admission < comment && comment < close && close < completion);
  assert.ok(events.slice(admission + 1, comment).includes("compare"));
  assert.ok(events.slice(comment + 1, close).includes("compare"));
  const action = receipt.actions.find((candidate) => candidate.target === "#1");
  assert.equal(action?.version, `${BASE_SHA}:${SOURCE_SHA}`);
  assert.equal(action?.successor?.version, `${BASE_SHA}:${SUCCESSOR_SHA}`);
  assert.equal(action?.successor?.proof, "head-ancestry");
});

test("clean PR closure re-fetches after admission and blocks successor/source drift before any mutation", async () => {
  const evidence = pullClosureEvidence();
  const plan = buildCleanPlan(evidence, new Date("2026-07-16T11:00:00Z"));
  const events: string[] = [];
  const state = { sourceHead: SOURCE_SHA, sourceState: "open" };

  await assert.rejects(
    applyCleanPlan(pullClosureGithub(state, events), REPOSITORY, plan, evidence, {
      onAdmission: async () => {
        state.sourceHead = "9".repeat(40);
        events.push("admission");
      },
      onCompletion: async () => { events.push("completion"); },
      mutateExact: pullClosureMutator(state, events)
    }),
    /drifted from its exact base\/head identity/
  );
  assert.equal(events.includes("admission"), true);
  assert.equal(events.includes("closure-comment"), false);
  assert.equal(events.includes("close"), false);
  assert.equal(events.includes("completion"), false);
});

test("clean PR closure rejects a race at the atomic mutation boundary", async () => {
  const evidence = pullClosureEvidence();
  const plan = buildCleanPlan(evidence, new Date("2026-07-16T11:00:00Z"));
  const events: string[] = [];
  const state = { sourceHead: SOURCE_SHA, sourceState: "open" };

  await assert.rejects(applyCleanPlan(pullClosureGithub(state, events), REPOSITORY, plan, evidence, {
    mutateExact: pullClosureMutator(state, events, { raceAtMutation: true })
  }), /atomic pull-request version precondition failed/);
  assert.equal(state.sourceState, "open");
  assert.equal(events.includes("closure-comment"), true);
  assert.equal(events.includes("close"), false);
});

test("clean artifact repair opens one exact dev PR and arms only protected green auto-merge", async () => {
  const state = artifactState();
  const evidence = artifactActionEvidence();
  const plan = buildCleanPlan(evidence, new Date("2026-07-16T12:00:00Z"));
  const receipt = await applyCleanPlan(artifactGithub(state), REPOSITORY, plan, evidence);

  assert.equal(state.branchHead, ARTIFACT_HEAD);
  assert.equal(state.pull?.auto_merge !== null, true);
  assert.equal(state.events.includes("create-ref:refs/heads/darkfactory/clean-artifact-" + artifactBranchSuffix()), true);
  assert.equal(state.events.some((event) => event.includes("refs/heads/dev")), false);
  assert.equal(state.events.includes("graphql:auto-merge"), true);
  assert.match(receipt.actions.find((action) => action.kind === "artifact")?.reason ?? "", /protected squash auto-merge/);
});

test("clean artifact repair blocks a dev base race before creating repository objects", async () => {
  const state = artifactState();
  const evidence = artifactActionEvidence();
  const plan = buildCleanPlan(evidence, new Date("2026-07-16T12:00:00Z"));

  await assert.rejects(applyCleanPlan(artifactGithub(state), REPOSITORY, plan, evidence, {
    onAdmission: async () => { state.baseSha = "9".repeat(40); }
  }), /base drifted/);
  assert.equal(state.events.some((event) => event.startsWith("post:")), false);
});

test("clean artifact repair blocks an exact blob race before creating repository objects", async () => {
  const state = artifactState();
  const evidence = artifactActionEvidence();
  const plan = buildCleanPlan(evidence, new Date("2026-07-16T12:00:00Z"));

  await assert.rejects(applyCleanPlan(artifactGithub(state), REPOSITORY, plan, evidence, {
    onAdmission: async () => { state.blobSha = "8".repeat(40); }
  }), /blob or mode drifted/);
  assert.equal(state.events.some((event) => event.startsWith("post:")), false);
});

test("clean managed-label deletion revalidates exact policy and label identity before confirming absence", async () => {
  const state = managedLabelState();
  const evidence = managedLabelEvidence();
  const plan = buildCleanPlan(evidence, new Date("2026-07-16T12:00:00Z"));
  const receipt = await applyCleanPlan(managedLabelGithub(state), REPOSITORY, plan, evidence, {
    mutateExact: managedLabelMutator(state)
  });

  assert.equal(state.exists, false);
  assert.deepEqual(state.events, ["delete:df:old"]);
  assert.match(receipt.actions.find((action) => action.kind === "managed-label")?.reason ?? "", /re-observed absence/);
});

test("clean managed-label deletion blocks identity drift and never touches human labels", async () => {
  const state = managedLabelState();
  const evidence = managedLabelEvidence();
  const plan = buildCleanPlan(evidence, new Date("2026-07-16T12:00:00Z"));
  await assert.rejects(applyCleanPlan(managedLabelGithub(state), REPOSITORY, plan, evidence, {
    onAdmission: async () => { state.color = "123456"; },
    mutateExact: managedLabelMutator(state)
  }), /drifted from its exact identity/);
  assert.equal(state.exists, true);
  assert.deepEqual(state.events, []);
  assert.equal(plan.entries.some((entry) => entry.kind === "managed-label" && !entry.target.startsWith("df:")), false);
});

test("clean managed-label deletion rejects a race at the atomic mutation boundary", async () => {
  const state = managedLabelState();
  const evidence = managedLabelEvidence();
  const plan = buildCleanPlan(evidence, new Date("2026-07-16T12:00:00Z"));

  await assert.rejects(applyCleanPlan(managedLabelGithub(state), REPOSITORY, plan, evidence, {
    mutateExact: managedLabelMutator(state, { raceAtMutation: true })
  }), /atomic label version precondition failed/);
  assert.equal(state.exists, true);
  assert.deepEqual(state.events, []);
});

test("clean marker issue closure accepts only an exact trusted marker and blocks actor drift", async () => {
  const first = markerIssueState();
  const evidence = markerIssueEvidence(first.issue);
  const plan = buildCleanPlan(evidence, new Date("2026-07-16T12:00:00Z"));
  await applyCleanPlan(markerIssueGithub(first), REPOSITORY, plan, evidence, {
    observeReviewFindings: async () => [],
    mutateExact: markerIssueMutator(first)
  });
  assert.equal(first.issue.state, "closed");
  assert.equal(first.comments.some((comment) => String(comment.body).startsWith("<!-- darkfactory:clean-marker-issue-closure schema=1")), true);

  const drift = markerIssueState();
  const driftEvidence = markerIssueEvidence(drift.issue);
  const driftPlan = buildCleanPlan(driftEvidence, new Date("2026-07-16T12:00:00Z"));
  await assert.rejects(applyCleanPlan(markerIssueGithub(drift), REPOSITORY, driftPlan, driftEvidence, {
    onAdmission: async () => { drift.issue.user = { login: "octocat", type: "User" }; },
    observeReviewFindings: async () => [],
    mutateExact: markerIssueMutator(drift)
  }), /actor, marker, or exact version drifted/);
  assert.equal(drift.issue.state, "open");
  assert.equal(drift.comments.length, 0);
});

test("clean marker issue closure revalidates the finding set and rejects an atomic close race", async () => {
  const findingDrift = markerIssueState();
  const driftEvidence = markerIssueEvidence(findingDrift.issue);
  const driftPlan = buildCleanPlan(driftEvidence, new Date("2026-07-16T12:00:00Z"));
  await assert.rejects(applyCleanPlan(markerIssueGithub(findingDrift), REPOSITORY, driftPlan, driftEvidence, {
    observeReviewFindings: async () => [reviewableIssueFinding()],
    mutateExact: markerIssueMutator(findingDrift)
  }), /doctor finding set drifted/);
  assert.equal(findingDrift.issue.state, "open");
  assert.deepEqual(findingDrift.comments, []);

  const race = markerIssueState();
  const evidence = markerIssueEvidence(race.issue);
  const plan = buildCleanPlan(evidence, new Date("2026-07-16T12:00:00Z"));
  await assert.rejects(applyCleanPlan(markerIssueGithub(race), REPOSITORY, plan, evidence, {
    observeReviewFindings: async () => [],
    mutateExact: markerIssueMutator(race, { raceAtMutation: true })
  }), /atomic marker issue version precondition failed/);
  assert.equal(race.issue.state, "open");
  assert.equal(race.comments.some((comment) => String(comment.body).startsWith("<!-- darkfactory:clean-marker-issue-closure schema=1")), true);
});

const REPOSITORY = { owner: "marius-patrik", repo: "example" } as const;
const MAIN_SHA = "a".repeat(40);
const MAIN_TREE = "1".repeat(40);
const SOURCE_SHA = "b".repeat(40);
const SUCCESSOR_SHA = "c".repeat(40);
const BASE_SHA = "d".repeat(40);
const ARTIFACT_BLOB = "4".repeat(40);
const ARTIFACT_BASE = "5".repeat(40);
const ARTIFACT_BASE_TREE = "6".repeat(40);
const ARTIFACT_TREE = "7".repeat(40);
const ARTIFACT_HEAD = "8".repeat(40);
const TRUSTED_ACTOR = { login: "darkfactory-agent[bot]", type: "Bot" } as const;

function issueFixture(): Record<string, unknown> {
  return {
    number: 7,
    title: "Original contract",
    body: "# Goal\n\nOriginal.",
    state: "open",
    labels: [],
    updated_at: "2026-07-16T09:00:00Z"
  };
}

function issueComment(
  id: number,
  body: string,
  createdAt: string,
  user: Readonly<{ login: string; type: string }> = TRUSTED_ACTOR
): Record<string, unknown> {
  return {
    id,
    issue_url: "https://api.github.com/repos/marius-patrik/example/issues/7",
    body,
    user,
    created_at: createdAt,
    updated_at: createdAt
  };
}

function cleanResultComment(version: string): string {
  return `${AUTOREVIEW_RESULT_MARKER}\n${autoreviewTargetVersionMarker(version)}\n## DarkFactory Autoreview\n\n**Verdict:** Clean high confirmation`;
}

function reviewableIssueFinding(): DoctorFinding {
  return {
    id: "issue-7-contract-stale",
    category: "issue lane",
    message: "Issue #7 has a deterministic contract defect.",
    severity: "warning",
    repair_class: "pr",
    evidence: [],
    repair: ["Run issue Autoreview."]
  };
}

function duplicateIssueFinding(): DoctorFinding {
  return {
    id: "duplicate-issue-contract-7-8",
    category: "issue lane",
    message: "Issues #7 and #8 duplicate scope.",
    severity: "warning",
    repair_class: "pr",
    evidence: [],
    repair: ["Fold only after exact scope containment proof."]
  };
}

function duplicateIssueState(uniqueSource: boolean): {
  issues: Array<Record<string, unknown>>;
  comments: Array<Record<string, unknown>>;
} {
  return {
    issues: [
      {
        number: 7,
        title: "Shared contract",
        body: uniqueSource ? "# Goal\n\nShared.\n\n## Acceptance\n\n- Unique source promise." : "# Goal\n\nShared.",
        state: "open",
        labels: [],
        updated_at: "2026-07-16T09:00:00Z"
      },
      {
        number: 8,
        title: "Shared contract",
        body: "# Goal\n\nShared.\n\n## Acceptance\n\n- Complete successor promise.",
        state: "open",
        labels: [],
        updated_at: "2026-07-16T09:05:00Z"
      }
    ],
    comments: []
  };
}

function duplicateIssueGithub(
  state: { issues: Array<Record<string, unknown>>; comments: Array<Record<string, unknown>> }
): OperatorGitHubRequester {
  let nextComment = 500;
  return {
    async request(route, parameters) {
      if (route === "GET /repos/{owner}/{repo}") return { data: { default_branch: "main" } };
      if (route === "GET /repos/{owner}/{repo}/branches") return { data: parameters.page === 1 ? [{ name: "main", protected: true, commit: { sha: MAIN_SHA } }] : [] };
      if (route === "GET /repos/{owner}/{repo}/pulls") return { data: [] };
      if (route === "GET /repos/{owner}/{repo}/issues") return { data: parameters.page === 1 ? state.issues.filter((issue) => issue.state === "open") : [] };
      if (route === "GET /repos/{owner}/{repo}/issues/comments") return { data: parameters.page === 1 ? state.comments : [] };
      if (route === "GET /repos/{owner}/{repo}/git/commits/{commit_sha}") return { data: { tree: { sha: MAIN_TREE } } };
      if (route === "GET /repos/{owner}/{repo}/contents/{path}") throw Object.assign(new Error("missing"), { status: 404 });
      if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}") {
        const issue = state.issues.find((candidate) => candidate.number === parameters.issue_number);
        if (!issue) throw Object.assign(new Error("missing"), { status: 404 });
        return { data: { ...issue } };
      }
      if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments") {
        const number = Number(parameters.issue_number);
        const comments = state.comments.filter((comment) => String(comment.issue_url).endsWith(`/issues/${number}`));
        return { data: parameters.page === 1 ? comments : [] };
      }
      if (route === "POST /repos/{owner}/{repo}/issues/{issue_number}/comments") {
        const number = Number(parameters.issue_number);
        const comment = {
          id: nextComment++,
          issue_url: `https://api.github.com/repos/marius-patrik/example/issues/${number}`,
          body: String(parameters.body),
          user: TRUSTED_ACTOR,
          created_at: "2026-07-16T12:00:00Z",
          updated_at: "2026-07-16T12:00:00Z"
        };
        state.comments.push(comment);
        return { data: comment };
      }
      if (route === "PATCH /repos/{owner}/{repo}/issues/{issue_number}") {
        throw new Error("unconditional issue mutation is forbidden");
      }
      throw new Error(`unexpected route ${route}`);
    }
  };
}

function duplicateIssueMutator(
  state: ReturnType<typeof duplicateIssueState>,
  options: { raceAtMutation?: boolean } = {}
): ExactMutator {
  return async (mutation) => {
    assert.equal(mutation.kind, "close-issue");
    assert.equal(mutation.route, "PATCH /repos/{owner}/{repo}/issues/{issue_number}");
    const number = Number(mutation.parameters.issue_number);
    const issue = state.issues.find((candidate) => candidate.number === number)!;
    if (options.raceAtMutation) issue.updated_at = "2026-07-16T12:00:01.000Z";
    const comments = state.comments.filter((comment) => String(comment.issue_url).endsWith(`/issues/${number}`));
    if (mutation.expectedVersion !== stableHash({ issue, comments })) {
      throw Object.assign(new Error("atomic issue version precondition failed"), { status: 412 });
    }
    issue.state = mutation.parameters.state;
    return { data: { ...issue } };
  };
}

function issueEvidenceGithub(issue: Record<string, unknown>, comments: Record<string, unknown>[]): OperatorGitHubRequester {
  return {
    async request(route, parameters) {
      if (route === "GET /repos/{owner}/{repo}") return { data: { default_branch: "main" } };
      if (route === "GET /repos/{owner}/{repo}/branches") {
        return { data: parameters.page === 1 ? [{ name: "main", protected: true, commit: { sha: MAIN_SHA } }] : [] };
      }
      if (route === "GET /repos/{owner}/{repo}/pulls") return { data: [] };
      if (route === "GET /repos/{owner}/{repo}/issues") return { data: parameters.page === 1 ? [issue] : [] };
      if (route === "GET /repos/{owner}/{repo}/issues/comments") return { data: parameters.page === 1 ? comments : [] };
      if (route === "GET /repos/{owner}/{repo}/git/commits/{commit_sha}") return { data: { tree: { sha: MAIN_TREE } } };
      if (route === "GET /repos/{owner}/{repo}/contents/{path}") throw Object.assign(new Error("missing"), { status: 404 });
      throw new Error(`unexpected route ${route}`);
    }
  };
}

function pullFixture(number: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const headSha = number === 1 ? SOURCE_SHA : SUCCESSOR_SHA;
  const headRef = number === 1 ? "feature/source" : "feature/successor";
  return {
    number,
    state: "open",
    merged_at: null,
    body: number === 1 ? "Superseded by: #2" : "",
    head: {
      ref: headRef,
      sha: headSha,
      repo: { name: "example", owner: { login: "marius-patrik" } }
    },
    base: { ref: "dev", sha: BASE_SHA },
    updated_at: `2026-07-16T10:0${number}:00Z`,
    ...overrides
  };
}

function successorEvidenceGithub(mode: "ancestry" | "tree" | "cross-base" | "fork"): OperatorGitHubRequester {
  const successorOverrides: Record<string, unknown> = mode === "cross-base"
    ? { base: { ref: "main", sha: BASE_SHA } }
    : mode === "fork"
      ? { head: { ref: "feature/successor", sha: SUCCESSOR_SHA, repo: { name: "example-fork", owner: { login: "someone-else" } } } }
      : {};
  const pulls = [pullFixture(1), pullFixture(2, successorOverrides)];
  const comments = [
    pullResultComment(1, `${BASE_SHA}:${SOURCE_SHA}`, 11),
    pullResultComment(2, `${BASE_SHA}:${SUCCESSOR_SHA}`, 12)
  ];
  return {
    async request(route, parameters) {
      if (route === "GET /repos/{owner}/{repo}") return { data: { default_branch: "main" } };
      if (route === "GET /repos/{owner}/{repo}/branches") {
        return { data: parameters.page === 1 ? [{ name: "main", protected: true, commit: { sha: MAIN_SHA } }] : [] };
      }
      if (route === "GET /repos/{owner}/{repo}/pulls") return { data: parameters.page === 1 ? pulls : [] };
      if (route === "GET /repos/{owner}/{repo}/issues") {
        return { data: parameters.page === 1 ? pulls.map((pull) => ({ number: pull.number, pull_request: {} })) : [] };
      }
      if (route === "GET /repos/{owner}/{repo}/issues/comments") return { data: parameters.page === 1 ? comments : [] };
      if (route === "GET /repos/{owner}/{repo}/compare/{basehead}") {
        return { data: { merge_base_commit: { sha: mode === "ancestry" ? SOURCE_SHA : "e".repeat(40) } } };
      }
      if (route === "GET /repos/{owner}/{repo}/git/commits/{commit_sha}") {
        const sha = String(parameters.commit_sha);
        const tree = sha === MAIN_SHA ? MAIN_TREE : mode === "tree" ? "f".repeat(40) : `${sha.slice(0, 39)}0`;
        return { data: { tree: { sha: tree } } };
      }
      if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
        return {
          data: {
            total_count: 1,
            check_runs: [{
              id: String(parameters.ref) === SOURCE_SHA ? 1 : 2,
              name: "DarkFactory Autoreview",
              app: { id: 15368 },
              head_sha: parameters.ref,
              status: "completed",
              conclusion: "success",
              completed_at: "2026-07-16T10:10:00Z"
            }]
          }
        };
      }
      if (route === "GET /repos/{owner}/{repo}/contents/{path}") throw Object.assign(new Error("missing"), { status: 404 });
      throw new Error(`unexpected route ${route}`);
    }
  };
}

function pullResultComment(number: number, version: string, id: number): Record<string, unknown> {
  return {
    id,
    issue_url: `https://api.github.com/repos/marius-patrik/example/issues/${number}`,
    body: cleanResultComment(version),
    user: TRUSTED_ACTOR,
    created_at: "2026-07-16T10:10:00Z",
    updated_at: "2026-07-16T10:10:00Z"
  };
}

function issueActionEvidence(version: string, autoreview: CleanEvidence["issues"][number]["autoreview"]): CleanEvidence {
  return {
    repository: "marius-patrik/example",
    defaultBranch: "main",
    observedRefs: { main: MAIN_SHA },
    branches: [],
    localBranches: [],
    orphanRefs: [],
    detachedWorktrees: [],
    pullRequests: [],
    issues: [{
      number: 7,
      fingerprint: version,
      classification: "finding",
      findingIds: ["issue-7-contract-stale"],
      reviewable: true,
      autoreview
    }],
    reviewFindings: [{
      id: "issue-7-contract-stale",
      category: "issue lane",
      severity: "warning",
      repairClass: "pr",
      message: "Issue #7 has a deterministic contract defect.",
      evidence: [],
      fingerprint: "finding-7"
    }],
    pullRequestFingerprint: "prs-v1",
    issueLaneFingerprint: version,
    prdFingerprint: "prd-v1"
  };
}

function issueAutoreviewApplyGithub(
  issue: Record<string, unknown>,
  initialComments: Record<string, unknown>[],
  events: string[]
): OperatorGitHubRequester {
  const comments = [...initialComments];
  let nextCommentId = 100;
  return {
    async request(route, parameters) {
      if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}") {
        events.push("refetch:issue");
        return { data: { ...issue } };
      }
      if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments") {
        return { data: parameters.page === 1 ? comments.map((comment) => ({ ...comment })) : [] };
      }
      if (route === "POST /repos/{owner}/{repo}/issues/{issue_number}/comments") {
        const body = String(parameters.body || "");
        const status = body.match(/status=(pending|failed)/)?.[1] || "other";
        events.push(`comment:${status}`);
        const now = new Date().toISOString();
        const comment = issueComment(nextCommentId, body, now);
        nextCommentId += 1;
        comments.push(comment);
        return { data: comment };
      }
      if (route === "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}") return { data: { id: 88, state: "active" } };
      if (route === "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches") {
        events.push("dispatch");
        assert.equal(parameters.ref, "main");
        assert.deepEqual(parameters.inputs, {
          target_kind: "issue",
          target_number: "7",
          target_version: issueVersion(issue)
        });
        return { data: {} };
      }
      throw new Error(`unexpected route ${route}`);
    }
  };
}

function pullClosureEvidence(): CleanEvidence {
  const successor = {
    number: 2,
    version: `${BASE_SHA}:${SUCCESSOR_SHA}`,
    base: "dev",
    baseSha: BASE_SHA,
    headRef: "feature/successor",
    head: SUCCESSOR_SHA,
    proof: "head-ancestry" as const
  };
  return {
    repository: "marius-patrik/example",
    defaultBranch: "main",
    observedRefs: { main: MAIN_SHA, dev: BASE_SHA },
    branches: [],
    localBranches: [],
    orphanRefs: [],
    detachedWorktrees: [],
    pullRequests: [
      {
        number: 1,
        version: `${BASE_SHA}:${SOURCE_SHA}`,
        base: "dev",
        baseSha: BASE_SHA,
        headRef: "feature/source",
        head: SOURCE_SHA,
        classification: "superseded",
        findingIds: ["pr-1-superseded"],
        autoreview: "stale",
        successor
      },
      {
        number: 2,
        version: `${BASE_SHA}:${SUCCESSOR_SHA}`,
        base: "dev",
        baseSha: BASE_SHA,
        headRef: "feature/successor",
        head: SUCCESSOR_SHA,
        classification: "active",
        findingIds: [],
        autoreview: "current",
        successor: null
      }
    ],
    issues: [],
    reviewFindings: [],
    pullRequestFingerprint: "prs-closure-v1",
    issueLaneFingerprint: "issues-v1",
    prdFingerprint: "prd-v1"
  };
}

function pullClosureGithub(
  state: { sourceHead: string; sourceState: string },
  events: string[]
): OperatorGitHubRequester {
  const comments: Record<string, unknown>[] = [];
  return {
    async request(route, parameters) {
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
        const number = Number(parameters.pull_number);
        events.push(`refetch:pr-${number}`);
        if (number === 1) {
          const source = pullFixture(1, {
            state: state.sourceState,
            head: {
              ref: "feature/source",
              sha: state.sourceHead,
              repo: { name: "example", owner: { login: "marius-patrik" } }
            }
          });
          return { data: source };
        }
        const successor = pullFixture(2);
        return { data: successor };
      }
      if (route === "GET /repos/{owner}/{repo}/compare/{basehead}") {
        events.push("compare");
        return { data: { merge_base_commit: { sha: state.sourceHead } } };
      }
      if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments") {
        return { data: parameters.page === 1 ? comments : [] };
      }
      if (route === "POST /repos/{owner}/{repo}/issues/{issue_number}/comments") {
        events.push("closure-comment");
        const body = String(parameters.body || "");
        assert.match(body, /darkfactory:clean-pr-closure schema=1/);
        const comment = {
          id: 300,
          issue_url: "https://api.github.com/repos/marius-patrik/example/issues/1",
          body,
          user: TRUSTED_ACTOR,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
        comments.push(comment);
        return { data: comment };
      }
      if (route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}") {
        throw new Error("unconditional pull-request mutation is forbidden");
      }
      throw new Error(`unexpected route ${route}`);
    }
  };
}

function pullClosureMutationVersion(state: { sourceHead: string; sourceState: string }): string {
  return stableHash({
    number: 1,
    state: state.sourceState,
    merged: false,
    body: "Superseded by: #2",
    headRef: "feature/source",
    headSha: state.sourceHead,
    baseRef: "dev",
    baseSha: BASE_SHA,
    sameRepository: true,
    trustedActor: false,
    autoMerge: false,
    nodeId: null,
    draft: false,
    title: "",
    updatedAt: "2026-07-16T10:01:00Z"
  });
}

function pullClosureMutator(
  state: { sourceHead: string; sourceState: string },
  events: string[],
  options: { raceAtMutation?: boolean } = {}
): ExactMutator {
  return async (mutation) => {
    assert.equal(mutation.kind, "close-pull-request");
    assert.equal(mutation.route, "PATCH /repos/{owner}/{repo}/pulls/{pull_number}");
    if (options.raceAtMutation) state.sourceHead = "9".repeat(40);
    if (mutation.expectedVersion !== pullClosureMutationVersion(state)) {
      throw Object.assign(new Error("atomic pull-request version precondition failed"), { status: 412 });
    }
    events.push("close");
    state.sourceState = "closed";
    return { data: pullFixture(1, { state: "closed" }) };
  };
}

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

function artifactBranchSuffix(): string {
  return stableHash({ findingId: "generated-artifact-debug-log", path: "debug.log", blobSha: ARTIFACT_BLOB, baseSha: ARTIFACT_BASE }).slice(0, 24);
}

function artifactActionEvidence(): CleanEvidence {
  const finding = {
    id: "generated-artifact-debug-log",
    category: "repository hygiene",
    severity: "warning",
    repairClass: "pr" as const,
    message: "Generated/runtime artifact `debug.log` is committed.",
    evidence: [],
    fingerprint: "f".repeat(64)
  };
  return {
    repository: "marius-patrik/example",
    defaultBranch: "main",
    observedRefs: { main: MAIN_SHA, dev: ARTIFACT_BASE },
    branches: [],
    localBranches: [],
    orphanRefs: [],
    detachedWorktrees: [],
    pullRequests: [],
    issues: [],
    reviewFindings: [finding],
    pullRequestFingerprint: "prs-artifact-v1",
    issueLaneFingerprint: "issues-artifact-v1",
    prdFingerprint: "prd-v1",
    artifactRepairs: [{
      findingId: finding.id,
      findingFingerprint: finding.fingerprint,
      path: "debug.log",
      blobSha: ARTIFACT_BLOB,
      mode: "100644",
      base: "dev",
      baseSha: ARTIFACT_BASE,
      branch: `darkfactory/clean-artifact-${artifactBranchSuffix()}`,
      state: "needed"
    }]
  };
}

function artifactState(): {
  baseSha: string;
  blobSha: string;
  branchHead: string | null;
  pull: Record<string, unknown> | null;
  events: string[];
} {
  return { baseSha: ARTIFACT_BASE, blobSha: ARTIFACT_BLOB, branchHead: null, pull: null, events: [] };
}

function artifactGithub(state: ReturnType<typeof artifactState>): OperatorGitHubRequester {
  const branch = `darkfactory/clean-artifact-${artifactBranchSuffix()}`;
  const pull = (): Record<string, unknown> => ({
    number: 41,
    node_id: "PR_artifact_41",
    state: "open",
    merged_at: null,
    draft: false,
    title: "chore(clean): remove generated artifact debug.log",
    body: String(state.pull?.body ?? ""),
    user: TRUSTED_ACTOR,
    auto_merge: state.pull?.auto_merge ?? null,
    head: { ref: branch, sha: ARTIFACT_HEAD, repo: { name: "example", owner: { login: "marius-patrik" } } },
    base: { ref: "dev", sha: ARTIFACT_BASE },
    updated_at: "2026-07-16T12:00:00Z"
  });
  return {
    async request(route, parameters) {
      if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") {
        if (parameters.ref === "heads/dev") return { data: { object: { sha: state.baseSha } } };
        if (parameters.ref === `heads/${branch}` && state.branchHead) return { data: { object: { sha: state.branchHead } } };
        throw Object.assign(new Error("missing"), { status: 404 });
      }
      if (route === "GET /repos/{owner}/{repo}/git/trees/{tree_sha}") {
        if (parameters.tree_sha === ARTIFACT_BASE) {
          return { data: { truncated: false, tree: [{ path: "debug.log", type: "blob", sha: state.blobSha, mode: "100644" }, { path: "README.md", type: "blob", sha: "1".repeat(40), mode: "100644" }] } };
        }
        if (parameters.tree_sha === ARTIFACT_HEAD) return { data: { truncated: false, tree: [{ path: "README.md", type: "blob", sha: "1".repeat(40), mode: "100644" }] } };
      }
      if (route === "GET /repos/{owner}/{repo}/branches/{branch}/protection") {
        return { data: { required_status_checks: { strict: true, checks: [{ context: "Validate", app_id: 15368 }, { context: "DarkFactory Autoreview", app_id: 15368 }] }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } } };
      }
      if (route === "GET /repos/{owner}/{repo}/git/commits/{commit_sha}") {
        if (parameters.commit_sha === ARTIFACT_BASE) return { data: { tree: { sha: ARTIFACT_BASE_TREE } } };
        if (parameters.commit_sha === ARTIFACT_HEAD) return { data: { message: "chore(clean): remove generated artifact debug.log", tree: { sha: ARTIFACT_TREE }, parents: [{ sha: ARTIFACT_BASE }] } };
      }
      if (route === "POST /repos/{owner}/{repo}/git/trees") {
        state.events.push("post:tree");
        assert.deepEqual(parameters.tree, [{ path: "debug.log", mode: "100644", type: "blob", sha: null }]);
        return { data: { sha: ARTIFACT_TREE } };
      }
      if (route === "POST /repos/{owner}/{repo}/git/commits") {
        state.events.push("post:commit");
        return { data: { sha: ARTIFACT_HEAD } };
      }
      if (route === "POST /repos/{owner}/{repo}/git/refs") {
        state.events.push(`create-ref:${String(parameters.ref)}`);
        state.branchHead = String(parameters.sha);
        return { data: { ref: parameters.ref, object: { sha: parameters.sha } } };
      }
      if (route === "GET /repos/{owner}/{repo}/pulls") return { data: parameters.page === 1 && state.pull ? [pull()] : [] };
      if (route === "POST /repos/{owner}/{repo}/pulls") {
        state.events.push("post:pull");
        state.pull = { body: parameters.body, auto_merge: null };
        return { data: pull() };
      }
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/files") {
        return { data: parameters.page === 1 ? [{ filename: "debug.log", status: "removed", sha: ARTIFACT_BLOB }] : [] };
      }
      throw new Error(`unexpected route ${route}`);
    },
    async graphql(_query, variables) {
      state.events.push("graphql:auto-merge");
      assert.deepEqual(variables, { pullRequestId: "PR_artifact_41" });
      state.pull!.auto_merge = { enabled_at: "2026-07-16T12:01:00Z" };
      return { enablePullRequestAutoMerge: { pullRequest: { number: 41, autoMergeRequest: { enabledAt: "2026-07-16T12:01:00Z" } } } };
    }
  };
}

function managedLabelEvidence(): CleanEvidence {
  const finding = { id: "label-df-old-orphan", category: "repository hygiene", severity: "warning", repairClass: "pr" as const, message: "Managed label `df:old` is absent from the canonical taxonomy.", evidence: [], fingerprint: "b".repeat(64) };
  return {
    repository: "marius-patrik/example", defaultBranch: "main", observedRefs: { dev: ARTIFACT_BASE }, branches: [], localBranches: [], orphanRefs: [], detachedWorktrees: [], pullRequests: [], issues: [],
    reviewFindings: [finding], pullRequestFingerprint: "prs-label-v1", issueLaneFingerprint: "issues-label-v1", prdFingerprint: "prd-v1",
    managedLabels: [{ findingId: finding.id, findingFingerprint: finding.fingerprint, name: "df:old", color: "abcdef", description: "old label", policyPath: ".darkfactory/labels.json", policyBlob: "3".repeat(40), policyRef: "dev", policyRevision: ARTIFACT_BASE }]
  };
}

function managedLabelState(): { exists: boolean; color: string; events: string[] } {
  return { exists: true, color: "abcdef", events: [] };
}

function managedLabelGithub(state: ReturnType<typeof managedLabelState>): OperatorGitHubRequester {
  const policy = JSON.stringify({ schemaVersion: 1, labels: [{ name: "df:ready", color: "0e8a16", description: "ready" }] });
  return {
    async request(route, parameters) {
      if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") return { data: { object: { sha: ARTIFACT_BASE } } };
      if (route === "GET /repos/{owner}/{repo}/contents/{path}") return { data: { sha: "3".repeat(40), encoding: "base64", content: Buffer.from(policy).toString("base64") } };
      if (route === "GET /repos/{owner}/{repo}/labels/{name}") {
        if (!state.exists) throw Object.assign(new Error("missing"), { status: 404 });
        const label = { name: "df:old", color: state.color, description: "old label" };
        return { data: label };
      }
      if (route === "DELETE /repos/{owner}/{repo}/labels/{name}") {
        throw new Error("unconditional label mutation is forbidden");
      }
      throw new Error(`unexpected route ${route}`);
    }
  };
}

function managedLabelMutator(
  state: ReturnType<typeof managedLabelState>,
  options: { raceAtMutation?: boolean } = {}
): ExactMutator {
  return async (mutation) => {
    assert.equal(mutation.kind, "delete-label");
    assert.equal(mutation.route, "DELETE /repos/{owner}/{repo}/labels/{name}");
    if (options.raceAtMutation) state.color = "123456";
    const currentVersion = stableHash({
      policyRevision: ARTIFACT_BASE,
      policyBlob: "3".repeat(40),
      name: "df:old",
      color: state.color,
      description: "old label"
    });
    if (mutation.expectedVersion !== currentVersion) {
      throw Object.assign(new Error("atomic label version precondition failed"), { status: 412 });
    }
    state.events.push(`delete:${String(mutation.parameters.name)}`);
    state.exists = false;
    return { data: {} };
  };
}

function markerIssueState(): { issue: Record<string, unknown>; comments: Record<string, unknown>[] } {
  return {
    issue: {
      number: 55,
      title: "DarkFactory orchestration dashboard",
      body: "<!-- df-dashboard:orchestration -->\nCurrent machine dashboard.",
      state: "open",
      user: TRUSTED_ACTOR,
      updated_at: "2026-07-16T12:00:00Z"
    },
    comments: []
  };
}

function markerIssueEvidence(issue: Record<string, unknown>): CleanEvidence {
  const version = issueVersion(issue);
  const successor = markerIssueSuccessor();
  return {
    repository: "marius-patrik/example", defaultBranch: "main", observedRefs: { main: MAIN_SHA }, branches: [], localBranches: [], orphanRefs: [], detachedWorktrees: [], pullRequests: [], issues: [], reviewFindings: [],
    pullRequestFingerprint: "prs-marker-v1", issueLaneFingerprint: "issues-marker-v1", prdFingerprint: "prd-v1",
    markerIssues: [{ number: 55, version, marker: "df-dashboard:orchestration", reason: "duplicate-dashboard", findingSetFingerprint: stableHash([]), successor: { number: 56, version: issueVersion(successor) } }]
  };
}

function markerIssueSuccessor(): Record<string, unknown> {
  return { number: 56, title: "DarkFactory orchestration dashboard", body: "<!-- df-dashboard:orchestration -->\nSuccessor dashboard.", state: "open", user: TRUSTED_ACTOR, updated_at: "2026-07-16T12:01:00Z" };
}

function markerIssueGithub(state: ReturnType<typeof markerIssueState>): OperatorGitHubRequester {
  const successor = markerIssueSuccessor();
  return {
    async request(route, parameters) {
      if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}") {
        if (parameters.issue_number === 55) return { data: { ...state.issue } };
        if (parameters.issue_number === 56) return { data: { ...successor } };
      }
      if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments") {
        return { data: parameters.page === 1 && parameters.issue_number === 55 ? state.comments : [] };
      }
      if (route === "POST /repos/{owner}/{repo}/issues/{issue_number}/comments") {
        const comment = { id: 800, issue_url: "https://api.github.com/repos/marius-patrik/example/issues/55", body: parameters.body, user: TRUSTED_ACTOR, created_at: "2026-07-16T12:02:00Z", updated_at: "2026-07-16T12:02:00Z" };
        state.comments.push(comment);
        return { data: comment };
      }
      if (route === "PATCH /repos/{owner}/{repo}/issues/{issue_number}") {
        throw new Error("unconditional marker issue mutation is forbidden");
      }
      throw new Error(`unexpected route ${route}`);
    }
  };
}

function markerIssueMutator(
  state: ReturnType<typeof markerIssueState>,
  options: { raceAtMutation?: boolean } = {}
): ExactMutator {
  return async (mutation) => {
    assert.equal(mutation.kind, "close-issue");
    assert.equal(mutation.route, "PATCH /repos/{owner}/{repo}/issues/{issue_number}");
    if (options.raceAtMutation) state.issue.updated_at = "2026-07-16T12:00:01.000Z";
    const currentVersion = stableHash({ issue: state.issue, comments: state.comments });
    if (mutation.expectedVersion !== currentVersion) {
      throw Object.assign(new Error("atomic marker issue version precondition failed"), { status: 412 });
    }
    state.issue.state = "closed";
    return { data: { ...state.issue } };
  };
}

async function createCleanWorktreeFixture(): Promise<{
  parent: string;
  root: string;
  linked: string;
  github: OperatorGitHubRequester;
}> {
  const parent = await mkdtemp(join(tmpdir(), "df-clean-worktree-ref-"));
  const root = join(parent, "repo");
  const linked = join(parent, "linked");
  await mkdir(root);
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.name", "DarkFactory Test"]);
  git(root, ["config", "user.email", "darkfactory@example.invalid"]);
  await writeFile(join(root, "README.md"), "# fixture\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "fixture"]);
  git(root, ["remote", "add", "origin", "https://github.com/marius-patrik/example.git"]);
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  const tree = git(root, ["rev-parse", "HEAD^{tree}"]).trim();
  git(root, ["update-ref", "refs/remotes/origin/main", head]);
  git(root, ["branch", "dev", head]);
  git(root, ["branch", "cleanup", head]);
  git(root, ["branch", "alternate", head]);
  git(root, ["worktree", "add", linked, "cleanup"]);
  return { parent, root, linked, github: cleanEvidenceGithub(head, tree) };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
}

function gitStatus(cwd: string, args: string[]): number | null {
  return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true }).status;
}
