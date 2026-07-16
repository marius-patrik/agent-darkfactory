import type { OperatorGitHubRequester } from "./clean-evidence.js";
import type { SetupReceipt } from "./setup.js";

export const MANAGED_REGISTRY_REPOSITORY = "marius-patrik/Andromeda-data";
export const MANAGED_REGISTRY_PATH = "managed-repository/.darkfactory/managed-repos.json";

export interface ManagedRegistrationResult {
  receipt: SetupReceipt;
  sourceActive: boolean;
}

export async function convergeManagedRegistration(
  github: OperatorGitHubRequester,
  targetRepository: string
): Promise<ManagedRegistrationResult> {
  const target = normalizeRepository(targetRepository);
  const registryRepository = { owner: "marius-patrik", repo: "Andromeda-data" };
  const metadata = record((await github.request("GET /repos/{owner}/{repo}", registryRepository)).data, "Andromeda-data metadata");
  if (metadata.private !== true || metadata.default_branch !== "main" || metadata.archived === true || metadata.disabled === true) {
    throw new Error("canonical managed registry authority must remain the private, writable Andromeda-data main repository");
  }

  const mainFile = registryFile(await github.request("GET /repos/{owner}/{repo}/contents/{path}", {
    ...registryRepository,
    path: MANAGED_REGISTRY_PATH,
    ref: "main"
  }));
  const registry = parseRegistry(mainFile.content);
  const current = findEntry(registry.repositories, target);
  if (current) {
    if (record(current.value, `managed registry entry ${current.key}`).state !== "active") {
      throw new Error(`managed registry entry ${current.key} is explicitly non-active; setup cannot override an owner lifecycle brake`);
    }
    return {
      sourceActive: true,
      receipt: {
        action: "managed-registration",
        target,
        status: "current",
        detail: "Canonical Andromeda-data source already declares this code repository active."
      }
    };
  }

  const branch = `darkfactory/register-${target.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
  const mainRef = record((await github.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
    ...registryRepository,
    ref: "heads/main"
  })).data, "Andromeda-data main ref");
  const mainObject = record(mainRef.object, "Andromeda-data main ref object");
  const mainHead = exactCommit(mainObject.sha, "Andromeda-data main head");
  const next = structuredClone(registry);
  next.repositories[target] = {
    state: "active",
    kind: "code",
    note: "Managed code repository admitted through the reviewed df setup registration lane."
  };
  const content = `${JSON.stringify(sortRegistry(next), null, 2)}\n`;
  const existingPulls = array((await github.request("GET /repos/{owner}/{repo}/pulls", {
    ...registryRepository,
    state: "open",
    base: "main",
    head: `${registryRepository.owner}:${branch}`,
    per_page: 10
  })).data, "managed registration pull requests");
  if (existingPulls.length > 1) throw new Error("multiple open managed registration pull requests exist for one repository");
  const branchRef = await optionalBranchRef(github, registryRepository, branch);
  if (existingPulls.length === 1) {
    const pull = record(existingPulls[0], "managed registration pull request");
    if (!branchRef) throw new Error("managed registration pull request exists without its exact source branch");
    const branchFile = registryFile(await github.request("GET /repos/{owner}/{repo}/contents/{path}", {
      ...registryRepository,
      path: MANAGED_REGISTRY_PATH,
      ref: branch
    }));
    if (branchFile.content !== content) throw new Error("existing managed registration pull request does not carry the exact canonical registry content");
    await assertSafeRegistrationBranch(github, registryRepository, mainHead, branchRef, branch);
    return {
      sourceActive: false,
      receipt: {
        action: "managed-registration-pr",
        target,
        status: "current",
        detail: requiredText(pull.html_url, "managed registration pull request URL")
      }
    };
  }

  if (!branchRef) {
    await github.request("POST /repos/{owner}/{repo}/git/refs", {
      ...registryRepository,
      ref: `refs/heads/${branch}`,
      sha: mainHead
    });
  } else {
    await assertSafeRegistrationBranch(github, registryRepository, mainHead, branchRef, branch);
  }
  let branchFile = branchRef && branchRef !== mainHead
    ? registryFile(await github.request("GET /repos/{owner}/{repo}/contents/{path}", {
      ...registryRepository,
      path: MANAGED_REGISTRY_PATH,
      ref: branch
    }))
    : mainFile;
  if (branchFile.content !== content) {
    await github.request("PUT /repos/{owner}/{repo}/contents/{path}", {
      ...registryRepository,
      path: MANAGED_REGISTRY_PATH,
      branch,
      sha: branchFile.sha,
      message: `Register ${target} for DarkFactory management`,
      content: Buffer.from(content, "utf8").toString("base64")
    });
  }
  const created = record((await github.request("POST /repos/{owner}/{repo}/pulls", {
    ...registryRepository,
    title: `Register ${target} for DarkFactory management`,
    head: branch,
    base: "main",
    body: [
      "## Summary",
      "",
      `- register \`${target}\` as an active managed code repository`,
      "- preserve every existing lifecycle entry exactly",
      "",
      "## Safety",
      "",
      "This reviewed source-policy change does not touch the target repository or override parked/archived state."
    ].join("\n")
  })).data, "created managed registration pull request");
  return {
    sourceActive: false,
    receipt: {
      action: "managed-registration-pr",
      target,
      status: "applied",
      detail: requiredText(created.html_url, "created managed registration pull request URL")
    }
  };
}

