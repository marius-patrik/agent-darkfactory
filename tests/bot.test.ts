import test from "node:test";
import assert from "node:assert/strict";

import { syncRepositories, type GitHubRequester } from "../src/bot.js";
import { MANAGED_SETUP_BRANCH } from "../src/managed-sync.js";
import type { ManagedFile } from "../src/managed-files.js";

const MANAGED_FILES: ManagedFile[] = [
  { path: "AGENTS.md", content: "# Agent Entry Point\n" },
  { path: ".agents/.global/VERSION", content: "agent-darkfactory@1.0.0\n" },
  { path: ".github/workflows/ci.yml", content: "name: CI\n" }
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
      { full_name: "marius-patrik/agent-darkfactory", default_branch: "main", archived: false },
      { full_name: "marius-patrik/agents-plugin", default_branch: "main", archived: false }
    ],
    MANAGED_FILES
  );

  assert.deepEqual(order, ["marius-patrik/agent-darkfactory", "marius-patrik/dream", "marius-patrik/agents-plugin"]);
});

test("syncRepositories stops when DarkFactory control repository sync fails", async () => {
  const order: string[] = [];
  const requester = createRequester({
    onSetupRef(owner, repo) {
      order.push(`${owner}/${repo}`);

      if (repo === "agent-darkfactory") {
        throw new Error("control repo sync failed");
      }
    }
  });

  await syncRepositories(
    requester,
    [
      { full_name: "marius-patrik/dream", default_branch: "main", archived: false },
      { full_name: "marius-patrik/agent-darkfactory", default_branch: "main", archived: false },
      { full_name: "marius-patrik/agents-plugin", default_branch: "main", archived: false }
    ],
    MANAGED_FILES
  );

  assert.deepEqual(order, ["marius-patrik/agent-darkfactory"]);
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
      { full_name: "marius-patrik/agent-darkfactory", default_branch: "main", archived: false },
      { full_name: "marius-patrik/agents-plugin", default_branch: "main", archived: false }
    ],
    MANAGED_FILES
  );

  assert.deepEqual(order, [
    "marius-patrik/agent-darkfactory",
    "marius-patrik/dream",
    "marius-patrik/agents-plugin"
  ]);
});

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
