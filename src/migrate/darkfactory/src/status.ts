export const CONTROL_OWNER = "marius-patrik";
export const CONTROL_REPO = "DarkFactory";
export const DARK_FACTORY_DATA_REPO = "darkfactory-data";

export interface GitHubRequester {
  request(route: string, parameters: Record<string, unknown>): Promise<{ data: unknown; headers?: Record<string, string> }>;
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

export interface ModelExecutionSummary {
  repo: string;
  modelTier: "low" | "medium" | "high" | "max";
  effort: string;
  provider: string | null;
  model: string | null;
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  status: string;
  blockReason: string | null;
  timestamp: string | null;
}

export interface PrdCoverage extends RepositoryRef {
  rootPrd: boolean;
  packagePrds: number;
  totalPackages: number;
}

export interface BacklogCoverage extends RepositoryRef {
  openIssues: number;
  prdTrackedIssues: number;
}

export interface StatusReport {
  generatedAt: string;
  managedRepos: ManagedRepo[];
  loopState: RepoLoopState[];
  recentRuns: RecentRuns;
  latestLedger: LedgerSummary | null;
  modelExecutions: ModelExecutionSummary[];
  blocked: BlockedIssue[];
  prdCoverage: PrdCoverage[];
  backlogCoverage: BacklogCoverage[];
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
  github: GitHubRequester
): Promise<StatusReport> {
  const owner = CONTROL_OWNER;
  const controlRepo = CONTROL_REPO;
  const dataRepo = DARK_FACTORY_DATA_REPO;

  const managedRepos = await fetchManagedRepos(github, { owner, repo: controlRepo }, owner);
  const [loopState, recentRuns, latestLedger, modelExecutions, blocked, prdCoverage, backlogCoverage] = await Promise.all([
    fetchLoopStateForRepos(github, managedRepos),
    fetchRecentRuns(github, { owner, repo: controlRepo }),
    fetchLatestLedger(github, { owner, repo: dataRepo }, { owner, repo: controlRepo }),
    fetchLatestModelExecutions(github, { owner, repo: dataRepo }, managedRepos),
    fetchBlockedIssues(github, managedRepos),
    fetchPrdCoverage(github, managedRepos),
    fetchBacklogCoverage(github, managedRepos)
  ]);

  return {
    generatedAt: new Date().toISOString(),
    managedRepos,
    loopState,
    recentRuns,
    latestLedger,
    modelExecutions,
    blocked,
    prdCoverage,
    backlogCoverage
  };
}

export async function fetchLatestModelExecutions(
  github: GitHubRequester,
  dataRepo: RepositoryRef,
  repos: RepositoryRef[]
): Promise<ModelExecutionSummary[]> {
  const summaries = await Promise.all(repos.map(async (repo) => {
    const ledgerPath = `runs/${repo.owner}/${repo.repo}`;
    let listing;
    try {
      listing = await github.request("GET /repos/{owner}/{repo}/contents/{path}", {
        owner: dataRepo.owner,
        repo: dataRepo.repo,
        path: ledgerPath
      });
    } catch (error) {
      if (isRequestError(error) && error.status === 404) return null;
      throw error;
    }
    if (!Array.isArray(listing.data)) return null;
    const latest = listing.data
      .filter((entry) => isRecord(entry) && typeof entry.name === "string" && entry.name.endsWith("-df-work.json"))
      .map((entry) => String((entry as Record<string, unknown>).name))
      .sort()
      .reverse()[0];
    if (!latest) return null;
    const response = await github.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner: dataRepo.owner,
      repo: dataRepo.repo,
      path: `${ledgerPath}/${latest}`
    });
    const content = decodeContentResponse(response.data);
    if (content === null) return null;
    let ledger: unknown;
    try {
      ledger = JSON.parse(content);
    } catch {
      return null;
    }
    if (!isRecord(ledger) || !isRecord(ledger.model_request)) return null;
    const modelTier = ledger.model_request.modelTier;
    const effort = ledger.model_request.effort;
    if (typeof modelTier !== "string" || !new Set(["low", "medium", "high", "max"]).has(modelTier) || typeof effort !== "string") return null;
    const receipt = isRecord(ledger.agent_os) && isRecord(ledger.agent_os.receipt) ? ledger.agent_os.receipt : null;
    const resolved = receipt && isRecord(receipt.resolved) ? receipt.resolved : null;
    const usage = receipt && isRecord(receipt.usage) ? receipt.usage : null;
    const attempts = receipt && Array.isArray(receipt.attempts) ? receipt.attempts.length : 0;
    const safeRoute = (value: unknown): string | null =>
      typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.\/-]{0,127}$/.test(value) ? value : null;
    const safeCount = (value: unknown): number => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
    const status = typeof ledger.status === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(ledger.status)
      ? ledger.status
      : "unknown";
    const receiptBlockReason = receipt ? safeRoute(receipt.blockReason) : null;
    return {
      repo: `${repo.owner}/${repo.repo}`,
      modelTier: modelTier as ModelExecutionSummary["modelTier"],
      effort,
      provider: resolved ? safeRoute(resolved.provider) : null,
      model: resolved ? safeRoute(resolved.model) : null,
      attempts,
      inputTokens: usage ? safeCount(usage.inputTokens) : 0,
      outputTokens: usage ? safeCount(usage.outputTokens) : 0,
      status,
      blockReason: status === "blocked" ? (receiptBlockReason || "execution_blocked") : receiptBlockReason,
      timestamp: typeof ledger.created_at === "string" ? ledger.created_at : null
    } satisfies ModelExecutionSummary;
  }));
  return summaries.filter((summary): summary is ModelExecutionSummary => summary !== null);
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

    const batch: Array<{ number: number; title: string; html_url: string }> = [];
    for (const item of response.data) {
      if (!isRecord(item)) continue;
      if (isRecord(item.pull_request)) continue;
      if (
        typeof item.number !== "number" ||
        typeof item.title !== "string" ||
        typeof item.html_url !== "string"
      ) {
        continue;
      }
      batch.push({ number: item.number, title: item.title, html_url: item.html_url });
    }

    issues.push(...batch);

    if (!hasNextPage(response.headers)) {
      break;
    }
  }

  return issues;
}

