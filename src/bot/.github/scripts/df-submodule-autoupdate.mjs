import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DARK_FACTORY_DATA_REPO,
  createGithubClient,
  getOptionalFileContent,
  isParkedRepo,
  listActiveManagedRepos,
  normalizeWorkerPullRequestActor,
  parseRepo,
  readLatestRunLedger,
  readManagedRepoRegistry,
  repoName,
  requiredEnv,
  slug,
  writeRunLedger
} from "./df-lib.mjs";
import { evaluateRequiredChecks, validateReleasePolicy } from "./df-release.mjs";

export const SUBMODULE_POLICY_PATH = ".darkfactory/submodule-policy.json";
export const SUBMODULE_MODES = new Set(["status", "plan", "update", "verify"]);
export const TRUSTED_GATE_APP_ID = 15368;
const MAX_PAGINATION_PAGES = 100;
const POLICY_FILE = fileURLToPath(new URL(`../../${SUBMODULE_POLICY_PATH}`, import.meta.url));

class PointerTrustViolation extends Error {}

let gh;
let ledgerGh;
let controlRepo;
let runtimeOptions = {};

export function configureSubmoduleRuntime(options) {
  gh = options.gh;
  ledgerGh = options.ledgerGh || options.gh;
  controlRepo = options.controlRepo || { owner: "marius-patrik", repo: "DarkFactory" };
  runtimeOptions = options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const secrets = [process.env.DARK_FACTORY_TOKEN, process.env.DF_LEDGER_TOKEN].filter(Boolean);
    let message = String(error.stack || error.message || error);
    for (const secret of secrets) message = message.split(secret).join("***");
    console.error(message);
    process.exitCode = 1;
  });
}

async function main() {
  const token = requiredEnv("DARK_FACTORY_TOKEN");
  const ledgerToken = process.env.DF_LEDGER_TOKEN?.trim() || token;
  configureSubmoduleRuntime({
    gh: createGithubClient(token, "darkfactory-submodule-autoupdate"),
    ledgerGh: createGithubClient(ledgerToken, "darkfactory-submodule-ledger"),
    controlRepo: parseRepo(process.env.DF_CONTROL_REPO || "marius-patrik/DarkFactory")
  });
  const result = await runSubmoduleCommand({
    mode: process.env.DF_SUBMODULE_MODE || "status",
    child: process.env.DF_SUBMODULE_REPO?.trim() || "",
    localPath: process.env.DF_SUBMODULE_LOCAL_PATH?.trim() || "",
    validation: process.env.DF_SUBMODULE_VALIDATION_SHA?.trim()
      ? {
          headSha: process.env.DF_SUBMODULE_VALIDATION_SHA.trim(),
          runUrl: process.env.DF_SUBMODULE_VALIDATION_URL?.trim() || ""
        }
      : null
  });
  console.log(JSON.stringify(result, null, 2));
}

export function loadSubmodulePolicy() {
  return validateSubmodulePolicy(JSON.parse(readFileSync(POLICY_FILE, "utf8")));
}

export function validateSubmodulePolicy(value) {
  const expected = [
    "schemaVersion", "enabled", "targetBranch", "branchPrefix", "requiredChecks",
    "releaseReceiptMaxAgeHours", "mainOnlyData", "canonicalRoots"
  ].sort();
  if (!isRecord(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expected)) {
    throw new Error("submodule policy has unknown or missing properties");
  }
  if (value.schemaVersion !== 1 || typeof value.enabled !== "boolean") {
    throw new Error("submodule policy must declare schemaVersion 1 and a boolean enabled state");
  }
  if (value.targetBranch !== "dev" || !/^[a-z][a-z0-9-]*\/$/.test(value.branchPrefix)) {
    throw new Error("submodule policy must target dev through a safe marker branch prefix");
  }
  if (!Array.isArray(value.requiredChecks)
      || JSON.stringify(value.requiredChecks) !== JSON.stringify(["Validate", "DarkFactory Autoreview"])) {
    throw new Error("submodule policy must require exact Validate and DarkFactory Autoreview checks");
  }
  if (!Number.isInteger(value.releaseReceiptMaxAgeHours)
      || value.releaseReceiptMaxAgeHours < 1 || value.releaseReceiptMaxAgeHours > 24 * 30) {
    throw new Error("submodule policy release receipt lifetime is invalid");
  }
  const expectedData = [
    ["marius-patrik/Andromeda-data", "encrypted-bundle-validate"],
    ["marius-patrik/darkfactory-data", "app-ledger-validate"]
  ];
  if (!Array.isArray(value.mainOnlyData) || JSON.stringify(value.mainOnlyData.map((item) => {
    if (!isRecord(item)
        || JSON.stringify(Object.keys(item).sort()) !== JSON.stringify(["admission", "repository"])) {
      throw new Error("submodule policy contains malformed main-only data admission");
    }
    return [item.repository, item.admission];
  })) !== JSON.stringify(expectedData)) {
    throw new Error("submodule policy must declare the exact main-only data admission contract");
  }
  if (!Array.isArray(value.canonicalRoots) || value.canonicalRoots.length !== 1) {
    throw new Error("submodule policy must declare the one canonical Andromeda root");
  }
  const root = value.canonicalRoots[0];
  if (!isRecord(root)
      || JSON.stringify(Object.keys(root).sort()) !== JSON.stringify(["gitlinks", "repository"])
      || root.repository !== "marius-patrik/Andromeda"
      || !Array.isArray(root.gitlinks)) {
    throw new Error("submodule policy canonical root is malformed");
  }
  const expectedGitlinks = [
    ["Singularity", "apps/Singularity", "marius-patrik/Singularity", "main"],
    ["Fabrica", "apps/Fabrica", "marius-patrik/Fabrica", "dev"],
    ["DarkFactory", "plugins/DarkFactory", "marius-patrik/DarkFactory", "main"],
    ["LifeQuest", "plugins/LifeQuest", "marius-patrik/LifeQuest", "main"],
    ["SkyAgent", "plugins/SkyAgent", "marius-patrik/SkyAgent", "main"],
    ["data", "data/andromeda", "marius-patrik/Andromeda-data", "main"],
    ["darkfactory-data", "data/darkfactory", "marius-patrik/darkfactory-data", "main"]
  ];
  const actual = root.gitlinks.map((item) => {
    if (!isRecord(item)
        || JSON.stringify(Object.keys(item).sort()) !== JSON.stringify(["branch", "name", "path", "repository"])
        || !["main", "dev"].includes(item.branch)
        || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(item.repository)
        || !isSafeGitlinkPath(item.path)) {
      throw new Error("submodule policy contains a malformed canonical gitlink");
    }
    return [item.name, item.path, item.repository, item.branch];
  });
  if (JSON.stringify(actual) !== JSON.stringify(expectedGitlinks)) {
    throw new Error("submodule policy does not match the exact Andromeda gitlink identity contract");
  }
  return Object.freeze({
    ...value,
    requiredChecks: Object.freeze([...value.requiredChecks]),
    mainOnlyData: Object.freeze(value.mainOnlyData.map((item) => Object.freeze({ ...item }))),
    canonicalRoots: Object.freeze(value.canonicalRoots.map((item) => Object.freeze({
      ...item,
      gitlinks: Object.freeze(item.gitlinks.map((gitlink) => Object.freeze({ ...gitlink })))
    })))
  });
}

export function canonicalAndromedaGitlinks(policy = loadSubmodulePolicy()) {
  return policy.canonicalRoots[0].gitlinks.map((item) => ({ ...item }));
}

export function releasedBranchForChild(child, policy = loadSubmodulePolicy()) {
  const repository = repoName(child).toLowerCase();
  const matches = policy.canonicalRoots
    .flatMap((root) => root.gitlinks)
    .filter((gitlink) => gitlink.repository.toLowerCase() === repository);
  const branches = [...new Set(matches.map((gitlink) => gitlink.branch))];
  if (branches.length > 1) throw new Error(`canonical child ${repoName(child)} has conflicting tracked branches`);
  return branches[0] || "main";
}

