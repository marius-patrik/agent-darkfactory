import test from "node:test";
import assert from "node:assert/strict";

import {
  dispatchDevMergeClosure,
  dispatchOrchestrator,
  dispatchReleaseConvergence,
  shouldDispatchDevMergeClosure,
  shouldDispatchForReadyLabel,
  shouldDispatchForRunComment,
  shouldDispatchReleaseConvergence,
  syncRepositories,
  type GitHubRequester
} from "../src/bot.js";
import { MANAGED_SETUP_BRANCH } from "../src/managed-sync.js";
import type { ManagedFile } from "../src/managed-files.js";

const MANAGED_FILES: ManagedFile[] = [
  { path: "AGENTS.md", content: "# Agent Entry Point\n" },
  { path: ".github/workflows/ci.yml", content: "name: CI\n" },
  {
    path: ".darkfactory/managed-repository.json",
    content: JSON.stringify({
      schemaVersion: 1,
      dataRepo: "marius-patrik/Andromeda-data",
      ledgerRepo: "marius-patrik/darkfactory-data",
      packageFiles: [],
      requiredFiles: [],
      removedFiles: []
    })
  }
];

test("syncRepositories processes DarkFactory control repository first", async () => {
  const order: string[] = [];
  const requester = createRequester({
    onSetupRef(owner, repo) {
      order.push(`${owner}/${repo}`);
    }
  });

  await syncRepositories(
    requester,
    [
      { full_name: "marius-patrik/dream", default_branch: "main", archived: false },
      { full_name: "marius-patrik/DarkFactory", default_branch: "main", archived: false },
      { full_name: "marius-patrik/agents-plugin", default_branch: "main", archived: false }
    ],
    MANAGED_FILES
  );

  assert.deepEqual(order, ["marius-patrik/DarkFactory", "marius-patrik/dream", "marius-patrik/agents-plugin"]);
});

test("syncRepositories stops when DarkFactory control repository sync fails", async () => {
  const order: string[] = [];
  const requester = createRequester({
    onSetupRef(owner, repo) {
      order.push(`${owner}/${repo}`);

      if (repo === "DarkFactory") {
        throw new Error("control repo sync failed");
      }
    }
  });

  await syncRepositories(
    requester,
    [
      { full_name: "marius-patrik/dream", default_branch: "main", archived: false },
      { full_name: "marius-patrik/DarkFactory", default_branch: "main", archived: false },
      { full_name: "marius-patrik/agents-plugin", default_branch: "main", archived: false }
    ],
    MANAGED_FILES
  );

  assert.deepEqual(order, ["marius-patrik/DarkFactory"]);
});

test("syncRepositories continues when a non-control repository sync fails", async () => {
  const order: string[] = [];
  const requester = createRequester({
    onSetupRef(owner, repo) {
      order.push(`${owner}/${repo}`);
    },
    onCommit(owner, repo) {
      if (repo === "dream") {
        throw new Error("dream sync failed");
      }

      return { sha: "new-commit-sha" };
    }
  });

  await syncRepositories(
    requester,
    [
      { full_name: "marius-patrik/dream", default_branch: "main", archived: false },
      { full_name: "marius-patrik/DarkFactory", default_branch: "main", archived: false },
      { full_name: "marius-patrik/agents-plugin", default_branch: "main", archived: false }
    ],
    MANAGED_FILES
  );

  assert.deepEqual(order, [
    "marius-patrik/DarkFactory",
    "marius-patrik/dream",
    "marius-patrik/agents-plugin"
  ]);
});

test("shouldDispatchForReadyLabel returns true only for df:ready on issues", () => {
  const base = {
    repository: { name: "dream", owner: { login: "marius-patrik" } },
    issue: { number: 1 }
  };

  assert.equal(shouldDispatchForReadyLabel({ ...base, label: { name: "df:ready" } }), true);
  assert.equal(shouldDispatchForReadyLabel({ ...base, label: { name: "P1" } }), false);
  assert.equal(
    shouldDispatchForReadyLabel({ ...base, label: { name: "df:ready" }, issue: { number: 1, pull_request: {} } }),
    false
  );
});

test("shouldDispatchForRunComment returns true only for trusted authors on issues", () => {
  const base = {
    repository: { name: "dream", owner: { login: "marius-patrik" } },
    issue: { number: 1 },
    comment: { body: "/df run", author_association: "OWNER" }
  };

  assert.equal(shouldDispatchForRunComment(base), true);
  assert.equal(shouldDispatchForRunComment({ ...base, comment: { ...base.comment, body: "/df run extra" } }), true);
  assert.equal(shouldDispatchForRunComment({ ...base, comment: { ...base.comment, body: "/df audit" } }), false);
  assert.equal(
    shouldDispatchForRunComment({ ...base, comment: { ...base.comment, author_association: "CONTRIBUTOR" } }),
    false
  );
  assert.equal(
    shouldDispatchForRunComment({
      ...base,
      issue: { number: 1, pull_request: {} },
      comment: { ...base.comment }
    }),
    false
  );
});

test("dispatchOrchestrator dispatches df-orchestrate.yml in the control repository", async () => {
  const requests: { route: string; parameters: Record<string, unknown> }[] = [];
  const requester: GitHubRequester = {
    async request(route, parameters) {
      requests.push({ route, parameters });
      return { data: {} };
    }
  };

  await dispatchOrchestrator(
    requester,
    { owner: "marius-patrik", repo: "DarkFactory" },
    {
      repository: { name: "dream", owner: { login: "marius-patrik" } },
      issue: { number: 42 }
    },
    "issues"
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0].route, "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches");
  assert.deepEqual(requests[0].parameters, {
    owner: "marius-patrik",
    repo: "DarkFactory",
    workflow_id: "df-orchestrate.yml",
    ref: "main",
    inputs: {
      repo: "marius-patrik/dream",
      issue_number: "42",
      source_event: "issues"
    }
  });
});

