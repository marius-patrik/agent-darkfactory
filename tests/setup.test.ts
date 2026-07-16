import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { armManagedSetupBootstrap, convergeBranchProtection, convergeRepositoryFoundation, convergeRepositorySettings, SetupOwnerActionRequired } from "../src/setup.js";
import {
  managedSetupPullRequestBody,
  MANAGED_SETUP_BRANCH,
  MANAGED_SETUP_TITLE,
  type ManagedSetupProvenance
} from "../src/managed-sync.js";
import { DARK_FACTORY_MANAGED_CONFIG_PATH, type ManagedFile } from "../src/managed-files.js";

const repo = { owner: "marius-patrik", repo: "example" };
const labels = [{ name: "df:ready", color: "0E8A16", description: "Machine-evaluated" }];
const workflows = [".github/workflows/ci.yml"];
const BOOTSTRAP_BASE_SHA = "a".repeat(40);
const BOOTSTRAP_HEAD_SHA = "b".repeat(40);
const BOOTSTRAP_BASE_TREE_SHA = "c".repeat(40);
const BOOTSTRAP_EXPECTED_TREE_SHA = "d".repeat(40);
const BOOTSTRAP_FILES: ManagedFile[] = [
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
const BOOTSTRAP_CHANGED_PATHS = BOOTSTRAP_FILES.map((file) => file.path);
const BOOTSTRAP_PROVENANCE: ManagedSetupProvenance = {
  schemaVersion: 1,
  baseBranch: "main",
  baseSha: BOOTSTRAP_BASE_SHA,
  headSha: BOOTSTRAP_HEAD_SHA,
  treeSha: BOOTSTRAP_EXPECTED_TREE_SHA,
  changedPathsDigest: createHash("sha256")
    .update(JSON.stringify([...BOOTSTRAP_CHANGED_PATHS].sort()))
    .digest("hex")
};

test("setup settings convergence is a proven no-op when repository state is healthy", async () => {
  const calls: Array<{ route: string; parameters: Record<string, unknown> }> = [];
  const github = requester(calls, (route, parameters) => {
    if (route === "GET /repos/{owner}/{repo}") return { default_branch: "main", allow_auto_merge: true, delete_branch_on_merge: true };
    if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") return { object: { sha: parameters.ref === "heads/main" ? "main-sha" : "dev-sha" } };
    if (route === "GET /repos/{owner}/{repo}/labels") return [{ name: "df:ready", color: "0e8a16", description: "Machine-evaluated" }];
    if (route === "GET /repos/{owner}/{repo}/actions/workflows") return { workflows: [{ id: 1, path: workflows[0], state: "active" }] };
    if (route === "GET /repos/{owner}/{repo}/branches/{branch}/protection") return protection();
    throw new Error(`unexpected ${route}`);
  });

  const receipts = await convergeRepositorySettings(github, repo, labels, workflows);
  assert.equal(receipts.every((receipt) => receipt.status === "current"), true);
  assert.equal(calls.some((call) => /^(POST|PATCH|PUT|DELETE) /.test(call.route)), false);
});

test("setup rejects code-repository convergence for main-only data before any GitHub call", async () => {
  for (const dataRepo of [
    { owner: "marius-patrik", repo: "Andromeda-data" },
    { owner: "MARIUS-PATRIK", repo: "DARKFACTORY-DATA" }
  ]) {
    const calls: Array<{ route: string; parameters: Record<string, unknown> }> = [];
    const github = requester(calls, (route) => {
      throw new Error(`main-only data boundary leaked into ${route}`);
    });

    await assert.rejects(
      () => convergeRepositorySettings(github, dataRepo, labels, workflows),
      (error: unknown) => error instanceof SetupOwnerActionRequired
        && error.action === "main-only-data-boundary"
        && /no dev branch, automerge, label, workflow, Autoreview, or code-gate mutation/.test(error.message)
    );
    assert.deepEqual(calls, []);
  }
});

test("setup settings convergence repairs only deterministic settings and preserves safe protection fields", async () => {
  const calls: Array<{ route: string; parameters: Record<string, unknown> }> = [];
  const notFound = Object.assign(new Error("not found"), { status: 404 });
  let automationEnabled = false;
  const protectedBranches = new Set<string>();
  const github = requester(calls, (route, parameters) => {
    if (route === "GET /repos/{owner}/{repo}") return { default_branch: "main", allow_auto_merge: automationEnabled, delete_branch_on_merge: automationEnabled };
    if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") {
      if (parameters.ref === "heads/dev") throw notFound;
      return { object: { sha: "main-sha" } };
    }
    if (route === "GET /repos/{owner}/{repo}/labels") return [];
    if (route === "GET /repos/{owner}/{repo}/actions/workflows") return { workflows: [{ id: 2, path: workflows[0], state: "disabled_manually" }] };
    if (route === "GET /repos/{owner}/{repo}/branches/{branch}/protection") {
      if (!protectedBranches.has(String(parameters.branch))) throw notFound;
      return protection();
    }
    if (route === "PATCH /repos/{owner}/{repo}") { automationEnabled = true; return {}; }
    if (route === "PUT /repos/{owner}/{repo}/branches/{branch}/protection") { protectedBranches.add(String(parameters.branch)); return {}; }
    if (/^(POST|PUT) /.test(route)) return {};
    throw new Error(`unexpected ${route}`);
  });

  const receipts = await convergeRepositorySettings(github, repo, labels, workflows);
  assert.ok(receipts.some((receipt) => receipt.action === "ensure-dev" && receipt.status === "applied"));
  assert.ok(calls.some((call) => call.route === "POST /repos/{owner}/{repo}/git/refs" && call.parameters.sha === "main-sha"));
  assert.ok(calls.some((call) => call.route === "PATCH /repos/{owner}/{repo}" && call.parameters.allow_auto_merge === true));
  const protections = calls.filter((call) => call.route === "PUT /repos/{owner}/{repo}/branches/{branch}/protection");
  assert.equal(protections.length, 2);
  assert.equal(protections.every((call) => call.parameters.enforce_admins === true && call.parameters.allow_force_pushes === false && call.parameters.allow_deletions === false), true);
});

