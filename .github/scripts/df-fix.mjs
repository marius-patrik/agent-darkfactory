import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DARK_FACTORY_DATA_REPO,
  WORK_LABELS,
  assertAllowedRepo,
  checksAreGreen,
  checksSummary,
  createGithubClient,
  darkFactoryWorkerIssueNumber,
  ensureLabels,
  getRequiredStatusCheckContexts,
  isDarkFactoryWorkerPullRequest,
  isParkedRepo,
  listActiveManagedRepos,
  parseRepo,
  repoName,
  requiredEnv,
  sanitize,
  writeRunLedger
} from "./df-lib.mjs";

const CONTROL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_MAX_ROUNDS = 3;
const EMPTY_CHECK_SETTLE_MS = 10 * 60 * 1000;
const REVISION_MARKER = "<!-- df-fix-revision -->";

export function parseFixRound(labels = [], body = "") {
  const rounds = [];
  for (const label of labels) {
    const name = typeof label === "string" ? label : label?.name;
    const match = name?.match(/^df:fix-round:(\d+)$/);
    if (match) rounds.push(Number(match[1]));
  }
  for (const match of String(body || "").matchAll(/df:fix-round:(\d+)/g)) {
    rounds.push(Number(match[1]));
  }
  return rounds.filter((round) => Number.isInteger(round) && round > 0).reduce((max, round) => Math.max(max, round), 0);
}

export function parseRevisionRound(comments = []) {
  const rounds = [];
  for (const comment of comments) {
    const body = String(comment?.body || "");
    if (!body.includes(REVISION_MARKER)) continue;
    for (const match of body.matchAll(/\bround:\s*(\d+)\b|df:fix-round:(\d+)/g)) {
      rounds.push(Number(match[1] || match[2]));
    }
  }
  return rounds.filter((round) => Number.isInteger(round) && round > 0).reduce((max, round) => Math.max(max, round), 0);
}

export function nextFixRound(pull) {
  return parseFixRound(pull.labels || [], pull.body || "") + 1;
}

export function extractBlockingFindings(reviewComment) {
  const text = String(reviewComment || "");
  const lines = text.split(/\r?\n/);
  let start = -1;

  for (let i = 0; i < lines.length; i += 1) {
    if (/^###\s+Blocking Findings\s*$/i.test(lines[i])) {
      start = i;
      break;
    }
  }

  if (start === -1) {
    return text
      ? `- Could not locate a \`### Blocking Findings\` section. Review comment excerpt: ${truncate(text, 2000)}`
      : "- No DarkFactory Autoreview blocking comment was found.";
  }

  const bullets = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^#{1,6}\s/.test(line)) break;
    const match = line.match(/^\s*[-*]\s+(.*)$/);
    if (match) bullets.push(`- ${match[1].trim()}`);
  }

  if (!bullets.length) return "- DarkFactory Autoreview had a blocking section, but no bullet findings were parsed.";
  return bullets.join("\n");
}

export function classifyFixCandidate(pull, repository, requiredContexts = [], options = {}) {
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const ref = `${repoName(repository)}#${pull.number}`;

  if (isParkedRepo(repository)) return { pr: ref, action: "skip", reason: "parked" };
  if (pull.isDraft) return { pr: ref, action: "skip", reason: "draft" };
  if (!isDarkFactoryWorkerPullRequest(pull, repository)) {
    return { pr: ref, action: "skip", reason: "not-worker-pr" };
  }

  const statusCheckRollup = Array.isArray(pull.statusCheckRollup) ? pull.statusCheckRollup : [];
  if (checksAreGreen(statusCheckRollup, requiredContexts)) {
    return { pr: ref, action: "skip", reason: "checks-green" };
  }

  if (!emptyCheckRollupHasSettled(pull)) {
    return { pr: ref, action: "skip", reason: "checks-not-reported-yet" };
  }

  const state = checkFailureState(statusCheckRollup, requiredContexts);
  if (state === "pending") return { pr: ref, action: "skip", reason: "checks-pending" };

  const round = options.currentRound ?? parseFixRound(pull.labels || [], pull.body || "");
  if (round >= maxRounds) {
    return { pr: ref, action: "escalate", reason: "max-rounds", round, maxRounds };
  }

  return { pr: ref, action: "fix", reason: state, round: round + 1, maxRounds };
}

