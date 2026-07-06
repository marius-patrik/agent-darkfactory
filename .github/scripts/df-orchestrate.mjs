import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_DATA_REPO,
  WORK_LABELS,
  assertAllowedRepo,
  createGithubClient,
  darkFactoryWorkerIssueNumber,
  ensureLabels,
  findOpenWorkerPullRequestForIssue,
  getOptionalFileContent,
  getRepository,
  listActiveManagedRepos,
  listIssues,
  parseRepo,
  preflightMergePolicy,
  repoName,
  requiredEnv,
  warnReadOnlyRepository,
  writeRunLedger
} from "./df-lib.mjs";

const CONTROL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DASHBOARD_MARKER = "<!-- dark-factory:orchestrator-dashboard -->";
const ASK_OWNER_MARKER_PREFIX = "<!-- dark-factory:l0-ask-owner";
const DEFAULT_LIMITS = {
  global: 4,
  perRepo: 1,
  perStream: 1
};
const STREAM_LEDGER_FILES = [
  ".darkfactory/streams.json",
  ".darkfactory/stream-ledgers.json",
  ".darkfactory/stream-ledger.json",
  ".darkfactory/ledger.json"
];
const STREAM_LEDGER_DIRS = [
  ".darkfactory/streams",
  ".darkfactory/ledgers"
];

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}

async function main() {
  // The workflow supplies a GitHub App installation token here. The repository GITHUB_TOKEN
  // cannot perform cross-repo issue writes for managed repositories.
  const appInstallationToken = requiredEnv("DARK_FACTORY_TOKEN");
  const controlRepo = parseRepo(requiredEnv("DF_CONTROL_REPO"));
  const dataRepo = process.env.DF_DATA_REPO ?? DEFAULT_DATA_REPO;
  const trigger = process.env.DF_TRIGGER ?? "unknown";
  const gh = createGithubClient(appInstallationToken, "darkfactory-orchestrate");

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
    limits = readLimitsFromEnv(),
    warn = console.warn,
    log = console.log
  } = options;

  assertAllowedRepo(controlRepo);
  const targets = await targetRepositories(gh, controlRepo, { root, registry, repositories, warn });
  const dispatched = [];
  const actions = [];
  const escalations = [];
  const repoStates = [];
  const activeCounts = newActiveCounts();

  for (const target of targets) {
    try {
      assertAllowedRepo(target);
      const state = await reconstructRepositoryState(gh, target, warn);
      repoStates.push(state.brief);
      addExistingActiveCounts(activeCounts, state);

      const sequenceActions = await sequenceReadyIssues(gh, target, state);
      actions.push(...sequenceActions);
      applySequenceActionsToState(state, sequenceActions);

      const escalationActions = await escalateOwnerOnlyBlockers(gh, target, state, controlRepo);
      actions.push(...escalationActions);
      escalations.push(...escalationActions.filter((action) => action.action === "ask-owner"));

      const candidates = dispatchCandidates(state);
      for (const candidate of candidates) {
        if (!hasDispatchCapacity(activeCounts, target, candidate.streams, limits)) {
          actions.push({
            action: "defer-capacity",
            repo: repoName(target),
            issue: `#${candidate.issue.number}`,
            streams: candidate.streams,
            reason: "concurrency-cap"
          });
          continue;
        }

        try {
          const dispatchResult = await dispatchWorker(gh, controlRepo, target, candidate.issue.number);
          if (dispatchResult.dispatched) {
            const dispatch = {
              repo: repoName(target),
              issue: candidate.issue.number,
              streams: candidate.streams
            };
            dispatched.push(dispatch);
            actions.push({ action: "dispatch-worker", ...dispatch });
            incrementActiveCounts(activeCounts, target, candidate.streams);
          } else if (dispatchResult.action) {
            const action = { ...dispatchResult.action, streams: candidate.streams };
            actions.push(action);
            if (action.action === "ask-owner") escalations.push(action);
          } else {
            actions.push({
              action: "worker-already-open",
              repo: repoName(target),
              issue: `#${candidate.issue.number}`,
              streams: candidate.streams
            });
          }
        } catch (error) {
          if (warnReadOnlyRepository(target, error, "worker dispatch")) continue;
          warn(`Failed to dispatch worker for ${repoName(target)}#${candidate.issue.number}: ${error.message || String(error)}`);
          actions.push({
            action: "dispatch-error",
            repo: repoName(target),
            issue: `#${candidate.issue.number}`,
            error: error.message || String(error)
          });
        }
      }
    } catch (error) {
      if (warnReadOnlyRepository(target, error, "orchestration")) continue;
      warn(`Failed to orchestrate ${repoName(target)}: ${error.message || String(error)}`);
      actions.push({ action: "repo-error", repo: repoName(target), error: error.message || String(error) });
    }
  }

  const brief = synthesizeGlobalBrief(repoStates, actions, limits);
  if (shouldUpdateDashboard) {
    try {
      const dashboard = await upsertDashboardDigest(gh, controlRepo, brief);
      actions.push({ action: "dashboard", issue: dashboard.issue, result: dashboard.result });
    } catch (error) {
      warn(`DarkFactory dashboard warning: ${error.message || String(error)}`);
      actions.push({ action: "dashboard-error", error: error.message || String(error) });
    }
  }

  const ledger = {
    trigger,
    control_repo: repoName(controlRepo),
    limits,
    dispatched,
    escalations: escalations.map((action) => ({
      repo: action.repo,
      issue: action.issue,
      ask_owner_issue: action.ask_owner_issue,
      reason: action.reason
    })),
    actions,
    global_state_brief: brief,
    token_usage: {
      codex_calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      note: "L0 orchestrator tick is deterministic; AI escalation is represented by df:ask-owner issues"
    }
  };

  if (shouldWriteLedger) {
    await writeLedger(gh, dataRepo, controlRepo, ledger, warn, log);
  }
  log(`DarkFactory orchestrator dispatched ${dispatched.length} worker runs.`);
  return { dispatched, ledger, brief };
}

