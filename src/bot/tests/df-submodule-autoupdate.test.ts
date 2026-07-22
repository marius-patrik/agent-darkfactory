// @ts-nocheck
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const submodules: any = await import("../../../scripts/df-submodule-autoupdate.mjs?unit=submodule-autoupdate-test");
const checkout: any = await import("../../../scripts/df-submodule-checkout.mjs?unit=submodule-checkout-test");
const orchestrator: any = await import("../../../scripts/df-orchestrate.mjs?unit=submodule-dashboard-test");
const dfLib: any = await import("../../../scripts/df-lib.mjs?unit=submodule-ledger-test");

const CHILD = { owner: "marius-patrik", repo: "DarkFactory" };
const PARENT = { owner: "marius-patrik", repo: "Andromeda" };
const OLD = "1".repeat(40);
const NEW = "2".repeat(40);
const PARENT_SHA = "3".repeat(40);
const POINTER_HEAD = "4".repeat(40);
const TREE = "5".repeat(40);
const ADVANCED_PARENT = "6".repeat(40);
const RECOVERY_HEAD = "7".repeat(40);
const ADVANCED_TREE = "8".repeat(40);
const RECOVERY_TREE = "9".repeat(40);
const policy = submodules.loadSubmodulePolicy();

function protectedBranch() {
  return {
    required_status_checks: {
      strict: true,
      checks: [
        { context: "Validate", app_id: 15368 },
        { context: "DarkFactory Autoreview", app_id: 15368 }
      ]
    },
    enforce_admins: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false }
  };
}

function releasePolicy() {
  return {
    schemaVersion: 1,
    enabled: true,
    mode: "branch-only",
    releaseBranchPrefix: "release/",
    reconcileBranchPrefix: "reconcile/",
    requiredChecks: ["Validate", "DarkFactory Autoreview"],
    mainChecks: ["Validate"],
    tagPattern: null,
    artifactWorkflows: [],
    publicationChecks: [],
    producer: null
  };
}

function releaseReceipt(overrides = {}) {
  return {
    kind: "df-release",
    target_repo: "marius-patrik/DarkFactory",
    created_at: "2026-07-15T08:00:00.000Z",
    status: "verified",
    plan_id: "release-" + "a".repeat(20),
    repository: "marius-patrik/DarkFactory",
    main_sha: NEW,
    dev_sha: NEW,
    main_tree_sha: TREE,
    dev_tree_sha: TREE,
    policy_mode: "branch-only",
    release: {
      green: true,
      pull_request: "https://github.com/marius-patrik/DarkFactory/pull/100",
      checks: {
        green: true,
        checks: [
          { name: "Validate", expectedAppId: 15368, actualAppId: 15368, id: 1, url: "https://github.com/checks/1", state: "green" },
          { name: "DarkFactory Autoreview", expectedAppId: 15368, actualAppId: 15368, id: 2, url: "https://github.com/checks/2", state: "green" }
        ]
      }
    },
    publication: { green: true, mode: "branch-only" },
    ...overrides
  };
}

function andromedaModules() {
  return policy.canonicalRoots[0].gitlinks.map((item: any) => [
    `[submodule "${item.name}"]`,
    `  path = ${item.path}`,
    `  url = https://github.com/${item.repository}.git`,
    `  branch = ${item.branch}`
  ].join("\n")).join("\n");
}

function content(text: string) {
  return { type: "file", encoding: "base64", content: Buffer.from(text).toString("base64") };
}

function apiError(status: number) {
  return Object.assign(new Error(`api ${status}`), { status });
}

function observationRuntime(options: any = {}) {
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const receipt = options.receipt === undefined ? releaseReceipt() : options.receipt;
  const mainPointer = options.mainPointer || OLD;
  const devPointer = options.devPointer || OLD;
  const relation = options.relation || { status: "ahead", ahead_by: 1, behind_by: 0 };
  const modules = options.modules || andromedaModules();
  const devModules = options.devModules || modules;
  const pulls = options.pulls || [];
  const gh = {
    async request(method: string, requestPath: string, body?: any) {
      calls.push({ method, path: requestPath, body });
      if (requestPath === "/repos/marius-patrik/DarkFactory" && options.childInaccessible) throw apiError(404);
      if (requestPath === "/repos/marius-patrik/DarkFactory") return { default_branch: "main", archived: false, disabled: false };
      if (requestPath === "/repos/marius-patrik/DarkFactory/commits/main") return { sha: NEW };
      if (requestPath === "/repos/marius-patrik/DarkFactory/branches/main/protection") return protectedBranch();
      if (requestPath.includes("/repos/marius-patrik/DarkFactory/contents/.agents/release-policy.json")) return content(JSON.stringify(releasePolicy()));
      if (requestPath === `/repos/marius-patrik/DarkFactory/commits/${NEW}/check-runs?per_page=100`) {
        return { check_runs: [{ name: "Validate", status: "completed", conclusion: "success", id: 10, html_url: "https://github.com/checks/10", app: { id: 15368 } }] };
      }
      if (requestPath === `/repos/marius-patrik/DarkFactory/commits/${NEW}/status`) return { statuses: [] };
      if (requestPath === "/repos/marius-patrik/darkfactory-data/contents/runs/marius-patrik/DarkFactory") {
        if (!receipt) throw apiError(404);
        return [{ type: "file", name: "2026-07-15T08-00-00-000Z-df-release.json" }];
      }
      if (requestPath.includes("/repos/marius-patrik/darkfactory-data/contents/runs/marius-patrik/DarkFactory/2026")) return content(JSON.stringify(receipt));
      if (requestPath === "/repos/marius-patrik/darkfactory-data/contents/runs/marius-patrik/Andromeda") {
        if (!options.pointerLedger) throw apiError(404);
        return [{ type: "file", name: "2026-07-15T08-30-00-000Z-df-submodule-update.json" }];
      }
      if (requestPath.includes("/repos/marius-patrik/darkfactory-data/contents/runs/marius-patrik/Andromeda/2026")) {
        return content(JSON.stringify(options.pointerLedger));
      }
      if (requestPath === "/repos/marius-patrik/Andromeda") {
        return { default_branch: "main", archived: false, disabled: false, allow_auto_merge: true, delete_branch_on_merge: true };
      }
      if (requestPath === "/repos/marius-patrik/Andromeda/git/ref/heads/main"
          || requestPath === "/repos/marius-patrik/Andromeda/git/ref/heads/dev") return { object: { sha: PARENT_SHA } };
      if (requestPath === `/repos/marius-patrik/Andromeda/compare/${PARENT_SHA}...${PARENT_SHA}`) return { status: "identical", ahead_by: 0, behind_by: 0 };
      if (requestPath.includes("/repos/marius-patrik/Andromeda/contents/.gitmodules?ref=dev")) return content(devModules);
      if (requestPath.includes("/repos/marius-patrik/Andromeda/contents/.gitmodules")) return content(modules);
      if (requestPath.includes("/repos/marius-patrik/Andromeda/contents/plugins/DarkFactory?ref=main")) return { type: "submodule", sha: mainPointer };
      if (requestPath.includes("/repos/marius-patrik/Andromeda/contents/plugins/DarkFactory?ref=dev")) return { type: "submodule", sha: devPointer };
      if (requestPath === `/repos/marius-patrik/DarkFactory/compare/${devPointer}...${NEW}`) return relation;
      if (requestPath === "/repos/marius-patrik/Andromeda/branches/dev/protection") return protectedBranch();
      if (requestPath.includes("/repos/marius-patrik/Andromeda/contents/.agents/release-policy.json")) return content(JSON.stringify(releasePolicy()));
      if (requestPath === "/repos/marius-patrik/Andromeda/pulls?state=open&base=dev&per_page=100&page=1") return pulls;
      const pullMatch = requestPath.match(/^\/repos\/marius-patrik\/Andromeda\/pulls\/(\d+)$/);
      if (pullMatch) return options.pullDetails?.[Number(pullMatch[1])] || pulls.find((item: any) => item.number === Number(pullMatch[1]));
      const filesMatch = requestPath.match(/^\/repos\/marius-patrik\/Andromeda\/pulls\/(\d+)\/files\?per_page=100&page=1$/);
      if (filesMatch) return options.pullFiles?.[Number(filesMatch[1])] || [];
      throw new Error(`unexpected ${method} ${requestPath}`);
    }
  };
  submodules.configureSubmoduleRuntime({
    gh,
    ledgerGh: gh,
    controlRepo: { owner: "marius-patrik", repo: "DarkFactory" },
    parents: [PARENT],
    registry: { schemaVersion: 1, repositories: { "marius-patrik/andromeda": { state: "active" } } },
    policy,
    now: Date.parse("2026-07-15T09:00:00.000Z")
  });
  return { gh, calls };
}

