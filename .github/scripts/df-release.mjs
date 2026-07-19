import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  DARK_FACTORY_DATA_REPO,
  createGithubClient,
  extractClosingIssueNumbers,
  getOptionalFileContent,
  isParkedRepo,
  listActiveManagedRepos,
  managedRepoLifecycleState,
  normalizeWorkerPullRequestActor,
  parseRepo,
  readManagedRepoRegistry,
  repoName,
  requiredEnv,
  writeRunLedger
} from "./df-lib.mjs";

export const RELEASE_POLICY_PATH = ".darkfactory/release-policy.json";
export const RELEASE_MODES = new Set(["status", "plan", "reconcile", "run", "verify"]);
const DATA_REPOSITORIES = new Set([
  "marius-patrik/andromeda-data",
  "marius-patrik/darkfactory-data"
]);
const ACTIONS_APP_ID = 15368;
const MAX_PAGINATION_PAGES = 100;
const MAX_CHECK_SUITES = 100;
const MAX_CHECK_RUNS = 2000;
const MAX_COMMIT_STATUSES = 2000;
const TRUSTED_POLICY_WORKFLOWS = Object.freeze({
  "Validate": Object.freeze({
    path: ".github/workflows/ci.yml",
    refs: Object.freeze(["main", "dev", "refs/heads/main", "refs/heads/dev"]),
    events: Object.freeze(["pull_request", "push"])
  }),
  "DarkFactory Autoreview": Object.freeze({
    path: ".github/workflows/darkfactory-autoreview.yml",
    refs: Object.freeze(["main", "dev", "refs/heads/main", "refs/heads/dev"]),
    events: Object.freeze(["pull_request_target", "workflow_dispatch"])
  })
});
let gh;
let ledgerGh;
let controlRepo;

export function configureReleaseRuntime(options) {
  gh = options.gh;
  ledgerGh = options.ledgerGh || options.gh;
  controlRepo = options.controlRepo || { owner: "marius-patrik", repo: "DarkFactory" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const token = process.env.DARK_FACTORY_TOKEN || "";
    console.error(String(error.stack || error.message || error).split(token).join("***"));
    process.exitCode = 1;
  });
}

async function main() {
  const token = requiredEnv("DARK_FACTORY_TOKEN");
  configureReleaseRuntime({
    gh: createGithubClient(token, "darkfactory-release"),
    controlRepo: parseRepo(process.env.DF_CONTROL_REPO || "marius-patrik/DarkFactory")
  });
  const mode = process.env.DF_RELEASE_MODE || "run";
  const target = process.env.DF_RELEASE_REPO?.trim();
  const targets = target
    ? [parseRepo(target)]
    : uniqueRepositories([controlRepo, ...await listActiveManagedRepos(gh, controlRepo)]);
  const results = [];
  for (const repository of targets) {
    if (DATA_REPOSITORIES.has(repoName(repository).toLowerCase())) {
      results.push({ repository: repoName(repository), status: "skipped", reason: "main-only-data" });
      continue;
    }
    try {
      results.push(await runReleaseCommand({ mode, repository }));
    } catch (error) {
      results.push({ repository: repoName(repository), status: "failed", error: error.message || String(error) });
      if (target) throw error;
    }
  }
  console.log(JSON.stringify({ schemaVersion: 1, mode, results }, null, 2));
  if (fleetReleaseHasBlockedResult(results)) process.exitCode = 1;
}

export function fleetReleaseHasBlockedResult(results) {
  return results.some((result) => ["failed", "blocked", "owner-required"].includes(String(result?.status || "")));
}

export function validateReleasePolicy(value) {
  if (!isRecord(value) || value.schemaVersion !== 1) throw new Error("release policy must declare schemaVersion 1");
  const expected = [
    "schemaVersion", "enabled", "mode", "releaseBranchPrefix", "reconcileBranchPrefix",
    "requiredChecks", "mainChecks", "tagPattern", "artifactWorkflows", "publicationChecks", "producer"
  ].sort();
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expected)) {
    throw new Error("release policy has unknown or missing properties");
  }
  if (value.enabled !== true && value.enabled !== false) throw new Error("release policy enabled must be boolean");
  if (!["branch-only", "tagged", "packaged", "artifact", "deployed"].includes(value.mode)) {
    throw new Error("release policy mode is unsupported");
  }
  for (const [name, prefix] of [["releaseBranchPrefix", value.releaseBranchPrefix], ["reconcileBranchPrefix", value.reconcileBranchPrefix]]) {
    if (typeof prefix !== "string" || !/^[a-z][a-z0-9-]*\/$/.test(prefix)) throw new Error(`release policy ${name} is invalid`);
  }
  for (const name of ["requiredChecks", "mainChecks", "artifactWorkflows", "publicationChecks"]) {
    if (!Array.isArray(value[name]) || value[name].some((item) => typeof item !== "string" || !item.trim())) {
      throw new Error(`release policy ${name} must contain nonblank strings`);
    }
    if (new Set(value[name]).size !== value[name].length) throw new Error(`release policy ${name} must be unique`);
  }
  if (!value.requiredChecks.includes("Validate") || !value.requiredChecks.includes("DarkFactory Autoreview")) {
    throw new Error("release policy must require Validate and DarkFactory Autoreview");
  }
  if (!value.mainChecks.includes("Validate")) throw new Error("release policy mainChecks must include Validate");
  if (value.mode === "branch-only" && value.tagPattern !== null) throw new Error("branch-only release policy cannot declare a tag pattern");
  if (value.mode !== "branch-only" && (typeof value.tagPattern !== "string" || !value.tagPattern.trim())) {
    throw new Error("non-branch-only release policy requires a tag pattern");
  }
  if (value.mode === "branch-only" && value.producer !== null) throw new Error("branch-only release policy cannot declare a producer");
  if (value.mode !== "branch-only") validateProducer(value.producer);
  return Object.freeze({ ...value });
}

function validateProducer(producer) {
  if (!isRecord(producer)
      || JSON.stringify(Object.keys(producer).sort()) !== JSON.stringify(["inputs", "maxAttempts", "ref", "workflow"])
      || typeof producer.workflow !== "string"
      || !/^[A-Za-z0-9_.-]+\.ya?ml$/.test(producer.workflow)
      || producer.ref !== "main"
      || !Number.isInteger(producer.maxAttempts) || producer.maxAttempts < 1 || producer.maxAttempts > 5
      || !isRecord(producer.inputs)
      || Object.entries(producer.inputs).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) || typeof value !== "string")) {
    throw new Error("non-branch-only release policy requires an exact trusted workflow producer");
  }
}

export function classifyConvergence(mainSha, devSha, comparison, mainTreeSha = null, devTreeSha = null) {
  if (!mainSha && !devSha) return "missing-both";
  if (!mainSha) return "missing-main";
  if (!devSha) return "missing-dev";
  if (mainSha === devSha) return "identical";
  if (mainTreeSha && devTreeSha && mainTreeSha === devTreeSha) return "tree-identical";
  if (!isRecord(comparison)
      || !["ahead", "behind", "diverged", "identical"].includes(comparison.status)
      || !Number.isInteger(comparison.ahead_by)
      || !Number.isInteger(comparison.behind_by)) {
    return "unobservable";
  }
  if (comparison.status === "identical" && comparison.ahead_by === 0 && comparison.behind_by === 0) return "identical";
  if (comparison.status === "ahead" && comparison.ahead_by > 0 && comparison.behind_by === 0) return "dev-ahead";
  if (comparison.status === "behind" && comparison.behind_by > 0 && comparison.ahead_by === 0) return "main-ahead";
  if (comparison.status === "diverged" && comparison.ahead_by > 0 && comparison.behind_by > 0) return "diverged";
  return "unobservable";
}

export function evaluateRequiredChecks(protection, checkRuns, statuses, policyChecks) {
  const required = requiredCheckBindings(protection);
  const policyNames = new Set(policyChecks);
  const expected = new Map(policyChecks.map((name) => [name, ACTIONS_APP_ID]));
  for (const binding of required) {
    expected.set(
      binding.context,
      policyNames.has(binding.context) ? ACTIONS_APP_ID : (binding.appId ?? null)
    );
  }
  const latest = new Map();
  for (const run of Array.isArray(checkRuns?.check_runs) ? checkRuns.check_runs : []) {
    if (typeof run?.name !== "string") continue;
    const candidates = latest.get(run.name) ?? [];
    candidates.push({
      appId: Number.isInteger(run?.app?.id) ? run.app.id : null,
      id: Number.isInteger(run?.id) ? run.id : null,
      url: typeof run?.html_url === "string" ? run.html_url : null,
      state: run?._trustedPolicyWorkflow === false
        ? "red"
        : run.status === "completed" && run.conclusion === "success"
        ? "green"
        : run.status === "completed" ? "red" : "pending"
    });
    latest.set(run.name, candidates);
  }
  for (const status of Array.isArray(statuses?.statuses) ? statuses.statuses : []) {
    if (typeof status?.context !== "string" || latest.has(status.context)) continue;
    latest.set(status.context, [{
      appId: null,
      id: Number.isInteger(status?.id) ? status.id : null,
      url: typeof status?.target_url === "string" ? status.target_url : null,
      state: status.state === "success" ? "green" : status.state === "pending" ? "pending" : "red"
    }]);
  }
  const checks = [...expected].map(([name, expectedAppId]) => {
    const candidates = latest.get(name) ?? [];
    const matching = expectedAppId === null
      ? candidates
      : candidates.filter((candidate) => candidate.appId === expectedAppId);
    const actual = matching[0] ?? candidates[0];
    const ambiguous = matching.length > 1;
    const appBound = expectedAppId === null || actual?.appId === expectedAppId;
    return {
      name, expectedAppId, actualAppId: actual?.appId ?? null,
      id: actual?.id ?? null, url: actual?.url ?? null,
      state: actual ? (appBound && !ambiguous ? actual.state : "red") : "missing"
    };
  });
  return {
    checks,
    green: checks.length > 0 && checks.every((check) => check.state === "green"),
    missing: checks.filter((check) => check.state === "missing").map((check) => check.name),
    pending: checks.filter((check) => check.state === "pending").map((check) => check.name),
    red: checks.filter((check) => check.state === "red").map((check) => check.name)
  };
}