test("dispatchOrchestrator swallows dispatch errors", async () => {
  const requester: GitHubRequester = {
    async request() {
      throw new Error("dispatch failed");
    }
  };

  await assert.doesNotReject(async () => {
    await dispatchOrchestrator(
      requester,
      { owner: "marius-patrik", repo: "DarkFactory" },
      {
        repository: { name: "dream", owner: { login: "marius-patrik" } },
        issue: { number: 42 }
      },
      "issues"
    );
  });
});

test("dev-merge closure dispatch requires an exact merged dev identity", () => {
  const payload = devMergePayload();

  assert.equal(shouldDispatchDevMergeClosure(payload), true);
  assert.equal(shouldDispatchDevMergeClosure(devMergePayload({ merged: false })), false);
  assert.equal(shouldDispatchDevMergeClosure(devMergePayload({ base: { ref: "main" } })), false);
  assert.equal(shouldDispatchDevMergeClosure(devMergePayload({ merge_commit_sha: "not-a-sha" })), false);
});

test("dispatchDevMergeClosure forwards only immutable identifiers to protected main", async () => {
  const requests: { route: string; parameters: Record<string, unknown> }[] = [];
  const requester: GitHubRequester = {
    async request(route, parameters) {
      requests.push({ route, parameters });
      return { data: {} };
    }
  };

  await dispatchDevMergeClosure(
    requester,
    { owner: "marius-patrik", repo: "DarkFactory" },
    devMergePayload()
  );

  assert.deepEqual(requests, [{
    route: "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
    parameters: {
      owner: "marius-patrik",
      repo: "DarkFactory",
      workflow_id: "df-follow-through.yml",
      ref: "main",
      inputs: {
        repo: "marius-patrik/Andromeda",
        pull_number: "42",
        merge_sha: "0123456789abcdef0123456789abcdef01234567"
      }
    }
  }]);
});

test("dispatchDevMergeClosure leaves scheduled recovery available on dispatch failure", async () => {
  const requester: GitHubRequester = {
    async request() {
      throw new Error("dispatch unavailable");
    }
  };

  await assert.doesNotReject(() => dispatchDevMergeClosure(
    requester,
    { owner: "marius-patrik", repo: "DarkFactory" },
    devMergePayload()
  ));
});

test("release convergence bridge follows merged main and dev PRs only", async () => {
  assert.equal(shouldDispatchReleaseConvergence(devMergePayload()), true);
  assert.equal(shouldDispatchReleaseConvergence(devMergePayload({ base: { ref: "main" } })), true);
  assert.equal(shouldDispatchReleaseConvergence(devMergePayload({ base: { ref: "feature" } })), false);
  assert.equal(shouldDispatchReleaseConvergence(devMergePayload({ merged: false })), false);

  const requests: Array<{ route: string; parameters: Record<string, unknown> }> = [];
  await dispatchReleaseConvergence({
    async request(route, parameters) {
      requests.push({ route, parameters });
      return { data: {} };
    }
  }, { owner: "marius-patrik", repo: "DarkFactory" }, devMergePayload());

  assert.deepEqual(requests[0].parameters, {
    owner: "marius-patrik",
    repo: "DarkFactory",
    workflow_id: "df-release.yml",
    ref: "main",
    inputs: { repo: "marius-patrik/Andromeda", mode: "run" }
  });
});

function devMergePayload(overrides: Record<string, unknown> = {}) {
  return {
    repository: { name: "Andromeda", owner: { login: "marius-patrik" } },
    pull_request: {
      number: 42,
      merged: true,
      merge_commit_sha: "0123456789abcdef0123456789abcdef01234567",
      base: { ref: "dev" },
      head: {
        sha: "abcdef0123456789abcdef0123456789abcdef01",
        repo: { name: "Andromeda", owner: { login: "marius-patrik" } }
      },
      ...overrides
    }
  };
}

interface RequesterHooks {
  onSetupRef?(owner: string, repo: string): void;
  onCommit?(owner: string, repo: string): { sha: string };
}

function createRequester(hooks: RequesterHooks): GitHubRequester {
  return {
    async request(route, parameters) {
      const owner = String(parameters.owner);
      const repo = String(parameters.repo);

      if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") {
        if (parameters.ref === `heads/${MANAGED_SETUP_BRANCH}`) {
          hooks.onSetupRef?.(owner, repo);
          throw { status: 404 };
        }

        return { data: { object: { sha: "base-sha" } } };
      }

      if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
        throw { status: 404 };
      }

      if (route === "GET /repos/{owner}/{repo}/git/commits/{commit_sha}") {
        return { data: { tree: { sha: "tree-sha" } } };
      }

      if (route === "GET /repos/{owner}/{repo}/git/trees/{tree_sha}") {
        return { data: { tree: [], truncated: false } };
      }

      if (route === "POST /repos/{owner}/{repo}/git/trees") {
        return { data: { sha: "new-tree-sha" } };
      }

      if (route === "POST /repos/{owner}/{repo}/git/commits") {
        return { data: hooks.onCommit?.(owner, repo) ?? { sha: "new-commit-sha" } };
      }

      if (route === "POST /repos/{owner}/{repo}/git/refs") {
        return { data: {} };
      }

      if (route === "GET /repos/{owner}/{repo}/pulls") {
        return { data: [] };
      }

      if (route === "POST /repos/{owner}/{repo}/pulls") {
        return { data: { html_url: `https://github.com/${owner}/${repo}/pull/1` } };
      }

      throw new Error(`Unexpected route ${route}`);
    }
  };
}
