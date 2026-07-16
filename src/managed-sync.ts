import { createHash } from "node:crypto";

import {
  GITHUB_BOOTSTRAP_WORKFLOW_PATH,
  readManagedFiles,
  removedManagedFilePaths,
  type ManagedFile
} from "./managed-files.js";

export const MANAGED_SETUP_BRANCH = "dark-factory/managed-repository-setup";
export const MANAGED_SETUP_COMMENT_MARKER = "<!-- dark-factory:managed-setup-pr -->";
export const MANAGED_SETUP_TITLE = "Update Dark Factory managed repository setup";
const MANAGED_SETUP_PROVENANCE_PREFIX = "<!-- dark-factory:managed-setup-provenance";
const FORBIDDEN_MANAGED_ROOTS = [".agents/.global"] as const;
export const DARK_FACTORY_CONTROL_REPOSITORY = {
  owner: "marius-patrik",
  repo: "DarkFactory"
} as const;
export const REPOSITORY_OWNED_RELEASE_CONTROLS = new Set([
  ".darkfactory/release-policy.json",
  ".github/scripts/df-release.mjs",
  ".github/workflows/df-release.yml"
]);

export class ManagedSourcePolicyContradiction extends Error {
  constructor(paths: string[]) {
    super(`Canonical managed source attempts to remove repository-owned DarkFactory release controls: ${paths.sort().join(", ")}. Reconcile source policy before managed sync.`);
    this.name = "ManagedSourcePolicyContradiction";
  }
}

export class ManagedSetupTrustViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedSetupTrustViolation";
  }
}

export interface GitHubRequester {
  request(route: string, parameters: Record<string, unknown>): Promise<{ data: unknown }>;
}

export interface ManagedRepository {
  owner: string;
  repo: string;
  defaultBranch?: string;
  archived?: boolean;
}

export interface ManagedSetupSyncResult {
  owner: string;
  repo: string;
  status: "skipped" | "current" | "created" | "updated";
  changedPaths: string[];
  pullRequestUrl?: string;
  reason?: string;
}

export interface ManagedSetupProvenance {
  schemaVersion: 1;
  baseBranch: string;
  baseSha: string;
  headSha: string;
  treeSha: string;
  changedPathsDigest: string;
}

interface PreparedManagedSetupPlan {
  baseBranch: string;
  baseSha: string;
  expectedTreeSha: string;
  changedFiles: ManagedFile[];
  forbiddenFiles: ForbiddenManagedFile[];
  changedPaths: string[];
}

export function orderManagedRepositoriesForSync<T>(
  items: readonly T[],
  getRepository: (item: T) => Pick<ManagedRepository, "owner" | "repo">,
  controlRepository: Pick<ManagedRepository, "owner" | "repo"> = DARK_FACTORY_CONTROL_REPOSITORY
): T[] {
  const controlKey = repositoryKey(controlRepository);
  const seen = new Set<string>();
  const uniqueItems: T[] = [];

  for (const item of items) {
    const key = repositoryKey(getRepository(item));
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueItems.push(item);
  }

  return uniqueItems.sort((left, right) => {
    const leftIsControl = repositoryKey(getRepository(left)) === controlKey;
    const rightIsControl = repositoryKey(getRepository(right)) === controlKey;

    if (leftIsControl === rightIsControl) return 0;
    return leftIsControl ? -1 : 1;
  });
}

