import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_DATA_REPO,
  PLANNING_LABELS,
  WORK_LABELS,
  assertAllowedRepo,
  createGithubClient,
  ensureLabels,
  findOpenWorkerPullRequestForIssue,
  getRepository,
  listActiveManagedRepos,
  parseRepo,
  preflightMergePolicy,
  readLocalJson,
  repoName,
  requiredEnv,
  warnReadOnlyRepository,
  writeRunLedger
} from "./df-lib.mjs";

const CONTROL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ORCHESTRATION_POLICY_PATH = ".darkfactory/orchestration.json";
export const DASHBOARD_MARKER = "df-dashboard:orchestration";
export const DEFAULT_ORCHESTRATION_POLICY = {
  schemaVersion: 1,
  concurrency: {
    global: 6,
    perRepository: 2,
    perStream: 3
  },
  waves: [
    {
      name: "hygiene",
      streams: ["hygiene", "setup", "bootstrap", "sync", "audit", "docs"]
    },
    {
      name: "enforcement",
      streams: ["enforcement", "review", "gate", "gates", "ci", "release"]
    },
    {
      name: "features",
      streams: ["feature", "features", "core", "work", "default"]
    }
  ],
  dashboard: {
    enabled: true,
    issueTitle: "DarkFactory L6 Orchestration Dashboard"
  }
};

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
    policy: policyInput,
    writeLedger: shouldWriteLedger = true,
    updateDashboard: shouldUpdateDashboard = true,
    warn = console.warn,
    log = console.log
  } = options;

  assertAllowedRepo(controlRepo);
  const policy = normalizeOrchestrationPolicy(policyInput ?? await readOrchestrationPolicy(root, warn));
  const targets = await targetRepositories(gh, controlRepo, { root, registry, repositories, warn });
  const snapshots = [];

  for (const target of targets) {
    try {
      snapshots.push({ repository: target, openIssues: await listOpenIssues(gh, target) });
    } catch (error) {
      if (warnReadOnlyRepository(target, error, "orchestration")) continue;
      warn(`Failed to inspect ${repoName(target)} for orchestration: ${error.message || String(error)}`);
    }
  }

  const plan = buildOrchestrationPlan(snapshots, policy);
  const dispatched = [];

  for (const candidate of plan.candidates) {
    const target = candidate.repository;
    const issue = candidate.issue;
    try {
      const wasDispatched = await dispatchWorker(gh, controlRepo, target, issue.number);
      if (wasDispatched) dispatched.push({
        repo: repoName(target),
        issue: issue.number,
        wave: candidate.wave,
        streams: candidate.streams
      });
    } catch (error) {
      if (warnReadOnlyRepository(target, error, "worker dispatch")) continue;
      warn(`Failed to dispatch worker for ${repoName(target)}#${issue.number}: ${error.message || String(error)}`);
    }
  }

  const ledger = {
    trigger,
    control_repo: repoName(controlRepo),
    wave_order: policy.waves.map((wave) => wave.name),
    concurrency: policy.concurrency,
    repositories: plan.repositories,
    dispatched,
    token_usage: {
      codex_calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      note: "Orchestrator dispatch is deterministic and uses no model calls"
    }
  };

  if (shouldWriteLedger) {
    await writeLedger(gh, dataRepo, controlRepo, ledger, warn, log);
  }
  if (shouldUpdateDashboard && policy.dashboard.enabled) {
    await updateDashboardIssue(gh, controlRepo, policy, plan, dispatched, trigger, warn, log);
  }
  log(`DarkFactory orchestrator dispatched ${dispatched.length} worker runs.`);
  return { dispatched, ledger };
}

export async function targetRepositories(gh, controlRepo, options = {}) {
  return await listActiveManagedRepos(gh, controlRepo, options);
}

export async function listReadyIssues(gh, repository) {
  return selectDispatchableIssues(await listOpenIssues(gh, repository));
}

