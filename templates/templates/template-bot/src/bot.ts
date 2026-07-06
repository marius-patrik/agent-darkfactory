import { App } from "@octokit/app";

export interface BotOptions {
  appId: string;
  privateKey: string;
  webhookSecret: string;
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
  });

  return app;
}