export async function runSubmoduleCommand({ mode, child = "", localPath = "", validation = null } = {}) {
  assertRuntime();
  if (!SUBMODULE_MODES.has(mode)) throw new Error(`unknown submodule mode: ${mode}`);
  const policy = runtimeOptions.policy || loadSubmodulePolicy();
  if (!policy.enabled) return { schemaVersion: 1, mode, status: "skipped", reason: "policy-disabled" };
  const observation = await observeSubmoduleUpdate({ child, localPath, policy });
  const plan = buildSubmodulePlan(observation, policy);
  if (mode === "status" || mode === "plan") {
    return { schemaVersion: 1, mode, status: plan.action === "block" ? "blocked" : "observed", plan, observation: publicObservation(observation) };
  }

  if (mode === "verify") {
    const verified = ["current", "released"].includes(plan.action);
    return {
      schemaVersion: 1,
      mode,
      status: verified ? "verified" : "blocked",
      plan,
      observation: publicObservation(observation),
      receipt: {
        kind: "submodule-verification",
        plan_id: plan.planId,
        verified,
        action: plan.action,
        evidence: plan.evidence,
        blockers: plan.blockers
      }
    };
  }

  await writeSubmoduleLedger(plan, "submodule-update-admission", {
    status: "admitted",
    mode,
    plan_id: plan.planId,
    action: plan.action,
    evidence: plan.evidence,
    blockers: plan.blockers
  });

  let action;
  if (plan.action === "block") action = { status: "blocked", reason: plan.blockers.join(";") };
  else if (plan.action === "current") action = { status: "current", state: observation.pointerState };
  else if (plan.action === "released") action = await completeReleasedPointer(observation, plan);
  else if (plan.action === "release-parent") action = await dispatchParentRelease(observation, plan);
  else if (validation) action = await finalizeSubmoduleUpdate(observation, plan, validation);
  else action = await ensureSubmoduleUpdatePull(observation, plan);

  const result = {
    schemaVersion: 1,
    mode,
    status: action.status,
    plan,
    action,
    observation: publicObservation(observation)
  };
  await writeSubmoduleLedger(plan, "df-submodule-update", result);
  return result;
}

export async function observeSubmoduleUpdate({ child = "", localPath = "", policy = loadSubmodulePolicy(), parentRepositories = null } = {}) {
  assertRuntime();
  const registry = runtimeOptions.registry || await readManagedRepoRegistry(runtimeOptions.root || process.cwd());
  const parents = parentRepositories || runtimeOptions.parents || await listActiveManagedRepos(gh, controlRepo, { registry, root: runtimeOptions.root || process.cwd() });
  let childRepo = child ? parseRepo(child) : null;
  if (!childRepo) {
    const candidates = await discoverCandidateChildren(parents, policy);
    const scans = [];
    for (const candidate of candidates) {
      scans.push(await observeSubmoduleUpdate({
        child: repoName(candidate), localPath, policy, parentRepositories: parents
      }));
    }
    const selected = selectSubmoduleScanObservation(scans, policy);
    if (selected) return { ...selected, scan: { candidates: candidates.map(repoName), selected: selected.child } };
  }
  if (!childRepo) {
    return { child: null, parents, blockers: [], pointerState: "current", reason: "no-current-release-receipt" };
  }

  const blockers = [];
  if (isParkedRepo(childRepo)) {
    return {
      child: repoName(childRepo),
      childRelease: null,
      parents: parents.map(repoName),
      candidate: null,
      local: { observed: false, clean: null, blockers: [] },
      blockers: [`parked-child:${repoName(childRepo)}`],
      pointerState: "blocked"
    };
  }
  const childRelease = await observeChildRelease(childRepo, policy);
  blockers.push(...childRelease.blockers);
  const candidateParents = [];
  for (const parent of parents) {
    if (repoName(parent).toLowerCase() === repoName(childRepo).toLowerCase()) continue;
    const parentObservation = await observeParentCandidate(parent, childRepo, childRelease, policy);
    if (parentObservation.referencesChild) candidateParents.push(parentObservation);
  }
  if (candidateParents.length === 0) blockers.push(`no-active-parent-consumer:${repoName(childRepo)}`);
  if (candidateParents.length > 1) blockers.push(`ambiguous-parent-consumers:${candidateParents.map((item) => item.repository).join(",")}`);
  const candidate = candidateParents.length === 1 ? candidateParents[0] : null;
  if (candidate) blockers.push(...candidate.blockers);
  const local = localPath ? inspectLocalCheckout(localPath, candidate?.repository || "") : { observed: false, clean: null, blockers: [] };
  blockers.push(...local.blockers);

  return {
    child: repoName(childRepo),
    childRelease,
    parents: parents.map(repoName),
    candidate,
    local,
    blockers: [...new Set(blockers)].sort(),
    pointerState: candidate?.pointerState || "blocked"
  };
}

export function selectSubmoduleScanObservation(observations, policy = loadSubmodulePolicy()) {
  const classified = observations.map((observation) => ({
    observation,
    action: buildSubmodulePlan(observation, policy).action,
    lastPlanRecorded: observation.candidate?.lastPlanRecorded === true,
    lastPlanCreatedAt: Number.isFinite(observation.candidate?.lastPlanCreatedAt)
      ? observation.candidate.lastPlanCreatedAt
      : 0
  }));
  const rank = (item) => {
    if (item.action === "release-parent") return 0;
    if (item.action === "update" && !item.lastPlanRecorded) return 1;
    if (item.action === "released") return 2;
    if (item.action === "update") return 3;
    if (item.action === "block") return 4;
    return 5;
  };
  classified.sort((left, right) => rank(left) - rank(right)
    || (rank(left) === 3 ? left.lastPlanCreatedAt - right.lastPlanCreatedAt : 0)
    || String(left.observation.child || "").localeCompare(String(right.observation.child || "")));
  return classified[0]?.observation || null;
}

async function discoverCandidateChildren(parents, policy) {
  const children = new Map();
  for (const parent of parents) {
    const gitmodules = await getOptionalFileContent(gh, parent, ".gitmodules", "main");
    for (const entry of parseGitmodules(gitmodules || "")) {
      const child = resolveSubmoduleRepo(parent, entry.url);
      if (!child || isParkedRepo(child)) continue;
      children.set(repoName(child).toLowerCase(), child);
    }
  }
  const released = [];
  for (const candidate of children.values()) {
    if (policy.mainOnlyData.some((item) => item.repository.toLowerCase() === repoName(candidate).toLowerCase())) {
      released.push({ candidate, created: Number.MAX_SAFE_INTEGER });
      continue;
    }
    const receipt = await readOptionalLedger("df-release", repoName(candidate));
    const created = Date.parse(receipt?.created_at || "");
    released.push({
      candidate,
      created: receipt?.status === "verified" && Number.isFinite(created) ? created : 0
    });
  }
  released.sort((a, b) => b.created - a.created || repoName(a.candidate).localeCompare(repoName(b.candidate)));
  return released.map((item) => item.candidate);
}

export async function observeChildRelease(child, policy) {
  const blockers = [];
  const releaseBranch = releasedBranchForChild(child, policy);
  let metadata;
  try {
    metadata = await gh.request("GET", `/repos/${repoName(child)}`);
  } catch (error) {
    if ([403, 404].includes(error.status)) {
      return { repository: repoName(child), branch: releaseBranch, blockers: ["child-inaccessible"], receipt: null };
    }
    throw error;
  }
  if (metadata.archived === true || metadata.disabled === true) blockers.push("child-read-only");
  if (metadata.default_branch !== releaseBranch) {
    blockers.push(`child-default-branch-not-${releaseBranch}:${metadata.default_branch || "missing"}`);
  }
  const dataAdmission = policy.mainOnlyData.find((item) => item.repository.toLowerCase() === repoName(child).toLowerCase());
  if (dataAdmission) return { ...await observeMainOnlyDataHead(child, metadata, dataAdmission, blockers), branch: releaseBranch };
  const receipt = await readOptionalLedger("df-release", repoName(child));
  const receiptResult = validateReleaseReceipt(receipt, child, policy, runtimeOptions.now || Date.now());
  blockers.push(...receiptResult.blockers);
  if (!receiptResult.sha) return { repository: repoName(child), metadata, receipt, branch: releaseBranch, blockers };

  let head;
  try {
    head = await gh.request("GET", `/repos/${repoName(child)}/commits/${encodeURIComponent(releaseBranch)}`);
  } catch (error) {
    if ([403, 404, 409].includes(error.status)) {
      return {
        repository: repoName(child), metadata, receipt, branch: releaseBranch,
        blockers: [...blockers, `child-${releaseBranch}-inaccessible`]
      };
    }
    throw error;
  }
  if (head?.sha !== receiptResult.sha) blockers.push(`child-${releaseBranch}-moved-after-release-receipt`);
  const protection = await optionalProtection(child, releaseBranch);
  blockers.push(...validateBoundProtection(protection, policy.requiredChecks, `child-${releaseBranch}`));
  const releasePolicyText = await getOptionalFileContent(gh, child, ".darkfactory/release-policy.json", releaseBranch);
  let releasePolicy = null;
  try { releasePolicy = validateReleasePolicy(JSON.parse(releasePolicyText || "")); } catch { blockers.push("child-release-policy-invalid"); }
  let mainChecks = null;
  if (head?.sha && releasePolicy) {
    const liveProtection = {
      ...protection,
      required_status_checks: {
        ...(protection?.required_status_checks || {}),
        checks: requiredCheckBindings(protection).filter((item) => item.context !== "DarkFactory Autoreview")
          .map((item) => ({ context: item.context, app_id: item.appId }))
      }
    };
    mainChecks = evaluateRequiredChecks(
      liveProtection,
      await gh.request("GET", `/repos/${repoName(child)}/commits/${head.sha}/check-runs?per_page=100`),
      await gh.request("GET", `/repos/${repoName(child)}/commits/${head.sha}/status`),
      releasePolicy.mainChecks
    );
    if (!mainChecks.green) blockers.push(`child-${releaseBranch}-checks-not-green`);
  }
  return {
    repository: repoName(child), metadata, receipt, branch: releaseBranch, sha: receiptResult.sha,
    receiptUrl: receiptResult.pullRequest, protection: summarizeProtection(protection),
    mainChecks, blockers: [...new Set(blockers)].sort()
  };
}

