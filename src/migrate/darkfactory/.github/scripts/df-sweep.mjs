import {
  AUTOREVIEW_REQUIRED_CONTEXT,
  DARK_FACTORY_DATA_REPO,
  assertAllowedRepo,
  checksAreGreen,
  checksSummary,
  createGithubClient,
  darkFactoryWorkerIssueNumber,
  extractClosingIssueNumbers,
  getRepository,
  getBranchProtection,
  getOptionalFileContent,
  inspectManagedBranchProtection,
  isDarkFactoryWorkerPullRequest as isWorkerPullRequest,
  isVerifiedWorkerIssue,
  isParkedRepo,
  listActiveManagedRepos,
  managedRepoLifecycleState,
  normalizedRepoName,
  parseRepo,
  readManagedRepoRegistry,
  repoName,
  requiredEnv,
  warnReadOnlyRepository,
  withAutoreviewRequiredContext,
  writeRunLedger
} from "./df-lib.mjs";
import { pathToFileURL } from "node:url";
import { evaluateEnforcementRules, loadEnforcementRules } from "./df-enforcement.mjs";

const MODE = process.env.DF_FOLLOW_THROUGH_MODE ?? "sweep";
const TRIGGER = process.env.DF_TRIGGER ?? "unknown";
const DEFAULT_EXCLUDED_REPOS = "";
const WORK_BRANCH = process.env.DF_WORK_BRANCH || "";
const EMPTY_CHECK_SETTLE_MS = 10 * 60 * 1000;
let gh;
let CONTROL_REPO;
const DATA_REPO = DARK_FACTORY_DATA_REPO;

export function configureSweepRuntime(options) {
  gh = options.gh;
  CONTROL_REPO = options.controlRepo;
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
  configureSweepRuntime({
    gh: createGithubClient(token, "darkfactory-sweep"),
    controlRepo: parseRepo(requiredEnv("DF_CONTROL_REPO"))
  });

  if (MODE === "dev-merge") {
    await closeDevMergeIssuesFromEnv();
    return;
  }

  const repos = await targetRepositories();
  const excluded = new Set(repoList(process.env.DF_SWEEP_EXCLUDE_REPOS || DEFAULT_EXCLUDED_REPOS).map((repo) => repoName(repo).toLowerCase()));
  const enforcementRules = await loadEnforcementRules();
  const ledger = {
    trigger: TRIGGER,
    mode: MODE,
    excluded_repos: [...excluded],
    actions: [],
    token_usage: {
      model_calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      note: "Green-PR sweep is deterministic and uses no model calls"
    }
  };

  for (const repository of repos) {
    if (isParkedRepo(repository)) {
      ledger.actions.push({ repo: repoName(repository), action: "skip", reason: "parked" });
      continue;
    }

    if (excluded.has(repoName(repository).toLowerCase())) {
      ledger.actions.push({ repo: repoName(repository), action: "skip", reason: "excluded" });
      continue;
    }

    try {
      assertAllowedRepo(repository);
      const { pulls, baseBranches } = await listOpenPullRequests(repository);
      console.log(`DarkFactory sweep listed ${pulls.length} open ${[...baseBranches].join(",")} worker candidate PRs for ${repoName(repository)}.`);
      for (const pull of pulls) {
        try {
          const result = await considerPullRequest(repository, pull, enforcementRules);
          console.log(formatPullDecision(repository, pull, result));
          ledger.actions.push(result);
        } catch (error) {
          const result = {
            repo: repoName(repository),
            pr: `${repoName(repository)}#${pull.number}`,
            action: "error",
            reason: "consider-pull-request-failed",
            error: error.message || String(error)
          };
          console.error(formatPullDecision(repository, pull, result));
          ledger.actions.push(result);
        }
      }
      const closureResults = await closeRecentlyMergedDevIssues(repository);
      ledger.actions.push(...closureResults);
    } catch (error) {
      if (warnReadOnlyRepository(repository, error, "follow-through")) {
        ledger.actions.push({ repo: repoName(repository), action: "skip", reason: "read-only" });
        continue;
      }
      ledger.actions.push({ repo: repoName(repository), action: "error", error: error.message || String(error) });
    }
  }

  await writeLedger("df-sweep", "sweep", ledger);
  const merged = ledger.actions.filter((action) => action.action === "merge" || action.action === "enable-automerge");
  console.log(`DarkFactory sweep processed ${repos.length} repos; merge actions: ${merged.length}.`);
}

