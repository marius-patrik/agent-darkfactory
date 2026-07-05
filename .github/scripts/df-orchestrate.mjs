import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_DATA_REPO,
  PLANNING_LABELS,
  WORK_LABELS,
  assertAllowedRepo,
  createGithubClient,
  ensureLabels,
  findPrdMarker,
  getOptionalFileContent,
  getRepository,
  listIssues,
  listActiveManagedRepos,
  parseRepo,
  preflightMergePolicy,
  repoName,
  requiredEnv,
  warnReadOnlyRepository,
  writeRunLedger
} from "./df-lib.mjs";

const CONTROL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DASHBOARD_MARKER = "<!-- dark-factory:l0-dashboard -->";
const DEFAULT_GLOBAL_CONCURRENCY = 4;
const DEFAULT_REPO_CONCURRENCY = 1;
const DEFAULT_STREAM_CONCURRENCY = 1;
const OWNER_DECISION_PATTERN = /\b(owner|human|manual|approval|approve|decision|choose|secret|credential|permission|billing|access|enable repository auto-merge|auto-merge disabled|policy decision)\b/i;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}

async function main() {
  const token = requiredEnv("DARK_FACTORY_TOKEN");
  const controlRepo = parseRepo(requiredEnv("DF_CONTROL_REPO"));
  const dataRepo = process.env.DF_DATA_REPO ?? DEFAULT_DATA_REPO;
  const trigger = process.env.DF_TRIGGER ?? "unknown";
  const gh = createGithubClient(token, "darkfactory-orchestrate");

  await orchestrate({ gh, controlRepo, dataRepo, trigger, root: CONTROL_ROOT });
}

export async function orchestrate(options) {
  const {
    gh,
    controlRepo,
    dataRepo = DEFAULT_DATA_REPO,
    trigger = "unknown",
    root = CONTROL_ROOT,
    registry,
    repositories,
    writeLedger: shouldWriteLedger = true,
    updateDashboard: shouldUpdateDashboard = true,
    concurrency = readConcurrencyFromEnv(),
    warn = console.warn,
    log = console.log
  } = options;

  assertAllowedRepo(controlRepo);
  const targets = await targetRepositories(gh, controlRepo, { root, registry, repositories, warn });
  const globalState = await synthesizeGlobalState(gh, controlRepo, targets, { warn });
  const dispatched = [];
  const actions = [];
  const caps = normalizeConcurrency(concurrency);
  const running = countRunningWork(globalState.repositories);

  for (const repositoryState of globalState.repositories) {
    try {
      const readyActions = await reconcileRepositoryReadiness(gh, repositoryState);
      actions.push(...readyActions);
      const escalationActions = await escalateOwnerOnlyBlockers(gh, repositoryState, { warn });
      actions.push(...escalationActions);
    } catch (error) {
      if (warnReadOnlyRepository(repositoryState.repository, error, "orchestrator state reconciliation")) continue;
      warn(`Failed to reconcile ${repoName(repositoryState.repository)}: ${error.message || String(error)}`);
      actions.push({ repo: repoName(repositoryState.repository), action: "error", reason: "reconcile-failed", error: error.message || String(error) });
    }
  }

  const candidates = selectDispatchCandidates(globalState.repositories);
  for (const candidate of candidates) {
    const target = candidate.repository;
    const issue = candidate.issue;
    const lane = candidate.lane;

    if (running.global >= caps.global) {
      actions.push({ repo: repoName(target), issue: issue.number, action: "skip-dispatch", reason: "global-concurrency-cap", cap: caps.global });
      continue;
    }
    if ((running.byRepo.get(repoName(target)) ?? 0) >= caps.perRepo) {
      actions.push({ repo: repoName(target), issue: issue.number, action: "skip-dispatch", reason: "repo-concurrency-cap", cap: caps.perRepo });
      continue;
    }
    if ((running.byLane.get(lane) ?? 0) >= caps.perStream) {
      actions.push({ repo: repoName(target), issue: issue.number, action: "skip-dispatch", reason: "stream-concurrency-cap", lane, cap: caps.perStream });
      continue;
    }

    try {
      const wasDispatched = await dispatchWorker(gh, controlRepo, target, issue.number);
      if (wasDispatched) {
        const dispatch = { repo: repoName(target), issue: issue.number, lane };
        dispatched.push(dispatch);
        actions.push({ action: "dispatch-worker", ...dispatch });
        running.global += 1;
        incrementCount(running.byRepo, repoName(target));
        incrementCount(running.byLane, lane);
      } else {
        actions.push({ repo: repoName(target), issue: issue.number, action: "skip-dispatch", reason: "preflight-blocked" });
      }
    } catch (error) {
      if (warnReadOnlyRepository(target, error, "worker dispatch")) continue;
      warn(`Failed to dispatch worker for ${repoName(target)}#${issue.number}: ${error.message || String(error)}`);
      actions.push({ repo: repoName(target), issue: issue.number, action: "error", reason: "dispatch-failed", error: error.message || String(error) });
    }
  }

  const ledger = {
    trigger,
    control_repo: repoName(controlRepo),
    concurrency: caps,
    state: summarizeGlobalState(globalState),
    actions,
    dispatched,
    token_usage: {
      codex_calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      note: "L0 orchestrator state synthesis, sequencing, dispatch, dashboard, and escalation are deterministic and use no model calls"
    }
  };

  if (shouldUpdateDashboard) {
    try {
      const dashboard = await upsertDashboardIssue(gh, controlRepo, globalState, ledger);
      ledger.dashboard = dashboard;
      log(`DarkFactory dashboard updated at ${dashboard.url}`);
    } catch (error) {
      const message = error.message || String(error);
      ledger.dashboard = { status: "failed", error: message };
      warn(`DarkFactory dashboard warning: ${message}`);
    }
  }

  if (shouldWriteLedger) {
    await writeLedger(gh, dataRepo, controlRepo, ledger, warn, log);
  }
  log(`DarkFactory orchestrator dispatched ${dispatched.length} worker runs.`);
  return { dispatched, ledger };
}

