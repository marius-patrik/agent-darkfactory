export const CONTROL_OWNER = "marius-patrik";
export const CONTROL_REPO = "agent-darkfactory";
export const DATA_REPO = "data-agentos";

export interface GitHubRequester {
  request(route: string, parameters: Record<string, unknown>): Promise<{ data: unknown }>;
}

export interface RepositoryRef {
  owner: string;
  repo: string;
}

export interface ManagedRepo extends RepositoryRef {
  state: "active" | "parked" | "archived";
}

export interface RepoLoopState extends RepositoryRef {
  ready: number;
  running: number;
  askOwner: number;
}

export interface WorkflowRunInfo {
  id: number;
  name: string;
  workflowId: number | string;
  status: string;
  conclusion: string | null;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
}

export interface RecentRuns {
  plan: WorkflowRunInfo | null;
  orchestrate: WorkflowRunInfo | null;
  inFlightWork: WorkflowRunInfo[];
}

export interface BlockedIssue {
  repo: string;
  number: number;
  title: string;
  url: string;
}

export interface LedgerSummary {
  dispatchCount: number;
  timestamp: string | null;
}

export interface StatusReport {
  generatedAt: string;
  managedRepos: ManagedRepo[];
  loopState: RepoLoopState[];
  recentRuns: RecentRuns;
  latestLedger: LedgerSummary | null;
  blocked: BlockedIssue[];
}

export interface StatusOptions {
  controlOwner?: string;
  controlRepo?: string;
  dataRepo?: string;
}

const MANAGED_REPOS_PATH = ".darkfactory/managed-repos.json";

export function parseManagedReposJson(raw: unknown, owner: string): ManagedRepo[] {
  if (!isRecord(raw) || !isRecord(raw.repositories)) {
    throw new Error("invalid managed-repos.json: missing repositories object");
  }

  const repos: ManagedRepo[] = [];

  for (const [fullName, entry] of Object.entries(raw.repositories)) {
    const ref = parseRepositoryRef(fullName);
    if (ref.owner.toLowerCase() !== owner.toLowerCase()) {
      continue;
    }

    if (!isRecord(entry) || typeof entry.state !== "string") {
      throw new Error(`invalid managed repo entry: ${fullName}`);
    }

    if (entry.state === "active") {
      repos.push({ owner: ref.owner, repo: ref.repo, state: "active" });
    }
  }

  return repos;
}

export async function fetchManagedRepos(
  github: GitHubRequester,
  controlRepo: RepositoryRef,
  owner: string
): Promise<ManagedRepo[]> {
  const response = await github.request("GET /repos/{owner}/{repo}/contents/{path}", {
    owner: controlRepo.owner,
    repo: controlRepo.repo,
    path: MANAGED_REPOS_PATH
  });

  const content = decodeContentResponse(response.data);
  if (content === null) {
    throw new Error(`GitHub returned an invalid managed-repos.json content response`);
  }

  const raw = JSON.parse(content) as unknown;
  return parseManagedReposJson(raw, owner);
}

export async function buildStatusReport(
  github: GitHubRequester,
  options: StatusOptions = {}
): Promise<StatusReport> {
  const owner = options.controlOwner ?? CONTROL_OWNER;
  const controlRepo = options.controlRepo ?? CONTROL_REPO;
  const dataRepo = options.dataRepo ?? DATA_REPO;

  const managedRepos = await fetchManagedRepos(github, { owner, repo: controlRepo }, owner);
  const [loopState, recentRuns, latestLedger, blocked] = await Promise.all([
    fetchLoopStateForRepos(github, managedRepos),
    fetchRecentRuns(github, { owner, repo: controlRepo }),
    fetchLatestLedger(github, { owner, repo: dataRepo }, { owner, repo: controlRepo }),
    fetchBlockedIssues(github, managedRepos)
  ]);

  return {
    generatedAt: new Date().toISOString(),
    managedRepos,
    loopState,
    recentRuns,
    latestLedger,
    blocked
  };
}

async function fetchLoopStateForRepos(
  github: GitHubRequester,
  repos: RepositoryRef[]
): Promise<RepoLoopState[]> {
  return Promise.all(repos.map((repo) => fetchRepoLoopState(github, repo)));
}