export function evaluatePolicySelectedChecks(checkRuns, statuses, policyChecks) {
  return evaluateRequiredChecks({
    required_status_checks: {
      checks: policyChecks.map((context) => ({ context, app_id: ACTIONS_APP_ID }))
    }
  }, checkRuns, statuses, policyChecks);
}

export async function listCompleteCheckRuns(repository, sha) {
  const first = await scanCompleteCheckRuns(repository, sha);
  const second = await scanCompleteCheckRuns(repository, sha);
  if (first.fingerprint !== second.fingerprint) {
    throw new Error("release check-run inventory changed during verification");
  }
  return second.payload;
}

async function scanCompleteCheckRuns(repository, sha) {
  const suites = await listCompleteCheckSuitesOnce(repository, sha);
  const checkRuns = [];
  const seen = new Set();
  for (const suite of suites.check_suites) {
    const payload = await listCompleteSuiteCheckRunsOnce(repository, sha, suite.id);
    for (const run of payload.check_runs) {
      if (seen.has(run.id)) throw new Error("release check-run inventory contains duplicate evidence across suites");
      seen.add(run.id);
      checkRuns.push({
        ...run,
        _checkSuiteEvidence: {
          id: suite.id,
          appId: suite.app.id,
          status: suite.status ?? null,
          conclusion: suite.conclusion ?? null,
          latestCheckRunsCount: suite.latest_check_runs_count ?? null,
          enumeratedCheckRunsCount: payload.check_runs.length
        }
      });
      if (checkRuns.length > MAX_CHECK_RUNS) {
        throw new Error("release check-run inventory exceeds the bounded limit");
      }
    }
  }
  const suiteEvidence = suites.check_suites.map((suite) => ({
    id: suite.id,
    headSha: suite.head_sha,
    appId: suite.app.id,
    status: suite.status ?? null,
    conclusion: suite.conclusion ?? null,
    latestCheckRunsCount: suite.latest_check_runs_count ?? null
  })).sort((left, right) => left.id - right.id);
  const runEvidence = checkRuns.map((run) => ({
    id: run.id,
    suiteId: run.check_suite.id,
    headSha: run.head_sha,
    name: run.name,
    appId: run.app?.id ?? null,
    status: run.status ?? null,
    conclusion: run.conclusion ?? null,
    url: run.html_url ?? null
  })).sort((left, right) => left.id - right.id);
  return {
    payload: { total_count: checkRuns.length, check_runs: checkRuns },
    fingerprint: JSON.stringify({ suites: suiteEvidence, runs: runEvidence })
  };
}

async function listCompleteCheckSuitesOnce(repository, sha) {
  const suites = [];
  const seen = new Set();
  let totalCount = null;
  for (let page = 1; page <= MAX_PAGINATION_PAGES; page += 1) {
    const payload = await gh.request(
      "GET",
      `/repos/${repoName(repository)}/commits/${sha}/check-suites?filter=all&per_page=100&page=${page}`
    );
    if (!isRecord(payload)
        || !Number.isSafeInteger(payload.total_count) || payload.total_count < 0 || payload.total_count > MAX_CHECK_SUITES
        || !Array.isArray(payload.check_suites) || payload.check_suites.length > 100) {
      throw new Error("release check-suite inventory is malformed or exceeds the bounded limit");
    }
    totalCount ??= payload.total_count;
    if (payload.total_count !== totalCount) throw new Error("release check-suite inventory changed during pagination");
    for (const suite of payload.check_suites) {
      if (!isRecord(suite)
          || !Number.isSafeInteger(suite.id) || suite.id < 1 || seen.has(suite.id)
          || suite.head_sha !== sha
          || !Number.isSafeInteger(suite?.app?.id) || suite.app.id < 1) {
        throw new Error("release check-suite inventory contains malformed or duplicate evidence");
      }
      seen.add(suite.id);
      suites.push(suite);
    }
    if (suites.length > totalCount) throw new Error("release check-suite inventory exceeds its declared total");
    if (suites.length === totalCount) return { total_count: totalCount, check_suites: suites };
    if (payload.check_suites.length < 100) throw new Error("release check-suite inventory is truncated");
  }
  throw new Error("release check-suite inventory exceeded the bounded page limit");
}

async function listCompleteSuiteCheckRunsOnce(repository, sha, suiteId) {
  const runs = [];
  const seen = new Set();
  let totalCount = null;
  for (let page = 1; page <= MAX_PAGINATION_PAGES; page += 1) {
    const payload = await gh.request(
      "GET",
      `/repos/${repoName(repository)}/check-suites/${suiteId}/check-runs?filter=latest&per_page=100&page=${page}`
    );
    if (!isRecord(payload)
        || !Number.isSafeInteger(payload.total_count) || payload.total_count < 0 || payload.total_count > MAX_CHECK_RUNS
        || !Array.isArray(payload.check_runs) || payload.check_runs.length > 100) {
      throw new Error("release check-run inventory is malformed or exceeds the bounded limit");
    }
    totalCount ??= payload.total_count;
    if (payload.total_count !== totalCount) throw new Error("release check-run inventory changed during pagination");
    for (const run of payload.check_runs) {
      if (!isRecord(run)
          || !Number.isSafeInteger(run.id) || run.id < 1 || seen.has(run.id)
          || run.head_sha !== sha || run?.check_suite?.id !== suiteId) {
        throw new Error("release check-run inventory contains malformed or duplicate evidence");
      }
      seen.add(run.id);
      runs.push(run);
    }
    if (runs.length > totalCount) throw new Error("release check-run inventory exceeds its declared total");
    if (runs.length === totalCount) return { total_count: totalCount, check_runs: runs };
    if (payload.check_runs.length < 100) throw new Error("release check-run inventory is truncated");
  }
  throw new Error("release check-run inventory exceeded the bounded page limit");
}

export async function listCompleteCommitStatuses(repository, sha) {
  const first = await scanCompleteCommitStatuses(repository, sha);
  const second = await scanCompleteCommitStatuses(repository, sha);
  if (first.fingerprint !== second.fingerprint) {
    throw new Error("release commit-status inventory changed during verification");
  }
  return second.payload;
}

async function scanCompleteCommitStatuses(repository, sha) {
  const statuses = [];
  const seen = new Set();
  let totalCount = null;
  for (let page = 1; page <= MAX_PAGINATION_PAGES; page += 1) {
    const payload = await gh.request(
      "GET",
      `/repos/${repoName(repository)}/commits/${sha}/status?per_page=100&page=${page}`
    );
    if (!isRecord(payload)
        || payload.sha !== sha
        || !Number.isSafeInteger(payload.total_count) || payload.total_count < 0 || payload.total_count > MAX_COMMIT_STATUSES
        || !Array.isArray(payload.statuses) || payload.statuses.length > 100) {
      throw new Error("release commit-status inventory is malformed or exceeds the bounded limit");
    }
    totalCount ??= payload.total_count;
    if (payload.total_count !== totalCount) throw new Error("release commit-status inventory changed during pagination");
    for (const status of payload.statuses) {
      if (!isRecord(status) || !Number.isSafeInteger(status.id) || status.id < 1 || seen.has(status.id)) {
        throw new Error("release commit-status inventory contains malformed or duplicate evidence");
      }
      seen.add(status.id);
      statuses.push(status);
    }
    if (statuses.length > totalCount) throw new Error("release commit-status inventory exceeds its declared total");
    if (statuses.length === totalCount) {
      const evidence = statuses.map((status) => ({
        id: status.id,
        context: status.context ?? null,
        state: status.state ?? null,
        targetUrl: status.target_url ?? null,
        createdAt: status.created_at ?? null,
        updatedAt: status.updated_at ?? null
      })).sort((left, right) => left.id - right.id);
      return {
        payload: { total_count: totalCount, statuses },
        fingerprint: JSON.stringify(evidence)
      };
    }
    if (payload.statuses.length < 100) throw new Error("release commit-status inventory is truncated");
  }
  throw new Error("release commit-status inventory exceeded the bounded page limit");
}

