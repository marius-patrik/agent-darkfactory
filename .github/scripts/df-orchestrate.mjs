import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_DATA_REPO,
  PLANNING_LABELS,
  WORK_LABELS,
  assertAllowedRepo,
  createGithubClient,
  ensureLabels,
  extractBlockedByIssueNumbers,
  findPrdMarker,
  getOptionalFileContent,
  getRepository,
  labelNames,
  listActiveManagedRepos,
  listIssues,
  parseRepo,
  priorityLabels,
  priorityRank,
  repoName,
  requiredEnv,
  slug,
  streamLabel,
  warnReadOnlyRepository,
  writeRunLedger
} from "./df-lib.mjs";

const CONTROL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TOKEN = requiredEnv("DARK_FACTORY_TOKEN");
const CONTROL_REPO = parseRepo(requiredEnv("DF_CONTROL_REPO"));
const DATA_REPO = process.env.DF_DATA_REPO ?? DEFAULT_DATA_REPO;
const TRIGGER = process.env.DF_TRIGGER ?? "unknown";
const MAX_GLOBAL_WORKERS = positiveIntegerEnv("DF_MAX_GLOBAL_WORKERS", 4);
const MAX_REPO_WORKERS = positiveIntegerEnv("DF_MAX_REPO_WORKERS", 1);
const MAX_STREAM_WORKERS = positiveIntegerEnv("DF_MAX_STREAM_WORKERS", 1);
const DASHBOARD_MARKER = "<!-- dark-factory:l0-dashboard -->";
const gh = createGithubClient(TOKEN, "darkfactory-orchestrate");

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  assertAllowedRepo(CONTROL_REPO);
  await ensureLabels(gh, CONTROL_REPO, [...PLANNING_LABELS, ...WORK_LABELS]);

  const targets = await targetRepositories();
  const states = [];
  const dispatched = [];
  const decisions = [];
  const ownerQuestions = [];

  for (const target of targets) {
    try {
      const state = await reconstructRepositoryState(target);
      states.push(state);
      decisions.push(...await reconcileSequencing(state));
      ownerQuestions.push(...await escalateOwnerQuestions(state));
    } catch (error) {
      if (warnReadOnlyRepository(target, error, "orchestration")) continue;
      console.warn(`Failed to orchestrate ${repoName(target)}: ${error.message || String(error)}`);
      decisions.push({ repo: repoName(target), action: "state-error", error: error.message || String(error) });
    }
  }

  const dispatchPlan = planDispatches(states);
  decisions.push(...dispatchPlan.decisions);

  for (const decision of dispatchPlan.dispatches) {
    try {
      await dispatchWorker(decision.repository, decision.issue);
      dispatched.push({
        repo: repoName(decision.repository),
        issue: decision.issue,
        priority: decision.priority,
        stream: decision.stream
      });
      decisions.push({ ...withoutRepository(decision), repo: repoName(decision.repository), action: "dispatch" });
    } catch (error) {
      if (warnReadOnlyRepository(decision.repository, error, "worker dispatch")) continue;
      console.warn(`Failed to dispatch worker for ${repoName(decision.repository)}#${decision.issue}: ${error.message || String(error)}`);
      decisions.push({
        repo: repoName(decision.repository),
        issue: `#${decision.issue}`,
        action: "dispatch-error",
        error: error.message || String(error)
      });
    }
  }

  const dashboard = await updateDashboard({ states, dispatched, decisions, ownerQuestions });

  const ledger = {
    trigger: TRIGGER,
    control_repo: repoName(CONTROL_REPO),
    caps: {
      global_workers: MAX_GLOBAL_WORKERS,
      repo_workers: MAX_REPO_WORKERS,
      stream_workers: MAX_STREAM_WORKERS
    },
    global_state_brief: states.map(summarizeRepositoryState),
    decisions,
    dispatched,
    owner_questions: ownerQuestions,
    dashboard,
    token_usage: {
      codex_calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      note: "L0 orchestrator state reconstruction, sequencing, dispatch, dashboard, and owner escalation used deterministic rules only"
    }
  };

  await writeLedger(ledger);
  console.log(`DarkFactory L0 orchestrator dispatched ${dispatched.length} worker runs across ${states.length} repositories.`);
}

