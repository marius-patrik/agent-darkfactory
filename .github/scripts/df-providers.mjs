import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const PROVIDER_REGISTRY_PATH = ".darkfactory/providers.json";

const PROVIDER_FAILURE_PATTERNS = {
  codex: [
    /usage.?limit/i,
    /rate.?limit/i,
    /quota/i,
    /billing/i,
    /usage_limit/i,
    /you'?ve hit your/i,
    /\b429\b/
  ],
  kimi: [
    /usage.?limit/i,
    /rate.?limit/i,
    /quota/i,
    /billing/i,
    /\b401\b/,
    /\b403\b/,
    /unauthorized/i,
    /invalid.*key/i,
    /authentication.*failed/i
  ],
  agy: [
    /usage.?limit/i,
    /rate.?limit/i,
    /quota/i,
    /billing/i,
    /authentication.*failed/i
  ]
};

export async function loadProviderRegistry(root) {
  const filePath = path.join(root, PROVIDER_REGISTRY_PATH);
  let data;
  try {
    data = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return { schemaVersion: 1, providers: [] };
    }
    throw new Error(`Failed to load provider registry from ${filePath}: ${error.message}`);
  }
  if (!data || typeof data !== "object") {
    throw new Error("Provider registry must be a JSON object");
  }
  return {
    schemaVersion: Number(data.schemaVersion) || 1,
    providers: Array.isArray(data.providers) ? data.providers : []
  };
}

export function availableProviders(registry, env = process.env) {
  if (!registry || !Array.isArray(registry.providers)) return [];
  return registry.providers
    .filter((provider) => provider.enabled !== false && env[provider.secret]?.trim())
    .map((provider) => ({ ...provider }));
}

export function resolveModel(provider, taskClass = "standard") {
  if (!provider || !provider.models) return "";
  const byTaskClass = provider.models.byTaskClass;
  if (byTaskClass && typeof byTaskClass === "object" && byTaskClass[taskClass]) {
    return byTaskClass[taskClass];
  }
  return provider.models.default || "";
}

export function isProviderFailure(providerId, output) {
  const text = [
    output.stdout || "",
    output.stderr || "",
    output.errorMessage || ""
  ].join("\n");
  const lower = text.toLowerCase();
  const patterns = PROVIDER_FAILURE_PATTERNS[providerId] || [];
  return patterns.some((pattern) => pattern.test(lower));
}

export async function prepareProviderAuth(provider, authJson, homeDir) {
  if (provider.id === "codex") {
    await mkdir(homeDir, { recursive: true });
    await writeFile(path.join(homeDir, "auth.json"), authJson, { mode: 0o600 });
    return;
  }

  if (provider.id === "kimi") {
    const credentialsDir = path.join(homeDir, ".kimi-code", "credentials");
    await mkdir(credentialsDir, { recursive: true });
    await writeFile(path.join(credentialsDir, "kimi-code.json"), authJson, { mode: 0o600 });
    return;
  }

  if (provider.id === "agy") {
    throw new Error("agy provider is disabled; auth preparation is not supported");
  }
}

export function buildProviderImage(provider, controlRoot) {
  if (provider.id === "codex") {
    const dockerfile = path.join(controlRoot, ".github", "codex-review.Dockerfile");
    runCommand("docker", ["build", "-f", dockerfile, "-t", provider.dockerImage || "darkfactory-codex-worker", controlRoot], process.cwd());
    return provider.dockerImage || "darkfactory-codex-worker";
  }

  if (provider.id === "kimi") {
    const dockerfile = path.join(controlRoot, ".github", "kimi-worker.Dockerfile");
    const image = provider.dockerImage || "darkfactory-kimi-worker";
    runCommand("docker", ["build", "-f", dockerfile, "-t", image, controlRoot], process.cwd());
    return image;
  }

  if (provider.id === "agy") {
    throw new Error("agy provider is disabled; image build is not supported");
  }

  throw new Error(`Unknown provider ${provider.id}`);
}

export function runProviderWorker(provider, options) {
  const { worktree, homeDir, model, codeEffort, controlRoot } = options;
  if (provider.id === "codex") {
    return runCodexWorker(provider, worktree, homeDir, model, codeEffort);
  }
  if (provider.id === "kimi") {
    return runKimiWorker(provider, worktree, homeDir, model, controlRoot);
  }
  if (provider.id === "agy") {
    throw providerDisabledError("agy");
  }
  throw new Error(`Unknown provider ${provider.id}`);
}