async function observeMainOnlyDataHead(child, metadata, admission, inheritedBlockers = []) {
  const dev = await optionalRefHead(child, "dev");
  const protectionPosture = await observeMainOnlyDataProtection(child);
  let head;
  try {
    head = await gh.request("GET", `/repos/${repoName(child)}/commits/main`);
  } catch (error) {
    if ([403, 404, 409].includes(error.status)) {
      return { repository: repoName(child), metadata, receipt: null, blockers: [...inheritedBlockers, "child-main-inaccessible"] };
    }
    throw error;
  }
  const checkRuns = isSha(head?.sha)
    ? await gh.request("GET", `/repos/${repoName(child)}/commits/${head.sha}/check-runs?per_page=100`)
    : { check_runs: [] };
  const mainChecks = evaluateRequiredChecks(
    { required_status_checks: { checks: [{ context: "Validate", app_id: TRUSTED_GATE_APP_ID }] } },
    checkRuns,
    { statuses: [] },
    ["Validate"]
  );
  const blockers = validateMainOnlyDataAdmission({
    metadata, dev, protectionPosture, headSha: head?.sha, mainChecks
  }, inheritedBlockers);
  const validate = mainChecks.checks.find((item) => item.name === "Validate");
  return {
    repository: repoName(child),
    metadata,
    receipt: null,
    sha: isSha(head?.sha) ? head.sha : null,
    receiptUrl: validate?.url || null,
    admission: admission.admission,
    protectionPosture,
    mainChecks,
    blockers: [...new Set(blockers)].sort()
  };
}

export function validateMainOnlyDataAdmission(evidence, inheritedBlockers = []) {
  const blockers = [...inheritedBlockers];
  if (evidence.metadata?.private !== true) blockers.push("main-only-data-not-private");
  if (evidence.dev) blockers.push("main-only-data-has-dev");
  if (evidence.protectionPosture !== "private-plan-unavailable") {
    blockers.push(`main-only-data-protection-posture:${evidence.protectionPosture || "unobservable"}`);
  }
  if (!isSha(evidence.headSha)) blockers.push("child-main-inaccessible");
  if (evidence.mainChecks?.green !== true) blockers.push("main-only-data-validate-not-green");
  return [...new Set(blockers)].sort();
}

async function observeMainOnlyDataProtection(repository) {
  try {
    await gh.request("GET", `/repos/${repoName(repository)}/branches/main/protection`);
    return "configured";
  } catch (error) {
    const message = String(error?.response?.data?.message || error?.message || "");
    if (error.status === 403 && /upgrade to github pro|enable this feature/i.test(message)) {
      return "private-plan-unavailable";
    }
    if (error.status === 404) return "missing";
    if (error.status === 403) return "inaccessible";
    throw error;
  }
}

export function validateReleaseReceipt(receipt, child, policy, now = Date.now()) {
  const blockers = [];
  const expected = repoName(child).toLowerCase();
  if (!isRecord(receipt)) return { sha: null, blockers: ["child-release-receipt-missing"] };
  if (receipt.kind !== "df-release" || receipt.status !== "verified") blockers.push("child-release-receipt-not-verified");
  if (String(receipt.target_repo || "").toLowerCase() !== expected
      || String(receipt.repository || "").toLowerCase() !== expected) blockers.push("child-release-receipt-repository-mismatch");
  const exactCommitIdentity = isSha(receipt.main_sha)
    && isSha(receipt.dev_sha)
    && receipt.main_sha === receipt.dev_sha;
  const exactTreeIdentity = isSha(receipt.main_sha)
    && isSha(receipt.dev_sha)
    && receipt.main_sha !== receipt.dev_sha
    && isSha(receipt.main_tree_sha)
    && isSha(receipt.dev_tree_sha)
    && receipt.main_tree_sha === receipt.dev_tree_sha;
  if (!exactCommitIdentity && !exactTreeIdentity) blockers.push("child-release-receipt-sha-invalid");
  const created = Date.parse(receipt.created_at || "");
  const maximumAge = policy.releaseReceiptMaxAgeHours * 60 * 60 * 1000;
  if (!Number.isFinite(created) || created > Number(now) + 5 * 60 * 1000 || Number(now) - created > maximumAge) {
    blockers.push("child-release-receipt-stale");
  }
  const release = receipt.release;
  const checks = release?.checks;
  const checkMap = new Map((Array.isArray(checks?.checks) ? checks.checks : []).map((item) => [item?.name, item]));
  for (const name of policy.requiredChecks) {
    const check = checkMap.get(name);
    if (!check || check.state !== "green" || check.expectedAppId !== TRUSTED_GATE_APP_ID || check.actualAppId !== TRUSTED_GATE_APP_ID
        || !Number.isInteger(check.id) || typeof check.url !== "string" || !/^https:\/\//.test(check.url)) {
      blockers.push(`child-release-gate-invalid:${name}`);
    }
  }
  const pullRequest = typeof release?.pull_request === "string" ? release.pull_request : "";
  if (!new RegExp(`^https://github\\.com/${escapeRegex(repoName(child))}/pull/[1-9][0-9]*$`, "i").test(pullRequest)) {
    blockers.push("child-release-pull-evidence-invalid");
  }
  if (release?.green !== true || receipt.publication?.green !== true) blockers.push("child-release-evidence-incomplete");
  const releaseBranch = releasedBranchForChild(child, policy);
  const releasedSha = releaseBranch === "dev" ? receipt.dev_sha : receipt.main_sha;
  return {
    sha: isSha(releasedSha) ? releasedSha : null,
    branch: releaseBranch,
    pullRequest,
    blockers: [...new Set(blockers)].sort()
  };
}

