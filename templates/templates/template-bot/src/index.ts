import "dotenv/config";

import { createBot } from "./bot.js";
import { loadConfig } from "./config.js";
import { createWebhookServer } from "./server.js";

const config = loadConfig();
const app = createBot({
  appId: config.appId,
  privateKey: config.privateKey,
  webhookSecret: config.webhookSecret
});
const server = createWebhookServer(app.webhooks);

server.listen(config.port, () => {
  console.log(`GitHub bot listening on http://localhost:${config.port}/webhook`);
});