export async function targetRepositories(gh, controlRepo, options = {}) {
  return await listActiveManagedRepos(gh, controlRepo, options);
}

export async function reconstructRepositoryState(gh, repository, warn = console.warn) {
  const repo = await getRepository(gh, repository);
  const defaultBranch = repo.default_branch || "main";
  const [issues, branch, prd, workflowRuns, openWorkerPullsByIssue, streamLedgers] = await Promise.all([
    listIssues(gh, repository, "open"),
    getDefaultBranchState(gh, repository, defaultBranch),
    getPrdState(gh, repository, defaultBranch),
    getRecentWorkflowRuns(gh, repository, defaultBranch, warn),
    listOpenWorkerPullRequestsByIssue(gh, repository),
    readStreamLedgers(gh, repository, defaultBranch, warn)
  ]);
  const issueStates = issues.map((issue) => normalizeIssueState(issue));
  const issueByNumber = new Map(issueStates.map((issue) => [issue.number, issue]));
  const referencedBlockers = [...new Set(issueStates.flatMap((issue) => issue.blockedBy))]
    .filter((issueNumber) => !issueByNumber.has(issueNumber));

  for (const issueNumber of referencedBlockers) {
    const blocker = await getIssueState(gh, repository, issueNumber, warn);
    if (blocker) issueByNumber.set(issueNumber, blocker);
  }

  const openWorkerIssues = [];
  const runningIssues = issueStates.filter((issue) => issue.labels.has("df:running"));
  const blockedIssues = issueStates.filter((issue) => issue.labels.has("df:blocked"));
  const askOwnerIssues = issueStates.filter((issue) => issue.labels.has("df:ask-owner"));

  for (const issue of issueStates.filter(
    (issue) =>
      isManagedWorkIssue(issue) &&
      issue.fixRound < 3 &&
      (issue.labels.has("df:ready") || issue.labels.has("df:blocked"))
  )) {
    issue.blockedCommentCount += await countBlockedCommentsFromHistory(gh, repository, issue.number, warn);
  }

  for (const issue of issueStates) {
    if (!isManagedWorkIssue(issue)) continue;
    const pull = openWorkerPullsByIssue.get(issue.number);
    if (!pull) continue;
    issue.openWorkerPull = pull;
    openWorkerIssues.push({
      issue: issue.number,
      pull: pull.number || pull.url || "open",
      branch: pull.headRefName || ""
    });
  }

  const brief = {
    repo: repoName(repository),
    default_branch: defaultBranch,
    git: {
      branch: defaultBranch,
      sha: branch.sha,
      protected: branch.protected
    },
    ci: summarizeWorkflowRuns(workflowRuns),
    prd: prd.exists ? { exists: true, sha: prd.sha, characters: prd.characters } : { exists: false },
    stream_ledgers: streamLedgers,
    backlog: {
      total_open: issueStates.length,
      ready: issueStates.filter((issue) => issue.labels.has("df:ready")).length,
      running: runningIssues.length,
      blocked: blockedIssues.length,
      ask_owner: askOwnerIssues.length,
      managed: issueStates.filter((issue) => isManagedWorkIssue(issue)).length
    },
    streams: summarizeStreams(issueStates),
    open_blockers: blockedIssues.map((issue) => issueRef(issue)),
    open_worker_prs: openWorkerIssues
  };

  return {
    repository,
    repo,
    defaultBranch,
    issues: issueStates,
    issueByNumber,
    brief
  };
}