test("setup observes App-omitted auto-merge through GraphQL without inventing a repair", async () => {
  const calls: string[] = [];
  const github = {
    async request(route: string, parameters: Record<string, unknown>) {
      calls.push(route);
      if (route === "GET /repos/{owner}/{repo}") return { data: { default_branch: "main", delete_branch_on_merge: true } };
      if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") return { data: { object: { sha: parameters.ref === "heads/main" ? "main-sha" : "dev-sha" } } };
      if (route === "GET /repos/{owner}/{repo}/labels") return { data: [{ name: "df:ready", color: "0e8a16", description: "Machine-evaluated" }] };
      if (route === "GET /repos/{owner}/{repo}/actions/workflows") return { data: { workflows: [{ id: 1, path: workflows[0], state: "active" }] } };
      if (route === "GET /repos/{owner}/{repo}/branches/{branch}/protection") return { data: protection() };
      throw new Error(`unexpected ${route}`);
    },
    async graphql() { return { repository: { autoMergeAllowed: true } }; }
  };

  const receipts = await convergeRepositorySettings(github, repo, labels, workflows);
  assert.ok(receipts.some((receipt) => receipt.action === "repository-automation" && receipt.status === "current"));
  assert.equal(calls.includes("PATCH /repos/{owner}/{repo}"), false);
});