function fabricaObservationRuntime(defaultBranch = "dev") {
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const receipt = releaseReceipt({
    target_repo: "marius-patrik/Fabrica",
    repository: "marius-patrik/Fabrica",
    main_sha: OLD,
    dev_sha: NEW,
    release: {
      ...releaseReceipt().release,
      pull_request: "https://github.com/marius-patrik/Fabrica/pull/100"
    }
  });
  const gh = {
    async request(method: string, requestPath: string, body?: any) {
      calls.push({ method, path: requestPath, body });
      if (requestPath === "/repos/marius-patrik/Fabrica") {
        return { default_branch: defaultBranch, archived: false, disabled: false };
      }
      if (requestPath === "/repos/marius-patrik/Fabrica/commits/dev") return { sha: NEW };
      if (requestPath === "/repos/marius-patrik/Fabrica/branches/dev/protection") return protectedBranch();
      if (requestPath.includes("/repos/marius-patrik/Fabrica/contents/.agents/release-policy.json?ref=dev")) {
        return content(JSON.stringify(releasePolicy()));
      }
      if (requestPath === `/repos/marius-patrik/Fabrica/commits/${NEW}/check-runs?per_page=100`) {
        return { check_runs: [{ name: "Validate", status: "completed", conclusion: "success", id: 10, html_url: "https://github.com/checks/10", app: { id: 15368 } }] };
      }
      if (requestPath === `/repos/marius-patrik/Fabrica/commits/${NEW}/status`) return { statuses: [] };
      if (requestPath === "/repos/marius-patrik/darkfactory-data/contents/runs/marius-patrik/Fabrica") {
        return [{ type: "file", name: "2026-07-15T08-00-00-000Z-df-release.json" }];
      }
      if (requestPath.includes("/repos/marius-patrik/darkfactory-data/contents/runs/marius-patrik/Fabrica/2026")) {
        return content(JSON.stringify(receipt));
      }
      if (requestPath === "/repos/marius-patrik/darkfactory-data/contents/runs/marius-patrik/Andromeda") throw apiError(404);
      if (requestPath === "/repos/marius-patrik/Andromeda") {
        return { default_branch: "main", archived: false, disabled: false, allow_auto_merge: true, delete_branch_on_merge: true };
      }
      if (requestPath === "/repos/marius-patrik/Andromeda/git/ref/heads/main"
          || requestPath === "/repos/marius-patrik/Andromeda/git/ref/heads/dev") return { object: { sha: PARENT_SHA } };
      if (requestPath === `/repos/marius-patrik/Andromeda/compare/${PARENT_SHA}...${PARENT_SHA}`) {
        return { status: "identical", ahead_by: 0, behind_by: 0 };
      }
      if (requestPath.includes("/repos/marius-patrik/Andromeda/contents/.gitmodules")) return content(andromedaModules());
      if (requestPath.includes("/repos/marius-patrik/Andromeda/contents/apps/Fabrica?ref=main")
          || requestPath.includes("/repos/marius-patrik/Andromeda/contents/apps/Fabrica?ref=dev")) {
        return { type: "submodule", sha: OLD };
      }
      if (requestPath === `/repos/marius-patrik/Fabrica/compare/${OLD}...${NEW}`) {
        return { status: "ahead", ahead_by: 1, behind_by: 0 };
      }
      if (requestPath === "/repos/marius-patrik/Andromeda/branches/dev/protection") return protectedBranch();
      if (requestPath.includes("/repos/marius-patrik/Andromeda/contents/.agents/release-policy.json")) {
        return content(JSON.stringify(releasePolicy()));
      }
      if (requestPath === "/repos/marius-patrik/Andromeda/pulls?state=open&base=dev&per_page=100&page=1") return [];
      throw new Error(`unexpected ${method} ${requestPath}`);
    }
  };
  submodules.configureSubmoduleRuntime({
    gh,
    ledgerGh: gh,
    controlRepo: { owner: "marius-patrik", repo: "DarkFactory" },
    parents: [PARENT],
    registry: { schemaVersion: 1, repositories: { "marius-patrik/andromeda": { state: "active" } } },
    policy,
    now: Date.parse("2026-07-15T09:00:00.000Z")
  });
  return { calls };
}

function pointerObservationAt(devSha: string) {
  const candidate = {
    repository: "marius-patrik/Andromeda",
    mainSha: PARENT_SHA,
    devSha,
    gitlink: {
      name: "DarkFactory",
      path: "plugins/DarkFactory",
      url: "https://github.com/marius-patrik/DarkFactory.git",
      branch: "main"
    },
    mainPointer: OLD,
    devPointer: OLD,
    releasedSha: NEW,
    relation: { status: "ahead", ahead_by: 1, behind_by: 0 },
    pointerState: "behind",
    evidence: {
      parent_pointer: `https://github.com/marius-patrik/Andromeda/tree/${devSha}/plugins/DarkFactory`,
      child_release: "https://github.com/marius-patrik/DarkFactory/pull/100",
      child_commit: `https://github.com/marius-patrik/DarkFactory/commit/${NEW}`,
      ancestry: `https://github.com/marius-patrik/DarkFactory/compare/${OLD}...${NEW}`
    },
    blockers: []
  };
  return {
    child: "marius-patrik/DarkFactory",
    childRelease: {
      repository: "marius-patrik/DarkFactory",
      branch: "main",
      sha: NEW,
      receiptUrl: "https://github.com/marius-patrik/DarkFactory/pull/100",
      blockers: []
    },
    candidate,
    blockers: [],
    pointerState: "behind"
  };
}

function pointerBody(observation: any, plan: any, headSha: string) {
  const candidate = observation.candidate;
  return [
    `<!-- darkfactory:submodule-update plan=${plan.planId} parent=${candidate.devSha} child=${observation.child} old=${candidate.devPointer} new=${candidate.releasedSha} path=${candidate.gitlink.path} head=${headSha} -->`,
    "## DarkFactory released-pointer update",
    "",
    `- Parent: \`${candidate.repository}@dev\` from \`${candidate.devSha}\``,
    `- Gitlink: \`${candidate.gitlink.path}\` (\`${candidate.gitlink.name}\`)`,
    `- Child: \`${observation.child}@${candidate.releasedSha}\``,
    `- Previous pointer: \`${candidate.devPointer}\``,
    `- Verified release: ${observation.childRelease.receiptUrl}`,
    `- Ancestry: ${candidate.evidence.ancestry}`,
    "",
    "A separate read-only job recursively checks out this exact head without executing child code. Validate and a clean high-confirmed DarkFactory Autoreview must also be green before normal protected-PR automerge. The parent then releases through `df release`; its verified release receipt triggers the same downstream lane."
  ].join("\n");
}