export function checkFailureState(statusCheckRollup = [], requiredContexts = []) {
  const present = new Set();
  let pending = false;
  let failing = false;

  for (const check of statusCheckRollup) {
    const name = checkName(check);
    if (name) present.add(name);

    if (check.__typename === "CheckRun") {
      if (check.status !== "COMPLETED") {
        pending = true;
        continue;
      }
      if (check.conclusion !== "SUCCESS") failing = true;
      continue;
    }

    if (check.__typename === "StatusContext") {
      if (check.state === "PENDING" || check.state === "EXPECTED") {
        pending = true;
        continue;
      }
      if (check.state !== "SUCCESS") failing = true;
      continue;
    }
  }

  if (requiredContexts.some((context) => !present.has(context))) return "required-checks-missing";
  if (failing) return "checks-failing";
  if (pending) return "pending";
  return "checks-not-green";
}

function emptyCheckRollupHasSettled(pull) {
  if (Array.isArray(pull.statusCheckRollup) && pull.statusCheckRollup.length > 0) return true;

  const changedAt = Date.parse(pull.updatedAt || pull.createdAt || "");
  return Number.isFinite(changedAt) && Date.now() - changedAt >= EMPTY_CHECK_SETTLE_MS;
}

function checkName(check) {
  if (check.__typename === "CheckRun") return check.name || "";
  if (check.__typename === "StatusContext") return check.context || "";
  return "";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const token = process.env.DARK_FACTORY_TOKEN || "";
    console.error(sanitize(error.stack || error.message || String(error), token));
    process.exitCode = 1;
  });
}

async function main() {
  const token = requiredEnv("DARK_FACTORY_TOKEN");
  const controlRepo = parseRepo(requiredEnv("DF_CONTROL_REPO"));
  const dataRepo = DARK_FACTORY_DATA_REPO;
  const trigger = process.env.DF_TRIGGER ?? "unknown";
  const maxRounds = parseMaxRounds(process.env.DF_MAX_FIX_ROUNDS);
  const gh = createGithubClient(token, "darkfactory-fix");
  const ledger = {
    trigger,
    control_repo: repoName(controlRepo),
    max_rounds: maxRounds,
    actions: [],
    token_usage: {
      model_calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      note: "Fix-forward is deterministic and uses no model calls"
    }
  };

  assertAllowedRepo(controlRepo);
  await ensureLabels(gh, controlRepo, WORK_LABELS);
  const repositories = await listActiveManagedRepos(gh, controlRepo, { root: CONTROL_ROOT });

  for (const repository of repositories) {
    if (isParkedRepo(repository)) {
      ledger.actions.push({ repo: repoName(repository), action: "skip", reason: "parked" });
      continue;
    }

    try {
      assertAllowedRepo(repository);
      await ensureLabels(gh, repository, WORK_LABELS);
      const pulls = await listOpenPullRequests(gh, repository);
      for (const pull of pulls) {
        const requiredStatus = await getRequiredStatusCheckContexts(gh, repository, pull.baseRefName);
        if (requiredStatus.healthy !== true) {
          ledger.actions.push({
            repo: repoName(repository),
            pr: `${repoName(repository)}#${pull.number}`,
            action: "blocked",
            reason: requiredStatus.observable === false
              ? "branch-protection-inaccessible"
              : requiredStatus.configured === false
                ? "branch-protection-missing"
                : "managed-gates-unhealthy",
            protection_status: requiredStatus.status,
            findings: requiredStatus.findings
          });
          continue;
        }
        const requiredContexts = requiredStatus.contexts;
        const classification = classifyFixCandidate(pull, repository, requiredContexts, { maxRounds });

        if (classification.action === "fix") {
          ledger.actions.push(await fixPullRequestByRedispatch(gh, controlRepo, repository, pull, classification, requiredContexts, { maxRounds, token }));
          continue;
        }

        if (classification.action === "escalate") {
          const findings = await residualFindings(gh, repository, pull, requiredContexts, token);
          ledger.actions.push(await escalatePullRequest(gh, repository, pull, classification, findings, token));
          continue;
        }

        ledger.actions.push({ repo: repoName(repository), ...classification });
      }
    } catch (error) {
      ledger.actions.push({
        repo: repoName(repository),
        action: "error",
        error: sanitize(error.stack || error.message || String(error), token)
      });
    }
  }

  try {
    const written = await writeRunLedger(gh, dataRepo, "df-fix", repoName(controlRepo), ledger);
    console.log(`DarkFactory ledger written to ${written.repository}/${written.path}`);
  } catch (error) {
    console.warn(sanitize(`DarkFactory ledger warning: ${error.message || String(error)}`, token));
  }

  const regenerated = ledger.actions.filter((action) => action.action === "reevaluate").length;
  const escalated = ledger.actions.filter((action) => action.action === "escalate").length;
  console.log(`DarkFactory fix cycle processed ${repositories.length} repos; regenerated=${regenerated} escalated=${escalated}.`);
}

