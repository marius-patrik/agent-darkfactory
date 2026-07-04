import {
  DEFAULT_DATA_REPO,
  assertAllowedRepo,
  checksAreGreen,
  checksSummary,
  createGithubClient,
  extractClosingIssueNumbers,
  parseRepo,
  repoName,
  requiredEnv,
  writeRunLedger
} from "./df-lib.mjs";

const TOKEN = requiredEnv("DARK_FACTORY_TOKEN");
const CONTROL_REPO = parseRepo(requiredEnv("DF_CONTROL_REPO"));
const DATA_REPO = process.env.DF_DATA_REPO ?? DEFAULT_DATA_REPO;
const MODE = process.env.DF_FOLLOW_THROUGH_MODE ?? "sweep";
const TRIGGER = process.env.DF_TRIGGER ?? "unknown";
const DEFAULT_EXCLUDED_REPOS = "marius-patrik/agents-harness";
const gh = createGithubClient(TOKEN, "darkfactory-sweep");

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  if (MODE === "dev-merge") {
    await closeDevMergeIssuesFromEnv();
    return;
  }

  const repos = await targetRepositories();
  const excluded = new Set(repoList(process.env.DF_SWEEP_EXCLUDE_REPOS || DEFAULT_EXCLUDED_REPOS).map((repo) => repoName(repo).toLowerCase()));
  const ledger = {
    trigger: TRIGGER,
    mode: MODE,
    excluded_repos: [...excluded],
    actions: [],
    token_usage: {
      codex_calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      note: "Green-PR sweep is deterministic and uses no model calls"
    }
  };

  for (const repository of repos) {
    if (excluded.has(repoName(repository).toLowerCase())) {
      ledger.actions.push({ repo: repoName(repository), action: "skip", reason: "excluded" });
      continue;
    }

    try {
      assertAllowedRepo(repository);
      const pulls = await listOpenPullRequests(repository);
      for (const pull of pulls) {
        const result = await considerPullRequest(repository, pull);
        ledger.actions.push(result);
      }
      const closureResults = await closeRecentlyMergedDevIssues(repository);
      ledger.actions.push(...closureResults);
    } catch (error) {
      ledger.actions.push({ repo: repoName(repository), action: "error", error: error.message || String(error) });
    }
  }

  await writeLedger("df-sweep", "sweep", ledger);
  const merged = ledger.actions.filter((action) => action.action === "merge" || action.action === "enable-automerge");
  console.log(`DarkFactory sweep processed ${repos.length} repos; merge actions: ${merged.length}.`);
}

async function considerPullRequest(repository, pull) {
  const ref = `${repoName(repository)}#${pull.number}`;

  if (pull.isDraft) return { repo: repoName(repository), pr: ref, action: "skip", reason: "draft" };
  if (!isWorkerPullRequest(pull, repository)) return { repo: repoName(repository), pr: ref, action: "skip", reason: "not-worker-pr" };
  if (!checksAreGreen(pull.statusCheckRollup)) {
    return {
      repo: repoName(repository),
      pr: ref,
      action: "skip",
      reason: "checks-not-green",
      checks: checksSummary(pull.statusCheckRollup)
    };
  }
  if (pull.mergeable !== "MERGEABLE") {
    return { repo: repoName(repository), pr: ref, action: "skip", reason: `mergeable-${pull.mergeable}` };
  }

  const protectedBranch = await branchIsProtected(repository, pull.baseRefName);
  if (protectedBranch) {
    const enabled = await enableAutoMerge(pull.id);
    if (enabled.enabled) {
      return {
        repo: repoName(repository),
        pr: ref,
        url: pull.url,
        action: "enable-automerge",
        result: enabled,
        checks: checksSummary(pull.statusCheckRollup)
      };
    }

    if (!canDirectMergeAfterAutomergeFailure(enabled.reason)) {
      return {
        repo: repoName(repository),
        pr: ref,
        url: pull.url,
        action: "skip",
        reason: "protected-branch-automerge-failed",
        automerge_error: enabled.reason,
        checks: checksSummary(pull.statusCheckRollup)
      };
    }

    const merged = await mergePullRequest(repository, pull);
    return {
      repo: repoName(repository),
      pr: ref,
      url: pull.url,
      action: "merge",
      sha: merged.sha,
      base: pull.baseRefName,
      fallback_from_automerge: enabled.reason,
      checks: checksSummary(pull.statusCheckRollup)
    };
  }

  const merged = await mergePullRequest(repository, pull);
  return {
    repo: repoName(repository),
    pr: ref,
    url: pull.url,
    action: "merge",
    sha: merged.sha,
    base: pull.baseRefName,
    checks: checksSummary(pull.statusCheckRollup)
  };
}

function canDirectMergeAfterAutomergeFailure(reason) {
  return /pull request is in clean status/i.test(reason || "");
}

async function mergePullRequest(repository, pull) {
  const merged = await gh.request("PUT", `/repos/${repoName(repository)}/pulls/${pull.number}/merge`, {
    commit_title: pull.title,
    merge_method: "squash"
  });
  await closeIssuesIfDevMerge(repository, pull);
  return merged;
}