function hasNextPage(headers: Record<string, string> | undefined): boolean {
  const link = headers?.link ?? headers?.Link;
  if (typeof link !== "string") {
    return false;
  }
  return link.includes('rel="next"');
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

export async function fetchPrdCoverage(
  github: GitHubRequester,
  repos: RepositoryRef[]
): Promise<PrdCoverage[]> {
  return Promise.all(repos.map((repo) => fetchRepoPrdCoverage(github, repo)));
}

async function fetchRepoPrdCoverage(github: GitHubRequester, repo: RepositoryRef): Promise<PrdCoverage> {
  const repoInfo = await github.request("GET /repos/{owner}/{repo}", {
    owner: repo.owner,
    repo: repo.repo
  });

  const defaultBranch = isRecord(repoInfo.data) && typeof repoInfo.data.default_branch === "string"
    ? repoInfo.data.default_branch
    : "main";

  const rootPrd = await hasRootPrd(github, repo, defaultBranch);
  const { packagePrds, totalPackages } = await countPackagePrds(github, repo, defaultBranch);

  return {
    owner: repo.owner,
    repo: repo.repo,
    rootPrd,
    packagePrds,
    totalPackages
  };
}

async function hasRootPrd(github: GitHubRequester, repo: RepositoryRef, ref: string): Promise<boolean> {
  try {
    const response = await github.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner: repo.owner,
      repo: repo.repo,
      path: "PRD.md",
      ref
    });
    return isRecord(response.data) && response.data.type === "file";
  } catch (error) {
    if (isRequestError(error) && error.status === 404) {
      return false;
    }
    throw error;
  }
}

async function countPackagePrds(
  github: GitHubRequester,
  repo: RepositoryRef,
  ref: string
): Promise<{ packagePrds: number; totalPackages: number }> {
  try {
    const response = await github.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
      owner: repo.owner,
      repo: repo.repo,
      tree_sha: encodeURIComponent(ref),
      recursive: 1
    });

    if (!isRecord(response.data) || !Array.isArray(response.data.tree)) {
      return { packagePrds: 0, totalPackages: 0 };
    }

    const tree = response.data.tree as Array<{ type?: string; path?: string }>;
    const packageDirs = new Set<string>();
    const prdPaths = new Set<string>();

    for (const entry of tree) {
      if (entry.type !== "blob" || typeof entry.path !== "string") continue;
      if (entry.path.endsWith("/package.json")) {
        const dir = entry.path.slice(0, -"/package.json".length);
        if (dir && !dir.includes("node_modules") && !dir.includes("/.") && dir !== ".") {
          packageDirs.add(dir);
        }
      }
      if (entry.path === "PRD.md" || entry.path.endsWith("/PRD.md")) {
        prdPaths.add(entry.path);
      }
    }

    let packagePrds = 0;
    for (const dir of packageDirs) {
      if (prdPaths.has(`${dir}/PRD.md`)) {
        packagePrds += 1;
      }
    }

    return { packagePrds, totalPackages: packageDirs.size };
  } catch (error) {
    if (isRequestError(error) && (error.status === 404 || error.status === 409)) {
      return { packagePrds: 0, totalPackages: 0 };
    }
    throw error;
  }
}