async function observeParentCandidate(parent, child, childRelease, policy) {
  const blockers = [];
  let metadata;
  try { metadata = await gh.request("GET", `/repos/${repoName(parent)}`); } catch (error) {
    if ([403, 404].includes(error.status)) return { repository: repoName(parent), referencesChild: false, blockers: ["parent-inaccessible"] };
    throw error;
  }
  if (metadata.archived === true || metadata.disabled === true) blockers.push("parent-read-only");
  if (metadata.default_branch !== "main") blockers.push("parent-default-branch-not-main");
  const autoMergeAllowed = await observeAutoMerge(parent, metadata.allow_auto_merge);
  metadata = { ...metadata, allow_auto_merge: autoMergeAllowed };
  if (autoMergeAllowed !== true) blockers.push("parent-automerge-disabled");
  if (metadata.delete_branch_on_merge !== true) blockers.push("parent-atomic-branch-cleanup-disabled");
  const [mainSha, devSha] = await Promise.all([optionalRefHead(parent, "main"), optionalRefHead(parent, policy.targetBranch)]);
  if (!mainSha || !devSha) blockers.push("parent-main-or-dev-missing");
  let convergence = null;
  if (mainSha && devSha) {
    convergence = mainSha === devSha ? { status: "identical", ahead_by: 0, behind_by: 0 } : await compare(parent, mainSha, devSha);
    if (!isForwardOrIdentical(convergence)) blockers.push("parent-main-dev-diverged");
  }
  const [mainModulesText, devModulesText] = await Promise.all([
    getOptionalFileContent(gh, parent, ".gitmodules", "main"),
    getOptionalFileContent(gh, parent, ".gitmodules", policy.targetBranch)
  ]);
  const mainModules = parseGitmodules(mainModulesText || "");
  const devModules = parseGitmodules(devModulesText || "");
  const mainLayout = validateParentLayout(parent, mainModules, policy);
  const devLayout = validateParentLayout(parent, devModules, policy);
  blockers.push(...mainLayout.blockers, ...devLayout.blockers);
  const matches = mainModules.filter((item) => {
    const resolved = resolveSubmoduleRepo(parent, item.url);
    return resolved && repoName(resolved).toLowerCase() === repoName(child).toLowerCase();
  });
  if (matches.length === 0) return { repository: repoName(parent), referencesChild: false, blockers };
  if (matches.length !== 1) blockers.push("ambiguous-child-remote-mapping");
  const gitlink = matches.length === 1 ? matches[0] : null;
  if (!gitlink) return { repository: repoName(parent), referencesChild: true, blockers };
  if (!isSafeGitlinkPath(gitlink.path)) blockers.push("unsafe-gitlink-path");
  const devEntry = devModules.find((item) => item.path === gitlink.path);
  if (!devEntry || devEntry.name !== gitlink.name || devEntry.url !== gitlink.url || devEntry.branch !== gitlink.branch) {
    blockers.push("parent-gitmodules-diverged");
  }
  if (gitlink.branch && gitlink.branch !== childRelease.branch) blockers.push("child-tracking-branch-mismatch");
  const [mainPointer, devPointer] = await Promise.all([
    getSubmoduleCommit(parent, gitlink.path, "main"),
    getSubmoduleCommit(parent, gitlink.path, policy.targetBranch)
  ]);
  if (!mainPointer || !devPointer) blockers.push("parent-gitlink-missing");
  let relation = null;
  if (devPointer && childRelease.sha) {
    relation = devPointer === childRelease.sha
      ? { status: "identical", ahead_by: 0, behind_by: 0 }
      : await compare(child, devPointer, childRelease.sha, { inaccessible: true });
    if (!isForwardOrIdentical(relation)) blockers.push(`child-history-not-forward:${relation?.status || "unobservable"}`);
  }
  const pointerState = classifyPointerState(mainPointer, devPointer, childRelease.sha, relation);
  if (pointerState === "blocked") blockers.push("parent-pointer-state-ambiguous");
  const [devProtection, releasePolicyText, pulls] = await Promise.all([
    optionalProtection(parent, policy.targetBranch),
    getOptionalFileContent(gh, parent, ".darkfactory/release-policy.json", "main"),
    listAll(`/repos/${repoName(parent)}/pulls?state=open&base=${encodeURIComponent(policy.targetBranch)}&per_page=100`)
  ]);
  blockers.push(...validateBoundProtection(devProtection, policy.requiredChecks, "parent-dev"));
  try {
    const releasePolicy = validateReleasePolicy(JSON.parse(releasePolicyText || ""));
    if (!releasePolicy.enabled) blockers.push("parent-release-policy-disabled");
  } catch { blockers.push("parent-release-policy-invalid"); }
  const exactEvidence = submodulePlanEvidence({
    child: repoName(child),
    childRelease,
    candidate: {
      repository: repoName(parent), mainSha, devSha, gitlink, mainPointer, devPointer, pointerState
    },
    pointerState
  });
  const currentPlanId = submodulePlanId(exactEvidence);
  const previousPointer = await readOptionalLedger("df-submodule-update", repoName(parent));
  const lastPlanRecorded = previousPointer?.plan?.planId === currentPlanId;
  const lastPlanCreatedAt = lastPlanRecorded ? Date.parse(previousPointer?.created_at || "") : NaN;
  const releasedRecorded = previousPointer?.status === "released"
    && lastPlanRecorded;
  const competing = await classifyOpenPointerPulls(parent, pulls, gitlink.path, child, childRelease.sha, policy, {
    parentSha: devSha,
    oldSha: devPointer,
    planId: currentPlanId,
    mainSha,
    mainPointer,
    pointerState,
    receipt: childRelease.receiptUrl || null,
    candidate: {
      repository: repoName(parent), mainSha, devSha, gitlink, mainPointer, devPointer,
      releasedSha: childRelease.sha || null, pointerState,
      evidence: {
        ancestry: devPointer && childRelease.sha
          ? `https://github.com/${repoName(child)}/compare/${devPointer}...${childRelease.sha}`
          : null
      }
    }
  });
  blockers.push(...competing.blockers);
  return {
    repository: repoName(parent),
    referencesChild: true,
    metadata,
    mainSha,
    devSha,
    convergence,
    gitlink,
    mainPointer,
    devPointer,
    releasedSha: childRelease.sha || null,
    relation,
    pointerState,
    releasedRecorded,
    lastPlanRecorded,
    lastPlanCreatedAt,
    protection: summarizeProtection(devProtection),
    trustedPull: competing.trustedPull,
    recoverablePull: competing.recoverablePull,
    blockers: [...new Set(blockers)].sort(),
    evidence: {
      parent_pointer: `https://github.com/${repoName(parent)}/tree/${devSha}/${gitlink.path}`,
      child_release: childRelease.receiptUrl || null,
      child_commit: childRelease.sha ? `https://github.com/${repoName(child)}/commit/${childRelease.sha}` : null,
      ancestry: devPointer && childRelease.sha ? `https://github.com/${repoName(child)}/compare/${devPointer}...${childRelease.sha}` : null
    }
  };
}

export function validateParentLayout(parent, entries, policy = loadSubmodulePolicy()) {
  const blockers = [];
  const paths = new Set();
  const identities = new Set();
  for (const entry of entries) {
    const identity = `${entry.name}\0${entry.path}`;
    if (!entry.name || !entry.path || !entry.url || paths.has(entry.path) || identities.has(identity)) blockers.push("ambiguous-gitmodule-declaration");
    paths.add(entry.path);
    identities.add(identity);
  }
  const root = policy.canonicalRoots.find((item) => item.repository.toLowerCase() === repoName(parent).toLowerCase());
  if (root) {
    const expectedPaths = new Set(root.gitlinks.map((item) => item.path));
    for (const expected of root.gitlinks) {
      const matches = entries.filter((item) => item.path === expected.path);
      const actual = matches[0];
      const resolved = actual ? resolveSubmoduleRepo(parent, actual.url) : null;
      if (matches.length !== 1 || actual.name !== expected.name || actual.branch !== expected.branch
          || !resolved || repoName(resolved).toLowerCase() !== expected.repository.toLowerCase()) {
        blockers.push(`canonical-andromeda-gitlink-invalid:${expected.path}`);
      }
    }
    for (const entry of entries) if (!expectedPaths.has(entry.path)) blockers.push(`unexpected-andromeda-gitlink:${entry.path}`);
  }
  return { blockers: [...new Set(blockers)].sort() };
}

async function classifyOpenPointerPulls(parent, pulls, gitlinkPath, child, releasedSha, policy, evidence) {
  const blockers = [];
  const trusted = [];
  const recoverable = [];
  for (const summary of pulls) {
    const pull = await gh.request("GET", `/repos/${repoName(parent)}/pulls/${summary.number}`);
    const files = await listAll(`/repos/${repoName(parent)}/pulls/${summary.number}/files?per_page=100`);
    const touchesPath = files.some((item) => item?.filename === gitlinkPath);
    const claimsLane = String(pull?.head?.ref || "").startsWith(policy.branchPrefix)
      || /<!-- darkfactory:submodule-update\b/.test(String(pull?.body || ""));
    if (!touchesPath && !claimsLane) continue;
    if (isTrustedPointerPull(parent, pull, {
      path: gitlinkPath,
      child: repoName(child),
      releasedSha,
      policy,
      parentSha: evidence.parentSha,
      oldSha: evidence.oldSha,
      planId: evidence.planId,
      branch: `${policy.branchPrefix}${slug(repoName(child))}-${String(releasedSha).slice(0, 12)}`
    })) {
      trusted.push(pull);
      continue;
    }
    const recovery = await admitRecoverablePointerPull(parent, pull, {
      ...evidence,
      path: gitlinkPath,
      child: repoName(child),
      releasedSha,
      policy,
      branch: `${policy.branchPrefix}${slug(repoName(child))}-${String(releasedSha).slice(0, 12)}`
    });
    if (recovery) recoverable.push(recovery);
    else blockers.push(`competing-or-untrusted-pointer-pr:${pull.number}`);
  }
  if (trusted.length + recoverable.length > 1) blockers.push("duplicate-trusted-pointer-prs");
  return {
    trustedPull: trusted.length === 1 && recoverable.length === 0 ? trusted[0] : null,
    recoverablePull: recoverable.length === 1 && trusted.length === 0 ? recoverable[0] : null,
    blockers
  };
}

