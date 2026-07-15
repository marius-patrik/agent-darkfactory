import type { OperatorGitHubRequester, RepositoryRef } from "./clean-evidence.js";

export interface LabelDefinition {
  name: string;
  color: string;
  description: string;
}

export interface SetupReceipt {
  action: string;
  target: string;
  status: "applied" | "current" | "owner-required";
  detail: string;
}

export class SetupOwnerActionRequired extends Error {
  readonly action: string;

  constructor(action: string, message: string) {
    super(message);
    this.name = "SetupOwnerActionRequired";
    this.action = action;
  }
}

export async function convergeRepositorySettings(
  github: OperatorGitHubRequester,
  repository: RepositoryRef,
  labels: LabelDefinition[],
  managedWorkflowPaths: string[]
): Promise<SetupReceipt[]> {
  const receipts: SetupReceipt[] = [];
  const metadata = record((await github.request("GET /repos/{owner}/{repo}", { ...repository })).data, "repository metadata");
  if (metadata.archived === true || metadata.disabled === true) {
    throw new SetupOwnerActionRequired("repository-lifecycle", "Archived or disabled repositories cannot be converged.");
  }
  let defaultBranch = text(metadata.default_branch, "default branch");
  let mainHead = await optionalRefHead(github, repository, "main");
  const defaultHead = await optionalRefHead(github, repository, defaultBranch);
  if (!mainHead && !defaultHead) {
    mainHead = await initializeEmptyMain(github, repository);
    receipts.push(receipt("initialize-main", "main", "applied", "Created the first empty commit and canonical main ref; all managed content still flows through reviewed PRs."));
  } else if (!mainHead && defaultHead) {
    await github.request("POST /repos/{owner}/{repo}/git/refs", {
      ...repository,
      ref: "refs/heads/main",
      sha: defaultHead
    }).catch((error) => { throw wrapOwnerBoundary("ensure-main", error); });
    mainHead = defaultHead;
    receipts.push(receipt("ensure-main", "main", "applied", `Created canonical main from the observed ${defaultBranch} head without deleting or rewriting any ref.`));
  } else {
    receipts.push(receipt("ensure-main", "main", "current", "Canonical release branch exists."));
  }
  if (!mainHead) throw new SetupOwnerActionRequired("ensure-main", "Canonical main head remains unobservable after bootstrap.");

  if (defaultBranch !== "main") {
    await github.request("PATCH /repos/{owner}/{repo}", { ...repository, default_branch: "main" })
      .catch((error) => { throw wrapOwnerBoundary("default-branch", error); });
    const verifiedDefault = record((await github.request("GET /repos/{owner}/{repo}", { ...repository })).data, "repository metadata after default-branch repair");
    if (verifiedDefault.default_branch !== "main") {
      throw new SetupOwnerActionRequired("default-branch-verification", "GitHub accepted the default-branch repair but main did not become observable as default.");
    }
    defaultBranch = "main";
    receipts.push(receipt("default-branch", "main", "applied", "Set main as default after preserving the prior default ref."));
  } else {
    receipts.push(receipt("default-branch", "main", "current", "Main is already the default branch."));
  }

  const devHead = await optionalRefHead(github, repository, "dev");
  if (devHead) {
    receipts.push(receipt("ensure-dev", "dev", "current", "Integration branch exists."));
  } else {
    await github.request("POST /repos/{owner}/{repo}/git/refs", {
      ...repository,
      ref: "refs/heads/dev",
      sha: mainHead
    }).catch((error) => { throw wrapOwnerBoundary("ensure-dev", error); });
    receipts.push(receipt("ensure-dev", "dev", "applied", "Created dev from the exact observed main head."));
  }

  const autoMerge = await observeAutoMerge(github, repository, metadata.allow_auto_merge);
  const deleteOnMerge = typeof metadata.delete_branch_on_merge === "boolean" ? metadata.delete_branch_on_merge : null;
  if (autoMerge === null || deleteOnMerge === null) {
    throw new SetupOwnerActionRequired("repository-automation-observation", "Repository automation settings are permission-omitted or unobservable; setup refused to infer drift or generate an automatic repair.");
  }
  if (autoMerge && deleteOnMerge) {
    receipts.push(receipt("repository-automation", `${repository.owner}/${repository.repo}`, "current", "Auto-merge and merged-branch deletion are enabled."));
  } else {
    await github.request("PATCH /repos/{owner}/{repo}", {
      ...repository,
      allow_auto_merge: true,
      delete_branch_on_merge: true
    }).catch((error) => { throw wrapOwnerBoundary("repository-automation", error); });
    const verified = record((await github.request("GET /repos/{owner}/{repo}", { ...repository })).data, "repository metadata after automation repair");
    const verifiedAutoMerge = await observeAutoMerge(github, repository, verified.allow_auto_merge);
    if (verifiedAutoMerge !== true || verified.delete_branch_on_merge !== true) {
      throw new SetupOwnerActionRequired("repository-automation-verification", "Repository automation repair did not become fully observable and enabled; setup stopped without assuming success.");
    }
    receipts.push(receipt("repository-automation", `${repository.owner}/${repository.repo}`, "applied", "Enabled auto-merge and merged-branch deletion."));
  }

  receipts.push(...await convergeLabels(github, repository, labels));
  receipts.push(...await enableManagedWorkflows(github, repository, managedWorkflowPaths));
  for (const branch of ["main", "dev"]) {
    receipts.push(await convergeBranchProtection(github, repository, branch));
  }
  return receipts;
}

