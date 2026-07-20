import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Config {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  port: number;
  controlRepo: RepositoryRef;
}

export interface AppCredentials {
  appId: string;
  privateKey: string;
}

export interface RepositoryRef {
  owner: string;
  repo: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const credentials = loadAppCredentials(env);
  const webhookSecret = requiredEnv(env, "GITHUB_WEBHOOK_SECRET");
  const port = parsePort(env.PORT);
  const controlRepo = parseControlRepo(env.DARK_FACTORY_CONTROL_REPO);

  return {
    appId: credentials.appId,
    privateKey: credentials.privateKey,
    webhookSecret,
    port,
    controlRepo
  };
}

export function parseControlRepo(value: string | undefined): RepositoryRef {
  const raw = value?.trim();

  if (raw) {
    return parseRepositoryRef(raw);
  }

  return { owner: "marius-patrik", repo: "DarkFactory" };
}

export function parseRepositoryRef(value: string): RepositoryRef {
  const parts = value.split("/");

  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Control repository must be in owner/repo form: ${value}`);
  }

  return { owner: parts[0], repo: parts[1] };
}

export function loadAppCredentials(env: NodeJS.ProcessEnv = process.env): AppCredentials {
  return {
    appId: requiredEnv(env, "GITHUB_APP_ID"),
    privateKey: requiredEnv(env, "GITHUB_PRIVATE_KEY").replace(/\\n/g, "\n")
  };
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim() ?? readAgentOsSecret(env, name)?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function readAgentOsSecret(env: NodeJS.ProcessEnv, name: string): string | null {
  const secretsDir = env.AGENTS_SECRETS?.trim();
  if (!secretsDir) return null;
  const file = join(secretsDir, `${name}.secret`);
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf8");
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