function formatPullDecision(repository, pull, result) {
  const decision = result.action === "skip"
    ? `skip:${result.reason || "unknown"}`
    : result.action === "error"
      ? `error:${result.reason || "unknown"}`
      : result.action;
  const error = result.error ? ` error=${String(result.error).replace(/\s+/g, " ")}` : "";
  return [
    `DarkFactory sweep decision ${repoName(repository)}#${pull.number}`,
    `base=${pull.baseRefName || "unknown"}`,
    `head=${pull.headRefName || "unknown"}`,
    `mergeable=${pull.mergeable || "unknown"}`,
    `draft=${pull.isDraft === true}`,
    `checks=${checksSummary(pull.statusCheckRollup)}`,
    `decision=${decision}${error}`
  ].join(" ");
}

export async function considerPullRequest(repository, pull, enforcementRules = null) {
  const ref = `${repoName(repository)}#${pull.number}`;

  if (pull.isDraft) return { repo: repoName(repository), pr: ref, action: "skip", reason: "draft" };
  if (!isWorkerPullRequest(pull, repository)) return { repo: repoName(repository), pr: ref, action: "skip", reason: "not-worker-pr" };

  const protection = inspectManagedBranchProtection(await getBranchProtection(gh, repository, pull.baseRefName));
  if (!protection.ok) {
    const issueUpdate = await markWorkerIssueBlocked(repository, pull, "merge-policy-blocked", protection.findings);
    return {
      repo: repoName(repository),
      pr: ref,
      action: "skip",
      reason: "merge-policy-blocked",
      issue_update: issueUpdate,
      findings: protection.findings
    };
  }

  const rules = enforcementRules ?? (await loadEnforcementRules());
  const registry = await readManagedRepoRegistry();
  const requiredContexts = protection.requiredChecks;
  const autoreview = { required: true, source: "branch-protection" };

  const enforcement = await evaluateEnforcementRules(rules, {
    gh,
    repository,
    pull,
    baseBranch: pull.baseRefName,
    registry,
    requiredContexts,
    statusCheckRollup: pull.statusCheckRollup,
    token: process.env.DARK_FACTORY_TOKEN || ""
  });

  if (!enforcement.ok) {
    const issueUpdate = await markWorkerIssueBlocked(repository, pull, "enforcement-rules", [
      ...enforcement.findings.filter((finding) => finding.severity === "block").map((finding) => `${finding.rule}: ${finding.message}`)
    ]);
    return {
      repo: repoName(repository),
      pr: ref,
      action: "skip",
      reason: "enforcement-rules",
      issue_update: issueUpdate,
      findings: enforcement.findings
    };
  }

  if (!emptyCheckRollupHasSettled(pull)) {
    return { repo: repoName(repository), pr: ref, action: "skip", reason: "checks-not-reported-yet" };
  }

  if (!checksAreGreen(pull.statusCheckRollup, requiredContexts)) {
    const reason = requiredContexts.length && !pull.statusCheckRollup?.length
      ? "required-checks-missing"
      : "checks-not-green";
    const issueUpdate = await markWorkerIssueBlocked(repository, pull, reason, [
      `Required checks: ${requiredContexts.length ? requiredContexts.join(", ") : "(none configured)"}`,
      `Reported checks: ${checksSummary(pull.statusCheckRollup) || "(none)"}`
    ]);
    return {
      repo: repoName(repository),
      pr: ref,
      action: "skip",
      reason,
      issue_update: issueUpdate,
      required_checks: requiredContexts,
      checks: checksSummary(pull.statusCheckRollup),
      ...autoreviewLedgerGap(autoreview)
    };
  }
  if (pull.mergeable !== "MERGEABLE") {
    const reason = `mergeable-${pull.mergeable}`;
    const issueUpdate = await markWorkerIssueBlocked(repository, pull, reason, [
      `GitHub mergeability is \`${pull.mergeable || "unknown"}\`.`
    ]);
    return { repo: repoName(repository), pr: ref, action: "skip", reason, issue_update: issueUpdate };
  }

  const mergeGate = await getPullRequestMergeGate(repository, pull.number);
  const hasMergeGateChecks = Array.isArray(mergeGate.statusCheckRollup) && mergeGate.statusCheckRollup.length > 0;
  if (!hasMergeGateChecks || !checksAreGreen(mergeGate.statusCheckRollup, requiredContexts)) {
    const issueUpdate = await markWorkerIssueBlocked(repository, pull, "merge-checks-not-green", [
      "Fresh merge gate check failed immediately before merge.",
      `Required checks: ${requiredContexts.join(", ")}`,
      `Reported checks: ${checksSummary(mergeGate.statusCheckRollup) || "(none)"}`
    ]);
    return {
      repo: repoName(repository),
      pr: ref,
      action: "skip",
      reason: "merge-checks-not-green",
      issue_update: issueUpdate,
      checks: checksSummary(mergeGate.statusCheckRollup),
      ...autoreviewLedgerGap(autoreview)
    };
  }
  if (mergeGate.mergeable !== "MERGEABLE") {
    const reason = `mergeable-${mergeGate.mergeable}`;
    const issueUpdate = await markWorkerIssueBlocked(repository, pull, reason, [
      `Fresh GitHub mergeability is \`${mergeGate.mergeable || "unknown"}\`.`
    ]);
    return { repo: repoName(repository), pr: ref, action: "skip", reason, issue_update: issueUpdate };
  }

  const issueNumber = darkFactoryWorkerIssueNumber(pull);
  if (issueNumber) {
    const issue = await gh.request("GET", `/repos/${repoName(repository)}/issues/${issueNumber}`);
    if (!isVerifiedWorkerIssue(issue)) {
      return { repo: repoName(repository), pr: ref, action: "skip", reason: "not-verified", issue: `#${issueNumber}` };
    }
  }

  const enabled = await enableAutoMerge(pull.id);
  if (enabled.enabled) {
    return {
      repo: repoName(repository),
      pr: ref,
      url: pull.url,
      action: "enable-automerge",
      result: enabled,
      checks: checksSummary(pull.statusCheckRollup),
      ...autoreviewLedgerGap(autoreview)
    };
  }

  if (!canDirectMergeAfterAutomergeFailure(enabled.reason)) {
    const issueUpdate = await markWorkerIssueBlocked(repository, pull, "protected-branch-automerge-failed", [
      `Auto-merge failed: ${enabled.reason || "unknown error"}`
    ]);
    return {
      repo: repoName(repository),
      pr: ref,
      url: pull.url,
      action: "skip",
      reason: "protected-branch-automerge-failed",
      automerge_error: enabled.reason,
      issue_update: issueUpdate,
      checks: checksSummary(pull.statusCheckRollup),
      ...autoreviewLedgerGap(autoreview)
    };
  }

  const merged = await mergePullRequest(repository, mergeGate);
  return {
    repo: repoName(repository),
    pr: ref,
    url: pull.url,
    action: "merge",
    sha: merged.sha,
    base: pull.baseRefName,
    direct_merge_reason: enabled.reason,
    checks: checksSummary(mergeGate.statusCheckRollup),
    ...autoreviewLedgerGap(autoreview)
  };
}