async function targetRepositories() {
  return await listActiveManagedRepos(gh, CONTROL_REPO, { root: CONTROL_ROOT });
}

async function reconstructRepositoryState(repository) {
  assertAllowedRepo(repository);
  await ensureLabels(gh, repository, [...PLANNING_LABELS, ...WORK_LABELS]);

  const repo = await getRepository(gh, repository);
  if (repo.archived === true || repo.disabled === true) {
    throw new Error(`GitHub reports archived=${repo.archived === true} disabled=${repo.disabled === true}.`);
  }

  const [issues, pulls, prd, workflowRuns] = await Promise.all([
    listIssues(gh, repository, "all"),
    listOpenPullRequests(repository),
    getOptionalFileContent(gh, repository, "PRD.md", repo.default_branch),
    listRecentWorkflowRuns(repository)
  ]);
  const issueByNumber = new Map(issues.map((issue) => [issue.number, issue]));
  const normalizedIssues = issues.map((issue) => normalizeIssue(issue, issueByNumber));

  return {
    repository,
    defaultBranch: repo.default_branch,
    prdPresent: typeof prd === "string" && prd.trim().length > 0,
    issues: normalizedIssues,
    openIssues: normalizedIssues.filter((issue) => issue.state === "open"),
    openPulls: pulls,
    workflowRuns
  };
}

function normalizeIssue(issue, issueByNumber) {
  const labels = labelNames(issue.labels);
  const labelSet = new Set(labels);
  const blockedBy = extractBlockedByIssueNumbers(issue.body || "");
  const missingBlockers = blockedBy.filter((number) => !issueByNumber.has(number));
  const unresolvedBlockers = blockedBy.filter((number) => {
    const blocker = issueByNumber.get(number);
    if (!blocker) return true;
    const blockerLabels = new Set(labelNames(blocker.labels));
    return blocker.state === "open" && !blockerLabels.has("df:done");
  });

  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    labels,
    labelSet,
    marker: findPrdMarker(issue.body || ""),
    htmlUrl: issue.html_url,
    blockedBy,
    missingBlockers,
    unresolvedBlockers,
    priorityLabels: priorityLabels(labels),
    priorityRank: priorityRank(labels),
    stream: streamLabel(labels)
  };
}

async function reconcileSequencing(state) {
  const decisions = [];

  for (const issue of state.openIssues) {
    if (!issue.marker) continue;
    if (issue.labelSet.has("df:ask-owner")) continue;
    if (issue.labelSet.has("df:running") || issue.labelSet.has("df:blocked") || issue.labelSet.has("df:done")) continue;

    if (issue.unresolvedBlockers.length > 0) {
      if (issue.labelSet.has("df:ready")) {
        await replaceIssueLabels(state.repository, issue.number, [], ["df:ready"]);
        issue.labelSet.delete("df:ready");
        issue.labels = issue.labels.filter((label) => label !== "df:ready");
        decisions.push({
          repo: repoName(state.repository),
          issue: `#${issue.number}`,
          action: "hold-sequenced-issue",
          blocked_by: issue.unresolvedBlockers.map((number) => `#${number}`)
        });
      }
      continue;
    }

    if (!issue.labelSet.has("df:ready")) {
      await replaceIssueLabels(state.repository, issue.number, ["df:ready"], []);
      issue.labelSet.add("df:ready");
      issue.labels.push("df:ready");
      decisions.push({
        repo: repoName(state.repository),
        issue: `#${issue.number}`,
        action: "ready-sequenced-issue",
        reason: "all Blocked-by references are resolved"
      });
    }
  }

  return decisions;
}