export async function bindTrustedPolicyCheckRuns(repository, sha, payload, policyChecks, options = {}) {
  if (!isRecord(payload) || !Array.isArray(payload.check_runs)) {
    throw new Error("release check-run inventory is malformed");
  }
  const selected = new Set(policyChecks);
  const bound = [];
  for (const checkRun of payload.check_runs) {
    if (!selected.has(checkRun?.name) || checkRun?.app?.id !== ACTIONS_APP_ID) {
      bound.push(checkRun);
      continue;
    }
    const binding = TRUSTED_POLICY_WORKFLOWS[checkRun.name];
    if (!binding) {
      bound.push(checkRun);
      continue;
    }
    const trusted = await isTrustedPolicyWorkflowRun(
      repository, sha, checkRun, binding, options.expectedPull || null, options.expectedBranch || null
    );
    bound.push({ ...checkRun, _trustedPolicyWorkflow: trusted });
  }
  return { ...payload, check_runs: bound };
}

export async function observeReleaseState(repository) {
  assertRuntime();
  await assertReleaseTarget(repository);
  const rawMetadata = await gh.request("GET", `/repos/${repoName(repository)}`);
  if (rawMetadata?.archived === true || rawMetadata?.disabled === true) throw new Error("release target is archived or disabled");
  const autoMergeAllowed = await observeAutoMerge(repository, rawMetadata?.allow_auto_merge);
  const metadata = { ...rawMetadata, allow_auto_merge: autoMergeAllowed };
  const policyText = await getOptionalFileContent(gh, repository, RELEASE_POLICY_PATH, "main");
  if (!policyText) throw new Error(`release target is missing ${RELEASE_POLICY_PATH} on main`);
  let policy;
  try { policy = validateReleasePolicy(JSON.parse(policyText)); } catch (error) { throw new Error(`invalid release policy: ${error.message || String(error)}`); }
  if (!policy.enabled) return { repository: repoName(repository), metadata, policy, classification: "non-releasing" };
  const [mainSha, devSha, mainProtection, devProtection, pulls] = await Promise.all([
    optionalRefHead(repository, "main"),
    optionalRefHead(repository, "dev"),
    optionalProtection(repository, "main"),
    optionalProtection(repository, "dev"),
    listAll(`/repos/${repoName(repository)}/pulls?state=open&per_page=100`)
  ]);
  let comparison = null;
  if (mainSha && devSha && mainSha !== devSha) comparison = await compare(repository, "main", "dev");
  const [mainTreeSha, devTreeSha] = await Promise.all([
    mainSha ? commitTreeSha(repository, mainSha) : null,
    devSha ? commitTreeSha(repository, devSha) : null
  ]);
  const classification = classifyConvergence(mainSha, devSha, comparison, mainTreeSha, devTreeSha);
  const mainChecks = mainSha && mainProtection
      ? await checksFor(repository, mainSha, mainProtection, policy, {
        includeProtection: false,
        expectedBranch: "main",
        requiredChecks: [...policy.mainChecks, ...policy.artifactWorkflows, ...policy.publicationChecks]
      })
    : null;
  return {
    repository: repoName(repository), metadata, policy, mainSha, devSha, mainTreeSha, devTreeSha, comparison, classification,
    protections: { main: summarizeProtection(mainProtection, policy), dev: summarizeProtection(devProtection, policy) },
    rawProtections: { main: mainProtection, dev: devProtection },
    mainChecks,
    openPulls: Array.isArray(pulls) ? pulls : []
  };
}

export function buildReleasePlan(observation) {
  const evidence = {
    repository: observation.repository,
    main: observation.mainSha || null,
    dev: observation.devSha || null,
    mainTree: observation.mainTreeSha || null,
    devTree: observation.devTreeSha || null,
    classification: observation.classification,
    policy: observation.policy?.mode || null
  };
  const planId = `release-${createHash("sha256").update(JSON.stringify(evidence)).digest("hex").slice(0, 20)}`;
  let action = "block";
  let reason = observation.classification;
  if (observation.classification === "non-releasing") { action = "skip"; reason = "policy-disabled"; }
  else if (observation.classification === "identical") { action = "verify"; reason = "main-dev-identical"; }
  else if (observation.classification === "tree-identical") { action = "verify"; reason = "reviewed-pr-tree-converged"; }
  else if (observation.classification === "dev-ahead") { action = "release"; reason = "verified-dev-ahead"; }
  else if (observation.classification === "main-ahead") { action = "reconcile-fast-forward"; reason = "review-main-into-dev"; }
  else if (observation.classification === "diverged") { action = "reconcile-merge"; reason = "main-dev-diverged"; }
  else if (observation.classification === "missing-dev") { action = "owner-required"; reason = "missing-dev-recovery-contract"; }
  return { schemaVersion: 1, planId, evidence, action, reason };
}

export async function runReleaseCommand({ mode, repository }) {
  if (!RELEASE_MODES.has(mode)) throw new Error(`unknown release mode: ${mode}`);
  const observation = await observeReleaseState(repository);
  const plan = buildReleasePlan(observation);
  if (mode === "status" || mode === "plan") return { status: "observed", mode, observation: publicObservation(observation), plan };
  if (plan.action === "skip") return { status: "skipped", mode, observation: publicObservation(observation), plan };
  if (plan.action === "block") throw new Error(`release is blocked: ${plan.reason}`);

  await writeReleaseLedger(repository, "release-admission", {
    status: "admitted", mode, plan_id: plan.planId, evidence: plan.evidence, planned_action: plan.action
  });

  let action;
  if (plan.action === "owner-required") {
    action = await upsertConvergenceContractIssue(repository, observation, plan);
  } else if (mode === "reconcile") {
    if (!["reconcile-fast-forward", "reconcile-merge"].includes(plan.action)) {
      action = { action: "no-reconciliation-needed", classification: observation.classification };
    } else {
      action = await reconcile(repository, observation, plan);
    }
  } else if (mode === "run") {
    if (["reconcile-fast-forward", "reconcile-merge"].includes(plan.action)) action = await reconcile(repository, observation, plan);
    else if (plan.action === "release") action = await ensureReleasePull(repository, observation, plan);
    else action = await verifyRelease(repository, observation, plan);
  } else {
    action = await verifyRelease(repository, observation, plan);
  }

  const after = await observeReleaseState(repository);
  const result = {
    status: action.status || "complete",
    mode,
    repository: repoName(repository),
    plan,
    action,
    after: publicObservation(after)
  };
  await writeReleaseLedger(repository, "release-completion", result);
  if (action.verified === true) {
    await writeReleaseLedger(repository, "df-release", {
      status: "verified",
      plan_id: plan.planId,
      repository: repoName(repository),
      main_sha: action.main_sha,
      dev_sha: action.dev_sha,
      main_tree_sha: action.main_tree_sha,
      dev_tree_sha: action.dev_tree_sha,
      policy_mode: action.policy_mode,
      release: action.release,
      publication: action.publication
    });
    await dispatchReleaseVerified(repository, action);
  }
  return result;
}

export async function ensureReleasePull(repository, observation, plan) {
  assertMutationPreconditions(observation);
  await assertRefsUnchanged(repository, observation.mainSha, observation.devSha);
  await assertCurrentProtections(repository, observation.policy);
  const branch = `${observation.policy.releaseBranchPrefix}${observation.devSha.slice(0, 12)}`;
  const activeLanes = observation.openPulls.filter((pull) => isTrustedReleasePull(repository, observation.policy, pull));
  if (activeLanes.length > 1) throw new Error("multiple trusted release lanes are open; refusing to create a competing lane");
  if (activeLanes.length === 1
      && (activeLanes[0].head?.ref !== branch || activeLanes[0].head?.sha !== observation.devSha)) {
    return {
      action: "release-pr", status: "blocked", reason: "stale-release-lane",
      pull_request: activeLanes[0].html_url, expected_branch: branch, expected_head: observation.devSha
    };
  }
  await ensureExactBranch(repository, branch, observation.devSha);
  const releaseIssues = await releaseClosurePlan(repository, observation.mainSha, observation.devSha);
  const body = releasePullBody(observation, plan, branch, releaseIssues);
  await assertCurrentProtections(repository, observation.policy);
  const pull = await ensurePull(repository, { branch, base: "main", title: `Release ${observation.devSha.slice(0, 12)} to main`, body });
  await assertRefsUnchanged(repository, observation.mainSha, observation.devSha);
  assertTrustedPull(repository, pull, branch, "main", observation.devSha);
  let currentProtections = await assertCurrentProtections(repository, observation.policy);
  let checks = await checksFor(repository, pull.head.sha, currentProtections.main, observation.policy, {
    expectedPull: expectedPullEvidence(pull, observation.mainSha)
  });
  if (!checks.green) return { action: "release-pr", status: "waiting-for-green", pull_request: pull.html_url, branch, checks };
  currentProtections = await assertCurrentProtections(repository, observation.policy);
  await assertRefsUnchanged(repository, observation.mainSha, observation.devSha);
  const currentPull = await gh.request("GET", `/repos/${repoName(repository)}/pulls/${pull.number}`);
  assertTrustedPull(repository, currentPull, branch, "main", observation.devSha);
  if (currentPull.state !== "open") throw new Error("release pull request is no longer open");
  checks = await checksFor(repository, currentPull.head.sha, currentProtections.main, observation.policy, {
    expectedPull: expectedPullEvidence(currentPull, observation.mainSha)
  });
  if (!checks.green) return { action: "release-pr", status: "waiting-for-green", pull_request: pull.html_url, branch, checks };
  await enableAutoMerge(currentPull);
  return { action: "release-pr", status: "automerge-armed", pull_request: pull.html_url, branch, checks };
}

