export interface Config {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const appId = requiredEnv(env, "GITHUB_APP_ID");
  const privateKey = requiredEnv(env, "GITHUB_PRIVATE_KEY").replace(/\\n/g, "\n");
  const webhookSecret = requiredEnv(env, "GITHUB_WEBHOOK_SECRET");
  const port = parsePort(env.PORT);

  return {
    appId,
    privateKey,
    webhookSecret,
    port
  };
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function parsePort(value: string | undefined): number {
  if (!value) {
    return 3000;
  }

  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  return port;
}