function baseAdvanceRecoveryRuntime(options: any = {}) {
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const oldObservation = pointerObservationAt(PARENT_SHA);
  const oldPlan = submodules.buildSubmodulePlan(oldObservation, policy);
  const currentObservation = pointerObservationAt(ADVANCED_PARENT);
  const currentPlan = submodules.buildSubmodulePlan(currentObservation, policy);
  const branch = currentPlan.branch;
  const oldPointerTree = "a".repeat(40);
  let branchHead = options.interrupted ? RECOVERY_HEAD : POINTER_HEAD;
  let pullHead = branchHead;
  let pullBody = pointerBody(oldObservation, oldPlan, POINTER_HEAD);
  let bodyDrifted = false;
  const receipt = releaseReceipt();
  const pull = () => ({
    number: 210,
    node_id: "PR_210",
    html_url: "https://github.com/marius-patrik/Andromeda/pull/210",
    title: `Update DarkFactory to ${NEW.slice(0, 12)}`,
    state: "open",
    draft: false,
    body: pullBody,
    user: { type: "Bot", login: "darkfactory-agent[bot]" },
    base: { ref: "dev" },
    head: { ref: branch, sha: pullHead, repo: { full_name: "marius-patrik/Andromeda" } }
  });
  const gh = {
    async request(method: string, requestPath: string, body?: any) {
      calls.push({ method, path: requestPath, body });
      if (requestPath === "/repos/marius-patrik/DarkFactory") return { default_branch: "main", archived: false, disabled: false };
      if (requestPath === "/repos/marius-patrik/DarkFactory/commits/main") return { sha: NEW };
      if (requestPath === "/repos/marius-patrik/DarkFactory/branches/main/protection") return protectedBranch();
      if (requestPath.includes("/repos/marius-patrik/DarkFactory/contents/.agents/release-policy.json")) return content(JSON.stringify(releasePolicy()));
      if (requestPath === `/repos/marius-patrik/DarkFactory/commits/${NEW}/check-runs?per_page=100`) {
        return { check_runs: [{ name: "Validate", status: "completed", conclusion: "success", id: 10, html_url: "https://github.com/checks/10", app: { id: 15368 } }] };
      }
      if (requestPath === `/repos/marius-patrik/DarkFactory/commits/${NEW}/status`) return { statuses: [] };
      if (requestPath === "/repos/marius-patrik/darkfactory-data/contents/runs/marius-patrik/DarkFactory") {
        return [{ type: "file", name: "2026-07-15T08-00-00-000Z-df-release.json" }];
      }
      if (requestPath.includes("/repos/marius-patrik/darkfactory-data/contents/runs/marius-patrik/DarkFactory/2026")) return content(JSON.stringify(receipt));
      if (requestPath === "/repos/marius-patrik/darkfactory-data/contents/runs/marius-patrik/Andromeda") throw apiError(404);
      if (requestPath === "/repos/marius-patrik/Andromeda") {
        return { default_branch: "main", archived: false, disabled: false, allow_auto_merge: true, delete_branch_on_merge: true };
      }
      if (method === "GET" && requestPath === "/repos/marius-patrik/Andromeda/git/ref/heads/main") return { object: { sha: PARENT_SHA } };
      if (method === "GET" && requestPath === "/repos/marius-patrik/Andromeda/git/ref/heads/dev") return { object: { sha: ADVANCED_PARENT } };
      if (method === "GET" && requestPath.includes("/repos/marius-patrik/Andromeda/git/ref/heads/submodule-update%2F")) {
        return { object: { sha: branchHead } };
      }
      if (requestPath === `/repos/marius-patrik/Andromeda/compare/${PARENT_SHA}...${ADVANCED_PARENT}`) {
        return { status: "ahead", ahead_by: 1, behind_by: 0, files: [{ filename: "README.md" }] };
      }
      if (requestPath.includes("/repos/marius-patrik/Andromeda/contents/.gitmodules")) return content(andromedaModules());
      if (requestPath.includes("/repos/marius-patrik/Andromeda/contents/plugins/DarkFactory?ref=main")
          || requestPath.includes("/repos/marius-patrik/Andromeda/contents/plugins/DarkFactory?ref=dev")) {
        return { type: "submodule", sha: OLD };
      }
      if (requestPath.includes(`/repos/marius-patrik/Andromeda/contents/plugins/DarkFactory?ref=${POINTER_HEAD}`)
          || requestPath.includes(`/repos/marius-patrik/Andromeda/contents/plugins/DarkFactory?ref=${RECOVERY_HEAD}`)) {
        return { type: "submodule", sha: NEW };
      }
      if (requestPath === `/repos/marius-patrik/DarkFactory/compare/${OLD}...${NEW}`) {
        return { status: "ahead", ahead_by: 1, behind_by: 0 };
      }
      if (requestPath === "/repos/marius-patrik/Andromeda/branches/dev/protection") return protectedBranch();
      if (requestPath.includes("/repos/marius-patrik/Andromeda/contents/.agents/release-policy.json")) return content(JSON.stringify(releasePolicy()));
      if (requestPath === "/repos/marius-patrik/Andromeda/pulls?state=open&base=dev&per_page=100&page=1") return [pull()];
      if (requestPath === "/repos/marius-patrik/Andromeda/pulls/210/files?per_page=100&page=1") return [{ filename: "plugins/DarkFactory" }];
      if (method === "GET" && requestPath === "/repos/marius-patrik/Andromeda/pulls/210") {
        if (options.bodyDrift && branchHead === RECOVERY_HEAD && !bodyDrifted) {
          pullBody += "\n\nOwner note that must be preserved.";
          bodyDrifted = true;
        }
        return pull();
      }
      if (requestPath === `/repos/marius-patrik/Andromeda/commits/${POINTER_HEAD}`) {
        return { sha: POINTER_HEAD, author: { type: "Bot", login: "darkfactory-agent[bot]" } };
      }
      if (requestPath === `/repos/marius-patrik/Andromeda/git/commits/${POINTER_HEAD}`) {
        return {
          sha: POINTER_HEAD,
          message: options.tamperedOldCommit ? "unknown work" : `Update plugins/DarkFactory to ${NEW}\n\nDarkFactory-Submodule-Plan: ${oldPlan.planId}`,
          tree: { sha: oldPointerTree },
          parents: [{ sha: PARENT_SHA }]
        };
      }
      if (requestPath === `/repos/marius-patrik/Andromeda/compare/${PARENT_SHA}...${POINTER_HEAD}`) {
        return { status: "ahead", ahead_by: 1, behind_by: 0, files: [{ filename: "plugins/DarkFactory" }] };
      }
      if (requestPath === `/repos/marius-patrik/Andromeda/commits/${RECOVERY_HEAD}`) {
        return { sha: RECOVERY_HEAD, author: { type: "Bot", login: "darkfactory-agent[bot]" } };
      }
      if (requestPath === `/repos/marius-patrik/Andromeda/git/commits/${RECOVERY_HEAD}`) {
        return {
          sha: RECOVERY_HEAD,
          message: `Update plugins/DarkFactory to ${NEW}\n\nDarkFactory-Submodule-Plan: ${currentPlan.planId}`,
          tree: { sha: RECOVERY_TREE },
          parents: [{ sha: POINTER_HEAD }, { sha: ADVANCED_PARENT }]
        };
      }
      if (requestPath === `/repos/marius-patrik/Andromeda/compare/${ADVANCED_PARENT}...${RECOVERY_HEAD}`) {
        return { status: "ahead", ahead_by: 1, behind_by: 0, files: [{ filename: "plugins/DarkFactory" }] };
      }
      if (requestPath === `/repos/marius-patrik/Andromeda/git/commits/${ADVANCED_PARENT}`) return { tree: { sha: ADVANCED_TREE } };
      if (method === "POST" && requestPath === "/repos/marius-patrik/Andromeda/git/trees") {
        assert.equal(body.base_tree, ADVANCED_TREE);
        assert.deepEqual(body.tree, [{ path: "plugins/DarkFactory", mode: "160000", type: "commit", sha: NEW }]);
        return { sha: RECOVERY_TREE };
      }
      if (method === "POST" && requestPath === "/repos/marius-patrik/Andromeda/git/commits") {
        assert.deepEqual(body.parents, [POINTER_HEAD, ADVANCED_PARENT]);
        assert.equal(body.message, `Update plugins/DarkFactory to ${NEW}\n\nDarkFactory-Submodule-Plan: ${currentPlan.planId}`);
        return { sha: RECOVERY_HEAD };
      }
      if (method === "PATCH" && requestPath.includes("/repos/marius-patrik/Andromeda/git/refs/heads/submodule-update%2F")) {
        assert.equal(body.force, false);
        if (options.refConflict) throw apiError(422);
        branchHead = body.sha;
        pullHead = body.sha;
        return { object: { sha: body.sha } };
      }
      if (method === "PATCH" && requestPath === "/repos/marius-patrik/Andromeda/pulls/210") {
        pullBody = body.body;
        return pull();
      }
      throw new Error(`unexpected ${method} ${requestPath}`);
    }
  };
  submodules.configureSubmoduleRuntime({
    gh,
    ledgerGh: gh,
    controlRepo: { owner: "marius-patrik", repo: "DarkFactory" },
    parents: [PARENT],
    registry: { schemaVersion: 1, repositories: { "marius-patrik/andromeda": { state: "active" } } },
    policy,
    now: Date.parse("2026-07-15T09:00:00.000Z")
  });
  return { calls, currentPlan, pull };
}

test("submodule policy fixes the exact Andromeda path and name contract", () => {
  assert.deepEqual(submodules.canonicalAndromedaGitlinks().map((item: any) => [item.name, item.path]), [
    ["Singularity", "apps/Singularity"],
    ["Fabrica", "apps/Fabrica"],
    ["DarkFactory", "plugins/DarkFactory"],
    ["LifeQuest", "plugins/LifeQuest"],
    ["SkyAgent", "plugins/SkyAgent"],
    ["data", "data/andromeda"],
    ["darkfactory-data", "data/darkfactory"]
  ]);
  assert.deepEqual(policy.mainOnlyData.map((item: any) => [item.repository, item.admission]), [
    ["marius-patrik/private-data", "encrypted-bundle-validate"],
    ["marius-patrik/darkfactory-data", "app-ledger-validate"]
  ]);
  assert.throws(() => submodules.validateSubmodulePolicy({ ...policy, targetBranch: "main" }), /target dev/);
});

test("main-only private data admits only the documented plan posture and green App-bound Validate", () => {
  const green = {
    metadata: { private: true },
    dev: null,
    protectionPosture: "private-plan-unavailable",
    headSha: NEW,
    mainChecks: { green: true }
  };
  assert.deepEqual(submodules.validateMainOnlyDataAdmission(green), []);
  const blocked = submodules.validateMainOnlyDataAdmission({
    ...green,
    metadata: { private: false },
    dev: OLD,
    protectionPosture: "inaccessible",
    mainChecks: { green: false }
  });
  assert.deepEqual(blocked, [
    "main-only-data-has-dev",
    "main-only-data-not-private",
    "main-only-data-protection-posture:inaccessible",
    "main-only-data-validate-not-green"
  ]);
});