async function admitRecoverablePointerPull(parent, pull, expected) {
  const marker = parsePointerPullMarker(pull?.body);
  const number = Number(pull?.number);
  if (!marker
      || pull?.state !== "open"
      || pull?.draft === true
      || !Number.isInteger(number) || number < 1
      || pull?.html_url !== `https://github.com/${repoName(parent)}/pull/${number}`
      || pull?.title !== pointerPullTitle(expected.candidate)
      || normalizeWorkerPullRequestActor(pull?.user) === null
      || pull?.base?.ref !== "dev"
      || String(pull?.head?.repo?.full_name || "").toLowerCase() !== repoName(parent).toLowerCase()
      || pull?.head?.ref !== expected.branch
      || !isSha(pull?.head?.sha)
      || marker.child.toLowerCase() !== expected.child.toLowerCase()
      || marker.oldSha !== expected.oldSha
      || marker.releasedSha !== expected.releasedSha
      || marker.path !== expected.path
      || marker.parentSha === expected.parentSha) {
    return null;
  }
  const priorEvidence = {
    child: expected.child,
    child_sha: expected.releasedSha,
    parent: repoName(parent),
    parent_main: expected.mainSha,
    parent_dev: marker.parentSha,
    path: expected.path,
    main_pointer: expected.mainPointer,
    dev_pointer: marker.oldSha,
    pointer_state: expected.pointerState,
    receipt: expected.receipt
  };
  if (marker.planId !== submodulePlanId(priorEvidence)) return null;
  const [branchHead, baseAdvance] = await Promise.all([
    optionalRefHead(parent, expected.branch),
    compare(parent, marker.parentSha, expected.parentSha, { inaccessible: true })
  ]);
  if (branchHead !== pull.head.sha
      || baseAdvance?.status !== "ahead"
      || !Number.isInteger(baseAdvance.ahead_by) || baseAdvance.ahead_by < 1
      || baseAdvance.behind_by !== 0) {
    return null;
  }
  const priorCandidate = {
    ...expected.candidate,
    devSha: marker.parentSha,
    devPointer: marker.oldSha,
    releasedSha: expected.releasedSha
  };
  const priorObservation = {
    child: expected.child,
    childRelease: { receiptUrl: expected.receipt },
    candidate: priorCandidate
  };
  if (String(pull.body) !== pointerPullBody(priorObservation, { planId: marker.planId }, marker.headSha)) return null;
  try {
    await verifyPointerBranch(parent, priorCandidate, { planId: marker.planId }, marker.headSha, { requireTreeSha: true });
    if (pull.head.sha === marker.headSha) {
      return { state: "stale-base", pull, body: String(pull.body), marker };
    }
    await verifyPointerBranch(
      parent,
      expected.candidate,
      { planId: expected.planId },
      pull.head.sha,
      { priorHead: marker.headSha, requireTreeSha: true }
    );
  } catch (error) {
    if (error instanceof PointerTrustViolation) return null;
    throw error;
  }
  return { state: "interrupted-provenance", pull, body: String(pull.body), marker };
}

export function buildSubmodulePlan(observation, policy = loadSubmodulePolicy()) {
  const candidate = observation.candidate;
  const evidence = submodulePlanEvidence(observation);
  const planId = submodulePlanId(evidence);
  const blockers = [...new Set(observation.blockers || [])].sort();
  let action = "block";
  if (blockers.length === 0) {
    if (!observation.child || !candidate) action = "current";
    else if (candidate.pointerState === "released") action = candidate.releasedRecorded ? "current" : "released";
    else if (candidate.pointerState === "merged") action = "release-parent";
    else if (["behind", "pending"].includes(candidate.pointerState)) action = "update";
    else if (candidate.pointerState === "current") action = "current";
  }
  return {
    schemaVersion: 1,
    planId,
    action,
    branch: action === "update" ? `${policy.branchPrefix}${slug(observation.child)}-${String(observation.childRelease.sha).slice(0, 12)}` : null,
    evidence,
    blockers
  };
}

export async function ensureSubmoduleUpdatePull(observation, plan) {
  if (plan.action !== "update") throw new Error(`submodule plan is not updateable: ${plan.action}`);
  const candidate = observation.candidate;
  const parent = parseRepo(candidate.repository);
  const child = parseRepo(observation.child);
  await assertObservationCurrent(observation);
  if (candidate.trustedPull) {
    assertTrustedPullHead(candidate.trustedPull, candidate, plan);
    return pointerPullResult(candidate.trustedPull, candidate, plan, "waiting-for-validation");
  }
  if (candidate.recoverablePull) {
    return await reconcileRecoverablePointerPull(observation, plan, candidate.recoverablePull);
  }
  const branchRef = await optionalRefHead(parent, plan.branch);
  let headSha = branchRef;
  if (!branchRef) {
    const baseCommit = await gh.request("GET", `/repos/${repoName(parent)}/git/commits/${candidate.devSha}`);
    if (!isSha(baseCommit?.tree?.sha)) throw new Error("parent dev commit tree is inaccessible");
    const tree = await gh.request("POST", `/repos/${repoName(parent)}/git/trees`, {
      base_tree: baseCommit.tree.sha,
      tree: [{ path: candidate.gitlink.path, mode: "160000", type: "commit", sha: candidate.releasedSha }]
    });
    const commit = await gh.request("POST", `/repos/${repoName(parent)}/git/commits`, {
      message: pointerCommitMessage(observation, plan),
      tree: tree.sha,
      parents: [candidate.devSha]
    });
    if (!isSha(commit?.sha)) throw new Error("GitHub did not return the pointer commit SHA");
    await assertObservationCurrent(observation);
    try {
      await gh.request("POST", `/repos/${repoName(parent)}/git/refs`, { ref: `refs/heads/${plan.branch}`, sha: commit.sha });
    } catch (error) {
      if (error.status !== 422) throw error;
      const raced = await optionalRefHead(parent, plan.branch);
      if (raced !== commit.sha) throw new Error("submodule update branch appeared with a different head; refusing overwrite");
    }
    headSha = commit.sha;
  }
  await verifyPointerBranch(parent, candidate, plan, headSha);
  const body = pointerPullBody(observation, plan, headSha);
  await assertObservationCurrent(observation);
  const pull = await gh.request("POST", `/repos/${repoName(parent)}/pulls`, {
    head: plan.branch,
    base: "dev",
    title: pointerPullTitle(candidate),
    body
  }).catch(async (error) => {
    if (error.status !== 422) throw error;
    const exact = await findExactOpenPointerPull(parent, candidate, plan, headSha);
    if (!exact) throw new Error("pointer PR creation raced with a different or untrusted lane");
    return exact;
  });
  assertTrustedPullHead(pull, candidate, plan, headSha);
  return pointerPullResult(pull, candidate, plan, "waiting-for-validation");
}