export async function fetchBacklogCoverage(
  github: GitHubRequester,
  repos: RepositoryRef[]
): Promise<BacklogCoverage[]> {
  return Promise.all(repos.map((repo) => fetchRepoBacklogCoverage(github, repo)));
}

async function fetchRepoBacklogCoverage(github: GitHubRequester, repo: RepositoryRef): Promise<BacklogCoverage> {
  const issues = await listOpenIssues(github, repo);
  let prdTrackedIssues = 0;
  for (const issue of issues) {
    const body = typeof issue.body === "string" ? issue.body : "";
    if (/df-prd:[a-z0-9-]+/.test(body)) {
      prdTrackedIssues += 1;
    }
  }

  return {
    owner: repo.owner,
    repo: repo.repo,
    openIssues: issues.length,
    prdTrackedIssues
  };
}

async function listOpenIssues(
  github: GitHubRequester,
  repo: RepositoryRef
): Promise<Array<{ number: number; title: string; html_url: string; body?: string }>> {
  const issues: Array<{ number: number; title: string; html_url: string; body?: string }> = [];

  for (let page = 1; page <= 20; page += 1) {
    const response = await github.request("GET /repos/{owner}/{repo}/issues", {
      owner: repo.owner,
      repo: repo.repo,
      state: "open",
      per_page: 100,
      page
    });

    if (!Array.isArray(response.data)) {
      throw new Error(`GitHub returned an invalid issues list for ${repo.owner}/${repo.repo}`);
    }

    const batch: Array<{ number: number; title: string; html_url: string; body?: string }> = [];
    for (const item of response.data) {
      if (!isRecord(item)) continue;
      if (isRecord(item.pull_request)) continue;
      if (
        typeof item.number !== "number" ||
        typeof item.title !== "string" ||
        typeof item.html_url !== "string"
      ) {
        continue;
      }
      batch.push({ number: item.number, title: item.title, html_url: item.html_url, body: typeof item.body === "string" ? item.body : undefined });
    }

    issues.push(...batch);

    if (!hasNextPage(response.headers)) {
      break;
    }
  }

  return issues;
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

  lines.push("Latest model executions:");
  if (report.modelExecutions.length === 0) {
    lines.push("  none");
  } else {
    for (const execution of report.modelExecutions) {
      lines.push(
        `  ${execution.repo}: tier=${execution.modelTier} effort=${execution.effort} route=${execution.provider ?? "unresolved"}/${execution.model ?? "unresolved"} attempts=${execution.attempts} usage=${execution.inputTokens}+${execution.outputTokens} status=${execution.status}${execution.blockReason ? ` block=${execution.blockReason}` : ""}`
      );
    }
  }
  lines.push("");

  if (report.blocked.length > 0) {
    lines.push("Blocked (df:ask-owner):");
    for (const issue of report.blocked) {
      lines.push(`  ${issue.repo}#${issue.number} ${issue.title}`);
    }
  } else {
    lines.push("Blocked: none");
  }
  lines.push("");

  lines.push("PRD coverage:");
  lines.push(`  ${pad("repo", 32)} ${pad("root", 5)} ${pad("packages", 12)}`);
  for (const coverage of report.prdCoverage) {
    const packageCell = `${coverage.packagePrds}/${coverage.totalPackages}`;
    lines.push(
      `  ${pad(`${coverage.owner}/${coverage.repo}`, 32)} ${pad(coverage.rootPrd ? "yes" : "no", 5)} ${pad(packageCell, 12)}`
    );
  }
  lines.push("");

  lines.push("Backlog coverage:");
  lines.push(`  ${pad("repo", 32)} ${pad("open", 5)} ${pad("prd", 5)}`);
  for (const coverage of report.backlogCoverage) {
    lines.push(
      `  ${pad(`${coverage.owner}/${coverage.repo}`, 32)} ${pad(String(coverage.openIssues), 5)} ${pad(String(coverage.prdTrackedIssues), 5)}`
    );
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

function isRequestError(error: unknown): error is { status: number } {
  return isRecord(error) && typeof error.status === "number";
}