export async function listOpenIssues(gh, repository) {
  const issues = [];
  for (let page = 1; page <= 20; page += 1) {
    const batch = await gh.request(
      "GET",
      `/repos/${repoName(repository)}/issues?state=open&per_page=100&page=${page}`
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    issues.push(...batch.filter((issue) => !issue.pull_request));
    if (batch.length < 100) break;
  }

  return issues;
}

export function selectDispatchableIssues(openIssues) {
  const openIssueNumbers = new Set(openIssues.map((issue) => issue.number).filter(Number.isInteger));
  const occupiedLanes = new Set();
  const selectedLanes = new Set();

  for (const issue of openIssues) {
    const names = issueLabelNames(issue);
    if (!names.has("df:running")) continue;
    for (const lane of issueStreamLanes(issue)) occupiedLanes.add(lane);
  }

  return openIssues
    .filter((issue) => {
      const names = issueLabelNames(issue);
      if (!names.has("df:ready")) return false;
      if (names.has("df:running") || names.has("df:blocked") || names.has("df:done")) return false;
      return blockedByIssueNumbers(issue.body || "").every(
        (number) => Number.isInteger(number) && !openIssueNumbers.has(number)
      );
    })
    .sort(compareReadyIssues)
    .filter((issue) => {
      const lanes = issueStreamLanes(issue);
      if (lanes.some((lane) => occupiedLanes.has(lane) || selectedLanes.has(lane))) return false;
      for (const lane of lanes) selectedLanes.add(lane);
      return true;
    });
}

export async function readOrchestrationPolicy(root = CONTROL_ROOT, warn = console.warn) {
  try {
    return await readLocalJson(path.join(root, ORCHESTRATION_POLICY_PATH), DEFAULT_ORCHESTRATION_POLICY);
  } catch (error) {
    warn(`DarkFactory orchestration policy warning: ${error.message || String(error)}`);
    return DEFAULT_ORCHESTRATION_POLICY;
  }
}

export function normalizeOrchestrationPolicy(policy = DEFAULT_ORCHESTRATION_POLICY) {
  const source = policy && typeof policy === "object" ? policy : {};
  const defaultPolicy = DEFAULT_ORCHESTRATION_POLICY;
  const sourceConcurrency = source.concurrency && typeof source.concurrency === "object" ? source.concurrency : {};
  const waves = Array.isArray(source.waves) && source.waves.length
    ? source.waves
    : defaultPolicy.waves;
  const normalizedWaves = waves
    .map((wave) => ({
      name: String(wave?.name || "").trim().toLowerCase(),
      streams: Array.isArray(wave?.streams)
        ? wave.streams.map((stream) => String(stream).trim().toLowerCase()).filter(Boolean)
        : []
    }))
    .filter((wave) => wave.name);

  return {
    schemaVersion: Number.isInteger(source.schemaVersion) ? source.schemaVersion : defaultPolicy.schemaVersion,
    concurrency: {
      global: positiveInteger(sourceConcurrency.global, defaultPolicy.concurrency.global),
      perRepository: positiveInteger(sourceConcurrency.perRepository, defaultPolicy.concurrency.perRepository),
      perStream: positiveInteger(sourceConcurrency.perStream, defaultPolicy.concurrency.perStream)
    },
    waves: normalizedWaves.length ? normalizedWaves : defaultPolicy.waves,
    dashboard: {
      enabled: source.dashboard?.enabled !== false,
      issueTitle: String(source.dashboard?.issueTitle || defaultPolicy.dashboard.issueTitle).trim()
        || defaultPolicy.dashboard.issueTitle
    }
  };
}

export function buildOrchestrationPlan(snapshots, policyInput = DEFAULT_ORCHESTRATION_POLICY) {
  const policy = normalizeOrchestrationPolicy(policyInput);
  const counts = activeConcurrencyCounts(snapshots);
  const candidates = [];
  const repositories = [];

  for (const snapshot of snapshots) {
    const repository = snapshot.repository;
    const openIssues = Array.isArray(snapshot.openIssues) ? snapshot.openIssues : [];
    const repositoryName = repoName(repository);
    const gateWave = repositoryGateWave(openIssues, policy);
    const selected = selectDispatchableIssues(openIssues)
      .map((issue) => ({
        repository,
        issue,
        wave: issueWave(issue, policy),
        waveRank: waveRank(issueWave(issue, policy), policy),
        streams: issueStreamKeys(issue),
        priority: priorityRank(issue)
      }))
      .filter((candidate) => !gateWave || candidate.wave === gateWave);

    candidates.push(...selected);
    repositories.push({
      repo: repositoryName,
      gate_wave: gateWave || "none",
      open_work: openIssues.filter(isWorkIssue).length,
      ready: openIssues.filter((issue) => issueLabelNames(issue).has("df:ready")).length,
      running: openIssues.filter((issue) => issueLabelNames(issue).has("df:running")).length,
      blocked: openIssues.filter((issue) => issueLabelNames(issue).has("df:blocked")).length,
      dispatchable: selected.length
    });
  }

  const planned = [];
  for (const candidate of candidates.sort(comparePlanCandidates)) {
    const repositoryKey = repoName(candidate.repository);
    if (counts.global >= policy.concurrency.global) break;
    if ((counts.byRepository.get(repositoryKey) || 0) >= policy.concurrency.perRepository) continue;
    if (candidate.streams.some((stream) => (counts.byStream.get(stream) || 0) >= policy.concurrency.perStream)) continue;

    planned.push(candidate);
    counts.global += 1;
    counts.byRepository.set(repositoryKey, (counts.byRepository.get(repositoryKey) || 0) + 1);
    for (const stream of candidate.streams) counts.byStream.set(stream, (counts.byStream.get(stream) || 0) + 1);
  }

  return {
    policy,
    candidates: planned,
    repositories,
    active: {
      global: counts.initialGlobal,
      byRepository: Object.fromEntries([...counts.initialByRepository.entries()].sort()),
      byStream: Object.fromEntries([...counts.initialByStream.entries()].sort())
    }
  };
}

export function repositoryGateWave(openIssues, policyInput = DEFAULT_ORCHESTRATION_POLICY) {
  const policy = normalizeOrchestrationPolicy(policyInput);
  let gate = null;
  for (const issue of openIssues.filter(isWorkIssue).filter((issue) => !issueLabelNames(issue).has("df:done"))) {
    const wave = issueWave(issue, policy);
    if (!gate || waveRank(wave, policy) < waveRank(gate, policy)) gate = wave;
  }
  return gate;
}

export function issueWave(issue, policyInput = DEFAULT_ORCHESTRATION_POLICY) {
  const policy = normalizeOrchestrationPolicy(policyInput);
  const names = issueLabelNames(issue);
  const waveLabel = [...names].find((label) => /^wave:[^:\s]+$/i.test(label));
  if (waveLabel) return waveLabel.slice("wave:".length).toLowerCase();

  const streamsByWave = new Map();
  for (const wave of policy.waves) {
    for (const stream of wave.streams) streamsByWave.set(stream, wave.name);
  }
  for (const stream of issueStreamKeys(issue)) {
    const wave = streamsByWave.get(stream);
    if (wave) return wave;
  }

  const text = `${issue.title || ""}\n${issue.body || ""}`.toLowerCase();
  if (/\b(hygiene|bootstrap|setup|managed setup|sync|audit|documentation|docs)\b/.test(text)) return "hygiene";
  if (/\b(enforcement|review gate|codex review|branch protection|ci|release)\b/.test(text)) return "enforcement";
  return "features";
}

async function updateDashboardIssue(gh, controlRepo, policy, plan, dispatched, trigger, warn = console.warn, log = console.log) {
  try {
    await ensureLabels(gh, controlRepo, PLANNING_LABELS);
    const title = policy.dashboard.issueTitle;
    const body = dashboardIssueBody(policy, plan, dispatched, trigger);
    const existing = await findDashboardIssue(gh, controlRepo);
    if (existing) {
      await gh.request("PATCH", `/repos/${repoName(controlRepo)}/issues/${existing.number}`, { title, body });
      log(`DarkFactory dashboard updated at ${repoName(controlRepo)}#${existing.number}`);
      return { action: "update", issue: existing.number };
    }

    const created = await gh.request("POST", `/repos/${repoName(controlRepo)}/issues`, {
      title,
      body,
      labels: ["roadmap"]
    });
    log(`DarkFactory dashboard created at ${repoName(controlRepo)}#${created.number}`);
    return { action: "create", issue: created.number };
  } catch (error) {
    warn(`DarkFactory dashboard warning: ${error.message || String(error)}`);
    return { action: "warning", warning: error.message || String(error) };
  }
}

async function findDashboardIssue(gh, controlRepo) {
  for (let page = 1; page <= 10; page += 1) {
    const issues = await gh.request(
      "GET",
      `/repos/${repoName(controlRepo)}/issues?state=open&per_page=100&page=${page}`
    );
    if (!Array.isArray(issues) || issues.length === 0) break;
    const found = issues.find((issue) => !issue.pull_request && String(issue.body || "").includes(DASHBOARD_MARKER));
    if (found) return found;
    if (issues.length < 100) break;
  }
  return null;
}

function dashboardIssueBody(policy, plan, dispatched, trigger) {
  const updatedAt = new Date().toISOString();
  const rows = plan.repositories.length
    ? plan.repositories.map((state) => {
      const dispatchedCount = dispatched.filter((item) => item.repo === state.repo).length;
      return `| \`${state.repo}\` | ${state.gate_wave} | ${state.open_work} | ${state.ready} | ${state.running} | ${state.blocked} | ${state.dispatchable} | ${dispatchedCount} |`;
    }).join("\n")
    : "| _none_ | none | 0 | 0 | 0 | 0 | 0 | 0 |";
  const dispatchRows = dispatched.length
    ? dispatched.map((item) => `- \`${item.repo}#${item.issue}\` (${item.wave}; ${item.streams.join(", ")})`).join("\n")
    : "- No worker dispatches in this tick.";

  return [
    `<!-- ${DASHBOARD_MARKER} -->`,
    "# DarkFactory L6 Orchestration Dashboard",
    "",
    `Updated: \`${updatedAt}\``,
    `Trigger: \`${trigger}\``,
    "",
    "## Wave Gates",
    "",
    `Order: ${policy.waves.map((wave) => `\`${wave.name}\``).join(" -> ")}`,
    "",
    "## Concurrency",
    "",
    `- Global active workers: \`${plan.active.global}/${policy.concurrency.global}\``,
    `- Per-repository cap: \`${policy.concurrency.perRepository}\``,
    `- Per-stream cap: \`${policy.concurrency.perStream}\``,
    "",
    "## Repositories",
    "",
    "| Repository | Gate | Open work | Ready | Running | Blocked | Dispatchable | Dispatched |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    rows,
    "",
    "## Dispatches",
    "",
    dispatchRows,
    "",
    "## Notes",
    "",
    "- Cross-repo waves, stream lanes, and concurrency caps are deterministic; AI tokens: 0.",
    "- Harness migration path: this GitHub-native scheduler state becomes harness scheduler input when L0/L6 move onto the harness runtime."
  ].join("\n");
}