export async function ensureManagedRepositorySetup(
  github: GitHubRequester,
  repository: ManagedRepository,
  files?: ManagedFile[]
): Promise<ManagedSetupSyncResult> {
  if (repository.archived) {
    return baseResult(repository, "skipped", [], "Repository is archived.");
  }

  const managedFiles = files ?? readManagedFiles(repository);
  const removedPaths = removedManagedFilePaths(managedFiles);
  if (repositoryKey(repository) === repositoryKey(DARK_FACTORY_CONTROL_REPOSITORY)) {
    const contradictions = [...removedPaths].filter((path) => REPOSITORY_OWNED_RELEASE_CONTROLS.has(path));
    if (contradictions.length > 0) throw new ManagedSourcePolicyContradiction(contradictions);
  }
  const repoInfo = await getRepositoryInfo(github, repository);

  if (repoInfo.archived) {
    return baseResult(repository, "skipped", [], "Repository is archived.");
  }

  const plan = await prepareManagedSetupPlan(
    github,
    repository,
    repoInfo.defaultBranch,
    managedFiles,
    removedPaths
  );
  const setupRef = await getOptionalRef(github, repository, `heads/${MANAGED_SETUP_BRANCH}`);

  if (plan.changedPaths.length === 0) {
    if (setupRef && setupRef.sha !== plan.baseSha) {
      throw new ManagedSetupTrustViolation(
        `Managed setup branch ${MANAGED_SETUP_BRANCH} exists while the canonical base is already current; preserved the unexplained branch and blocked adoption.`
      );
    }
    return baseResult(repository, "current", []);
  }

  let headSha: string;

  if (setupRef) {
    const setupCommit = await getCommit(github, repository, setupRef.sha);
    if (
      setupCommit.treeSha !== plan.expectedTreeSha
      || !setupCommit.parents
      || setupCommit.parents.length !== 1
      || setupCommit.parents[0] !== plan.baseSha
    ) {
      throw new ManagedSetupTrustViolation(
        `Managed setup branch ${MANAGED_SETUP_BRANCH} is not the exact canonical one-commit plan on ${plan.baseSha}; preserved existing branch work and blocked adoption.`
      );
    }
    await assertManagedSetupHeadOwnedByApp(github, repository, setupRef.sha);
    headSha = setupRef.sha;
  } else {
    const commit = await createCommit(github, repository, plan.baseSha, plan.expectedTreeSha);
    await github.request("POST /repos/{owner}/{repo}/git/refs", {
      owner: repository.owner,
      repo: repository.repo,
      ref: `refs/heads/${MANAGED_SETUP_BRANCH}`,
      sha: commit.sha
    });
    headSha = commit.sha;
  }

  const provenance = managedSetupProvenance(plan, headSha);

  const existingPr = await findExistingPullRequest(github, repository, repoInfo.defaultBranch);

  if (existingPr) {
    const pull = await github.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner: repository.owner,
      repo: repository.repo,
      pull_number: existingPr.number
    });
    await assertManagedSetupPullRequest(github, repository, pull.data, plan);
    return {
      ...baseResult(repository, "updated", plan.changedPaths),
      pullRequestUrl: existingPr.url
    };
  }

  const pullRequest = await createPullRequest(
    github,
    repository,
    repoInfo.defaultBranch,
    plan.changedPaths,
    provenance
  );

  return {
    ...baseResult(repository, "created", plan.changedPaths),
    pullRequestUrl: pullRequest.url
  };
}

function baseResult(
  repository: ManagedRepository,
  status: ManagedSetupSyncResult["status"],
  changedPaths: string[],
  reason?: string
): ManagedSetupSyncResult {
  return {
    owner: repository.owner,
    repo: repository.repo,
    status,
    changedPaths,
    reason
  };
}

function repositoryKey(repository: Pick<ManagedRepository, "owner" | "repo">): string {
  return `${repository.owner.toLowerCase()}/${repository.repo.toLowerCase()}`;
}

async function getRepositoryInfo(
  github: GitHubRequester,
  repository: ManagedRepository
): Promise<{ defaultBranch: string; archived: boolean }> {
  if (repository.defaultBranch && typeof repository.archived === "boolean") {
    return {
      defaultBranch: repository.defaultBranch,
      archived: repository.archived
    };
  }

  const response = await github.request("GET /repos/{owner}/{repo}", {
    owner: repository.owner,
    repo: repository.repo
  });

  if (!isRecord(response.data)) {
    throw new Error("GitHub returned an invalid repository response");
  }

  const defaultBranch = response.data.default_branch;
  const archived = response.data.archived;

  if (typeof defaultBranch !== "string" || typeof archived !== "boolean") {
    throw new Error("GitHub repository response is missing default branch or archived state");
  }

  return { defaultBranch, archived };
}