test("scheduled scans do not let a blocked newer receipt starve an actionable older release", () => {
  const blocked = { child: "marius-patrik/private-data", childRelease: { sha: NEW }, candidate: null, pointerState: "blocked", blockers: ["red"] };
  const released = {
    child: "marius-patrik/Other",
    childRelease: { sha: NEW },
    candidate: { pointerState: "released", releasedRecorded: false },
    pointerState: "released",
    blockers: []
  };
  const actionable = {
    child: "marius-patrik/DarkFactory",
    childRelease: { sha: NEW },
    candidate: { pointerState: "behind" },
    pointerState: "behind",
    blockers: []
  };
  assert.equal(submodules.selectSubmoduleScanObservation([blocked, released, actionable], policy), actionable);
});

test("scheduled recovery rotates away from the last recorded pending pointer plan", () => {
  const first = {
    child: "marius-patrik/Alpha",
    childRelease: { sha: NEW },
    candidate: { pointerState: "behind", trustedPull: { number: 1 }, lastPlanRecorded: true, lastPlanCreatedAt: 10 },
    pointerState: "behind",
    blockers: []
  };
  const second = {
    child: "marius-patrik/Beta",
    childRelease: { sha: NEW },
    candidate: { pointerState: "behind", trustedPull: { number: 2 }, lastPlanRecorded: false, lastPlanCreatedAt: Number.NaN },
    pointerState: "behind",
    blockers: []
  };
  assert.equal(submodules.selectSubmoduleScanObservation([first, second], policy), second);
});

test("scheduled scans surface a blocked lane when no actionable transition exists", () => {
  const blocked = {
    child: "marius-patrik/Alpha",
    childRelease: { sha: NEW },
    candidate: null,
    pointerState: "blocked",
    blockers: ["ambiguous-parent-consumers"]
  };
  const current = {
    child: "marius-patrik/Beta",
    childRelease: { sha: NEW },
    candidate: { pointerState: "current" },
    pointerState: "current",
    blockers: []
  };
  assert.equal(submodules.selectSubmoduleScanObservation([current, blocked], policy), blocked);
});

test("dashboard pointer receipts normalize pending, blocked, merged, and released states with exact links", () => {
  const base = {
    kind: "df-submodule-update",
    status: "waiting-for-validation",
    plan: { evidence: {
      parent: "marius-patrik/Andromeda",
      child: "marius-patrik/DarkFactory",
      path: "plugins/DarkFactory",
      dev_pointer: OLD,
      child_sha: NEW,
      receipt: "https://github.com/marius-patrik/DarkFactory/pull/100"
    } }
  };
  for (const [status, state] of [
    ["waiting-for-validation", "pending"],
    ["blocked", "blocked"],
    ["release-dispatched", "merged"],
    ["released", "released"]
  ]) {
    const normalized = orchestrator.submodulePointerStatusFromLedger(
      { ...base, status },
      "marius-patrik/Andromeda"
    );
    assert.equal(normalized.state, state);
    assert.match(normalized.pointerUrl, new RegExp(`${OLD}/plugins/DarkFactory$`));
    assert.match(normalized.childUrl, new RegExp(`${NEW}$`));
  }
  assert.equal(orchestrator.submodulePointerStatusFromLedger(base, "marius-patrik/Other"), null);

  const unresolved = orchestrator.submodulePointerStatusFromLedger({
    ...base,
    status: "blocked",
    plan: { evidence: {
      parent: null,
      child: "marius-patrik/DarkFactory",
      path: null,
      dev_pointer: null,
      child_sha: NEW,
      receipt: null
    } }
  }, "marius-patrik/DarkFactory");
  assert.equal(unresolved.state, "blocked");
  assert.equal(unresolved.parent, null);
  assert.equal(unresolved.path, null);
  assert.equal(unresolved.pointerUrl, null);
  assert.match(unresolved.childUrl, new RegExp(`${NEW}$`));

  assert.equal(orchestrator.submodulePointerStatusFromLedger({
    ...base,
    status: "blocked",
    plan: { evidence: {
      parent: null,
      child: "not a repository",
      path: null,
      dev_pointer: null,
      child_sha: "not-a-sha"
    } }
  }, "marius-patrik/DarkFactory"), null);
});

test("dashboard collection keeps an unresolved blocked receipt keyed by its child", async () => {
  const ledger = {
    kind: "df-submodule-update",
    status: "blocked",
    plan: { evidence: {
      parent: null,
      child: "marius-patrik/DarkFactory",
      path: null,
      dev_pointer: null,
      child_sha: NEW,
      receipt: null
    } }
  };
  const github = {
    async request(method: string, requestPath: string) {
      assert.equal(method, "GET");
      if (requestPath.endsWith("/contents/runs/marius-patrik/DarkFactory")) {
        return [{ type: "file", name: "2026-07-16T12-00-00-000Z-df-submodule-update.json" }];
      }
      if (requestPath.endsWith("/contents/runs/marius-patrik/DarkFactory/2026-07-16T12-00-00-000Z-df-submodule-update.json")) {
        return content(JSON.stringify(ledger));
      }
      throw new Error(`unexpected ${method} ${requestPath}`);
    }
  };
  const statuses = await orchestrator.collectSubmodulePointerStatuses(github, ["marius-patrik/DarkFactory"]);
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].state, "blocked");
  assert.equal(statuses[0].parent, null);
  assert.equal(statuses[0].child, "marius-patrik/DarkFactory");
});

test("latest pointer receipt falls back to the complete Git tree after the Contents limit", async () => {
  const oldName = "2026-07-15T08-00-00-000Z-df-submodule-update.json";
  const newName = "2026-07-15T09-00-00-000Z-df-submodule-update.json";
  const saturatedPage = Array.from({ length: 1_000 }, (_, index) => ({
    type: "file",
    name: index === 999 ? oldName : `2026-07-14T00-00-${String(index).padStart(4, "0")}-other.json`
  }));
  const trees: Record<string, any> = {
    main: { truncated: false, tree: [{ path: "runs", type: "tree", sha: "tree-runs" }] },
    "tree-runs": { truncated: false, tree: [{ path: "marius-patrik", type: "tree", sha: "tree-owner" }] },
    "tree-owner": { truncated: false, tree: [{ path: "Andromeda", type: "tree", sha: "tree-repo" }] },
    "tree-repo": { truncated: false, tree: [
      { path: oldName, type: "blob", sha: "old" },
      { path: newName, type: "blob", sha: "new" }
    ] }
  };
  const calls: string[] = [];
  const gh = {
    async request(_method: string, requestPath: string) {
      calls.push(requestPath);
      if (requestPath.endsWith("/contents/runs/marius-patrik/Andromeda")) return saturatedPage;
      if (requestPath.endsWith("/git/ref/heads/main")) return { object: { sha: "commit-main" } };
      if (requestPath.endsWith("/git/commits/commit-main")) return { tree: { sha: "main" } };
      const tree = requestPath.match(/\/git\/trees\/([^/?]+)$/)?.[1];
      if (tree && trees[decodeURIComponent(tree)]) return trees[decodeURIComponent(tree)];
      if (requestPath.endsWith(`/contents/runs/marius-patrik/Andromeda/${newName}`)) {
        return content(JSON.stringify({ kind: "df-submodule-update", status: "released", marker: "complete-tree" }));
      }
      throw new Error(`unexpected GET ${requestPath}`);
    }
  };
  const ledger = await dfLib.readLatestRunLedger(
    gh,
    "marius-patrik/darkfactory-data",
    "df-submodule-update",
    "marius-patrik/Andromeda"
  );
  assert.equal(ledger.marker, "complete-tree");
  assert.ok(calls.some((requestPath) => requestPath.endsWith("/git/ref/heads/main")));
  assert.ok(calls.some((requestPath) => requestPath.endsWith("/git/trees/main")));
  assert.ok(calls.some((requestPath) => requestPath.endsWith(`/contents/runs/marius-patrik/Andromeda/${newName}`)));
});

test("latest pointer receipt fails closed when complete Git tree evidence is truncated", async () => {
  const saturatedPage = Array.from({ length: 1_000 }, (_, index) => ({
    type: "file",
    name: `2026-07-14T00-00-${String(index).padStart(4, "0")}-other.json`
  }));
  const gh = {
    async request(_method: string, requestPath: string) {
      if (requestPath.endsWith("/contents/runs/marius-patrik/Andromeda")) return saturatedPage;
      if (requestPath.endsWith("/git/ref/heads/main")) return { object: { sha: "commit-main" } };
      if (requestPath.endsWith("/git/commits/commit-main")) return { tree: { sha: "main" } };
      if (requestPath.endsWith("/git/trees/main")) return { truncated: true, tree: [] };
      throw new Error(`unexpected GET ${requestPath}`);
    }
  };
  await assert.rejects(
    dfLib.readLatestRunLedger(
      gh,
      "marius-patrik/darkfactory-data",
      "df-submodule-update",
      "marius-patrik/Andromeda"
    ),
    /ledger tree evidence is truncated or malformed at runs/
  );
});