export function compareReadyIssues(a, b) {
  return priorityRank(a) - priorityRank(b) || a.number - b.number;
}

export function priorityRank(issue) {
  const names = issueLabelNames(issue);
  if (names.has("P0")) return 0;
  if (names.has("P1")) return 1;
  if (names.has("P2")) return 2;
  return 3;
}

export function issueStreamLanes(issue) {
  const streamLabels = [...issueLabelNames(issue)]
    .filter((label) => /^stream:[^:\s]+$/i.test(label))
    .sort((a, b) => a.localeCompare(b));
  return streamLabels.length ? streamLabels : ["stream:default"];
}

function issueStreamKeys(issue) {
  return issueStreamLanes(issue).map((lane) => lane.slice("stream:".length).toLowerCase());
}

export function blockedByIssueNumbers(body) {
  const numbers = [];
  for (const line of String(body || "").split(/\r?\n/)) {
    const match = line.match(/^\s*Blocked-by:\s*(.+)$/i);
    if (!match) continue;

    const refs = [...match[1].matchAll(/(?:[\w.-]+\/[\w.-]+)?#(\d+)/g)];
    if (refs.length === 0) {
      numbers.push(Number.NaN);
      continue;
    }

    numbers.push(...refs.map((ref) => Number(ref[1])));
  }
  return numbers;
}

function issueLabelNames(issue) {
  return new Set(
    (issue.labels || []).map((label) => (typeof label === "string" ? label : label?.name)).filter(Boolean)
  );
}

function isWorkIssue(issue) {
  const names = issueLabelNames(issue);
  return [...names].some((label) => label.startsWith("df:") || label === "roadmap");
}

function activeConcurrencyCounts(snapshots) {
  const byRepository = new Map();
  const byStream = new Map();
  let global = 0;

  for (const snapshot of snapshots) {
    const repositoryKey = repoName(snapshot.repository);
    for (const issue of (snapshot.openIssues || [])) {
      if (!issueLabelNames(issue).has("df:running")) continue;
      global += 1;
      byRepository.set(repositoryKey, (byRepository.get(repositoryKey) || 0) + 1);
      for (const stream of issueStreamKeys(issue)) {
        byStream.set(stream, (byStream.get(stream) || 0) + 1);
      }
    }
  }

  return {
    global,
    byRepository,
    byStream,
    initialGlobal: global,
    initialByRepository: new Map(byRepository),
    initialByStream: new Map(byStream)
  };
}

function comparePlanCandidates(a, b) {
  return a.waveRank - b.waveRank
    || a.priority - b.priority
    || repoName(a.repository).localeCompare(repoName(b.repository))
    || a.issue.number - b.issue.number;
}

function waveRank(name, policy) {
  const index = policy.waves.findIndex((wave) => wave.name === name);
  return index === -1 ? policy.waves.length : index;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

export async function dispatchWorker(gh, controlRepo, repository, issueNumber) {
  const existingPullRequest = await findOpenWorkerPullRequestForIssue(gh, repository, issueNumber);
  if (existingPullRequest) {
    await replaceIssueLabels(gh, repository, issueNumber, ["df:running"], ["df:ready"]);
    return false;
  }

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

async function writeLedger(gh, dataRepo, controlRepo, ledger, warn = console.warn, log = console.log) {
  try {
    const written = await writeRunLedger(gh, dataRepo, "df-orchestrate", repoName(controlRepo), ledger);
    log(`DarkFactory ledger written to ${written.repository}/${written.path}`);
  } catch (error) {
    warn(`DarkFactory ledger warning: ${error.message || String(error)}`);
  }
}