export async function reconcile(repository, observation, plan) {
  if (plan.action === "owner-required") return await upsertConvergenceContractIssue(repository, observation, plan);
  assertMutationPreconditions(observation);
  if (observation.classification === "main-ahead") return await reconcileFastForward(repository, observation, plan);
  if (observation.classification !== "diverged") return { action: "reconcile", status: "current" };
  await assertRefsUnchanged(repository, observation.mainSha, observation.devSha);
  await assertCurrentProtections(repository, observation.policy);
  const branch = `${observation.policy.reconcileBranchPrefix}${observation.mainSha.slice(0, 8)}-${observation.devSha.slice(0, 8)}`;
  let mergeSha;
  try {
    mergeSha = await ensureReconciliationMerge(repository, observation, branch);
  } catch (error) {
    if (error.status !== 409) throw error;
    await assertRefsUnchanged(repository, observation.mainSha, observation.devSha);
    const conflict = await upsertConflictIssue(repository, observation, plan);
    return { action: "reconcile", status: conflict.status, reason: conflict.reason, issue: conflict.issue.html_url };
  }
  const pull = await ensurePull(repository, {
    branch, base: "dev", title: `Reconcile main into dev (${plan.planId})`,
    body: reconciliationPullBody(observation, plan, branch, mergeSha)
  });
  assertTrustedPull(repository, pull, branch, "dev", mergeSha);
  let currentProtections = await assertCurrentProtections(repository, observation.policy);
  let checks = await checksFor(repository, mergeSha, currentProtections.dev, observation.policy, {
    expectedPull: expectedPullEvidence(pull, observation.devSha)
  });
  if (!checks.green) return { action: "reconcile", status: "waiting-for-green", pull_request: pull.html_url, branch, checks };
  currentProtections = await assertCurrentProtections(repository, observation.policy);
  const currentPull = await gh.request("GET", `/repos/${repoName(repository)}/pulls/${pull.number}`);
  assertTrustedPull(repository, currentPull, branch, "dev", mergeSha);
  if (currentPull.state !== "open") throw new Error("reconciliation pull request is no longer open");
  checks = await checksFor(repository, currentPull.head.sha, currentProtections.dev, observation.policy, {
    expectedPull: expectedPullEvidence(currentPull, observation.devSha)
  });
  if (!checks.green) return { action: "reconcile", status: "waiting-for-green", pull_request: pull.html_url, branch, checks };
  await enableAutoMerge(currentPull);
  return { action: "reconcile", status: "automerge-armed", pull_request: pull.html_url, branch, checks };
}

async function reconcileFastForward(repository, observation, plan) {
  await assertRefsUnchanged(repository, observation.mainSha, observation.devSha);
  await assertCurrentProtections(repository, observation.policy);
  const branch = `${observation.policy.reconcileBranchPrefix}${observation.mainSha.slice(0, 8)}-${observation.devSha.slice(0, 8)}`;
  await ensureExactBranch(repository, branch, observation.mainSha);
  const pull = await ensurePull(repository, {
    branch,
    base: "dev",
    title: `Reconcile main into dev (${plan.planId})`,
    body: reconciliationPullBody(observation, plan, branch, observation.mainSha)
  });
  assertTrustedPull(repository, pull, branch, "dev", observation.mainSha);
  let currentProtections = await assertCurrentProtections(repository, observation.policy);
  let checks = await checksFor(repository, pull.head.sha, currentProtections.dev, observation.policy, {
    expectedPull: expectedPullEvidence(pull, observation.devSha)
  });
  if (!checks.green) return { action: "reconcile", status: "waiting-for-green", pull_request: pull.html_url, branch, checks };
  await assertRefsUnchanged(repository, observation.mainSha, observation.devSha);
  currentProtections = await assertCurrentProtections(repository, observation.policy);
  const currentPull = await gh.request("GET", `/repos/${repoName(repository)}/pulls/${pull.number}`);
  assertTrustedPull(repository, currentPull, branch, "dev", observation.mainSha);
  if (currentPull.state !== "open") throw new Error("reconciliation pull request is no longer open");
  checks = await checksFor(repository, currentPull.head.sha, currentProtections.dev, observation.policy, {
    expectedPull: expectedPullEvidence(currentPull, observation.devSha)
  });
  if (!checks.green) return { action: "reconcile", status: "waiting-for-green", pull_request: pull.html_url, branch, checks };
  await enableAutoMerge(currentPull);
  return { action: "reconcile", status: "automerge-armed", pull_request: pull.html_url, branch, checks };
}

export async function verifyRelease(repository, observation, plan) {
  const exactCommitIdentity = Boolean(observation.mainSha && observation.mainSha === observation.devSha);
  const exactTreeIdentity = Boolean(
    observation.mainTreeSha
    && observation.devTreeSha
    && observation.mainTreeSha === observation.devTreeSha
  );
  if (!exactCommitIdentity && !exactTreeIdentity) {
    throw new Error(`release verification requires exact commit or tree identity, observed ${observation.classification}`);
  }
  assertMutationPreconditions(observation);
  await assertRefsUnchanged(repository, observation.mainSha, observation.devSha);
  const currentProtections = await assertCurrentProtections(repository, observation.policy);
  const checks = await checksFor(repository, observation.mainSha, currentProtections.main, observation.policy, {
    includeProtection: false,
    expectedBranch: "main",
    requiredChecks: [...observation.policy.mainChecks, ...observation.policy.artifactWorkflows, ...observation.policy.publicationChecks]
  });
  if (!checks.green) {
    const issue = await upsertPostReleaseFailure(repository, observation, checks);
    return { action: "verify", status: "blocked", verified: false, reason: "main-checks-not-green", issue: issue.html_url, checks };
  }
  const releaseEvidence = await verifyReleasePullEvidence(repository, observation);
  if (!releaseEvidence.green) throw new Error(`release pull evidence is not verified: ${releaseEvidence.reason}`);
  const declared = await verifyDeclaredPublication(repository, observation, checks);
  if (!declared.green) {
    const producer = await ensureDeclaredPublication(repository, observation, declared);
    return {
      action: "verify", status: "waiting-for-publication", verified: false,
      repository: repoName(repository), main_sha: observation.mainSha, dev_sha: observation.devSha,
      policy_mode: observation.policy.mode, checks, publication: declared, producer
    };
  }
  const cleaned = await cleanupMergedReleaseBranches(repository, observation);
  await closeSupersededPostReleaseFailures(repository, observation.mainSha);
  return {
    action: "verify", status: "verified", verified: true,
    repository: repoName(repository), main_sha: observation.mainSha, dev_sha: observation.devSha,
    main_tree_sha: observation.mainTreeSha || null, dev_tree_sha: observation.devTreeSha || null,
    policy_mode: observation.policy.mode, checks, release: releaseEvidence, publication: declared,
    verified_absent_automation_branches: cleaned
  };
}

function assertMutationPreconditions(observation) {
  if (observation.metadata?.default_branch !== "main") throw new Error("main is not the repository default branch");
  if (observation.metadata?.allow_auto_merge !== true) throw new Error("repository auto-merge is not enabled");
  if (observation.metadata?.delete_branch_on_merge !== true) throw new Error("repository atomic delete-on-merge is not enabled");
  for (const branch of ["main", "dev"]) {
    const protection = observation.protections?.[branch];
    if (!protection?.configured || !protection.safe) throw new Error(`${branch} protection is missing or unsafe`);
  }
}

async function assertCurrentProtections(repository, policy) {
  const [main, dev] = await Promise.all([optionalProtection(repository, "main"), optionalProtection(repository, "dev")]);
  for (const [branch, protection] of [["main", main], ["dev", dev]]) {
    const summary = summarizeProtection(protection, policy);
    if (!summary.configured || !summary.safe) throw new Error(`${branch} protection changed or became unsafe; replan`);
  }
  return { main, dev };
}

async function observeAutoMerge(repository, restValue) {
  if (typeof restValue === "boolean") return restValue;
  if (typeof gh.graphql !== "function") return null;
  try {
    const result = await gh.graphql(
      `query ReleaseAutoMerge($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { autoMergeAllowed } }`,
      { owner: repository.owner, name: repository.repo }
    );
    return typeof result?.repository?.autoMergeAllowed === "boolean" ? result.repository.autoMergeAllowed : null;
  } catch {
    return null;
  }
}

async function assertReleaseTarget(repository) {
  if (isParkedRepo(repository)) throw new Error(`refusing release mutation for parked repository ${repoName(repository)}`);
  if (DATA_REPOSITORIES.has(repoName(repository).toLowerCase())) throw new Error("main-only data repositories do not use the release lane");
  if (repoName(repository).toLowerCase() === repoName(controlRepo).toLowerCase()) return;
  const registry = await readManagedRepoRegistry();
  const lifecycle = managedRepoLifecycleState(repository, registry);
  if (lifecycle !== "active") throw new Error(`release target lifecycle is '${lifecycle}'`);
}

async function optionalRefHead(repository, branch) {
  try {
    const ref = await gh.request("GET", `/repos/${repoName(repository)}/git/ref/heads/${encodeURIComponent(branch)}`);
    return typeof ref?.object?.sha === "string" ? ref.object.sha : null;
  } catch (error) {
    if (error.status === 404 || error.status === 409) return null;
    throw error;
  }
}