export async function listReadyIssues(gh, repository) {
  const state = await reconstructRepositoryState(gh, repository);
  return dispatchCandidates(state).map((candidate) => candidate.issue.raw);
}

export async function dispatchWorker(gh, controlRepo, repository, issueNumber) {
  const existingPullRequest = await findOpenWorkerPullRequestForIssue(gh, repository, issueNumber);
  if (existingPullRequest) {
    await replaceIssueLabels(gh, repository, issueNumber, ["df:running"], ["df:ready"]);
    return { dispatched: false, reason: "existing-worker-pr" };
  }

  const repo = await getRepository(gh, repository);
  const workBaseBranch = await resolveWorkBaseBranch(gh, repository, repo.default_branch);
  const mergePolicy = await preflightMergePolicy(gh, repository, workBaseBranch, repo);
  if (mergePolicy.blocked) {
    await blockIssueBeforeDispatch(gh, repository, issueNumber, workBaseBranch, mergePolicy);
    const ask = await ensureAskOwnerIssue(gh, repository, issueNumber, {
      reason: "merge-policy-blocked",
      title: "Enable auto-merge for protected DarkFactory worker dispatch",
      details: [
        mergePolicy.reason,
        `Target branch: \`${workBaseBranch}\``,
        `Repository auto-merge enabled: \`${mergePolicy.autoMergeSupported ? "yes" : "no"}\``
      ]
    });
    return {
      dispatched: false,
      action: {
        action: "ask-owner",
        repo: repoName(repository),
        issue: `#${issueNumber}`,
        ask_owner_issue: ask.issue,
        result: ask.result,
        reason: "merge-policy-blocked"
      }
    };
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
  return { dispatched: true };
}

export function extractBlockedBy(body) {
  const blockers = new Set();
  const matches = body?.matchAll(/^\s*Blocked[-\s]*by:\s*(.+)$/gim) ?? [];
  for (const match of matches) {
    const refs = match[1].matchAll(/#(\d+)\b/g);
    for (const ref of refs) blockers.add(Number(ref[1]));
  }
  return [...blockers].filter((number) => Number.isInteger(number) && number > 0).sort((a, b) => a - b);
}

export function dispatchCandidates(state) {
  return state.issues
    .filter((issue) => {
      if (!isManagedWorkIssue(issue)) return false;
      if (!issue.labels.has("df:ready")) return false;
      if (issue.labels.has("df:running") || issue.labels.has("df:blocked") || issue.labels.has("df:done")) return false;
      if (issue.labels.has("df:ask-owner")) return false;
      if (issue.openWorkerPull) return false;
      return blockersAreClosed(issue, state.issueByNumber);
    })
    .map((issue) => ({
      issue,
      streams: issue.streams.length ? issue.streams : ["default"]
    }))
    .sort(compareCandidates);
}

async function sequenceReadyIssues(gh, repository, state) {
  const actions = [];
  for (const issue of state.issues.filter((candidate) => isManagedWorkIssue(candidate))) {
    if (issue.labels.has("df:done") || issue.labels.has("df:running") || issue.labels.has("df:ask-owner")) continue;

    const blockersClosed = blockersAreClosed(issue, state.issueByNumber);
    if (blockersClosed && issue.labels.has("df:blocked") && isDependencyOnlyBlocked(issue)) {
      await replaceIssueLabels(gh, repository, issue.number, ["df:ready"], ["df:blocked", "df:done"]);
      actions.push({ action: "requeue-unblocked", repo: repoName(repository), issue: `#${issue.number}` });
      continue;
    }

    if (blockersClosed && !issue.labels.has("df:ready") && !issue.labels.has("df:blocked") && issue.blockedBy.length > 0) {
      await replaceIssueLabels(gh, repository, issue.number, ["df:ready"], ["df:done"]);
      actions.push({ action: "mark-ready", repo: repoName(repository), issue: `#${issue.number}` });
      continue;
    }

    if (!blockersClosed && issue.labels.has("df:ready")) {
      await replaceIssueLabels(gh, repository, issue.number, ["df:blocked"], ["df:ready"]);
      actions.push({
        action: "remove-ready-blocked-by",
        repo: repoName(repository),
        issue: `#${issue.number}`,
        blockers: openBlockers(issue, state.issueByNumber).map((blocker) => `#${blocker.number}`)
      });
    }
  }
  return actions;
}

async function escalateOwnerOnlyBlockers(gh, repository, state, controlRepo) {
  const actions = [];
  for (const issue of state.issues) {
    if (!isManagedWorkIssue(issue)) continue;
    if (issue.labels.has("df:ask-owner")) continue;

    const repeatedWorkerFailure = issue.fixRound >= 3 || issue.blockedCommentCount >= 3;
    if (!repeatedWorkerFailure) continue;

    await markSourceIssueAskOwner(gh, repository, issue);
    const ask = await ensureAskOwnerIssue(gh, repository, issue.number, {
      reason: "repeated-worker-failure",
      title: "Resolve repeated DarkFactory worker failure",
      details: [
        `DarkFactory found repeated worker failures for ${repoName(repository)}#${issue.number}.`,
        "Owner input is required before L0 should keep spending worker cycles on this lane.",
        `Control repository: \`${repoName(controlRepo)}\``
      ]
    });
    actions.push({
      action: "ask-owner",
      repo: repoName(repository),
      issue: `#${issue.number}`,
      ask_owner_issue: ask.issue,
      result: ask.result,
      reason: "repeated-worker-failure"
    });
  }
  return actions;
}

async function markSourceIssueAskOwner(gh, repository, issue) {
  await ensureLabels(gh, repository, WORK_LABELS);
  await replaceIssueLabels(gh, repository, issue.number, ["df:ask-owner", "df:blocked"], ["df:ready"]);
  issue.labels.add("df:ask-owner");
  issue.labels.add("df:blocked");
  issue.labels.delete("df:ready");
}

async function ensureAskOwnerIssue(gh, repository, sourceIssueNumber, request) {
  await ensureLabels(gh, repository, WORK_LABELS);
  const marker = `${ASK_OWNER_MARKER_PREFIX} repo=${repoName(repository)} issue=${sourceIssueNumber} reason=${request.reason} -->`;
  const existing = await findOpenIssueByMarker(gh, repository, marker);
  const body = [
    marker,
    `DarkFactory needs owner input for ${repoName(repository)}#${sourceIssueNumber}.`,
    "",
    "## Question",
    "",
    request.title,
    "",
    "## Context",
    "",
    ...request.details.map((detail) => `- ${detail}`),
    "",
    "## Acceptance Criteria",
    "",
    "- Owner answers this question or changes repository policy/state so DarkFactory can continue.",
    "- Remove `df:ask-owner` from this issue after the decision is captured in GitHub."
  ].join("\n");

  if (existing) {
    await gh.request("PATCH", `/repos/${repoName(repository)}/issues/${existing.number}`, {
      title: `DarkFactory owner decision: ${request.title}`,
      body
    });
    return { issue: `#${existing.number}`, result: "updated" };
  }

  const created = await gh.request("POST", `/repos/${repoName(repository)}/issues`, {
    title: `DarkFactory owner decision: ${request.title}`,
    body,
    labels: ["df:ask-owner"]
  });
  return { issue: `#${created.number}`, result: "created" };
}

async function upsertDashboardDigest(gh, controlRepo, brief) {
  const existing = await findOpenIssueByMarker(gh, controlRepo, DASHBOARD_MARKER);
  const body = [
    DASHBOARD_MARKER,
    "DarkFactory L0 orchestrator dashboard.",
    "",
    "```text",
    brief,
    "```"
  ].join("\n");

  if (existing) {
    const updated = await gh.request("PATCH", `/repos/${repoName(controlRepo)}/issues/${existing.number}`, {
      title: "DarkFactory Orchestrator Dashboard",
      body
    });
    return { issue: `#${updated.number ?? existing.number}`, result: "updated" };
  }

  const created = await gh.request("POST", `/repos/${repoName(controlRepo)}/issues`, {
    title: "DarkFactory Orchestrator Dashboard",
    body
  });
  return { issue: `#${created.number}`, result: "created" };
}

async function findOpenIssueByMarker(gh, repository, marker) {
  for (let page = 1; page <= 20; page += 1) {
    const batch = await gh.request(
      "GET",
      `/repos/${repoName(repository)}/issues?state=open&per_page=100&page=${page}`
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    const match = batch.find((issue) => !issue.pull_request && String(issue.body || "").includes(marker));
    if (match) return match;
    if (batch.length < 100) break;
  }
  return null;
}

async function listOpenWorkerPullRequestsByIssue(gh, repository) {
  const query = `
    query WorkerBranchPulls($owner: String!, $repo: String!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        pullRequests(states: OPEN, first: 100, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            number
            title
            body
            url
            headRefName
            headRepository {
              name
              owner { login }
            }
            author { login }
          }
        }
      }
    }`;
  const pullsByIssue = new Map();
  let cursor = null;

  for (let page = 1; page <= 20; page += 1) {
    const data = await gh.graphql(query, { owner: repository.owner, repo: repository.repo, cursor });
    const connection = data.repository.pullRequests;
    for (const pull of connection.nodes) {
      const sameRepositoryHead = pull.headRepository?.owner?.login === repository.owner && pull.headRepository?.name === repository.repo;
      const markerIssue = darkFactoryWorkerIssueNumber(pull);
      const branchIssue = Number(pull.headRefName?.match(/^df\/(\d+)-/)?.[1]);
      const issue = markerIssue > 0 ? markerIssue : branchIssue;
      if (!sameRepositoryHead || !Number.isInteger(issue) || issue <= 0) continue;
      if (!pullsByIssue.has(issue)) pullsByIssue.set(issue, pull);
    }

    if (!connection.pageInfo?.hasNextPage) break;
    cursor = connection.pageInfo.endCursor;
  }

  return pullsByIssue;
}

function synthesizeGlobalBrief(repoStates, actions, limits) {
  const totals = repoStates.reduce((sum, state) => {
    sum.ready += state.backlog.ready;
    sum.running += state.backlog.running;
    sum.blocked += state.backlog.blocked;
    sum.askOwner += state.backlog.ask_owner;
    sum.managed += state.backlog.managed;
    return sum;
  }, { ready: 0, running: 0, blocked: 0, askOwner: 0, managed: 0 });
  const lines = [];

  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Repos assessed: ${repoStates.length}`);
  lines.push(`Concurrency caps: global=${limits.global} per-repo=${limits.perRepo} per-stream=${limits.perStream}`);
  lines.push(`Backlog: managed=${totals.managed} ready=${totals.ready} running=${totals.running} blocked=${totals.blocked} ask-owner=${totals.askOwner}`);
  lines.push("");
  lines.push("Repositories:");
  for (const state of repoStates) {
    lines.push(
      `- ${state.repo}: ${state.git.branch}@${state.git.sha || "unknown"} ci=${state.ci.latest || "unknown"} prd=${state.prd.exists ? "present" : "missing"} ready=${state.backlog.ready} running=${state.backlog.running} blocked=${state.backlog.blocked} ask-owner=${state.backlog.ask_owner}`
    );
    const streams = Object.entries(state.streams)
      .map(([stream, counts]) => `${stream}:ready=${counts.ready},running=${counts.running},blocked=${counts.blocked}`)
      .join("; ");
    if (streams) lines.push(`  streams: ${streams}`);
    if (state.stream_ledgers.files.length) {
      const latest = state.stream_ledgers.latest ? ` latest=${state.stream_ledgers.latest}` : "";
      lines.push(`  stream ledgers: files=${state.stream_ledgers.files.length} entries=${state.stream_ledgers.entries}${latest}`);
    }
    if (state.open_blockers.length) lines.push(`  blockers: ${state.open_blockers.join(", ")}`);
  }
  lines.push("");
  lines.push("Actions:");
  if (actions.length === 0) {
    lines.push("- no changes");
  } else {
    for (const action of actions.slice(0, 80)) {
      lines.push(`- ${formatAction(action)}`);
    }
    if (actions.length > 80) lines.push(`- ... ${actions.length - 80} more actions`);
  }
  lines.push("");
  lines.push("Token use: 0 model calls; this L0 tick used deterministic GitHub state reconstruction.");
  lines.push("Harness migration: this state machine can move behind the harness scheduler without changing GitHub as the source of truth.");
  return lines.join("\n");
}

function formatAction(action) {
  const repo = action.repo ? `${action.repo} ` : "";
  const issue = action.issue ? `${action.issue} ` : "";
  const reason = action.reason ? ` (${action.reason})` : "";
  const result = action.result ? ` result=${action.result}` : "";
  return `${repo}${issue}${action.action}${reason}${result}`.trim();
}

function normalizeIssueState(issue) {
  const labels = new Set((issue.labels || []).map((label) => typeof label === "string" ? label : label?.name).filter(Boolean));
  const body = issue.body || "";
  const streams = [...labels]
    .filter((label) => label.startsWith("stream:"))
    .map((label) => label.slice("stream:".length) || "default")
    .sort();
  return {
    raw: issue,
    number: issue.number,
    title: issue.title || `Issue #${issue.number}`,
    body,
    labels,
    streams,
    priority: issuePriority(labels),
    blockedBy: extractBlockedBy(body),
    fixRound: maxFixRound(labels, body),
    blockedCommentCount: countWorkerBlockedComments(body),
    state: issue.state || "open"
  };
}

async function readStreamLedgers(gh, repository, ref, warn = console.warn) {
  const files = [];
  const seen = new Set();

  for (const filePath of STREAM_LEDGER_FILES) {
    const content = await readOptionalLedgerFile(gh, repository, filePath, ref, warn);
    if (content === null) continue;
    files.push(summarizeLedgerContent(filePath, content));
    seen.add(filePath);
  }

  for (const dirPath of STREAM_LEDGER_DIRS) {
    const entries = await listOptionalContentDirectory(gh, repository, dirPath, ref, warn);
    for (const entry of entries) {
      if (entry?.type !== "file" || typeof entry.path !== "string") continue;
      if (!/\.(json|jsonl|md|markdown)$/i.test(entry.path)) continue;
      if (seen.has(entry.path)) continue;
      const content = await readOptionalLedgerFile(gh, repository, entry.path, ref, warn);
      if (content === null) continue;
      files.push(summarizeLedgerContent(entry.path, content));
      seen.add(entry.path);
    }
  }

  const latest = files.map((file) => file.latest).filter(Boolean).sort().at(-1) ?? null;
  return {
    files,
    entries: files.reduce((sum, file) => sum + file.entries, 0),
    latest
  };
}

async function readOptionalLedgerFile(gh, repository, filePath, ref, warn) {
  try {
    return await getOptionalFileContent(gh, repository, filePath, ref);
  } catch (error) {
    warn(`DarkFactory stream ledger warning for ${repoName(repository)}:${filePath}: ${error.message || String(error)}`);
    return null;
  }
}

async function listOptionalContentDirectory(gh, repository, dirPath, ref, warn) {
  try {
    const suffix = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    const data = await gh.request("GET", `/repos/${repoName(repository)}/contents/${encodeContentPath(dirPath)}${suffix}`);
    return Array.isArray(data) ? data : [];
  } catch (error) {
    if (error.status === 404) return [];
    warn(`DarkFactory stream ledger directory warning for ${repoName(repository)}:${dirPath}: ${error.message || String(error)}`);
    return [];
  }
}

function summarizeLedgerContent(filePath, content) {
  const bytes = Buffer.byteLength(content, "utf8");
  const trimmed = content.trim();
  if (!trimmed) return { path: filePath, format: ledgerFormat(filePath), entries: 0, latest: null, bytes };

  if (/\.json$/i.test(filePath)) {
    try {
      return summarizeJsonLedger(filePath, JSON.parse(trimmed), bytes);
    } catch {
      return { path: filePath, format: "json", entries: 1, latest: null, bytes };
    }
  }

  if (/\.jsonl$/i.test(filePath)) {
    const rows = trimmed.split("\n").filter(Boolean);
    const latest = rows.map((row) => {
      try {
        return findLatestTimestamp(JSON.parse(row));
      } catch {
        return null;
      }
    }).filter(Boolean).sort().at(-1) ?? null;
    return { path: filePath, format: "jsonl", entries: rows.length, latest, bytes };
  }

  return { path: filePath, format: ledgerFormat(filePath), entries: 1, latest: null, bytes };
}

function summarizeJsonLedger(filePath, value, bytes) {
  if (Array.isArray(value)) {
    return { path: filePath, format: "json", entries: value.length, latest: findLatestTimestamp(value), bytes };
  }
  if (value && typeof value === "object") {
    const arrays = ["entries", "runs", "items", "actions", "events"]
      .map((key) => Array.isArray(value[key]) ? value[key] : null)
      .filter(Boolean);
    const entries = arrays.length ? arrays.reduce((sum, rows) => sum + rows.length, 0) : 1;
    return { path: filePath, format: "json", entries, latest: findLatestTimestamp(value), bytes };
  }
  return { path: filePath, format: "json", entries: 1, latest: null, bytes };
}

function findLatestTimestamp(value) {
  const timestamps = [];
  collectTimestamps(value, timestamps);
  return timestamps.sort().at(-1) ?? null;
}

function collectTimestamps(value, timestamps) {
  if (Array.isArray(value)) {
    for (const item of value) collectTimestamps(item, timestamps);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (typeof nested === "string" && /(?:created|updated|finished|timestamp|time|at)$/i.test(key) && !Number.isNaN(Date.parse(nested))) {
      timestamps.push(new Date(nested).toISOString());
    } else {
      collectTimestamps(nested, timestamps);
    }
  }
}

function ledgerFormat(filePath) {
  return filePath.split(".").at(-1)?.toLowerCase() || "text";
}

function encodeContentPath(filePath) {
  return filePath.split("/").map(encodeURIComponent).join("/");
}

function issuePriority(labels) {
  if (labels.has("P0")) return 0;
  if (labels.has("P1")) return 1;
  if (labels.has("P2")) return 2;
  return 3;
}

function maxFixRound(labels, body) {
  let round = 0;
  for (const label of labels) {
    const match = label.match(/^df:fix-round:(\d+)$/);
    if (match) round = Math.max(round, Number(match[1]));
  }
  for (const match of body.matchAll(/df:fix-round:(\d+)/g)) {
    round = Math.max(round, Number(match[1]));
  }
  return round;
}

function countWorkerBlockedComments(body) {
  const matches = body.match(/DarkFactory (?:worker|follow-through) blocked/gi);
  return matches ? matches.length : 0;
}

async function countBlockedCommentsFromHistory(gh, repository, issueNumber, warn) {
  try {
    const comments = await gh.request(
      "GET",
      `/repos/${repoName(repository)}/issues/${issueNumber}/comments?per_page=100`
    );
    if (!Array.isArray(comments)) return 0;
    return comments.reduce((count, comment) => count + countWorkerBlockedComments(String(comment.body || "")), 0);
  } catch (error) {
    if (error.status === 403 || error.status === 404) {
      warn(`DarkFactory could not read issue history for ${repoName(repository)}#${issueNumber}: ${error.message || String(error)}`);
      return 0;
    }
    throw error;
  }
}

function isManagedWorkIssue(issue) {
  if (issue.raw?.pull_request) return false;
  if (issue.labels.has("roadmap")) return true;
  if ([...issue.labels].some((label) => /^df:(ready|running|blocked|done|class:|prd-drift)/.test(label))) return true;
  if ([...issue.labels].some((label) => label.startsWith("stream:"))) return true;
  return new RegExp("df-prd:" + "[a-z0-9-]+").test(issue.body || "");
}

function blockersAreClosed(issue, issueByNumber) {
  return openBlockers(issue, issueByNumber).length === 0;
}

function openBlockers(issue, issueByNumber) {
  return issue.blockedBy
    .map((issueNumber) => issueByNumber.get(issueNumber) || { number: issueNumber, state: "unknown" })
    .filter((blocker) => blocker.state !== "closed");
}

function isDependencyOnlyBlocked(issue) {
  if (issue.blockedBy.length > 0) return true;
  return /Blocked[-\s]*by:/i.test(issue.body || "");
}

function issueRef(issue) {
  return `#${issue.number}`;
}

function compareCandidates(a, b) {
  if (a.issue.priority !== b.issue.priority) return a.issue.priority - b.issue.priority;
  const streamCompare = a.streams.join(",").localeCompare(b.streams.join(","));
  if (streamCompare !== 0) return streamCompare;
  return a.issue.number - b.issue.number;
}

function summarizeStreams(issues) {
  const streams = {};
  for (const issue of issues) {
    const names = issue.streams.length ? issue.streams : ["default"];
    for (const stream of names) {
      streams[stream] ??= { ready: 0, running: 0, blocked: 0 };
      if (issue.labels.has("df:ready")) streams[stream].ready += 1;
      if (issue.labels.has("df:running")) streams[stream].running += 1;
      if (issue.labels.has("df:blocked")) streams[stream].blocked += 1;
    }
  }
  return streams;
}

function applySequenceActionsToState(state, actions) {
  for (const action of actions) {
    if (action.repo !== repoName(state.repository)) continue;
    const number = Number(String(action.issue || "").replace("#", ""));
    const issue = state.issueByNumber.get(number);
    if (!issue) continue;
    if (action.action === "mark-ready" || action.action === "requeue-unblocked") {
      issue.labels.add("df:ready");
      issue.labels.delete("df:blocked");
      issue.labels.delete("df:done");
    }
    if (action.action === "remove-ready-blocked-by") {
      issue.labels.add("df:blocked");
      issue.labels.delete("df:ready");
    }
  }
}

function newActiveCounts() {
  return {
    global: 0,
    repos: new Map(),
    streams: new Map()
  };
}

function addExistingActiveCounts(activeCounts, state) {
  for (const issue of state.issues) {
    if (!issue.labels.has("df:running")) continue;
    incrementActiveCounts(activeCounts, state.repository, issue.streams.length ? issue.streams : ["default"]);
  }
  for (const openWorker of state.brief.open_worker_prs) {
    const issue = state.issueByNumber.get(openWorker.issue);
    if (!issue || issue.labels.has("df:running")) continue;
    incrementActiveCounts(activeCounts, state.repository, issue.streams.length ? issue.streams : ["default"]);
  }
}

function hasDispatchCapacity(activeCounts, repository, streams, limits) {
  if (activeCounts.global >= limits.global) return false;
  if ((activeCounts.repos.get(repoName(repository)) || 0) >= limits.perRepo) return false;
  for (const stream of streams) {
    if ((activeCounts.streams.get(stream) || 0) >= limits.perStream) return false;
  }
  return true;
}

function incrementActiveCounts(activeCounts, repository, streams) {
  activeCounts.global += 1;
  activeCounts.repos.set(repoName(repository), (activeCounts.repos.get(repoName(repository)) || 0) + 1);
  for (const stream of streams) {
    activeCounts.streams.set(stream, (activeCounts.streams.get(stream) || 0) + 1);
  }
}

async function getDefaultBranchState(gh, repository, branch) {
  try {
    const data = await gh.request("GET", `/repos/${repoName(repository)}/branches/${encodeURIComponent(branch)}`);
    return {
      sha: data?.commit?.sha || data?.commit?.commit?.tree?.sha || "",
      protected: data?.protected === true
    };
  } catch (error) {
    if (error.status === 404 || error.status === 403) {
      return { sha: "", protected: false };
    }
    throw error;
  }
}

async function getPrdState(gh, repository, branch) {
  const content = await getOptionalFileContent(gh, repository, "PRD.md", branch);
  if (!content) return { exists: false };
  return {
    exists: true,
    characters: content.length,
    sha: await getContentSha(gh, repository, "PRD.md", branch)
  };
}

async function getContentSha(gh, repository, filePath, ref) {
  try {
    const data = await gh.request(
      "GET",
      `/repos/${repoName(repository)}/contents/${encodePath(filePath)}?ref=${encodeURIComponent(ref)}`
    );
    return typeof data?.sha === "string" ? data.sha : "";
  } catch (error) {
    if (error.status === 404 || error.status === 403) return "";
    throw error;
  }
}

async function getRecentWorkflowRuns(gh, repository, branch, warn) {
  try {
    const data = await gh.request(
      "GET",
      `/repos/${repoName(repository)}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=10`
    );
    return Array.isArray(data?.workflow_runs) ? data.workflow_runs : [];
  } catch (error) {
    if (error.status === 403 || error.status === 404) {
      warn(`DarkFactory could not read workflow runs for ${repoName(repository)}: ${error.message || String(error)}`);
      return [];
    }
    throw error;
  }
}

function summarizeWorkflowRuns(runs) {
  if (!runs.length) return { latest: "none", red: 0, pending: 0 };
  const latest = runs[0];
  return {
    latest: `${latest.name || latest.workflow_id || "workflow"}:${latest.status || "unknown"}/${latest.conclusion || "none"}`,
    red: runs.filter((run) => run.status === "completed" && run.conclusion && run.conclusion !== "success").length,
    pending: runs.filter((run) => run.status !== "completed").length
  };
}

async function getIssueState(gh, repository, issueNumber, warn) {
  try {
    const issue = await gh.request("GET", `/repos/${repoName(repository)}/issues/${issueNumber}`);
    if (issue.pull_request) return null;
    return normalizeIssueState(issue);
  } catch (error) {
    if (error.status === 404 || error.status === 410) {
      return { number: issueNumber, title: `Issue #${issueNumber}`, body: "", labels: new Set(), streams: [], priority: 3, blockedBy: [], fixRound: 0, blockedCommentCount: 0, state: "missing", raw: null };
    }
    warn(`DarkFactory could not read blocker ${repoName(repository)}#${issueNumber}: ${error.message || String(error)}`);
    return { number: issueNumber, title: `Issue #${issueNumber}`, body: "", labels: new Set(), streams: [], priority: 3, blockedBy: [], fixRound: 0, blockedCommentCount: 0, state: "unknown", raw: null };
  }
}

function readLimitsFromEnv() {
  return {
    global: positiveInteger(process.env.DF_ORCHESTRATOR_GLOBAL_LIMIT, DEFAULT_LIMITS.global),
    perRepo: positiveInteger(process.env.DF_ORCHESTRATOR_REPO_LIMIT, DEFAULT_LIMITS.perRepo),
    perStream: positiveInteger(process.env.DF_ORCHESTRATOR_STREAM_LIMIT, DEFAULT_LIMITS.perStream)
  };
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
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

async function writeLedger(gh, dataRepo, controlRepo, ledger, warn = console.warn, log = console.log) {
  try {
    const written = await writeRunLedger(gh, dataRepo, "df-orchestrate", repoName(controlRepo), ledger);
    log(`DarkFactory ledger written to ${written.repository}/${written.path}`);
  } catch (error) {
    warn(`DarkFactory ledger warning: ${error.message || String(error)}`);
  }
}

function encodePath(filePath) {
  return filePath.split("/").map(encodeURIComponent).join("/");
}