export async function fetchRepoLoopState(
  github: GitHubRequester,
  repo: RepositoryRef
): Promise<RepoLoopState> {
  const [ready, running, askOwner] = await Promise.all([
    countIssuesWithLabel(github, repo, "df:ready"),
    countIssuesWithLabel(github, repo, "df:running"),
    listIssuesWithLabel(github, repo, "df:ask-owner")
  ]);

  return {
    owner: repo.owner,
    repo: repo.repo,
    ready,
    running,
    askOwner: askOwner.length
  };
}

async function countIssuesWithLabel(
  github: GitHubRequester,
  repo: RepositoryRef,
  label: string
): Promise<number> {
  const issues = await listIssuesWithLabel(github, repo, label);
  return issues.length;
}

async function listIssuesWithLabel(
  github: GitHubRequester,
  repo: RepositoryRef,
  label: string
): Promise<Array<{ number: number; title: string; html_url: string }>> {
  const issues: Array<{ number: number; title: string; html_url: string }> = [];

  for (let page = 1; page <= 20; page += 1) {
    const response = await github.request("GET /repos/{owner}/{repo}/issues", {
      owner: repo.owner,
      repo: repo.repo,
      state: "open",
      labels: label,
      per_page: 100,
      page
    });

    if (!Array.isArray(response.data)) {
      throw new Error(`GitHub returned an invalid issues list for ${repo.owner}/${repo.repo}`);
    }

    const batch = response.data
      .filter((item) => !isRecord(item) || !isRecord(item.pull_request))
      .map((item) => {
        if (
          !isRecord(item) ||
          typeof item.number !== "number" ||
          typeof item.title !== "string" ||
          typeof item.html_url !== "string"
        ) {
          throw new Error(`GitHub returned an invalid issue record in ${repo.owner}/${repo.repo}`);
        }

        return { number: item.number, title: item.title, html_url: item.html_url };
      });

    issues.push(...batch);

    if (response.data.length < 100) {
      break;
    }
  }

  return issues;
}

export async function fetchRecentRuns(
  github: GitHubRequester,
  controlRepo: RepositoryRef
): Promise<RecentRuns> {
  const [plan, orchestrate, workRuns] = await Promise.all([
    fetchLatestWorkflowRun(github, controlRepo, "df-plan.yml"),
    fetchLatestWorkflowRun(github, controlRepo, "df-orchestrate.yml"),
    fetchWorkflowRuns(github, controlRepo, "df-work.yml")
  ]);

  return {
    plan,
    orchestrate,
    inFlightWork: workRuns.filter((run) => run.status !== "completed")
  };
}

async function fetchLatestWorkflowRun(
  github: GitHubRequester,
  repo: RepositoryRef,
  workflowId: string
): Promise<WorkflowRunInfo | null> {
  const runs = await fetchWorkflowRuns(github, repo, workflowId);
  return runs[0] ?? null;
}

async function fetchWorkflowRuns(
  github: GitHubRequester,
  repo: RepositoryRef,
  workflowId: string
): Promise<WorkflowRunInfo[]> {
  const response = await github.request("GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs", {
    owner: repo.owner,
    repo: repo.repo,
    workflow_id: workflowId,
    per_page: 50
  });

  if (!isRecord(response.data) || !Array.isArray(response.data.workflow_runs)) {
    throw new Error(`GitHub returned an invalid workflow runs response for ${workflowId}`);
  }

  return response.data.workflow_runs.map((run) => {
    if (
      !isRecord(run) ||
      typeof run.id !== "number" ||
      typeof run.name !== "string" ||
      (typeof run.workflow_id !== "number" && typeof run.workflow_id !== "string") ||
      typeof run.status !== "string" ||
      typeof run.created_at !== "string" ||
      typeof run.updated_at !== "string" ||
      typeof run.html_url !== "string"
    ) {
      throw new Error(`GitHub returned an invalid workflow run record for ${workflowId}`);
    }

    return {
      id: run.id,
      name: run.name,
      workflowId: run.workflow_id,
      status: run.status,
      conclusion: typeof run.conclusion === "string" ? run.conclusion : null,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      htmlUrl: run.html_url
    };
  });
}

