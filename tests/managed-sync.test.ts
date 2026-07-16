import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  ensureManagedRepositorySetup,
  ManagedSetupTrustViolation,
  ManagedSourcePolicyContradiction,
  managedSetupPullRequestBody,
  MANAGED_SETUP_BRANCH,
  orderManagedRepositoriesForSync,
  type GitHubRequester
} from "../src/managed-sync.js";
import {
  DARK_FACTORY_ENFORCEMENT_SCRIPT_PATH,
  DARK_FACTORY_AUTOREVIEW_POLICY_PATH,
  DARK_FACTORY_AUTOREVIEW_PROTOCOL_PATH,
  DARK_FACTORY_AUTOREVIEW_SCHEMA_PATH,
  DARK_FACTORY_AUTOREVIEW_SCRIPT_PATH,
  DARK_FACTORY_AUTOREVIEW_WORKFLOW_PATH,
  DARK_FACTORY_DATA_REPOSITORY_POLICY_PATH,
  DARK_FACTORY_FOLLOW_THROUGH_WORKFLOW_PATH,
  DARK_FACTORY_MANAGED_CONFIG_PATH,
  DARK_FACTORY_ORCHESTRATE_SCRIPT_PATH,
  DARK_FACTORY_ORCHESTRATE_WORKFLOW_PATH,
  DARK_FACTORY_MODEL_POLICY_PATH,
  DARK_FACTORY_MODEL_POLICY_SCRIPT_PATH,
  DARK_FACTORY_PLAN_SCRIPT_PATH,
  DARK_FACTORY_PLAN_WORKFLOW_PATH,
  DARK_FACTORY_SCRIPT_LIB_PATH,
  DARK_FACTORY_RELEASE_POLICY_PATH,
  DARK_FACTORY_RELEASE_SCRIPT_PATH,
  DARK_FACTORY_RELEASE_WORKFLOW_PATH,
  DARK_FACTORY_SUBMODULE_CHECKOUT_SCRIPT_PATH,
  DARK_FACTORY_SUBMODULE_POLICY_PATH,
  DARK_FACTORY_SUBMODULE_SCRIPT_PATH,
  DARK_FACTORY_SUBMODULE_WORKFLOW_PATH,
  DARK_FACTORY_SWEEP_SCRIPT_PATH,
  DARK_FACTORY_TRIGGER_POLICY_PATH,
  DARK_FACTORY_TRIGGER_POLICY_SCRIPT_PATH,
  DARK_FACTORY_WORKFLOW_PATH,
  DARK_FACTORY_WORK_SCRIPT_PATH,
  readManagedFiles,
  requiredManagedFilePaths,
  type ManagedFile
} from "../src/managed-files.js";

const PACKAGE_MANAGED_PATHS = new Set([
  DARK_FACTORY_AUTOREVIEW_POLICY_PATH,
  DARK_FACTORY_DATA_REPOSITORY_POLICY_PATH,
  DARK_FACTORY_MODEL_POLICY_PATH,
  DARK_FACTORY_TRIGGER_POLICY_PATH,
  DARK_FACTORY_RELEASE_POLICY_PATH,
  DARK_FACTORY_AUTOREVIEW_SCHEMA_PATH,
  DARK_FACTORY_AUTOREVIEW_WORKFLOW_PATH,
  DARK_FACTORY_AUTOREVIEW_PROTOCOL_PATH,
  DARK_FACTORY_AUTOREVIEW_SCRIPT_PATH,
  DARK_FACTORY_ENFORCEMENT_SCRIPT_PATH,
  DARK_FACTORY_PLAN_WORKFLOW_PATH,
  DARK_FACTORY_FOLLOW_THROUGH_WORKFLOW_PATH,
  DARK_FACTORY_ORCHESTRATE_WORKFLOW_PATH,
  DARK_FACTORY_WORKFLOW_PATH,
  DARK_FACTORY_SCRIPT_LIB_PATH,
  DARK_FACTORY_PLAN_SCRIPT_PATH,
  DARK_FACTORY_ORCHESTRATE_SCRIPT_PATH,
  DARK_FACTORY_MODEL_POLICY_SCRIPT_PATH,
  DARK_FACTORY_TRIGGER_POLICY_SCRIPT_PATH,
  DARK_FACTORY_RELEASE_SCRIPT_PATH,
  DARK_FACTORY_RELEASE_WORKFLOW_PATH,
  DARK_FACTORY_SUBMODULE_POLICY_PATH,
  DARK_FACTORY_SUBMODULE_WORKFLOW_PATH,
  DARK_FACTORY_SUBMODULE_SCRIPT_PATH,
  DARK_FACTORY_SUBMODULE_CHECKOUT_SCRIPT_PATH,
  DARK_FACTORY_SWEEP_SCRIPT_PATH,
  DARK_FACTORY_WORK_SCRIPT_PATH
]);

