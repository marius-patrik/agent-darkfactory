import { App } from "@octokit/app";

import { loadAppCredentials } from "../src/config.js";
import { ensureManagedRepositorySetup } from "../src/managed-sync.js";

const credentials = loadAppCredentials();
const app = new App({
  appId: credentials.appId,
  privateKey: credentials.privateKey
});

let count = 0;

for await (const { octokit, repository } of app.eachRepository.iterator()) {
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