async function prepareManagedSetupPlan(
  github: GitHubRequester,
  repository: ManagedRepository,
  baseBranch: string,
  managedFiles: ManagedFile[],
  removedPaths: ReadonlySet<string>
): Promise<PreparedManagedSetupPlan> {
  const baseRef = await getRef(github, repository, `heads/${baseBranch}`);
  const changedFiles = await changedManagedFiles(github, repository, baseRef.sha, managedFiles);
  const baseCommit = await getCommit(github, repository, baseRef.sha);
  const forbiddenFiles = await findForbiddenManagedFiles(
    github,
    repository,
    baseCommit.treeSha,
    removedPaths
  );
  const changedPaths = [
    ...changedFiles.map((file) => file.path),
    ...forbiddenFiles.map((file) => file.path)
  ];
  const expectedTreeSha = changedPaths.length === 0
    ? baseCommit.treeSha
    : (await createTree(github, repository, baseCommit.treeSha, changedFiles, forbiddenFiles)).sha;

  return {
    baseBranch,
    baseSha: baseRef.sha,
    expectedTreeSha,
    changedFiles,
    forbiddenFiles,
    changedPaths
  };
}

function managedSetupProvenance(
  plan: Pick<PreparedManagedSetupPlan, "baseBranch" | "baseSha" | "expectedTreeSha" | "changedPaths">,
  headSha: string
): ManagedSetupProvenance {
  return {
    schemaVersion: 1,
    baseBranch: plan.baseBranch,
    baseSha: plan.baseSha,
    headSha,
    treeSha: plan.expectedTreeSha,
    changedPathsDigest: createHash("sha256")
      .update(JSON.stringify([...plan.changedPaths].sort()))
      .digest("hex")
  };
}

export function managedSetupProvenanceMarker(provenance: ManagedSetupProvenance): string {
  return `${MANAGED_SETUP_PROVENANCE_PREFIX} schema=${provenance.schemaVersion} base-branch=${provenance.baseBranch} base=${provenance.baseSha} head=${provenance.headSha} tree=${provenance.treeSha} paths-sha256=${provenance.changedPathsDigest} -->`;
}

export async function verifyManagedSetupPullRequest(
  github: GitHubRequester,
  repository: ManagedRepository,
  pullRequest: unknown,
  files?: ManagedFile[]
): Promise<void> {
  const repoInfo = await getRepositoryInfo(github, repository);
  if (repoInfo.archived) {
    throw new ManagedSetupTrustViolation("Managed setup pull request targets an archived repository.");
  }
  if (repoInfo.defaultBranch !== "main") {
    throw new ManagedSetupTrustViolation("Managed setup bootstrap requires canonical main to be the exact default branch.");
  }
  const managedFiles = files ?? readManagedFiles(repository);
  const plan = await prepareManagedSetupPlan(
    github,
    repository,
    repoInfo.defaultBranch,
    managedFiles,
    removedManagedFilePaths(managedFiles)
  );
  await assertManagedSetupPullRequest(github, repository, pullRequest, plan);
}

async function getOptionalRef(
  github: GitHubRequester,
  repository: ManagedRepository,
  ref: string
): Promise<{ sha: string } | null> {
  try {
    return await getRef(github, repository, ref);
  } catch (error) {
    if (isRequestError(error) && error.status === 404) {
      return null;
    }

    throw error;
  }
}

async function getRef(
  github: GitHubRequester,
  repository: ManagedRepository,
  ref: string
): Promise<{ sha: string }> {
  const response = await github.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
    owner: repository.owner,
    repo: repository.repo,
    ref
  });

  if (!isRecord(response.data) || !isRecord(response.data.object) || typeof response.data.object.sha !== "string") {
    throw new Error(`GitHub returned an invalid ref response for ${ref}`);
  }

  return { sha: response.data.object.sha };
}

