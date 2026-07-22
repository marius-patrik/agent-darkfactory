import { createHash } from "node:crypto";

import type { OperatorGitHubRequester } from "./clean-evidence.js";
import type { SetupReceipt } from "./setup.js";

export const MANAGED_REGISTRY_REPOSITORY = "marius-patrik/private-data";
export const MANAGED_REGISTRY_PATH = "managed-repository/.agents/managed-repos.json";
const REGISTRATION_PR_MARKER = "<!-- darkfactory:managed-registration-pr -->";
const REGISTRATION_PROVENANCE_PREFIX = "<!-- darkfactory:managed-registration";
const REGISTRATION_GATE_APP_ID = 15368;
const REGISTRATION_VALIDATE_CHECK = "Validate";
const REGISTRATION_REVIEW_CHECK = "DarkFactory Autoreview";
const REGISTRATION_NOTE = "Managed code repository admitted through the reviewed df setup registration lane.";

interface RegistrationProvenance {
  baseSha: string;
  headSha: string;
  target: string;
  contentDigest: string;
}

interface RegistrationPullAdmission {
  provenanceBaseSha: string;
  provenanceHeadSha: string;
  provenanceContent: string;
  allowLegacyProvenance: boolean;
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
  const registryRepository = { owner: "marius-patrik", repo: "private-data" };
  const metadata = record((await github.request("GET /repos/{owner}/{repo}", registryRepository)).data, "private-data metadata");
  if (metadata.private !== true || metadata.default_branch !== "main" || metadata.archived === true || metadata.disabled === true) {
    throw new Error("canonical managed registry authority must remain the private, writable private-data main repository");
  }

