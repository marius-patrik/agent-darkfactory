export interface Config {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  port: number;
}

export interface AppCredentials {
  appId: string;
  privateKey: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const credentials = loadAppCredentials(env);
  const webhookSecret = requiredEnv(env, "GITHUB_WEBHOOK_SECRET");
  const port = parsePort(env.PORT);

  return {
    appId: credentials.appId,
    privateKey: credentials.privateKey,
    webhookSecret,
    port
  };
}

export function loadAppCredentials(env: NodeJS.ProcessEnv = process.env): AppCredentials {
  return {
    appId: requiredEnv(env, "GITHUB_APP_ID"),
    privateKey: requiredEnv(env, "GITHUB_PRIVATE_KEY").replace(/\\n/g, "\n")
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