test("release receipt admits exact commit identity and targets the released main SHA", () => {
  const valid = submodules.validateReleaseReceipt(releaseReceipt(), CHILD, policy, Date.parse("2026-07-15T09:00:00Z"));
  assert.equal(valid.sha, NEW);
  assert.deepEqual(valid.blockers, []);
});

test("release receipt admits distinct commits only when their exact trees converge", () => {
  const converged = submodules.validateReleaseReceipt(releaseReceipt({
    main_sha: OLD,
    dev_sha: NEW,
    main_tree_sha: TREE,
    dev_tree_sha: TREE
  }), CHILD, policy, Date.parse("2026-07-15T09:00:00Z"));
  assert.equal(converged.sha, OLD);
  assert.deepEqual(converged.blockers, []);
});

test("canonical Fabrica observes its released default dev commit without weakening main-tracked children", async () => {
  const selected = submodules.validateReleaseReceipt(releaseReceipt({
    target_repo: "marius-patrik/Fabrica",
    repository: "marius-patrik/Fabrica",
    main_sha: OLD,
    dev_sha: NEW,
    release: {
      ...releaseReceipt().release,
      pull_request: "https://github.com/marius-patrik/Fabrica/pull/100"
    }
  }), { owner: "marius-patrik", repo: "Fabrica" }, policy, Date.parse("2026-07-15T09:00:00Z"));
  assert.equal(selected.branch, "dev");
  assert.equal(selected.sha, NEW);

  const { calls } = fabricaObservationRuntime();
  const observation = await submodules.observeChildRelease({ owner: "marius-patrik", repo: "Fabrica" }, policy);
  assert.equal(observation.branch, "dev");
  assert.equal(observation.sha, NEW);
  assert.deepEqual(observation.blockers, []);
  assert.equal(calls.some((call) => call.path === "/repos/marius-patrik/Fabrica/commits/main"), false);
  assert.equal(submodules.releasedBranchForChild(CHILD, policy), "main");
});

test("canonical Fabrica blocks when repository default disagrees with its exact dev policy", async () => {
  fabricaObservationRuntime("main");
  const observation = await submodules.observeChildRelease({ owner: "marius-patrik", repo: "Fabrica" }, policy);
  assert.ok(observation.blockers.includes("child-default-branch-not-dev:main"));
});

test("release receipt rejects unequal or malformed tree evidence for distinct commits", () => {
  for (const [label, trees] of [
    ["unequal", { main_tree_sha: TREE, dev_tree_sha: "6".repeat(40) }],
    ["malformed", { main_tree_sha: TREE, dev_tree_sha: "not-a-tree" }]
  ] as const) {
    const denied = submodules.validateReleaseReceipt(releaseReceipt({
      main_sha: OLD,
      dev_sha: NEW,
      ...trees
    }), CHILD, policy, Date.parse("2026-07-15T09:00:00Z"));
    assert.ok(denied.blockers.includes("child-release-receipt-sha-invalid"), label);
  }
});

test("release receipt still requires exact repository, green App-bound gates, and publication", () => {

  const malformed = releaseReceipt({
    main_sha: OLD,
    dev_sha: NEW,
    main_tree_sha: TREE,
    dev_tree_sha: "6".repeat(40),
    release: { ...releaseReceipt().release, checks: { green: true, checks: [{ name: "Validate", expectedAppId: 15368, actualAppId: 1, state: "green" }] } }
  });
  const denied = submodules.validateReleaseReceipt(malformed, CHILD, policy, Date.parse("2026-07-15T09:00:00Z"));
  assert.ok(denied.blockers.includes("child-release-receipt-sha-invalid"));
  assert.ok(denied.blockers.some((item: string) => item.includes("DarkFactory Autoreview")));
});

test("current released pointer is a released no-op and child dev never influences the target", async () => {
  const { calls } = observationRuntime({ mainPointer: NEW, devPointer: NEW, relation: { status: "identical", ahead_by: 0, behind_by: 0 } });
  const observation = await submodules.observeSubmoduleUpdate({ child: "marius-patrik/DarkFactory", policy });
  const plan = submodules.buildSubmodulePlan(observation, policy);
  assert.equal(observation.pointerState, "released");
  assert.equal(plan.action, "released");
  assert.equal(calls.some((call) => /DarkFactory\/commits\/dev/.test(call.path)), false);
});

test("an exact released completion receipt makes later recovery scans current", async () => {
  observationRuntime({ mainPointer: NEW, devPointer: NEW, relation: { status: "identical", ahead_by: 0, behind_by: 0 } });
  const first = await submodules.observeSubmoduleUpdate({ child: "marius-patrik/DarkFactory", policy });
  const firstPlan = submodules.buildSubmodulePlan(first, policy);
  assert.equal(firstPlan.action, "released");

  observationRuntime({
    mainPointer: NEW,
    devPointer: NEW,
    relation: { status: "identical", ahead_by: 0, behind_by: 0 },
    pointerLedger: { kind: "df-submodule-update", status: "released", plan: { planId: firstPlan.planId } }
  });
  const repeated = await submodules.observeSubmoduleUpdate({ child: "marius-patrik/DarkFactory", policy });
  assert.equal(submodules.buildSubmodulePlan(repeated, policy).action, "current");
});

test("behind released head produces one exact update plan with ancestry evidence", async () => {
  observationRuntime();
  const observation = await submodules.observeSubmoduleUpdate({ child: "marius-patrik/DarkFactory", policy });
  const plan = submodules.buildSubmodulePlan(observation, policy);
  assert.equal(plan.action, "update");
  assert.equal(plan.evidence.path, "plugins/DarkFactory");
  assert.equal(plan.evidence.dev_pointer, OLD);
  assert.equal(plan.evidence.child_sha, NEW);
  assert.match(observation.candidate.evidence.ancestry, new RegExp(`${OLD}\.\.\.${NEW}`));
});

test("public and durable plan output summarizes private ancestry without compare patches or commit payloads", async () => {
  observationRuntime({ relation: {
    status: "ahead", ahead_by: 2, behind_by: 0,
    commits: [{ sha: NEW, secret: "private-commit-payload" }],
    files: [{ filename: "runs/private.json", patch: "private-ledger-patch" }]
  } });
  const result = await submodules.runSubmoduleCommand({ mode: "plan", child: "marius-patrik/DarkFactory" });
  assert.deepEqual(result.observation.parent.relation, { status: "ahead", ahead_by: 2, behind_by: 0 });
  assert.doesNotMatch(JSON.stringify(result), /private-commit-payload|private-ledger-patch/);
});

test("verify is observation-only and never writes target or ledger state", async () => {
  const { calls } = observationRuntime();
  const result = await submodules.runSubmoduleCommand({ mode: "verify", child: "marius-patrik/DarkFactory" });
  assert.equal(result.mode, "verify");
  assert.equal(result.status, "blocked");
  assert.equal(result.receipt.kind, "submodule-verification");
  assert.equal(result.receipt.verified, false);
  assert.equal(calls.some((call) => ["POST", "PATCH", "PUT", "DELETE"].includes(call.method)), false);
});

test("merged dev pointer with unchanged main dispatches the parent release lane", async () => {
  observationRuntime({ mainPointer: OLD, devPointer: NEW, relation: { status: "identical", ahead_by: 0, behind_by: 0 } });
  const observation = await submodules.observeSubmoduleUpdate({ child: "marius-patrik/DarkFactory", policy });
  assert.equal(observation.pointerState, "merged");
  assert.equal(submodules.buildSubmodulePlan(observation, policy).action, "release-parent");
});

test("non-ancestor rewrite and inaccessible private child block closed", async () => {
  observationRuntime({ relation: { status: "diverged", ahead_by: 2, behind_by: 1 } });
  const rewritten = await submodules.observeSubmoduleUpdate({ child: "marius-patrik/DarkFactory", policy });
  assert.ok(rewritten.blockers.some((item: string) => item.startsWith("child-history-not-forward")));
  assert.equal(submodules.buildSubmodulePlan(rewritten, policy).action, "block");

  observationRuntime({ childInaccessible: true, receipt: null });
  const inaccessible = await submodules.observeSubmoduleUpdate({ child: "marius-patrik/DarkFactory", policy });
  assert.ok(inaccessible.blockers.includes("child-inaccessible"));
  assert.equal(submodules.buildSubmodulePlan(inaccessible, policy).action, "block");
});