  const mainRef = record((await github.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
    ...registryRepository,
    ref: "heads/main"
  })).data, "private-data main ref");
  const mainObject = record(mainRef.object, "private-data main ref object");
  const mainHead = exactCommit(mainObject.sha, "private-data main head");
  const mainFile = await registrationFileAt(github, registryRepository, mainHead);
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
        detail: "Canonical private-data source already declares this code repository active."
      }
    };
  }

  const branch = `darkfactory/register-${target.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
  const next = structuredClone(registry);
  next.repositories[target] = managedRegistrationEntry();
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
  let pullAdmission: RegistrationPullAdmission | null = null;

  if (pull && !branchHead) throw new Error("managed registration pull request exists without its exact source branch");
  if (!branchHead) {
    const admittedMain = requiredBranchRef(await optionalBranchRef(github, registryRepository, "main"), "main");
    if (admittedMain !== mainHead) {
      throw new ManagedRegistrationTrustViolation("canonical managed registry main advanced before branch creation; no mutation was authorized");
    }
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
    pullAdmission = convergence.pullAdmission;
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
    if (!pullAdmission || typeof pull.body !== "string") {
      throw new ManagedRegistrationTrustViolation("managed registration recovery is missing its exact admitted pull request state");
    }
    const admittedBody = pull.body;
    pull = record((await github.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      ...registryRepository,
      pull_number: pullReference.number
    })).data, "managed registration pull request immediately before provenance update");
    const currentBody = typeof pull.body === "string" ? pull.body : null;
    if (currentBody === null || currentBody !== admittedBody) {
      throw new ManagedRegistrationTrustViolation("managed registration pull request body changed after admission; preserved the concurrent edit and blocked provenance update");
    }
    await assertRegistrationPullRequest(
      github,
      registryRepository,
      pull,
      branch,
      branchHead,
      mainHead,
      target,
      content,
      {
        branchBaseSha: mainHead,
        provenanceBaseSha: pullAdmission.provenanceBaseSha,
        provenanceHeadSha: pullAdmission.provenanceHeadSha,
        provenanceContent: pullAdmission.provenanceContent,
        allowLegacyProvenance: pullAdmission.allowLegacyProvenance
      }
    );
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
    return completeManagedRegistrationPullRequest(
      github,
      registryRepository,
      pullReference,
      pull,
      branch,
      branchHead,
      mainHead,
      target,
      content,
      changed
    );
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
  return completeManagedRegistrationPullRequest(
    github,
    registryRepository,
    createdReference,
    createdPull,
    branch,
    branchHead,
    mainHead,
    target,
    content,
    true
  );
}

async function completeManagedRegistrationPullRequest(
  github: OperatorGitHubRequester,
  repository: { owner: string; repo: string },
  reference: { number: number; url: string },
  pull: Record<string, any>,
  branch: string,
  headSha: string,
  mainHead: string,
  target: string,
  content: string,
  changed: boolean
): Promise<ManagedRegistrationResult> {
  const firstGate = await registrationCompletionGate(github, repository, headSha);
  if (!firstGate.ready) return pendingRegistrationResult(target, reference.url, changed, firstGate.detail);

  const observedMain = requiredBranchRef(await optionalBranchRef(github, repository, "main"), "main");
  if (observedMain !== mainHead) {
    return pendingRegistrationResult(target, reference.url, changed, "Canonical main advanced before merge admission; the next setup pass must regenerate the exact branch.");
  }
  pull = record((await github.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    ...repository,
    pull_number: reference.number
  })).data, "managed registration pull request before merge admission");
  await assertRegistrationPullRequest(github, repository, pull, branch, headSha, mainHead, target, content);
  const mergeability = registrationMergeability(pull);
  if (mergeability === "pending") {
    return pendingRegistrationResult(target, reference.url, changed, "GitHub has not finished computing mergeability for the exact registration head.");
  }

  const finalGate = await registrationCompletionGate(github, repository, headSha);
  if (!finalGate.ready) return pendingRegistrationResult(target, reference.url, changed, finalGate.detail);
  const admittedMain = requiredBranchRef(await optionalBranchRef(github, repository, "main"), "main");
  const admittedPull = record((await github.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    ...repository,
    pull_number: reference.number
  })).data, "managed registration pull request immediately before merge");
  if (admittedMain !== mainHead) {
    return pendingRegistrationResult(target, reference.url, changed, "Canonical main advanced during merge admission; no merge was attempted.");
  }
  await assertRegistrationPullRequest(github, repository, admittedPull, branch, headSha, mainHead, target, content);
  if (registrationMergeability(admittedPull) !== "ready") {
    return pendingRegistrationResult(target, reference.url, changed, "Exact registration mergeability changed during admission; no merge was attempted.");
  }

  const merged = record((await github.request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge", {
    ...repository,
    pull_number: reference.number,
    sha: headSha,
    merge_method: "squash",
    commit_title: `Register ${target} for DarkFactory management`
  })).data, "managed registration merge response");
  if (merged.merged !== true) {
    throw new ManagedRegistrationTrustViolation(`managed registration merge was rejected: ${requiredText(merged.message, "managed registration merge message")}`);
  }
  const mergeSha = exactCommit(merged.sha, "managed registration merge SHA");
  const mergedPull = record((await github.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    ...repository,
    pull_number: reference.number
  })).data, "merged managed registration pull request");
  await assertMergedRegistrationPullRequest(github, repository, mergedPull, branch, headSha, mainHead, mergeSha, target);

  const landedMain = requiredBranchRef(await optionalBranchRef(github, repository, "main"), "main");
  if (landedMain !== mergeSha) await assertRegistrationBaseAdvance(github, repository, mergeSha, landedMain);
  const landedFile = await registrationFileAt(github, repository, landedMain);
  const landedRegistry = parseRegistry(landedFile.content);
  const landedEntry = findEntry(landedRegistry.repositories, target);
  if (!landedEntry || !isExactManagedRegistrationEntry(landedEntry.value)) {
    throw new ManagedRegistrationTrustViolation("managed registration merge did not leave the exact active target entry on canonical main");
  }
  return {
    sourceActive: true,
    receipt: {
      action: "managed-registration-merge",
      target,
      status: "applied",
      detail: `Merged ${reference.url} at ${mergeSha} after exact App-bound Validate and ${finalGate.reviewCheck} evidence.`
    }
  };
}

function pendingRegistrationResult(
  target: string,
  url: string,
  changed: boolean,
  detail: string
): ManagedRegistrationResult {
  return {
    sourceActive: false,
    receipt: {
      action: "managed-registration-pr",
      target,
      status: changed ? "applied" : "current",
      detail: `${url}: ${detail}`
    }
  };
}

function registrationMergeability(pull: Record<string, any>): "ready" | "pending" {
  if (pull.mergeable === null || pull.mergeable_state === "unknown") return "pending";
  if (pull.mergeable !== true || !["clean", "unstable", "has_hooks"].includes(String(pull.mergeable_state || ""))) {
    throw new ManagedRegistrationTrustViolation(`managed registration pull request is not safely mergeable (${String(pull.mergeable_state || "unknown")})`);
  }
  return "ready";
}

async function assertMergedRegistrationPullRequest(
  github: OperatorGitHubRequester,
  repository: { owner: string; repo: string },
  pull: Record<string, any>,
  branch: string,
  headSha: string,
  baseSha: string,
  mergeSha: string,
  target: string
): Promise<void> {
  const actor = await expectedRegistrationActor(github);
  const mergedBy = record(pull.merged_by, "managed registration merged actor");
  const base = record(pull.base, "merged managed registration base");
  const head = record(pull.head, "merged managed registration head");
  if (
    pull.state !== "closed"
    || pull.merged !== true
    || typeof pull.merged_at !== "string"
    || pull.merge_commit_sha !== mergeSha
    || pull.title !== registrationTitle(target)
    || base.ref !== "main"
    || base.sha !== baseSha
    || head.ref !== branch
    || head.sha !== headSha
    || String(mergedBy.login || "").toLowerCase() !== actor.login.toLowerCase()
    || mergedBy.type !== "Bot"
  ) {
    throw new ManagedRegistrationTrustViolation("managed registration merge evidence is not the exact App-owned admitted pull request");
  }
}

interface RegistrationCheckRun {
  id: number;
  name: string;
  headSha: string;
  status: string;
  conclusion: string | null;
  appId: number | null;
}

async function registrationCompletionGate(
  github: OperatorGitHubRequester,
  repository: { owner: string; repo: string },
  headSha: string
): Promise<{ ready: boolean; detail: string; reviewCheck: string }> {
  const checks = await readRegistrationCheckRuns(github, repository, headSha);
  const latest = new Map<string, RegistrationCheckRun>();
  for (const check of checks) {
    const current = latest.get(check.name);
    if (!current || check.id > current.id) latest.set(check.name, check);
  }
  for (const check of latest.values()) {
    if (check.status !== "completed") {
      return { ready: false, detail: `Latest ${check.name} check is still ${check.status}.`, reviewCheck: "" };
    }
    if (!["success", "skipped", "neutral"].includes(String(check.conclusion || ""))) {
      throw new ManagedRegistrationTrustViolation(`latest ${check.name} check is not green (${String(check.conclusion || "unknown")})`);
    }
  }
  const validate = latest.get(REGISTRATION_VALIDATE_CHECK);
  if (!validate) {
    return { ready: false, detail: "Waiting for the exact App-bound Validate check on the registration head.", reviewCheck: "" };
  }
  assertGreenRegistrationGate(validate, REGISTRATION_VALIDATE_CHECK);
  const review = latest.get(REGISTRATION_REVIEW_CHECK);
  if (!review) {
    return { ready: false, detail: "Waiting for the exact App-bound DarkFactory Autoreview check on the registration head.", reviewCheck: "" };
  }
  assertGreenRegistrationGate(review, REGISTRATION_REVIEW_CHECK);
  return { ready: true, detail: "Exact App-bound Validate and DarkFactory Autoreview checks are green.", reviewCheck: REGISTRATION_REVIEW_CHECK };
}

function assertGreenRegistrationGate(check: RegistrationCheckRun, name: string): void {
  if (
    check.appId !== REGISTRATION_GATE_APP_ID
    || check.status !== "completed"
    || check.conclusion !== "success"
  ) {
    throw new ManagedRegistrationTrustViolation(`registration gate ${name} is not exact green App-bound evidence`);
  }
}

async function readRegistrationCheckRuns(
  github: OperatorGitHubRequester,
  repository: { owner: string; repo: string },
  headSha: string
): Promise<RegistrationCheckRun[]> {
  const checks: RegistrationCheckRun[] = [];
  const seenIds = new Set<number>();
  let expectedTotal: number | null = null;
  for (let page = 1; page <= 10; page += 1) {
    const payload = record((await github.request("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", {
      ...repository,
      ref: headSha,
      filter: "latest",
      per_page: 100,
      page
    })).data, "managed registration check runs");
    const rawChecks = array(payload.check_runs, "managed registration check run list");
    if (!Number.isInteger(payload.total_count) || payload.total_count < 0) {
      throw new ManagedRegistrationTrustViolation("managed registration check total is malformed");
    }
    const pageTotal = Number(payload.total_count);
    if (expectedTotal === null) {
      expectedTotal = pageTotal;
    } else if (pageTotal !== expectedTotal) {
      throw new ManagedRegistrationTrustViolation("managed registration check total changed during pagination");
    }
    if (rawChecks.length > 100 || checks.length + rawChecks.length > expectedTotal) {
      throw new ManagedRegistrationTrustViolation("managed registration check inventory exceeds its declared total");
    }
    for (const raw of rawChecks) {
      const check = record(raw, "managed registration check run");
      const app = check.app === null || check.app === undefined ? null : record(check.app, "managed registration check App");
      const normalized: RegistrationCheckRun = {
        id: Number(check.id),
        name: requiredText(check.name, "managed registration check name"),
        headSha: exactCommit(check.head_sha, "managed registration check head"),
        status: requiredText(check.status, "managed registration check status"),
        conclusion: check.conclusion === null ? null : requiredText(check.conclusion, "managed registration check conclusion"),
        appId: app && Number.isInteger(app.id) ? Number(app.id) : null
      };
      if (!Number.isInteger(normalized.id) || normalized.id <= 0 || normalized.headSha !== headSha) {
        throw new ManagedRegistrationTrustViolation("managed registration check identity is malformed or stale");
      }
      if (seenIds.has(normalized.id)) {
        throw new ManagedRegistrationTrustViolation("managed registration check inventory contains a duplicate check id");
      }
      seenIds.add(normalized.id);
      checks.push(normalized);
    }
    if (checks.length === expectedTotal) return checks;
    if (rawChecks.length < 100) {
      throw new ManagedRegistrationTrustViolation("managed registration check inventory ended before its declared total");
    }
  }
  throw new ManagedRegistrationTrustViolation("managed registration check inventory exceeded its bounded complete scan");
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
): Promise<{
  headSha: string;
  changed: boolean;
  pull: Record<string, any> | null;
  pullAdmission: RegistrationPullAdmission | null;
}> {
  try {
    await assertRegistrationBranch(github, repository, mainHead, branchHead, branch, content);
    let allowLegacyProvenance = false;
    if (pull) {
      try {
        await assertRegistrationPullRequest(
          github,
          repository,
          pull,
          branch,
          branchHead,
          mainHead,
          target,
          content
        );
      } catch (error) {
        if (!(error instanceof ManagedRegistrationTrustViolation) || parseRegistrationProvenance(pull.body)) throw error;
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
        allowLegacyProvenance = true;
      }
    }
    return {
      headSha: branchHead,
      changed: false,
      pull,
      pullAdmission: pull ? {
        provenanceBaseSha: mainHead,
        provenanceHeadSha: branchHead,
        provenanceContent: content,
        allowLegacyProvenance
      } : null
    };
  } catch (error) {
    if (!(error instanceof ManagedRegistrationTrustViolation)) throw error;
  }

  const branchCommit = await registrationCommit(github, repository, branchHead);
  const priorProvenance = parseRegistrationProvenance(pull?.body);
  let admittedBaseSha: string;
  let pullAdmission: RegistrationPullAdmission | null = null;

  if (priorProvenance && priorProvenance.headSha !== branchHead) {
    if (
      priorProvenance.target !== target
      || branchCommit.parents.length !== 2
      || branchCommit.parents[0] !== priorProvenance.headSha
    ) {
      throw unknownRegistrationRecoveryState(branch);
    }
    const interruptedBaseSha = branchCommit.parents[1];
    const priorFile = await registrationFileAt(github, repository, priorProvenance.baseSha);
    const priorContent = registrationContentForTarget(priorFile.content, target);
    await assertRegistrationBranch(github, repository, priorProvenance.baseSha, priorProvenance.headSha, branch, priorContent);
    await assertRegistrationBaseAdvance(github, repository, priorProvenance.baseSha, interruptedBaseSha);
    const interruptedFile = await registrationFileAt(github, repository, interruptedBaseSha);
    const interruptedContent = registrationContentForTarget(interruptedFile.content, target);
    await assertRegistrationBranch(github, repository, interruptedBaseSha, branchHead, branch, interruptedContent);
    if (pull) {
      await assertRegistrationPullRequest(
        github,
        repository,
        pull,
        branch,
        branchHead,
        mainHead,
        target,
        interruptedContent,
        {
          branchBaseSha: interruptedBaseSha,
          provenanceBaseSha: priorProvenance.baseSha,
          provenanceHeadSha: priorProvenance.headSha,
          provenanceContent: priorContent
        }
      );
    }
    admittedBaseSha = interruptedBaseSha;
    pullAdmission = pull ? {
      provenanceBaseSha: priorProvenance.baseSha,
      provenanceHeadSha: priorProvenance.headSha,
      provenanceContent: priorContent,
      allowLegacyProvenance: false
    } : null;
  } else {
    const priorBase = priorProvenance?.baseSha
      ?? (branchCommit.parents.length === 1 ? branchCommit.parents[0] : null);
    if (
      !priorBase
      || priorBase === mainHead
      || (priorProvenance && priorProvenance.target !== target)
    ) {
      throw unknownRegistrationRecoveryState(branch);
    }
    const priorFile = await registrationFileAt(github, repository, priorBase);
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
        {
          provenanceBaseSha: priorBase,
          allowLegacyProvenance: priorProvenance === null
        }
      );
    }
    admittedBaseSha = priorBase;
    pullAdmission = pull ? {
      provenanceBaseSha: priorBase,
      provenanceHeadSha: branchHead,
      provenanceContent: priorContent,
      allowLegacyProvenance: priorProvenance === null
    } : null;
  }

  if (admittedBaseSha === mainHead) {
    return { headSha: branchHead, changed: false, pull, pullAdmission };
  }
  await assertRegistrationBaseAdvance(github, repository, admittedBaseSha, mainHead);

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
  const recoveryCommit = await registrationCommit(github, repository, recoverySha);
  if (
    recoveryCommit.treeSha !== treeSha
    || recoveryCommit.parents.length !== 2
    || recoveryCommit.parents[0] !== branchHead
    || recoveryCommit.parents[1] !== mainHead
  ) {
    throw new ManagedRegistrationTrustViolation("managed registration recovery commit does not retain the exact admitted head and current-main parents");
  }
  await assertRegistrationBranch(github, repository, mainHead, recoverySha, branch, content);
  return { headSha: recoverySha, changed: true, pull, pullAdmission };
}

function unknownRegistrationRecoveryState(branch: string): ManagedRegistrationTrustViolation {
  return new ManagedRegistrationTrustViolation(
    `managed registration branch ${branch} contains unknown or conflicting work; setup preserved it and refused base-advance recovery`
  );
}

async function registrationFileAt(
  github: OperatorGitHubRequester,
  repository: { owner: string; repo: string },
  ref: string
): Promise<{ sha: string; content: string }> {
  return registryFile(await github.request("GET /repos/{owner}/{repo}/contents/{path}", {
    ...repository,
    path: MANAGED_REGISTRY_PATH,
    ref
  }));
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
  options: {
    branchBaseSha?: string;
    provenanceBaseSha?: string;
    provenanceHeadSha?: string;
    provenanceContent?: string;
    allowLegacyProvenance?: boolean;
  } = {}
): Promise<void> {
  const actor = await expectedRegistrationActor(github);
  const base = record(pull.base, "managed registration pull request base");
  const head = record(pull.head, "managed registration pull request head");
  const user = record(pull.user, "managed registration pull request actor");
  const baseRepository = record(base.repo, "managed registration pull request base repository");
  const headRepository = record(head.repo, "managed registration pull request head repository");
  const provenance = registrationProvenance(
    options.provenanceBaseSha ?? observedBaseSha,
    options.provenanceHeadSha ?? headSha,
    target,
    options.provenanceContent ?? content
  );
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
  await assertRegistrationBranch(
    github,
    repository,
    options.branchBaseSha ?? options.provenanceBaseSha ?? observedBaseSha,
    headSha,
    branch,
    content
  );
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
  next.repositories[target] = managedRegistrationEntry();
  return `${JSON.stringify(sortRegistry(next), null, 2)}\n`;
}

function managedRegistrationEntry(): Record<string, string> {
  return { state: "active", kind: "code", note: REGISTRATION_NOTE };
}

function isExactManagedRegistrationEntry(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return Object.keys(entry).sort().join(",") === "kind,note,state"
    && entry.state === "active"
    && entry.kind === "code"
    && entry.note === REGISTRATION_NOTE;
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