async function reconcileRecoverablePointerPull(observation, plan, observedAdmission) {
  const candidate = observation.candidate;
  const parent = parseRepo(candidate.repository);
  const expected = {
    candidate,
    path: candidate.gitlink.path,
    child: observation.child,
    releasedSha: candidate.releasedSha,
    oldSha: candidate.devPointer,
    parentSha: candidate.devSha,
    mainSha: candidate.mainSha,
    mainPointer: candidate.mainPointer,
    pointerState: candidate.pointerState,
    receipt: observation.childRelease.receiptUrl || null,
    policy: runtimeOptions.policy || loadSubmodulePolicy(),
    branch: plan.branch,
    planId: plan.planId
  };
  const pullNumber = observedAdmission.pull.number;
  let pull = await gh.request("GET", `/repos/${repoName(parent)}/pulls/${pullNumber}`);
  if (String(pull?.body) !== observedAdmission.body) {
    throw new PointerTrustViolation("pointer PR body changed after recovery admission; preserved the concurrent edit");
  }
  let admission = await admitRecoverablePointerPull(parent, pull, expected);
  if (!admission) throw new PointerTrustViolation("pointer PR no longer matches the exact admitted base-advance recovery");

  let headSha = pull.head.sha;
  if (admission.state === "stale-base") {
    const baseCommit = await gh.request("GET", `/repos/${repoName(parent)}/git/commits/${candidate.devSha}`);
    if (!isSha(baseCommit?.tree?.sha)) throw new PointerTrustViolation("current parent dev tree is inaccessible during pointer recovery");
    const tree = await gh.request("POST", `/repos/${repoName(parent)}/git/trees`, {
      base_tree: baseCommit.tree.sha,
      tree: [{ path: candidate.gitlink.path, mode: "160000", type: "commit", sha: candidate.releasedSha }]
    });
    if (!isSha(tree?.sha)) throw new PointerTrustViolation("GitHub did not return the pointer recovery tree SHA");
    const commit = await gh.request("POST", `/repos/${repoName(parent)}/git/commits`, {
      message: pointerCommitMessage(observation, plan),
      tree: tree.sha,
      parents: [admission.marker.headSha, candidate.devSha]
    });
    if (!isSha(commit?.sha)) throw new PointerTrustViolation("GitHub did not return the pointer recovery commit SHA");

    await assertObservationCurrent(observation);
    const [currentDev, currentBranch] = await Promise.all([
      optionalRefHead(parent, "dev"),
      optionalRefHead(parent, plan.branch)
    ]);
    pull = await gh.request("GET", `/repos/${repoName(parent)}/pulls/${pullNumber}`);
    if (currentDev !== candidate.devSha
        || currentBranch !== admission.marker.headSha
        || pull?.head?.sha !== admission.marker.headSha
        || String(pull?.body) !== admission.body
        || !await admitRecoverablePointerPull(parent, pull, expected)) {
      throw new PointerTrustViolation("pointer recovery refs or PR changed before non-force update; preserved existing work");
    }
    try {
      await gh.request("PATCH", `/repos/${repoName(parent)}/git/refs/heads/${encodeURIComponent(plan.branch)}`, {
        sha: commit.sha,
        force: false
      });
    } catch (error) {
      throw new PointerTrustViolation(`pointer base-advance update conflicted; preserved existing work (${Number(error?.status) || "unknown"})`);
    }
    const [verifiedDev, verifiedBranch] = await Promise.all([
      optionalRefHead(parent, "dev"),
      optionalRefHead(parent, plan.branch)
    ]);
    if (verifiedDev !== candidate.devSha || verifiedBranch !== commit.sha) {
      throw new PointerTrustViolation("pointer recovery did not retain the exact admitted parent and branch refs");
    }
    await verifyPointerBranch(parent, candidate, plan, commit.sha, {
      priorHead: admission.marker.headSha,
      requireTreeSha: true,
      expectedTreeSha: tree.sha
    });
    headSha = commit.sha;
  }

  await assertObservationCurrent(observation);
  pull = await gh.request("GET", `/repos/${repoName(parent)}/pulls/${pullNumber}`);
  if (String(pull?.body) !== admission.body) {
    throw new PointerTrustViolation("pointer PR body changed before provenance update; preserved the concurrent edit");
  }
  const interrupted = await admitRecoverablePointerPull(parent, pull, expected);
  if (!interrupted || interrupted.state !== "interrupted-provenance" || pull.head.sha !== headSha) {
    throw new PointerTrustViolation("pointer PR is not the exact interrupted recovery immediately before provenance update");
  }
  const body = pointerPullBody(observation, plan, headSha);
  await gh.request("PATCH", `/repos/${repoName(parent)}/pulls/${pullNumber}`, { body });
  const latest = await gh.request("GET", `/repos/${repoName(parent)}/pulls/${pullNumber}`);
  if (latest?.state !== "open" || latest?.draft === true
      || latest?.title !== pointerPullTitle(candidate)
      || latest?.html_url !== `https://github.com/${repoName(parent)}/pull/${pullNumber}`
      || String(latest?.body) !== body
      || await optionalRefHead(parent, plan.branch) !== headSha) {
    throw new PointerTrustViolation("pointer PR provenance update did not retain the exact admitted PR and branch");
  }
  assertTrustedPullHead(latest, candidate, plan, headSha);
  await verifyPointerBranch(parent, candidate, plan, headSha, {
    priorHead: admission.marker.headSha,
    requireTreeSha: true
  });
  return pointerPullResult(latest, candidate, plan, "waiting-for-validation");
}

export async function finalizeSubmoduleUpdate(observation, plan, validation) {
  if (plan.action !== "update") throw new Error(`submodule plan is not verifiable: ${plan.action}`);
  const candidate = observation.candidate;
  const parent = parseRepo(candidate.repository);
  const pull = candidate.trustedPull;
  if (!pull) return { status: "blocked", reason: "trusted-pointer-pr-missing" };
  assertTrustedPullHead(pull, candidate, plan);
  if (!validation || validation.headSha !== pull.head.sha || !/^https:\/\/github\.com\/.+\/actions\/runs\/[1-9][0-9]*$/.test(validation.runUrl || "")) {
    return { status: "blocked", reason: "least-privilege-validation-receipt-missing-or-stale" };
  }
  await verifyPointerBranch(parent, candidate, plan, pull.head.sha);
  await assertObservationCurrent(observation);
  const currentPull = await gh.request("GET", `/repos/${repoName(parent)}/pulls/${pull.number}`);
  assertTrustedPullHead(currentPull, candidate, plan);
  if (currentPull.state !== "open" || currentPull.draft === true) return { status: "blocked", reason: "pointer-pr-not-open-and-ready" };
  const protection = await optionalProtection(parent, "dev");
  const checks = evaluateRequiredChecks(
    protection,
    await gh.request("GET", `/repos/${repoName(parent)}/commits/${currentPull.head.sha}/check-runs?per_page=100`),
    await gh.request("GET", `/repos/${repoName(parent)}/commits/${currentPull.head.sha}/status`),
    loadSubmodulePolicy().requiredChecks
  );
  if (!checks.green) return { status: "waiting-for-green", pull_request: currentPull.html_url, checks, validation };
  await assertObservationCurrent(observation);
  const latestPull = await gh.request("GET", `/repos/${repoName(parent)}/pulls/${pull.number}`);
  assertTrustedPullHead(latestPull, candidate, plan);
  if (latestPull.head.sha !== validation.headSha) throw new Error("pointer PR changed after least-privilege validation");
  if (!latestPull.auto_merge) {
    if (typeof gh.graphql !== "function" || !latestPull.node_id) throw new Error("GitHub auto-merge authority is unavailable");
    await gh.graphql(
      `mutation EnablePointerAutoMerge($pullRequestId: ID!) {
        enablePullRequestAutoMerge(input: {pullRequestId: $pullRequestId, mergeMethod: MERGE}) {
          pullRequest { url autoMergeRequest { enabledAt } }
        }
      }`,
      { pullRequestId: latestPull.node_id }
    );
  }
  return { status: "automerge-armed", pull_request: latestPull.html_url, head_sha: latestPull.head.sha, checks, validation };
}

async function dispatchParentRelease(observation, plan) {
  const candidate = observation.candidate;
  const previous = await readOptionalLedger("df-submodule-update", candidate.repository);
  if (previous?.plan?.planId === plan.planId && previous?.action?.status === "release-dispatched") {
    return { status: "waiting-for-parent-release", reason: "exact-release-dispatch-already-recorded" };
  }
  await assertObservationCurrent(observation);
  await gh.request("POST", `/repos/${repoName(controlRepo)}/actions/workflows/df-release.yml/dispatches`, {
    ref: "main",
    inputs: { repo: candidate.repository, mode: "run" }
  });
  return { status: "release-dispatched", repository: candidate.repository, main_pointer: candidate.mainPointer, dev_pointer: candidate.devPointer };
}

async function completeReleasedPointer(observation, plan) {
  const candidate = observation.candidate;
  const parent = parseRepo(candidate.repository);
  await assertObservationCurrent(observation);
  const issues = await listAll(`/repos/${repoName(parent)}/issues?state=open&per_page=100`);
  const exactIds = new Set([
    `submodule-${slug(candidate.gitlink.path)}-pointer-drift-main`,
    `submodule-${slug(candidate.gitlink.path)}-pointer-drift-dev`
  ]);
  const closed = [];
  for (const issue of issues) {
    if (issue.pull_request || normalizeWorkerPullRequestActor(issue.user) === null) continue;
    const marker = String(issue.body || "").match(/<!-- df-doctor:[a-z0-9-]+:([a-z0-9-]+) -->/i);
    if (!marker || !exactIds.has(marker[1])) continue;
    await gh.request("POST", `/repos/${repoName(parent)}/issues/${issue.number}/comments`, {
      body: `Released pointer verified on both protected parent branches: \`${candidate.releasedSha}\`. Release receipt: ${observation.childRelease.receiptUrl}.`
    });
    await gh.request("PATCH", `/repos/${repoName(parent)}/issues/${issue.number}`, { state: "closed" });
    closed.push(issue.html_url || `#${issue.number}`);
  }
  return {
    status: "released",
    verified: true,
    parent: candidate.repository,
    child: observation.child,
    path: candidate.gitlink.path,
    sha: candidate.releasedSha,
    closed_doctor_findings: closed,
    downstream_handoff: "darkfactory-release-verified"
  };
}

async function assertObservationCurrent(observation) {
  const candidate = observation.candidate;
  const parent = parseRepo(candidate.repository);
  const child = parseRepo(observation.child);
  const childBranch = observation.childRelease.branch || releasedBranchForChild(child, runtimeOptions.policy || loadSubmodulePolicy());
  const [mainSha, devSha, mainPointer, devPointer, childHead] = await Promise.all([
    optionalRefHead(parent, "main"),
    optionalRefHead(parent, "dev"),
    getSubmoduleCommit(parent, candidate.gitlink.path, "main"),
    getSubmoduleCommit(parent, candidate.gitlink.path, "dev"),
    gh.request("GET", `/repos/${repoName(child)}/commits/${encodeURIComponent(childBranch)}`)
  ]);
  if (mainSha !== candidate.mainSha || devSha !== candidate.devSha
      || mainPointer !== candidate.mainPointer || devPointer !== candidate.devPointer
      || childHead?.sha !== candidate.releasedSha) {
    throw new Error("submodule evidence changed; replan before mutation");
  }
}