test("missing or renamed canonical gitlinks block the entire root before mutation", async () => {
  const missing = andromedaModules().replace(/\[submodule "DarkFactory"\][\s\S]*?branch = main\n/, "");
  observationRuntime({ modules: missing });
  const observation = await submodules.observeSubmoduleUpdate({ child: "marius-patrik/DarkFactory", policy });
  assert.ok(observation.blockers.some((item: string) => item === "no-active-parent-consumer:marius-patrik/DarkFactory" || item.includes("canonical-andromeda")));

  const renamed = andromedaModules().replace('[submodule "data"]', '[submodule "agent-os"]');
  observationRuntime({ modules: renamed });
  const renamedObservation = await submodules.observeSubmoduleUpdate({ child: "marius-patrik/DarkFactory", policy });
  assert.ok(renamedObservation.blockers.includes("canonical-andromeda-gitlink-invalid:data/andromeda"));
});

test("an unexpected gitlink on dev blocks the entire canonical root before mutation", async () => {
  const unexpected = `${andromedaModules()}\n[submodule "Memory"]\n path = plugins/Memory\n url = https://github.com/marius-patrik/Memory.git\n branch = main\n`;
  observationRuntime({ devModules: unexpected });
  const observation = await submodules.observeSubmoduleUpdate({ child: "marius-patrik/DarkFactory", policy });
  assert.ok(observation.blockers.includes("unexpected-andromeda-gitlink:plugins/Memory"));
  assert.equal(submodules.buildSubmodulePlan(observation, policy).action, "block");
});

test("duplicate trusted or untrusted pointer PRs block instead of overwriting", async () => {
  observationRuntime();
  const baseline = await submodules.observeSubmoduleUpdate({ child: "marius-patrik/DarkFactory", policy });
  const exactPlan = submodules.buildSubmodulePlan(baseline, policy);
  const makePull = (number: number, actor = "darkfactory-agent[bot]") => ({
    number,
    state: "open",
    body: `<!-- darkfactory:submodule-update plan=${exactPlan.planId} parent=${PARENT_SHA} child=marius-patrik/DarkFactory old=${OLD} new=${NEW} path=plugins/DarkFactory head=${POINTER_HEAD} -->`,
    user: { type: "Bot", login: actor },
    base: { ref: "dev" },
    head: { ref: `submodule-update/marius-patrik-darkfactory-${NEW.slice(0, 12)}`, sha: POINTER_HEAD, repo: { full_name: "marius-patrik/Andromeda" } }
  });
  const pulls = [makePull(1), makePull(2)];
  observationRuntime({
    pulls,
    pullDetails: { 1: pulls[0], 2: pulls[1] },
    pullFiles: { 1: [{ filename: "plugins/DarkFactory" }], 2: [{ filename: "plugins/DarkFactory" }] }
  });
  const duplicate = await submodules.observeSubmoduleUpdate({ child: "marius-patrik/DarkFactory", policy });
  assert.ok(duplicate.blockers.includes("duplicate-trusted-pointer-prs"));
  assert.equal(submodules.buildSubmodulePlan(duplicate, policy).action, "block");

  const untrusted = makePull(3, "github-actions[bot]");
  observationRuntime({ pulls: [untrusted], pullDetails: { 3: untrusted }, pullFiles: { 3: [{ filename: "plugins/DarkFactory" }] } });
  const spoofed = await submodules.observeSubmoduleUpdate({ child: "marius-patrik/DarkFactory", policy });
  assert.ok(spoofed.blockers.includes("competing-or-untrusted-pointer-pr:3"));
});

test("exact App-owned pointer PR reconciles a parent dev base advance through one non-force recovery", async () => {
  const fixture = baseAdvanceRecoveryRuntime();
  const observation = await submodules.observeSubmoduleUpdate({ child: "marius-patrik/DarkFactory", policy });
  const plan = submodules.buildSubmodulePlan(observation, policy);
  assert.deepEqual(observation.blockers, []);
  assert.equal(plan.planId, fixture.currentPlan.planId);
  assert.equal(plan.action, "update");
  assert.equal(observation.candidate.trustedPull, null);
  assert.equal(observation.candidate.recoverablePull.state, "stale-base");

  const result = await submodules.ensureSubmoduleUpdatePull(observation, plan);
  assert.equal(result.status, "waiting-for-validation");
  assert.equal(result.pull_number, 210);
  assert.equal(result.head_sha, RECOVERY_HEAD);
  const refUpdates = fixture.calls.filter((call) => call.method === "PATCH" && call.path.includes("/git/refs/"));
  assert.equal(refUpdates.length, 1);
  assert.equal(refUpdates[0].body.force, false);
  assert.equal(fixture.calls.some((call) => call.method === "POST" && call.path.endsWith("/pulls")), false);
  assert.equal(fixture.calls.filter((call) => call.method === "PATCH" && call.path.endsWith("/pulls/210")).length, 1);
  assert.match(fixture.pull().body, new RegExp(`parent=${ADVANCED_PARENT}.*head=${RECOVERY_HEAD}`));
});

test("interrupted pointer recovery resumes only the exact stale provenance update", async () => {
  const fixture = baseAdvanceRecoveryRuntime({ interrupted: true });
  const observation = await submodules.observeSubmoduleUpdate({ child: "marius-patrik/DarkFactory", policy });
  const plan = submodules.buildSubmodulePlan(observation, policy);
  assert.deepEqual(observation.blockers, []);
  assert.equal(observation.candidate.recoverablePull.state, "interrupted-provenance");

  const result = await submodules.ensureSubmoduleUpdatePull(observation, plan);
  assert.equal(result.head_sha, RECOVERY_HEAD);
  assert.equal(fixture.calls.some((call) => call.method === "POST" && ["/git/trees", "/git/commits"].some((suffix) => call.path.endsWith(suffix))), false);
  assert.equal(fixture.calls.some((call) => call.method === "PATCH" && call.path.includes("/git/refs/")), false);
  assert.equal(fixture.calls.filter((call) => call.method === "PATCH" && call.path.endsWith("/pulls/210")).length, 1);
});

test("unknown stale pointer work and non-force ref conflicts remain preserved and blocked", async () => {
  const unknown = baseAdvanceRecoveryRuntime({ tamperedOldCommit: true });
  const deniedObservation = await submodules.observeSubmoduleUpdate({ child: "marius-patrik/DarkFactory", policy });
  assert.ok(deniedObservation.blockers.includes("competing-or-untrusted-pointer-pr:210"));
  assert.equal(submodules.buildSubmodulePlan(deniedObservation, policy).action, "block");
  assert.equal(unknown.calls.some((call) => ["POST", "PATCH"].includes(call.method)), false);

  const conflict = baseAdvanceRecoveryRuntime({ refConflict: true });
  const admitted = await submodules.observeSubmoduleUpdate({ child: "marius-patrik/DarkFactory", policy });
  const plan = submodules.buildSubmodulePlan(admitted, policy);
  await assert.rejects(() => submodules.ensureSubmoduleUpdatePull(admitted, plan), /base-advance update conflicted/);
  const attempted = conflict.calls.find((call) => call.method === "PATCH" && call.path.includes("/git/refs/"));
  assert.equal(attempted.body.force, false);
  assert.equal(conflict.calls.some((call) => call.method === "PATCH" && call.path.endsWith("/pulls/210")), false);

  const drift = baseAdvanceRecoveryRuntime({ bodyDrift: true });
  const driftObservation = await submodules.observeSubmoduleUpdate({ child: "marius-patrik/DarkFactory", policy });
  const driftPlan = submodules.buildSubmodulePlan(driftObservation, policy);
  await assert.rejects(() => submodules.ensureSubmoduleUpdatePull(driftObservation, driftPlan), /body changed before provenance update/);
  assert.match(drift.pull().body, /Owner note that must be preserved/);
  assert.equal(drift.calls.some((call) => call.method === "PATCH" && call.path.endsWith("/pulls/210")), false);
});

test("parked children remain categorically non-mutating even with receipt-shaped evidence", async () => {
  observationRuntime();
  const observation = await submodules.observeSubmoduleUpdate({ child: "marius-patrik/Singularity", policy });
  assert.ok(observation.blockers.includes("parked-child:marius-patrik/Singularity"));
  assert.equal(submodules.buildSubmodulePlan(observation, policy).action, "block");
});

