import { App } from "@octokit/app";

import {
  checkRepositorySetup,
  formatRepositorySetupComment,
  type GitHubRequester
} from "./repository-setup.js";
import {
  DARK_FACTORY_CONTROL_REPOSITORY,
  ensureManagedRepositorySetup,
  orderManagedRepositoriesForSync,
  type ManagedRepository
} from "./managed-sync.js";
import type { ManagedFile } from "./managed-files.js";

export type { GitHubRequester };

export interface ControlRepositoryRef {
  owner: string;
  repo: string;
}

export interface BotOptions {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  controlRepo?: ControlRepositoryRef;
}

interface RepositoryPayload {
  repository: {
    name: string;
    owner: {
      login: string;
    };
  };
  installation?: {
    id: number;
  };
}

interface IssueLikePayload extends RepositoryPayload {
  issue: {
    number: number;
    pull_request?: unknown;
  };
}

interface IssuePayload extends IssueLikePayload {
  label?: {
    name: string;
  };
}

interface IssueCommentPayload extends IssueLikePayload {
  comment: {
    body: string;
    author_association: string;
  };
}

interface PullRequestPayload {
  repository: {
    name: string;
    owner: {
      login: string;
    };
  };
  pull_request: {
    number: number;
    head: {
      sha: string;
      repo: {
        name: string;
        owner: {
          login: string;
        } | null;
      } | null;
    };
  };
}

interface InstallationRepository {
  full_name?: string;
  name?: string;
  owner?: {
    login?: string;
  } | null;
  default_branch?: string;
  archived?: boolean;
}

interface InstallationPayload {
  repositories?: InstallationRepository[];
}

interface InstallationRepositoriesPayload {
  repositories_added?: InstallationRepository[];
}

const CONTROL_REPO: ControlRepositoryRef = {
  owner: "marius-patrik",
  repo: "DarkFactory"
};

const DISPATCHABLE_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export function createBot(options: BotOptions): App {
  const controlRepo = options.controlRepo ?? CONTROL_REPO;

  const app = new App({
    appId: options.appId,
    privateKey: options.privateKey,
    webhooks: {
      secret: options.webhookSecret
    }
  });

  app.webhooks.on("ping", ({ payload }) => {
    console.log(`Received ping for ${payload.repository?.full_name ?? "unknown repository"}`);
  });

  app.webhooks.on("issues.opened", async ({ octokit, payload }) => {
    await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      issue_number: payload.issue.number,
      body: "Thanks for opening this issue. I am online and ready to help."
    });
  });

  app.webhooks.on("issues.labeled", async ({ octokit, payload }) => {
    if (shouldDispatchForReadyLabel(payload)) {
      await dispatchOrchestrator(octokit, controlRepo, payload, "issues");
    }
  });

  app.webhooks.on("issue_comment.created", async ({ octokit, payload }) => {
    if (shouldDispatchForRunComment(payload)) {
      await dispatchOrchestrator(octokit, controlRepo, payload, "issue_comment");
    }
  });

  app.webhooks.on("pull_request.opened", async ({ octokit, payload }) => {
    await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      issue_number: payload.pull_request.number,
      body: "Thanks for opening this pull request. I will take a look."
    });

    await enforceRepositorySetup(octokit, payload);
  });

  app.webhooks.on("pull_request.reopened", async ({ octokit, payload }) => {
    await enforceRepositorySetup(octokit, payload);
  });

  app.webhooks.on("pull_request.synchronize", async ({ octokit, payload }) => {
    await enforceRepositorySetup(octokit, payload);
  });

  app.webhooks.on("pull_request.ready_for_review", async ({ octokit, payload }) => {
    await enforceRepositorySetup(octokit, payload);
  });

  app.webhooks.on("installation.created", async ({ octokit, payload }) => {
    await syncInstalledRepositories(octokit, payload);
  });

  app.webhooks.on("installation_repositories.added", async ({ octokit, payload }) => {
    await syncAddedRepositories(octokit, payload);
  });

  return app;
}

export function shouldDispatchForReadyLabel(payload: IssuePayload): boolean {
  return payload.label?.name === "df:ready" && payload.issue.pull_request === undefined;
}