async function autoreviewProvisioning(repository, pull) {
  if (hasAutoreviewContext(pull.statusCheckRollup)) {
    return { required: true, source: "reported-check" };
  }

  if (await managedConfigDeclaresAutoreview(repository, pull.baseRefName)) {
    return { required: true, source: "managed-config" };
  }

  const message = [
    `DarkFactory sweep warning ${repoName(repository)}#${pull.number}:`,
    `${AUTOREVIEW_REQUIRED_CONTEXT} context is absent and managed config does not declare .github/workflows/darkfactory-autoreview.yml;`,
    "falling back to branch-protection checks only."
  ].join(" ");
  console.warn(message);
  return {
    required: false,
    source: "not-provisioned",
    warning: "darkfactory-autoreview-not-provisioned",
    message
  };
}

function hasAutoreviewContext(statusCheckRollup) {
  if (!Array.isArray(statusCheckRollup)) return false;
  return statusCheckRollup.some((check) => {
    const name = checkContextName(check).trim().toLowerCase();
    return name === AUTOREVIEW_REQUIRED_CONTEXT.toLowerCase();
  });
}

async function managedConfigDeclaresAutoreview(repository, ref) {
  const content = await getOptionalFileContent(gh, repository, ".darkfactory/managed-repository.json", ref);
  if (!content) return false;

  try {
    const config = JSON.parse(content);
    return managedConfigPaths(config).some((filePath) => filePath === ".github/workflows/darkfactory-autoreview.yml");
  } catch (error) {
    console.warn(`DarkFactory sweep warning ${repoName(repository)}: invalid .darkfactory/managed-repository.json: ${error.message || String(error)}`);
    return false;
  }
}