async function verifyPointerBranch(parent, candidate, plan, headSha, options = {}) {
  if (!isSha(headSha)) throw new Error("pointer branch head is invalid");
  const [commit, gitCommit, pointer, relation] = await Promise.all([
    gh.request("GET", `/repos/${repoName(parent)}/commits/${headSha}`),
    gh.request("GET", `/repos/${repoName(parent)}/git/commits/${headSha}`),
    getSubmoduleCommit(parent, candidate.gitlink.path, headSha),
    compare(parent, candidate.devSha, headSha)
  ]);
  const expectedParents = options.priorHead
    ? [options.priorHead, candidate.devSha]
    : [candidate.devSha];
  const actualParents = Array.isArray(gitCommit?.parents) ? gitCommit.parents.map((item) => item?.sha) : [];
  if (normalizeWorkerPullRequestActor(commit?.author) === null
      || gitCommit?.message !== pointerCommitMessage({ child: candidateChild(candidate), candidate }, plan)
      || JSON.stringify(actualParents) !== JSON.stringify(expectedParents)
      || (options.requireTreeSha && (!isSha(commit?.sha) || commit.sha !== headSha
        || !isSha(gitCommit?.sha) || gitCommit.sha !== headSha
        || !isSha(gitCommit?.tree?.sha)))
      || (options.expectedTreeSha && gitCommit?.tree?.sha !== options.expectedTreeSha)
      || pointer !== candidate.releasedSha
      || relation?.status !== "ahead" || relation.ahead_by !== 1 || relation.behind_by !== 0
      || !Array.isArray(relation.files) || relation.files.length !== 1 || relation.files[0]?.filename !== candidate.gitlink.path) {
    throw new PointerTrustViolation("submodule update branch is not the exact App-owned one-gitlink plan");
  }
}

function candidateChild(candidate) {
  const resolved = resolveSubmoduleRepo(parseRepo(candidate.repository), candidate.gitlink.url);
  return resolved ? repoName(resolved) : "";
}

function pointerCommitMessage(observation, plan) {
  return `Update ${observation.candidate.gitlink.path} to ${observation.candidate.releasedSha}\n\nDarkFactory-Submodule-Plan: ${plan.planId}`;
}

function pointerPullTitle(candidate) {
  return `Update ${candidate.gitlink.name} to ${candidate.releasedSha.slice(0, 12)}`;
}