function runCodexWorker(provider, worktree, homeDir, model, codeEffort) {
  const image = provider.dockerImage || "darkfactory-codex-worker";
  const script = [
    "set -euo pipefail",
    "git config --global --add safe.directory /workspace",
    "cd /workspace",
    `codex exec --cd /workspace --model "${model}" -c "model_reasoning_effort=\"${codeEffort}\"" --sandbox danger-full-access --output-last-message .darkfactory/df-worker-summary.md - < .darkfactory/df-task-brief.md`
  ].join("\n");

  return runCommand("docker", [
    "run",
    "--rm",
    "--entrypoint",
    "bash",
    "-e",
    "CODEX_HOME=/codex-home",
    "-e",
    "HOME=/codex-home",
    "-e",
    `CODEX_MODEL=${model}`,
    "-e",
    `CODEX_EFFORT=${codeEffort}`,
    "-v",
    `${worktree}:/workspace`,
    "-v",
    `${homeDir}:/codex-home`,
    image,
    "-lc",
    script
  ], process.cwd());
}

function runKimiWorker(provider, worktree, homeDir, model, controlRoot) {
  const image = provider.dockerImage || "darkfactory-kimi-worker";
  const script = [
    "set -euo pipefail",
    "git config --global --add safe.directory /workspace",
    "cd /workspace",
    'brief=$(cat /workspace/.darkfactory/df-task-brief.md)',
    `kimi -p "$brief" -m "${model}" > /workspace/.darkfactory/df-worker-summary.md`
  ].join("\n");

  return runCommand("docker", [
    "run",
    "--rm",
    "--entrypoint",
    "bash",
    "-e",
    "HOME=/kimi-home",
    "-e",
    "KIMI_CODE_HOME=/kimi-home/.kimi-code",
    "-v",
    `${worktree}:/workspace`,
    "-v",
    `${homeDir}:/kimi-home`,
    image,
    "-lc",
    script
  ], process.cwd());
}

export async function runWithFailover(providers, runFn, options = {}) {
  const { taskClass = "standard", onAttempt } = options;
  const attempts = [];

  for (const provider of providers) {
    const model = resolveModel(provider, taskClass);
    const attempt = {
      provider: provider.id,
      model,
      startedAt: new Date().toISOString()
    };
    try {
      const result = await runFn(provider, model);
      attempt.endedAt = new Date().toISOString();
      attempt.result = "success";
      attempts.push(attempt);
      if (onAttempt) onAttempt(attempt);
      return { provider: provider.id, model, result, attempts };
    } catch (error) {
      attempt.error = redactSecrets(error.message || String(error));
      attempt.endedAt = new Date().toISOString();
      const output = {
        stdout: error.stdout || "",
        stderr: error.stderr || "",
        exitCode: error.status ?? error.exitCode ?? null,
        errorMessage: error.message || String(error)
      };
      if (isProviderFailure(provider.id, output)) {
        attempt.result = "provider-failure";
        attempts.push(attempt);
        if (onAttempt) onAttempt(attempt);
        continue;
      }
      attempt.result = "task-failure";
      attempts.push(attempt);
      if (onAttempt) onAttempt(attempt);
      throw error;
    }
  }

  const summary = attempts
    .filter((a) => a.result === "provider-failure")
    .map((a) => `${a.provider}: provider quota/auth/rate-limit`)
    .join("; ");
  const aggregate = new Error(`all providers quota-limited (${summary})`);
  aggregate.providerExhausted = true;
  aggregate.attempts = attempts;
  throw aggregate;
}

function runCommand(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    env: process.env
  });
  if (result.status !== 0) {
    const error = new Error(`${command} failed with exit ${result.status}\n${result.stdout || ""}\n${result.stderr || ""}`.trim());
    error.status = result.status;
    error.stdout = result.stdout || "";
    error.stderr = result.stderr || "";
    throw error;
  }
  return result.stdout || "";
}

function providerDisabledError(providerId) {
  const error = new Error(`${providerId} provider is disabled and cannot execute workers`);
  error.providerDisabled = true;
  return error;
}

function redactSecrets(value) {
  let out = String(value);
  for (const name of ["KIMI_AUTH_JSON", "CODEX_AUTH_JSON", "AGY_AUTH_JSON"]) {
    const secret = process.env[name];
    if (!secret) continue;
    out = out.split(secret).join("***");
  }
  return out;
}
