import { App } from "@octokit/app";

import {
  checkRepositorySetup,
  formatRepositorySetupComment,
  type GitHubRequester
} from "./repository-setup.js";
import { ensureManagedRepositorySetup } from "./managed-sync.js";

export interface BotOptions {
  appId: string;
  privateKey: string;
  webhookSecret: string;
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

export function createBot(options: BotOptions): App {
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

async function syncRepositories(
  octokit: GitHubRequester,
  repositories: InstallationRepository[]
): Promise<void> {
  for (const repository of repositories) {
    const parsed = parseRepository(repository);

    if (!parsed) {
      continue;
    }

    try {
      const result = await ensureManagedRepositorySetup(octokit, parsed);
      console.log(
        `Managed setup ${result.status} for ${result.owner}/${result.repo}${
          result.pullRequestUrl ? `: ${result.pullRequestUrl}` : ""
        }`
      );
    } catch (error) {
      console.error(`Failed to sync managed setup for ${parsed.owner}/${parsed.repo}`, error);
    }
  }
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