async function commitTreeSha(repository, sha) {
  const commit = await gh.request("GET", `/repos/${repoName(repository)}/git/commits/${sha}`);
  const treeSha = commit?.tree?.sha;
  if (typeof treeSha !== "string" || !/^[0-9a-f]{40}$/i.test(treeSha)) {
    throw new Error(`commit ${sha} returned no exact tree identity`);
  }
  return treeSha.toLowerCase();
}

async function optionalProtection(repository, branch) {
  try { return await gh.request("GET", `/repos/${repoName(repository)}/branches/${encodeURIComponent(branch)}/protection`); }
  catch (error) { if (error.status === 403 || error.status === 404) return null; throw error; }
}

async function compare(repository, base, head) {
  return await gh.request("GET", `/repos/${repoName(repository)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
}

function summarizeProtection(protection, policy) {
  if (!isRecord(protection)) return { configured: false, safe: false, requiredChecks: [] };
  const checks = requiredCheckBindings(protection);
  const names = new Set(checks.map((check) => check.context));
  const safe = protection.allow_force_pushes?.enabled === false
    && protection.allow_deletions?.enabled === false
    && protection.enforce_admins?.enabled === true
    && protection.required_status_checks?.strict === true
    && policy.requiredChecks.every((name) => names.has(name))
    && checks.filter((check) => policy.requiredChecks.includes(check.context)).every((check) => check.appId === ACTIONS_APP_ID);
  return { configured: true, safe, requiredChecks: checks };
}

function requiredCheckBindings(protection) {
  const required = protection?.required_status_checks;
  if (!isRecord(required)) return [];
  if (Array.isArray(required.checks)) {
    return required.checks
      .filter((check) => typeof check?.context === "string")
      .map((check) => ({ context: check.context, appId: Number.isInteger(check.app_id) ? check.app_id : null }));
  }
  return Array.isArray(required.contexts)
    ? required.contexts.filter((name) => typeof name === "string").map((context) => ({ context, appId: null }))
    : [];
}

async function checksFor(repository, sha, protection, policy, options = {}) {
  const requiredChecks = options.requiredChecks || policy.requiredChecks;
  const [rawCheckRuns, statuses] = await Promise.all([
    listCompleteCheckRuns(repository, sha),
    listCompleteCommitStatuses(repository, sha)
  ]);
  const checkRuns = await bindTrustedPolicyCheckRuns(repository, sha, rawCheckRuns, requiredChecks, {
    expectedPull: options.expectedPull || null,
    expectedBranch: options.expectedBranch || null
  });
  return options.includeProtection === false
    ? evaluatePolicySelectedChecks(checkRuns, statuses, requiredChecks)
    : evaluateRequiredChecks(protection, checkRuns, statuses, requiredChecks);
}

async function isTrustedPolicyWorkflowRun(repository, sha, checkRun, binding, expectedPull, expectedBranch) {
  const suiteId = checkRun?.check_suite?.id;
  if (!Number.isSafeInteger(suiteId) || suiteId < 1 || checkRun.head_sha !== sha) return false;
  if (!hasConsistentTrustedCheckSuite(checkRun, suiteId)) return false;
  const runs = await listCompleteWorkflowRuns(repository, suiteId);
  if (runs.length !== 1) return false;
  const [run] = runs;
  if (!isRecord(run)
      || run.check_suite_id !== suiteId
      || run.head_sha !== sha
      || !binding.events.includes(run.event)
      || !Number.isSafeInteger(run.id) || run.id < 1
      || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) return false;
  if (!await hasTrustedWorkflowProvenance(repository, sha, run, binding, expectedPull, expectedBranch)) return false;
  if (checkRun.status === "completed") {
    return run.status === "completed" && run.conclusion === checkRun.conclusion;
  }
  return run.status !== "completed" && run.conclusion === null;
}

function hasConsistentTrustedCheckSuite(checkRun, suiteId) {
  const suite = checkRun?._checkSuiteEvidence;
  if (!isRecord(suite)
      || suite.id !== suiteId
      || suite.appId !== checkRun?.app?.id
      || !Number.isSafeInteger(suite.latestCheckRunsCount) || suite.latestCheckRunsCount < 1
      || suite.latestCheckRunsCount !== suite.enumeratedCheckRunsCount) return false;
  if (checkRun.status === "completed") {
    return suite.status === "completed" && suite.conclusion === checkRun.conclusion;
  }
  return suite.status !== "completed" && suite.conclusion === null;
}

async function listCompleteWorkflowRuns(repository, suiteId) {
  const first = await scanCompleteWorkflowRuns(repository, suiteId);
  const second = await scanCompleteWorkflowRuns(repository, suiteId);
  if (first.fingerprint !== second.fingerprint) {
    throw new Error("release workflow-run binding changed during verification");
  }
  return second.runs;
}

async function scanCompleteWorkflowRuns(repository, suiteId) {
  const runs = [];
  const seen = new Set();
  let totalCount = null;
  for (let page = 1; page <= MAX_PAGINATION_PAGES; page += 1) {
    const payload = await gh.request(
      "GET",
      `/repos/${repoName(repository)}/actions/runs?check_suite_id=${suiteId}&per_page=100&page=${page}`
    );
    if (!isRecord(payload)
        || !Number.isSafeInteger(payload.total_count) || payload.total_count < 0 || payload.total_count > 100
        || !Array.isArray(payload.workflow_runs) || payload.workflow_runs.length > 100) {
      throw new Error("release workflow-run binding evidence is malformed or ambiguous");
    }
    totalCount ??= payload.total_count;
    if (payload.total_count !== totalCount) throw new Error("release workflow-run binding changed during pagination");
    for (const run of payload.workflow_runs) {
      if (!isRecord(run) || !Number.isSafeInteger(run.id) || run.id < 1 || seen.has(run.id)) {
        throw new Error("release workflow-run binding contains malformed or duplicate evidence");
      }
      seen.add(run.id);
      runs.push(run);
    }
    if (runs.length > totalCount) throw new Error("release workflow-run binding exceeds its declared total");
    if (runs.length === totalCount) {
      const evidence = runs.map((run) => ({
        id: run.id,
        checkSuiteId: run.check_suite_id ?? null,
        headSha: run.head_sha ?? null,
        path: run.path ?? null,
        event: run.event ?? null,
        headBranch: run.head_branch ?? null,
        repository: run?.repository?.full_name ?? null,
        repositoryId: run?.repository?.id ?? null,
        headRepository: run?.head_repository?.full_name ?? null,
        headRepositoryId: run?.head_repository?.id ?? null,
        pullRequests: workflowPullEvidence(run.pull_requests),
        status: run.status ?? null,
        conclusion: run.conclusion ?? null,
        runAttempt: run.run_attempt ?? null
      })).sort((left, right) => left.id - right.id);
      return { runs, fingerprint: JSON.stringify(evidence) };
    }
    if (payload.workflow_runs.length < 100) throw new Error("release workflow-run binding evidence is truncated");
  }
  throw new Error("release workflow-run binding exceeded the bounded page limit");
}

async function hasTrustedWorkflowProvenance(repository, sha, run, binding, expectedPull, expectedBranch) {
  const pathEvidence = trustedWorkflowPath(run.path, binding);
  if (!pathEvidence) return false;
  const fullName = repoName(repository);
  if (String(run?.repository?.full_name || "").toLowerCase() !== fullName.toLowerCase()
      || String(run?.head_repository?.full_name || "").toLowerCase() !== fullName.toLowerCase()
      || !Number.isSafeInteger(run?.repository?.id) || run.repository.id < 1
      || run?.head_repository?.id !== run.repository.id) return false;

  let trustedRef = null;
  let trustedBaseSha = null;
  if (["pull_request", "pull_request_target"].includes(run.event)) {
    if (expectedBranch !== null || !isExpectedPullEvidence(expectedPull, sha)) return false;
    const pulls = Array.isArray(run.pull_requests) ? run.pull_requests : [];
    if (pulls.length !== 1) return false;
    const [pull] = pulls;
    if (!isRecord(pull)
        || pull.number !== expectedPull.number
        || pull?.head?.sha !== expectedPull.headSha
        || pull?.head?.ref !== expectedPull.headRef
        || pull?.head?.ref !== run.head_branch
        || pull?.head?.repo?.id !== run.head_repository.id
        || pull?.base?.repo?.id !== run.repository.id
        || pull?.base?.ref !== expectedPull.baseRef
        || pull?.base?.sha !== expectedPull.baseSha) return false;
    trustedRef = pull.base.ref;
    trustedBaseSha = pull.base.sha;
  } else if (["push", "workflow_dispatch"].includes(run.event)) {
    if (expectedPull !== null
        || !Array.isArray(run.pull_requests) || run.pull_requests.length !== 0
        || typeof expectedBranch !== "string" || expectedBranch.length === 0
        || run.head_branch !== expectedBranch) return false;
    trustedRef = expectedBranch;
  } else {
    return false;
  }
  if (!binding.refs.includes(trustedRef) && !binding.refs.includes(`refs/heads/${trustedRef}`)) return false;
  if (pathEvidence.ref && pathEvidence.ref !== trustedRef && pathEvidence.ref !== `refs/heads/${trustedRef}`) return false;

  if (run.event === "pull_request" && !pathEvidence.ref) {
    return await workflowFileMatchesTrustedBase(repository, binding.path, sha, trustedBaseSha);
  }
  return true;
}

function expectedPullEvidence(pull, baseSha) {
  return {
    number: pull?.number,
    headRef: pull?.head?.ref,
    headSha: pull?.head?.sha,
    baseRef: pull?.base?.ref,
    baseSha
  };
}

function isExpectedPullEvidence(value, sha) {
  return isRecord(value)
    && Number.isSafeInteger(value.number) && value.number > 0
    && typeof value.headRef === "string" && value.headRef.length > 0
    && value.headSha === sha
    && typeof value.baseRef === "string" && value.baseRef.length > 0
    && typeof value.baseSha === "string" && /^[0-9a-f]{40}$/i.test(value.baseSha);
}

function trustedWorkflowPath(value, binding) {
  if (typeof value !== "string") return false;
  const separator = value.indexOf("@");
  const workflowPath = separator === -1 ? value : value.slice(0, separator);
  const workflowRef = separator === -1 ? null : value.slice(separator + 1);
  if (workflowPath !== binding.path) return false;
  if (workflowRef !== null && (workflowRef.length === 0 || workflowRef.includes("@") || !binding.refs.includes(workflowRef))) {
    return false;
  }
  return { path: workflowPath, ref: workflowRef };
}

async function workflowFileMatchesTrustedBase(repository, workflowPath, headSha, baseSha) {
  const endpoint = `/repos/${repoName(repository)}/contents/${workflowPath}`;
  const [head, base] = await Promise.all([
    gh.request("GET", `${endpoint}?ref=${encodeURIComponent(headSha)}`),
    gh.request("GET", `${endpoint}?ref=${encodeURIComponent(baseSha)}`)
  ]);
  return isRecord(head)
    && isRecord(base)
    && head.type === "file"
    && base.type === "file"
    && typeof head.sha === "string"
    && /^[0-9a-f]{40}$/i.test(head.sha)
    && head.sha === base.sha;
}

function workflowPullEvidence(value) {
  if (!Array.isArray(value)) return null;
  return value.map((pull) => ({
    number: pull?.number ?? null,
    headRef: pull?.head?.ref ?? null,
    headSha: pull?.head?.sha ?? null,
    headRepoId: pull?.head?.repo?.id ?? null,
    baseRef: pull?.base?.ref ?? null,
    baseSha: pull?.base?.sha ?? null,
    baseRepoId: pull?.base?.repo?.id ?? null
  })).sort((left, right) => Number(left.number ?? 0) - Number(right.number ?? 0));
}

async function assertRefsUnchanged(repository, mainSha, devSha) {
  const [currentMain, currentDev] = await Promise.all([optionalRefHead(repository, "main"), optionalRefHead(repository, "dev")]);
  if (currentMain !== mainSha || currentDev !== devSha) throw new Error("main/dev refs changed after release planning; replan from current state");
}

async function ensureExactBranch(repository, branch, sha) {
  const existing = await optionalRefHead(repository, branch);
  if (existing && existing !== sha) throw new Error(`marker-owned branch ${branch} exists at an unexpected head`);
  if (!existing) await gh.request("POST", `/repos/${repoName(repository)}/git/refs`, { ref: `refs/heads/${branch}`, sha });
}

async function ensureReconciliationMerge(repository, observation, branch) {
  let current = await optionalRefHead(repository, branch);
  if (!current) {
    await assertRefsUnchanged(repository, observation.mainSha, observation.devSha);
    await assertCurrentProtections(repository, observation.policy);
    await ensureExactBranch(repository, branch, observation.devSha);
    current = observation.devSha;
  }
  if (current !== observation.devSha) {
    await assertPlannedMergeCommit(repository, current, observation);
    return current;
  }

  await assertRefsUnchanged(repository, observation.mainSha, observation.devSha);
  await assertCurrentProtections(repository, observation.policy);
  const merged = await gh.request("POST", `/repos/${repoName(repository)}/merges`, {
    base: branch,
    head: observation.mainSha,
    commit_message: `Reconcile main ${observation.mainSha.slice(0, 12)} into dev ${observation.devSha.slice(0, 12)}`
  });
  const mergeSha = typeof merged?.sha === "string" ? merged.sha : await optionalRefHead(repository, branch);
  if (typeof mergeSha !== "string" || !/^[0-9a-f]{40}$/i.test(mergeSha)) {
    throw new Error("GitHub returned an invalid reconciliation merge commit");
  }
  await assertPlannedMergeCommit(repository, mergeSha, observation);
  return mergeSha;
}

async function assertPlannedMergeCommit(repository, sha, observation) {
  const commit = await gh.request("GET", `/repos/${repoName(repository)}/commits/${sha}`);
  const parents = Array.isArray(commit?.parents) ? commit.parents.map((parent) => parent?.sha) : [];
  const expectedParents = [observation.devSha, observation.mainSha].sort();
  if (commit?.sha !== sha || parents.length !== 2 || JSON.stringify([...parents].sort()) !== JSON.stringify(expectedParents)) {
    throw new Error("marker-owned reconciliation branch is not the exact planned two-parent merge");
  }
  const message = commit?.commit?.message || "";
  if (normalizeWorkerPullRequestActor(commit?.author) === null
      || !message.startsWith(`Reconcile main ${observation.mainSha.slice(0, 12)} into dev ${observation.devSha.slice(0, 12)}`)) {
    throw new Error("marker-owned reconciliation merge lacks trusted automation provenance");
  }
}

async function ensurePull(repository, { branch, base, title, body }) {
  const pulls = await listAll(`/repos/${repoName(repository)}/pulls?state=open&base=${encodeURIComponent(base)}&head=${encodeURIComponent(`${repository.owner}:${branch}`)}&per_page=100`);
  if (Array.isArray(pulls) && pulls.length > 1) throw new Error(`multiple marker-owned pull requests exist for ${branch}`);
  if (Array.isArray(pulls) && pulls.length === 1) {
    const current = pulls[0];
    if (current.title !== title || current.body !== body) {
      throw new Error(`marker-owned pull request ${current.number} content drifted; preserving edits for review`);
    }
    return current;
  }
  return await gh.request("POST", `/repos/${repoName(repository)}/pulls`, { title, head: branch, base, body, draft: false });
}

function assertTrustedPull(repository, pull, branch, base, expectedHeadSha) {
  if (!pull || !Number.isInteger(pull.number)
      || pull.base?.ref !== base
      || pull.head?.ref !== branch
      || pull.head?.sha !== expectedHeadSha
      || normalizeWorkerPullRequestActor(pull.user) === null
      || String(pull.head?.repo?.full_name || "").toLowerCase() !== repoName(repository).toLowerCase()) {
    throw new Error("release pull request identity or same-repository provenance did not match the plan");
  }
}

async function enableAutoMerge(pull) {
  if (pull.auto_merge) return;
  if (typeof pull.node_id !== "string" || !pull.node_id) throw new Error("pull request node identity is missing");
  if (typeof gh.graphql !== "function") throw new Error("GitHub GraphQL auto-merge authority is unavailable");
  await gh.graphql(
    `mutation EnableReleaseAutoMerge($pullRequestId: ID!) {
      enablePullRequestAutoMerge(input: {pullRequestId: $pullRequestId, mergeMethod: MERGE}) {
        pullRequest { url autoMergeRequest { enabledAt } }
      }
    }`,
    { pullRequestId: pull.node_id }
  );
}

export async function cleanupMergedReleaseBranches(repository, observation) {
  if (observation.metadata?.delete_branch_on_merge !== true) {
    throw new Error("repository delete_branch_on_merge is not enabled; refusing race-prone manual branch deletion");
  }
  const pulls = await listAll(`/repos/${repoName(repository)}/pulls?state=closed&per_page=100`);
  const absent = [];
  for (const summary of pulls) {
    const pull = await gh.request("GET", `/repos/${repoName(repository)}/pulls/${summary.number}`);
    if (pull?.merged !== true || !pull?.merged_at || typeof pull?.head?.sha !== "string") continue;
    const releaseOwned = isTrustedReleasePull(repository, observation.policy, pull);
    const reconcileOwned = isTrustedReconciliationPull(repository, observation.policy, pull);
    if (!releaseOwned && !reconcileOwned) continue;
    const current = await optionalRefHead(repository, pull.head.ref);
    if (!current) {
      absent.push(pull.head.ref);
      continue;
    }
    if (current !== pull.head.sha) throw new Error(`automation branch ${pull.head.ref} changed after merge; preserving it`);
    throw new Error(`automation branch ${pull.head.ref} awaits GitHub's atomic delete-on-merge cleanup`);
  }
  return absent;
}