function managedConfigPaths(config) {
  const paths = [];
  for (const key of ["requiredFiles", "managedFiles", "installedFiles", "workflows"]) {
    if (!Array.isArray(config?.[key])) continue;
    for (const item of config[key]) {
      if (typeof item === "string") paths.push(item);
      else if (typeof item?.path === "string") paths.push(item.path);
    }
  }
  return paths.map((filePath) => filePath.trim().replace(/^\/+/, ""));
}

function checkContextName(check) {
  if (check.__typename === "CheckRun") return check.name || "";
  if (check.__typename === "StatusContext") return check.context || "";
  return "";
}

function autoreviewLedgerGap(autoreview) {
  if (autoreview.warning !== "darkfactory-autoreview-not-provisioned") return {};
  return {
    autoreview_gap: {
      warning: autoreview.warning,
      message: autoreview.message
    }
  };
}

function emptyCheckRollupHasSettled(pull) {
  if (Array.isArray(pull.statusCheckRollup) && pull.statusCheckRollup.length > 0) return true;

  const changedAt = Date.parse(pull.updatedAt || pull.createdAt || "");
  return Number.isFinite(changedAt) && Date.now() - changedAt >= EMPTY_CHECK_SETTLE_MS;
}

function canDirectMergeAfterAutomergeFailure(reason) {
  return /pull request is in clean status/i.test(reason || "");
}

async function mergePullRequest(repository, pull) {
  const ref = `${repoName(repository)}#${pull.number}`;
  let merged;
  try {
    merged = await gh.request("PUT", `/repos/${repoName(repository)}/pulls/${pull.number}/merge`, {
      commit_title: pull.title,
      merge_method: "squash"
    });
  } catch (error) {
    console.error(`DarkFactory sweep merge error ${ref}: ${error.message || String(error)}`);
    throw error;
  }

  try {
    await closeIssuesIfDevMerge(repository, pull);
  } catch (error) {
    console.warn(`DarkFactory sweep dev-closure warning ${ref}: ${error.message || String(error)}`);
  }
  return merged;
}

