#!/usr/bin/env node
import "dotenv/config";

import { App } from "@octokit/app";
import { Octokit } from "@octokit/core";
import { createBot } from "./bot.js";
import { loadAppCredentials, loadConfig } from "./config.js";
import { ensureManagedRepositorySetup, orderManagedRepositoriesForSync } from "./managed-sync.js";
import {
  GhCliRunnerClient,
  RunnerManager,
  parseRunnerCommand,
  type RunnerStatus
} from "./runners.js";
import {
  CONTROL_OWNER,
  CONTROL_REPO,
  DATA_REPO,
  buildStatusReport,
  formatStatusReport,
  type GitHubRequester
} from "./status.js";
import { createWebhookServer } from "./server.js";

export async function runCli(args = process.argv.slice(2)): Promise<void> {
  const [command = "help"] = args;

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "serve") {
    serve();
    return;
  }

  if (command === "install-url") {
    await printInstallationUrl();
    return;
  }

  if (command === "sync-managed") {
    await syncManagedRepositories();
    return;
  }

  if (command === "runners") {
    await runRunners(args.slice(1));
    return;
  }

  if (command === "status") {
    await runStatus(args.slice(1));
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

function serve(): void {
  const config = loadConfig();
  const app = createBot({
    appId: config.appId,
    privateKey: config.privateKey,
    webhookSecret: config.webhookSecret
  });
  const server = createWebhookServer(app.webhooks);

  server.listen(config.port, () => {
    console.log(`DarkFactory listening on http://localhost:${config.port}/webhook`);
  });
}

async function printInstallationUrl(): Promise<void> {
  const credentials = loadAppCredentials();
  const app = new App({
    appId: credentials.appId,
    privateKey: credentials.privateKey
  });

  console.log(await app.getInstallationUrl());
}

async function syncManagedRepositories(): Promise<void> {
  const credentials = loadAppCredentials();
  const app = new App({
    appId: credentials.appId,
    privateKey: credentials.privateKey
  });
  const repositories: Array<{
    octokit: Parameters<typeof ensureManagedRepositorySetup>[0];
    repository: {
      owner: { login: string };
      name: string;
      default_branch?: string;
      archived?: boolean;
    };
  }> = [];
  let count = 0;

  for await (const { octokit, repository } of app.eachRepository.iterator()) {
    repositories.push({ octokit, repository });
  }

  for (const { octokit, repository } of orderManagedRepositoriesForSync(repositories, ({ repository }) => ({
    owner: repository.owner.login,
    repo: repository.name
  }))) {
    const result = await ensureManagedRepositorySetup(octokit, {
      owner: repository.owner.login,
      repo: repository.name,
      defaultBranch: repository.default_branch,
      archived: repository.archived
    });

    count += 1;
    console.log(
      `${result.owner}/${result.repo}: ${result.status}${
        result.pullRequestUrl ? ` ${result.pullRequestUrl}` : ""
      }`
    );
  }

  console.log(`Processed ${count} installed repositories.`);
}

async function runStatus(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const credentials = loadAppCredentials();
  const app = new App({
    appId: credentials.appId,
    privateKey: credentials.privateKey
  });
  const octokit = await getInstallationOctokit(app, CONTROL_OWNER);
  const requester = createOctokitRequester(octokit);
  const report = await buildStatusReport(requester, {
    controlOwner: CONTROL_OWNER,
    controlRepo: CONTROL_REPO,
    dataRepo: DATA_REPO
  });

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatStatusReport(report));
  }
}

async function getInstallationOctokit(app: App, owner: string): Promise<Octokit> {
  const { data } = await app.octokit.request("GET /app/installations");

  if (!Array.isArray(data)) {
    throw new Error("GitHub returned an invalid app installations response");
  }

  const installation = data.find(
    (item) =>
      isRecord(item) &&
      isRecord(item.account) &&
      typeof item.account.login === "string" &&
      item.account.login.toLowerCase() === owner.toLowerCase()
  );

  if (!installation || !isRecord(installation) || typeof installation.id !== "number") {
    throw new Error(`GitHub App is not installed for owner ${owner}`);
  }

  return app.getInstallationOctokit(installation.id);
}

function createOctokitRequester(octokit: Octokit): GitHubRequester {
  return {
    async request(route, parameters) {
      const response = await octokit.request(route, parameters);
      return { data: response.data };
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function runRunners(args: string[]): Promise<void> {
  const command = parseRunnerCommand(args);
  const manager = new RunnerManager({ github: new GhCliRunnerClient() });

  if (command.action === "setup") {
    const record = await manager.setup(command.repository, { root: command.root });
    const started = await manager.start(command.repository, { root: command.root });
    console.log(`${record.owner}/${record.repo}: configured ${record.runnerName} at ${record.directory}`);
    console.log(`${record.owner}/${record.repo}: started pid ${started.pid}`);
    return;
  }

  if (command.action === "start") {
    const records = command.repository ? [command.repository] : await manager.list({ root: command.root });
    for (const repository of records) {
      const record = await manager.start(repository, { root: command.root });
      console.log(`${record.owner}/${record.repo}: started ${record.runnerName} pid ${record.pid}`);
    }
    return;
  }

  if (command.action === "stop") {
    const records = command.repository ? [command.repository] : await manager.list({ root: command.root });
    for (const repository of records) {
      const record = await manager.stop(repository, { root: command.root });
      console.log(`${record.owner}/${record.repo}: stopped ${record.runnerName}`);
    }
    return;
  }

  if (command.action === "status") {
    printRunnerStatuses(await manager.status(command.repository, { root: command.root }));
    return;
  }

  if (command.action === "remove") {
    const record = await manager.remove(command.repository, { root: command.root });
    console.log(`${record.owner}/${record.repo}: removed ${record.runnerName}`);
  }
}

function printRunnerStatuses(statuses: RunnerStatus[]): void {
  if (statuses.length === 0) {
    console.log("No DarkFactory runners are recorded.");
    return;
  }

  for (const status of statuses) {
    console.log(
      `${status.repository}: ${status.runnerName} process=${status.process} github=${status.github}` +
        `${typeof status.busy === "boolean" ? ` busy=${status.busy}` : ""}` +
        `${status.pid ? ` pid=${status.pid}` : ""}`
    );
  }
}

function printHelp(): void {
  console.log(`darkfactory - DarkFactory GitHub agent

Usage:
  darkfactory serve
  darkfactory install-url
  darkfactory sync-managed
  darkfactory status [--json]
  darkfactory runners setup <owner/repo> [--root <path>]
  darkfactory runners start <owner/repo> [--root <path>]
  darkfactory runners stop <owner/repo> [--root <path>]
  darkfactory runners status [owner/repo] [--root <path>]
  darkfactory runners remove <owner/repo> [--root <path>]

Secrets are read from environment variables first, then AGENTS_SECRETS/*.secret.`);
}

runCli().catch((error) => {
  console.error(`darkfactory: ${error.message}`);
  process.exitCode = 1;
});