const RECOVERY_BASE_SHA = "1".repeat(40);
const RECOVERY_HEAD_SHA = "2".repeat(40);
const RECOVERY_BASE_TREE_SHA = "3".repeat(40);
const RECOVERY_EXPECTED_TREE_SHA = "4".repeat(40);
const RECOVERY_FILES: ManagedFile[] = [
  { path: "AGENTS.md", content: "# Canonical managed entrypoint\n" },
  {
    path: DARK_FACTORY_MANAGED_CONFIG_PATH,
    content: `${JSON.stringify({
      schemaVersion: 1,
      dataRepo: "marius-patrik/Andromeda-data",
      ledgerRepo: "marius-patrik/darkfactory-data",
      packageFiles: [],
      requiredFiles: [],
      removedFiles: []
    })}\n`
  }
];

const ADVANCE_PRIOR_BASE_SHA = "7".repeat(40);
const ADVANCE_CURRENT_BASE_SHA = "8".repeat(40);
const ADVANCE_OLD_HEAD_SHA = "9".repeat(40);
const ADVANCE_RECOVERY_HEAD_SHA = "a".repeat(40);
const ADVANCE_PRIOR_BASE_TREE_SHA = "b".repeat(40);
const ADVANCE_CURRENT_BASE_TREE_SHA = "c".repeat(40);
const ADVANCE_PRIOR_EXPECTED_TREE_SHA = "d".repeat(40);
const ADVANCE_CURRENT_EXPECTED_TREE_SHA = "e".repeat(40);
const ADVANCE_CHANGED_PATHS = ["AGENTS.md", DARK_FACTORY_MANAGED_CONFIG_PATH];

function managedRecoveryRequester(branchTreeSha: string): {
  requester: GitHubRequester;
  calls: Array<{ route: string; parameters: Record<string, unknown> }>;
} {
  const calls: Array<{ route: string; parameters: Record<string, unknown> }> = [];
  const requester: GitHubRequester = {
    async request(route, parameters) {
      calls.push({ route, parameters });
      if (route === "GET /repos/{owner}/{repo}") {
        return { data: { default_branch: "main", archived: false } };
      }
      if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") {
        return {
          data: {
            object: {
              sha: parameters.ref === `heads/${MANAGED_SETUP_BRANCH}`
                ? RECOVERY_HEAD_SHA
                : RECOVERY_BASE_SHA
            }
          }
        };
      }
      if (route === "GET /repos/{owner}/{repo}/contents/{path}") throw { status: 404 };
      if (route === "GET /repos/{owner}/{repo}/git/commits/{commit_sha}") {
        const isHead = parameters.commit_sha === RECOVERY_HEAD_SHA;
        return {
          data: {
            tree: { sha: isHead ? branchTreeSha : RECOVERY_BASE_TREE_SHA },
            parents: isHead ? [{ sha: RECOVERY_BASE_SHA }] : []
          }
        };
      }
      if (route === "GET /repos/{owner}/{repo}/git/trees/{tree_sha}") {
        return { data: { tree: [], truncated: false } };
      }
      if (route === "POST /repos/{owner}/{repo}/git/trees") {
        return { data: { sha: RECOVERY_EXPECTED_TREE_SHA } };
      }
      if (route === "GET /installation") {
        return { data: { app_slug: "darkfactory-agent", app_id: 12345 } };
      }
      if (route === "GET /repos/{owner}/{repo}/commits/{ref}") {
        return { data: { author: { login: "darkfactory-agent[bot]", type: "Bot" } } };
      }
      if (route === "GET /repos/{owner}/{repo}/pulls") return { data: [] };
      if (route === "POST /repos/{owner}/{repo}/pulls") {
        return { data: { html_url: "https://github.com/marius-patrik/example/pull/9" } };
      }
      throw new Error(`Unexpected route ${route}`);
    }
  };
  return { requester, calls };
}

