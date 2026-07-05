import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_DATA_REPO,
  WORK_LABELS,
  assertAllowedRepo,
  createGithubClient,
  ensureLabels,
  getRepository,
  listActiveManagedRepos,
  parseRepo,
  preflightMergePolicy,
  repoName,
  requiredEnv,
  warnReadOnlyRepository,
  writeRunLedger
} from "./df-lib.mjs";

const CONTROL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TOKEN = requiredEnv("DARK_FACTORY_TOKEN");
const CONTROL_REPO = parseRepo(requiredEnv("DF_CONTROL_REPO"));
const DATA_REPO = process.env.DF_DATA_REPO ?? DEFAULT_DATA_REPO;
const TRIGGER = process.env.DF_TRIGGER ?? "unknown";
const gh = createGithubClient(TOKEN, "darkfactory-orchestrate");

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  assertAllowedRepo(CONTROL_REPO);
  const targets = await targetRepositories();
  const dispatched = [];

  for (const target of targets) {
    try {
      const ready = await listReadyIssues(target);
      for (const issue of ready) {
        try {
          const wasDispatched = await dispatchWorker(target, issue.number);
          if (wasDispatched) dispatched.push({ repo: repoName(target), issue: issue.number });
        } catch (error) {
          if (warnReadOnlyRepository(target, error, "worker dispatch")) continue;
          console.warn(`Failed to dispatch worker for ${repoName(target)}#${issue.number}: ${error.message || String(error)}`);
        }
      }
    } catch (error) {
      if (warnReadOnlyRepository(target, error, "orchestration")) continue;
      console.warn(`Failed to orchestrate ${repoName(target)}: ${error.message || String(error)}`);
    }
  }

  const ledger = {
    trigger: TRIGGER,
    control_repo: repoName(CONTROL_REPO),
    dispatched,
    token_usage: {
      codex_calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      note: "Orchestrator dispatch is deterministic and uses no model calls"
    }
  };

  await writeLedger(ledger);
  console.log(`DarkFactory orchestrator dispatched ${dispatched.length} worker runs.`);
}

async function targetRepositories() {
  return await listActiveManagedRepos(gh, CONTROL_REPO, { root: CONTROL_ROOT });
}

async function listReadyIssues(repository) {
  const issues = [];
  for (let page = 1; page <= 20; page += 1) {
    const batch = await gh.request(
      "GET",
      `/repos/${repoName(repository)}/issues?state=open&labels=df:ready&per_page=100&page=${page}`
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    issues.push(...batch.filter((issue) => !issue.pull_request));
    if (batch.length < 100) break;
  }

  return issues.filter((issue) => {
    const body = issue.body || "";
    if (!/df-prd:[a-z0-9-]+/.test(body)) return false;
    const names = new Set(
      (issue.labels || []).map((label) => (typeof label === "string" ? label : label?.name)).filter(Boolean)
    );
    if (names.has("df:running") || names.has("df:blocked") || names.has("df:done")) return false;
    return true;
  });
}

async function dispatchWorker(repository, issueNumber) {
  const repo = await getRepository(gh, repository);
  const workBaseBranch = await resolveWorkBaseBranch(repository, repo.default_branch);
  const mergePolicy = await preflightMergePolicy(gh, repository, workBaseBranch, repo);
  if (mergePolicy.blocked) {
    await blockIssueBeforeDispatch(repository, issueNumber, workBaseBranch, mergePolicy);
    return false;
  }

  // Claim the issue before dispatch so a subsequent orchestrator tick cannot
  // re-dispatch the same ready issue while the worker workflow is starting.
  await replaceIssueLabels(repository, issueNumber, ["df:running"], ["df:ready"]);
  try {
    await gh.request("POST", `/repos/${repoName(CONTROL_REPO)}/actions/workflows/df-work.yml/dispatches`, {
      ref: "main",
      inputs: {
        repo: repoName(repository),
        issue_number: String(issueNumber)
      }
    });
  } catch (error) {
    // Restore df:ready so the next orchestrator tick can retry; do not leave
    // the issue stranded in df:running when dispatch failed.
    await replaceIssueLabels(repository, issueNumber, ["df:ready"], ["df:running"]);
    throw error;
  }
  return true;
}

async function resolveWorkBaseBranch(repository, defaultBranch) {
  try {
    await gh.request("GET", `/repos/${repoName(repository)}/git/ref/heads/${encodeURIComponent("dev")}`);
    return "dev";
  } catch (error) {
    if (error.status === 404) return defaultBranch;
    throw error;
  }
}

async function blockIssueBeforeDispatch(repository, issueNumber, baseBranch, mergePolicy) {
  await ensureLabels(gh, repository, WORK_LABELS);
  await replaceIssueLabels(repository, issueNumber, ["df:blocked"], ["df:ready", "df:running", "df:done"]);
  await createIssueComment(
    repository,
    issueNumber,
    [
      "DarkFactory blocked this issue before worker dispatch.",
      "",
      "Blocker:",
      "",
      "```text",
      mergePolicy.reason,
      "```",
      "",
      `Target branch: \`${baseBranch}\``,
      `Repository auto-merge enabled: \`${mergePolicy.autoMergeSupported ? "yes" : "no"}\``,
      "",
      "This is target repository setup work, not a code implementation failure."
    ].join("\n")
  );
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

async function createIssueComment(repository, issueNumber, body) {
  await gh.request("POST", `/repos/${repoName(repository)}/issues/${issueNumber}/comments`, { body });
}

async function writeLedger(ledger) {
  try {
    const written = await writeRunLedger(gh, DATA_REPO, "df-orchestrate", repoName(CONTROL_REPO), ledger);
    console.log(`DarkFactory ledger written to ${written.repository}/${written.path}`);
  } catch (error) {
    console.warn(`DarkFactory ledger warning: ${error.message || String(error)}`);
  }
}