export async function targetRepositories(gh, controlRepo, options = {}) {
  return await listActiveManagedRepos(gh, controlRepo, options);
}

export async function listReadyIssues(gh, repository) {
  const issues = [];
  for (let page = 1; page <= 20; page += 1) {
    const labels = encodeURIComponent("df:ready");
    const batch = await gh.request(
      "GET",
      `/repos/${repoName(repository)}/issues?state=open&labels=${labels}&per_page=100&page=${page}`
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    issues.push(...batch.filter((issue) => !issue.pull_request));
    if (batch.length < 100) break;
  }

  return issues.filter((issue) => {
    const names = new Set(
      (issue.labels || []).map((label) => (typeof label === "string" ? label : label?.name)).filter(Boolean)
    );
    if (!names.has("df:ready")) return false;
    if (names.has("df:running") || names.has("df:blocked") || names.has("df:done")) return false;
    return true;
  });
}

export async function synthesizeGlobalState(gh, controlRepo, repositories, options = {}) {
  const warn = options.warn ?? console.warn;
  const states = [];

  for (const repository of repositories) {
    try {
      assertAllowedRepo(repository);
      states.push(await synthesizeRepositoryState(gh, repository));
    } catch (error) {
      if (warnReadOnlyRepository(repository, error, "state synthesis", warn)) continue;
      warn(`DarkFactory could not synthesize state for ${repoName(repository)}: ${error.message || String(error)}`);
      states.push({
        repository,
        error: error.message || String(error),
        repo: null,
        prd: { present: false, source: "PRD.md" },
        issues: [],
        pulls: []
      });
    }
  }

  return {
    control_repo: repoName(controlRepo),
    generated_at: new Date().toISOString(),
    repositories: states
  };
}

async function synthesizeRepositoryState(gh, repository) {
  const repo = await getRepository(gh, repository);
  const [issues, pulls, prd, ci] = await Promise.all([
    listIssues(gh, repository, "open"),
    listOpenPullRequests(gh, repository),
    readPrdState(gh, repository, repo.default_branch),
    readCiState(gh, repository)
  ]);

  return {
    repository,
    repo: {
      default_branch: repo.default_branch,
      archived: repo.archived === true,
      disabled: repo.disabled === true,
      allow_auto_merge: repo.allow_auto_merge === true
    },
    prd,
    ci,
    issues: issues.map(normalizeIssue),
    pulls: pulls.map(normalizePull)
  };
}

async function readPrdState(gh, repository, ref) {
  const content = await getOptionalFileContent(gh, repository, "PRD.md", ref);
  return {
    present: typeof content === "string" && content.trim().length > 0,
    source: "PRD.md",
    tracked_items: typeof content === "string" ? (content.match(/^\s*-\s*(?:\[[ xX]\]\s*)?\*\*/gm) || []).length : 0
  };
}

async function listOpenPullRequests(gh, repository) {
  const pulls = [];
  for (let page = 1; page <= 20; page += 1) {
    const batch = await gh.request(
      "GET",
      `/repos/${repoName(repository)}/pulls?state=open&per_page=100&page=${page}`
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    pulls.push(...batch);
    if (batch.length < 100) break;
  }
  return pulls;
}

async function readCiState(gh, repository) {
  try {
    const data = await gh.request("GET", `/repos/${repoName(repository)}/actions/runs?per_page=20`);
    const runs = Array.isArray(data.workflow_runs) ? data.workflow_runs : [];
    const latest = runs[0];
    return {
      available: true,
      latest: latest
        ? {
            name: latest.name || "",
            status: latest.status || "",
            conclusion: latest.conclusion || null,
            created_at: latest.created_at || "",
            html_url: latest.html_url || ""
          }
        : null,
      red: runs.filter((run) => run.status === "completed" && !["success", "skipped", "neutral"].includes(run.conclusion)).length,
      in_progress: runs.filter((run) => run.status !== "completed").length
    };
  } catch (error) {
    if (error.status === 403 || error.status === 404) {
      return {
        available: false,
        reason: error.message || String(error),
        latest: null,
        red: 0,
        in_progress: 0
      };
    }
    throw error;
  }
}

export async function reconcileRepositoryReadiness(gh, repositoryState) {
  const repository = repositoryState.repository;
  const openIssueNumbers = new Set(repositoryState.issues.map((issue) => issue.number));
  const actions = [];

  await ensureLabels(gh, repository, WORK_LABELS);

  for (const issue of repositoryState.issues) {
    if (!isManagedBacklogIssue(issue)) continue;
    if (issue.labels.has("df:ask-owner") || issue.labels.has("df:running") || issue.labels.has("df:blocked") || issue.labels.has("df:done")) {
      continue;
    }

    const openBlockers = issue.blockedBy.filter((number) => openIssueNumbers.has(number));
    if (openBlockers.length === 0 && !issue.labels.has("df:ready")) {
      await replaceIssueLabels(gh, repository, issue.number, ["df:ready"], []);
      issue.labels.add("df:ready");
      actions.push({ repo: repoName(repository), issue: issue.number, action: "ready-issue", reason: "blockers-clear" });
    }
    if (openBlockers.length > 0 && issue.labels.has("df:ready")) {
      await replaceIssueLabels(gh, repository, issue.number, [], ["df:ready"]);
      issue.labels.delete("df:ready");
      actions.push({ repo: repoName(repository), issue: issue.number, action: "unready-issue", reason: "open-blockers", blockers: openBlockers });
    }
  }

  return actions;
}

export async function escalateOwnerOnlyBlockers(gh, repositoryState, options = {}) {
  const warn = options.warn ?? console.warn;
  const repository = repositoryState.repository;
  const actions = [];

  await ensureLabels(gh, repository, WORK_LABELS);

  for (const issue of repositoryState.issues) {
    if (!issue.labels.has("df:blocked") || issue.labels.has("df:ask-owner")) continue;

    let comments = [];
    try {
      comments = await listIssueComments(gh, repository, issue.number);
    } catch (error) {
      warn(`DarkFactory could not inspect blocker comments for ${repoName(repository)}#${issue.number}: ${error.message || String(error)}`);
    }

    const text = [
      issue.title,
      issue.body,
      ...comments.map((comment) => comment.body || "")
    ].join("\n");
    if (!OWNER_DECISION_PATTERN.test(text)) continue;

    await replaceIssueLabels(gh, repository, issue.number, ["df:ask-owner"], ["df:ready", "df:running", "df:blocked", "df:done"]);
    issue.labels.add("df:ask-owner");
    issue.labels.delete("df:blocked");

    const marker = `<!-- dark-factory:l0-owner-escalation issue=${issue.number} -->`;
    if (!comments.some((comment) => String(comment.body || "").includes(marker))) {
      await createIssueComment(
        gh,
        repository,
        issue.number,
        [
          marker,
          "DarkFactory L0 escalated this blocker for owner input instead of leaving the lane blocked.",
          "",
          "Reason: the blocker appears to require an owner-only decision, permission, credential, or repository setting.",
          "",
          "Resolve the question in GitHub, then remove `df:ask-owner` and apply `df:ready` when work may continue."
        ].join("\n")
      );
    }

    actions.push({ repo: repoName(repository), issue: issue.number, action: "escalate-owner", reason: "owner-only-blocker" });
  }

  return actions;
}

export function selectDispatchCandidates(repositoryStates) {
  const candidates = [];

  for (const state of repositoryStates) {
    const openIssueNumbers = new Set(state.issues.map((issue) => issue.number));
    for (const issue of state.issues) {
      if (!isDispatchableIssue(issue, openIssueNumbers)) continue;
      candidates.push({
        repository: state.repository,
        issue,
        lane: laneKey(state.repository, issue),
        priority: priorityRank(issue)
      });
    }
  }

  return candidates.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    const repoCompare = repoName(a.repository).localeCompare(repoName(b.repository));
    if (repoCompare !== 0) return repoCompare;
    const laneCompare = a.lane.localeCompare(b.lane);
    if (laneCompare !== 0) return laneCompare;
    return a.issue.number - b.issue.number;
  });
}

