import { createHash } from "node:crypto";

import type { OperatorGitHubRequester } from "./clean-evidence.js";
import type { SetupReceipt } from "./setup.js";

export const MANAGED_REGISTRY_REPOSITORY = "marius-patrik/Andromeda-data";
export const MANAGED_REGISTRY_PATH = "managed-repository/.darkfactory/managed-repos.json";
const REGISTRATION_PR_MARKER = "<!-- darkfactory:managed-registration-pr -->";
const REGISTRATION_PROVENANCE_PREFIX = "<!-- darkfactory:managed-registration";

interface RegistrationProvenance {
  baseSha: string;
  headSha: string;
  target: string;
  contentDigest: string;
}

export interface ManagedRegistrationResult {
  receipt: SetupReceipt;
  sourceActive: boolean;
}

export class ManagedRegistrationTrustViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedRegistrationTrustViolation";
  }
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
  const pullReference = existingPulls.length === 1
    ? registrationPullReference(existingPulls[0])
    : null;
  let pull = pullReference
    ? record((await github.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      ...registryRepository,
      pull_number: pullReference.number
    })).data, "managed registration pull request")
    : null;
  let branchHead = await optionalBranchRef(github, registryRepository, branch);
  let changed = false;

  if (pull && !branchHead) throw new Error("managed registration pull request exists without its exact source branch");
  if (!branchHead) {
    await github.request("POST /repos/{owner}/{repo}/git/refs", {
      ...registryRepository,
      ref: `refs/heads/${branch}`,
      sha: mainHead
    });
    branchHead = mainHead;
    changed = true;
  } else if (branchHead !== mainHead) {
    const convergence = await convergeRegistrationBranch(
      github,
      registryRepository,
      branch,
      branchHead,
      mainHead,
      target,
      content,
      pull
    );
    branchHead = convergence.headSha;
    changed ||= convergence.changed;
    pull = convergence.pull;
  }

  let branchFile = branchHead !== mainHead
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
    changed = true;
    branchHead = requiredBranchRef(await optionalBranchRef(github, registryRepository, branch), branch);
    branchFile = registryFile(await github.request("GET /repos/{owner}/{repo}/contents/{path}", {
      ...registryRepository,
      path: MANAGED_REGISTRY_PATH,
      ref: branch
    }));
    await assertRegistrationBranch(github, registryRepository, mainHead, branchHead, branch, content);
  }

  const provenance = registrationProvenance(mainHead, branchHead, target, content);
  if (pullReference && pull) {
    const currentBody = typeof pull.body === "string" ? pull.body : "";
    const nextBody = replaceRegistrationProvenance(currentBody, provenance, target);
    if (nextBody !== currentBody) {
      await github.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
        ...registryRepository,
        pull_number: pullReference.number,
        body: nextBody
      });
      changed = true;
    }
    pull = record((await github.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      ...registryRepository,
      pull_number: pullReference.number
    })).data, "managed registration pull request after convergence");
    await assertRegistrationPullRequest(github, registryRepository, pull, branch, branchHead, mainHead, target, content);
    return {
      sourceActive: false,
      receipt: {
        action: "managed-registration-pr",
        target,
        status: changed ? "applied" : "current",
        detail: pullReference.url
      }
    };
  }

  const created = record((await github.request("POST /repos/{owner}/{repo}/pulls", {
    ...registryRepository,
    title: registrationTitle(target),
    head: branch,
    base: "main",
    body: registrationPullRequestBody(target, provenance)
  })).data, "created managed registration pull request");
  const createdReference = registrationPullReference(created);
  const createdPull = record((await github.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    ...registryRepository,
    pull_number: createdReference.number
  })).data, "created managed registration pull request evidence");
  await assertRegistrationPullRequest(github, registryRepository, createdPull, branch, branchHead, mainHead, target, content);
  return {
    sourceActive: false,
    receipt: {
      action: "managed-registration-pr",
      target,
      status: "applied",
      detail: createdReference.url
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

async function convergeRegistrationBranch(
  github: OperatorGitHubRequester,
  repository: { owner: string; repo: string },
  branch: string,
  branchHead: string,
  mainHead: string,
  target: string,
  content: string,
  pull: Record<string, any> | null
): Promise<{ headSha: string; changed: boolean; pull: Record<string, any> | null }> {
  try {
    await assertRegistrationBranch(github, repository, mainHead, branchHead, branch, content);
    if (pull) {
      await assertRegistrationPullRequest(
        github,
        repository,
        pull,
        branch,
        branchHead,
        mainHead,
        target,
        content,
        { allowLegacyProvenance: true }
      );
    }
    return { headSha: branchHead, changed: false, pull };
  } catch (error) {
    if (!(error instanceof ManagedRegistrationTrustViolation)) throw error;
  }

  const branchCommit = await registrationCommit(github, repository, branchHead);
  const priorProvenance = parseRegistrationProvenance(pull?.body);
  const priorBase = priorProvenance?.baseSha
    ?? (branchCommit.parents.length === 1 ? branchCommit.parents[0] : null);
  if (
    !priorBase
    || priorBase === mainHead
    || (priorProvenance && (
      priorProvenance.headSha !== branchHead
      || priorProvenance.target !== target
    ))
  ) {
    throw new ManagedRegistrationTrustViolation(
      `managed registration branch ${branch} contains unknown or conflicting work; setup preserved it and refused base-advance recovery`
    );
  }

  const priorFile = registryFile(await github.request("GET /repos/{owner}/{repo}/contents/{path}", {
    ...repository,
    path: MANAGED_REGISTRY_PATH,
    ref: priorBase
  }));
  const priorContent = registrationContentForTarget(priorFile.content, target);
  await assertRegistrationBranch(github, repository, priorBase, branchHead, branch, priorContent);
  if (pull) {
    await assertRegistrationPullRequest(
      github,
      repository,
      pull,
      branch,
      branchHead,
      mainHead,
      target,
      priorContent,
      { provenanceBaseSha: priorBase, allowLegacyProvenance: priorProvenance === null }
    );
  }
  await assertRegistrationBaseAdvance(github, repository, priorBase, mainHead);

  const admittedMain = requiredBranchRef(await optionalBranchRef(github, repository, "main"), "main");
  const admittedBranch = requiredBranchRef(await optionalBranchRef(github, repository, branch), branch);
  if (admittedMain !== mainHead || admittedBranch !== branchHead) {
    throw new ManagedRegistrationTrustViolation("managed registration refs changed before base-advance recovery; no branch mutation was authorized");
  }

  const mainCommit = await registrationCommit(github, repository, mainHead);
  const tree = record((await github.request("POST /repos/{owner}/{repo}/git/trees", {
    ...repository,
    base_tree: mainCommit.treeSha,
    tree: [{
      path: MANAGED_REGISTRY_PATH,
      mode: "100644",
      type: "blob",
      content
    }]
  })).data, "managed registration recovery tree");
  const treeSha = exactCommit(tree.sha, "managed registration recovery tree SHA");
  const recovery = record((await github.request("POST /repos/{owner}/{repo}/git/commits", {
    ...repository,
    message: `Recover ${target} registration on ${mainHead}`,
    tree: treeSha,
    parents: [branchHead, mainHead]
  })).data, "managed registration recovery commit");
  const recoverySha = exactCommit(recovery.sha, "managed registration recovery commit SHA");
  try {
    await github.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
      ...repository,
      ref: `heads/${branch}`,
      sha: recoverySha,
      force: false
    });
  } catch (error) {
    throw new ManagedRegistrationTrustViolation(`managed registration base-advance update conflicted; preserved existing work and blocked recovery (${recordStatus(error) ?? "unknown"})`);
  }

  const verifiedMain = requiredBranchRef(await optionalBranchRef(github, repository, "main"), "main");
  const verifiedBranch = requiredBranchRef(await optionalBranchRef(github, repository, branch), branch);
  if (verifiedMain !== mainHead || verifiedBranch !== recoverySha) {
    throw new ManagedRegistrationTrustViolation("managed registration base-advance recovery did not retain the exact admitted refs");
  }
  await assertRegistrationBranch(github, repository, mainHead, recoverySha, branch, content);
  return { headSha: recoverySha, changed: true, pull };
}