test("setup refuses automation mutation when App-scoped settings remain unobservable", async () => {
  const calls: string[] = [];
  const github = {
    async request(route: string, parameters: Record<string, unknown>) {
      calls.push(route);
      if (route === "GET /repos/{owner}/{repo}") return { data: { default_branch: "main" } };
      if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") return { data: { object: { sha: parameters.ref === "heads/main" ? "main-sha" : "dev-sha" } } };
      throw new Error(`unexpected ${route}`);
    },
    async graphql() { throw Object.assign(new Error("forbidden"), { status: 403 }); }
  };

  await assert.rejects(
    () => convergeRepositorySettings(github, repo, labels, workflows),
    (error: unknown) => error instanceof SetupOwnerActionRequired && error.action === "repository-automation-observation"
  );
  assert.equal(calls.includes("PATCH /repos/{owner}/{repo}"), false);
});

test("setup settings convergence surfaces App permission gaps as owner actions", async () => {
  const forbidden = Object.assign(new Error("forbidden"), { status: 403 });
  const github = requester([], (route, parameters) => {
    if (route === "GET /repos/{owner}/{repo}") return { default_branch: "main", allow_auto_merge: false, delete_branch_on_merge: false };
    if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") return { object: { sha: parameters.ref === "heads/main" ? "main-sha" : "dev-sha" } };
    if (route === "PATCH /repos/{owner}/{repo}") throw forbidden;
    throw new Error(`unexpected ${route}`);
  });

  await assert.rejects(
    () => convergeRepositorySettings(github, repo, labels, workflows),
    (error: unknown) => error instanceof SetupOwnerActionRequired && error.action === "repository-automation"
  );
});