async function optionalBranchRef(
  github: OperatorGitHubRequester,
  repository: { owner: string; repo: string },
  branch: string
): Promise<string | null> {
  try {
    const ref = record((await github.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
      ...repository,
      ref: `heads/${branch}`
    })).data, "managed registration branch ref");
    return exactCommit(record(ref.object, "managed registration branch object").sha, "managed registration branch head");
  } catch (error) {
    if (recordStatus(error) === 404) return null;
    throw error;
  }
}

async function assertSafeRegistrationBranch(
  github: OperatorGitHubRequester,
  repository: { owner: string; repo: string },
  mainHead: string,
  branchHead: string,
  branch: string
): Promise<void> {
  if (branchHead === mainHead) return;
  const comparison = record((await github.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
    ...repository,
    basehead: `${mainHead}...${branchHead}`
  })).data, "managed registration branch comparison");
  const files = array(comparison.files, "managed registration branch files");
  if (comparison.status !== "ahead" || comparison.ahead_by !== 1 || comparison.behind_by !== 0
      || files.length !== 1 || record(files[0], "managed registration branch file").filename !== MANAGED_REGISTRY_PATH) {
    throw new Error(`managed registration branch ${branch} contains unknown or stale work; setup preserved it and refused adoption`);
  }
}

interface Registry {
  schemaVersion: 1;
  description?: string;
  repositories: Record<string, unknown>;
}

function parseRegistry(content: string): Registry {
  let value: unknown;
  try { value = JSON.parse(content); } catch { throw new Error("canonical managed registry is invalid JSON"); }
  const registry = record(value, "canonical managed registry") as unknown as Registry;
  if (registry.schemaVersion !== 1 || !registry.repositories || typeof registry.repositories !== "object" || Array.isArray(registry.repositories)) {
    throw new Error("canonical managed registry must use schemaVersion 1 and a repositories object");
  }
  const normalized = new Set<string>();
  for (const [key, raw] of Object.entries(registry.repositories)) {
    const name = normalizeRepository(key);
    if (normalized.has(name)) throw new Error("canonical managed registry contains a case-insensitive duplicate repository");
    normalized.add(name);
    const entry = record(raw, `managed registry entry ${key}`);
    if (!["active", "parked", "archived", "removed"].includes(String(entry.state || ""))) {
      throw new Error(`managed registry entry ${key} has an invalid lifecycle state`);
    }
  }
  return registry;
}

function registryFile(response: { data: unknown }): { sha: string; content: string } {
  const value = record(response.data, "managed registry file");
  if (value.encoding !== "base64") throw new Error("managed registry file must be returned as base64 content");
  return {
    sha: exactCommit(value.sha, "managed registry blob SHA"),
    content: Buffer.from(requiredText(value.content, "managed registry content"), "base64").toString("utf8")
  };
}

function findEntry(repositories: Record<string, unknown>, target: string): { key: string; value: unknown } | null {
  const matches = Object.entries(repositories).filter(([key]) => normalizeRepository(key) === target);
  if (matches.length > 1) throw new Error("canonical managed registry contains duplicate target entries");
  return matches[0] ? { key: matches[0][0], value: matches[0][1] } : null;
}

function sortRegistry(registry: Registry): Registry {
  return {
    schemaVersion: 1,
    ...(typeof registry.description === "string" ? { description: registry.description } : {}),
    repositories: Object.fromEntries(Object.entries(registry.repositories).sort(([a], [b]) => a.localeCompare(b)))
  };
}

function normalizeRepository(value: string): string {
  const repository = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository)) throw new Error("managed registration target must be one exact owner/repository name");
  return repository;
}

function exactCommit(value: unknown, label: string): string {
  const text = requiredText(value, label);
  if (!/^[0-9a-f]{40}$/.test(text)) throw new Error(`${label} must be one exact commit SHA`);
  return text;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is missing`);
  return value.trim();
}

function record(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is malformed`);
  return value as Record<string, any>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} is malformed`);
  return value;
}

function recordStatus(error: unknown): number | undefined {
  return error && typeof error === "object" && "status" in error ? Number((error as { status?: unknown }).status) : undefined;
}
