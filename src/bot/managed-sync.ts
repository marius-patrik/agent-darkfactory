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
  ".agents/release-policy.json",
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

interface ManagedSetupPullAdmission {
  provenancePlan: PreparedManagedSetupPlan;
  provenanceHeadSha: string;
  allowLegacyProvenance: boolean;
}

interface ManagedSetupBranchConvergence {
  headSha: string;
  pullAdmission: ManagedSetupPullAdmission | null;
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
  const existingPr = setupRef
    ? await findExistingPullRequest(github, repository, repoInfo.defaultBranch)
    : null;
  let existingPull = existingPr
    ? (await github.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner: repository.owner,
      repo: repository.repo,
      pull_number: existingPr.number
    })).data
    : null;

  if (plan.changedPaths.length === 0) {
    if (setupRef && setupRef.sha !== plan.baseSha) {
      throw new ManagedSetupTrustViolation(
        `Managed setup branch ${MANAGED_SETUP_BRANCH} exists while the canonical base is already current; preserved the unexplained branch and blocked adoption.`
      );
    }
    return baseResult(repository, "current", []);
  }

  let headSha: string;
  let pullAdmission: ManagedSetupPullAdmission | null = null;

  if (setupRef) {
    const convergence = await convergeExistingManagedSetupBranch(
      github,
      repository,
      setupRef.sha,
      plan,
      managedFiles,
      removedPaths,
      existingPull
    );
    headSha = convergence.headSha;
    pullAdmission = convergence.pullAdmission;
  } else {
    const commit = await createCommit(github, repository, [plan.baseSha], plan.expectedTreeSha);
    await github.request("POST /repos/{owner}/{repo}/git/refs", {
      owner: repository.owner,
      repo: repository.repo,
      ref: `refs/heads/${MANAGED_SETUP_BRANCH}`,
      sha: commit.sha
    });
    headSha = commit.sha;
  }

  const provenance = managedSetupProvenance(plan, headSha);

  if (existingPr) {
    if (!pullAdmission || !isRecord(existingPull) || typeof existingPull.body !== "string") {
      throw new ManagedSetupTrustViolation("Managed setup recovery is missing its exact admitted pull request state.");
    }
    const admittedBody = existingPull.body;
    existingPull = (await github.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner: repository.owner,
      repo: repository.repo,
      pull_number: existingPr.number
    })).data;
    const currentBody = isRecord(existingPull) && typeof existingPull.body === "string" ? existingPull.body : null;
    if (currentBody === null || currentBody !== admittedBody) {
      throw new ManagedSetupTrustViolation("Managed setup pull request body changed after admission; preserved the concurrent edit and blocked provenance update.");
    }
    await assertManagedSetupPullRequest(github, repository, existingPull, plan, {
      observedBaseSha: plan.baseSha,
      expectedHeadSha: headSha,
      provenancePlan: pullAdmission.provenancePlan,
      provenanceHeadSha: pullAdmission.provenanceHeadSha,
      allowLegacyProvenance: pullAdmission.allowLegacyProvenance
    });
    const nextBody = replaceManagedSetupProvenance(currentBody, provenance, plan.changedPaths);
    if (nextBody !== currentBody) {
      await github.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner: repository.owner,
        repo: repository.repo,
        pull_number: existingPr.number,
        body: nextBody
      });
    }
    existingPull = (await github.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner: repository.owner,
      repo: repository.repo,
      pull_number: existingPr.number
    })).data;
    await assertManagedSetupPullRequest(github, repository, existingPull, plan);
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
  return prepareManagedSetupPlanAtSha(
    github,
    repository,
    baseBranch,
    baseRef.sha,
    managedFiles,
    removedPaths
  );
}