async function observeAutoMerge(
  github: OperatorGitHubRequester,
  repository: RepositoryRef,
  restValue: unknown
): Promise<boolean | null> {
  if (typeof restValue === "boolean") return restValue;
  if (typeof github.graphql !== "function") return null;
  try {
    const response = record(await github.graphql(
      `query RepositoryAutoMerge($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) { autoMergeAllowed }
      }`,
      { owner: repository.owner, name: repository.repo }
    ), "repository auto-merge GraphQL response");
    const value = record(response.repository, "repository auto-merge GraphQL repository").autoMergeAllowed;
    return typeof value === "boolean" ? value : null;
  } catch {
    return null;
  }
}

export async function convergeLabels(
  github: OperatorGitHubRequester,
  repository: RepositoryRef,
  desired: LabelDefinition[]
): Promise<SetupReceipt[]> {
  const current = await listPages(github, "GET /repos/{owner}/{repo}/labels", repository);
  const byName = new Map(current.map((item) => {
    const label = record(item, "repository label");
    return [text(label.name, "label name").toLowerCase(), label];
  }));
  const receipts: SetupReceipt[] = [];
  for (const label of [...desired].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!/^[0-9a-f]{6}$/i.test(label.color)) throw new Error(`label ${label.name} has an invalid color`);
    const existing = byName.get(label.name.toLowerCase());
    if (!existing) {
      await github.request("POST /repos/{owner}/{repo}/labels", { ...repository, ...label })
        .catch((error) => { throw wrapOwnerBoundary(`label:${label.name}`, error); });
      receipts.push(receipt("label", label.name, "applied", "Created from canonical taxonomy."));
      continue;
    }
    const same = String(existing.color || "").toLowerCase() === label.color.toLowerCase()
      && String(existing.description || "") === label.description;
    if (same) {
      receipts.push(receipt("label", label.name, "current", "Canonical taxonomy already matches."));
      continue;
    }
    await github.request("PATCH /repos/{owner}/{repo}/labels/{name}", {
      ...repository,
      name: text(existing.name, "label name"),
      new_name: label.name,
      color: label.color,
      description: label.description
    }).catch((error) => { throw wrapOwnerBoundary(`label:${label.name}`, error); });
    receipts.push(receipt("label", label.name, "applied", "Updated to canonical taxonomy."));
  }
  return receipts;
}

export async function enableManagedWorkflows(
  github: OperatorGitHubRequester,
  repository: RepositoryRef,
  managedWorkflowPaths: string[]
): Promise<SetupReceipt[]> {
  const response = record((await github.request("GET /repos/{owner}/{repo}/actions/workflows", {
    ...repository,
    per_page: 100,
    page: 1
  })).data, "workflow enumeration");
  if (!Array.isArray(response.workflows)) throw new Error("workflow enumeration is malformed or unobservable");
  const managed = new Set(managedWorkflowPaths);
  const receipts: SetupReceipt[] = [];
  for (const item of response.workflows) {
    const workflow = record(item, "workflow");
    const path = text(workflow.path, "workflow path");
    if (!managed.has(path)) continue;
    const id = workflow.id;
    if (typeof id !== "number" && typeof id !== "string") throw new Error(`workflow ${path} has an invalid ID`);
    if (workflow.state === "active") {
      receipts.push(receipt("workflow", path, "current", "Managed workflow is enabled."));
      continue;
    }
    await github.request("PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/enable", {
      ...repository,
      workflow_id: id
    }).catch((error) => { throw wrapOwnerBoundary(`workflow:${path}`, error); });
    receipts.push(receipt("workflow", path, "applied", "Enabled managed workflow."));
  }
  return receipts;
}

