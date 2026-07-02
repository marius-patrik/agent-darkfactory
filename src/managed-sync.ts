import {
  GITHUB_BOOTSTRAP_WORKFLOW_PATH,
  readManagedFiles,
  type ManagedFile
} from "./managed-files.js";

export const MANAGED_SETUP_BRANCH = "vibe-bot/managed-repository-setup";
export const MANAGED_SETUP_COMMENT_MARKER = "<!-- vibe-bot:managed-setup-pr -->";

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

export async function ensureManagedRepositorySetup(
  github: GitHubRequester,
  repository: ManagedRepository,
  files = readManagedFiles()
): Promise<ManagedSetupSyncResult> {
  if (repository.archived) {
    return baseResult(repository, "skipped", [], "Repository is archived.");
  }

  const repoInfo = await getRepositoryInfo(github, repository);

  if (repoInfo.archived) {
    return baseResult(repository, "skipped", [], "Repository is archived.");
  }

  const baseRef = await getRef(github, repository, `heads/${repoInfo.defaultBranch}`);
  const setupRef = await getOptionalRef(github, repository, `heads/${MANAGED_SETUP_BRANCH}`);
  const sourceSha = setupRef?.sha ?? baseRef.sha;
  const changedFiles = await changedManagedFiles(github, repository, sourceSha, files);

  if (changedFiles.length === 0) {
    return baseResult(repository, "current", []);
  }

  const sourceCommit = await getCommit(github, repository, sourceSha);
  const tree = await createTree(github, repository, sourceCommit.treeSha, changedFiles);
  const commit = await createCommit(github, repository, sourceSha, tree.sha);

  if (setupRef) {
    await github.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
      owner: repository.owner,
      repo: repository.repo,
      ref: `heads/${MANAGED_SETUP_BRANCH}`,
      sha: commit.sha,
      force: false
    });
  } else {
    await github.request("POST /repos/{owner}/{repo}/git/refs", {
      owner: repository.owner,
      repo: repository.repo,
      ref: `refs/heads/${MANAGED_SETUP_BRANCH}`,
      sha: commit.sha
    });
  }

  const existingPr = await findExistingPullRequest(github, repository, repoInfo.defaultBranch);

  if (existingPr) {
    return {
      ...baseResult(repository, "updated", changedFiles.map((file) => file.path)),
      pullRequestUrl: existingPr.url
    };
  }

  const pullRequest = await createPullRequest(
    github,
    repository,
    repoInfo.defaultBranch,
    changedFiles.map((file) => file.path)
  );

  return {
    ...baseResult(repository, "created", changedFiles.map((file) => file.path)),
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
): Promise<{ treeSha: string }> {
  const response = await github.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
    owner: repository.owner,
    repo: repository.repo,
    commit_sha: sha
  });

  if (!isRecord(response.data) || !isRecord(response.data.tree) || typeof response.data.tree.sha !== "string") {
    throw new Error("GitHub returned an invalid commit response");
  }

  return { treeSha: response.data.tree.sha };
}

async function createTree(
  github: GitHubRequester,
  repository: ManagedRepository,
  baseTree: string,
  files: ManagedFile[]
): Promise<{ sha: string }> {
  const response = await github.request("POST /repos/{owner}/{repo}/git/trees", {
    owner: repository.owner,
    repo: repository.repo,
    base_tree: baseTree,
    tree: files.map((file) => ({
      path: file.path,
      mode: "100644",
      type: "blob",
      content: file.content
    }))
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
    message: "Update Vibe Bot managed repository setup",
    tree: treeSha,
    parents: [parentSha]
  });

  if (!isRecord(response.data) || typeof response.data.sha !== "string") {
    throw new Error("GitHub returned an invalid commit response");
  }

  return { sha: response.data.sha };
}

async function findExistingPullRequest(
  github: GitHubRequester,
  repository: ManagedRepository,
  base: string
): Promise<{ url: string } | null> {
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

  const first = response.data[0];

  if (!isRecord(first) || typeof first.html_url !== "string") {
    return null;
  }

  return { url: first.html_url };
}

async function createPullRequest(
  github: GitHubRequester,
  repository: ManagedRepository,
  base: string,
  changedPaths: string[]
): Promise<{ url: string }> {
  const response = await github.request("POST /repos/{owner}/{repo}/pulls", {
    owner: repository.owner,
    repo: repository.repo,
    title: "Update Vibe Bot managed repository setup",
    head: MANAGED_SETUP_BRANCH,
    base,
    body: managedSetupPullRequestBody(changedPaths)
  });

  if (!isRecord(response.data) || typeof response.data.html_url !== "string") {
    throw new Error("GitHub returned an invalid pull request response");
  }

  return { url: response.data.html_url };
}

export function managedSetupPullRequestBody(changedPaths: string[]): string {
  const paths = changedPaths.map((path) => `- \`${path}\``).join("\n");

  return [
    MANAGED_SETUP_COMMENT_MARKER,
    "## Summary",
    "",
    "Vibe Bot is installing or updating managed repository setup files.",
    "",
    paths,
    "",
    "## Notes",
    "",
    "- `.agents/.global` is version-managed by Vibe Bot.",
    `- \`${GITHUB_BOOTSTRAP_WORKFLOW_PATH}\` is bootstrap-managed so repositories have a safe baseline workflow.`,
    "- Project-specific `.agents/.project` files are not changed."
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