async function prepareManagedSetupPlanAtSha(
  github: GitHubRequester,
  repository: ManagedRepository,
  baseBranch: string,
  baseSha: string,
  managedFiles: ManagedFile[],
  removedPaths: ReadonlySet<string>
): Promise<PreparedManagedSetupPlan> {
  const changedFiles = await changedManagedFiles(github, repository, baseSha, managedFiles);
  const baseCommit = await getCommit(github, repository, baseSha);
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
    baseSha,
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

function parseManagedSetupProvenance(body: unknown): ManagedSetupProvenance | null {
  if (typeof body !== "string") return null;
  const candidates = body.match(/<!-- dark-factory:managed-setup-provenance\b[^>]*-->/g) ?? [];
  if (candidates.length === 0) return null;
  if (candidates.length !== 1) {
    throw new ManagedSetupTrustViolation("Managed setup pull request contains ambiguous provenance markers.");
  }
  const match = /^<!-- dark-factory:managed-setup-provenance schema=1 base-branch=([A-Za-z0-9._/-]+) base=([0-9a-f]{40}) head=([0-9a-f]{40}) tree=([0-9a-f]{40}) paths-sha256=([0-9a-f]{64}) -->$/.exec(candidates[0]);
  if (!match) throw new ManagedSetupTrustViolation("Managed setup pull request provenance marker is malformed.");
  return {
    schemaVersion: 1,
    baseBranch: match[1],
    baseSha: match[2],
    headSha: match[3],
    treeSha: match[4],
    changedPathsDigest: match[5]
  };
}

function replaceManagedSetupProvenance(
  body: string,
  provenance: ManagedSetupProvenance,
  changedPaths: string[]
): string {
  const marker = managedSetupProvenanceMarker(provenance);
  const existing = body.match(/<!-- dark-factory:managed-setup-provenance\b[^>]*-->/g) ?? [];
  if (existing.length > 1) {
    throw new ManagedSetupTrustViolation("Managed setup pull request contains ambiguous provenance markers.");
  }
  if (existing.length === 1) return body.replace(existing[0], marker);
  if (body.split(MANAGED_SETUP_COMMENT_MARKER).length === 2) {
    return body.replace(MANAGED_SETUP_COMMENT_MARKER, `${MANAGED_SETUP_COMMENT_MARKER}\n${marker}`);
  }
  return managedSetupPullRequestBody(changedPaths, provenance);
}

async function convergeExistingManagedSetupBranch(
  github: GitHubRequester,
  repository: ManagedRepository,
  setupHead: string,
  currentPlan: PreparedManagedSetupPlan,
  managedFiles: ManagedFile[],
  removedPaths: ReadonlySet<string>,
  pullRequest: unknown
): Promise<ManagedSetupBranchConvergence> {
  try {
    await assertManagedSetupBranch(github, repository, setupHead, currentPlan);
    let allowLegacyProvenance = false;
    if (pullRequest) {
      try {
        await assertManagedSetupPullRequest(github, repository, pullRequest, currentPlan, {
          expectedHeadSha: setupHead
        });
      } catch (error) {
        if (!(error instanceof ManagedSetupTrustViolation) || parseManagedSetupProvenance(isRecord(pullRequest) ? pullRequest.body : null)) {
          throw error;
        }
        await assertManagedSetupPullRequest(github, repository, pullRequest, currentPlan, {
          expectedHeadSha: setupHead,
          allowLegacyProvenance: true
        });
        allowLegacyProvenance = true;
      }
    }
    return {
      headSha: setupHead,
      pullAdmission: pullRequest ? {
        provenancePlan: currentPlan,
        provenanceHeadSha: setupHead,
        allowLegacyProvenance
      } : null
    };
  } catch (error) {
    if (!(error instanceof ManagedSetupTrustViolation)) throw error;
  }

  const setupCommit = await getCommit(github, repository, setupHead);
  const priorProvenance = parseManagedSetupProvenance(isRecord(pullRequest) ? pullRequest.body : null);
  let admittedBaseSha: string;
  let pullAdmission: ManagedSetupPullAdmission | null = null;

  if (priorProvenance && priorProvenance.headSha !== setupHead) {
    if (
      priorProvenance.baseBranch !== currentPlan.baseBranch
      || !setupCommit.parents
      || setupCommit.parents.length !== 2
      || setupCommit.parents[0] !== priorProvenance.headSha
    ) {
      throw unknownManagedSetupRecoveryState();
    }
    const interruptedBaseSha = setupCommit.parents[1];
    const provenancePlan = await prepareManagedSetupPlanAtSha(
      github,
      repository,
      currentPlan.baseBranch,
      priorProvenance.baseSha,
      managedFiles,
      removedPaths
    );
    await assertManagedSetupBranch(github, repository, priorProvenance.headSha, provenancePlan);
    await assertManagedSetupBaseAdvance(github, repository, priorProvenance.baseSha, interruptedBaseSha);
    const interruptedPlan = await prepareManagedSetupPlanAtSha(
      github,
      repository,
      currentPlan.baseBranch,
      interruptedBaseSha,
      managedFiles,
      removedPaths
    );
    await assertManagedSetupBranch(github, repository, setupHead, interruptedPlan);
    if (pullRequest) {
      await assertManagedSetupPullRequest(github, repository, pullRequest, interruptedPlan, {
        observedBaseSha: currentPlan.baseSha,
        expectedHeadSha: setupHead,
        provenancePlan,
        provenanceHeadSha: priorProvenance.headSha
      });
    }
    admittedBaseSha = interruptedBaseSha;
    pullAdmission = pullRequest ? {
      provenancePlan,
      provenanceHeadSha: priorProvenance.headSha,
      allowLegacyProvenance: false
    } : null;
  } else {
    const priorBase = priorProvenance?.baseSha
      ?? (setupCommit.parents?.length === 1 ? setupCommit.parents[0] : null);
    if (
      !priorBase
      || priorBase === currentPlan.baseSha
      || (priorProvenance && priorProvenance.baseBranch !== currentPlan.baseBranch)
    ) {
      throw unknownManagedSetupRecoveryState();
    }
    const priorPlan = await prepareManagedSetupPlanAtSha(
      github,
      repository,
      currentPlan.baseBranch,
      priorBase,
      managedFiles,
      removedPaths
    );
    await assertManagedSetupBranch(github, repository, setupHead, priorPlan);
    if (pullRequest) {
      await assertManagedSetupPullRequest(github, repository, pullRequest, priorPlan, {
        observedBaseSha: currentPlan.baseSha,
        expectedHeadSha: setupHead,
        allowLegacyProvenance: priorProvenance === null
      });
    }
    admittedBaseSha = priorBase;
    pullAdmission = pullRequest ? {
      provenancePlan: priorPlan,
      provenanceHeadSha: setupHead,
      allowLegacyProvenance: priorProvenance === null
    } : null;
  }

  if (admittedBaseSha === currentPlan.baseSha) {
    return { headSha: setupHead, pullAdmission };
  }
  await assertManagedSetupBaseAdvance(github, repository, admittedBaseSha, currentPlan.baseSha);

  const admittedMain = await getRef(github, repository, `heads/${currentPlan.baseBranch}`);
  const admittedBranch = await getRef(github, repository, `heads/${MANAGED_SETUP_BRANCH}`);
  if (admittedMain.sha !== currentPlan.baseSha || admittedBranch.sha !== setupHead) {
    throw new ManagedSetupTrustViolation("Managed setup refs changed before base-advance recovery; no branch mutation was authorized.");
  }

  const recovery = await createCommit(
    github,
    repository,
    [setupHead, currentPlan.baseSha],
    currentPlan.expectedTreeSha,
    `Recover Dark Factory managed setup on ${currentPlan.baseSha}`
  );
  try {
    await github.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
      owner: repository.owner,
      repo: repository.repo,
      ref: `heads/${MANAGED_SETUP_BRANCH}`,
      sha: recovery.sha,
      force: false
    });
  } catch (error) {
    throw new ManagedSetupTrustViolation(`Managed setup base-advance update conflicted; preserved the existing branch and blocked recovery (${requestStatus(error) ?? "unknown"}).`);
  }

  const verifiedMain = await getRef(github, repository, `heads/${currentPlan.baseBranch}`);
  const verifiedBranch = await getRef(github, repository, `heads/${MANAGED_SETUP_BRANCH}`);
  if (verifiedMain.sha !== currentPlan.baseSha || verifiedBranch.sha !== recovery.sha) {
    throw new ManagedSetupTrustViolation("Managed setup base-advance recovery did not retain the exact admitted refs.");
  }
  const recoveryCommit = await getCommit(github, repository, recovery.sha);
  if (
    recoveryCommit.treeSha !== currentPlan.expectedTreeSha
    || !recoveryCommit.parents
    || recoveryCommit.parents.length !== 2
    || recoveryCommit.parents[0] !== setupHead
    || recoveryCommit.parents[1] !== currentPlan.baseSha
  ) {
    throw new ManagedSetupTrustViolation("Managed setup recovery commit does not retain the exact admitted head and current-main parents.");
  }
  await assertManagedSetupBranch(github, repository, recovery.sha, currentPlan);
  return { headSha: recovery.sha, pullAdmission };
}