export async function fetchLatestLedger(
  github: GitHubRequester,
  dataRepo: RepositoryRef,
  controlRepo: RepositoryRef
): Promise<LedgerSummary | null> {
  const ledgerPath = `runs/${controlRepo.owner}/${controlRepo.repo}`;
  const response = await github.request("GET /repos/{owner}/{repo}/contents/{path}", {
    owner: dataRepo.owner,
    repo: dataRepo.repo,
    path: ledgerPath
  });

  if (!Array.isArray(response.data)) {
    return null;
  }

  const orchestrateFiles = response.data
    .filter(
      (entry) =>
        isRecord(entry) && typeof entry.name === "string" && entry.name.endsWith("-df-orchestrate.json")
    )
    .map((entry) => String(entry.name))
    .sort()
    .reverse();

  if (orchestrateFiles.length === 0) {
    return null;
  }

  const latestFile = orchestrateFiles[0];
  const fileResponse = await github.request("GET /repos/{owner}/{repo}/contents/{path}", {
    owner: dataRepo.owner,
    repo: dataRepo.repo,
    path: `${ledgerPath}/${latestFile}`
  });

  const content = decodeContentResponse(fileResponse.data);
  if (content === null) {
    return null;
  }

  const ledger = JSON.parse(content) as unknown;
  if (!isRecord(ledger) || !Array.isArray(ledger.dispatched)) {
    return { dispatchCount: 0, timestamp: null };
  }

  return {
    dispatchCount: ledger.dispatched.length,
    timestamp: typeof ledger.created_at === "string" ? ledger.created_at : null
  };
}

export async function fetchBlockedIssues(
  github: GitHubRequester,
  repos: RepositoryRef[]
): Promise<BlockedIssue[]> {
  const nested = await Promise.all(repos.map((repo) => listIssuesWithLabel(github, repo, "df:ask-owner")));
  const blocked: BlockedIssue[] = [];

  for (let index = 0; index < repos.length; index += 1) {
    const repo = repos[index];
    for (const issue of nested[index]) {
      blocked.push({
        repo: `${repo.owner}/${repo.repo}`,
        number: issue.number,
        title: issue.title,
        url: issue.html_url
      });
    }
  }

  return blocked.sort((a, b) => {
    const repoCompare = a.repo.localeCompare(b.repo);
    if (repoCompare !== 0) return repoCompare;
    return a.number - b.number;
  });
}

export function formatStatusReport(report: StatusReport): string {
  const lines: string[] = [];
  lines.push("DarkFactory orchestration status");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push("");

  lines.push("Managed repositories:");
  for (const repo of report.managedRepos) {
    lines.push(`  ${repo.owner}/${repo.repo}`);
  }
  lines.push("");

  lines.push("Loop state:");
  lines.push(`  ${pad("repo", 32)} ${pad("ready", 5)} ${pad("running", 7)} ask-owner`);
  for (const state of report.loopState) {
    lines.push(
      `  ${pad(`${state.owner}/${state.repo}`, 32)} ${pad(String(state.ready), 5)} ${pad(String(state.running), 7)} ${state.askOwner}`
    );
  }
  lines.push("");

  lines.push("Recent control-repo runs:");
  lines.push(`  df-plan:        ${formatRun(report.recentRuns.plan)}`);
  lines.push(`  df-orchestrate: ${formatRun(report.recentRuns.orchestrate)}`);
  lines.push("");

  if (report.recentRuns.inFlightWork.length > 0) {
    lines.push("In-flight df-work runs:");
    for (const run of report.recentRuns.inFlightWork) {
      lines.push(`  #${run.id} ${run.status} ${run.name} ${run.htmlUrl}`);
    }
    lines.push("");
  }

  if (report.latestLedger) {
    lines.push(
      `Latest ledger: ${report.latestLedger.dispatchCount} dispatched at ${report.latestLedger.timestamp ?? "unknown"}`
    );
    lines.push("");
  }

  if (report.blocked.length > 0) {
    lines.push("Blocked (df:ask-owner):");
    for (const issue of report.blocked) {
      lines.push(`  ${issue.repo}#${issue.number} ${issue.title}`);
    }
  } else {
    lines.push("Blocked: none");
  }

  return lines.join("\n");
}

function formatRun(run: WorkflowRunInfo | null): string {
  if (!run) {
    return "no runs found";
  }

  return `${run.status}${run.conclusion ? ` (${run.conclusion})` : ""} at ${run.createdAt} — ${run.htmlUrl}`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function parseRepositoryRef(value: string): RepositoryRef {
  const parts = value.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`invalid repository reference: ${value}`);
  }

  return { owner: parts[0], repo: parts[1] };
}

function decodeContentResponse(data: unknown): string | null {
  if (!isRecord(data) || data.type !== "file" || typeof data.content !== "string") {
    return null;
  }

  const encoding = typeof data.encoding === "string" ? data.encoding : "base64";
  if (encoding !== "base64") {
    return null;
  }

  return Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf8").replace(/\r\n/g, "\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
