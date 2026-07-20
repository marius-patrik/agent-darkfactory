import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  convergeManagedRegistration,
  ManagedRegistrationTrustViolation,
  MANAGED_REGISTRY_PATH
} from "../src/registration.js";

const MAIN_SHA = "a".repeat(40);
const BRANCH_SHA = "b".repeat(40);
const WRITTEN_SHA = "c".repeat(40);
const PRIOR_BASE_SHA = "d".repeat(40);
const MAIN_TREE_SHA = "e".repeat(40);
const BRANCH_TREE_SHA = "f".repeat(40);
const RECOVERY_TREE_SHA = "1".repeat(40);
const RECOVERY_SHA = "2".repeat(40);
const FILE_SHA = "3".repeat(40);
const MERGE_SHA = "4".repeat(40);
const TARGET = "marius-patrik/example";
const PULL_URL = "https://github.com/marius-patrik/Andromeda-data/pull/77";

test("managed registration is a no-op when canonical source already declares the target active", async () => {
  const calls: string[] = [];
  const github = fixtureGithub(calls, {
    repositories: { "marius-patrik/example": { state: "active", kind: "code" } }
  });
  const result = await convergeManagedRegistration(github, "MARIUS-PATRIK/EXAMPLE");
  assert.equal(result.sourceActive, true);
  assert.equal(result.receipt.status, "current");
  assert.deepEqual(calls, [
    "GET /repos/{owner}/{repo}",
    "GET /repos/{owner}/{repo}/git/ref/{ref}",
    "GET /repos/{owner}/{repo}/contents/{path}"
  ]);
});

test("managed registration opens one reviewed source-policy PR and preserves existing entries", async () => {
  const calls: string[] = [];
  let written: Record<string, unknown> | null = null;
  const github = fixtureGithub(calls, {
    repositories: { "marius-patrik/Andromeda": { state: "active" } },
    onWrite(parameters) { written = parameters; }
  });
  const result = await convergeManagedRegistration(github, "marius-patrik/Example");
  assert.equal(result.sourceActive, false);
  assert.equal(result.receipt.status, "applied");
  assert.match(result.receipt.detail, /pull\/77/);
  assert.ok(written);
  const writtenParameters = written as Record<string, unknown>;
  const next = JSON.parse(Buffer.from(String(writtenParameters.content), "base64").toString("utf8"));
  assert.deepEqual(next.repositories["marius-patrik/Andromeda"], { state: "active" });
  assert.equal(next.repositories["marius-patrik/example"].state, "active");
  assert.equal(next.repositories["marius-patrik/example"].kind, "code");
  assert.ok(calls.includes("GET /installation"));
  assert.ok(calls.includes("GET /repos/{owner}/{repo}/commits/{ref}"));
});