async function assertRegistrationBranch(
  github: OperatorGitHubRequester,
  repository: { owner: string; repo: string },
  baseHead: string,
  branchHead: string,
  branch: string,
  expectedContent: string
): Promise<void> {
  if (branchHead === baseHead) {
    throw new ManagedRegistrationTrustViolation(`managed registration branch ${branch} has no reviewed registry change`);
  }
  const comparison = record((await github.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
    ...repository,
    basehead: `${baseHead}...${branchHead}`
  })).data, "managed registration branch comparison");
  const files = array(comparison.files, "managed registration branch files");
  if (comparison.status !== "ahead" || !Number.isInteger(comparison.ahead_by) || comparison.ahead_by < 1 || comparison.behind_by !== 0
      || files.length !== 1 || record(files[0], "managed registration branch file").filename !== MANAGED_REGISTRY_PATH) {
    throw new ManagedRegistrationTrustViolation(`managed registration branch ${branch} contains unknown or stale work; setup preserved it and refused adoption`);
  }
  const branchFile = registryFile(await github.request("GET /repos/{owner}/{repo}/contents/{path}", {
    ...repository,
    path: MANAGED_REGISTRY_PATH,
    ref: branchHead
  }));
  if (branchFile.content !== expectedContent) {
    throw new ManagedRegistrationTrustViolation(`managed registration branch ${branch} does not carry the exact canonical registry content`);
  }
  await assertRegistrationHeadOwnedByApp(github, repository, branchHead);
}