export async function verifyDeclaredPublication(repository, observation, currentChecks) {
  if (observation.policy.mode === "branch-only") return { green: true, mode: "branch-only" };
  const tags = await gh.request("GET", `/repos/${repoName(repository)}/git/matching-refs/tags/`);
  let matcher;
  try { matcher = new RegExp(observation.policy.tagPattern); } catch { return { green: false, reason: "invalid-tag-pattern" }; }
  let exact = null;
  for (const tag of Array.isArray(tags) ? tags : []) {
    if (!matcher.test(String(tag.ref || ""))) continue;
    if (await resolveTagCommit(repository, tag.object) === observation.mainSha) {
      exact = tag;
      break;
    }
  }
  if (!exact) return { green: false, reason: "released-main-tag-missing" };
  if (observation.policy.artifactWorkflows.length || observation.policy.publicationChecks.length) {
    const names = new Set(currentChecks?.checks?.filter((check) => check.state === "green").map((check) => check.name));
    const missing = [...observation.policy.artifactWorkflows, ...observation.policy.publicationChecks].filter((name) => !names.has(name));
    if (missing.length) return { green: false, reason: `declared-publication-evidence-missing:${missing.join(",")}` };
  }
  return { green: true, mode: observation.policy.mode, tag: exact.ref };
}