test("a downstream umbrella consumes the released parent through the same generic plan", async () => {
  const umbrella = { owner: "marius-patrik", repo: "Umbrella" };
  const child = { owner: "marius-patrik", repo: "Andromeda" };
  const genericModules = '[submodule "Andromeda"]\n path = products/Andromeda\n url = https://github.com/marius-patrik/Andromeda.git\n branch = main\n';
  const genericReceipt = releaseReceipt({
    target_repo: "marius-patrik/Andromeda",
    repository: "marius-patrik/Andromeda",
    release: { ...releaseReceipt().release, pull_request: "https://github.com/marius-patrik/Andromeda/pull/101" }
  });
  const calls: string[] = [];
  const gh = {
    async request(method: string, requestPath: string) {
      calls.push(requestPath);
      if (requestPath === "/repos/marius-patrik/Andromeda") return { default_branch: "main", archived: false, disabled: false };
      if (requestPath === "/repos/marius-patrik/Andromeda/commits/main") return { sha: NEW };
      if (requestPath === "/repos/marius-patrik/Andromeda/branches/main/protection") return protectedBranch();
      if (requestPath.includes("Andromeda/contents/.agents/release-policy.json")) return content(JSON.stringify(releasePolicy()));
      if (requestPath.includes(`Andromeda/commits/${NEW}/check-runs`)) return { check_runs: [{ name: "Validate", status: "completed", conclusion: "success", id: 1, html_url: "https://github.com/checks/1", app: { id: 15368 } }] };
      if (requestPath.endsWith(`/Andromeda/commits/${NEW}/status`)) return { statuses: [] };
      if (requestPath.endsWith("darkfactory-data/contents/runs/marius-patrik/Andromeda")) return [{ type: "file", name: "2026-df-release.json" }];
      if (requestPath.includes("darkfactory-data/contents/runs/marius-patrik/Andromeda/2026")) return content(JSON.stringify(genericReceipt));
      if (requestPath === "/repos/marius-patrik/Umbrella") return { default_branch: "main", allow_auto_merge: true, delete_branch_on_merge: true };
      if (requestPath.includes("Umbrella/git/ref/heads/")) return { object: { sha: PARENT_SHA } };
      if (requestPath.includes(`Umbrella/compare/${PARENT_SHA}...${PARENT_SHA}`)) return { status: "identical", ahead_by: 0, behind_by: 0 };
      if (requestPath.includes("Umbrella/contents/.gitmodules")) return content(genericModules);
      if (requestPath.includes("Umbrella/contents/products/Andromeda")) return { type: "submodule", sha: OLD };
      if (requestPath === `/repos/marius-patrik/Andromeda/compare/${OLD}...${NEW}`) return { status: "ahead", ahead_by: 1, behind_by: 0 };
      if (requestPath === "/repos/marius-patrik/Umbrella/branches/dev/protection") return protectedBranch();
      if (requestPath.includes("Umbrella/contents/.agents/release-policy.json")) return content(JSON.stringify(releasePolicy()));
      if (requestPath.includes("Umbrella/pulls?state=open")) return [];
      if (requestPath.endsWith("darkfactory-data/contents/runs/marius-patrik/Umbrella")) return [];
      throw new Error(`unexpected ${method} ${requestPath}`);
    }
  };
  submodules.configureSubmoduleRuntime({ gh, ledgerGh: gh, controlRepo: CHILD, parents: [umbrella], policy, now: Date.parse("2026-07-15T09:00:00Z") });
  const observation = await submodules.observeSubmoduleUpdate({ child: "marius-patrik/Andromeda", policy });
  const plan = submodules.buildSubmodulePlan(observation, policy);
  assert.equal(plan.action, "update");
  assert.equal(plan.evidence.path, "products/Andromeda");
  assert.ok(calls.some((item) => item.includes("runs/marius-patrik/Andromeda")));
});