async function changedManagedFiles(
  github: GitHubRequester,
  repository: ManagedRepository,
  ref: string,
  files: ManagedFile[]
): Promise<ManagedFile[]> {
  const changed: ManagedFile[] = [];

  for (const file of files) {
    const existing = await getOptionalFileContent(github, repository, file.path, ref);

    if (existing !== file.content) {
      changed.push(file);
    }
  }

  return changed;
}

async function getOptionalFileContent(
  github: GitHubRequester,
  repository: ManagedRepository,
  path: string,
  ref: string
): Promise<string | null> {
  try {
    const response = await github.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner: repository.owner,
      repo: repository.repo,
      path,
      ref
    });

    return decodeContentResponse(response.data);
  } catch (error) {
    if (isRequestError(error) && error.status === 404) {
      return null;
    }

    throw error;
  }
}

async function getCommit(
  github: GitHubRequester,
  repository: ManagedRepository,
  sha: string
): Promise<{ treeSha: string; parents: string[] | null }> {
  const response = await github.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
    owner: repository.owner,
    repo: repository.repo,
    commit_sha: sha
  });

  if (!isRecord(response.data) || !isRecord(response.data.tree) || typeof response.data.tree.sha !== "string") {
    throw new Error("GitHub returned an invalid commit response");
  }

  const parents = Array.isArray(response.data.parents)
    ? response.data.parents.map((parent) => isRecord(parent) && typeof parent.sha === "string" ? parent.sha : null)
    : null;
  if (parents?.some((parent) => parent === null)) {
    throw new Error("GitHub returned invalid commit parent evidence");
  }

  return { treeSha: response.data.tree.sha, parents: parents as string[] | null };
}

interface ForbiddenManagedFile {
  path: string;
  mode: string;
  type: "blob";
}

async function findForbiddenManagedFiles(
  github: GitHubRequester,
  repository: ManagedRepository,
  treeSha: string,
  removedFiles: ReadonlySet<string>
): Promise<ForbiddenManagedFile[]> {
  const response = await github.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
    owner: repository.owner,
    repo: repository.repo,
    tree_sha: treeSha,
    recursive: "1"
  });

  if (!isRecord(response.data) || !Array.isArray(response.data.tree) || response.data.truncated === true) {
    throw new Error("GitHub returned an incomplete repository tree while checking forbidden managed paths");
  }

  return response.data.tree.flatMap((entry) => {
    if (
      !isRecord(entry) ||
      entry.type !== "blob" ||
      typeof entry.path !== "string" ||
      typeof entry.mode !== "string"
    ) {
      return [];
    }
    const entryPath = entry.path;
    const isForbiddenRoot = FORBIDDEN_MANAGED_ROOTS.some(
      (root) => entryPath === root || entryPath.startsWith(`${root}/`)
    );
    if (!isForbiddenRoot && !removedFiles.has(entryPath)) return [];
    return [{ path: entryPath, mode: entry.mode, type: "blob" as const }];
  });
}

async function createTree(
  github: GitHubRequester,
  repository: ManagedRepository,
  baseTree: string,
  files: ManagedFile[],
  forbiddenFiles: ForbiddenManagedFile[]
): Promise<{ sha: string }> {
  const response = await github.request("POST /repos/{owner}/{repo}/git/trees", {
    owner: repository.owner,
    repo: repository.repo,
    base_tree: baseTree,
    tree: [
      ...files.map((file) => ({
        path: file.path,
        mode: "100644",
        type: "blob",
        content: file.content
      })),
      ...forbiddenFiles.map((file) => ({
        path: file.path,
        mode: file.mode,
        type: file.type,
        sha: null
      }))
    ]
  });

  if (!isRecord(response.data) || typeof response.data.sha !== "string") {
    throw new Error("GitHub returned an invalid tree response");
  }

  return { sha: response.data.sha };
}

async function createCommit(
  github: GitHubRequester,
  repository: ManagedRepository,
  parentSha: string,
  treeSha: string
): Promise<{ sha: string }> {
  const response = await github.request("POST /repos/{owner}/{repo}/git/commits", {
    owner: repository.owner,
    repo: repository.repo,
    message: "Update Dark Factory managed repository setup",
    tree: treeSha,
    parents: [parentSha]
  });

  if (!isRecord(response.data) || typeof response.data.sha !== "string") {
    throw new Error("GitHub returned an invalid commit response");
  }

  return { sha: response.data.sha };
}