async function resolveTagCommit(repository, object, depth = 0) {
  if (!object || typeof object.sha !== "string" || depth > 8) return null;
  if (object.type === "commit" || object.type === undefined) return object.sha;
  if (object.type !== "tag") return null;
  const tag = await gh.request("GET", `/repos/${repoName(repository)}/git/tags/${object.sha}`);
  return await resolveTagCommit(repository, tag?.object, depth + 1);
}

async function ensureDeclaredPublication(repository, observation, evidence) {
  const producer = observation.policy.producer;
  if (!producer) throw new Error(`declared release policy is not verified: ${evidence.reason}`);
  await assertRefsUnchanged(repository, observation.mainSha, observation.devSha);
  await assertCurrentProtections(repository, observation.policy);
  const runs = await listAll(
    `/repos/${repoName(repository)}/actions/workflows/${encodeURIComponent(producer.workflow)}/runs?branch=main&event=workflow_dispatch&per_page=100`
  );
  const attempts = runs.filter((run) => run?.head_sha === observation.mainSha);
  const current = attempts.find((run) => ["queued", "in_progress", "waiting", "requested", "pending"].includes(run?.status));
  if (current) return { status: "in-progress", workflow: producer.workflow, run: current.html_url || null };
  if (attempts.length >= producer.maxAttempts) {
    throw new Error(`declared publication producer exhausted ${producer.maxAttempts} attempts for ${observation.mainSha}`);
  }
  await gh.request("POST", `/repos/${repoName(repository)}/actions/workflows/${encodeURIComponent(producer.workflow)}/dispatches`, {
    ref: producer.ref,
    inputs: producer.inputs
  });
  return { status: "dispatched", workflow: producer.workflow, reason: evidence.reason };
}

async function verifyReleasePullEvidence(repository, observation) {
  const pulls = await listAll(`/repos/${repoName(repository)}/pulls?state=closed&per_page=100`);
  const candidates = [];
  for (const summary of pulls) {
    const pull = await gh.request("GET", `/repos/${repoName(repository)}/pulls/${summary.number}`);
    if (pull?.merged !== true || !pull?.merged_at || typeof pull?.head?.sha !== "string") continue;
    const kind = isTrustedReleasePull(repository, observation.policy, pull)
      ? "release"
      : isTrustedReconciliationPull(repository, observation.policy, pull) ? "reconcile" : null;
    if (!kind) continue;
    const targetSha = kind === "release" ? observation.mainSha : observation.devSha;
    const relation = await compare(repository, pull.head.sha, targetSha);
    if (!isValidComparison(relation) || !["ahead", "identical"].includes(relation.status) || relation.behind_by !== 0) continue;
    const headTreeSha = await commitTreeSha(repository, pull.head.sha);
    const convergedTreeSha = observation.mainTreeSha && observation.mainTreeSha === observation.devTreeSha
      ? observation.mainTreeSha
      : null;
    if (!convergedTreeSha || headTreeSha !== convergedTreeSha) continue;
    candidates.push({ pull, kind });
  }
  if (candidates.length === 0) {
    return {
      green: observation.mainSha === observation.devSha,
      reason: observation.mainSha === observation.devSha
        ? "explicit-exact-ref-bootstrap-with-no-trusted-release-history"
        : "trusted-release-evidence-missing",
      pull_request: null, issues: []
    };
  }
  candidates.sort((a, b) => String(b.pull.merged_at).localeCompare(String(a.pull.merged_at)));
  const { pull, kind } = candidates[0];
  const protection = kind === "release" ? observation.rawProtections.main : observation.rawProtections.dev;
  const checks = await checksFor(repository, pull.head.sha, protection, observation.policy, {
    expectedPull: expectedPullEvidence(pull, trustedPullBaseSha(pull, kind))
  });
  if (!checks.green) return { green: false, reason: `${kind}-pr-gates-not-green`, pull_request: pull.html_url, checks };
  const marker = kind === "release"
    ? String(pull.body || "").match(/<!-- darkfactory:release-issues ([0-9,]*) -->/)
    : null;
  const issueNumbers = marker?.[1] ? marker[1].split(",").map(Number).filter((number) => Number.isInteger(number) && number > 0) : [];
  for (const issueNumber of issueNumbers) {
    const issue = await gh.request("GET", `/repos/${repoName(repository)}/issues/${issueNumber}`);
    if (issue?.state !== "closed" || issue?.pull_request) return { green: false, reason: `linked-issue-${issueNumber}-not-closed`, pull_request: pull.html_url, checks };
  }
  return { green: true, kind, pull_request: pull.html_url, head_sha: pull.head.sha, tree_sha: observation.mainTreeSha, checks, issues: issueNumbers };
}

export async function releaseClosurePlan(repository, mainSha, devSha) {
  const comparison = await compare(repository, mainSha, devSha);
  const commits = Array.isArray(comparison?.commits) ? comparison.commits : [];
  if (Number.isInteger(comparison?.total_commits) && comparison.total_commits !== commits.length) {
    throw new Error(`release closure history is truncated: observed ${commits.length} of ${comparison.total_commits} commits`);
  }
  const issues = new Set();
  for (const commit of commits) {
    for (const number of extractClosingIssueNumbers(commit?.commit?.message || "", repoName(repository))) issues.add(number);
    if (typeof commit?.sha !== "string") continue;
    let pulls = [];
    try { pulls = await listAll(`/repos/${repoName(repository)}/commits/${commit.sha}/pulls?per_page=100`); } catch (error) { if (error.status !== 404) throw error; }
    for (const pull of Array.isArray(pulls) ? pulls : []) {
      for (const number of extractClosingIssueNumbers(pull?.body || "", repoName(repository))) issues.add(number);
    }
  }
  return [...issues].sort((a, b) => a - b);
}

async function closeSupersededPostReleaseFailures(repository, greenSha) {
  const issues = await listAll(`/repos/${repoName(repository)}/issues?state=open&per_page=100`);
  for (const issue of issues) {
    if (issue.pull_request || !isTrustedAutomationActor(issue)) continue;
    const match = String(issue.body || "").match(/<!-- darkfactory:post-release-ci sha=([0-9a-f]{40}) -->/i);
    if (!match || match[1].toLowerCase() === greenSha.toLowerCase()) continue;
    await gh.request("POST", `/repos/${repoName(repository)}/issues/${issue.number}/comments`, {
      body: `Verified green replacement main evidence: \`${greenSha}\`. Closing the superseded post-release failure.`
    });
    await gh.request("PATCH", `/repos/${repoName(repository)}/issues/${issue.number}`, { state: "closed" });
  }
}

async function upsertConvergenceContractIssue(repository, observation, plan) {
  const marker = `<!-- darkfactory:release-contract plan=${plan.planId} -->`;
  const existing = await findOpenIssueByMarker(repository, marker);
  const body = [
    marker,
    "# Restore the missing protected dev branch",
    "",
    `Repository: ${repoName(repository)}`,
    `Observed state: ${observation.classification}`,
    `Main: \`${observation.mainSha || "missing"}\``,
    `Dev: \`${observation.devSha || "missing"}\``,
    "",
    "DarkFactory uses PR-only protected landing and defines convergence as reviewed ancestry plus exact tree identity. That contract handles normal main-ahead reconciliation without writing either protected ref.",
    "",
    "The dev branch is absent, so GitHub has no PR base on which to perform that reviewed landing. Restoring it requires an explicit owner action to create the protected branch before DarkFactory can resume through a PR.",
    "",
    "DarkFactory remains fail-closed: it will not create or update the protected dev ref, bypass protection, or claim convergence until the owner restores the branch and the normal reviewed lane completes."
  ].join("\n");
  const issue = existing
    ? await gh.request("PATCH", `/repos/${repoName(repository)}/issues/${existing.number}`, { body, labels: ["P0", "df:ask-owner"] })
    : await gh.request("POST", `/repos/${repoName(repository)}/issues`, {
      title: "Restore the missing protected dev branch", body, labels: ["P0", "df:ask-owner"]
    });
  return { action: "release-contract", status: "owner-required", reason: plan.reason, issue: issue.html_url };
}