async function markWorkerIssueBlocked(repository, pull, reason, details = []) {
  const issueNumber = darkFactoryWorkerIssueNumber(pull);
  if (!issueNumber) return { status: "skipped", reason: "missing-worker-marker" };

  await replaceIssueLabels(repository, issueNumber, ["df:blocked"], ["df:ready", "df:running", "df:done"]);

  const marker = `<!-- dark-factory:sweep-blocked pr=${pull.number} -->`;
  if (!(await hasSweepBlockedComment(repository, issueNumber, marker))) {
    await gh.request("POST", `/repos/${repoName(repository)}/issues/${issueNumber}/comments`, {
      body: [
        marker,
        "DarkFactory follow-through blocked this worker PR.",
        "",
        `PR: ${pull.url || `#${pull.number}`}`,
        `Reason: ${reason}`,
        ...details.map((detail) => `- ${detail}`)
      ].join("\n")
    });
  }

  return { status: "blocked", issue: `#${issueNumber}`, reason };
}

async function hasSweepBlockedComment(repository, issueNumber, marker) {
  const comments = await gh.request("GET", `/repos/${repoName(repository)}/issues/${issueNumber}/comments?per_page=100`);
  return Array.isArray(comments) && comments.some((comment) => String(comment.body || "").includes(marker));
}