test("local dirty or mismatched state blocks without exposing the checkout path", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "df-submodule-local-"));
  try {
    await mkdir(root, { recursive: true });
    execFileSync("git", ["init"], { cwd: root, stdio: "pipe" });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/marius-patrik/Andromeda.git"], { cwd: root, stdio: "pipe" });
    await writeFile(path.join(root, "dirty.txt"), "dirty\n");
    const evidence = submodules.inspectLocalCheckout(root, "marius-patrik/Andromeda");
    assert.equal(evidence.clean, false);
    assert.ok(evidence.blockers.includes("local-parent-dirty"));
    assert.doesNotMatch(JSON.stringify(evidence), /df-submodule-local|patrik/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("least-privilege checkout validator covers success, malformed recursion, and denied pointer", () => {
  const responses = new Map([
    ["remote get-url origin", { ok: true, stdout: "https://github.com/marius-patrik/Andromeda.git\n" }],
    ["rev-parse HEAD", { ok: true, stdout: `${POINTER_HEAD}\n` }],
    ["ls-tree HEAD -- plugins/DarkFactory", { ok: true, stdout: `160000 commit ${NEW}\tplugins/DarkFactory\n` }],
    ["status --porcelain=v2 --untracked-files=all", { ok: true, stdout: "" }],
    ["submodule status --recursive", { ok: true, stdout: ` ${NEW} plugins/DarkFactory (heads/main)\n` }]
  ]);
  const input = { checkout: ".", repository: "marius-patrik/Andromeda", headSha: POINTER_HEAD, gitlinkPath: "plugins/DarkFactory", childSha: NEW };
  const run = (_cwd: string, args: string[]) => responses.get(args.join(" "));
  assert.equal(checkout.validateCheckoutEvidence(input, run).executed_child_code, false);

  const malformedRun = (_cwd: string, args: string[]) => args[0] === "submodule"
    ? { ok: true, stdout: `-${NEW} plugins/DarkFactory\n` }
    : responses.get(args.join(" "));
  assert.throws(() => checkout.validateCheckoutEvidence(input, malformedRun), /uninitialized, divergent, or conflicted/);

  assert.throws(() => checkout.validateCheckoutEvidence({ ...input, childSha: OLD }, run), /exact released child gitlink/);
});

test("trusted pointer PR identity rejects near-miss actors, stale bases, and rewritten heads", () => {
  const marker = `<!-- darkfactory:submodule-update plan=submodule-${"a".repeat(20)} parent=${PARENT_SHA} child=marius-patrik/DarkFactory old=${OLD} new=${NEW} path=plugins/DarkFactory head=${POINTER_HEAD} -->`;
  const pull = {
    body: marker,
    user: { type: "Bot", login: "darkfactory-agent[bot]" },
    base: { ref: "dev" },
    head: { ref: `submodule-update/marius-patrik-darkfactory-${NEW.slice(0, 12)}`, sha: POINTER_HEAD, repo: { full_name: "marius-patrik/Andromeda" } }
  };
  const expected = { path: "plugins/DarkFactory", child: "marius-patrik/DarkFactory", releasedSha: NEW, oldSha: OLD, parentSha: PARENT_SHA, headSha: POINTER_HEAD, policy };
  assert.equal(submodules.isTrustedPointerPull(PARENT, pull, expected), true);
  assert.equal(submodules.isTrustedPointerPull(PARENT, { ...pull, user: { type: "Bot", login: "github-actions[bot]" } }, expected), false);
  assert.equal(submodules.isTrustedPointerPull(PARENT, pull, { ...expected, parentSha: OLD }), false);
  assert.equal(submodules.isTrustedPointerPull(PARENT, { ...pull, head: { ...pull.head, sha: OLD } }, expected), false);
});

test("update creates one App-owned one-gitlink commit and PR without protected-ref writes", async () => {
  observationRuntime();
  const observation = await submodules.observeSubmoduleUpdate({ child: "marius-patrik/DarkFactory", policy });
  const plan = submodules.buildSubmodulePlan(observation, policy);
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const message = `Update plugins/DarkFactory to ${NEW}\n\nDarkFactory-Submodule-Plan: ${plan.planId}`;
  const gh = {
    async request(method: string, requestPath: string, body?: any) {
      calls.push({ method, path: requestPath, body });
      if (requestPath === "/repos/marius-patrik/Andromeda/git/ref/heads/main"
          || requestPath === "/repos/marius-patrik/Andromeda/git/ref/heads/dev") return { object: { sha: PARENT_SHA } };
      if (requestPath.includes("/git/ref/heads/submodule-update%2F")) throw apiError(404);
      if (requestPath.includes("/contents/plugins/DarkFactory?ref=main") || requestPath.includes("/contents/plugins/DarkFactory?ref=dev")) return { type: "submodule", sha: OLD };
      if (requestPath.includes(`/contents/plugins/DarkFactory?ref=${POINTER_HEAD}`)) return { type: "submodule", sha: NEW };
      if (requestPath === "/repos/marius-patrik/DarkFactory/commits/main") return { sha: NEW };
      if (requestPath === `/repos/marius-patrik/Andromeda/git/commits/${PARENT_SHA}`) return { tree: { sha: TREE } };
      if (method === "POST" && requestPath.endsWith("/git/trees")) {
        assert.deepEqual(body.tree, [{ path: "plugins/DarkFactory", mode: "160000", type: "commit", sha: NEW }]);
        return { sha: "6".repeat(40) };
      }
      if (method === "POST" && requestPath.endsWith("/git/commits")) {
        assert.deepEqual(body.parents, [PARENT_SHA]);
        assert.equal(body.message, message);
        return { sha: POINTER_HEAD };
      }
      if (method === "POST" && requestPath.endsWith("/git/refs")) {
        assert.equal(body.ref, `refs/heads/${plan.branch}`);
        return {};
      }
      if (requestPath === `/repos/marius-patrik/Andromeda/commits/${POINTER_HEAD}`) return { author: { type: "Bot", login: "darkfactory-agent[bot]" } };
      if (requestPath === `/repos/marius-patrik/Andromeda/git/commits/${POINTER_HEAD}`) return { message, parents: [{ sha: PARENT_SHA }] };
      if (requestPath === `/repos/marius-patrik/Andromeda/compare/${PARENT_SHA}...${POINTER_HEAD}`) {
        return { status: "ahead", ahead_by: 1, behind_by: 0, files: [{ filename: "plugins/DarkFactory", status: "modified" }] };
      }
      if (method === "POST" && requestPath.endsWith("/pulls")) {
        return {
          number: 200,
          html_url: "https://github.com/marius-patrik/Andromeda/pull/200",
          body: body.body,
          user: { type: "Bot", login: "darkfactory-agent[bot]" },
          base: { ref: "dev" },
          head: { ref: plan.branch, sha: POINTER_HEAD, repo: { full_name: "marius-patrik/Andromeda" } }
        };
      }
      throw new Error(`unexpected ${method} ${requestPath}`);
    }
  };
  submodules.configureSubmoduleRuntime({ gh, ledgerGh: gh, controlRepo: CHILD, policy });
  const result = await submodules.ensureSubmoduleUpdatePull(observation, plan);
  assert.equal(result.status, "waiting-for-validation");
  assert.equal(result.pull_request, "https://github.com/marius-patrik/Andromeda/pull/200");
  assert.equal(calls.some((call) => /refs\/heads\/(?:main|dev)$/.test(String(call.body?.ref || ""))), false);
  assert.equal(calls.some((call) => call.method === "DELETE" || (call.method === "PATCH" && call.path.includes("/git/refs"))), false);
});

test("finalization binds the read-only run and current App gates before automerge", async () => {
  observationRuntime();
  const observation = await submodules.observeSubmoduleUpdate({ child: "marius-patrik/DarkFactory", policy });
  const plan = submodules.buildSubmodulePlan(observation, policy);
  const message = `Update plugins/DarkFactory to ${NEW}\n\nDarkFactory-Submodule-Plan: ${plan.planId}`;
  const body = `<!-- darkfactory:submodule-update plan=${plan.planId} parent=${PARENT_SHA} child=marius-patrik/DarkFactory old=${OLD} new=${NEW} path=plugins/DarkFactory head=${POINTER_HEAD} -->`;
  const pull = {
    number: 201,
    node_id: "PR_201",
    html_url: "https://github.com/marius-patrik/Andromeda/pull/201",
    state: "open",
    draft: false,
    body,
    user: { type: "Bot", login: "darkfactory-agent[bot]" },
    base: { ref: "dev" },
    head: { ref: plan.branch, sha: POINTER_HEAD, repo: { full_name: "marius-patrik/Andromeda" } }
  };
  observation.candidate.trustedPull = pull;
  const graphqlCalls: any[] = [];
  const gh = {
    async request(method: string, requestPath: string) {
      if (requestPath === "/repos/marius-patrik/Andromeda/git/ref/heads/main"
          || requestPath === "/repos/marius-patrik/Andromeda/git/ref/heads/dev") return { object: { sha: PARENT_SHA } };
      if (requestPath.includes("/contents/plugins/DarkFactory?ref=main") || requestPath.includes("/contents/plugins/DarkFactory?ref=dev")) return { type: "submodule", sha: OLD };
      if (requestPath.includes(`/contents/plugins/DarkFactory?ref=${POINTER_HEAD}`)) return { type: "submodule", sha: NEW };
      if (requestPath === "/repos/marius-patrik/DarkFactory/commits/main") return { sha: NEW };
      if (requestPath === `/repos/marius-patrik/Andromeda/commits/${POINTER_HEAD}`) return { author: { type: "Bot", login: "darkfactory-agent[bot]" } };
      if (requestPath === `/repos/marius-patrik/Andromeda/git/commits/${POINTER_HEAD}`) return { message, parents: [{ sha: PARENT_SHA }] };
      if (requestPath === `/repos/marius-patrik/Andromeda/compare/${PARENT_SHA}...${POINTER_HEAD}`) return { status: "ahead", ahead_by: 1, behind_by: 0, files: [{ filename: "plugins/DarkFactory" }] };
      if (requestPath === "/repos/marius-patrik/Andromeda/pulls/201") return pull;
      if (requestPath === "/repos/marius-patrik/Andromeda/branches/dev/protection") return protectedBranch();
      if (requestPath.includes(`/commits/${POINTER_HEAD}/check-runs`)) return { check_runs: [
        { name: "Validate", status: "completed", conclusion: "success", id: 1, html_url: "https://github.com/checks/1", app: { id: 15368 } },
        { name: "DarkFactory Autoreview", status: "completed", conclusion: "success", id: 2, html_url: "https://github.com/checks/2", app: { id: 15368 } }
      ] };
      if (requestPath.endsWith(`/commits/${POINTER_HEAD}/status`)) return { statuses: [] };
      throw new Error(`unexpected ${method} ${requestPath}`);
    },
    async graphql(query: string, variables: any) {
      graphqlCalls.push({ query, variables });
      return { enablePullRequestAutoMerge: { pullRequest: { url: pull.html_url } } };
    }
  };
  submodules.configureSubmoduleRuntime({ gh, ledgerGh: gh, controlRepo: CHILD, policy });
  const result = await submodules.finalizeSubmoduleUpdate(observation, plan, {
    headSha: POINTER_HEAD,
    runUrl: "https://github.com/marius-patrik/DarkFactory/actions/runs/999"
  });
  assert.equal(result.status, "automerge-armed");
  assert.equal(result.checks.green, true);
  assert.equal(graphqlCalls.length, 1);
  assert.equal(graphqlCalls[0].variables.pullRequestId, "PR_201");
});

test("managed workflow keeps trusted planning, mutation, and validation authorities separate", async () => {
  const workflow = await readFile(new URL("../.github/workflows/df-submodule-autoupdate.yml", import.meta.url), "utf8");
  const source = await readFile(new URL("../../../scripts/df-submodule-autoupdate.mjs", import.meta.url), "utf8");
  const manifest = JSON.parse(await readFile(new URL("../.agents/managed-repository.json", import.meta.url), "utf8"));
  const installer = JSON.parse(await readFile(new URL("../.agents/installer-policy.json", import.meta.url), "utf8"));
  const trigger = JSON.parse(await readFile(new URL("../.agents/trigger-policy.json", import.meta.url), "utf8"));
  assert.match(workflow, /repository_dispatch:[\s\S]+darkfactory-release-verified/);
  assert.match(workflow, /schedule:[\s\S]+29 \*\/2 \* \* \*/);
  assert.match(workflow, /Least-privilege recursive pointer validation/);
  assert.match(workflow, /permission-contents:\s+read/);
  assert.match(workflow, /persist-credentials:\s+false/);
  assert.match(workflow, /node control\/\.github\/scripts\/df-submodule-checkout\.mjs/);
  assert.match(workflow, /DF_SUBMODULE_MODE:\s+update[\s\S]+DF_SUBMODULE_VALIDATION_SHA/);
  assert.doesNotMatch(workflow, /DF_SUBMODULE_MODE:\s+verify/);
  assert.match(workflow, /needs\.plan\.outputs\.action != 'current'/);
  assert.doesNotMatch(workflow, /needs\.plan\.outputs\.action != 'block'/);
  assert.doesNotMatch(workflow, /npm (?:ci|test|run)|bun |python |go test/);
  assert.doesNotMatch(source, /git\/refs\/heads\/(?:main|dev)|force\s*:\s*true|"DELETE"/);
  assert.equal(manifest.dataRepo, "marius-patrik/private-data");
  assert.equal(manifest.ledgerRepo, "marius-patrik/darkfactory-data");
  assert.equal(installer.autoUpdater.source, "marius-patrik/private-data");
  assert.equal(installer.autoUpdater.ledger, "marius-patrik/darkfactory-data");
  assert.equal(dfLib.DARK_FACTORY_DATA_REPO, "marius-patrik/darkfactory-data");
  for (const managed of [
    ".agents/data-repository-policy.json",
    ".agents/submodule-policy.json",
    ".github/workflows/df-submodule-autoupdate.yml",
    ".github/scripts/df-submodule-autoupdate.mjs",
    ".github/scripts/df-submodule-checkout.mjs"
  ]) {
    assert.ok(manifest.packageFiles.includes(managed), managed);
    assert.ok(manifest.requiredFiles.includes(managed), managed);
  }
  assert.equal(trigger.loops.find((item: any) => item.id === "submodule-autoupdate").status, "active");
});