async function upsertConflictIssue(repository, observation, plan) {
  const marker = `<!-- darkfactory:release-conflict plan=${plan.planId} -->`;
  const existing = await findOpenIssueByMarker(repository, marker);
  const comparison = observation.comparison || await compare(repository, "main", "dev");
  const hunks = (Array.isArray(comparison?.files) ? comparison.files : []).slice(0, 20).map((file) => [
    `### ${file.filename || "unknown"}`,
    "```diff",
    String(file.patch || "Patch unavailable from GitHub; inspect the linked comparison.").slice(0, 12000),
    "```"
  ].join("\n")).join("\n\n");
  const mechanical = isMechanicalConflict(comparison);
  const body = [marker, mechanical ? "# Mechanically reconcile release branches" : "# Release reconciliation needs owner resolution", "", `Repository: ${repoName(repository)}`,
    `Main: \`${observation.mainSha}\``, `Dev: \`${observation.devSha}\``,
    `Comparison: https://github.com/${repoName(repository)}/compare/${observation.mainSha}...${observation.devSha}`,
    "", mechanical
      ? "The conflict is limited to trusted generated/lock artifacts. Re-run the canonical generators on an isolated reconciliation branch, validate the exact result, and publish only through a reviewed PR."
      : "GitHub could not merge main into the isolated reconciliation branch. DarkFactory will not guess a semantic resolution.",
    "", "## Acceptance", "", "- Preserve both branch histories and resolve only the listed files.",
    "- Validate the repository and obtain clean DarkFactory Autoreview evidence.",
    "- Merge only through the protected dev PR lane; no force push or protected-ref write.",
    "", hunks || "No bounded patch evidence was returned."
  ].join("\n");
  const title = mechanical ? "Mechanically reconcile release conflict" : "Resolve semantic release reconciliation conflict";
  const labels = mechanical ? ["P0", "df:class:mechanical"] : ["P0", "df:ask-owner"];
  const issue = existing
    ? await gh.request("PATCH", `/repos/${repoName(repository)}/issues/${existing.number}`, { title, body, labels })
    : await gh.request("POST", `/repos/${repoName(repository)}/issues`, { title, body, labels });
  return {
    issue,
    status: mechanical ? "queued-for-readiness" : "owner-required",
    reason: mechanical ? "mechanical-conflict" : "semantic-or-content-conflict"
  };
}

async function upsertPostReleaseFailure(repository, observation, checks) {
  const marker = `<!-- darkfactory:post-release-ci sha=${observation.mainSha} -->`;
  const existing = await findOpenIssueByMarker(repository, marker);
  const exactEvidence = checks.checks.map((check) =>
    `- ${check.name}: ${check.state}; check id ${check.id ?? "unavailable"}; ${check.url || "evidence URL unavailable"}`
  );
  const body = [marker, "# Post-release main verification is red", "", `Main SHA: \`${observation.mainSha}\``,
    `Missing: ${checks.missing.join(", ") || "none"}`, `Pending: ${checks.pending.join(", ") || "none"}`, `Red: ${checks.red.join(", ") || "none"}`,
    "", "## Exact check evidence", "", ...exactEvidence,
    "", "## Acceptance", "", "- Repair the failing current-main checks through a reviewed dev PR.",
    "- Release through the protected release lane and prove a green replacement main SHA.",
    "- This issue closes only after that replacement evidence is verified."
  ].join("\n");
  if (existing) return await gh.request("PATCH", `/repos/${repoName(repository)}/issues/${existing.number}`, { body });
  return await gh.request("POST", `/repos/${repoName(repository)}/issues`, {
    title: `Repair red post-release CI at ${observation.mainSha.slice(0, 12)}`, body,
    labels: ["P0", "df:class:standard"]
  });
}

async function findOpenIssueByMarker(repository, marker) {
  const issues = await listAll(`/repos/${repoName(repository)}/issues?state=open&per_page=100`);
  const matches = issues.filter((issue) => !issue.pull_request && isTrustedAutomationActor(issue) && String(issue.body || "").includes(marker));
  if (matches.length > 1) throw new Error(`multiple trusted DarkFactory issues claim marker ${marker}`);
  return matches[0] || null;
}

async function dispatchReleaseVerified(repository, action) {
  await gh.request("POST", `/repos/${repoName(controlRepo)}/dispatches`, {
    event_type: "darkfactory-release-verified",
    client_payload: { repository: repoName(repository), main_sha: action.main_sha, policy_mode: action.policy_mode }
  });
}

function releasePullBody(observation, plan, branch, releaseIssues = []) {
  return [
    `<!-- darkfactory:release plan=${plan.planId} main=${observation.mainSha} dev=${observation.devSha} -->`,
    `<!-- darkfactory:release-issues ${releaseIssues.join(",")} -->`,
    "## DarkFactory release convergence", "",
    `- Repository: \`${observation.repository}\``, `- Source dev: \`${observation.devSha}\``, `- Observed main: \`${observation.mainSha}\``,
    `- Release branch: \`${branch}\``, `- Declared policy: \`${observation.policy.mode}\``,
    `- Closure plan: ${releaseIssues.length ? releaseIssues.map((number) => `#${number}`).join(", ") : "no closing references discovered"}; worker issues close at their trusted dev-merge boundary.`,
    "", "Validate and a clean high-confirmed DarkFactory Autoreview are required. No direct main write, force push, or bypass is permitted."
  ].join("\n");
}

function reconciliationPullBody(observation, plan, branch, headSha) {
  return [
    `<!-- darkfactory:reconcile plan=${plan.planId} main=${observation.mainSha} dev=${observation.devSha} head=${headSha} -->`, "## DarkFactory main/dev reconciliation", "",
    `- Observed main: \`${observation.mainSha}\``, `- Observed dev: \`${observation.devSha}\``, `- Reviewed head: \`${headSha}\``,
    `- Marker-owned branch: \`${branch}\``, "", "This PR exists to review the exact convergence head. DarkFactory re-fetches every ref and required check before normal protected-PR automerge; it never writes a protected ref directly."
  ].join("\n");
}

function publicObservation(observation) {
  return {
    repository: observation.repository,
    classification: observation.classification,
    main_sha: observation.mainSha || null,
    dev_sha: observation.devSha || null,
    main_tree_sha: observation.mainTreeSha || null,
    dev_tree_sha: observation.devTreeSha || null,
    convergence_invariant: "reviewed-ancestry-and-exact-tree-identity",
    policy: observation.policy,
    protections: observation.protections,
    main_checks: observation.mainChecks
  };
}

async function writeReleaseLedger(repository, kind, payload) {
  return await writeRunLedger(ledgerGh, DARK_FACTORY_DATA_REPO, kind, repoName(repository), payload);
}

function isValidComparison(value) {
  return isRecord(value) && ["ahead", "behind", "diverged", "identical"].includes(value.status)
    && Number.isInteger(value.ahead_by) && Number.isInteger(value.behind_by);
}

async function listAll(path) {
  const items = [];
  for (let page = 1; page <= MAX_PAGINATION_PAGES; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const batch = await gh.request("GET", `${path}${separator}page=${page}`);
    if (!Array.isArray(batch)) throw new Error(`GitHub pagination returned malformed evidence for ${path}`);
    items.push(...batch);
    if (batch.length < 100) return items;
  }
  throw new Error(`GitHub pagination exceeded ${MAX_PAGINATION_PAGES} pages for ${path}`);
}

function isTrustedAutomationActor(value) {
  return normalizeWorkerPullRequestActor(value?.user) !== null;
}

function isTrustedReleasePull(repository, policy, pull) {
  const marker = String(pull?.body || "").match(
    /<!-- darkfactory:release plan=(release-[0-9a-f]{20}) main=([0-9a-f]{40}) dev=([0-9a-f]{40}) -->/i
  );
  return Boolean(marker)
    && isTrustedAutomationActor(pull)
    && pull?.base?.ref === "main"
    && pull?.head?.ref?.startsWith(policy.releaseBranchPrefix)
    && pull?.head?.sha === marker[3]
    && String(pull?.head?.repo?.full_name || "").toLowerCase() === repoName(repository).toLowerCase();
}

function isTrustedReconciliationPull(repository, policy, pull) {
  const marker = String(pull?.body || "").match(
    /<!-- darkfactory:reconcile plan=(release-[0-9a-f]{20}) main=([0-9a-f]{40}) dev=([0-9a-f]{40}) head=([0-9a-f]{40}) -->/i
  );
  return Boolean(marker)
    && isTrustedAutomationActor(pull)
    && pull?.base?.ref === "dev"
    && pull?.head?.ref?.startsWith(policy.reconcileBranchPrefix)
    && pull?.head?.sha === marker[4]
    && String(pull?.head?.repo?.full_name || "").toLowerCase() === repoName(repository).toLowerCase();
}

function trustedPullBaseSha(pull, kind) {
  const expression = kind === "release"
    ? /<!-- darkfactory:release plan=release-[0-9a-f]{20} main=([0-9a-f]{40}) dev=[0-9a-f]{40} -->/i
    : /<!-- darkfactory:reconcile plan=release-[0-9a-f]{20} main=[0-9a-f]{40} dev=([0-9a-f]{40}) head=[0-9a-f]{40} -->/i;
  return String(pull?.body || "").match(expression)?.[1] || null;
}

function isMechanicalConflict(comparison) {
  const files = Array.isArray(comparison?.files) ? comparison.files : [];
  if (files.length === 0) return false;
  const mechanical = /(^|\/)(?:package-lock\.json|bun\.lockb?|uv\.lock|go\.sum|Cargo\.lock)$|^prompts\/(?:fixtures\/snapshots\/|manifest(?:\.recovery)?\.json$)/i;
  return files.every((file) => typeof file?.filename === "string" && mechanical.test(file.filename));
}

function uniqueRepositories(repositories) {
  const seen = new Set();
  return repositories.filter((repository) => {
    const key = repoName(repository).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function assertRuntime() {
  if (!gh || !ledgerGh || !controlRepo) throw new Error("DarkFactory release runtime is not configured");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