function managedBaseAdvanceRequester(options: { updateConflict?: boolean } = {}): {
  requester: GitHubRequester;
  calls: Array<{ route: string; parameters: Record<string, unknown> }>;
} {
  const calls: Array<{ route: string; parameters: Record<string, unknown> }> = [];
  let setupHead = ADVANCE_OLD_HEAD_SHA;
  let pullBody = managedSetupPullRequestBody(ADVANCE_CHANGED_PATHS, {
    schemaVersion: 1,
    baseBranch: "main",
    baseSha: ADVANCE_PRIOR_BASE_SHA,
    headSha: ADVANCE_OLD_HEAD_SHA,
    treeSha: ADVANCE_PRIOR_EXPECTED_TREE_SHA,
    changedPathsDigest: createHash("sha256")
      .update(JSON.stringify([...ADVANCE_CHANGED_PATHS].sort()))
      .digest("hex")
  });
  const pull = () => ({
    state: "open",
    draft: false,
    title: "Update Dark Factory managed repository setup",
    commits: setupHead === ADVANCE_RECOVERY_HEAD_SHA ? 2 : 1,
    body: pullBody,
    user: { login: "darkfactory-agent[bot]", type: "Bot" },
    base: {
      ref: "main",
      sha: ADVANCE_CURRENT_BASE_SHA,
      repo: { full_name: "marius-patrik/example" }
    },
    head: {
      ref: MANAGED_SETUP_BRANCH,
      sha: setupHead,
      repo: { full_name: "marius-patrik/example" }
    }
  });
  const requester: GitHubRequester = {
    async request(route, parameters) {
      calls.push({ route, parameters });
      if (route === "GET /repos/{owner}/{repo}") {
        return { data: { default_branch: "main", archived: false } };
      }
      if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") {
        return {
          data: {
            object: {
              sha: parameters.ref === `heads/${MANAGED_SETUP_BRANCH}`
                ? setupHead
                : ADVANCE_CURRENT_BASE_SHA
            }
          }
        };
      }
      if (route === "GET /repos/{owner}/{repo}/contents/{path}") throw { status: 404 };
      if (route === "GET /repos/{owner}/{repo}/git/commits/{commit_sha}") {
        if (parameters.commit_sha === ADVANCE_PRIOR_BASE_SHA) {
          return { data: { tree: { sha: ADVANCE_PRIOR_BASE_TREE_SHA }, parents: [] } };
        }
        if (parameters.commit_sha === ADVANCE_CURRENT_BASE_SHA) {
          return {
            data: {
              tree: { sha: ADVANCE_CURRENT_BASE_TREE_SHA },
              parents: [{ sha: ADVANCE_PRIOR_BASE_SHA }]
            }
          };
        }
        if (parameters.commit_sha === ADVANCE_OLD_HEAD_SHA) {
          return {
            data: {
              tree: { sha: ADVANCE_PRIOR_EXPECTED_TREE_SHA },
              parents: [{ sha: ADVANCE_PRIOR_BASE_SHA }]
            }
          };
        }
        if (parameters.commit_sha === ADVANCE_RECOVERY_HEAD_SHA) {
          return {
            data: {
              tree: { sha: ADVANCE_CURRENT_EXPECTED_TREE_SHA },
              parents: [{ sha: ADVANCE_OLD_HEAD_SHA }, { sha: ADVANCE_CURRENT_BASE_SHA }]
            }
          };
        }
        throw new Error(`Unexpected commit ${String(parameters.commit_sha)}`);
      }
      if (route === "GET /repos/{owner}/{repo}/git/trees/{tree_sha}") {
        return { data: { tree: [], truncated: false } };
      }
      if (route === "POST /repos/{owner}/{repo}/git/trees") {
        if (parameters.base_tree === ADVANCE_PRIOR_BASE_TREE_SHA) {
          return { data: { sha: ADVANCE_PRIOR_EXPECTED_TREE_SHA } };
        }
        assert.equal(parameters.base_tree, ADVANCE_CURRENT_BASE_TREE_SHA);
        return { data: { sha: ADVANCE_CURRENT_EXPECTED_TREE_SHA } };
      }
      if (route === "GET /installation") {
        return { data: { app_slug: "darkfactory-agent", app_id: 12345 } };
      }
      if (route === "GET /repos/{owner}/{repo}/commits/{ref}") {
        return { data: { author: { login: "darkfactory-agent[bot]", type: "Bot" } } };
      }
      if (route === "GET /repos/{owner}/{repo}/pulls") {
        return { data: [{ number: 9, html_url: "https://github.com/marius-patrik/example/pull/9" }] };
      }
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
        assert.equal(parameters.pull_number, 9);
        return { data: pull() };
      }
      if (route === "GET /repos/{owner}/{repo}/compare/{basehead}") {
        assert.equal(parameters.basehead, `${ADVANCE_PRIOR_BASE_SHA}...${ADVANCE_CURRENT_BASE_SHA}`);
        return { data: { status: "ahead", ahead_by: 1, behind_by: 0 } };
      }
      if (route === "POST /repos/{owner}/{repo}/git/commits") {
        assert.deepEqual(parameters.parents, [ADVANCE_OLD_HEAD_SHA, ADVANCE_CURRENT_BASE_SHA]);
        assert.equal(parameters.tree, ADVANCE_CURRENT_EXPECTED_TREE_SHA);
        return { data: { sha: ADVANCE_RECOVERY_HEAD_SHA } };
      }
      if (route === "PATCH /repos/{owner}/{repo}/git/refs/{ref}") {
        assert.equal(parameters.ref, `heads/${MANAGED_SETUP_BRANCH}`);
        assert.equal(parameters.sha, ADVANCE_RECOVERY_HEAD_SHA);
        assert.equal(parameters.force, false);
        if (options.updateConflict) throw Object.assign(new Error("conflict"), { status: 409 });
        setupHead = ADVANCE_RECOVERY_HEAD_SHA;
        return { data: {} };
      }
      if (route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}") {
        pullBody = String(parameters.body);
        return { data: {} };
      }
      throw new Error(`Unexpected route ${route}`);
    }
  };
  return { requester, calls };
}

