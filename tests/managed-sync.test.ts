import test from "node:test";
import assert from "node:assert/strict";

import {
  ensureManagedRepositorySetup,
  managedSetupPullRequestBody,
  MANAGED_SETUP_BRANCH,
  type GitHubRequester
} from "../src/managed-sync.js";
import type { ManagedFile } from "../src/managed-files.js";

test("managedSetupPullRequestBody lists changed files and preserves project-specific state", () => {
  const body = managedSetupPullRequestBody([
    ".agents/.global/VERSION",
    ".github/workflows/vibe-bot-bootstrap.yml"
  ]);

  assert.match(body, /\.agents\/\.global\/VERSION/);
  assert.match(body, /\.github\/workflows\/vibe-bot-bootstrap\.yml/);
  assert.match(body, /Project-specific `.agents\/.project` files are not changed/);
});

test("ensureManagedRepositorySetup creates a managed PR when files are missing", async () => {
  const calls: Array<{ route: string; parameters: Record<string, unknown> }> = [];
  const requester: GitHubRequester = {
    async request(route, parameters) {
      calls.push({ route, parameters });

      if (route === "GET /repos/{owner}/{repo}") {
        return { data: { default_branch: "main", archived: false } };
      }

      if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") {
        if (parameters.ref === `heads/${MANAGED_SETUP_BRANCH}`) {
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
        return { data: { sha: "new-commit-sha" } };
      }

      if (route === "POST /repos/{owner}/{repo}/git/refs") {
        return { data: {} };
      }

      if (route === "GET /repos/{owner}/{repo}/pulls") {
        return { data: [] };
      }

      if (route === "POST /repos/{owner}/{repo}/pulls") {
        return { data: { html_url: "https://github.com/marius-patrik/example/pull/1" } };
      }

      throw new Error(`Unexpected route ${route}`);
    }
  };
  const files: ManagedFile[] = [
    { path: ".agents/.global/VERSION", content: "vibe-bot@1.0.0\n" },
    { path: ".github/workflows/vibe-bot-bootstrap.yml", content: "name: Vibe Bot Bootstrap\n" }
  ];

  const result = await ensureManagedRepositorySetup(
    requester,
    { owner: "marius-patrik", repo: "example" },
    files
  );

  assert.equal(result.status, "created");
  assert.deepEqual(result.changedPaths, [
    ".agents/.global/VERSION",
    ".github/workflows/vibe-bot-bootstrap.yml"
  ]);
  assert.equal(result.pullRequestUrl, "https://github.com/marius-patrik/example/pull/1");
  assert.ok(
    calls.some(
      (call) =>
        call.route === "POST /repos/{owner}/{repo}/git/refs" &&
        call.parameters.ref === `refs/heads/${MANAGED_SETUP_BRANCH}`
    )
  );
});