function unknownManagedSetupRecoveryState(): ManagedSetupTrustViolation {
  return new ManagedSetupTrustViolation(
    `Managed setup branch ${MANAGED_SETUP_BRANCH} contains unknown or conflicting work; setup preserved it and refused base-advance recovery.`
  );
}

async function assertManagedSetupBranch(
  github: GitHubRequester,
  repository: ManagedRepository,
  headSha: string,
  plan: PreparedManagedSetupPlan
): Promise<void> {
  const commit = await getCommit(github, repository, headSha);
  if (
    commit.treeSha !== plan.expectedTreeSha
    || !commit.parents
    || ![1, 2].includes(commit.parents.length)
    || !commit.parents.includes(plan.baseSha)
  ) {
    throw new ManagedSetupTrustViolation(
      `Managed setup branch ${MANAGED_SETUP_BRANCH} is not the exact canonical managed-only plan on ${plan.baseSha}.`
    );
  }
  await assertManagedSetupHeadOwnedByApp(github, repository, headSha);
}

async function assertManagedSetupBaseAdvance(
  github: GitHubRequester,
  repository: ManagedRepository,
  priorBase: string,
  currentBase: string
): Promise<void> {
  const comparison = await github.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
    owner: repository.owner,
    repo: repository.repo,
    basehead: `${priorBase}...${currentBase}`
  });
  if (
    !isRecord(comparison.data)
    || comparison.data.status !== "ahead"
    || typeof comparison.data.ahead_by !== "number"
    || comparison.data.ahead_by < 1
    || comparison.data.behind_by !== 0
  ) {
    throw new ManagedSetupTrustViolation("Current main is not a proven descendant of the managed setup provenance base; recovery was blocked.");
  }
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
  parents: string[],
  treeSha: string,
  message = "Update Dark Factory managed repository setup"
): Promise<{ sha: string }> {
  const response = await github.request("POST /repos/{owner}/{repo}/git/commits", {
    owner: repository.owner,
    repo: repository.repo,
    message,
    tree: treeSha,
    parents
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
  plan: PreparedManagedSetupPlan,
  options: {
    observedBaseSha?: string;
    expectedHeadSha?: string;
    provenancePlan?: PreparedManagedSetupPlan;
    provenanceHeadSha?: string;
    allowLegacyProvenance?: boolean;
  } = {}
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
  const provenancePlan = options.provenancePlan ?? plan;
  const provenanceHeadSha = options.provenanceHeadSha ?? headSha;
  const provenance = typeof provenanceHeadSha === "string"
    ? managedSetupProvenance(provenancePlan, provenanceHeadSha)
    : null;
  const expectedMarker = provenance ? managedSetupProvenanceMarker(provenance) : null;
  const body = typeof pull.body === "string" ? pull.body : "";
  const provenanceMarkers = body.match(/<!-- dark-factory:managed-setup-provenance\b[^>]*-->/g) ?? [];
  const provenanceIsExact = provenanceMarkers.length === 1 && provenanceMarkers[0] === expectedMarker;
  const legacyProvenanceIsAdmissible = options.allowLegacyProvenance === true
    && provenanceMarkers.length === 0
    && body === managedSetupPullRequestBody(provenancePlan.changedPaths);

  if (
    pull.state !== "open"
    || pull.draft !== false
    || pull.title !== MANAGED_SETUP_TITLE
    || typeof pull.commits !== "number"
    || !Number.isInteger(pull.commits)
    || pull.commits < 1
    || base?.ref !== plan.baseBranch
    || base?.sha !== (options.observedBaseSha ?? plan.baseSha)
    || String(baseRepository?.full_name || "").toLowerCase() !== repositoryName
    || head?.ref !== MANAGED_SETUP_BRANCH
    || typeof headSha !== "string"
    || (options.expectedHeadSha !== undefined && headSha !== options.expectedHeadSha)
    || String(headRepository?.full_name || "").toLowerCase() !== repositoryName
    || typeof user?.login !== "string"
    || user.login.toLowerCase() !== actor.login.toLowerCase()
    || user.type !== "Bot"
    || body.split(MANAGED_SETUP_COMMENT_MARKER).length !== 2
    || (!provenanceIsExact && !legacyProvenanceIsAdmissible)
  ) {
    throw new ManagedSetupTrustViolation("Managed setup pull request is not the exact expected App-owned target, head, parent, and provenance plan.");
  }

  const commit = await getCommit(github, repository, headSha);
  if (
    commit.treeSha !== plan.expectedTreeSha
    || !commit.parents
    || ![1, 2].includes(commit.parents.length)
    || !commit.parents.includes(plan.baseSha)
  ) {
    throw new ManagedSetupTrustViolation("Managed setup pull request head is not the exact canonical managed-only diff on its admitted base.");
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
    "- Shared Agent OS identity, memory, roles, skills, provider state, and sessions remain under `$ANDROMEDA_HOME`; DarkFactory never copies them into repositories.",
    "- `.agents/project` is managed only when a repo-specific canonical private-data overlay exists.",
    "- `AGENTS.md` is the repository entrypoint into project-local context and `$ANDROMEDA_HOME`.",
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

function requestStatus(error: unknown): number | undefined {
  return isRequestError(error) ? error.status : undefined;
}