export async function convergeBranchProtection(
  github: OperatorGitHubRequester,
  repository: RepositoryRef,
  branch: string
): Promise<SetupReceipt> {
  let protection: Record<string, unknown> | null = null;
  try {
    protection = record((await github.request("GET /repos/{owner}/{repo}/branches/{branch}/protection", {
      ...repository,
      branch
    })).data, `branch protection ${branch}`);
  } catch (error) {
    if (!status(error, 404)) throw wrapOwnerBoundary(`protection:${branch}`, error);
  }

  const existingChecks = requiredChecks(protection?.required_status_checks);
  const reviewContext = existingChecks.find((check) => check.context === "DarkFactory Autoreview")
    ? "DarkFactory Autoreview"
    : existingChecks.find((check) => check.context === "Codex Review")
      ? "Codex Review"
      : "Codex Review";
  const desiredChecks = dedupeChecks([
    ...existingChecks,
    { context: "Validate", app_id: 15368 },
    { context: reviewContext, app_id: 15368 }
  ]);
  const currentSafe = protection
    && recordOrNull(protection.enforce_admins)?.enabled === true
    && recordOrNull(protection.allow_force_pushes)?.enabled === false
    && recordOrNull(protection.allow_deletions)?.enabled === false
    && recordOrNull(protection.required_status_checks)?.strict === true
    && desiredChecks.every((desired) => existingChecks.some((current) => current.context === desired.context && current.app_id === desired.app_id));
  if (currentSafe) return receipt("branch-protection", branch, "current", "Required gates and non-bypass controls match policy.");

  const payload: Record<string, unknown> = {
    ...repository,
    branch,
    required_status_checks: { strict: true, checks: desiredChecks },
    enforce_admins: true,
    required_pull_request_reviews: normalizePullRequestReviews(protection?.required_pull_request_reviews),
    restrictions: normalizeRestrictions(protection?.restrictions),
    required_linear_history: enabled(protection?.required_linear_history),
    allow_force_pushes: false,
    allow_deletions: false,
    block_creations: enabled(protection?.block_creations),
    required_conversation_resolution: enabled(protection?.required_conversation_resolution),
    lock_branch: enabled(protection?.lock_branch),
    allow_fork_syncing: enabled(protection?.allow_fork_syncing)
  };
  await github.request("PUT /repos/{owner}/{repo}/branches/{branch}/protection", payload)
    .catch((error) => { throw wrapOwnerBoundary(`protection:${branch}`, error); });
  const verified = record((await github.request("GET /repos/{owner}/{repo}/branches/{branch}/protection", {
    ...repository,
    branch
  })).data, `branch protection ${branch} after repair`);
  const verifiedChecks = requiredChecks(verified.required_status_checks);
  const verifiedSafe = recordOrNull(verified.enforce_admins)?.enabled === true
    && recordOrNull(verified.allow_force_pushes)?.enabled === false
    && recordOrNull(verified.allow_deletions)?.enabled === false
    && recordOrNull(verified.required_status_checks)?.strict === true
    && verifiedChecks.length === desiredChecks.length
    && desiredChecks.every((desired) => verifiedChecks.some((current) => current.context === desired.context && current.app_id === desired.app_id));
  if (!verifiedSafe) {
    throw new SetupOwnerActionRequired(`protection:${branch}:verification`, "Branch-protection repair did not become fully observable with exact app-bound gates and non-bypass controls.");
  }
  return receipt("branch-protection", branch, "applied", "Converged required app-bound gates, strict updates, admin enforcement, and deletion/force-push denial while preserving observable review/restriction settings.");
}

async function optionalRefHead(
  github: OperatorGitHubRequester,
  repository: RepositoryRef,
  branch: string
): Promise<string | null> {
  try {
    const ref = record((await github.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
      ...repository,
      ref: `heads/${branch}`
    })).data, `branch ref ${branch}`);
    return text(record(ref.object, `branch ref ${branch} object`).sha, `branch ref ${branch} head`);
  } catch (error) {
    if (status(error, 404) || status(error, 409)) return null;
    throw wrapOwnerBoundary(`observe-branch:${branch}`, error);
  }
}