async function escalateOwnerQuestions(state) {
  const questions = [];

  if (!state.prdPresent) {
    questions.push(await upsertOwnerQuestion(
      state.repository,
      `missing-prd-${repoName(state.repository)}`,
      `DarkFactory owner question - missing PRD for ${repoName(state.repository)}`,
      [
        `Repository \`${repoName(state.repository)}\` has no root \`PRD.md\` on \`${state.defaultBranch}\`.`,
        "",
        "DarkFactory needs the PRD source of truth before L0/L4 can safely sequence backlog work.",
        "",
        "Requested owner decision: add a root `PRD.md`, mark the repository non-active in `.darkfactory/managed-repos.json`, or explain the intended source of truth."
      ].join("\n")
    ));
  }

  for (const issue of state.openIssues) {
    if (issue.labelSet.has("df:ask-owner")) continue;

    if (issue.labelSet.has("df:ready") && !issue.marker) {
      questions.push(await upsertOwnerQuestion(
        state.repository,
        `ready-without-prd-${repoName(state.repository)}-${issue.number}`,
        `DarkFactory owner question - ready issue #${issue.number} lacks a PRD marker`,
        [
          `Issue ${issue.htmlUrl || `#${issue.number}`} is labeled \`df:ready\` but has no \`df-prd:\` marker.`,
          "",
          "DarkFactory only dispatches PRD-tracked ready work automatically.",
          "",
          "Requested owner decision: link the issue to PRD-managed work, remove `df:ready`, or confirm it should be manually handled outside DarkFactory."
        ].join("\n")
      ));
    }

    if (issue.priorityLabels.length > 1) {
      questions.push(await upsertOwnerQuestion(
        state.repository,
        `conflicting-priority-${repoName(state.repository)}-${issue.number}`,
        `DarkFactory owner question - conflicting priorities on issue #${issue.number}`,
        [
          `Issue ${issue.htmlUrl || `#${issue.number}`} has multiple priority labels: ${issue.priorityLabels.map((label) => `\`${label}\``).join(", ")}.`,
          "",
          "L0 can rank a single P0/P1/P2 priority deterministically, but multiple priority labels need an owner decision.",
          "",
          "Requested owner decision: leave exactly one priority label on the issue."
        ].join("\n")
      ));
    }

    if (issue.missingBlockers.length > 0) {
      questions.push(await upsertOwnerQuestion(
        state.repository,
        `missing-blocker-${repoName(state.repository)}-${issue.number}`,
        `DarkFactory owner question - missing Blocked-by reference on issue #${issue.number}`,
        [
          `Issue ${issue.htmlUrl || `#${issue.number}`} references missing blockers: ${issue.missingBlockers.map((number) => `#${number}`).join(", ")}.`,
          "",
          "L0 cannot prove whether missing blockers are resolved from GitHub issue history.",
          "",
          "Requested owner decision: fix the `Blocked-by:` references or remove the stale dependency lines."
        ].join("\n")
      ));
    }
  }

  return questions.filter(Boolean);
}

function planDispatches(states) {
  const decisions = [];
  const dispatches = [];
  const runningByRepo = new Map();
  const runningByStream = new Map();
  let runningGlobal = 0;

  for (const state of states) {
    for (const issue of state.openIssues) {
      if (!issue.labelSet.has("df:running")) continue;
      runningGlobal += 1;
      increment(runningByRepo, repoName(state.repository));
      increment(runningByStream, issue.stream);
    }
  }

  const candidates = states.flatMap((state) => state.openIssues
    .filter((issue) => shouldDispatch(issue))
    .map((issue) => ({
      repository: state.repository,
      issue: issue.number,
      priority: issue.priorityLabels[0] || "P?",
      priorityRank: issue.priorityRank,
      stream: issue.stream,
      blockedBy: issue.unresolvedBlockers
    })))
    .sort((a, b) => (
      a.priorityRank - b.priorityRank ||
      repoName(a.repository).localeCompare(repoName(b.repository)) ||
      a.issue - b.issue
    ));

  for (const candidate of candidates) {
    const repoKey = repoName(candidate.repository);
    const repoRunning = runningByRepo.get(repoKey) || 0;
    const streamRunning = runningByStream.get(candidate.stream) || 0;

    if (runningGlobal >= MAX_GLOBAL_WORKERS) {
      decisions.push(skipDispatch(candidate, "global-concurrency-cap"));
      continue;
    }
    if (repoRunning >= MAX_REPO_WORKERS) {
      decisions.push(skipDispatch(candidate, "repo-concurrency-cap"));
      continue;
    }
    if (streamRunning >= MAX_STREAM_WORKERS) {
      decisions.push(skipDispatch(candidate, "stream-concurrency-cap"));
      continue;
    }

    dispatches.push(candidate);
    runningGlobal += 1;
    increment(runningByRepo, repoKey);
    increment(runningByStream, candidate.stream);
  }

  return { dispatches, decisions };
}