test("managed registration lands only an exact green App-bound reviewed pull request", async () => {
  const calls: string[] = [];
  const result = await convergeManagedRegistration(fixtureGithub(calls, {
    repositories: { "marius-patrik/Andromeda": { state: "active" } },
    registrationChecks: "green"
  }), TARGET);

  assert.equal(result.sourceActive, true);
  assert.equal(result.receipt.action, "managed-registration-merge");
  assert.equal(result.receipt.status, "applied");
  assert.match(result.receipt.detail, /App-bound Validate and DarkFactory Autoreview/);
  assert.equal(calls.filter((route) => route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs").length, 2);
  assert.equal(calls.includes("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge"), true);
});

test("managed registration blocks a Codex Review-only registration head", async () => {
  const calls: string[] = [];
  const result = await convergeManagedRegistration(fixtureGithub(calls, {
    repositories: { "marius-patrik/Andromeda": { state: "active" } },
    registrationChecks: "green",
    registrationReviewCheck: "Codex Review"
  }), TARGET);

  assert.equal(result.sourceActive, false);
  assert.equal(result.receipt.action, "managed-registration-pr");
  assert.match(result.receipt.detail, /exact App-bound DarkFactory Autoreview/);
  assert.equal(calls.includes("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge"), false);
});

test("managed registration refuses a green-looking review from the wrong App", async () => {
  const calls: string[] = [];
  await assert.rejects(
    convergeManagedRegistration(fixtureGithub(calls, {
      repositories: { "marius-patrik/Andromeda": { state: "active" } },
      registrationChecks: "wrong-app"
    }), TARGET),
    (error: unknown) => error instanceof ManagedRegistrationTrustViolation
      && /DarkFactory Autoreview is not exact green App-bound evidence/.test(error.message)
  );
  assert.equal(calls.includes("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge"), false);
});

test("managed registration admits a complete stable multi-page check inventory", async () => {
  const calls: string[] = [];
  const result = await convergeManagedRegistration(fixtureGithub(calls, {
    repositories: { "marius-patrik/Andromeda": { state: "active" } },
    registrationCheckPage(page, headSha) {
      if (page === 1) {
        return {
          total_count: 102,
          check_runs: greenRegistrationChecks(headSha, 100, 100)
        };
      }
      if (page === 2) {
        return {
          total_count: 102,
          check_runs: requiredRegistrationChecks(headSha)
        };
      }
      throw new Error(`unexpected registration check page ${page}`);
    }
  }), TARGET);

  assert.equal(result.sourceActive, true);
  assert.equal(calls.filter((route) => route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs").length, 4);
  assert.equal(calls.includes("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge"), true);
});

test("managed registration rejects a truncated check page before direct merge", async () => {
  const calls: string[] = [];
  await assert.rejects(
    convergeManagedRegistration(fixtureGithub(calls, {
      repositories: { "marius-patrik/Andromeda": { state: "active" } },
      registrationCheckPage(page, headSha) {
        assert.equal(page, 1);
        return {
          total_count: 3,
          check_runs: requiredRegistrationChecks(headSha)
        };
      }
    }), TARGET),
    (error: unknown) => error instanceof ManagedRegistrationTrustViolation
      && /inventory ended before its declared total/.test(error.message)
  );
  assert.equal(calls.includes("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge"), false);
});

test("managed registration rejects check total drift during pagination", async () => {
  const calls: string[] = [];
  await assert.rejects(
    convergeManagedRegistration(fixtureGithub(calls, {
      repositories: { "marius-patrik/Andromeda": { state: "active" } },
      registrationCheckPage(page, headSha) {
        if (page === 1) {
          return {
            total_count: 101,
            check_runs: [...requiredRegistrationChecks(headSha), ...greenRegistrationChecks(headSha, 98, 100)]
          };
        }
        if (page === 2) {
          return {
            total_count: 102,
            check_runs: greenRegistrationChecks(headSha, 1, 1_000)
          };
        }
        throw new Error(`unexpected registration check page ${page}`);
      }
    }), TARGET),
    (error: unknown) => error instanceof ManagedRegistrationTrustViolation
      && /check total changed during pagination/.test(error.message)
  );
  assert.equal(calls.includes("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge"), false);
});

test("managed registration rejects duplicate check ids across pages", async () => {
  const calls: string[] = [];
  await assert.rejects(
    convergeManagedRegistration(fixtureGithub(calls, {
      repositories: { "marius-patrik/Andromeda": { state: "active" } },
      registrationCheckPage(page, headSha) {
        if (page === 1) {
          return {
            total_count: 101,
            check_runs: [...requiredRegistrationChecks(headSha), ...greenRegistrationChecks(headSha, 98, 100)]
          };
        }
        if (page === 2) {
          return {
            total_count: 101,
            check_runs: [greenRegistrationCheck(headSha, 10, "Validate")]
          };
        }
        throw new Error(`unexpected registration check page ${page}`);
      }
    }), TARGET),
    (error: unknown) => error instanceof ManagedRegistrationTrustViolation
      && /duplicate check id/.test(error.message)
  );
  assert.equal(calls.includes("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge"), false);
});

test("managed registration resumes branch-only partial mutations and creates the missing pull request", async () => {
  for (const [label, branchHead, branchContent] of [
    ["branch-created", MAIN_SHA, undefined],
    ["content-written", BRANCH_SHA, expectedRegistryContent({
      "marius-patrik/Andromeda": { state: "active" },
      "marius-patrik/example": managedTargetEntry()
    })]
  ] as const) {
    const calls: string[] = [];
    const result = await convergeManagedRegistration(fixtureGithub(calls, {
      repositories: { "marius-patrik/Andromeda": { state: "active" } },
      branchExists: true,
      branchHead,
      branchContent
    }), TARGET);
    assert.equal(result.receipt.status, "applied", label);
    assert.equal(calls.includes("POST /repos/{owner}/{repo}/git/refs"), false, label);
    assert.equal(calls.includes("POST /repos/{owner}/{repo}/pulls"), true, label);
    assert.equal(calls.includes("PUT /repos/{owner}/{repo}/contents/{path}"), label === "branch-created", label);
  }
});

test("managed registration upgrades only the exact deterministic legacy App pull request", async () => {
  const calls: string[] = [];
  const repositories = { "marius-patrik/Andromeda": { state: "active" } };
  const result = await convergeManagedRegistration(fixtureGithub(calls, {
    repositories,
    existingPull: true,
    branchHead: BRANCH_SHA,
    branchContent: expectedRegistryContent({ ...repositories, [TARGET]: managedTargetEntry() }),
    existingPullBody: legacyRegistrationBody()
  }), TARGET);

  assert.equal(result.receipt.status, "applied");
  assert.equal(calls.includes("PATCH /repos/{owner}/{repo}/pulls/{pull_number}"), true);
  assert.equal(calls.includes("PATCH /repos/{owner}/{repo}/git/refs/{ref}"), false);
  assert.equal(calls.includes("PUT /repos/{owner}/{repo}/contents/{path}"), false);
});

test("managed registration preserves a predictable branch carrying unknown work", async () => {
  const calls: string[] = [];
  await assert.rejects(convergeManagedRegistration(fixtureGithub(calls, {
    repositories: {},
    branchExists: true,
    branchHead: BRANCH_SHA,
    comparisonFiles: [MANAGED_REGISTRY_PATH, "README.md"]
  }), TARGET), (error: unknown) => error instanceof ManagedRegistrationTrustViolation
    && /unknown or conflicting work/.test(error.message));
  assert.equal(calls.includes("PUT /repos/{owner}/{repo}/contents/{path}"), false);
  assert.equal(calls.includes("PATCH /repos/{owner}/{repo}/git/refs/{ref}"), false);
  assert.equal(calls.includes("POST /repos/{owner}/{repo}/pulls"), false);
});

test("managed registration refuses parked targets and competing pull-request content", async () => {
  await assert.rejects(
    convergeManagedRegistration(fixtureGithub([], { repositories: { "marius-patrik/example": { state: "parked" } } }), TARGET),
    /owner lifecycle brake/
  );
  const calls: string[] = [];
  await assert.rejects(
    convergeManagedRegistration(fixtureGithub(calls, {
      repositories: {},
      existingPull: true,
      branchHead: BRANCH_SHA,
      branchContent: expectedRegistryContent({ "marius-patrik/other": { state: "active" } })
    }), TARGET),
    (error: unknown) => error instanceof ManagedRegistrationTrustViolation
      && /unknown or conflicting work/.test(error.message)
  );
  assert.equal(calls.includes("PATCH /repos/{owner}/{repo}/git/refs/{ref}"), false);
  assert.equal(calls.includes("PATCH /repos/{owner}/{repo}/pulls/{pull_number}"), false);
});

test("managed registration safely rebases an exact concurrent App pull request after main advances", async () => {
  const calls: string[] = [];
  const priorRepositories = { "marius-patrik/Andromeda": { state: "active" } };
  const repositories = {
    ...priorRepositories,
    "marius-patrik/newly-landed": { state: "active", kind: "code" }
  };
  const priorContent = expectedRegistryContent({ ...priorRepositories, [TARGET]: managedTargetEntry() });
  const currentContent = expectedRegistryContent({ ...repositories, [TARGET]: managedTargetEntry() });
  const commits: Record<string, unknown>[] = [];
  const refUpdates: Record<string, unknown>[] = [];
  const pullUpdates: Record<string, unknown>[] = [];
  const github = fixtureGithub(calls, {
    repositories,
    priorRepositories,
    priorBaseHead: PRIOR_BASE_SHA,
    existingPull: true,
    branchHead: BRANCH_SHA,
    branchContent: priorContent,
    existingPullBody: registrationBody(PRIOR_BASE_SHA, BRANCH_SHA, priorContent),
    onCreateCommit(parameters) { commits.push(parameters); },
    onUpdateRef(parameters) { refUpdates.push(parameters); },
    onUpdatePull(parameters) { pullUpdates.push(parameters); }
  });

  const result = await convergeManagedRegistration(github, TARGET);

  assert.equal(result.receipt.status, "applied");
  assert.match(result.receipt.detail, new RegExp(PULL_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0].parents, [BRANCH_SHA, MAIN_SHA]);
  assert.equal(commits[0].tree, RECOVERY_TREE_SHA);
  assert.equal(refUpdates.length, 1);
  assert.equal(refUpdates[0].sha, RECOVERY_SHA);
  assert.equal(refUpdates[0].force, false);
  assert.equal(pullUpdates.length, 1);
  assert.match(String(pullUpdates[0].body), new RegExp(`base=${MAIN_SHA} head=${RECOVERY_SHA}`));
  assert.equal(calls.includes("PUT /repos/{owner}/{repo}/contents/{path}"), false);
  assert.ok(calls.filter((route) => route === "GET /repos/{owner}/{repo}/pulls/{pull_number}").length >= 2);
  assert.ok(calls.filter((route) => route === "GET /repos/{owner}/{repo}/git/ref/{ref}").length >= 6);
  assert.equal(currentContent, expectedRegistryContent({ ...repositories, [TARGET]: managedTargetEntry() }));
});

test("managed registration resumes an exact crash after the recovery ref update", async () => {
  const calls: string[] = [];
  const priorRepositories = { "marius-patrik/Andromeda": { state: "active" } };
  const repositories = {
    ...priorRepositories,
    "marius-patrik/newly-landed": { state: "active", kind: "code" }
  };
  const priorContent = expectedRegistryContent({ ...priorRepositories, [TARGET]: managedTargetEntry() });
  const result = await convergeManagedRegistration(fixtureGithub(calls, {
    repositories,
    priorRepositories,
    priorBaseHead: PRIOR_BASE_SHA,
    existingPull: true,
    existingPullBody: registrationBody(PRIOR_BASE_SHA, BRANCH_SHA, priorContent),
    startAfterRefUpdate: true
  }), TARGET);

  assert.equal(result.receipt.status, "applied");
  assert.equal(calls.includes("POST /repos/{owner}/{repo}/git/commits"), false);
  assert.equal(calls.includes("PATCH /repos/{owner}/{repo}/git/refs/{ref}"), false);
  assert.equal(calls.includes("PATCH /repos/{owner}/{repo}/pulls/{pull_number}"), true);
});

test("managed registration blocks a concurrent pull body edit after the recovery ref update", async () => {
  const calls: string[] = [];
  const priorRepositories = { "marius-patrik/Andromeda": { state: "active" } };
  const priorContent = expectedRegistryContent({ ...priorRepositories, [TARGET]: managedTargetEntry() });
  await assert.rejects(
    convergeManagedRegistration(fixtureGithub(calls, {
      repositories: { ...priorRepositories, "marius-patrik/newly-landed": { state: "active" } },
      priorRepositories,
      priorBaseHead: PRIOR_BASE_SHA,
      existingPull: true,
      branchHead: BRANCH_SHA,
      branchContent: priorContent,
      existingPullBody: registrationBody(PRIOR_BASE_SHA, BRANCH_SHA, priorContent),
      driftBodyAfterRefUpdate: true
    }), TARGET),
    (error: unknown) => error instanceof ManagedRegistrationTrustViolation
      && /body changed after admission; preserved the concurrent edit/.test(error.message)
  );
  assert.equal(calls.includes("PATCH /repos/{owner}/{repo}/git/refs/{ref}"), true);
  assert.equal(calls.includes("PATCH /repos/{owner}/{repo}/pulls/{pull_number}"), false);
});

test("managed registration fails closed when a concurrent ref update conflicts", async () => {
  const calls: string[] = [];
  const priorRepositories = { "marius-patrik/Andromeda": { state: "active" } };
  const priorContent = expectedRegistryContent({ ...priorRepositories, [TARGET]: managedTargetEntry() });
  await assert.rejects(
    convergeManagedRegistration(fixtureGithub(calls, {
      repositories: { ...priorRepositories, "marius-patrik/newly-landed": { state: "active" } },
      priorRepositories,
      priorBaseHead: PRIOR_BASE_SHA,
      existingPull: true,
      branchHead: BRANCH_SHA,
      branchContent: priorContent,
      existingPullBody: registrationBody(PRIOR_BASE_SHA, BRANCH_SHA, priorContent),
      updateConflict: true
    }), TARGET),
    (error: unknown) => error instanceof ManagedRegistrationTrustViolation
      && /update conflicted; preserved existing work and blocked recovery \(409\)/.test(error.message)
  );
  assert.equal(calls.includes("PATCH /repos/{owner}/{repo}/git/refs/{ref}"), true);
  assert.equal(calls.includes("PATCH /repos/{owner}/{repo}/pulls/{pull_number}"), false);
  assert.equal(calls.includes("PUT /repos/{owner}/{repo}/contents/{path}"), false);
});

interface FixtureOptions {
  repositories: Record<string, unknown>;
  priorRepositories?: Record<string, unknown>;
  priorBaseHead?: string;
  existingPull?: boolean;
  existingPullBody?: string;
  branchExists?: boolean;
  branchHead?: string;
  branchContent?: string;
  comparisonFiles?: string[];
  updateConflict?: boolean;
  startAfterRefUpdate?: boolean;
  driftBodyAfterRefUpdate?: boolean;
  registrationChecks?: "pending" | "green" | "red" | "wrong-app";
  registrationReviewCheck?: "DarkFactory Autoreview" | "Codex Review";
  registrationCheckPage?: (page: number, headSha: string) => {
    total_count: number;
    check_runs: Record<string, unknown>[];
  };
  onWrite?: (parameters: Record<string, unknown>) => void;
  onCreateCommit?: (parameters: Record<string, unknown>) => void;
  onUpdateRef?: (parameters: Record<string, unknown>) => void;
  onUpdatePull?: (parameters: Record<string, unknown>) => void;
}

function fixtureGithub(calls: string[], options: FixtureOptions) {
  const branch = "darkfactory/register-marius-patrik-example";
  let branchExists = options.branchExists === true || options.existingPull === true;
  let branchHead = options.branchHead ?? BRANCH_SHA;
  let branchContent = options.branchContent;
  let pullExists = options.existingPull === true;
  let pullBody = options.existingPullBody ?? "<!-- darkfactory:managed-registration-pr -->";
  let mainHead = MAIN_SHA;
  let pullMerged = false;
  const recoveryCommits = new Map<string, { treeSha: string; parents: string[] }>();

  const fileResponse = (raw: string) => ({
    data: {
      sha: FILE_SHA,
      encoding: "base64",
      content: Buffer.from(raw).toString("base64")
    }
  });
  const mainContent = expectedRegistryContent(options.repositories);
  let canonicalMainContent = mainContent;
  const priorContent = expectedRegistryContent(options.priorRepositories ?? options.repositories);
  if (options.startAfterRefUpdate) {
    branchHead = RECOVERY_SHA;
    branchContent = mainContentForTarget(mainContent);
    recoveryCommits.set(RECOVERY_SHA, {
      treeSha: RECOVERY_TREE_SHA,
      parents: [BRANCH_SHA, MAIN_SHA]
    });
  }
  const pullResponse = () => ({
    number: 77,
    html_url: PULL_URL,
    state: pullMerged ? "closed" : "open",
    draft: false,
    title: `Register ${TARGET} for DarkFactory management`,
    commits: recoveryCommits.has(branchHead) ? 2 : 1,
    body: pullBody,
    user: { login: "darkfactory-agent[bot]", type: "Bot" },
    base: {
      ref: "main",
      sha: MAIN_SHA,
      repo: { full_name: "marius-patrik/Andromeda-data" }
    },
    head: {
      ref: branch,
      sha: branchHead,
      repo: { full_name: "marius-patrik/Andromeda-data" }
    },
    mergeable: true,
    mergeable_state: "clean",
    ...(pullMerged ? {
      merged: true,
      merged_at: "2026-07-16T12:00:00Z",
      merge_commit_sha: MERGE_SHA,
      merged_by: { login: "darkfactory-agent[bot]", type: "Bot" }
    } : {})
  });

  return {
    async request(route: string, parameters: Record<string, unknown>) {
      calls.push(route);
      if (route === "GET /repos/{owner}/{repo}") {
        return { data: { private: true, default_branch: "main", archived: false, disabled: false } };
      }
      if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
        assert.equal(parameters.path, MANAGED_REGISTRY_PATH);
        if (parameters.ref === "main") return fileResponse(canonicalMainContent);
        if (parameters.ref === MAIN_SHA) return fileResponse(mainContent);
        if (parameters.ref === mainHead) return fileResponse(canonicalMainContent);
        if (parameters.ref === options.priorBaseHead) return fileResponse(priorContent);
        if (options.startAfterRefUpdate && parameters.ref === BRANCH_SHA) {
          return fileResponse(mainContentForTarget(priorContent));
        }
        if (parameters.ref === branch || parameters.ref === branchHead) {
          return fileResponse(branchContent ?? (branchHead === MAIN_SHA ? mainContent : priorContent));
        }
        throw new Error(`unexpected registry ref ${String(parameters.ref)}`);
      }
      if (route === "GET /repos/{owner}/{repo}/pulls") {
        return { data: pullExists ? [{ number: 77, html_url: PULL_URL }] : [] };
      }
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
        assert.equal(parameters.pull_number, 77);
        return { data: pullResponse() };
      }
      if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") {
        if (parameters.ref === "heads/main") return { data: { object: { sha: mainHead } } };
        if (parameters.ref === `heads/${branch}` && branchExists) return { data: { object: { sha: branchHead } } };
        throw Object.assign(new Error("missing"), { status: 404 });
      }
      if (route === "GET /repos/{owner}/{repo}/compare/{basehead}") {
        const basehead = String(parameters.basehead);
        const [base, head] = basehead.split("...");
        if (options.priorBaseHead && base === MAIN_SHA && head === BRANCH_SHA) {
          return { data: { status: "diverged", ahead_by: 1, behind_by: 1, files: [{ filename: MANAGED_REGISTRY_PATH }] } };
        }
        return {
          data: {
            status: "ahead",
            ahead_by: recoveryCommits.has(head) ? 2 : 1,
            behind_by: 0,
            files: (options.comparisonFiles ?? [MANAGED_REGISTRY_PATH]).map((filename) => ({ filename }))
          }
        };
      }
      if (route === "GET /repos/{owner}/{repo}/git/commits/{commit_sha}") {
        const sha = String(parameters.commit_sha);
        const recovery = recoveryCommits.get(sha);
        if (recovery) return { data: { tree: { sha: recovery.treeSha }, parents: recovery.parents.map((parent) => ({ sha: parent })) } };
        if (sha === branchHead || sha === BRANCH_SHA) {
          return {
            data: {
              tree: { sha: BRANCH_TREE_SHA },
              parents: [{ sha: options.priorBaseHead ?? MAIN_SHA }]
            }
          };
        }
        if (sha === MAIN_SHA) {
          return {
            data: {
              tree: { sha: MAIN_TREE_SHA },
              parents: options.priorBaseHead ? [{ sha: options.priorBaseHead }] : []
            }
          };
        }
        throw new Error(`unexpected commit ${sha}`);
      }
      if (route === "GET /installation") {
        return { data: { app_slug: "darkfactory-agent", app_id: 12345 } };
      }
      if (route === "GET /repos/{owner}/{repo}/commits/{ref}") {
        return { data: { author: { login: "darkfactory-agent[bot]", type: "Bot" } } };
      }
      if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
        if (options.registrationCheckPage) {
          return { data: options.registrationCheckPage(Number(parameters.page), branchHead) };
        }
        if (options.registrationChecks === undefined || options.registrationChecks === "pending") {
          return { data: { total_count: 0, check_runs: [] } };
        }
        const validateConclusion = options.registrationChecks === "red" ? "failure" : "success";
        const reviewAppId = options.registrationChecks === "wrong-app" ? 99999 : 15368;
        return {
          data: {
            total_count: 2,
            check_runs: [
              { id: 10, name: "Validate", head_sha: branchHead, status: "completed", conclusion: validateConclusion, app: { id: 15368 } },
              { id: 11, name: options.registrationReviewCheck ?? "DarkFactory Autoreview", head_sha: branchHead, status: "completed", conclusion: "success", app: { id: reviewAppId } }
            ]
          }
        };
      }
      if (route === "POST /repos/{owner}/{repo}/git/refs") {
        branchExists = true;
        branchHead = String(parameters.sha);
        branchContent = mainContent;
        return { data: {} };
      }
      if (route === "PUT /repos/{owner}/{repo}/contents/{path}") {
        options.onWrite?.(parameters);
        branchHead = WRITTEN_SHA;
        branchContent = Buffer.from(String(parameters.content), "base64").toString("utf8");
        return { data: { commit: { sha: WRITTEN_SHA } } };
      }
      if (route === "POST /repos/{owner}/{repo}/git/trees") {
        const tree = parameters.tree as Array<Record<string, unknown>>;
        assert.equal(parameters.base_tree, MAIN_TREE_SHA);
        assert.equal(tree.length, 1);
        assert.equal(tree[0].path, MANAGED_REGISTRY_PATH);
        assert.equal(tree[0].content, mainContentForTarget(mainContent));
        return { data: { sha: RECOVERY_TREE_SHA } };
      }
      if (route === "POST /repos/{owner}/{repo}/git/commits") {
        options.onCreateCommit?.(parameters);
        const parents = parameters.parents as string[];
        recoveryCommits.set(RECOVERY_SHA, { treeSha: String(parameters.tree), parents });
        return { data: { sha: RECOVERY_SHA } };
      }
      if (route === "PATCH /repos/{owner}/{repo}/git/refs/{ref}") {
        options.onUpdateRef?.(parameters);
        if (options.updateConflict) throw Object.assign(new Error("conflict"), { status: 409 });
        assert.equal(parameters.force, false);
        branchHead = String(parameters.sha);
        branchContent = mainContentForTarget(mainContent);
        if (options.driftBodyAfterRefUpdate) pullBody = `${pullBody}\nconcurrent unadmitted edit`;
        return { data: {} };
      }
      if (route === "POST /repos/{owner}/{repo}/pulls") {
        pullExists = true;
        pullBody = String(parameters.body);
        return { data: { number: 77, html_url: PULL_URL } };
      }
      if (route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}") {
        options.onUpdatePull?.(parameters);
        pullBody = String(parameters.body);
        return { data: {} };
      }
      if (route === "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge") {
        assert.equal(parameters.sha, branchHead);
        assert.equal(parameters.merge_method, "squash");
        pullMerged = true;
        mainHead = MERGE_SHA;
        canonicalMainContent = branchContent ?? mainContentForTarget(mainContent);
        return { data: { merged: true, message: "Pull Request successfully merged", sha: MERGE_SHA } };
      }
      throw new Error(`unexpected route ${route}`);
    }
  };
}