async function initializeEmptyMain(github: OperatorGitHubRequester, repository: RepositoryRef): Promise<string> {
  const tree = record((await github.request("POST /repos/{owner}/{repo}/git/trees", {
    ...repository,
    tree: []
  })).data, "empty bootstrap tree");
  const treeSha = text(tree.sha, "empty bootstrap tree sha");
  const commit = record((await github.request("POST /repos/{owner}/{repo}/git/commits", {
    ...repository,
    message: "Initialize managed repository",
    tree: treeSha,
    parents: []
  })).data, "empty bootstrap commit");
  const commitSha = text(commit.sha, "empty bootstrap commit sha");
  await github.request("POST /repos/{owner}/{repo}/git/refs", {
    ...repository,
    ref: "refs/heads/main",
    sha: commitSha
  }).catch((error) => { throw wrapOwnerBoundary("initialize-main", error); });
  const verified = await optionalRefHead(github, repository, "main");
  if (verified !== commitSha) throw new SetupOwnerActionRequired("initialize-main-verification", "The initial main ref did not match its exact admitted bootstrap commit.");
  return commitSha;
}

function requiredChecks(value: unknown): Array<{ context: string; app_id: number | null }> {
  const statusChecks = recordOrNull(value);
  if (!statusChecks) return [];
  const raw = Array.isArray(statusChecks.checks)
    ? statusChecks.checks
    : Array.isArray(statusChecks.contexts)
      ? statusChecks.contexts.map((context) => ({ context, app_id: null }))
      : [];
  return raw.map((item) => {
    const check = typeof item === "string" ? { context: item, app_id: null } : record(item, "required check");
    return {
      context: text(check.context, "required check context"),
      app_id: typeof check.app_id === "number" ? check.app_id : null
    };
  });
}

function dedupeChecks(checks: Array<{ context: string; app_id: number | null }>): Array<{ context: string; app_id: number | null }> {
  const byContext = new Map<string, { context: string; app_id: number | null }>();
  for (const check of checks) byContext.set(check.context, check);
  return [...byContext.values()].sort((a, b) => a.context.localeCompare(b.context));
}

function normalizePullRequestReviews(value: unknown): Record<string, unknown> | null {
  const reviews = recordOrNull(value);
  if (!reviews) return null;
  const bypass = recordOrNull(reviews.bypass_pull_request_allowances);
  return {
    dismissal_restrictions: normalizeRestrictions(reviews.dismissal_restrictions),
    dismiss_stale_reviews: Boolean(reviews.dismiss_stale_reviews),
    require_code_owner_reviews: Boolean(reviews.require_code_owner_reviews),
    required_approving_review_count: Number.isInteger(reviews.required_approving_review_count) ? reviews.required_approving_review_count : 0,
    require_last_push_approval: Boolean(reviews.require_last_push_approval),
    bypass_pull_request_allowances: bypass ? normalizeRestrictions(bypass) : undefined
  };
}

function normalizeRestrictions(value: unknown): Record<string, string[]> | null {
  const restrictions = recordOrNull(value);
  if (!restrictions) return null;
  return {
    users: identifiers(restrictions.users, "login"),
    teams: identifiers(restrictions.teams, "slug"),
    apps: identifiers(restrictions.apps, "slug")
  };
}

function identifiers(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => text(record(item, "restriction")[key], `restriction ${key}`)).sort();
}

function enabled(value: unknown): boolean {
  return recordOrNull(value)?.enabled === true;
}

function receipt(action: string, target: string, statusValue: SetupReceipt["status"], detail: string): SetupReceipt {
  return { action, target, status: statusValue, detail };
}

function wrapOwnerBoundary(action: string, error: unknown): Error {
  if (status(error, 401) || status(error, 403)) {
    return new SetupOwnerActionRequired(action, `GitHub App lacks authority for ${action}; install or grant the exact required permission.`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

async function listPages(github: OperatorGitHubRequester, route: string, repository: RepositoryRef): Promise<unknown[]> {
  const values: unknown[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const response = await github.request(route, { ...repository, per_page: 100, page });
    if (!Array.isArray(response.data)) throw new Error(`${route} returned malformed pagination data`);
    values.push(...response.data);
    if (response.data.length < 100) return values;
  }
  throw new Error(`${route} exceeded the bounded 2000-record window`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  const result = recordOrNull(value);
  if (!result) throw new Error(`${label} is malformed or unobservable`);
  return result;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} is malformed or unobservable`);
  return value;
}

function status(error: unknown, expected: number): boolean {
  return Boolean(error && typeof error === "object" && "status" in error && (error as { status?: number }).status === expected);
}