function isDispatchableIssue(issue, openIssueNumbers) {
  if (!issue.labels.has("df:ready")) return false;
  if (issue.labels.has("df:running") || issue.labels.has("df:blocked") || issue.labels.has("df:done") || issue.labels.has("df:ask-owner")) {
    return false;
  }
  return issue.blockedBy.every((number) => !openIssueNumbers.has(number));
}

export async function dispatchWorker(gh, controlRepo, repository, issueNumber) {
  const repo = await getRepository(gh, repository);
  const workBaseBranch = await resolveWorkBaseBranch(gh, repository, repo.default_branch);
  const mergePolicy = await preflightMergePolicy(gh, repository, workBaseBranch, repo);
  if (mergePolicy.blocked) {
    await blockIssueBeforeDispatch(gh, repository, issueNumber, workBaseBranch, mergePolicy);
    return false;
  }

  // Claim the issue before dispatch so a subsequent orchestrator tick cannot
  // re-dispatch the same ready issue while the worker workflow is starting.
  await replaceIssueLabels(gh, repository, issueNumber, ["df:running"], ["df:ready"]);
  try {
    await gh.request("POST", `/repos/${repoName(controlRepo)}/actions/workflows/df-work.yml/dispatches`, {
      ref: "main",
      inputs: {
        repo: repoName(repository),
        issue_number: String(issueNumber)
      }
    });
  } catch (error) {
    // Restore df:ready so the next orchestrator tick can retry; do not leave
    // the issue stranded in df:running when dispatch failed.
    await replaceIssueLabels(gh, repository, issueNumber, ["df:ready"], ["df:running"]);
    throw error;
  }
  return true;
}

