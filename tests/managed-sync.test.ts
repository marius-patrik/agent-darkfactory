import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  ensureManagedRepositorySetup,
  managedSetupPullRequestBody,
  MANAGED_SETUP_BRANCH,
  orderManagedRepositoriesForSync,
  type GitHubRequester
} from "../src/managed-sync.js";
import {
  DARK_FACTORY_FOLLOW_THROUGH_WORKFLOW_PATH,
  DARK_FACTORY_ORCHESTRATE_SCRIPT_PATH,
  DARK_FACTORY_ORCHESTRATE_WORKFLOW_PATH,
  DARK_FACTORY_PLAN_SCRIPT_PATH,
  DARK_FACTORY_PLAN_WORKFLOW_PATH,
  DARK_FACTORY_SCRIPT_LIB_PATH,
  DARK_FACTORY_SWEEP_SCRIPT_PATH,
  DARK_FACTORY_WORKFLOW_PATH,
  DARK_FACTORY_WORK_SCRIPT_PATH,
  readManagedFiles,
  requiredManagedFilePaths,
  type ManagedFile
} from "../src/managed-files.js";

test("managedSetupPullRequestBody lists changed files and documents workspace-owned project state", () => {
  const body = managedSetupPullRequestBody([
    "AGENTS.md",
    ".agents/.global/VERSION",
    ".github/workflows/ci.yml",
    ".github/workflows/dark-factory-bootstrap.yml"
  ]);

  assert.match(body, /AGENTS\.md/);
  assert.match(body, /\.agents\/\.global\/VERSION/);
  assert.match(body, /\.github\/workflows\/ci\.yml/);
  assert.match(body, /\.github\/workflows\/dark-factory-bootstrap\.yml/);
  assert.match(body, /\.agents\/.project` is managed only when a repo-specific workspace overlay exists/);
  assert.match(body, /labels, branching, installer, auto-updater, and release baseline/);
  assert.match(body, /dark-factory-autoupdate\.yml/);
  assert.match(body, /dark-factory-release\.yml/);
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
    { path: "AGENTS.md", content: "# Agent Entry Point\n" },
    { path: ".agents/.global/VERSION", content: "agent-darkfactory@1.0.0\n" },
    { path: ".github/workflows/ci.yml", content: "name: CI\n" },
    { path: ".github/workflows/dark-factory-bootstrap.yml", content: "name: Dark Factory Bootstrap\n" }
  ];

  const result = await ensureManagedRepositorySetup(
    requester,
    { owner: "marius-patrik", repo: "example" },
    files
  );

  assert.equal(result.status, "created");
  assert.deepEqual(result.changedPaths, [
    "AGENTS.md",
    ".agents/.global/VERSION",
    ".github/workflows/ci.yml",
    ".github/workflows/dark-factory-bootstrap.yml"
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

test("orderManagedRepositoriesForSync processes DarkFactory control repository first", () => {
  const repositories = [
    { owner: "marius-patrik", repo: "dream" },
    { owner: "marius-patrik", repo: "agent-darkfactory" },
    { owner: "marius-patrik", repo: "agents-plugin" }
  ];

  const ordered = orderManagedRepositoriesForSync(repositories, (repository) => repository);

  assert.deepEqual(
    ordered.map((repository) => repository.repo),
    ["agent-darkfactory", "dream", "agents-plugin"]
  );
});

test("orderManagedRepositoriesForSync deduplicates repository entries case-insensitively", () => {
  const repositories = [
    { owner: "marius-patrik", repo: "agent-darkfactory", id: 1 },
    { owner: "MARIUS-PATRIK", repo: "Agent-DarkFactory", id: 2 },
    { owner: "marius-patrik", repo: "dream", id: 3 }
  ];

  const ordered = orderManagedRepositoriesForSync(repositories, (repository) => repository);

  assert.deepEqual(
    ordered.map((repository) => repository.id),
    [1, 3]
  );
});

test("readManagedFiles supplies every required package-managed payload", async () => {
  const root = await mkdtemp(join(tmpdir(), "df-managed-root-"));
  const packagePaths = new Set([
    DARK_FACTORY_PLAN_WORKFLOW_PATH,
    DARK_FACTORY_FOLLOW_THROUGH_WORKFLOW_PATH,
    DARK_FACTORY_ORCHESTRATE_WORKFLOW_PATH,
    DARK_FACTORY_WORKFLOW_PATH,
    DARK_FACTORY_SCRIPT_LIB_PATH,
    DARK_FACTORY_PLAN_SCRIPT_PATH,
    DARK_FACTORY_ORCHESTRATE_SCRIPT_PATH,
    DARK_FACTORY_SWEEP_SCRIPT_PATH,
    DARK_FACTORY_WORK_SCRIPT_PATH
  ]);

  try {
    const requiredPaths = requiredManagedFilePaths(root);
    for (const filePath of requiredPaths) {
      if (packagePaths.has(filePath)) continue;
      const fullPath = join(root, ...filePath.split("/"));
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, `${filePath}\n`);
    }

    const managedFiles = readManagedFiles(undefined, root);
    const managedPaths = new Set(managedFiles.map((file) => file.path));

    for (const filePath of requiredPaths) {
      assert.equal(managedPaths.has(filePath), true, filePath);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