function greenRegistrationCheck(headSha: string, id: number, name: string): Record<string, unknown> {
  return {
    id,
    name,
    head_sha: headSha,
    status: "completed",
    conclusion: "success",
    app: { id: 15368 }
  };
}

function greenRegistrationChecks(headSha: string, count: number, firstId: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => greenRegistrationCheck(
    headSha,
    firstId + index,
    `Supplemental ${firstId + index}`
  ));
}

function requiredRegistrationChecks(headSha: string): Record<string, unknown>[] {
  return [
    greenRegistrationCheck(headSha, 10, "Validate"),
    greenRegistrationCheck(headSha, 11, "DarkFactory Autoreview")
  ];
}

function managedTargetEntry(): Record<string, unknown> {
  return {
    state: "active",
    kind: "code",
    note: "Managed code repository admitted through the reviewed df setup registration lane."
  };
}

function mainContentForTarget(mainContent: string): string {
  const parsed = JSON.parse(mainContent) as { repositories: Record<string, unknown> };
  return expectedRegistryContent({ ...parsed.repositories, [TARGET]: managedTargetEntry() });
}

function registrationBody(baseSha: string, headSha: string, content: string): string {
  const digest = createHash("sha256").update(content).digest("hex");
  return [
    "<!-- darkfactory:managed-registration-pr -->",
    `<!-- darkfactory:managed-registration schema=1 target=${TARGET} base=${baseSha} head=${headSha} content-sha256=${digest} -->`,
    "## Summary"
  ].join("\n");
}

function legacyRegistrationBody(): string {
  return [
    "## Summary",
    "",
    `- register \`${TARGET}\` as an active managed code repository`,
    "- preserve every existing lifecycle entry exactly",
    "",
    "## Safety",
    "",
    "This reviewed source-policy change does not touch the target repository or override parked/archived state."
  ].join("\n");
}

function expectedRegistryContent(repositories: Record<string, unknown>): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    description: "fixture",
    repositories: Object.fromEntries(Object.entries(repositories).sort(([a], [b]) => a.localeCompare(b)))
  }, null, 2)}\n`;
}
