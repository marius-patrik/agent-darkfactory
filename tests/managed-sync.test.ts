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
  DARK_FACTORY_ENFORCEMENT_SCRIPT_PATH,
  DARK_FACTORY_FOLLOW_THROUGH_WORKFLOW_PATH,
  DARK_FACTORY_MANAGED_CONFIG_PATH,
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

const PACKAGE_MANAGED_PATHS = new Set([
  DARK_FACTORY_ENFORCEMENT_SCRIPT_PATH,
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

async function seedCanonicalManagedSource(root: string): Promise<{ managedRoot: string; registryPath: string }> {
  const dataRoot = join(root, "data", "agent-os");
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
        packageFiles: [...PACKAGE_MANAGED_PATHS],
        requiredFiles,
        removedFiles: [
          ".darkfactory/release-conventions.md",
          ".darkfactory/release-policy.json",
          ".github/scripts/dark-factory-release-check.mjs",
          ".github/workflows/dark-factory-release.yml"
        ]
      })}\n`
      : `${filePath}\n`;
    await writeFile(fullPath, content);
  }
  await writeFile(
    registryPath,
    JSON.stringify([{ id: "agent-os-data", repo: "marius-patrik/agents-data", path: dataRoot }])
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
  assert.match(body, /\.agents\/.project` is managed only when a repo-specific `agents-data` overlay exists/);
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
  const previousAgentsRoot = process.env.AGENTS_ROOT;

  try {
    const { registryPath } = await seedCanonicalManagedSource(root);
    process.env.AGENTS_ROOT = root;
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
    if (previousAgentsRoot === undefined) delete process.env.AGENTS_ROOT;
    else process.env.AGENTS_ROOT = previousAgentsRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("readManagedFiles does not ship the control-only event forward workflow", async () => {
  const root = await mkdtemp(join(tmpdir(), "df-managed-root-"));
  const previousRegistry = process.env.AGENTS_DATA_REPOS;
  const previousAgentsRoot = process.env.AGENTS_ROOT;

  try {
    const { managedRoot, registryPath } = await seedCanonicalManagedSource(root);
    process.env.AGENTS_ROOT = root;
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
    if (previousAgentsRoot === undefined) delete process.env.AGENTS_ROOT;
    else process.env.AGENTS_ROOT = previousAgentsRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("readManagedFiles rejects duplicate package-owned payloads in managed data", async () => {
  const root = await mkdtemp(join(tmpdir(), "df-managed-root-"));
  const previousRegistry = process.env.AGENTS_DATA_REPOS;
  const previousAgentsRoot = process.env.AGENTS_ROOT;
  try {
    const { managedRoot, registryPath } = await seedCanonicalManagedSource(root);
    process.env.AGENTS_ROOT = root;
    process.env.AGENTS_DATA_REPOS = registryPath;
    const duplicatePath = join(managedRoot, ...DARK_FACTORY_PLAN_WORKFLOW_PATH.split("/"));
    await mkdir(dirname(duplicatePath), { recursive: true });
    await writeFile(duplicatePath, "name: duplicate\n");

    assert.throws(() => readManagedFiles(), /duplicates package-owned payload/);
  } finally {
    if (previousRegistry === undefined) delete process.env.AGENTS_DATA_REPOS;
    else process.env.AGENTS_DATA_REPOS = previousRegistry;
    if (previousAgentsRoot === undefined) delete process.env.AGENTS_ROOT;
    else process.env.AGENTS_ROOT = previousAgentsRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("readManagedFiles resolves only the canonical Agent OS data registry record", async () => {
  const root = await mkdtemp(join(tmpdir(), "df-agent-os-data-"));
  const previousRegistry = process.env.AGENTS_DATA_REPOS;
  const previousAgentsRoot = process.env.AGENTS_ROOT;

  try {
    const { registryPath } = await seedCanonicalManagedSource(root);
    process.env.AGENTS_ROOT = root;
    process.env.AGENTS_DATA_REPOS = registryPath;

    const files = readManagedFiles();
    assert.ok(files.some((file) => file.path === "AGENTS.md"));

    await writeFile(
      registryPath,
      JSON.stringify([{ id: "agent-os-data", repo: "marius-patrik/agents-data", path: join(root, "different") }])
    );
    assert.throws(() => readManagedFiles(), /agent-os-data path must be/);

    await writeFile(
      registryPath,
      JSON.stringify([{ id: "agent-os-data", repo: "wrong/data", path: join(root, "data", "agent-os") }])
    );
    assert.throws(() => readManagedFiles(), /must use repository marius-patrik\/agents-data/);

    await writeFile(registryPath, JSON.stringify([]));
    assert.throws(() => readManagedFiles(), /only the agent-os-data record/);

    await writeFile(
      registryPath,
      JSON.stringify([
        { id: "agent-os-data", repo: "marius-patrik/agents-data", path: join(root, "data", "agent-os") },
        { id: "other-data", repo: "marius-patrik/other", path: join(root, "data", "other") }
      ])
    );
    assert.throws(() => readManagedFiles(), /only the agent-os-data record/);
  } finally {
    if (previousRegistry === undefined) delete process.env.AGENTS_DATA_REPOS;
    else process.env.AGENTS_DATA_REPOS = previousRegistry;
    if (previousAgentsRoot === undefined) delete process.env.AGENTS_ROOT;
    else process.env.AGENTS_ROOT = previousAgentsRoot;
    await rm(root, { recursive: true, force: true });
  }
});