async function resolveWorkBaseBranch(gh, repository, defaultBranch) {
  try {
    await gh.request("GET", `/repos/${repoName(repository)}/git/ref/heads/${encodeURIComponent("dev")}`);
    return "dev";
  } catch (error) {
    if (error.status === 404) return defaultBranch;
    throw error;
  }
}

async function blockIssueBeforeDispatch(gh, repository, issueNumber, baseBranch, mergePolicy) {
  await ensureLabels(gh, repository, WORK_LABELS);
  await replaceIssueLabels(gh, repository, issueNumber, ["df:blocked"], ["df:ready", "df:running", "df:done"]);
  await createIssueComment(
    gh,
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

async function createIssueComment(gh, repository, issueNumber, body) {
  await gh.request("POST", `/repos/${repoName(repository)}/issues/${issueNumber}/comments`, { body });
}

async function listIssueComments(gh, repository, issueNumber) {
  const comments = [];
  for (let page = 1; page <= 5; page += 1) {
    const batch = await gh.request(
      "GET",
      `/repos/${repoName(repository)}/issues/${issueNumber}/comments?per_page=100&page=${page}`
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    comments.push(...batch);
    if (batch.length < 100) break;
  }
  return comments;
}

async function upsertDashboardIssue(gh, controlRepo, globalState, ledger) {
  await ensureLabels(gh, controlRepo, PLANNING_LABELS);
  const title = "DarkFactory L0 dashboard";
  const body = formatDashboardBody(globalState, ledger);
  const existing = (await listIssues(gh, controlRepo, "open")).find((issue) => String(issue.body || "").includes(DASHBOARD_MARKER));

  if (existing) {
    const updated = await gh.request("PATCH", `/repos/${repoName(controlRepo)}/issues/${existing.number}`, { title, body });
    return { status: "updated", issue: updated.number, url: updated.html_url };
  }

  const created = await gh.request("POST", `/repos/${repoName(controlRepo)}/issues`, {
    title,
    body,
    labels: ["roadmap"]
  });
  return { status: "created", issue: created.number, url: created.html_url };
}

export function formatDashboardBody(globalState, ledger) {
  const summary = summarizeGlobalState(globalState);
  const lines = [
    DASHBOARD_MARKER,
    "# DarkFactory L0 Dashboard",
    "",
    `Generated: ${globalState.generated_at}`,
    `Trigger: \`${ledger.trigger}\``,
    `Control repo: \`${globalState.control_repo}\``,
    "",
    "## Summary",
    "",
    `- Active repositories inspected: ${summary.repositories}`,
    `- Open backlog issues: ${summary.issues}`,
    `- Ready: ${summary.ready}`,
    `- Running: ${summary.running}`,
    `- Blocked: ${summary.blocked}`,
    `- Ask owner: ${summary.ask_owner}`,
    `- Open worker/control PRs: ${summary.open_prs}`,
    `- Dispatches this run: ${ledger.dispatched.length}`,
    "",
    "## Concurrency",
    "",
    `- Global worker cap: ${ledger.concurrency.global}`,
    `- Per-repository cap: ${ledger.concurrency.perRepo}`,
    `- Per-stream lane cap: ${ledger.concurrency.perStream}`,
    "",
    "## Repository State",
    "",
    "| Repository | PRD | CI | Ready | Running | Blocked | Ask owner | Open PRs |",
    "| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |"
  ];

  for (const state of globalState.repositories) {
    const counts = issueCounts(state.issues);
    lines.push(`| ${repoName(state.repository)} | ${state.prd.present ? "yes" : "no"} | ${formatCiState(state.ci)} | ${counts.ready} | ${counts.running} | ${counts.blocked} | ${counts.askOwner} | ${state.pulls.length} |`);
  }

  lines.push("", "## Dispatches", "");
  if (ledger.dispatched.length) {
    for (const dispatch of ledger.dispatched) {
      lines.push(`- ${dispatch.repo}#${dispatch.issue} (${dispatch.lane})`);
    }
  } else {
    lines.push("- None");
  }

  const askOwner = globalState.repositories.flatMap((state) =>
    state.issues
      .filter((issue) => issue.labels.has("df:ask-owner"))
      .map((issue) => `${repoName(state.repository)}#${issue.number} ${issue.title}`)
  );
  lines.push("", "## Owner Questions", "");
  if (askOwner.length) {
    lines.push(...askOwner.map((item) => `- ${item}`));
  } else {
    lines.push("- None");
  }

  lines.push(
    "",
    "## Harness Migration",
    "",
    "- This L0 tick is GitHub-native state reconstruction. The deterministic scheduler boundary is isolated for migration to the agents-harness scheduler.",
    "",
    "## Token Use",
    "",
    "- AI tokens: 0 for L0 deterministic orchestration."
  );

  return lines.join("\n");
}

function normalizeIssue(issue) {
  const labels = new Set((issue.labels || []).map((label) => typeof label === "string" ? label : label?.name).filter(Boolean));
  return {
    number: issue.number,
    title: issue.title || "",
    body: issue.body || "",
    labels,
    blockedBy: extractBlockedBy(issue.body || ""),
    priority: [...labels].find((label) => /^P[0-2]$/.test(label)) || "P2",
    stream: [...labels].find((label) => label.startsWith("stream:")) || "",
    prdMarker: findPrdMarker(issue.body || "")
  };
}

function normalizePull(pull) {
  return {
    number: pull.number,
    title: pull.title || "",
    state: pull.state || "open",
    head: pull.head?.ref || pull.headRefName || "",
    base: pull.base?.ref || pull.baseRefName || ""
  };
}

function extractBlockedBy(body) {
  const numbers = [];
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^Blocked-by:\s*#(\d+)\s*$/i);
    if (match) numbers.push(Number(match[1]));
  }
  return numbers;
}

function isManagedBacklogIssue(issue) {
  return Boolean(
    issue.prdMarker ||
    issue.labels.has("roadmap") ||
    issue.labels.has("df:class:mechanical") ||
    issue.labels.has("df:class:standard") ||
    issue.labels.has("df:class:hard")
  );
}

function priorityRank(issue) {
  if (issue.labels.has("P0")) return 0;
  if (issue.labels.has("P1")) return 1;
  return 2;
}

function laneKey(repository, issue) {
  return `${repoName(repository)}:${issue.stream || "default"}`;
}

function countRunningWork(repositoryStates) {
  const byRepo = new Map();
  const byLane = new Map();
  let global = 0;

  for (const state of repositoryStates) {
    for (const issue of state.issues) {
      if (!issue.labels.has("df:running")) continue;
      global += 1;
      incrementCount(byRepo, repoName(state.repository));
      incrementCount(byLane, laneKey(state.repository, issue));
    }
  }

  return { global, byRepo, byLane };
}

function incrementCount(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function summarizeGlobalState(globalState) {
  const totals = {
    repositories: globalState.repositories.length,
    issues: 0,
    ready: 0,
    running: 0,
    blocked: 0,
    ask_owner: 0,
    open_prs: 0,
    prd_missing: 0
  };

  for (const state of globalState.repositories) {
    const counts = issueCounts(state.issues);
    totals.issues += state.issues.length;
    totals.ready += counts.ready;
    totals.running += counts.running;
    totals.blocked += counts.blocked;
    totals.ask_owner += counts.askOwner;
    totals.open_prs += state.pulls.length;
    if (!state.prd.present) totals.prd_missing += 1;
  }

  return totals;
}

function issueCounts(issues) {
  const counts = { ready: 0, running: 0, blocked: 0, askOwner: 0 };
  for (const issue of issues) {
    if (issue.labels.has("df:ready")) counts.ready += 1;
    if (issue.labels.has("df:running")) counts.running += 1;
    if (issue.labels.has("df:blocked")) counts.blocked += 1;
    if (issue.labels.has("df:ask-owner")) counts.askOwner += 1;
  }
  return counts;
}

function formatCiState(ci) {
  if (!ci?.available) return "unavailable";
  if (!ci.latest) return "no runs";
  const conclusion = ci.latest.conclusion ? `/${ci.latest.conclusion}` : "";
  return `${ci.latest.status}${conclusion}`;
}

function readConcurrencyFromEnv() {
  return {
    global: process.env.DF_MAX_GLOBAL_WORKERS,
    perRepo: process.env.DF_MAX_REPO_WORKERS,
    perStream: process.env.DF_MAX_STREAM_WORKERS
  };
}

function normalizeConcurrency(concurrency) {
  return {
    global: positiveInteger(concurrency.global, DEFAULT_GLOBAL_CONCURRENCY),
    perRepo: positiveInteger(concurrency.perRepo, DEFAULT_REPO_CONCURRENCY),
    perStream: positiveInteger(concurrency.perStream, DEFAULT_STREAM_CONCURRENCY)
  };
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

async function writeLedger(gh, dataRepo, controlRepo, ledger, warn = console.warn, log = console.log) {
  try {
    const written = await writeRunLedger(gh, dataRepo, "df-orchestrate", repoName(controlRepo), ledger);
    log(`DarkFactory ledger written to ${written.repository}/${written.path}`);
  } catch (error) {
    warn(`DarkFactory ledger warning: ${error.message || String(error)}`);
  }
}