async function assertRegistrationBaseAdvance(
  github: OperatorGitHubRequester,
  repository: { owner: string; repo: string },
  priorBase: string,
  currentBase: string
): Promise<void> {
  const comparison = record((await github.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
    ...repository,
    basehead: `${priorBase}...${currentBase}`
  })).data, "managed registration base advance");
  if (comparison.status !== "ahead" || !Number.isInteger(comparison.ahead_by) || comparison.ahead_by < 1 || comparison.behind_by !== 0) {
    throw new ManagedRegistrationTrustViolation("current main is not a proven descendant of the managed registration provenance base");
  }
}

async function assertRegistrationPullRequest(
  github: OperatorGitHubRequester,
  repository: { owner: string; repo: string },
  pull: Record<string, any>,
  branch: string,
  headSha: string,
  observedBaseSha: string,
  target: string,
  content: string,
  options: { provenanceBaseSha?: string; allowLegacyProvenance?: boolean } = {}
): Promise<void> {
  const actor = await expectedRegistrationActor(github);
  const base = record(pull.base, "managed registration pull request base");
  const head = record(pull.head, "managed registration pull request head");
  const user = record(pull.user, "managed registration pull request actor");
  const baseRepository = record(base.repo, "managed registration pull request base repository");
  const headRepository = record(head.repo, "managed registration pull request head repository");
  const provenance = registrationProvenance(options.provenanceBaseSha ?? observedBaseSha, headSha, target, content);
  const parsed = parseRegistrationProvenance(pull.body);
  const repositoryName = `${repository.owner}/${repository.repo}`.toLowerCase();
  const exact = parsed
    && parsed.baseSha === provenance.baseSha
    && parsed.headSha === provenance.headSha
    && parsed.target === provenance.target
    && parsed.contentDigest === provenance.contentDigest;
  const legacyIsExact = options.allowLegacyProvenance === true
    && parsed === null
    && pull.body === legacyRegistrationPullRequestBody(target);
  if (
    pull.state !== "open"
    || pull.draft !== false
    || pull.title !== registrationTitle(target)
    || !Number.isInteger(pull.commits)
    || pull.commits < 1
    || base.ref !== "main"
    || base.sha !== observedBaseSha
    || String(baseRepository.full_name || "").toLowerCase() !== repositoryName
    || head.ref !== branch
    || head.sha !== headSha
    || String(headRepository.full_name || "").toLowerCase() !== repositoryName
    || String(user.login || "").toLowerCase() !== actor.login.toLowerCase()
    || user.type !== "Bot"
    || (!exact && !legacyIsExact)
  ) {
    throw new ManagedRegistrationTrustViolation("managed registration pull request is not the exact App-owned target, branch, base, and provenance plan");
  }
  await assertRegistrationBranch(github, repository, options.provenanceBaseSha ?? observedBaseSha, headSha, branch, content);
}

async function expectedRegistrationActor(github: OperatorGitHubRequester): Promise<{ login: string }> {
  const installation = record((await github.request("GET /installation", {})).data, "managed registration App installation");
  const slug = requiredText(installation.app_slug, "managed registration App slug");
  if (!Number.isInteger(installation.app_id) || installation.app_id <= 0) {
    throw new ManagedRegistrationTrustViolation("managed registration App identity is incomplete");
  }
  return { login: `${slug}[bot]` };
}

async function assertRegistrationHeadOwnedByApp(
  github: OperatorGitHubRequester,
  repository: { owner: string; repo: string },
  headSha: string
): Promise<void> {
  const actor = await expectedRegistrationActor(github);
  const commit = record((await github.request("GET /repos/{owner}/{repo}/commits/{ref}", {
    ...repository,
    ref: headSha
  })).data, "managed registration commit actor");
  const author = record(commit.author, "managed registration commit author");
  if (String(author.login || "").toLowerCase() !== actor.login.toLowerCase() || author.type !== "Bot") {
    throw new ManagedRegistrationTrustViolation("managed registration branch head is not owned by the expected GitHub App");
  }
}