test("setup initializes an empty repository with an empty main commit before reviewed content PRs", async () => {
  const calls: Array<{ route: string; parameters: Record<string, unknown> }> = [];
  const notFound = Object.assign(new Error("not found"), { status: 404 });
  const refs = new Map<string, string>();
  const github = requester(calls, (route, parameters) => {
    if (route === "GET /repos/{owner}/{repo}") return { default_branch: "main", allow_auto_merge: true, delete_branch_on_merge: true };
    if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") {
      const sha = refs.get(String(parameters.ref));
      if (!sha) throw notFound;
      return { object: { sha } };
    }
    if (route === "POST /repos/{owner}/{repo}/git/trees") return { sha: "empty-tree" };
    if (route === "POST /repos/{owner}/{repo}/git/commits") return { sha: "initial-commit" };
    if (route === "POST /repos/{owner}/{repo}/git/refs") { refs.set(String(parameters.ref).replace(/^refs\//, ""), String(parameters.sha)); return {}; }
    if (route === "GET /repos/{owner}/{repo}/labels") return [{ name: "df:ready", color: "0e8a16", description: "Machine-evaluated" }];
    if (route === "GET /repos/{owner}/{repo}/actions/workflows") return { workflows: [{ id: 1, path: workflows[0], state: "active" }] };
    if (route === "GET /repos/{owner}/{repo}/branches/{branch}/protection") return protection();
    throw new Error(`unexpected ${route}`);
  });
  const receipts = await convergeRepositorySettings(github, repo, labels, workflows);
  assert.ok(receipts.some((receipt) => receipt.action === "initialize-main" && receipt.status === "applied"));
  assert.ok(receipts.some((receipt) => receipt.action === "ensure-dev" && receipt.status === "applied"));
  assert.deepEqual(calls.find((call) => call.route === "POST /repos/{owner}/{repo}/git/trees")?.parameters.tree, []);
  assert.equal(calls.some((call) => call.route === "PATCH /repos/{owner}/{repo}" && "default_branch" in call.parameters), false);
});

test("fresh-repository foundation creates refs without prematurely installing unavailable gates", async () => {
  const calls: Array<{ route: string; parameters: Record<string, unknown> }> = [];
  const notFound = Object.assign(new Error("not found"), { status: 404 });
  const refs = new Map<string, string>();
  const github = requester(calls, (route, parameters) => {
    if (route === "GET /repos/{owner}/{repo}") return { default_branch: "main", allow_auto_merge: true, delete_branch_on_merge: true };
    if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") {
      const sha = refs.get(String(parameters.ref));
      if (!sha) throw notFound;
      return { object: { sha } };
    }
    if (route === "POST /repos/{owner}/{repo}/git/trees") return { sha: "empty-tree" };
    if (route === "POST /repos/{owner}/{repo}/git/commits") return { sha: "initial-commit" };
    if (route === "POST /repos/{owner}/{repo}/git/refs") { refs.set(String(parameters.ref).replace(/^refs\//, ""), String(parameters.sha)); return {}; }
    throw new Error(`unexpected ${route}`);
  });

  const receipts = await convergeRepositoryFoundation(github, repo, { createDev: false });
  assert.ok(receipts.some((receipt) => receipt.action === "initialize-main"));
  assert.equal(receipts.some((receipt) => receipt.action === "ensure-dev"), false);
  assert.equal(calls.some((call) => call.route.includes("/protection")), false);
  assert.equal(calls.some((call) => call.route.includes("/actions/workflows")), false);
  assert.equal(calls.some((call) => call.route.endsWith("/labels")), false);
});

test("setup fails closed when branch-protection postconditions do not materialize", async () => {
  const unsafe = {
    required_status_checks: { strict: false, checks: [] },
    enforce_admins: { enabled: false },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false }
  };
  const github = requester([], (route, parameters) => {
    if (route === "GET /repos/{owner}/{repo}") return { default_branch: "main", allow_auto_merge: true, delete_branch_on_merge: true };
    if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") return { object: { sha: parameters.ref === "heads/main" ? "main-sha" : "dev-sha" } };
    if (route === "GET /repos/{owner}/{repo}/labels") return [{ name: "df:ready", color: "0e8a16", description: "Machine-evaluated" }];
    if (route === "GET /repos/{owner}/{repo}/actions/workflows") return { workflows: [{ id: 1, path: workflows[0], state: "active" }] };
    if (route === "GET /repos/{owner}/{repo}/branches/{branch}/protection") return unsafe;
    if (route === "PUT /repos/{owner}/{repo}/branches/{branch}/protection") return {};
    throw new Error(`unexpected ${route}`);
  });
  await assert.rejects(
    () => convergeRepositorySettings(github, repo, labels, workflows),
    (error: unknown) => error instanceof SetupOwnerActionRequired && error.action === "protection:main:verification"
  );
});

test("setup replaces the retired Codex Review gate with exact DarkFactory Autoreview evidence", async () => {
  const legacy = {
    ...protection(),
    required_status_checks: {
      strict: true,
      checks: [
        { context: "Validate", app_id: 15368 },
        { context: "Codex Review", app_id: 15368 },
        { context: "Repository policy", app_id: 42 }
      ]
    }
  };
  let observed = legacy;
  const writes: Record<string, unknown>[] = [];
  const github = requester([], (route, parameters) => {
    if (route === "GET /repos/{owner}/{repo}/branches/{branch}/protection") return observed;
    if (route === "PUT /repos/{owner}/{repo}/branches/{branch}/protection") {
      writes.push(parameters);
      observed = {
        ...legacy,
        required_status_checks: parameters.required_status_checks as typeof legacy.required_status_checks
      };
      return {};
    }
    throw new Error(`unexpected ${route}`);
  });

  const receipt = await convergeBranchProtection(github, repo, "dev");
  assert.equal(receipt.status, "applied");
  const checks = (writes[0].required_status_checks as { checks: Array<{ context: string; app_id: number }> }).checks;
  assert.deepEqual(checks, [
    { context: "DarkFactory Autoreview", app_id: 15368 },
    { context: "Repository policy", app_id: 42 },
    { context: "Validate", app_id: 15368 }
  ]);
});

test("initial managed setup arms auto-merge only behind an exact temporary bootstrap gate", async () => {
  const { github, calls, graphql } = managedBootstrapRequester();

  const receipts = await armManagedSetupBootstrap(
    github,
    repo,
    "https://github.com/marius-patrik/example/pull/9",
    BOOTSTRAP_FILES
  );
  const write = calls.find((call) => call.route === "PUT /repos/{owner}/{repo}/branches/{branch}/protection")!;
  assert.deepEqual(write.parameters.required_status_checks, { strict: true, checks: [{ context: "Managed setup", app_id: 15368 }] });
  assert.equal(write.parameters.enforce_admins, true);
  assert.equal(write.parameters.allow_force_pushes, false);
  assert.equal(write.parameters.allow_deletions, false);
  assert.equal(graphql[0]?.variables?.pullRequestId, "PR_node");
  assert.equal(calls.filter((call) => call.route === "GET /repos/{owner}/{repo}/pulls/{pull_number}").length, 2);
  assert.ok(receipts.some((entry) => entry.action === "managed-bootstrap-automerge" && entry.status === "applied"));
});

test("managed bootstrap accepts the exact non-force two-parent base-advance recovery head", async () => {
  const pull = managedBootstrapPull();
  pull.commits = 2;
  const { github, calls, graphql } = managedBootstrapRequester({
    pull,
    headParents: ["f".repeat(40), BOOTSTRAP_BASE_SHA]
  });

  const receipts = await armManagedSetupBootstrap(
    github,
    repo,
    "https://github.com/marius-patrik/example/pull/9",
    BOOTSTRAP_FILES
  );

  assert.equal(graphql[0]?.variables?.pullRequestId, "PR_node");
  assert.equal(calls.some((call) => call.route === "PUT /repos/{owner}/{repo}/branches/{branch}/protection"), true);
  assert.ok(receipts.some((entry) => entry.action === "managed-bootstrap-automerge" && entry.status === "applied"));
});

test("managed bootstrap rejects a fork or competing branch before protection mutation", async () => {
  const pull = managedBootstrapPull();
  pull.head = { ref: "attacker", sha: BOOTSTRAP_HEAD_SHA, repo: { full_name: "someone/fork" } };
  const { github, calls, graphql } = managedBootstrapRequester({ pull });

  await assert.rejects(
    armManagedSetupBootstrap(
      github,
      repo,
      "https://github.com/marius-patrik/example/pull/9",
      BOOTSTRAP_FILES
    ),
    (error: unknown) => error instanceof SetupOwnerActionRequired
      && error.action === "managed-bootstrap-pr"
      && /exact expected App-owned target, head, parent, and provenance plan/.test(error.message)
  );
  assert.equal(calls.some((call) => call.route.includes("/protection")), false);
  assert.deepEqual(graphql, []);
});

test("managed bootstrap rejects non-canonical head content before protection mutation", async () => {
  const { github, calls, graphql } = managedBootstrapRequester({ headTreeSha: "e".repeat(40) });

  await assert.rejects(
    armManagedSetupBootstrap(
      github,
      repo,
      "https://github.com/marius-patrik/example/pull/9",
      BOOTSTRAP_FILES
    ),
    (error: unknown) => error instanceof SetupOwnerActionRequired
      && error.action === "managed-bootstrap-pr"
      && /exact canonical managed-only diff/.test(error.message)
  );
  assert.equal(calls.some((call) => call.route.includes("/protection")), false);
  assert.deepEqual(graphql, []);
});

function managedBootstrapPull(): Record<string, unknown> {
  return {
    state: "open",
    draft: false,
    title: MANAGED_SETUP_TITLE,
    commits: 1,
    node_id: "PR_node",
    auto_merge: null,
    body: managedSetupPullRequestBody(BOOTSTRAP_CHANGED_PATHS, BOOTSTRAP_PROVENANCE),
    user: { login: "darkfactory-agent[bot]", type: "Bot" },
    base: {
      ref: "main",
      sha: BOOTSTRAP_BASE_SHA,
      repo: { full_name: "marius-patrik/example" }
    },
    head: {
      ref: MANAGED_SETUP_BRANCH,
      sha: BOOTSTRAP_HEAD_SHA,
      repo: { full_name: "marius-patrik/example" }
    }
  };
}

function managedBootstrapRequester(options: {
  pull?: Record<string, unknown>;
  headTreeSha?: string;
  headParents?: string[];
} = {}) {
  const notFound = Object.assign(new Error("not found"), { status: 404 });
  const pull = options.pull ?? managedBootstrapPull();
  const calls: Array<{ route: string; parameters: Record<string, unknown> }> = [];
  const graphql: Array<{ query: string; variables?: Record<string, unknown> }> = [];
  let installed: Record<string, unknown> | null = null;
  const github = {
    async request(route: string, parameters: Record<string, unknown>) {
      calls.push({ route, parameters });
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") return { data: pull };
      if (route === "GET /repos/{owner}/{repo}") {
        return { data: { default_branch: "main", archived: false } };
      }
      if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") {
        return { data: { object: { sha: BOOTSTRAP_BASE_SHA } } };
      }
      if (route === "GET /repos/{owner}/{repo}/contents/{path}") throw notFound;
      if (route === "GET /repos/{owner}/{repo}/git/commits/{commit_sha}") {
        const isHead = parameters.commit_sha === BOOTSTRAP_HEAD_SHA;
        return {
          data: {
            tree: { sha: isHead ? (options.headTreeSha ?? BOOTSTRAP_EXPECTED_TREE_SHA) : BOOTSTRAP_BASE_TREE_SHA },
            parents: isHead
              ? (options.headParents ?? [BOOTSTRAP_BASE_SHA]).map((sha) => ({ sha }))
              : []
          }
        };
      }
      if (route === "GET /repos/{owner}/{repo}/git/trees/{tree_sha}") {
        return { data: { tree: [], truncated: false } };
      }
      if (route === "POST /repos/{owner}/{repo}/git/trees") {
        return { data: { sha: BOOTSTRAP_EXPECTED_TREE_SHA } };
      }
      if (route === "GET /installation") {
        return { data: { app_slug: "darkfactory-agent", app_id: 12345 } };
      }
      if (route === "GET /repos/{owner}/{repo}/commits/{ref}") {
        return { data: { author: { login: "darkfactory-agent[bot]", type: "Bot" } } };
      }
      if (route === "GET /repos/{owner}/{repo}/branches/{branch}/protection") {
        if (!installed) throw notFound;
        return { data: installed };
      }
      if (route === "PUT /repos/{owner}/{repo}/branches/{branch}/protection") {
        installed = {
          required_status_checks: parameters.required_status_checks,
          enforce_admins: { enabled: parameters.enforce_admins },
          allow_force_pushes: { enabled: parameters.allow_force_pushes },
          allow_deletions: { enabled: parameters.allow_deletions }
        };
        return { data: {} };
      }
      throw new Error(`unexpected ${route}`);
    },
    async graphql(query: string, variables?: Record<string, unknown>) {
      graphql.push({ query, variables });
      return { enablePullRequestAutoMerge: { pullRequest: { id: "PR_node" } } };
    }
  };
  return { github, calls, graphql };
}

function requester(
  calls: Array<{ route: string; parameters: Record<string, unknown> }>,
  handle: (route: string, parameters: Record<string, unknown>) => unknown
) {
  return {
    async request(route: string, parameters: Record<string, unknown>) {
      calls.push({ route, parameters });
      return { data: handle(route, parameters) };
    }
  };
}

function protection() {
  return {
    required_status_checks: { strict: true, checks: [{ context: "Validate", app_id: 15368 }, { context: "DarkFactory Autoreview", app_id: 15368 }] },
    enforce_admins: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false }
  };
}