async function listOpenPullRequests(gh, repository) {
  const pulls = [];
  let cursor = null;
  const query = `
    query Pulls($owner: String!, $repo: String!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        pullRequests(states: OPEN, first: 50, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
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
            headRefOid
            labels(first: 50) {
              nodes { name }
            }
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
      }
    }`;
  do {
    const data = await gh.graphql(query, { owner: repository.owner, repo: repository.repo, cursor });
    const page = data.repository.pullRequests;
    pulls.push(...page.nodes.map((pull) => ({
      ...pull,
      labels: pull.labels?.nodes || [],
      statusCheckRollup: pull.statusCheckRollup?.contexts?.nodes || []
    })));
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return pulls;
}

export async function fixPullRequestByRedispatch(gh, controlRepo, repository, pull, classification, requiredContexts, options = {}) {
  const token = options.token || "";
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const issueNumber = darkFactoryWorkerIssueNumber(pull);
  const ref = `${repoName(repository)}#${pull.number}`;

  if (!issueNumber) {
    return { repo: repoName(repository), pr: ref, action: "skip", reason: "missing-worker-marker" };
  }

  const issue = await getIssue(gh, repository, issueNumber);
  const issueComments = await listIssueComments(gh, repository, issueNumber);
  const currentRound = Math.max(
    parseFixRound(issue.labels || [], issue.body || ""),
    parseFixRound(pull.labels || [], pull.body || ""),
    parseRevisionRound(issueComments)
  );

  if (currentRound >= maxRounds) {
    const findings = await residualFindings(gh, repository, pull, requiredContexts, token);
    return await escalatePullRequest(
      gh,
      repository,
      pull,
      { ...classification, action: "escalate", reason: "max-rounds", round: currentRound, maxRounds },
      findings,
      token
    );
  }

  const freshPull = await getPullRequestForFix(gh, repository, pull.number);
  const trustFailure = fixTrustFailure(pull, freshPull, repository);
  if (trustFailure) {
    return {
      repo: repoName(repository),
      pr: ref,
      url: freshPull.url || pull.url,
      action: "skip",
      reason: "fix-trust-failed",
      trust_failure: trustFailure
    };
  }
  if (checksAreGreen(freshPull.statusCheckRollup, requiredContexts)) {
    return {
      repo: repoName(repository),
      pr: ref,
      url: freshPull.url || pull.url,
      action: "skip",
      reason: "fix-checks-now-green",
      checks: checksSummary(freshPull.statusCheckRollup)
    };
  }

  const round = currentRound + 1;
  const findings = await residualFindings(gh, repository, freshPull, requiredContexts, token);
  const revision = await postRevisionRequest(gh, repository, issue, freshPull, round, maxRounds, findings);
  await updateIssueFixRound(gh, repository, issue, round);
  await resetIssueForEvaluation(gh, repository, issueNumber);
  await closeSupersededPullRequest(gh, repository, freshPull, round);
  const branchDeletion = await deleteHeadBranch(gh, repository, freshPull.headRefName);
  await dispatchOrchestratorEvaluation(gh, controlRepo, repository, issueNumber);

  return {
    repo: repoName(repository),
    pr: ref,
    url: freshPull.url || pull.url,
    action: "reevaluate",
    issue: `#${issueNumber}`,
    round,
    max_rounds: maxRounds,
    reason: classification.reason,
    revision,
    stale_pr_closed: true,
    head_branch_deleted: branchDeletion.deleted,
    head_branch: freshPull.headRefName,
    head_branch_delete_reason: branchDeletion.reason,
    dispatched_workflow: "df-orchestrate.yml"
  };
}

async function getIssue(gh, repository, issueNumber) {
  return responseData(await gh.request("GET", `/repos/${repoName(repository)}/issues/${issueNumber}`));
}

async function listIssueComments(gh, repository, issueNumber) {
  const comments = responseData(await gh.request("GET", `/repos/${repoName(repository)}/issues/${issueNumber}/comments?per_page=100`));
  return Array.isArray(comments) ? comments : [];
}

async function getLatestAutoreviewComment(gh, repository, pullNumber) {
  const comments = await listIssueComments(gh, repository, pullNumber);
  const matches = comments
    .filter((comment) => String(comment.body || "").includes("<!-- darkfactory-autoreview -->"))
    .sort((a, b) => Date.parse(b.updated_at || b.created_at || "") - Date.parse(a.updated_at || a.created_at || ""));
  return matches[0]?.body || "";
}

async function getFailingCheckDetails(gh, repository, pull, token) {
  const summary = checksSummary(pull.statusCheckRollup) || "(none)";
  if (!pull.headRefOid) return summary;

  let checks;
  try {
    checks = responseData(await gh.request("GET", `/repos/${repoName(repository)}/commits/${pull.headRefOid}/check-runs?per_page=100`));
  } catch (error) {
    return `Could not read check runs: ${sanitize(error.message || String(error), token)}\nReported checks: ${summary}`;
  }

  const failed = (checks.check_runs || []).filter((check) => {
    return check.status === "completed" && check.conclusion && check.conclusion !== "success";
  });
  if (!failed.length) return summary;

  return failed.slice(0, 8).map((check) => {
    const output = check.output || {};
    const details = [output.summary, output.text].filter(Boolean).join("\n\n");
    return [`### ${check.name}`, `Conclusion: ${check.conclusion}`, details ? truncate(details, 3000) : ""].filter(Boolean).join("\n");
  }).join("\n\n");
}

async function residualFindings(gh, repository, pull, requiredContexts, token) {
  const review = await getLatestAutoreviewComment(gh, repository, pull.number);
  const failing = await getFailingCheckDetails(gh, repository, pull, token);
  return [
    `Required checks: ${requiredContexts.length ? requiredContexts.join(", ") : "(none configured)"}`,
    `Reported checks: ${checksSummary(pull.statusCheckRollup) || "(none)"}`,
    `DarkFactory Autoreview blocking findings:\n${extractBlockingFindings(review)}`,
    failing ? `Failing checks:\n${truncate(failing, 6000)}` : ""
  ].filter(Boolean);
}

async function postRevisionRequest(gh, repository, issue, pull, round, maxRounds, findings) {
  const issueNumber = issue.number;
  const marker = `${REVISION_MARKER}\n<!-- df-fix-revision pr=${pull.number} round=${round} -->`;
  const existing = await hasIssueComment(gh, repository, issueNumber, marker);
  if (existing) return "already-present";

  await gh.request("POST", `/repos/${repoName(repository)}/issues/${issueNumber}/comments`, {
    body: [
      marker,
      `df:fix-round:${round}`,
      "",
      `Previous attempt ${pull.url || `#${pull.number}`} failed review or checks.`,
      `Round: ${round}/${maxRounds}`,
      "",
      "Address these blocking findings in the next attempt:",
      "",
      ...findings.flatMap((finding) => ["- " + truncate(finding, 3000).replace(/\n/g, "\n  ")])
    ].join("\n")
  });
  return "created";
}

async function updateIssueFixRound(gh, repository, issue, round) {
  await ensureFixRoundLabel(gh, repository, round);
  await gh.request("POST", `/repos/${repoName(repository)}/issues/${issue.number}/labels`, { labels: [`df:fix-round:${round}`] });

  const oldRounds = (issue.labels || [])
    .map((label) => typeof label === "string" ? label : label?.name)
    .filter((name) => /^df:fix-round:\d+$/.test(name || "") && name !== `df:fix-round:${round}`);
  for (const label of oldRounds) {
    try {
      await gh.request("DELETE", `/repos/${repoName(repository)}/issues/${issue.number}/labels/${encodeURIComponent(label)}`);
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
}

async function resetIssueForEvaluation(gh, repository, issueNumber) {
  await replaceIssueLabels(gh, repository, issueNumber, [], ["df:ready", "df:running", "df:blocked", "df:done", "df:ask-owner"]);
}

async function closeSupersededPullRequest(gh, repository, pull, round) {
  const marker = `<!-- df-fix-superseded pr=${pull.number} round=${round} -->`;
  if (!(await hasIssueComment(gh, repository, pull.number, marker))) {
    await gh.request("POST", `/repos/${repoName(repository)}/issues/${pull.number}/comments`, {
      body: [
        marker,
        "DarkFactory fix-forward is superseding this red worker PR with a regenerated attempt from the trusted issue.",
        "",
        "This PR is closed so `df-work` can recreate the branch cleanly."
      ].join("\n")
    });
  }
  await gh.request("PATCH", `/repos/${repoName(repository)}/pulls/${pull.number}`, { state: "closed" });
}

async function deleteHeadBranch(gh, repository, branch) {
  try {
    await gh.request("DELETE", `/repos/${repoName(repository)}/git/refs/heads/${encodeRefPath(branch)}`);
    return { deleted: true, reason: "deleted" };
  } catch (error) {
    if (error.status === 404 || error.status === 422) {
      return { deleted: false, reason: error.message || String(error) };
    }
    throw error;
  }
}

async function dispatchOrchestratorEvaluation(gh, controlRepo, repository, issueNumber) {
  await gh.request("POST", `/repos/${repoName(controlRepo)}/actions/workflows/df-orchestrate.yml/dispatches`, {
    ref: "main",
    inputs: {
      repo: repoName(repository),
      issue_number: String(issueNumber),
      source_event: "df-fix"
    }
  });
}

async function escalatePullRequest(gh, repository, pull, classification, findings, token) {
  const issueNumber = darkFactoryWorkerIssueNumber(pull);
  if (!issueNumber) {
    return { repo: repoName(repository), pr: `${repoName(repository)}#${pull.number}`, action: "skip", reason: "missing-worker-marker" };
  }

  await ensureFixRoundLabel(gh, repository, classification.round || classification.maxRounds || DEFAULT_MAX_ROUNDS);
  await gh.request("POST", `/repos/${repoName(repository)}/issues/${issueNumber}/labels`, { labels: ["df:ask-owner"] });

  const marker = `<!-- dark-factory:fix-escalated pr=${pull.number} -->`;
  if (!(await hasIssueComment(gh, repository, issueNumber, marker))) {
    await gh.request("POST", `/repos/${repoName(repository)}/issues/${issueNumber}/comments`, {
      body: [
        marker,
        "DarkFactory fix cycle reached the autonomous round cap and needs owner input.",
        "",
        `PR: ${pull.url || `#${pull.number}`}`,
        `Reason: ${classification.reason}`,
        `Rounds: ${classification.round || classification.maxRounds}/${classification.maxRounds}`,
        "",
        "Residual findings:",
        "",
        ...findings.map((finding) => `- ${truncate(finding, 3000)}`)
      ].join("\n")
    });
  }

  return {
    repo: repoName(repository),
    pr: `${repoName(repository)}#${pull.number}`,
    url: pull.url,
    action: "escalate",
    reason: classification.reason,
    issue: `#${issueNumber}`,
    max_rounds: classification.maxRounds
  };
}

async function ensureFixRoundLabel(gh, repository, round) {
  const label = {
    name: `df:fix-round:${round}`,
    color: "C2E0C6",
    description: `DarkFactory autonomous fix cycle round ${round}`
  };
  try {
    await gh.request("POST", `/repos/${repoName(repository)}/labels`, label);
  } catch (error) {
    if (error.status !== 422) throw error;
  }
}

async function replaceIssueLabels(gh, repository, issueNumber, add, remove) {
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

async function hasIssueComment(gh, repository, issueNumber, marker) {
  const comments = await listIssueComments(gh, repository, issueNumber);
  return comments.some((comment) => String(comment.body || "").includes(marker));
}

export function fixTrustFailure(originalPull, freshPull, repository) {
  const expectedHeadOwner = originalPull.headRepository?.owner?.login || repository.owner;
  const expectedHeadRepo = originalPull.headRepository?.name || repository.repo;
  const actualHeadOwner = freshPull.headRepository?.owner?.login || "";
  const actualHeadRepo = freshPull.headRepository?.name || "";

  if (freshPull.isDraft) return "draft";
  if (freshPull.headRefName !== originalPull.headRefName) return "head-branch-changed";
  if (actualHeadOwner !== expectedHeadOwner || actualHeadRepo !== expectedHeadRepo) return "head-repository-changed";
  if (actualHeadOwner !== repository.owner || actualHeadRepo !== repository.repo) return "fork-head-repository";
  if (!isDarkFactoryWorkerPullRequest(freshPull, repository)) return "not-worker-pr";
  return "";
}

async function getPullRequestForFix(gh, repository, pullNumber) {
  const query = `
    query PullForFix($owner: String!, $repo: String!, $number: Int!) {
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
          headRefOid
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

function parseMaxRounds(value) {
  const parsed = Number(value || DEFAULT_MAX_ROUNDS);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_ROUNDS;
}

function encodeRefPath(ref) {
  return String(ref || "").split("/").map(encodeURIComponent).join("/");
}

function responseData(response) {
  if (response && typeof response === "object" && "data" in response) return response.data;
  return response;
}

function truncate(value, maxLength) {
  if (String(value).length <= maxLength) return String(value);
  return `${String(value).slice(0, maxLength)}\n\n[truncated from ${String(value).length} characters]`;
}