async function seedCanonicalManagedSource(root: string): Promise<{ managedRoot: string; registryPath: string }> {
  const dataRoot = root;
  const managedRoot = join(dataRoot, "managed-repository");
  const registryPath = join(root, "data-repos.json");
  const requiredFiles = requiredManagedFilePaths();
  for (const filePath of requiredFiles) {
    if (PACKAGE_MANAGED_PATHS.has(filePath)) continue;
    const fullPath = join(managedRoot, ...filePath.split("/"));
    await mkdir(dirname(fullPath), { recursive: true });
    const content = filePath === DARK_FACTORY_MANAGED_CONFIG_PATH
      ? `${JSON.stringify({
        schemaVersion: 1,
        dataRepo: "marius-patrik/Andromeda-data",
        ledgerRepo: "marius-patrik/darkfactory-data",
        packageFiles: [...PACKAGE_MANAGED_PATHS],
        requiredFiles,
        removedFiles: [
          ".darkfactory/release-conventions.md",
          ".github/scripts/dark-factory-release-check.mjs",
          ".github/workflows/dark-factory-release.yml"
        ]
      })}\n`
      : `${filePath}\n`;
    await writeFile(fullPath, content);
  }
  await writeFile(
    registryPath,
    JSON.stringify([{ id: "agent-os-data", repo: "marius-patrik/Andromeda-data", path: dataRoot }])
  );
  return { managedRoot, registryPath };
}