async function registrationCommit(
  github: OperatorGitHubRequester,
  repository: { owner: string; repo: string },
  sha: string
): Promise<{ treeSha: string; parents: string[] }> {
  const commit = record((await github.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
    ...repository,
    commit_sha: sha
  })).data, "managed registration commit");
  const parents = array(commit.parents, "managed registration commit parents").map((parent) =>
    exactCommit(record(parent, "managed registration commit parent").sha, "managed registration parent SHA")
  );
  return {
    treeSha: exactCommit(record(commit.tree, "managed registration commit tree").sha, "managed registration tree SHA"),
    parents
  };
}

function registrationTitle(target: string): string {
  return `Register ${target} for DarkFactory management`;
}

function registrationProvenance(
  baseSha: string,
  headSha: string,
  target: string,
  content: string
): RegistrationProvenance {
  return {
    baseSha,
    headSha,
    target,
    contentDigest: createHash("sha256").update(content).digest("hex")
  };
}

function registrationProvenanceMarker(provenance: RegistrationProvenance): string {
  return `${REGISTRATION_PROVENANCE_PREFIX} schema=1 target=${provenance.target} base=${provenance.baseSha} head=${provenance.headSha} content-sha256=${provenance.contentDigest} -->`;
}

function parseRegistrationProvenance(body: unknown): RegistrationProvenance | null {
  if (typeof body !== "string") return null;
  const candidates = body.match(/<!-- darkfactory:managed-registration\b(?!-pr)[^>]*-->/g) ?? [];
  if (candidates.length === 0) return null;
  if (candidates.length !== 1) throw new ManagedRegistrationTrustViolation("managed registration pull request contains ambiguous provenance");
  const match = /^<!-- darkfactory:managed-registration schema=1 target=([a-z0-9_.-]+\/[a-z0-9_.-]+) base=([0-9a-f]{40}) head=([0-9a-f]{40}) content-sha256=([0-9a-f]{64}) -->$/.exec(candidates[0]);
  if (!match) throw new ManagedRegistrationTrustViolation("managed registration pull request provenance is malformed");
  return { target: match[1], baseSha: match[2], headSha: match[3], contentDigest: match[4] };
}

function registrationPullRequestBody(target: string, provenance: RegistrationProvenance): string {
  return [
    REGISTRATION_PR_MARKER,
    registrationProvenanceMarker(provenance),
    legacyRegistrationPullRequestBody(target)
  ].join("\n");
}

function legacyRegistrationPullRequestBody(target: string): string {
  return [
    "## Summary",
    "",
    `- register \`${target}\` as an active managed code repository`,
    "- preserve every existing lifecycle entry exactly",
    "",
    "## Safety",
    "",
    "This reviewed source-policy change does not touch the target repository or override parked/archived state."
  ].join("\n");
}

function replaceRegistrationProvenance(
  body: string,
  provenance: RegistrationProvenance,
  target: string
): string {
  const existing = body.match(/<!-- darkfactory:managed-registration\b(?!-pr)[^>]*-->/g) ?? [];
  if (existing.length > 1) throw new ManagedRegistrationTrustViolation("managed registration pull request contains ambiguous provenance");
  const marker = registrationProvenanceMarker(provenance);
  if (existing.length === 1) return body.replace(existing[0], marker);
  if (body.split(REGISTRATION_PR_MARKER).length === 2) {
    return body.replace(REGISTRATION_PR_MARKER, `${REGISTRATION_PR_MARKER}\n${marker}`);
  }
  return registrationPullRequestBody(target, provenance);
}

function registrationContentForTarget(baseContent: string, target: string): string {
  const registry = parseRegistry(baseContent);
  if (findEntry(registry.repositories, target)) {
    throw new ManagedRegistrationTrustViolation("managed registration provenance base already contains the target entry");
  }
  const next = structuredClone(registry);
  next.repositories[target] = {
    state: "active",
    kind: "code",
    note: "Managed code repository admitted through the reviewed df setup registration lane."
  };
  return `${JSON.stringify(sortRegistry(next), null, 2)}\n`;
}

function registrationPullReference(value: unknown): { number: number; url: string } {
  const pull = record(value, "managed registration pull request reference");
  if (!Number.isInteger(pull.number) || pull.number <= 0) {
    throw new ManagedRegistrationTrustViolation("managed registration pull request number is invalid");
  }
  return {
    number: pull.number,
    url: requiredText(pull.html_url, "managed registration pull request URL")
  };
}

function requiredBranchRef(value: string | null, branch: string): string {
  if (!value) throw new ManagedRegistrationTrustViolation(`managed registration branch ${branch} is not observable`);
  return value;
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