async function replaceIssueLabels(repository, issueNumber, add, remove) {
  if (add.length) {
    await gh.request("POST", `/repos/${repoName(repository)}/issues/${issueNumber}/labels`, { labels: add });
  }
  for (const label of remove) {
    try {
      await gh.request("DELETE", `/repos/${repoName(repository)}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`);
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
}

export async function closeDevMergeIssuesFromEnv() {
  return await closeVerifiedDevMergeIssues({
    repositoryName: process.env.DF_DEV_MERGE_REPO || "",
    pullNumber: process.env.DF_DEV_MERGE_PR || "",
    mergeSha: process.env.DF_DEV_MERGE_SHA || ""
  });
}

export async function closeVerifiedDevMergeIssues(request) {
  let repository;
  const ledger = {
    trigger: TRIGGER,
    mode: "dev-merge",
    requested: {
      repository: String(request.repositoryName || ""),
      pull_number: String(request.pullNumber || ""),
      merge_sha: String(request.mergeSha || "")
    },
    actions: [],
    token_usage: {
      model_calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      note: "Issue closure on dev merge is deterministic"
    }
  };
  try {
    const verified = await verifyDevMergeRequest(request);
    repository = verified.repository;
    ledger.verified = {
      repository: repoName(repository),
      pull_number: verified.pull.number,
      merge_sha: verified.pull.mergeCommitSha,
      merged_at: verified.pull.mergedAt,
      base: verified.pull.baseRefName,
      head: verified.pull.headRefName,
      closing_issues: verified.closingIssues
    };
    const action = await closeIssuesIfDevMerge(repository, verified.pull);
    ledger.actions.push(action);
  } catch (error) {
    ledger.actions.push({
      repo: repository ? repoName(repository) : String(request.repositoryName || "invalid"),
      pr: String(request.pullNumber || ""),
      action: "error",
      reason: "dev-merge-verification-or-closure-failed",
      error: error.message || String(error)
    });
    await writeLedger("df-sweep", repository ? repoName(repository) : "invalid-dev-merge-target", ledger);
    throw error;
  }

  // Ledger failure is deliberately a warning after the target issue mutation:
  // the scheduled recovery scan will prove convergence again without undoing it.
  await writeLedger("df-sweep", repoName(repository), ledger);
  return ledger.actions[0];
}

export async function verifyDevMergeRequest(request) {
  const repositoryName = String(request.repositoryName || "").trim();
  const pullNumberText = String(request.pullNumber || "").trim();
  const mergeSha = String(request.mergeSha || "").trim().toLowerCase();
  if (!repositoryName) throw new Error("Missing exact dev-merge repository identifier.");
  if (!/^[1-9][0-9]*$/.test(pullNumberText)) throw new Error("Invalid exact dev-merge pull request number.");
  if (!/^[0-9a-f]{40}$/.test(mergeSha)) throw new Error("Invalid exact dev-merge commit SHA.");

  const repository = parseRepo(repositoryName);
  if (!CONTROL_REPO || repository.owner.toLowerCase() !== CONTROL_REPO.owner.toLowerCase()) {
    throw new Error(`Dev-merge closure is restricted to the ${CONTROL_REPO?.owner || "control"} owner.`);
  }
  assertAllowedRepo(repository);

  const registry = await readManagedRepoRegistry();
  const lifecycle = managedRepoLifecycleState(repository, registry);
  if (lifecycle !== "active") {
    throw new Error(`Refusing dev-merge closure for managed lifecycle state '${lifecycle}'.`);
  }

  const liveRepository = await getRepository(gh, repository);
  if (liveRepository?.archived === true || liveRepository?.disabled === true) {
    throw new Error(`Refusing dev-merge closure for archived=${liveRepository?.archived === true} disabled=${liveRepository?.disabled === true}.`);
  }
  if (typeof liveRepository?.full_name !== "string"
      || liveRepository.full_name.toLowerCase() !== repoName(repository).toLowerCase()) {
    throw new Error("GitHub repository identity did not match the requested managed repository.");
  }

  const pullNumber = Number(pullNumberText);
  const rawPull = await gh.request("GET", `/repos/${repoName(repository)}/pulls/${pullNumber}`);
  if (rawPull?.number !== pullNumber) throw new Error("GitHub pull request identity did not match the requested number.");
  if (rawPull?.state !== "closed" || rawPull?.merged !== true || !rawPull?.merged_at) {
    throw new Error("GitHub does not report the requested pull request as merged.");
  }
  if (rawPull?.base?.ref !== "dev") throw new Error("Merged pull request base is not dev.");
  if (String(rawPull?.base?.repo?.full_name || "").toLowerCase() !== repoName(repository).toLowerCase()) {
    throw new Error("Merged pull request base repository does not match the managed target.");
  }
  if (String(rawPull?.merge_commit_sha || "").toLowerCase() !== mergeSha) {
    throw new Error("Merged pull request commit SHA does not match the immutable dispatch identity.");
  }

  const mergeCommit = await gh.request("GET", `/repos/${repoName(repository)}/commits/${mergeSha}`);
  if (String(mergeCommit?.sha || "").toLowerCase() !== mergeSha) {
    throw new Error("GitHub did not return the exact merged commit identity.");
  }

  const pull = normalizeRestPullRequest(rawPull);
  if (!isWorkerPullRequest(pull, repository)) {
    throw new Error("Merged pull request does not have trusted DarkFactory worker provenance.");
  }
  const closingIssues = extractClosingIssueNumbers(pull.body || "", repoName(repository));
  if (closingIssues.length === 0) {
    throw new Error("Merged worker pull request has no same-repository closing issue reference.");
  }

  return { repository, pull, closingIssues };
}

export async function closeIssuesIfDevMerge(repository, pull) {
  if (pull.baseRefName !== "dev") {
    return { repo: repoName(repository), pr: pull.url, action: "skip-dev-closure", reason: `base-${pull.baseRefName}` };
  }
  if (!isWorkerPullRequest(pull, repository)) {
    return { repo: repoName(repository), pr: pull.url, action: "skip-dev-closure", reason: "not-worker-pr" };
  }

  const issueNumbers = extractClosingIssueNumbers(pull.body || "", repoName(repository));
  const changed = [];
  for (const issue_number of issueNumbers) {
    const issue = await gh.request("GET", `/repos/${repoName(repository)}/issues/${issue_number}`);
    if (issue?.pull_request) {
      throw new Error(`Closing reference #${issue_number} resolves to a pull request, not an issue.`);
    }
    let mutated = false;
    if (!(await hasDevMergeComment(repository, issue_number, pull.url))) {
      await gh.request("POST", `/repos/${repoName(repository)}/issues/${issue_number}/comments`, {
        body: `merged to dev in ${pull.url}, enters canonical main through the next Agent OS integration PR`
      });
      mutated = true;
    }
    if (issue?.state !== "closed") {
      await gh.request("PATCH", `/repos/${repoName(repository)}/issues/${issue_number}`, { state: "closed" });
      mutated = true;
    }
    if (mutated) changed.push(issue_number);
  }
  return {
    repo: repoName(repository),
    pr: pull.url,
    action: "close-dev-merge-issues",
    issues: changed,
    closing_refs: issueNumbers
  };
}

async function closeRecentlyMergedDevIssues(repository) {
  const pulls = await gh.request(
    "GET",
    `/repos/${repoName(repository)}/pulls?state=closed&sort=updated&direction=desc&per_page=50`
  );
  if (!Array.isArray(pulls)) return [];

  const results = [];
  for (const pull of pulls) {
    // The list endpoint does not reliably expose merged status; fetch the
    // single PR to get the exact merge timestamp and full payload.
    if (pull.base?.ref !== "dev") continue;
    const full = await gh.request("GET", `/repos/${repoName(repository)}/pulls/${pull.number}`);
    const normalized = normalizeRestPullRequest(full);
    if (!normalized.mergedAt || normalized.baseRefName !== "dev" || !isWorkerPullRequest(normalized, repository)) continue;
    const action = await closeIssuesIfDevMerge(repository, normalized);
    if (action.issues?.length) results.push(action);
  }
  return results;
}

async function hasDevMergeComment(repository, issueNumber, pullUrl) {
  const comments = await gh.request(
    "GET",
    `/repos/${repoName(repository)}/issues/${issueNumber}/comments?per_page=100`
  );
  return Array.isArray(comments) && comments.some((comment) => {
    return typeof comment.body === "string" && comment.body.includes(`merged to dev in ${pullUrl}`);
  });
}

async function targetRepositories() {
  const configured = repoList(process.env.DF_SWEEP_REPOS || "");
  if (configured.length) return await filterConfiguredActiveManagedRepos(configured);

  return await listActiveManagedRepos(gh, CONTROL_REPO);
}

async function filterConfiguredActiveManagedRepos(configured) {
  const registry = await readManagedRepoRegistry();
  const active = [];

  for (const repository of configured) {
    if (repository.owner !== CONTROL_REPO.owner) {
      console.warn(`DarkFactory skipped configured sweep repository ${repoName(repository)} because it is outside ${CONTROL_REPO.owner}.`);
      continue;
    }

    const state = managedRepoLifecycleState(repository, registry);
    if (state !== "active") {
      console.warn(`DarkFactory skipped configured sweep repository ${repoName(repository)} because managed lifecycle state is '${state}'.`);
      continue;
    }

    try {
      const repo = await getRepository(gh, repository);
      if (repo.archived === true || repo.disabled === true) {
        console.warn(`DarkFactory skipped configured sweep repository ${repoName(repository)} because GitHub reports archived=${repo.archived === true} disabled=${repo.disabled === true}.`);
        continue;
      }
    } catch (error) {
      if (warnReadOnlyRepository(repository, error, "configured follow-through")) continue;
      throw error;
    }

    active.push(repository);
  }

  active.sort((a, b) => normalizedRepoName(a).localeCompare(normalizedRepoName(b)));
  return active;
}

function repoList(value) {
  return value
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map(parseRepo);
}

async function listOpenPullRequests(repository) {
  const baseBranches = await sweepBaseBranches(repository);
  const query = `
    query Pulls($owner: String!, $repo: String!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        pullRequests(states: OPEN, first: 100, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            number
            title
            body
            url
            createdAt
            updatedAt
            isDraft
            mergeable
            baseRefName
            headRefName
            headRepository {
              name
              owner { login }
            }
            author { __typename login }
            statusCheckRollup {
              contexts(first: 50) {
                nodes {
                  __typename
                  ... on CheckRun {
                    name
                    status
                    conclusion
                  }
                  ... on StatusContext {
                    context
                    state
                  }
                }
              }
            }
          }
        }
      }
    }`;
  const pulls = [];
  let cursor = null;

  for (let page = 1; page <= 20; page += 1) {
    const data = await gh.graphql(query, { owner: repository.owner, repo: repository.repo, cursor });
    const connection = data.repository.pullRequests;
    pulls.push(...connection.nodes.map((pull) => ({
      ...pull,
      statusCheckRollup: pull.statusCheckRollup?.contexts?.nodes || []
    })));

    if (!connection.pageInfo?.hasNextPage) break;
    cursor = connection.pageInfo.endCursor;
  }

  return {
    pulls: pulls.filter((pull) => {
      return baseBranches.has(pull.baseRefName) && String(pull.headRefName || "").startsWith("df/");
    }),
    baseBranches
  };
}

async function sweepBaseBranches(repository) {
  if (WORK_BRANCH) return new Set([WORK_BRANCH]);

  const repo = await getRepository(gh, repository);
  return new Set(["dev", repo.default_branch].filter(Boolean));
}

async function getPullRequestMergeGate(repository, pullNumber) {
  const query = `
    query PullForMergeGate($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          id
          number
          title
          body
          url
          isDraft
          mergeable
          baseRefName
          headRefName
          headRepository {
            name
            owner { login }
          }
          author { __typename login }
          statusCheckRollup {
            contexts(first: 100) {
              nodes {
                __typename
                ... on CheckRun {
                  name
                  status
                  conclusion
                }
                ... on StatusContext {
                  context
                  state
                }
              }
            }
          }
        }
      }
    }`;
  const data = await gh.graphql(query, { owner: repository.owner, repo: repository.repo, number: pullNumber });
  const pull = data.repository.pullRequest;
  return {
    ...pull,
    statusCheckRollup: pull.statusCheckRollup?.contexts?.nodes || []
  };
}

function normalizeRestPullRequest(pull) {
  // Preserve the REST merged_at field so the dev-merge closure backstop can
  // distinguish merged PRs from merely closed ones.
  const mergedAt = pull.merged_at || null;
  return {
    number: pull.number,
    title: pull.title,
    body: pull.body || "",
    url: pull.html_url,
    author: { login: pull.user?.login || "", type: pull.user?.type || "" },
    headRefName: pull.head?.ref || "",
    headRepository: {
      name: pull.head?.repo?.name || "",
      owner: { login: pull.head?.repo?.owner?.login || "" }
    },
    baseRefName: pull.base?.ref || "",
    baseRepository: pull.base?.repo?.full_name || "",
    headSha: pull.head?.sha || "",
    baseSha: pull.base?.sha || "",
    state: pull.state || "",
    merged: pull.merged === true,
    mergeCommitSha: pull.merge_commit_sha || "",
    mergedAt
  };
}

async function enableAutoMerge(pullRequestId) {
  try {
    await gh.graphql(
      `mutation EnableAutoMerge($pullRequestId: ID!) {
        enablePullRequestAutoMerge(input: {pullRequestId: $pullRequestId, mergeMethod: SQUASH}) {
          pullRequest { url }
        }
      }`,
      { pullRequestId }
    );
    return { enabled: true };
  } catch (error) {
    return { enabled: false, reason: error.message || String(error) };
  }
}

async function writeLedger(kind, targetRepoName, ledger) {
  try {
    const written = await writeRunLedger(gh, DATA_REPO, kind, targetRepoName, ledger);
    console.log(`DarkFactory ledger written to ${written.repository}/${written.path}`);
  } catch (error) {
    console.warn(`DarkFactory ledger warning: ${error.message || String(error)}`);
  }
}