function shouldDispatch(issue) {
  if (!issue.labelSet.has("df:ready")) return false;
  if (!issue.marker) return false;
  if (issue.labelSet.has("df:running") || issue.labelSet.has("df:blocked") || issue.labelSet.has("df:done")) return false;
  if (issue.unresolvedBlockers.length > 0) return false;
  if (issue.priorityLabels.length > 1) return false;
  return true;
}

function skipDispatch(candidate, reason) {
  return {
    repo: repoName(candidate.repository),
    issue: `#${candidate.issue}`,
    action: "skip-dispatch",
    reason,
    priority: candidate.priority,
    stream: candidate.stream
  };
}

async function dispatchWorker(repository, issueNumber) {
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

async function upsertOwnerQuestion(repository, key, title, details) {
  const marker = `<!-- dark-factory:ask-owner ${slug(key)} -->`;
  const issues = await listIssues(gh, repository, "all");
  const existing = issues.find((issue) => (issue.body || "").includes(marker));
  const body = [
    marker,
    "## Owner Question",
    "",
    details,
    "",
    "## L0 Context",
    "",
    "- DarkFactory escalated this instead of blocking a worker lane.",
    "- Resolve by commenting with the decision and closing this issue, or by editing labels/issues/PRD so the question no longer applies.",
    "- AI tokens: 0 (deterministic L0 escalation)."
  ].join("\n");

  if (existing) {
    const updated = await gh.request("PATCH", `/repos/${repoName(repository)}/issues/${existing.number}`, {
      title,
      body,
      state: "open"
    });
    await replaceIssueLabels(repository, existing.number, ["P1", "df:ask-owner"], []);
    return { repo: repoName(repository), issue: `#${updated.number}`, action: "update-owner-question", title };
  }

  const created = await gh.request("POST", `/repos/${repoName(repository)}/issues`, {
    title,
    body,
    labels: ["P1", "df:ask-owner"]
  });
  return { repo: repoName(repository), issue: `#${created.number}`, action: "create-owner-question", title };
}

async function updateDashboard({ states, dispatched, decisions, ownerQuestions }) {
  const body = formatDashboard({ states, dispatched, decisions, ownerQuestions });
  const issues = await listIssues(gh, CONTROL_REPO, "all");
  const existing = issues.find((issue) => (issue.body || "").includes(DASHBOARD_MARKER));
  const title = "DarkFactory L0 dashboard";

  if (existing) {
    const updated = await gh.request("PATCH", `/repos/${repoName(CONTROL_REPO)}/issues/${existing.number}`, {
      title,
      body,
      state: "open"
    });
    return { issue: `#${updated.number}`, url: updated.html_url, action: "update-dashboard" };
  }

  const created = await gh.request("POST", `/repos/${repoName(CONTROL_REPO)}/issues`, {
    title,
    body,
    labels: ["roadmap"]
  });
  return { issue: `#${created.number}`, url: created.html_url, action: "create-dashboard" };
}

function formatDashboard({ states, dispatched, decisions, ownerQuestions }) {
  const now = new Date().toISOString();
  const queued = decisions.filter((decision) => decision.action === "skip-dispatch").length;
  const sequencing = decisions.filter((decision) => decision.action === "ready-sequenced-issue" || decision.action === "hold-sequenced-issue");
  const blockers = states.flatMap((state) => state.openIssues
    .filter((issue) => issue.labelSet.has("df:blocked") || issue.unresolvedBlockers.length > 0)
    .map((issue) => `${repoName(state.repository)}#${issue.number}`));

  return [
    DASHBOARD_MARKER,
    "## DarkFactory L0 Dashboard",
    "",
    `Updated: ${now}`,
    `Trigger: \`${TRIGGER}\``,
    "",
    "## Dispatch",
    "",
    `- Dispatched workers: ${dispatched.length}`,
    `- Queued by concurrency caps: ${queued}`,
    `- Sequencing updates: ${sequencing.length}`,
    `- Open blocker lanes: ${blockers.length}`,
    `- Open owner questions touched: ${ownerQuestions.length}`,
    "",
    "## Repository State",
    "",
    "| Repository | PRD | Ready | Running | Blocked | Done | Open PRs | Latest CI |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ...states.map((state) => {
      const counts = countLabels(state.openIssues);
      const latestRun = state.workflowRuns[0];
      const ci = latestRun ? `${latestRun.name}:${latestRun.status}/${latestRun.conclusion || "none"}` : "unavailable";
      return `| ${repoName(state.repository)} | ${state.prdPresent ? "yes" : "missing"} | ${counts.ready} | ${counts.running} | ${counts.blocked} | ${counts.done} | ${state.openPulls.length} | ${ci} |`;
    }),
    "",
    "## Recent Dispatches",
    "",
    dispatched.length
      ? dispatched.map((item) => `- ${item.repo}#${item.issue} (${item.priority}, ${item.stream})`).join("\n")
      : "- None.",
    "",
    "## Owner Questions",
    "",
    ownerQuestions.length
      ? ownerQuestions.map((item) => `- ${item.repo}${item.issue}: ${item.title}`).join("\n")
      : "- None touched this run.",
    "",
    "## Harness Migration Path",
    "",
    "- This L0 tick reconstructs state exclusively from GitHub repositories, issue history, workflow state, PRD files, and `.darkfactory/` registry data.",
    "- The deterministic scheduler can move behind the agents-harness scheduler without changing GitHub as the durable control plane.",
    "- AI tokens are reserved for future explicit judgment runs; this dashboard update used zero model calls."
  ].join("\n");
}