export function shouldDispatchForRunComment(payload: IssueCommentPayload): boolean {
  if (payload.issue.pull_request !== undefined) {
    return false;
  }

  const body = payload.comment.body.trim();

  if (body !== "/df run" && !body.startsWith("/df run ")) {
    return false;
  }

  return DISPATCHABLE_ASSOCIATIONS.has(payload.comment.author_association);
}

export async function dispatchOrchestrator(
  octokit: GitHubRequester,
  controlRepo: ControlRepositoryRef,
  payload: IssueLikePayload,
  sourceEvent: string
): Promise<void> {
  const targetRepo = `${payload.repository.owner.login}/${payload.repository.name}`;

  try {
    await octokit.request("POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches", {
      owner: controlRepo.owner,
      repo: controlRepo.repo,
      workflow_id: "df-orchestrate.yml",
      ref: "main",
      inputs: {
        repo: targetRepo,
        issue_number: String(payload.issue.number),
        source_event: sourceEvent
      }
    });

    console.log(`Dispatched df-orchestrate for ${targetRepo}#${payload.issue.number} (${sourceEvent})`);
  } catch (error) {
    console.error(
      `Failed to dispatch df-orchestrate for ${targetRepo}#${payload.issue.number}:`,
      error
    );
  }
}

async function enforceRepositorySetup(
  octokit: GitHubRequester,
  payload: PullRequestPayload
): Promise<void> {
  const headRepository = payload.pull_request.head.repo;
  const report = await checkRepositorySetup(octokit, {
    owner: headRepository?.owner?.login ?? payload.repository.owner.login,
    repo: headRepository?.name ?? payload.repository.name,
    ref: payload.pull_request.head.sha
  });
  const body = formatRepositorySetupComment(report);

  if (!body) {
    return;
  }

  await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    issue_number: payload.pull_request.number,
    body
  });
}

async function syncInstalledRepositories(
  octokit: GitHubRequester,
  payload: InstallationPayload
): Promise<void> {
  await syncRepositories(octokit, payload.repositories ?? []);
}

async function syncAddedRepositories(
  octokit: GitHubRequester,
  payload: InstallationRepositoriesPayload
): Promise<void> {
  await syncRepositories(octokit, payload.repositories_added ?? []);
}

export async function syncRepositories(
  octokit: GitHubRequester,
  repositories: InstallationRepository[],
  files?: ManagedFile[]
): Promise<void> {
  const parsed = repositories
    .map(parseRepository)
    .filter((repository): repository is NonNullable<ReturnType<typeof parseRepository>> => repository !== null);
  const controlKey = repositoryKey(DARK_FACTORY_CONTROL_REPOSITORY);

  for (const repository of orderManagedRepositoriesForSync(parsed, (repository) => repository)) {
    const isControl = repositoryKey(repository) === controlKey;

    try {
      const result = await ensureManagedRepositorySetup(octokit, repository, files);
      console.log(
        `Managed setup ${result.status} for ${result.owner}/${result.repo}${
          result.pullRequestUrl ? `: ${result.pullRequestUrl}` : ""
        }`
      );
    } catch (error) {
      console.error(`Failed to sync managed setup for ${repository.owner}/${repository.repo}`, error);

      // DarkFactory must manage itself before it manages other repositories.
      if (isControl) {
        break;
      }
    }
  }
}

function repositoryKey(repository: Pick<ManagedRepository, "owner" | "repo">): string {
  return `${repository.owner.toLowerCase()}/${repository.repo.toLowerCase()}`;
}

function parseRepository(repository: InstallationRepository) {
  if (repository.owner?.login && repository.name) {
    return {
      owner: repository.owner.login,
      repo: repository.name,
      defaultBranch: repository.default_branch,
      archived: repository.archived
    };
  }

  if (repository.full_name) {
    const [owner, repo] = repository.full_name.split("/");

    if (owner && repo) {
      return {
        owner,
        repo,
        defaultBranch: repository.default_branch,
        archived: repository.archived
      };
    }
  }

  return null;
}