test("managedSetupPullRequestBody lists changed files and documents Agent OS-owned shared state", () => {
  const body = managedSetupPullRequestBody([
    "AGENTS.md",
    ".github/workflows/ci.yml",
    ".github/workflows/dark-factory-bootstrap.yml"
  ]);

  assert.match(body, /AGENTS\.md/);
  assert.doesNotMatch(body, /\.agents\/\.global/);
  assert.match(body, /\.github\/workflows\/ci\.yml/);
  assert.match(body, /\.github\/workflows\/dark-factory-bootstrap\.yml/);
  assert.match(body, /\.agents\/.project` is managed only when a repo-specific canonical Andromeda-data overlay exists/);
  assert.match(body, /Shared Agent OS identity/);
  assert.match(body, /labels, branching, installer, and orchestration behavior/);
  assert.match(body, /dark-factory-autoupdate\.yml/);
  assert.doesNotMatch(body, /dark-factory-release\.yml/);
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

      if (route === "GET /repos/{owner}/{repo}/git/trees/{tree_sha}") {
        return {
          data: {
            tree: [
              { path: ".agents/.global/VERSION", mode: "100644", type: "blob" },
              { path: ".github/workflows/dark-factory-release.yml", mode: "100644", type: "blob" }
            ],
            truncated: false
          }
        };
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
    { path: ".github/workflows/ci.yml", content: "name: CI\n" },
    { path: ".github/workflows/dark-factory-bootstrap.yml", content: "name: Dark Factory Bootstrap\n" },
    {
      path: DARK_FACTORY_MANAGED_CONFIG_PATH,
      content: JSON.stringify({
        schemaVersion: 1,
        dataRepo: "marius-patrik/Andromeda-data",
        ledgerRepo: "marius-patrik/darkfactory-data",
        packageFiles: [],
        requiredFiles: [],
        removedFiles: [".github/workflows/dark-factory-release.yml"]
      })
    }
  ];

  const result = await ensureManagedRepositorySetup(
    requester,
    { owner: "marius-patrik", repo: "example" },
    files
  );

  assert.equal(result.status, "created");
  assert.deepEqual(result.changedPaths, [
    "AGENTS.md",
    ".github/workflows/ci.yml",
    ".github/workflows/dark-factory-bootstrap.yml",
    DARK_FACTORY_MANAGED_CONFIG_PATH,
    ".agents/.global/VERSION",
    ".github/workflows/dark-factory-release.yml"
  ]);
  assert.equal(result.pullRequestUrl, "https://github.com/marius-patrik/example/pull/1");
  assert.ok(
    calls.some(
      (call) =>
        call.route === "POST /repos/{owner}/{repo}/git/refs" &&
        call.parameters.ref === `refs/heads/${MANAGED_SETUP_BRANCH}`
    )
  );
  const treeCall = calls.find((call) => call.route === "POST /repos/{owner}/{repo}/git/trees");
  assert.ok(treeCall);
  assert.ok(
    Array.isArray(treeCall.parameters.tree) &&
      treeCall.parameters.tree.some(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          "path" in entry &&
          entry.path === ".github/workflows/dark-factory-release.yml" &&
          "sha" in entry &&
          entry.sha === null
      )
  );
  assert.ok(
    Array.isArray(treeCall.parameters.tree) &&
      treeCall.parameters.tree.some(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          "path" in entry &&
          entry.path === ".agents/.global/VERSION" &&
          "sha" in entry &&
          entry.sha === null
      )
  );
});

test("managed setup recovery creates the missing PR only for the exact App-owned canonical branch", async () => {
  const { requester, calls } = managedRecoveryRequester(RECOVERY_EXPECTED_TREE_SHA);

  const result = await ensureManagedRepositorySetup(
    requester,
    { owner: "marius-patrik", repo: "example" },
    RECOVERY_FILES
  );

  assert.equal(result.status, "created");
  assert.equal(result.pullRequestUrl, "https://github.com/marius-patrik/example/pull/9");
  assert.equal(calls.some((call) => call.route === "PATCH /repos/{owner}/{repo}/git/refs/{ref}"), false);
  assert.equal(calls.some((call) => call.route === "POST /repos/{owner}/{repo}/git/commits"), false);
  assert.equal(calls.some((call) => call.route === "POST /repos/{owner}/{repo}/git/refs"), false);
  const createPull = calls.find((call) => call.route === "POST /repos/{owner}/{repo}/pulls");
  assert.ok(createPull);
  assert.match(String(createPull.parameters.body), new RegExp(`base=${RECOVERY_BASE_SHA}`));
  assert.match(String(createPull.parameters.body), new RegExp(`head=${RECOVERY_HEAD_SHA}`));
  assert.match(String(createPull.parameters.body), new RegExp(`tree=${RECOVERY_EXPECTED_TREE_SHA}`));
});

test("managed setup recovery preserves and blocks a partial predictable branch", async () => {
  const { requester, calls } = managedRecoveryRequester("5".repeat(40));

  await assert.rejects(
    ensureManagedRepositorySetup(
      requester,
      { owner: "marius-patrik", repo: "example" },
      RECOVERY_FILES
    ),
    (error: unknown) => error instanceof ManagedSetupTrustViolation
      && /unknown or conflicting work/.test(error.message)
  );

  assert.equal(calls.some((call) => /^(PATCH .*git\/refs|POST .*git\/commits|POST .*git\/refs|POST .*pulls)/.test(call.route)), false);
});

test("managed setup recovery preserves and blocks an exact-looking branch with a malicious extra file", async () => {
  const { requester, calls } = managedRecoveryRequester("6".repeat(40));

  await assert.rejects(
    ensureManagedRepositorySetup(
      requester,
      { owner: "marius-patrik", repo: "example" },
      RECOVERY_FILES
    ),
    (error: unknown) => error instanceof ManagedSetupTrustViolation
      && /unknown or conflicting work/.test(error.message)
  );

  assert.equal(calls.some((call) => /^(PATCH .*git\/refs|POST .*git\/commits|POST .*git\/refs|POST .*pulls)/.test(call.route)), false);
});

test("managed setup safely recovers an exact App-owned pull request after main advances", async () => {
  const { requester, calls } = managedBaseAdvanceRequester();

  const result = await ensureManagedRepositorySetup(
    requester,
    { owner: "marius-patrik", repo: "example" },
    RECOVERY_FILES
  );

  assert.equal(result.status, "updated");
  assert.equal(result.pullRequestUrl, "https://github.com/marius-patrik/example/pull/9");
  const commit = calls.find((call) => call.route === "POST /repos/{owner}/{repo}/git/commits");
  assert.ok(commit);
  assert.deepEqual(commit.parameters.parents, [ADVANCE_OLD_HEAD_SHA, ADVANCE_CURRENT_BASE_SHA]);
  assert.equal(commit.parameters.tree, ADVANCE_CURRENT_EXPECTED_TREE_SHA);
  const refUpdate = calls.find((call) => call.route === "PATCH /repos/{owner}/{repo}/git/refs/{ref}");
  assert.ok(refUpdate);
  assert.equal(refUpdate.parameters.force, false);
  const pullUpdate = calls.find((call) => call.route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}");
  assert.ok(pullUpdate);
  assert.match(String(pullUpdate.parameters.body), new RegExp(`base=${ADVANCE_CURRENT_BASE_SHA}`));
  assert.match(String(pullUpdate.parameters.body), new RegExp(`head=${ADVANCE_RECOVERY_HEAD_SHA}`));
  assert.ok(calls.filter((call) => call.route === "GET /repos/{owner}/{repo}/pulls/{pull_number}").length >= 2);
  assert.ok(calls.filter((call) => call.route === "GET /repos/{owner}/{repo}/git/ref/{ref}").length >= 6);
});

test("managed setup fails closed when its non-force base-advance update conflicts", async () => {
  const { requester, calls } = managedBaseAdvanceRequester({ updateConflict: true });

  await assert.rejects(
    ensureManagedRepositorySetup(
      requester,
      { owner: "marius-patrik", repo: "example" },
      RECOVERY_FILES
    ),
    (error: unknown) => error instanceof ManagedSetupTrustViolation
      && /update conflicted; preserved the existing branch and blocked recovery \(409\)/.test(error.message)
  );

  assert.equal(calls.some((call) => call.route === "PATCH /repos/{owner}/{repo}/git/refs/{ref}"), true);
  assert.equal(calls.some((call) => call.route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}"), false);
  assert.equal(calls.some((call) => call.route === "POST /repos/{owner}/{repo}/pulls"), false);
});

test("control managed sync refuses contradictory release-control removals before GitHub reads or writes", async () => {
  let requests = 0;
  const requester: GitHubRequester = {
    async request() {
      requests += 1;
      throw new Error("managed sync must reject the trusted source contradiction before GitHub access");
    }
  };
  const files: ManagedFile[] = [{
    path: DARK_FACTORY_MANAGED_CONFIG_PATH,
    content: JSON.stringify({
      schemaVersion: 1,
      dataRepo: "marius-patrik/Andromeda-data",
      ledgerRepo: "marius-patrik/darkfactory-data",
      packageFiles: [],
      requiredFiles: [],
      removedFiles: [
        ".github/workflows/df-release.yml",
        ".github/scripts/df-release.mjs"
      ]
    })
  }];

  await assert.rejects(
    ensureManagedRepositorySetup(requester, { owner: "marius-patrik", repo: "DarkFactory" }, files),
    (error: unknown) => error instanceof ManagedSourcePolicyContradiction
      && /df-release\.mjs/.test(error.message)
      && /df-release\.yml/.test(error.message)
  );
  assert.equal(requests, 0);
});

test("orderManagedRepositoriesForSync processes DarkFactory control repository first", () => {
  const repositories = [
    { owner: "marius-patrik", repo: "dream" },
    { owner: "marius-patrik", repo: "DarkFactory" },
    { owner: "marius-patrik", repo: "agents-plugin" }
  ];

  const ordered = orderManagedRepositoriesForSync(repositories, (repository) => repository);

  assert.deepEqual(
    ordered.map((repository) => repository.repo),
    ["DarkFactory", "dream", "agents-plugin"]
  );
});

test("orderManagedRepositoriesForSync deduplicates repository entries case-insensitively", () => {
  const repositories = [
    { owner: "marius-patrik", repo: "DarkFactory", id: 1 },
    { owner: "MARIUS-PATRIK", repo: "darkfactory", id: 2 },
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
  const previousRegistry = process.env.AGENTS_DATA_REPOS;
  const previousAgentsHome = process.env.AGENTS_HOME;

  try {
    const { registryPath } = await seedCanonicalManagedSource(root);
    process.env.AGENTS_HOME = root;
    process.env.AGENTS_DATA_REPOS = registryPath;
    const requiredPaths = requiredManagedFilePaths();
    assert.equal(requiredPaths.some((path) => path.startsWith(".agents/.global")), false);
    const managedFiles = readManagedFiles();
    const managedPaths = new Set(managedFiles.map((file) => file.path));

    for (const filePath of requiredPaths) {
      assert.equal(managedPaths.has(filePath), true, filePath);
    }
  } finally {
    if (previousRegistry === undefined) delete process.env.AGENTS_DATA_REPOS;
    else process.env.AGENTS_DATA_REPOS = previousRegistry;
    if (previousAgentsHome === undefined) delete process.env.AGENTS_HOME;
    else process.env.AGENTS_HOME = previousAgentsHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("readManagedFiles does not ship the control-only event forward workflow", async () => {
  const root = await mkdtemp(join(tmpdir(), "df-managed-root-"));
  const previousRegistry = process.env.AGENTS_DATA_REPOS;
  const previousAgentsHome = process.env.AGENTS_HOME;

  try {
    const { managedRoot, registryPath } = await seedCanonicalManagedSource(root);
    process.env.AGENTS_HOME = root;
    process.env.AGENTS_DATA_REPOS = registryPath;
    const eventForwardPath = join(managedRoot, ".github", "workflows", "df-event-forward.yml");
    await mkdir(dirname(eventForwardPath), { recursive: true });
    await writeFile(eventForwardPath, "name: DarkFactory Event Forward\n");
    await writeFile(join(managedRoot, ".github", "workflows", "dark-factory-release.yml"), "name: obsolete\n");

    const managedFiles = readManagedFiles();
    const managedPaths = new Set(managedFiles.map((file) => file.path));

    assert.equal(managedPaths.has(".github/workflows/df-event-forward.yml"), false);
    assert.equal(managedPaths.has(".github/workflows/dark-factory-release.yml"), false);
  } finally {
    if (previousRegistry === undefined) delete process.env.AGENTS_DATA_REPOS;
    else process.env.AGENTS_DATA_REPOS = previousRegistry;
    if (previousAgentsHome === undefined) delete process.env.AGENTS_HOME;
    else process.env.AGENTS_HOME = previousAgentsHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("readManagedFiles rejects duplicate package-owned payloads in managed data", async () => {
  const root = await mkdtemp(join(tmpdir(), "df-managed-root-"));
  const previousRegistry = process.env.AGENTS_DATA_REPOS;
  const previousAgentsHome = process.env.AGENTS_HOME;
  try {
    const { managedRoot, registryPath } = await seedCanonicalManagedSource(root);
    process.env.AGENTS_HOME = root;
    process.env.AGENTS_DATA_REPOS = registryPath;
    const duplicatePath = join(managedRoot, ...DARK_FACTORY_PLAN_WORKFLOW_PATH.split("/"));
    await mkdir(dirname(duplicatePath), { recursive: true });
    await writeFile(duplicatePath, "name: duplicate\n");

    assert.throws(() => readManagedFiles(), /duplicates package-owned payload/);
  } finally {
    if (previousRegistry === undefined) delete process.env.AGENTS_DATA_REPOS;
    else process.env.AGENTS_DATA_REPOS = previousRegistry;
    if (previousAgentsHome === undefined) delete process.env.AGENTS_HOME;
    else process.env.AGENTS_HOME = previousAgentsHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("readManagedFiles rejects swapped or missing managed-source and runtime-ledger authorities", async () => {
  const root = await mkdtemp(join(tmpdir(), "df-managed-authorities-"));
  const previousRegistry = process.env.AGENTS_DATA_REPOS;
  const previousAgentsHome = process.env.AGENTS_HOME;
  try {
    const { managedRoot, registryPath } = await seedCanonicalManagedSource(root);
    process.env.AGENTS_HOME = root;
    process.env.AGENTS_DATA_REPOS = registryPath;
    const manifestPath = join(managedRoot, ...DARK_FACTORY_MANAGED_CONFIG_PATH.split("/"));
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

    await writeFile(manifestPath, JSON.stringify({ ...manifest, dataRepo: "marius-patrik/darkfactory-data" }));
    assert.throws(() => readManagedFiles(), /canonical Andromeda-data source and darkfactory-data ledger authorities/);

    await writeFile(manifestPath, JSON.stringify({ ...manifest, ledgerRepo: "marius-patrik/Andromeda-data" }));
    assert.throws(() => readManagedFiles(), /canonical Andromeda-data source and darkfactory-data ledger authorities/);

    await writeFile(manifestPath, JSON.stringify({ ...manifest, ledgerRepo: undefined }));
    assert.throws(() => readManagedFiles(), /canonical Andromeda-data source and darkfactory-data ledger authorities/);
  } finally {
    if (previousRegistry === undefined) delete process.env.AGENTS_DATA_REPOS;
    else process.env.AGENTS_DATA_REPOS = previousRegistry;
    if (previousAgentsHome === undefined) delete process.env.AGENTS_HOME;
    else process.env.AGENTS_HOME = previousAgentsHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("readManagedFiles selects canonical Andromeda-data while allowing unrelated registered data repositories", async () => {
  const root = await mkdtemp(join(tmpdir(), "df-agent-os-data-"));
  const previousRegistry = process.env.AGENTS_DATA_REPOS;
  const previousAgentsHome = process.env.AGENTS_HOME;
  const previousAgentsRoot = process.env.AGENTS_ROOT;

  try {
    const { registryPath } = await seedCanonicalManagedSource(root);
    process.env.AGENTS_HOME = root;
    process.env.AGENTS_ROOT = join(root, "distribution-root");
    process.env.AGENTS_DATA_REPOS = registryPath;

    await writeFile(registryPath, JSON.stringify([
      { id: "agent-os-data", repo: "marius-patrik/Andromeda-data", path: root },
      { id: "darkfactory-data", repo: "marius-patrik/darkfactory-data", path: join(root, "other-data") }
    ]));
    const files = readManagedFiles();
    assert.ok(files.some((file) => file.path === "AGENTS.md"));

  } finally {
    if (previousRegistry === undefined) delete process.env.AGENTS_DATA_REPOS;
    else process.env.AGENTS_DATA_REPOS = previousRegistry;
    if (previousAgentsHome === undefined) delete process.env.AGENTS_HOME;
    else process.env.AGENTS_HOME = previousAgentsHome;
    if (previousAgentsRoot === undefined) delete process.env.AGENTS_ROOT;
    else process.env.AGENTS_ROOT = previousAgentsRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("readManagedFiles rejects a missing or duplicate canonical agent-os-data authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "df-agent-os-data-missing-"));
  const previousRegistry = process.env.AGENTS_DATA_REPOS;
  const previousAgentsHome = process.env.AGENTS_HOME;
  try {
    const { registryPath } = await seedCanonicalManagedSource(root);
    process.env.AGENTS_HOME = root;
    process.env.AGENTS_DATA_REPOS = registryPath;

    await writeFile(registryPath, JSON.stringify([{ id: "darkfactory-data", repo: "marius-patrik/darkfactory-data", path: join(root, "other") }]));
    assert.throws(() => readManagedFiles(), /exactly one agent-os-data authority record/);

    await writeFile(registryPath, JSON.stringify([
      { id: "agent-os-data", repo: "marius-patrik/Andromeda-data", path: root },
      { id: "agent-os-data", repo: "marius-patrik/Andromeda-data", path: root }
    ]));
    assert.throws(() => readManagedFiles(), /exactly one agent-os-data authority record/);
  } finally {
    if (previousRegistry === undefined) delete process.env.AGENTS_DATA_REPOS;
    else process.env.AGENTS_DATA_REPOS = previousRegistry;
    if (previousAgentsHome === undefined) delete process.env.AGENTS_HOME;
    else process.env.AGENTS_HOME = previousAgentsHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("readManagedFiles rejects wrong repository, path, or conflicting canonical authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "df-agent-os-data-invalid-"));
  const previousRegistry = process.env.AGENTS_DATA_REPOS;
  const previousAgentsHome = process.env.AGENTS_HOME;
  try {
    const { registryPath } = await seedCanonicalManagedSource(root);
    process.env.AGENTS_HOME = root;
    process.env.AGENTS_DATA_REPOS = registryPath;

    await writeFile(
      registryPath,
      JSON.stringify([{ id: "agent-os-data", repo: "marius-patrik/Andromeda-data", path: join(root, "different") }])
    );
    assert.throws(() => readManagedFiles(), /agent-os-data path must be/);

    await writeFile(
      registryPath,
      JSON.stringify([{ id: "agent-os-data", repo: "wrong/data", path: root }])
    );
    assert.throws(() => readManagedFiles(), /must use repository marius-patrik\/Andromeda-data/);
    await writeFile(registryPath, JSON.stringify([]));
    assert.throws(() => readManagedFiles(), /exactly one agent-os-data authority record/);

    await writeFile(
      registryPath,
      JSON.stringify([
        { id: "agent-os-data", repo: "marius-patrik/Andromeda-data", path: root },
        { id: "other-data", repo: "marius-patrik/Andromeda-data", path: join(root, "other") }
      ])
    );
    assert.throws(() => readManagedFiles(), /conflicting Andromeda-data authority/);

    await writeFile(
      registryPath,
      JSON.stringify([
        { id: "agent-os-data", repo: "marius-patrik/Andromeda-data", path: root },
        { id: "other-data", repo: "marius-patrik/other", path: join(root, "other") }
      ])
    );
    assert.ok(readManagedFiles().some((file) => file.path === "AGENTS.md"));

    await writeFile(
      registryPath,
      JSON.stringify([
        { id: "agent-os-data", repo: "marius-patrik/Andromeda-data", path: root },
        { id: "agent-os-data", repo: "marius-patrik/Andromeda-data", path: root }
      ])
    );
    assert.throws(() => readManagedFiles(), /exactly one agent-os-data authority record/);

    await writeFile(registryPath, JSON.stringify([null]));
    assert.throws(() => readManagedFiles(), /Invalid Agent OS data repository registry record/);
  } finally {
    if (previousRegistry === undefined) delete process.env.AGENTS_DATA_REPOS;
    else process.env.AGENTS_DATA_REPOS = previousRegistry;
    if (previousAgentsHome === undefined) delete process.env.AGENTS_HOME;
    else process.env.AGENTS_HOME = previousAgentsHome;
    await rm(root, { recursive: true, force: true });
  }
});