function summarizeRepositoryState(state) {
  const counts = countLabels(state.openIssues);
  return {
    repo: repoName(state.repository),
    default_branch: state.defaultBranch,
    prd_present: state.prdPresent,
    open_issues: state.openIssues.length,
    open_pull_requests: state.openPulls.length,
    labels: counts,
    unresolved_blockers: state.openIssues
      .filter((issue) => issue.unresolvedBlockers.length)
      .map((issue) => ({ issue: `#${issue.number}`, blocked_by: issue.unresolvedBlockers.map((number) => `#${number}`) })),
    latest_workflow_run: state.workflowRuns[0] || null
  };
}

function countLabels(issues) {
  const counts = { ready: 0, running: 0, blocked: 0, done: 0, ask_owner: 0 };
  for (const issue of issues) {
    if (issue.labelSet.has("df:ready")) counts.ready += 1;
    if (issue.labelSet.has("df:running")) counts.running += 1;
    if (issue.labelSet.has("df:blocked")) counts.blocked += 1;
    if (issue.labelSet.has("df:done")) counts.done += 1;
    if (issue.labelSet.has("df:ask-owner")) counts.ask_owner += 1;
  }
  return counts;
}

async function listOpenPullRequests(repository) {
  const pulls = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await gh.request(
      "GET",
      `/repos/${repoName(repository)}/pulls?state=open&per_page=100&page=${page}`
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    pulls.push(...batch.map((pull) => ({
      number: pull.number,
      title: pull.title,
      state: pull.state,
      draft: pull.draft === true,
      html_url: pull.html_url
    })));
    if (batch.length < 100) break;
  }
  return pulls;
}

async function listRecentWorkflowRuns(repository) {
  try {
    const data = await gh.request(
      "GET",
      `/repos/${repoName(repository)}/actions/runs?per_page=10`
    );
    return (Array.isArray(data.workflow_runs) ? data.workflow_runs : []).map((run) => ({
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      branch: run.head_branch,
      event: run.event,
      created_at: run.created_at,
      html_url: run.html_url
    }));
  } catch (error) {
    if (error.status === 403 || error.status === 404) return [];
    throw error;
  }
}

async function writeLedger(ledger) {
  try {
    const written = await writeRunLedger(gh, DATA_REPO, "df-orchestrate", repoName(CONTROL_REPO), ledger);
    console.log(`DarkFactory ledger written to ${written.repository}/${written.path}`);
  } catch (error) {
    console.warn(`DarkFactory ledger warning: ${error.message || String(error)}`);
  }
}

function positiveIntegerEnv(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function increment(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function withoutRepository(decision) {
  const { repository, ...rest } = decision;
  return rest;
}