async function closeDevMergeIssuesFromEnv() {
  const payload = JSON.parse(process.env.GITHUB_EVENT_PAYLOAD || "{}");
  const pull = payload.pull_request;
  const repositoryPayload = payload.repository;
  if (!pull?.merged || pull.base?.ref !== "dev" || !repositoryPayload?.full_name) {
    console.log("No merged dev pull request in event payload.");
    return;
  }

  const repository = parseRepo(repositoryPayload.full_name);
  assertAllowedRepo(repository);
  const ledger = {
    trigger: TRIGGER,
    mode: "dev-merge",
    actions: [],
    token_usage: {
      codex_calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      note: "Issue closure on dev merge is deterministic"
    }
  };
  const action = await closeIssuesIfDevMerge(repository, {
    number: pull.number,
    title: pull.title || "",
    author: { login: pull.user?.login || "" },
    url: pull.html_url,
    body: pull.body || "",
    baseRefName: pull.base.ref,
    headRefName: pull.head?.ref || "",
    headRepository: {
      name: pull.head?.repo?.name || "",
      owner: { login: pull.head?.repo?.owner?.login || "" }
    }
  });
  ledger.actions.push(action);
  try {
    await writeLedger("df-sweep", repoName(repository), ledger);
  } catch (error) {
    console.warn(`DarkFactory ledger warning: ${error.message || String(error)}`);
  }
}

async function closeIssuesIfDevMerge(repository, pull) {
  if (pull.baseRefName !== "dev") {
    return { repo: repoName(repository), pr: pull.url, action: "skip-dev-closure", reason: `base-${pull.baseRefName}` };
  }
  if (!isWorkerPullRequest(pull, repository)) {
    return { repo: repoName(repository), pr: pull.url, action: "skip-dev-closure", reason: "not-worker-pr" };
  }

  const issueNumbers = extractClosingIssueNumbers(pull.body || "", repoName(repository));
  const closed = [];
  for (const issue_number of issueNumbers) {
    if (await hasDevMergeComment(repository, issue_number, pull.url)) {
      continue;
    }
    await gh.request("POST", `/repos/${repoName(repository)}/issues/${issue_number}/comments`, {
      body: `merged to dev in ${pull.url}; releases with the next dev→main PR`
    });
    await gh.request("PATCH", `/repos/${repoName(repository)}/issues/${issue_number}`, { state: "closed" });
    closed.push(issue_number);
  }
  return { repo: repoName(repository), pr: pull.url, action: "close-dev-merge-issues", issues: closed };
}

async function closeRecentlyMergedDevIssues(repository) {
  const pulls = await gh.request(
    "GET",
    `/repos/${repoName(repository)}/pulls?state=closed&sort=updated&direction=desc&per_page=50`
  );
  if (!Array.isArray(pulls)) return [];

  const results = [];
  for (const pull of pulls) {
    const normalized = normalizeRestPullRequest(pull);
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
  if (configured.length) return configured;

  try {
    const repositories = [];
    for (let page = 1; page <= 20; page += 1) {
      const data = await gh.request("GET", `/installation/repositories?per_page=100&page=${page}`);
      if (!Array.isArray(data.repositories) || data.repositories.length === 0) break;
      repositories.push(...data.repositories);
      if (data.repositories.length < 100) break;
    }
    return repositories.map((repo) => parseRepo(repo.full_name)).filter((repo) => repo.owner === CONTROL_REPO.owner);
  } catch {
    return [CONTROL_REPO];
  }

  return [CONTROL_REPO];
}

function repoList(value) {
  return value
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map(parseRepo);
}

async function listOpenPullRequests(repository) {
  const query = `
    query Pulls($owner: String!, $repo: String!) {
      repository(owner: $owner, name: $repo) {
        pullRequests(states: OPEN, first: 50, orderBy: {field: UPDATED_AT, direction: DESC}) {
          nodes {
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
            author { login }
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
  const data = await gh.graphql(query, { owner: repository.owner, repo: repository.repo });
  return data.repository.pullRequests.nodes.map((pull) => ({
    ...pull,
    statusCheckRollup: pull.statusCheckRollup?.contexts?.nodes || []
  }));
}

function isWorkerPullRequest(pull, repository) {
  const provenance = `${pull.title || ""}\n${pull.body || ""}`;
  const sameRepositoryHead = pull.headRepository?.owner?.login === repository.owner && pull.headRepository?.name === repository.repo;
  const marker = provenance.match(/<!--\s*dark-factory:worker-pr\s+issue=(\d+)\s*-->/i);
  const markerIssue = marker ? Number(marker[1]) : 0;
  const branchMatchesIssue = Number.isInteger(markerIssue) && markerIssue > 0 && pull.headRefName?.startsWith(`df/${markerIssue}-`);
  const bodyClosesIssue = extractClosingIssueNumbers(pull.body || "", repoName(repository)).includes(markerIssue);
  const botAuthor = /\[bot\]$/i.test(pull.author?.login || "");

  return (
    sameRepositoryHead &&
    botAuthor &&
    Boolean(marker) &&
    branchMatchesIssue &&
    bodyClosesIssue
  );
}

function normalizeRestPullRequest(pull) {
  return {
    number: pull.number,
    title: pull.title,
    body: pull.body || "",
    url: pull.html_url,
    author: { login: pull.user?.login || "" },
    headRefName: pull.head?.ref || "",
    headRepository: {
      name: pull.head?.repo?.name || "",
      owner: { login: pull.head?.repo?.owner?.login || "" }
    },
    baseRefName: pull.base?.ref || "",
    mergedAt: pull.merged_at || null
  };
}

async function branchIsProtected(repository, branch) {
  try {
    await gh.request("GET", `/repos/${repoName(repository)}/branches/${encodeURIComponent(branch)}/protection`);
    return true;
  } catch (error) {
    if (error.status === 404) return false;
    if (error.status === 403 && /enable this feature/i.test(error.message || "")) return false;
    throw error;
  }
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