function pointerPullBody(observation, plan, headSha) {
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

function pointerPullResult(pull, candidate, plan, status) {
  return {
    status,
    parent: candidate.repository,
    child: candidateChild(candidate),
    path: candidate.gitlink.path,
    branch: plan.branch,
    head_sha: pull.head.sha,
    pull_number: pull.number,
    pull_request: pull.html_url
  };
}

function assertTrustedPullHead(pull, candidate, plan, expectedHead = pull?.head?.sha) {
  const parent = candidate.repository;
  if (!isTrustedPointerPull(parseRepo(parent), pull, {
    path: candidate.gitlink.path,
    child: candidateChild(candidate),
    releasedSha: candidate.releasedSha,
    policy: loadSubmodulePolicy(),
    planId: plan.planId,
    parentSha: candidate.devSha,
    headSha: expectedHead
  })) throw new Error("pointer pull request identity does not match the exact App-owned plan");
}

export function isTrustedPointerPull(parent, pull, expected) {
  const marker = parsePointerPullMarker(pull?.body);
  if (!marker || normalizeWorkerPullRequestActor(pull?.user) === null) return false;
  return pull?.base?.ref === "dev"
    && String(pull?.head?.repo?.full_name || "").toLowerCase() === repoName(parent).toLowerCase()
    && String(pull?.head?.ref || "").startsWith(expected.policy.branchPrefix)
    && pull?.head?.sha === marker.headSha
    && marker.child.toLowerCase() === expected.child.toLowerCase()
    && (!expected.oldSha || marker.oldSha === expected.oldSha)
    && marker.releasedSha === expected.releasedSha
    && marker.path === expected.path
    && (!expected.planId || marker.planId === expected.planId)
    && (!expected.parentSha || marker.parentSha === expected.parentSha)
    && (!expected.branch || pull?.head?.ref === expected.branch)
    && (!expected.headSha || marker.headSha === expected.headSha);
}

function parsePointerPullMarker(body) {
  const matches = String(body || "").match(
    /<!-- darkfactory:submodule-update plan=(submodule-[0-9a-f]{20}) parent=([0-9a-f]{40}) child=([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+) old=([0-9a-f]{40}) new=([0-9a-f]{40}) path=([A-Za-z0-9_.\/-]+) head=([0-9a-f]{40}) -->/g
  ) || [];
  if (matches.length !== 1) return null;
  const marker = matches[0].match(
    /^<!-- darkfactory:submodule-update plan=(submodule-[0-9a-f]{20}) parent=([0-9a-f]{40}) child=([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+) old=([0-9a-f]{40}) new=([0-9a-f]{40}) path=([A-Za-z0-9_.\/-]+) head=([0-9a-f]{40}) -->$/
  );
  if (!marker) return null;
  return {
    planId: marker[1],
    parentSha: marker[2],
    child: marker[3],
    oldSha: marker[4],
    releasedSha: marker[5],
    path: marker[6],
    headSha: marker[7]
  };
}

export function classifyPointerState(mainPointer, devPointer, releasedSha, relation) {
  if (!mainPointer || !devPointer || !releasedSha) return "blocked";
  if (mainPointer === releasedSha && devPointer === releasedSha) return "released";
  if (devPointer === releasedSha && mainPointer !== releasedSha) return "merged";
  if (mainPointer === releasedSha && devPointer !== releasedSha) return "blocked";
  if (isForwardOrIdentical(relation) && relation.status === "ahead") return "behind";
  if (relation?.status === "identical") return "current";
  return "blocked";
}

function submodulePlanEvidence(observation) {
  const candidate = observation.candidate;
  return {
    child: observation.child || null,
    child_sha: observation.childRelease?.sha || null,
    parent: candidate?.repository || null,
    parent_main: candidate?.mainSha || null,
    parent_dev: candidate?.devSha || null,
    path: candidate?.gitlink?.path || null,
    main_pointer: candidate?.mainPointer || null,
    dev_pointer: candidate?.devPointer || null,
    pointer_state: observation.pointerState,
    receipt: observation.childRelease?.receiptUrl || null
  };
}

function submodulePlanId(evidence) {
  return `submodule-${createHash("sha256").update(JSON.stringify(evidence)).digest("hex").slice(0, 20)}`;
}

export function parseGitmodules(content) {
  const entries = [];
  let current = null;
  for (const rawLine of String(content || "").replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const section = line.match(/^\[submodule\s+"([^"]+)"\]$/);
    if (section) {
      if (current) entries.push(current);
      current = { name: section[1], path: "", url: "", branch: "" };
      continue;
    }
    const pair = current && line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!pair) continue;
    const key = pair[1].toLowerCase();
    if (["path", "url", "branch"].includes(key)) current[key] = pair[2].trim();
  }
  if (current) entries.push(current);
  return entries;
}

export function resolveSubmoduleRepo(parent, url) {
  const value = String(url || "").trim();
  const github = value.match(/^(?:https?:\/\/github\.com\/|git@github\.com:|github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (github) return { owner: github[1], repo: github[2] };
  if (/^\.\.?(?:\/|$)/.test(value)) {
    try {
      const segments = new URL(value, `https://github.com/${repoName(parent)}/`).pathname.split("/").filter(Boolean);
      if (segments.length === 2) return { owner: segments[0], repo: segments[1].replace(/\.git$/, "") };
    } catch { return null; }
  }
  return null;
}

export function inspectLocalCheckout(localPath, expectedRepository) {
  const blockers = [];
  const resolved = path.resolve(localPath);
  const origin = runGit(resolved, ["remote", "get-url", "origin"]);
  const expected = expectedRepository ? parseRepo(expectedRepository) : null;
  const actual = expected ? resolveSubmoduleRepo(expected, origin.stdout.trim()) : null;
  if (!origin.ok || !actual || repoName(actual).toLowerCase() !== expectedRepository.toLowerCase()) blockers.push("local-parent-origin-mismatch");
  const rootStatus = runGit(resolved, ["status", "--porcelain=v2", "--untracked-files=all"]);
  if (!rootStatus.ok) blockers.push("local-parent-state-unobservable");
  else if (rootStatus.stdout.trim()) blockers.push("local-parent-dirty");
  const submodules = runGit(resolved, ["submodule", "status", "--recursive"]);
  if (!submodules.ok) blockers.push("local-submodule-state-unobservable");
  else if (submodules.stdout.split(/\r?\n/).filter(Boolean).some((line) => /^[-+U]/.test(line))) blockers.push("local-submodule-dirty-or-diverged");
  return { observed: true, clean: blockers.length === 0, blockers: [...new Set(blockers)].sort() };
}

function runGit(cwd, args) {
  try {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: 30_000 });
    return { ok: result.status === 0, stdout: result.stdout || "" };
  } catch { return { ok: false, stdout: "" }; }
}

function validateBoundProtection(protection, requiredChecks, prefix) {
  const blockers = [];
  if (!protection) return [`${prefix}-protection-missing`];
  if (protection.enforce_admins?.enabled !== true
      || protection.allow_force_pushes?.enabled !== false
      || protection.allow_deletions?.enabled !== false
      || protection.required_status_checks?.strict !== true) blockers.push(`${prefix}-protection-unsafe`);
  const bindings = new Map(requiredCheckBindings(protection).map((item) => [item.context, item.appId]));
  for (const name of requiredChecks) if (bindings.get(name) !== TRUSTED_GATE_APP_ID) blockers.push(`${prefix}-gate-not-app-bound:${name}`);
  return blockers;
}

function requiredCheckBindings(protection) {
  const checks = Array.isArray(protection?.required_status_checks?.checks) ? protection.required_status_checks.checks : [];
  const contexts = Array.isArray(protection?.required_status_checks?.contexts) ? protection.required_status_checks.contexts : [];
  const out = checks.map((item) => ({ context: item?.context, appId: Number.isInteger(item?.app_id) ? item.app_id : null }));
  for (const context of contexts) if (!out.some((item) => item.context === context)) out.push({ context, appId: null });
  return out.filter((item) => typeof item.context === "string" && item.context);
}

function summarizeProtection(protection) {
  return protection ? {
    strict: protection.required_status_checks?.strict === true,
    checks: requiredCheckBindings(protection),
    administrators_enforced: protection.enforce_admins?.enabled === true,
    force_push_blocked: protection.allow_force_pushes?.enabled === false,
    deletion_blocked: protection.allow_deletions?.enabled === false
  } : null;
}

async function optionalProtection(repository, branch) {
  try { return await gh.request("GET", `/repos/${repoName(repository)}/branches/${encodeURIComponent(branch)}/protection`); }
  catch (error) { if ([403, 404].includes(error.status)) return null; throw error; }
}

async function observeAutoMerge(repository, restValue) {
  if (typeof restValue === "boolean") return restValue;
  if (typeof gh.graphql !== "function") return null;
  try {
    const result = await gh.graphql(
      `query SubmoduleAutoMerge($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) { autoMergeAllowed }
      }`,
      { owner: repository.owner, name: repository.repo }
    );
    return typeof result?.repository?.autoMergeAllowed === "boolean" ? result.repository.autoMergeAllowed : null;
  } catch {
    return null;
  }
}

async function optionalRefHead(repository, branch) {
  try {
    const ref = await gh.request("GET", `/repos/${repoName(repository)}/git/ref/heads/${encodeURIComponent(branch)}`);
    return isSha(ref?.object?.sha) ? ref.object.sha : null;
  } catch (error) { if ([404, 409].includes(error.status)) return null; throw error; }
}

async function getSubmoduleCommit(repository, gitlinkPath, ref) {
  try {
    const data = await gh.request("GET", `/repos/${repoName(repository)}/contents/${encodePath(gitlinkPath)}?ref=${encodeURIComponent(ref)}`);
    return data?.type === "submodule" && isSha(data.sha) ? data.sha : null;
  } catch (error) { if ([403, 404, 409].includes(error.status)) return null; throw error; }
}

async function compare(repository, base, head, options = {}) {
  try {
    return await gh.request("GET", `/repos/${repoName(repository)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
  } catch (error) {
    if (options.inaccessible && [403, 404, 409, 422].includes(error.status)) return { status: "unobservable", ahead_by: null, behind_by: null };
    throw error;
  }
}

function isForwardOrIdentical(comparison) {
  return isRecord(comparison)
    && Number.isInteger(comparison.ahead_by) && Number.isInteger(comparison.behind_by)
    && ((comparison.status === "identical" && comparison.ahead_by === 0 && comparison.behind_by === 0)
      || (comparison.status === "ahead" && comparison.ahead_by > 0 && comparison.behind_by === 0));
}

async function listAll(requestPath) {
  const out = [];
  for (let page = 1; page <= MAX_PAGINATION_PAGES; page += 1) {
    const separator = requestPath.includes("?") ? "&" : "?";
    const batch = await gh.request("GET", `${requestPath}${separator}page=${page}`);
    if (!Array.isArray(batch)) throw new Error(`GitHub returned malformed pagination for ${requestPath}`);
    out.push(...batch);
    if (batch.length < 100) return out;
  }
  throw new Error(`GitHub pagination exceeded ${MAX_PAGINATION_PAGES} pages for ${requestPath}`);
}

async function findExactOpenPointerPull(parent, candidate, plan, headSha) {
  const pulls = await listAll(`/repos/${repoName(parent)}/pulls?state=open&base=dev&per_page=100`);
  const matches = [];
  for (const summary of pulls) {
    const pull = await gh.request("GET", `/repos/${repoName(parent)}/pulls/${summary.number}`);
    if (isTrustedPointerPull(parent, pull, {
      path: candidate.gitlink.path,
      child: candidateChild(candidate),
      releasedSha: candidate.releasedSha,
      oldSha: candidate.devPointer,
      parentSha: candidate.devSha,
      headSha,
      branch: plan.branch,
      planId: plan.planId,
      policy: loadSubmodulePolicy()
    })) matches.push(pull);
  }
  if (matches.length > 1) throw new Error("multiple exact trusted pointer PRs appeared during creation");
  return matches[0] || null;
}

async function writeSubmoduleLedger(plan, kind, payload) {
  const target = plan.evidence.parent || plan.evidence.child || "fleet";
  return await writeRunLedger(ledgerGh, DARK_FACTORY_DATA_REPO, kind, target, payload);
}

async function readOptionalLedger(kind, target) {
  try {
    return await readLatestRunLedger(ledgerGh, DARK_FACTORY_DATA_REPO, kind, target);
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

function publicObservation(observation) {
  return {
    child: observation.child,
    child_release: observation.childRelease ? {
      repository: observation.childRelease.repository,
      branch: observation.childRelease.branch || null,
      sha: observation.childRelease.sha || null,
      receipt: observation.childRelease.receiptUrl || null,
      main_checks: observation.childRelease.mainChecks || null
    } : null,
    parent: observation.candidate ? {
      repository: observation.candidate.repository,
      path: observation.candidate.gitlink?.path || null,
      name: observation.candidate.gitlink?.name || null,
      main_sha: observation.candidate.mainSha,
      dev_sha: observation.candidate.devSha,
      main_pointer: observation.candidate.mainPointer,
      dev_pointer: observation.candidate.devPointer,
      released_sha: observation.candidate.releasedSha,
      relation: summarizeComparison(observation.candidate.relation),
      pointer_state: observation.candidate.pointerState,
      pull_request: observation.candidate.trustedPull?.html_url
        || observation.candidate.recoverablePull?.pull?.html_url
        || null,
      evidence: observation.candidate.evidence
    } : null,
    local: observation.local || null,
    blockers: observation.blockers || []
  };
}

function summarizeComparison(comparison) {
  return isRecord(comparison) ? {
    status: typeof comparison.status === "string" ? comparison.status : "unobservable",
    ahead_by: Number.isInteger(comparison.ahead_by) ? comparison.ahead_by : null,
    behind_by: Number.isInteger(comparison.behind_by) ? comparison.behind_by : null
  } : null;
}

function isSafeGitlinkPath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 240
    && !value.startsWith("/") && !value.endsWith("/") && !value.includes("\\")
    && value.split("/").every((segment) => segment && segment !== "." && segment !== ".." && /^[A-Za-z0-9_.-]+$/.test(segment));
}

function encodePath(filePath) {
  return filePath.split("/").map(encodeURIComponent).join("/");
}

function isSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertRuntime() {
  if (!gh || !ledgerGh || !controlRepo) throw new Error("DarkFactory submodule runtime is not configured");
}