async function expectedManagedSetupActor(
  github: GitHubRequester
): Promise<{ login: string; appId: number }> {
  const installation = await github.request("GET /installation", {});
  if (!isRecord(installation.data)) {
    throw new ManagedSetupTrustViolation("GitHub returned invalid installation provenance for managed setup.");
  }
  const appSlug = installation.data.app_slug;
  const appId = installation.data.app_id;
  if (typeof appSlug !== "string" || !appSlug.trim() || typeof appId !== "number" || !Number.isInteger(appId) || appId <= 0) {
    throw new ManagedSetupTrustViolation("GitHub installation provenance is missing the exact App identity.");
  }
  return { login: `${appSlug}[bot]`, appId };
}

async function assertManagedSetupHeadOwnedByApp(
  github: GitHubRequester,
  repository: ManagedRepository,
  headSha: string,
  expectedActor?: { login: string; appId: number }
): Promise<void> {
  const actor = expectedActor ?? await expectedManagedSetupActor(github);
  const response = await github.request("GET /repos/{owner}/{repo}/commits/{ref}", {
    owner: repository.owner,
    repo: repository.repo,
    ref: headSha
  });
  if (!isRecord(response.data) || !isRecord(response.data.author)) {
    throw new ManagedSetupTrustViolation("Managed setup head is missing App author provenance.");
  }
  const author = response.data.author;
  if (
    typeof author.login !== "string"
    || author.login.toLowerCase() !== actor.login.toLowerCase()
    || author.type !== "Bot"
  ) {
    throw new ManagedSetupTrustViolation(`Managed setup head ${headSha} is not owned by the expected GitHub App.`);
  }
}

async function assertManagedSetupPullRequest(
  github: GitHubRequester,
  repository: ManagedRepository,
  pullRequest: unknown,
  plan: PreparedManagedSetupPlan
): Promise<void> {
  if (plan.changedPaths.length === 0) {
    throw new ManagedSetupTrustViolation("Managed setup pull request has no canonical managed-only change to admit.");
  }
  const pull = isRecord(pullRequest) ? pullRequest : null;
  if (!pull) throw new ManagedSetupTrustViolation("GitHub returned invalid managed setup pull request evidence.");
  const base = isRecord(pull.base) ? pull.base : null;
  const head = isRecord(pull.head) ? pull.head : null;
  const user = isRecord(pull.user) ? pull.user : null;
  const baseRepository = base && isRecord(base.repo) ? base.repo : null;
  const headRepository = head && isRecord(head.repo) ? head.repo : null;
  const actor = await expectedManagedSetupActor(github);
  const repositoryName = `${repository.owner}/${repository.repo}`.toLowerCase();
  const headSha = head?.sha;
  const provenance = typeof headSha === "string" ? managedSetupProvenance(plan, headSha) : null;
  const expectedMarker = provenance ? managedSetupProvenanceMarker(provenance) : null;
  const body = typeof pull.body === "string" ? pull.body : "";
  const provenanceMarkers = body.match(/<!-- dark-factory:managed-setup-provenance\b[^>]*-->/g) ?? [];

  if (
    pull.state !== "open"
    || pull.draft !== false
    || pull.title !== MANAGED_SETUP_TITLE
    || pull.commits !== 1
    || base?.ref !== plan.baseBranch
    || base?.sha !== plan.baseSha
    || String(baseRepository?.full_name || "").toLowerCase() !== repositoryName
    || head?.ref !== MANAGED_SETUP_BRANCH
    || typeof headSha !== "string"
    || String(headRepository?.full_name || "").toLowerCase() !== repositoryName
    || typeof user?.login !== "string"
    || user.login.toLowerCase() !== actor.login.toLowerCase()
    || user.type !== "Bot"
    || body.split(MANAGED_SETUP_COMMENT_MARKER).length !== 2
    || provenanceMarkers.length !== 1
    || provenanceMarkers[0] !== expectedMarker
  ) {
    throw new ManagedSetupTrustViolation("Managed setup pull request is not the exact expected App-owned target, head, parent, and provenance plan.");
  }

  const commit = await getCommit(github, repository, headSha);
  if (
    commit.treeSha !== plan.expectedTreeSha
    || !commit.parents
    || commit.parents.length !== 1
    || commit.parents[0] !== plan.baseSha
  ) {
    throw new ManagedSetupTrustViolation("Managed setup pull request head is not the exact canonical managed-only one-commit diff.");
  }
  await assertManagedSetupHeadOwnedByApp(github, repository, headSha, actor);
}

