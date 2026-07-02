import { App } from "@octokit/app";

import { loadAppCredentials } from "../src/config.js";

const credentials = loadAppCredentials();
const app = new App({
  appId: credentials.appId,
  privateKey: credentials.privateKey
});

console.log(await app.getInstallationUrl());