async function findExistingPullRequest(
  github: GitHubRequester,
  repository: ManagedRepository,
  base: string
): Promise<{ url: string; number: number } | null> {
  const response = await github.request("GET /repos/{owner}/{repo}/pulls", {
    owner: repository.owner,
    repo: repository.repo,
    state: "open",
    head: `${repository.owner}:${MANAGED_SETUP_BRANCH}`,
    base
  });

  if (!Array.isArray(response.data)) {
    throw new Error("GitHub returned an invalid pull request list response");
  }

  if (response.data.length === 0) return null;
  if (response.data.length !== 1) {
    throw new ManagedSetupTrustViolation("GitHub returned multiple open managed setup pull requests for one exact branch.");
  }
  const first = response.data[0];
  if (!isRecord(first) || typeof first.html_url !== "string" || typeof first.number !== "number") {
    throw new ManagedSetupTrustViolation("GitHub returned malformed managed setup pull request identity evidence.");
  }

  return { url: first.html_url, number: first.number };
}

async function createPullRequest(
  github: GitHubRequester,
  repository: ManagedRepository,
  base: string,
  changedPaths: string[],
  provenance: ManagedSetupProvenance
): Promise<{ url: string }> {
  const response = await github.request("POST /repos/{owner}/{repo}/pulls", {
    owner: repository.owner,
    repo: repository.repo,
    title: MANAGED_SETUP_TITLE,
    head: MANAGED_SETUP_BRANCH,
    base,
    body: managedSetupPullRequestBody(changedPaths, provenance)
  });

  if (!isRecord(response.data) || typeof response.data.html_url !== "string") {
    throw new Error("GitHub returned an invalid pull request response");
  }

  return { url: response.data.html_url };
}

export function managedSetupPullRequestBody(
  changedPaths: string[],
  provenance?: ManagedSetupProvenance
): string {
  const paths = changedPaths.map((path) => `- \`${path}\``).join("\n");

  return [
    MANAGED_SETUP_COMMENT_MARKER,
    ...(provenance ? [managedSetupProvenanceMarker(provenance)] : []),
    "## Summary",
    "",
    "Dark Factory is installing or updating managed repository setup files.",
    "",
    paths,
    "",
    "## Notes",
    "",
    "- Shared Agent OS identity, memory, roles, skills, provider state, and sessions remain under `$AGENTS_HOME`; DarkFactory never copies them into repositories.",
    "- `.agents/.project` is managed only when a repo-specific canonical Andromeda-data overlay exists.",
    "- `AGENTS.md` is the repository entrypoint into project-local context and `$AGENTS_HOME`.",
    "- `.darkfactory` policy files define labels, branching, installer, and orchestration behavior.",
    "- `.github/workflows/ci.yml` provides the managed validation baseline.",
    `- \`${GITHUB_BOOTSTRAP_WORKFLOW_PATH}\` is bootstrap-managed so repositories have a safe baseline workflow.`,
    "- `.github/workflows/dark-factory-autoupdate.yml` verifies managed setup on a schedule while DarkFactory performs centralized sync.",
    "- `.github/workflows/darkfactory-autoreview.yml` runs bounded medium review-to-clean and independent high confirmation only through canonical Agent OS on the trusted runner."
  ].join("\n");
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
