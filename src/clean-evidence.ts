import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  AUTOREVIEW_RESULT_MARKER,
  AUTOREVIEW_TARGET_VERSION_MARKER_PREFIX,
  isTrustedDarkFactoryComment,
  issueVersion,
  resolveEffectiveIssueContent
} from "./issue-spec.js";

import {
  buildCleanPlan,
  stableHash,
  verifyCleanPlanAdmission,
  type CleanBranchEvidence,
  type CleanEvidence,
  type CleanPlan,
  type CleanPlanEntry,
  type CleanWorktreeEvidence,
  type DoctorFinding,
  type PullRequestClassification
} from "./operator.js";

const AUTOREVIEW_CHECK_NAME = "DarkFactory Autoreview";
const TRUSTED_ACTIONS_APP_ID = 15368;
const AUTOREVIEW_WORKFLOW = "darkfactory-autoreview.yml";
const CLEAN_CLOSURE_MARKER = "<!-- darkfactory:clean-pr-closure";
const CLEAN_AUTOREVIEW_MARKER = "<!-- darkfactory:clean-autoreview";
const CLEAN_ISSUE_FOLD_MARKER = "<!-- darkfactory:clean-issue-fold";
const CLEAN_MARKER_ISSUE_CLOSURE = "<!-- darkfactory:clean-marker-issue-closure";
const CLEAN_ARTIFACT_MARKER = "<!-- darkfactory:clean-artifact";
const CLEAN_ARTIFACT_BRANCH_PREFIX = "darkfactory/clean-artifact-";
const MANAGED_LABEL_POLICY_PATH = ".darkfactory/labels.json";
const DASHBOARD_MARKER = "df-dashboard:orchestration";
const TRUSTED_ISSUE_ACTORS = new Set(["darkfactory-agent[bot]", "mp-agents[bot]"]);
const REQUIRED_PROTECTED_CHECKS = ["Validate", "DarkFactory Autoreview"] as const;
const EXACT_COMMIT = /^[0-9a-f]{40}$/;
const AUTOREVIEW_PENDING_MAX_AGE_MS = 3 * 60 * 60 * 1_000;
const ISSUE_VERSION = /^[0-9a-f]{64}$/;
const PULL_REQUEST_VERSION = /^[0-9a-f]{40}:[0-9a-f]{40}$/;

export interface OperatorGitHubRequester {
  request(route: string, parameters: Record<string, unknown>): Promise<{ data: unknown }>;
  graphql?(query: string, variables?: Record<string, unknown>): Promise<unknown>;
}

export interface RepositoryRef {
  owner: string;
  repo: string;
}

interface LocalCleanEvidence {
  worktreesByBranch: Map<string, CleanWorktreeEvidence[]>;
  rawWorktreeById: Map<string, string>;
  detachedWorktrees: CleanWorktreeEvidence[];
  localBranches: Map<string, {
    head: string;
    tree: string;
    ahead: number | null;
    unpublished: boolean;
    containedBy: string[];
    treeEquivalentTo: string[];
  }>;
  orphanRefs: CleanEvidence["orphanRefs"];
}

export async function collectCleanEvidence(
  github: OperatorGitHubRequester,
  repository: RepositoryRef,
  localPath = "",
  reviewFindings: DoctorFinding[] = []
): Promise<CleanEvidence> {
  const metadata = asRecord((await github.request("GET /repos/{owner}/{repo}", { ...repository })).data, "repository metadata");
  const defaultBranch = requiredString(metadata.default_branch, "repository default branch");
  const branches = await listPages(github, "GET /repos/{owner}/{repo}/branches", { ...repository });
  const pulls = await listPages(github, "GET /repos/{owner}/{repo}/pulls", { ...repository, state: "all", sort: "updated", direction: "desc" });
  const issues = await listPages(github, "GET /repos/{owner}/{repo}/issues", { ...repository, state: "open", sort: "updated", direction: "desc" });
  const comments = issues.length > 0
    ? await listPages(github, "GET /repos/{owner}/{repo}/issues/comments", { ...repository, sort: "created", direction: "asc" })
    : [];
  const commentsByIssue = groupIssueComments(comments);
  const branchRecords = branches.map((branch, index) => asRecord(branch, `branch ${index}`));
  const branchHeads = new Map<string, string>();
  for (const branch of branchRecords) {
    const name = requiredString(branch.name, "branch name");
    const commit = asRecord(branch.commit, `branch ${name} commit`);
    branchHeads.set(name, requiredString(commit.sha, `branch ${name} head`));
  }
  // Policy names remain immutable even when the corresponding remote ref is
  // missing. A local-only main/dev is recovery evidence, never cleanup.
  const policyBranchNames = new Set([defaultBranch, "main", "dev"]);
  const policyBranches = new Set([...policyBranchNames].filter((name) => branchHeads.has(name)));
  const trees = new Map<string, string>();
  for (const [name, head] of branchHeads) trees.set(name, await commitTree(github, repository, head));
  const local = localPath
    ? collectLocalEvidence(localPath, repository, branchHeads, trees, policyBranchNames)
    : emptyLocalEvidence();

  const normalizedPulls = pulls.map((pull, index) => normalizePull(pull, index, repository));
  const cleanBranches: CleanBranchEvidence[] = [];
  for (const branch of branchRecords) {
    const name = requiredString(branch.name, "branch name");
    const head = branchHeads.get(name)!;
    const openPull = normalizedPulls.find((pull) => pull.state === "open" && pull.headRef === name && pull.headSha === head && pull.sameRepository);
    const mergedPull = normalizedPulls.find((pull) => pull.merged && pull.headRef === name && pull.headSha === head && pull.sameRepository);
    const containedBy: string[] = [];
    for (const policy of policyBranches) {
      if (policy === name) continue;
      if (await isHeadContainedBy(github, repository, head, policy)) containedBy.push(policy);
    }
    const tree = trees.get(name)!;
    const treeEquivalentTo = [...policyBranches]
      .filter((policy) => policy !== name && trees.get(policy) === tree)
      .sort();
    const localBranch = local.localBranches.get(name);
    cleanBranches.push({
      name,
      head,
      tree,
      protected: branch.protected === true,
      policyBranch: policyBranchNames.has(name),
      openPullRequest: openPull?.number ?? null,
      mergedPullRequest: mergedPull?.number ?? null,
      mergedPullHead: mergedPull?.headSha ?? null,
      containedBy: containedBy.sort(),
      treeEquivalentTo,
      localAhead: localBranch?.ahead ?? null,
      localUnpublished: localBranch?.unpublished ?? false,
      worktrees: local.worktreesByBranch.get(name) ?? []
    });
  }

  const localBranches: CleanBranchEvidence[] = [...local.localBranches].map(([name, branch]) => {
    const openPull = normalizedPulls.find((pull) => pull.state === "open" && pull.headRef === name && pull.headSha === branch.head && pull.sameRepository);
    const mergedPull = normalizedPulls.find((pull) => pull.merged && pull.headRef === name && pull.headSha === branch.head && pull.sameRepository);
    return {
      name,
      head: branch.head,
      tree: branch.tree,
      protected: false,
      policyBranch: policyBranchNames.has(name),
      openPullRequest: openPull?.number ?? null,
      mergedPullRequest: mergedPull?.number ?? null,
      mergedPullHead: mergedPull?.headSha ?? null,
      containedBy: branch.containedBy,
      treeEquivalentTo: branch.treeEquivalentTo,
      localAhead: branch.ahead,
      localUnpublished: branch.unpublished,
      worktrees: local.worktreesByBranch.get(name) ?? []
    };
  });

  const stableReviewFindings = normalizeCleanReviewFindings(reviewFindings);
  const openPulls: CleanEvidence["pullRequests"] = [];
  for (const pull of normalizedPulls.filter((candidate) => candidate.state === "open")) {
    const findingIds = reviewFindings.filter((finding) => findingTouchesPull(finding, pull.number)).map((finding) => finding.id).sort();
    const claimedSuccessor = successorNumber(pull.body);
    let successor: CleanEvidence["pullRequests"][number]["successor"] = null;
    if (claimedSuccessor !== null && claimedSuccessor !== pull.number) {
      const candidate = normalizedPulls.find((entry) => entry.number === claimedSuccessor);
      if (
        candidate
        && pull.sameRepository
        && candidate.sameRepository
        && candidate.baseRef === pull.baseRef
        && (candidate.state === "open" || candidate.merged)
      ) {
        const comparison = await compareCommits(github, repository, pull.headSha, candidate.headSha);
        if (comparison.ancestor) {
          successor = successorEvidence(candidate, "head-ancestry");
        } else {
          const [pullTree, successorTree] = await Promise.all([
            commitTree(github, repository, pull.headSha),
            commitTree(github, repository, candidate.headSha)
          ]);
          if (pullTree === successorTree) successor = successorEvidence(candidate, "tree-equivalence");
        }
      }
    }
    openPulls.push({
      number: pull.number,
      version: pullVersion(pull),
      base: pull.baseRef,
      baseSha: pull.baseSha,
      headRef: pull.headRef,
      head: pull.headSha,
      classification: classifyPullRequest(findingIds, pull.body),
      findingIds,
      autoreview: await observePullAutoreview(github, repository, pull, commentsByIssue.get(pull.number) ?? []),
      successor
    });
  }
  const openIssues: CleanEvidence["issues"] = [];
  const effectiveIssues = new Map<number, {
    issue: Record<string, unknown>;
    comments: Record<string, unknown>[];
    effective: ReturnType<typeof resolveEffectiveIssueContent>;
    scope: IssueScopeEvidence;
  }>();
  for (const issue of issues.filter((candidate) => !asRecord(candidate, "issue").pull_request)) {
    const value = asRecord(issue, "issue");
    const number = requiredNumber(value.number, "issue number");
    const issueFindings = reviewFindings.filter((finding) => findingTouchesIssue(finding, number));
    const findingIds = issueFindings.map((finding) => finding.id).sort();
    const issueComments = commentsByIssue.get(number) ?? [];
    const effective = resolveEffectiveIssueContent(value, issueComments);
    const fingerprint = effective.version;
    const scope = issueScopeEvidence(effective.title, effective.body);
    effectiveIssues.set(number, { issue: value, comments: issueComments, effective, scope });
    if (ownedMarker(value) !== null) continue;
    openIssues.push({
      number,
      fingerprint,
      classification: findingIds.length ? "finding" as const : "current" as const,
      findingIds,
      reviewable: issueFindings.length > 0 && issueFindings.every((finding) => finding.repair_class === "pr"),
      autoreview: observeIssueAutoreview(issueComments, fingerprint),
      scopeDigest: scope.digest
    });
  }
  assignIssueFoldEvidence(openIssues, stableReviewFindings, effectiveIssues);
  const findingSetFingerprint = cleanFindingSetFingerprint(stableReviewFindings);
  const markerIssues = collectMarkerIssueEvidence(effectiveIssues, stableReviewFindings, repository, findingSetFingerprint);
  const artifactRepairs = await collectArtifactRepairEvidence(github, repository, branchHeads, normalizedPulls, stableReviewFindings);
  const managedLabels = await collectManagedLabelEvidence(github, repository, branchHeads, stableReviewFindings);

  const prdFingerprint = await contentFingerprint(github, repository, "PRD.md", defaultBranch);
  return {
    repository: `${repository.owner}/${repository.repo}`,
    defaultBranch,
    observedRefs: Object.fromEntries([...branchHeads].filter(([name]) => policyBranches.has(name)).sort(([a], [b]) => a.localeCompare(b))),
    branches: cleanBranches.sort((a, b) => a.name.localeCompare(b.name)),
    localBranches: localBranches.sort((a, b) => a.name.localeCompare(b.name)),
    orphanRefs: local.orphanRefs,
    detachedWorktrees: local.detachedWorktrees,
    pullRequests: openPulls.sort((a, b) => a.number - b.number),
    issues: openIssues.sort((a, b) => a.number - b.number),
    reviewFindings: stableReviewFindings,
    pullRequestFingerprint: stableHash(normalizedPulls.map((pull) => ({
      number: pull.number,
      state: pull.state,
      merged: pull.merged,
      headRef: pull.headRef,
      headSha: pull.headSha,
      baseRef: pull.baseRef,
      baseSha: pull.baseSha,
      body: pull.body,
      sameRepository: pull.sameRepository,
      trustedActor: pull.trustedActor,
      autoMerge: pull.autoMerge,
      updatedAt: pull.updatedAt
    }))),
    issueLaneFingerprint: stableHash(openIssues.map((issue) => ({
      number: issue.number,
      version: issue.fingerprint,
      autoreview: issue.autoreview,
      findingIds: issue.findingIds,
      scopeDigest: issue.scopeDigest,
      fold: issue.fold
    }))),
    prdFingerprint,
    artifactRepairs,
    managedLabels,
    markerIssues
  };
}

function normalizeCleanReviewFindings(reviewFindings: DoctorFinding[]): CleanEvidence["reviewFindings"] {
  return reviewFindings.map((finding) => ({
    id: finding.id,
    category: finding.category,
    severity: finding.severity,
    repairClass: finding.repair_class,
    message: finding.message,
    evidence: finding.evidence || [],
    fingerprint: stableHash({
      id: finding.id,
      category: finding.category,
      severity: finding.severity,
      repairClass: finding.repair_class,
      message: finding.message,
      evidence: finding.evidence || [],
      repair: finding.repair || []
    })
  })).sort((a, b) => a.id.localeCompare(b.id));
}

function cleanFindingSetFingerprint(findings: CleanEvidence["reviewFindings"]): string {
  return stableHash(findings.map((finding) => ({ id: finding.id, fingerprint: finding.fingerprint })));
}

interface IssueScopeEvidence {
  title: string;
  lines: string[];
  digest: string;
}

function issueScopeEvidence(title: string, body: string): IssueScopeEvidence {
  const normalizedTitle = normalizeScopeLine(title);
  const lines = [...new Set(body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map(normalizeScopeLine)
    .filter((line) => line && !/^(?:[-*]\s*)?(?:status\s*:\s*)?superseded[- ]by\s*:/i.test(line)))]
    .sort();
  return { title: normalizedTitle, lines, digest: stableHash({ title: normalizedTitle, lines }) };
}

function normalizeScopeLine(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function issueScopeContains(source: IssueScopeEvidence, successor: IssueScopeEvidence): boolean {
  if (!source.title || source.title !== successor.title || source.lines.length === 0) return false;
  const successorLines = new Set(successor.lines);
  return source.lines.every((line) => successorLines.has(line));
}

function assignIssueFoldEvidence(
  issues: CleanEvidence["issues"],
  findings: CleanEvidence["reviewFindings"],
  effectiveIssues: Map<number, { scope: IssueScopeEvidence }>
): void {
  const issuesByNumber = new Map(issues.map((issue) => [issue.number, issue]));
  const proposals = new Map<number, Array<{
    findingId: string;
    findingFingerprint: string;
    successorNumber: number;
    successorVersion: string;
    sourceScopeDigest: string;
    successorScopeDigest: string;
    proof: "line-containment-v1";
  }>>();
  const groups: Array<{ sources: number[] }> = [];

  for (const finding of findings) {
    const match = /^duplicate-issue-contract-(\d+(?:-\d+)+)$/.exec(finding.id);
    if (!match) continue;
    const numbers = [...new Set(match[1].split("-").map(Number))].sort((a, b) => a - b);
    if (numbers.length < 2 || numbers.some((number) => !Number.isSafeInteger(number) || !issuesByNumber.has(number) || !effectiveIssues.has(number))) continue;
    const completeSuccessors = numbers.filter((candidateNumber) => {
      const candidate = effectiveIssues.get(candidateNumber)!.scope;
      return numbers.every((sourceNumber) => issueScopeContains(effectiveIssues.get(sourceNumber)!.scope, candidate));
    });
    const successorNumber = completeSuccessors[0];
    if (successorNumber === undefined) continue;
    const successor = issuesByNumber.get(successorNumber)!;
    const successorScope = effectiveIssues.get(successorNumber)!.scope;
    const sources = numbers.filter((number) => number !== successorNumber);
    groups.push({ sources });
    for (const sourceNumber of sources) {
      const sourceScope = effectiveIssues.get(sourceNumber)!.scope;
      const proposal = {
        findingId: finding.id,
        findingFingerprint: finding.fingerprint,
        successorNumber,
        successorVersion: successor.fingerprint,
        sourceScopeDigest: sourceScope.digest,
        successorScopeDigest: successorScope.digest,
        proof: "line-containment-v1" as const
      };
      proposals.set(sourceNumber, [...(proposals.get(sourceNumber) ?? []), proposal]);
    }
  }

  for (const group of groups) {
    if (group.sources.some((number) => (proposals.get(number) ?? []).length !== 1)) continue;
    for (const sourceNumber of group.sources) issuesByNumber.get(sourceNumber)!.fold = proposals.get(sourceNumber)![0];
  }
}

function collectMarkerIssueEvidence(
  effectiveIssues: Map<number, {
    issue: Record<string, unknown>;
    effective: ReturnType<typeof resolveEffectiveIssueContent>;
  }>,
  findings: CleanEvidence["reviewFindings"],
  repository: RepositoryRef,
  findingSetFingerprint: string
): NonNullable<CleanEvidence["markerIssues"]> {
  const currentFindingIds = new Set(findings.map((finding) => finding.id));
  const repositorySlug = cleanSlug(`${repository.owner}-${repository.repo}`);
  const doctorPrefix = `df-doctor:${repositorySlug}:`;
  const doctors = new Map<string, Array<{ number: number; version: string }>>();
  const dashboards: Array<{ number: number; version: string; updatedAt: number }> = [];
  const legacy: Array<{ number: number; version: string }> = [];

  for (const [number, observed] of effectiveIssues) {
    const marker = ownedMarker(observed.issue);
    if (!marker) continue;
    if (marker.kind === "doctor" && marker.value.startsWith(doctorPrefix)) {
      doctors.set(marker.value, [...(doctors.get(marker.value) ?? []), { number, version: observed.effective.version }]);
    } else if (marker.kind === "dashboard") {
      const updatedAt = timestamp(observed.issue.updated_at);
      if (updatedAt > 0) dashboards.push({ number, version: observed.effective.version, updatedAt });
    } else if (marker.kind === "legacy-audit" && marker.value === `df-audit:${repositorySlug}`) {
      legacy.push({ number, version: observed.effective.version });
    }
  }

  const result: NonNullable<CleanEvidence["markerIssues"]> = [];
  for (const [marker, matches] of doctors) {
    const ordered = [...matches].sort((a, b) => a.number - b.number);
    const findingId = marker.slice(doctorPrefix.length);
    if (!currentFindingIds.has(findingId)) {
      for (const issue of ordered) result.push({ ...issue, marker, reason: "resolved-doctor", findingSetFingerprint });
      continue;
    }
    const successor = ordered[0];
    for (const issue of ordered.slice(1)) {
      result.push({ ...issue, marker, reason: "duplicate-doctor", findingSetFingerprint, successor });
    }
  }
  for (const issue of legacy.sort((a, b) => a.number - b.number)) {
    result.push({ ...issue, marker: `df-audit:${repositorySlug}`, reason: "legacy-audit", findingSetFingerprint });
  }
  if (dashboards.length > 1) {
    const ordered = [...dashboards].sort((a, b) => b.updatedAt - a.updatedAt || a.number - b.number);
    const successor = { number: ordered[0]!.number, version: ordered[0]!.version };
    for (const issue of ordered.slice(1)) {
      result.push({ number: issue.number, version: issue.version, marker: DASHBOARD_MARKER, reason: "duplicate-dashboard", findingSetFingerprint, successor });
    }
  }
  return result.sort((a, b) => a.number - b.number);
}

function ownedMarker(issue: Record<string, unknown>): { kind: "doctor" | "dashboard" | "legacy-audit"; value: string } | null {
  const user = issue.user && typeof issue.user === "object" && !Array.isArray(issue.user) ? issue.user as Record<string, unknown> : {};
  if (user.type !== "Bot" || typeof user.login !== "string" || !TRUSTED_ISSUE_ACTORS.has(user.login)) return null;
  const body = typeof issue.body === "string" ? issue.body : "";
  const matches = [
    ...[...body.matchAll(/<!--\s*(df-doctor:[a-z0-9-]+:[a-z0-9-]+)\s*-->/gi)].map((match) => ({ kind: "doctor" as const, value: match[1]!.toLowerCase() })),
    ...[...body.matchAll(/<!--\s*(df-audit:[a-z0-9-]+)\s*-->/gi)].map((match) => ({ kind: "legacy-audit" as const, value: match[1]!.toLowerCase() })),
    ...[...body.matchAll(/<!--\s*(df-dashboard:orchestration)\s*-->/gi)].map((match) => ({ kind: "dashboard" as const, value: match[1]!.toLowerCase() }))
  ];
  return matches.length === 1 ? matches[0]! : null;
}

async function collectArtifactRepairEvidence(
  github: OperatorGitHubRequester,
  repository: RepositoryRef,
  branchHeads: Map<string, string>,
  pulls: ReturnType<typeof normalizePull>[],
  findings: CleanEvidence["reviewFindings"]
): Promise<NonNullable<CleanEvidence["artifactRepairs"]>> {
  const candidates = findings.flatMap((finding) => {
    const match = /^Generated\/runtime artifact `([^`]+)` is committed\.$/.exec(finding.message);
    return match && finding.category === "repository hygiene" && finding.repairClass === "pr"
      ? [{ finding, path: match[1]! }]
      : [];
  });
  const baseSha = branchHeads.get("dev");
  if (candidates.length === 0 || !baseSha || !EXACT_COMMIT.test(baseSha)) return [];
  const tree = await readCompleteTree(github, repository, baseSha);
  const entries = new Map(tree.map((entry) => [entry.path, entry]));
  const repairs: NonNullable<CleanEvidence["artifactRepairs"]> = [];

  for (const candidate of candidates) {
    if (!safeRepositoryPath(candidate.path)) continue;
    const conflicting = findings.some((finding) => finding.id !== candidate.finding.id
      && finding.message.includes(`\`${candidate.path}\``)
      && ["state boundary", "nested repository state"].includes(finding.category));
    if (conflicting) continue;
    const entry = entries.get(candidate.path);
    const mergedReceipt: NormalizedPull[] = [];
    for (const pull of exactArtifactPulls(pulls, candidate.finding.id, candidate.path, null, null).filter((pull) => pull.merged)) {
      const marker = parseArtifactMarker(pull.body)!;
      if (await artifactPullReceiptIsExact(github, repository, pull, marker)) mergedReceipt.push(pull);
    }
    if (!entry) {
      if (mergedReceipt.length !== 1) continue;
      const pull = mergedReceipt[0]!;
      const marker = parseArtifactMarker(pull.body)!;
      repairs.push({
        findingId: candidate.finding.id,
        findingFingerprint: candidate.finding.fingerprint,
        path: candidate.path,
        blobSha: marker.blobSha,
        mode: marker.mode,
        base: "dev",
        baseSha,
        branch: artifactBranch(candidate.finding.id, candidate.path, marker.blobSha, marker.baseSha),
        state: "resolved",
        pull: artifactPullEvidence(pull)
      });
      continue;
    }
    if (entry.type !== "blob" || !EXACT_COMMIT.test(entry.sha) || !isBlobMode(entry.mode)) continue;
    const branch = artifactBranch(candidate.finding.id, candidate.path, entry.sha, baseSha);
    const openReceipt: NormalizedPull[] = [];
    for (const pull of exactArtifactPulls(pulls, candidate.finding.id, candidate.path, entry.sha, baseSha)
      .filter((pull) => pull.state === "open" && pull.headRef === branch && pull.baseSha === baseSha)) {
      const marker = parseArtifactMarker(pull.body)!;
      if (await artifactPullReceiptIsExact(github, repository, pull, marker)) openReceipt.push(pull);
    }
    if (openReceipt.length > 1) continue;
    const pull = openReceipt[0];
    repairs.push({
      findingId: candidate.finding.id,
      findingFingerprint: candidate.finding.fingerprint,
      path: candidate.path,
      blobSha: entry.sha,
      mode: entry.mode,
      base: "dev",
      baseSha,
      branch,
      state: pull?.autoMerge ? "watch" : "needed",
      ...(pull ? { pull: artifactPullEvidence(pull) } : {})
    });
  }
  return repairs.sort((a, b) => a.path.localeCompare(b.path));
}

async function collectManagedLabelEvidence(
  github: OperatorGitHubRequester,
  repository: RepositoryRef,
  branchHeads: Map<string, string>,
  findings: CleanEvidence["reviewFindings"]
): Promise<NonNullable<CleanEvidence["managedLabels"]>> {
  const candidates = findings.flatMap((finding) => {
    const match = /^Managed label `([^`]+)` is absent from the canonical taxonomy\.$/.exec(finding.message);
    return match && finding.id.endsWith("-orphan") ? [{ finding, name: match[1]! }] : [];
  });
  const policyRevision = branchHeads.get("dev");
  if (candidates.length === 0 || !policyRevision || !EXACT_COMMIT.test(policyRevision)) return [];
  const policyFile = await readTextFile(github, repository, MANAGED_LABEL_POLICY_PATH, policyRevision);
  let policy: unknown;
  try {
    policy = JSON.parse(policyFile.content);
  } catch {
    return [];
  }
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return [];
  const policyLabels = (policy as Record<string, unknown>).labels;
  if ((policy as Record<string, unknown>).schemaVersion !== 1 || !Array.isArray(policyLabels)) return [];
  const desired = new Set(policyLabels.flatMap((label) => {
    if (!label || typeof label !== "object" || Array.isArray(label) || typeof (label as Record<string, unknown>).name !== "string") return [];
    return [String((label as Record<string, unknown>).name).toLowerCase()];
  }));
  const rawLabels = await listPages(github, "GET /repos/{owner}/{repo}/labels", { ...repository });
  const actual = rawLabels.map((label, index) => {
    const value = asRecord(label, `repository label ${index}`);
    return {
      name: requiredString(value.name, `repository label ${index} name`),
      color: requiredString(value.color, `repository label ${index} color`).toLowerCase(),
      description: typeof value.description === "string" ? value.description : ""
    };
  });
  const result: NonNullable<CleanEvidence["managedLabels"]> = [];
  for (const candidate of candidates) {
    if (!candidate.name.startsWith("df:") || desired.has(candidate.name.toLowerCase())) continue;
    const matches = actual.filter((label) => label.name.toLowerCase() === candidate.name.toLowerCase());
    if (matches.length !== 1 || !/^[0-9a-f]{6}$/.test(matches[0]!.color)) continue;
    result.push({
      findingId: candidate.finding.id,
      findingFingerprint: candidate.finding.fingerprint,
      ...matches[0]!,
      policyPath: MANAGED_LABEL_POLICY_PATH,
      policyBlob: policyFile.sha,
      policyRef: "dev",
      policyRevision
    });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

async function readCompleteTree(
  github: OperatorGitHubRequester,
  repository: RepositoryRef,
  treeSha: string
): Promise<Array<{ path: string; type: string; sha: string; mode: string }>> {
  const tree = asRecord((await github.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
    ...repository,
    tree_sha: treeSha,
    recursive: "1"
  })).data, `recursive tree ${treeSha}`);
  if (tree.truncated === true || !Array.isArray(tree.tree)) throw new Error(`recursive tree ${treeSha} is incomplete`);
  return tree.tree.map((item, index) => {
    const entry = asRecord(item, `recursive tree ${treeSha} entry ${index}`);
    return {
      path: requiredString(entry.path, `recursive tree ${treeSha} entry ${index} path`),
      type: requiredString(entry.type, `recursive tree ${treeSha} entry ${index} type`),
      sha: requiredString(entry.sha, `recursive tree ${treeSha} entry ${index} sha`).toLowerCase(),
      mode: requiredString(entry.mode, `recursive tree ${treeSha} entry ${index} mode`)
    };
  });
}

async function readTextFile(
  github: OperatorGitHubRequester,
  repository: RepositoryRef,
  path: string,
  ref: string
): Promise<{ sha: string; content: string }> {
  const value = asRecord((await github.request("GET /repos/{owner}/{repo}/contents/{path}", {
    ...repository,
    path,
    ref
  })).data, `${path} at ${ref}`);
  const sha = requiredString(value.sha, `${path} blob`).toLowerCase();
  if (!EXACT_COMMIT.test(sha) || value.encoding !== "base64" || typeof value.content !== "string") throw new Error(`${path} at ${ref} is not an exact observable text blob`);
  return { sha, content: Buffer.from(value.content.replace(/\s/g, ""), "base64").toString("utf8") };
}

function safeRepositoryPath(path: string): boolean {
  return Boolean(path)
    && !path.startsWith("/")
    && !path.includes("\\")
    && !path.includes("\0")
    && !/[\u0000-\u001f\u007f]/.test(path)
    && path.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

function isBlobMode(value: string): value is "100644" | "100755" | "120000" {
  return value === "100644" || value === "100755" || value === "120000";
}

function cleanSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

interface ArtifactMarker {
  findingId: string;
  path: string;
  blobSha: string;
  mode: "100644" | "100755" | "120000";
  baseSha: string;
  headSha: string;
}

function artifactBranch(findingId: string, path: string, blobSha: string, baseSha: string): string {
  return `${CLEAN_ARTIFACT_BRANCH_PREFIX}${stableHash({ findingId, path, blobSha, baseSha }).slice(0, 24)}`;
}

function artifactMarker(marker: ArtifactMarker): string {
  const encodedPath = Buffer.from(marker.path, "utf8").toString("base64url");
  return `${CLEAN_ARTIFACT_MARKER} schema=1 finding=${marker.findingId} path=${encodedPath} blob=${marker.blobSha} mode=${marker.mode} base=${marker.baseSha} head=${marker.headSha} -->`;
}

function parseArtifactMarker(body: string): ArtifactMarker | null {
  const lines = body.split(/\r?\n/);
  const matches = lines.filter((line) => line.startsWith(CLEAN_ARTIFACT_MARKER));
  if (matches.length !== 1) return null;
  if (lines[0] !== matches[0]) return null;
  const match = /^<!-- darkfactory:clean-artifact schema=1 finding=([^\s]+) path=([A-Za-z0-9_-]+) blob=([0-9a-f]{40}) mode=(100644|100755|120000) base=([0-9a-f]{40}) head=([0-9a-f]{40}) -->$/.exec(matches[0]!);
  if (!match) return null;
  let path: string;
  try {
    path = Buffer.from(match[2]!, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!safeRepositoryPath(path) || Buffer.from(path, "utf8").toString("base64url") !== match[2]) return null;
  return {
    findingId: match[1]!,
    path,
    blobSha: match[3]!,
    mode: match[4]! as ArtifactMarker["mode"],
    baseSha: match[5]!,
    headSha: match[6]!
  };
}

function exactArtifactPulls(
  pulls: NormalizedPull[],
  findingId: string,
  path: string,
  blobSha: string | null,
  baseSha: string | null
): NormalizedPull[] {
  return pulls.filter((pull) => {
    const marker = parseArtifactMarker(pull.body);
    return marker !== null
      && pull.trustedActor
      && pull.sameRepository
      && !pull.draft
      && pull.baseRef === "dev"
      && pull.baseSha === marker.baseSha
      && pull.title === artifactPullTitle(path)
      && marker.findingId === findingId
      && marker.path === path
      && marker.headSha === pull.headSha
      && pull.headRef === artifactBranch(marker.findingId, marker.path, marker.blobSha, marker.baseSha)
      && (blobSha === null || marker.blobSha === blobSha)
      && (baseSha === null || marker.baseSha === baseSha);
  });
}

function artifactPullEvidence(pull: NormalizedPull): NonNullable<NonNullable<CleanEvidence["artifactRepairs"]>[number]["pull"]> {
  return {
    number: pull.number,
    version: pullVersion(pull),
    headRef: pull.headRef,
    head: pull.headSha,
    autoMerge: pull.autoMerge,
    merged: pull.merged
  };
}

async function artifactPullReceiptIsExact(
  github: OperatorGitHubRequester,
  repository: RepositoryRef,
  pull: NormalizedPull,
  marker: ArtifactMarker
): Promise<boolean> {
  try {
    if (pull.baseSha !== marker.baseSha || pull.title !== artifactPullTitle(marker.path)) return false;
    const commit = asRecord((await github.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
      ...repository,
      commit_sha: marker.headSha
    })).data, `artifact receipt commit ${marker.headSha}`);
    if (commit.message !== artifactCommitMessage(marker.path) || !Array.isArray(commit.parents) || commit.parents.length !== 1) return false;
    if (asRecord(commit.parents[0], `artifact receipt commit ${marker.headSha} parent`).sha !== marker.baseSha) return false;
    if (await exactArtifactBlob(github, repository, marker.headSha, marker.path) !== null) return false;
    const files = await listPages(github, "GET /repos/{owner}/{repo}/pulls/{pull_number}/files", {
      ...repository,
      pull_number: pull.number
    });
    if (files.length !== 1) return false;
    const file = asRecord(files[0], `artifact receipt pull #${pull.number} file`);
    return file.filename === marker.path && file.status === "removed" && file.sha === marker.blobSha;
  } catch {
    return false;
  }
}

export interface CleanApplyReceipt {
  planId: string;
  repository: string;
  actions: Array<{
    kind: string;
    target: string;
    head: string;
    version?: string;
    base?: string;
    baseSha?: string;
    headRef?: string;
    successor?: CleanPlanEntry["successor"];
    status: "applied" | "skipped";
    reason: string;
  }>;
}

interface CleanApplyOptions {
  localPath?: string;
  deleteRemoteBranchExact?: (branch: string, expectedHead: string) => Promise<void>;
  observeReviewFindings?: () => Promise<DoctorFinding[]>;
  mutateExact?: (mutation: {
    kind: "close-pull-request" | "close-issue" | "delete-label";
    route: string;
    parameters: Record<string, unknown>;
    expectedVersion: string;
  }) => Promise<{ data: unknown }>;
  onAdmission?: (receipt: CleanApplyReceipt["actions"][number]) => Promise<void>;
  onCompletion?: (receipt: CleanApplyReceipt["actions"][number]) => Promise<void>;
}

export async function deleteRemoteBranchWithLease(
  localPath: string,
  remoteUrl: string,
  branch: string,
  expectedHead: string,
  token = ""
): Promise<void> {
  if (!localPath.trim()) throw new Error("atomic remote branch deletion requires an exact local checkout");
  if (!remoteUrl.trim()) throw new Error("atomic remote branch deletion requires an exact remote URL");
  if (!/^[0-9a-f]{40}$/.test(expectedHead)) throw new Error("atomic remote branch deletion requires an exact 40-character head");
  const ref = `refs/heads/${branch}`;
  runGit(localPath, ["check-ref-format", ref]);
  const env = gitTransportEnvironment(token);
  const push = spawnSync(
    "git",
    ["push", "--porcelain", `--force-with-lease=${ref}:${expectedHead}`, remoteUrl, `:${ref}`],
    { cwd: localPath, encoding: "utf8", env, windowsHide: true }
  );
  if (push.status !== 0) {
    throw new Error(`atomic remote branch deletion refused for ${branch}: ${cleanProcessError(push)}`);
  }
  const confirmation = spawnSync(
    "git",
    ["ls-remote", "--exit-code", "--heads", remoteUrl, ref],
    { cwd: localPath, encoding: "utf8", env, windowsHide: true }
  );
  if (confirmation.status === 0) throw new Error(`remote branch ${branch} still exists after atomic deletion`);
  if (confirmation.status !== 2) {
    throw new Error(`remote branch ${branch} deletion could not be confirmed: ${cleanProcessError(confirmation)}`);
  }
}

export async function applyCleanPlan(
  github: OperatorGitHubRequester,
  repository: RepositoryRef,
  saved: CleanPlan,
  freshEvidence: CleanEvidence,
  options: CleanApplyOptions = {}
): Promise<CleanApplyReceipt> {
  const fresh = buildCleanPlan(freshEvidence, new Date(saved.createdAt));
  verifyCleanPlanAdmission(saved, fresh);
  if (saved.entries.some((entry) => entry.kind === "remote-branch" && entry.action === "delete") && !options.deleteRemoteBranchExact) {
    throw new Error("clean remote branch deletion requires an atomic exact-head Git transport");
  }
  const local = options.localPath
    ? collectLocalEvidence(
      options.localPath,
      repository,
      new Map(freshEvidence.branches.map((branch) => [branch.name, branch.head])),
      new Map(freshEvidence.branches.map((branch) => [branch.name, branch.tree])),
      new Set([freshEvidence.defaultBranch, "main", "dev"])
    )
    : emptyLocalEvidence();
  const actions: CleanApplyReceipt["actions"] = [];

  // Remove exact clean worktree copies first. `git worktree remove` has no
  // force flag here and therefore remains fail-closed if Git observes drift.
  for (const entry of saved.entries.filter((candidate) => candidate.kind === "worktree" && candidate.action === "remove")) {
    const rawPath = local.rawWorktreeById.get(entry.target);
    if (!options.localPath || !rawPath) throw new Error(`clean worktree ${entry.target} is no longer observable; apply aborted`);
    const plannedRef = plannedWorktreeRef(saved, entry);
    await recordAdmission({ kind: entry.kind, target: entry.target, head: entry.head, status: "applied", reason: "admitted exact clean preserved worktree removal" }, options.onAdmission);
    revalidateWorktreeRemoval(options.localPath, rawPath, entry, plannedRef);
    runGit(options.localPath, ["worktree", "remove", "--", rawPath]);
    await recordCompleted(actions, { kind: entry.kind, target: entry.target, head: entry.head, status: "applied", reason: "exact clean preserved worktree removed" }, options.onCompletion);
  }

  for (const entry of saved.entries.filter((candidate) => candidate.kind === "orphan-ref" && candidate.action === "delete")) {
    if (!options.localPath) throw new Error(`clean orphan ref ${entry.target} requires an explicit local checkout`);
    await recordAdmission({ kind: entry.kind, target: entry.target, head: entry.head, status: "applied", reason: "admitted atomic exact-head deletion after preservation proof" }, options.onAdmission);
    runGit(options.localPath, ["update-ref", "-d", entry.target, entry.head]);
    await recordCompleted(actions, { kind: entry.kind, target: entry.target, head: entry.head, status: "applied", reason: "atomic exact-head deletion after independent preservation proof" }, options.onCompletion);
  }

  for (const entry of saved.entries.filter((candidate) => candidate.kind === "local-branch" && candidate.action === "delete")) {
    if (!options.localPath) throw new Error(`clean local branch ${entry.target} requires an explicit local checkout`);
    await recordAdmission({ kind: entry.kind, target: entry.target, head: entry.head, status: "applied", reason: "admitted atomic exact-head deletion after preservation proof" }, options.onAdmission);
    runGit(options.localPath, ["update-ref", "-d", `refs/heads/${entry.target}`, entry.head]);
    await recordCompleted(actions, { kind: entry.kind, target: entry.target, head: entry.head, status: "applied", reason: "atomic exact-head deletion after independent preservation proof" }, options.onCompletion);
  }

  for (const entry of saved.entries.filter((candidate) => candidate.kind === "remote-branch" && candidate.action === "delete")) {
    const current = asRecord((await github.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
      ...repository,
      ref: `heads/${entry.target}`
    })).data, `remote branch ${entry.target}`);
    const object = asRecord(current.object, `remote branch ${entry.target} object`);
    if (object.sha !== entry.head) throw new Error(`remote branch ${entry.target} drifted immediately before deletion; apply aborted`);
    await recordAdmission({ kind: entry.kind, target: entry.target, head: entry.head, status: "applied", reason: "admitted exact remote head deletion after preservation proof" }, options.onAdmission);
    const admitted = asRecord((await github.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
      ...repository,
      ref: `heads/${entry.target}`
    })).data, `remote branch ${entry.target}`);
    const admittedObject = asRecord(admitted.object, `remote branch ${entry.target} object`);
    if (admittedObject.sha !== entry.head) throw new Error(`remote branch ${entry.target} drifted after admission; apply aborted`);
    await options.deleteRemoteBranchExact!(entry.target, entry.head);
    await recordCompleted(actions, { kind: entry.kind, target: entry.target, head: entry.head, status: "applied", reason: "exact head independently preserved and deleted through an atomic force-with-lease Git transport" }, options.onCompletion);
  }

  for (const entry of saved.entries.filter((candidate) => candidate.action === "autoreview")) {
    await applyAutoreviewAction(github, repository, entry, actions, options);
  }

  for (const entry of saved.entries.filter((candidate) => candidate.kind === "pull-request" && candidate.action === "close")) {
    await applyPullClosureAction(github, repository, entry, actions, options);
  }

  for (const entry of saved.entries.filter((candidate) => candidate.kind === "issue" && candidate.action === "fold")) {
    await applyIssueFoldAction(github, repository, entry, actions, options);
  }

  for (const entry of saved.entries.filter((candidate) => candidate.kind === "marker-issue" && candidate.action === "close")) {
    await applyMarkerIssueClosure(github, repository, entry, actions, options);
  }

  for (const entry of saved.entries.filter((candidate) => candidate.kind === "managed-label" && candidate.action === "delete-label")) {
    await applyManagedLabelDeletion(github, repository, entry, actions, options);
  }

  for (const entry of saved.entries.filter((candidate) => candidate.kind === "artifact" && candidate.action === "repair-artifact")) {
    await applyArtifactRepairAction(github, repository, entry, actions, options);
  }

  for (const entry of saved.entries.filter((candidate) => candidate.action === "watch")) {
    await recordCompleted(actions, actionReceipt(entry, "skipped", entry.reasons.join(" ")), options.onCompletion);
  }

  for (const entry of saved.entries.filter((candidate) => candidate.action === "preserve")) {
    await recordCompleted(actions, actionReceipt(entry, "skipped", entry.reasons.join(" ")), options.onCompletion);
  }
  return { planId: saved.planId, repository: saved.repository, actions };
}

function gitTransportEnvironment(token: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  if (!token) return env;
  const authorization = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
  env.GIT_CONFIG_COUNT = "2";
  env.GIT_CONFIG_KEY_0 = "credential.helper";
  env.GIT_CONFIG_VALUE_0 = "";
  env.GIT_CONFIG_KEY_1 = "http.https://github.com/.extraheader";
  env.GIT_CONFIG_VALUE_1 = `AUTHORIZATION: basic ${authorization}`;
  return env;
}

function cleanProcessError(result: ReturnType<typeof spawnSync>): string {
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
  return stderr || stdout || result.error?.message || `git exited with status ${String(result.status)}`;
}

async function recordAdmission(
  receipt: CleanApplyReceipt["actions"][number],
  callback?: (receipt: CleanApplyReceipt["actions"][number]) => Promise<void>
): Promise<void> {
  if (callback) await callback(receipt);
}

async function recordCompleted(
  actions: CleanApplyReceipt["actions"],
  receipt: CleanApplyReceipt["actions"][number],
  callback?: (receipt: CleanApplyReceipt["actions"][number]) => Promise<void>
): Promise<void> {
  actions.push(receipt);
  if (callback) await callback(receipt);
}

async function applyAutoreviewAction(
  github: OperatorGitHubRequester,
  repository: RepositoryRef,
  entry: CleanPlanEntry,
  actions: CleanApplyReceipt["actions"],
  options: CleanApplyOptions
): Promise<void> {
  if ((entry.kind !== "issue" && entry.kind !== "pull-request") || !entry.version) {
    throw new Error(`clean Autoreview target ${entry.target} lacks an exact version`);
  }
  validateAutoreviewVersion(entry.kind, entry.version);
  const number = cleanTargetNumber(entry);
  const before = await readExactAutoreviewTarget(github, repository, entry, number);
  if (before.autoreview === "current" || before.autoreview === "pending" || before.autoreview === "owner-required") {
    await recordCompleted(
      actions,
      actionReceipt(entry, "skipped", before.autoreview === "owner-required"
        ? `Exact ${entry.version} recovery is owner-required; automated dispatch remains blocked.`
        : `Exact ${entry.version} Autoreview is already ${before.autoreview}; duplicate dispatch suppressed.`),
      options.onCompletion
    );
    return;
  }
  await assertAutoreviewWorkflowActive(github, repository);

  await recordAdmission(
    actionReceipt(entry, "applied", `Admitted exact ${entry.version} Autoreview dispatch after observing ${before.autoreview} evidence.`),
    options.onAdmission
  );
  const admitted = await readExactAutoreviewTarget(github, repository, entry, number);
  if (admitted.autoreview === "current" || admitted.autoreview === "pending" || admitted.autoreview === "owner-required") {
    await recordCompleted(
      actions,
      actionReceipt(entry, "skipped", admitted.autoreview === "owner-required"
        ? `Exact ${entry.version} recovery became owner-required after admission; automated dispatch remains blocked.`
        : `Exact ${entry.version} became ${admitted.autoreview} after admission; duplicate dispatch suppressed.`),
      options.onCompletion
    );
    return;
  }

  const pendingResponse = await github.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
    ...repository,
    issue_number: number,
    body: renderCleanAutoreviewComment(entry, number, "pending", "The exact target was re-fetched after durable admission; workflow dispatch is pending.")
  });
  const pendingComment = asRecord(pendingResponse.data, `clean Autoreview pending comment for ${entry.target}`);
  const pendingCommentId = requiredNumber(pendingComment.id, `clean Autoreview pending comment id for ${entry.target}`);

  const marked = await readExactAutoreviewTarget(github, repository, entry, number);
  if (marked.autoreview === "current") {
    await recordCompleted(
      actions,
      actionReceipt(entry, "applied", `Pending evidence comment #${pendingCommentId} was published, but exact Autoreview completed concurrently; dispatch suppressed.`),
      options.onCompletion
    );
    return;
  }
  if (marked.autoreview === "owner-required") {
    await recordCompleted(
      actions,
      actionReceipt(entry, "applied", `Pending evidence comment #${pendingCommentId} was published, but exact recovery became owner-required; dispatch suppressed.`),
      options.onCompletion
    );
    return;
  }
  const canonicalPending = firstPendingAutoreviewComment(marked.comments, entry.kind, number, entry.version);
  if (canonicalPending !== null && canonicalPending !== pendingCommentId) {
    await recordCompleted(
      actions,
      actionReceipt(entry, "applied", `Pending evidence comment #${pendingCommentId} was published; dispatch deduplicated behind canonical comment #${canonicalPending}.`),
      options.onCompletion
    );
    return;
  }

  await assertAutoreviewWorkflowActive(github, repository);
  await readExactAutoreviewTarget(github, repository, entry, number);
  try {
    await github.request("POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches", {
      ...repository,
      workflow_id: AUTOREVIEW_WORKFLOW,
      ref: "main",
      inputs: {
        target_kind: entry.kind === "issue" ? "issue" : "pull_request",
        target_number: String(number),
        target_version: entry.version
      }
    });
  } catch (error) {
    await readExactAutoreviewTarget(github, repository, entry, number);
    await github.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      ...repository,
      issue_number: number,
      body: renderCleanAutoreviewComment(entry, number, "failed", "GitHub rejected the evidence-bound workflow dispatch; the next clean plan may retry this exact version.")
    });
    throw error;
  }
  await recordCompleted(
    actions,
    actionReceipt(entry, "applied", `GitHub accepted ${AUTOREVIEW_WORKFLOW} for exact ${entry.version} after pending evidence comment #${pendingCommentId}.`),
    options.onCompletion
  );
}

async function applyPullClosureAction(
  github: OperatorGitHubRequester,
  repository: RepositoryRef,
  entry: CleanPlanEntry,
  actions: CleanApplyReceipt["actions"],
  options: CleanApplyOptions
): Promise<void> {
  if (!entry.version || !entry.successor || (entry.classification !== "superseded" && entry.classification !== "abandoned")) {
    throw new Error(`clean pull-request closure ${entry.target} lacks exact successor authority`);
  }
  requireExactMutator(options, `pull request ${entry.target}`);
  const number = cleanTargetNumber(entry);
  await revalidatePullClosure(github, repository, number, entry);
  await recordAdmission(
    actionReceipt(entry, "applied", `Admitted ${entry.classification} closure after exact ${entry.successor.proof} successor proof.`),
    options.onAdmission
  );

  await revalidatePullClosure(github, repository, number, entry);
  const comments = await listPages(github, "GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
    ...repository,
    issue_number: number
  });
  const hasClosureReceipt = comments.some((comment) => isTrustedClosureComment(comment, entry));
  if (!hasClosureReceipt) {
    await revalidatePullClosure(github, repository, number, entry);
    await github.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      ...repository,
      issue_number: number,
      body: renderPullClosureComment(entry)
    });
  }

  const expectedVersion = await revalidatePullClosure(github, repository, number, entry);
  await options.mutateExact!({
    kind: "close-pull-request",
    route: "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
    parameters: { ...repository, pull_number: number, state: "closed" },
    expectedVersion
  });
  const closed = normalizePull((await github.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    ...repository,
    pull_number: number
  })).data, number, repository);
  assertPullIdentity(closed, entry, false);
  if (closed.state !== "closed") throw new Error(`pull request ${entry.target} closure was not confirmed`);
  await recordCompleted(
    actions,
    actionReceipt(entry, "applied", `Closed with exact ${entry.successor.proof} successor PR #${entry.successor.number}; source and successor versions are receipt-bound.`),
    options.onCompletion
  );
}

interface ExactIssueObservation {
  issue: Record<string, unknown>;
  comments: Record<string, unknown>[];
  effective: ReturnType<typeof resolveEffectiveIssueContent>;
  mutationVersion: string;
}

async function readExactOpenIssue(
  github: OperatorGitHubRequester,
  repository: RepositoryRef,
  number: number,
  label: string
): Promise<ExactIssueObservation> {
  const response = await github.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
    ...repository,
    issue_number: number
  });
  const issue = asRecord(response.data, label);
  const comments = (await listPages(github, "GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
    ...repository,
    issue_number: number
  })).map((comment, index) => asRecord(comment, `${label} comment ${index}`));
  if (issue.pull_request !== undefined || issue.state !== "open") throw new Error(`${label} is no longer an open issue`);
  return {
    issue,
    comments,
    effective: resolveEffectiveIssueContent(issue, comments),
    mutationVersion: stableHash({ issue, comments })
  };
}

async function revalidateIssueFold(
  github: OperatorGitHubRequester,
  repository: RepositoryRef,
  entry: CleanPlanEntry
): Promise<{ source: ExactIssueObservation; successor: ExactIssueObservation }> {
  if (!entry.version || !entry.issueFold || !ISSUE_VERSION.test(entry.version)) {
    throw new Error(`clean issue fold ${entry.target} lacks exact containment evidence`);
  }
  const sourceNumber = cleanTargetNumber(entry);
  const { successorNumber, successorVersion, sourceScopeDigest, successorScopeDigest } = entry.issueFold;
  if (successorNumber === sourceNumber || !ISSUE_VERSION.test(successorVersion)) {
    throw new Error(`clean issue fold ${entry.target} has an invalid successor identity`);
  }
  const [source, successor] = await Promise.all([
    readExactOpenIssue(github, repository, sourceNumber, `issue ${entry.target}`),
    readExactOpenIssue(github, repository, successorNumber, `successor issue #${successorNumber}`)
  ]);
  if (source.effective.version !== entry.version || successor.effective.version !== successorVersion) {
    throw new Error(`issue ${entry.target} or successor #${successorNumber} drifted from its exact version`);
  }
  const sourceScope = issueScopeEvidence(source.effective.title, source.effective.body);
  const successorScope = issueScopeEvidence(successor.effective.title, successor.effective.body);
  if (sourceScope.digest !== sourceScopeDigest
    || successorScope.digest !== successorScopeDigest
    || !issueScopeContains(sourceScope, successorScope)) {
    throw new Error(`issue ${entry.target} successor no longer contains the complete source scope`);
  }
  return { source, successor };
}

function issueFoldMarker(entry: CleanPlanEntry): string {
  if (!entry.version || !entry.issueFold) throw new Error(`clean issue fold ${entry.target} lacks exact evidence`);
  const fold = entry.issueFold;
  return `${CLEAN_ISSUE_FOLD_MARKER} schema=1 source=${entry.version} successor=${fold.successorNumber} successor-version=${fold.successorVersion} source-scope=${fold.sourceScopeDigest} successor-scope=${fold.successorScopeDigest} finding=${fold.findingId} finding-fingerprint=${fold.findingFingerprint} proof=${fold.proof} -->`;
}

function renderIssueFoldComment(entry: CleanPlanEntry): string {
  if (!entry.issueFold) throw new Error(`clean issue fold ${entry.target} lacks exact evidence`);
  return [
    issueFoldMarker(entry),
    "## DarkFactory duplicate issue fold",
    "",
    `Closing this exact duplicate only because open issue #${entry.issueFold.successorNumber} contains every normalized source scope line.`,
    "",
    `Source scope: \`${entry.issueFold.sourceScopeDigest}\``,
    `Successor scope: \`${entry.issueFold.successorScopeDigest}\``
  ].join("\n");
}

function isTrustedIssueFoldComment(value: unknown, entry: CleanPlanEntry): boolean {
  return isTrustedDarkFactoryComment(value)
    && typeof (value as Record<string, unknown>).body === "string"
    && ((value as Record<string, unknown>).body as string).split(/\r?\n/, 1)[0] === issueFoldMarker(entry);
}

async function applyIssueFoldAction(
  github: OperatorGitHubRequester,
  repository: RepositoryRef,
  entry: CleanPlanEntry,
  actions: CleanApplyReceipt["actions"],
  options: CleanApplyOptions
): Promise<void> {
  requireExactMutator(options, `issue ${entry.target}`);
  await revalidateIssueFold(github, repository, entry);
  await recordAdmission(
    actionReceipt(entry, "applied", `Admitted exact scope-preserving fold into #${entry.issueFold!.successorNumber}.`),
    options.onAdmission
  );
  let observed = await revalidateIssueFold(github, repository, entry);
  if (!observed.source.comments.some((comment) => isTrustedIssueFoldComment(comment, entry))) {
    const response = await github.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      ...repository,
      issue_number: cleanTargetNumber(entry),
      body: renderIssueFoldComment(entry)
    });
    if (!isTrustedIssueFoldComment(response.data, entry)) throw new Error(`issue ${entry.target} fold receipt actor or marker is untrusted`);
  }
  observed = await revalidateIssueFold(github, repository, entry);
  if (!observed.source.comments.some((comment) => isTrustedIssueFoldComment(comment, entry))) {
    throw new Error(`issue ${entry.target} fold receipt was not durably re-observed`);
  }
  await options.mutateExact!({
    kind: "close-issue",
    route: "PATCH /repos/{owner}/{repo}/issues/{issue_number}",
    parameters: { ...repository, issue_number: cleanTargetNumber(entry), state: "closed" },
    expectedVersion: observed.source.mutationVersion
  });
  const closedIssue = asRecord((await github.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
    ...repository,
    issue_number: cleanTargetNumber(entry)
  })).data, `closed issue ${entry.target}`);
  if (closedIssue.state !== "closed" || closedIssue.pull_request !== undefined) throw new Error(`issue ${entry.target} closure was not confirmed`);
  const closedComments = (await listPages(github, "GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
    ...repository,
    issue_number: cleanTargetNumber(entry)
  })).map((comment, index) => asRecord(comment, `closed issue ${entry.target} comment ${index}`));
  const closedEffective = resolveEffectiveIssueContent(closedIssue, closedComments);
  if (closedEffective.title !== observed.source.effective.title || closedEffective.body !== observed.source.effective.body) {
    throw new Error(`issue ${entry.target} content changed during closure`);
  }
  if (!closedComments.some((comment) => isTrustedIssueFoldComment(comment, entry))) {
    throw new Error(`issue ${entry.target} fold receipt disappeared during closure`);
  }
  await recordCompleted(
    actions,
    actionReceipt(entry, "applied", `Closed after exact source/successor revalidation; #${entry.issueFold!.successorNumber} preserves the complete source scope.`),
    options.onCompletion
  );
}

function markerIssueClosureMarker(entry: CleanPlanEntry): string {
  if (!entry.markerIssue) throw new Error(`clean marker issue ${entry.target} lacks exact evidence`);
  const evidence = entry.markerIssue;
  return `${CLEAN_MARKER_ISSUE_CLOSURE} schema=1 issue=${evidence.number} version=${evidence.version} marker=${Buffer.from(evidence.marker, "utf8").toString("base64url")} reason=${evidence.reason} findings=${evidence.findingSetFingerprint}${evidence.successor ? ` successor=${evidence.successor.number} successor-version=${evidence.successor.version}` : ""} -->`;
}

function isTrustedMarkerIssueClosureComment(value: unknown, entry: CleanPlanEntry): boolean {
  return isTrustedDarkFactoryComment(value)
    && typeof (value as Record<string, unknown>).body === "string"
    && ((value as Record<string, unknown>).body as string).split(/\r?\n/, 1)[0] === markerIssueClosureMarker(entry);
}

async function revalidateMarkerIssue(
  github: OperatorGitHubRequester,
  repository: RepositoryRef,
  entry: CleanPlanEntry
): Promise<ExactIssueObservation> {
  if (!entry.markerIssue || !entry.version || entry.version !== entry.markerIssue.version) {
    throw new Error(`clean marker issue ${entry.target} lacks exact evidence`);
  }
  const evidence = entry.markerIssue;
  const observed = await readExactOpenIssue(github, repository, evidence.number, `marker issue ${entry.target}`);
  const marker = ownedMarker(observed.issue);
  if (!marker || marker.value !== evidence.marker || observed.effective.version !== evidence.version) {
    throw new Error(`marker issue ${entry.target} actor, marker, or exact version drifted`);
  }
  if (evidence.successor) {
    const successor = await readExactOpenIssue(github, repository, evidence.successor.number, `marker successor #${evidence.successor.number}`);
    const successorMarker = ownedMarker(successor.issue);
    if (!successorMarker || successorMarker.value !== evidence.marker || successor.effective.version !== evidence.successor.version) {
      throw new Error(`marker issue ${entry.target} successor drifted`);
    }
  }
  return observed;
}

async function applyMarkerIssueClosure(
  github: OperatorGitHubRequester,
  repository: RepositoryRef,
  entry: CleanPlanEntry,
  actions: CleanApplyReceipt["actions"],
  options: CleanApplyOptions
): Promise<void> {
  requireExactMutator(options, `marker issue ${entry.target}`);
  await revalidateMarkerIssue(github, repository, entry);
  await recordAdmission(actionReceipt(entry, "applied", `Admitted exact trusted ${entry.markerIssue!.reason} marker closure.`), options.onAdmission);
  await assertCurrentMarkerFindingSet(entry, options);
  let observed = await revalidateMarkerIssue(github, repository, entry);
  if (!observed.comments.some((comment) => isTrustedMarkerIssueClosureComment(comment, entry))) {
    const body = [markerIssueClosureMarker(entry), "## DarkFactory marker cleanup", "", "This exact machine-owned marker issue is stale and is closed without mutating any human-owned issue."].join("\n");
    const response = await github.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      ...repository,
      issue_number: entry.markerIssue!.number,
      body
    });
    if (!isTrustedMarkerIssueClosureComment(response.data, entry)) throw new Error(`marker issue ${entry.target} closure receipt is untrusted`);
  }
  observed = await revalidateMarkerIssue(github, repository, entry);
  if (!observed.comments.some((comment) => isTrustedMarkerIssueClosureComment(comment, entry))) {
    throw new Error(`marker issue ${entry.target} closure receipt was not durably re-observed`);
  }
  await assertCurrentMarkerFindingSet(entry, options);
  await options.mutateExact!({
    kind: "close-issue",
    route: "PATCH /repos/{owner}/{repo}/issues/{issue_number}",
    parameters: { ...repository, issue_number: entry.markerIssue!.number, state: "closed" },
    expectedVersion: observed.mutationVersion
  });
  const closed = asRecord((await github.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
    ...repository,
    issue_number: entry.markerIssue!.number
  })).data, `closed marker issue ${entry.target}`);
  if (closed.state !== "closed" || ownedMarker(closed)?.value !== entry.markerIssue!.marker) {
    throw new Error(`marker issue ${entry.target} closure was not confirmed against the exact owned marker`);
  }
  await recordCompleted(actions, actionReceipt(entry, "applied", `Closed exact trusted ${entry.markerIssue!.reason} marker issue.`), options.onCompletion);
}

async function assertCurrentMarkerFindingSet(entry: CleanPlanEntry, options: CleanApplyOptions): Promise<void> {
  const expected = entry.markerIssue?.findingSetFingerprint;
  if (!expected || !/^[0-9a-f]{64}$/.test(expected)) {
    throw new Error(`marker issue ${entry.target} lacks an exact finding-set fingerprint`);
  }
  if (!options.observeReviewFindings) {
    throw new Error(`marker issue ${entry.target} requires current doctor finding-set observation; closure preserved`);
  }
  const observed = cleanFindingSetFingerprint(normalizeCleanReviewFindings(await options.observeReviewFindings()));
  if (observed !== expected) {
    throw new Error(`marker issue ${entry.target} doctor finding set drifted; closure preserved`);
  }
}

async function revalidateManagedLabel(
  github: OperatorGitHubRequester,
  repository: RepositoryRef,
  entry: CleanPlanEntry
): Promise<string> {
  const label = entry.managedLabel;
  if (!label || entry.target !== label.name || !label.name.startsWith("df:")) {
    throw new Error(`clean managed label ${entry.target} lacks exact policy ownership evidence`);
  }
  const revision = await readRefSha(github, repository, label.policyRef);
  if (revision !== label.policyRevision) throw new Error(`managed label ${entry.target} policy revision drifted`);
  const policy = await readTextFile(github, repository, label.policyPath, revision);
  if (policy.sha !== label.policyBlob) throw new Error(`managed label ${entry.target} policy blob drifted`);
  let parsed: unknown;
  try { parsed = JSON.parse(policy.content); } catch { throw new Error(`managed label ${entry.target} policy is malformed`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || (parsed as Record<string, unknown>).schemaVersion !== 1 || !Array.isArray((parsed as Record<string, unknown>).labels)) {
    throw new Error(`managed label ${entry.target} policy is malformed`);
  }
  const desired = ((parsed as Record<string, unknown>).labels as unknown[]).some((candidate) => {
    return candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
      && typeof (candidate as Record<string, unknown>).name === "string"
      && String((candidate as Record<string, unknown>).name).toLowerCase() === label.name.toLowerCase();
  });
  if (desired) throw new Error(`managed label ${entry.target} became part of the canonical taxonomy`);
  const response = await github.request("GET /repos/{owner}/{repo}/labels/{name}", {
    ...repository,
    name: label.name
  });
  const current = asRecord(response.data, `managed label ${entry.target}`);
  if (String(current.name).toLowerCase() !== label.name.toLowerCase()
    || String(current.color).toLowerCase() !== label.color
    || String(current.description ?? "") !== label.description) {
    throw new Error(`managed label ${entry.target} drifted from its exact identity`);
  }
  return stableHash({
    policyRevision: label.policyRevision,
    policyBlob: label.policyBlob,
    name: String(current.name).toLowerCase(),
    color: String(current.color).toLowerCase(),
    description: String(current.description ?? "")
  });
}

async function applyManagedLabelDeletion(
  github: OperatorGitHubRequester,
  repository: RepositoryRef,
  entry: CleanPlanEntry,
  actions: CleanApplyReceipt["actions"],
  options: CleanApplyOptions
): Promise<void> {
  requireExactMutator(options, `managed label ${entry.target}`);
  await revalidateManagedLabel(github, repository, entry);
  await recordAdmission(actionReceipt(entry, "applied", "Admitted deletion of an exact orphaned df: label after current policy proof."), options.onAdmission);
  const expectedVersion = await revalidateManagedLabel(github, repository, entry);
  await options.mutateExact!({
    kind: "delete-label",
    route: "DELETE /repos/{owner}/{repo}/labels/{name}",
    parameters: { ...repository, name: entry.target },
    expectedVersion
  });
  try {
    await github.request("GET /repos/{owner}/{repo}/labels/{name}", { ...repository, name: entry.target });
  } catch (error) {
    if (isStatus(error, 404)) {
      await recordCompleted(actions, actionReceipt(entry, "applied", "Deleted and re-observed absence of the exact orphaned policy-owned label."), options.onCompletion);
      return;
    }
    throw error;
  }
  throw new Error(`managed label ${entry.target} deletion was not confirmed`);
}

async function readRefSha(
  github: OperatorGitHubRequester,
  repository: RepositoryRef,
  branch: string
): Promise<string> {
  const ref = asRecord((await github.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
    ...repository,
    ref: `heads/${branch}`
  })).data, `branch ${branch}`);
  const sha = requiredString(asRecord(ref.object, `branch ${branch} object`).sha, `branch ${branch} head`).toLowerCase();
  if (!EXACT_COMMIT.test(sha)) throw new Error(`branch ${branch} head is not an exact commit`);
  return sha;
}

async function readRefShaIfPresent(
  github: OperatorGitHubRequester,
  repository: RepositoryRef,
  branch: string
): Promise<string | null> {
  try {
    return await readRefSha(github, repository, branch);
  } catch (error) {
    if (isStatus(error, 404)) return null;
    throw error;
  }
}

function assertExactDevProtection(value: unknown): void {
  const protection = asRecord(value, "dev branch protection");
  const statuses = asRecord(protection.required_status_checks, "dev required status checks");
  if (statuses.strict !== true || !Array.isArray(statuses.checks)) throw new Error("dev protection does not enforce strict App-bound checks");
  const checks = statuses.checks.map((value, index) => {
    const check = asRecord(value, `dev required check ${index}`);
    return { context: requiredString(check.context, `dev required check ${index} context`), appId: requiredNumber(check.app_id, `dev required check ${index} app`) };
  }).sort((left, right) => left.context.localeCompare(right.context));
  const required = [...REQUIRED_PROTECTED_CHECKS].sort();
  if (checks.length !== required.length || checks.some((check, index) => check.context !== required[index] || check.appId !== TRUSTED_ACTIONS_APP_ID)) {
    throw new Error("dev protection is not bound exactly to Validate and DarkFactory Autoreview on the trusted Actions App");
  }
  const admins = asRecord(protection.enforce_admins, "dev admin enforcement");
  const force = asRecord(protection.allow_force_pushes, "dev force-push policy");
  const deletion = asRecord(protection.allow_deletions, "dev deletion policy");
  if (admins.enabled !== true || force.enabled !== false || deletion.enabled !== false) {
    throw new Error("dev protection permits a bypass, force push, or deletion");
  }
}

async function assertProtectedDevLane(
  github: OperatorGitHubRequester,
  repository: RepositoryRef
): Promise<void> {
  const response = await github.request("GET /repos/{owner}/{repo}/branches/{branch}/protection", {
    ...repository,
    branch: "dev"
  });
  assertExactDevProtection(response.data);
}

async function exactArtifactBlob(
  github: OperatorGitHubRequester,
  repository: RepositoryRef,
  revision: string,
  path: string
): Promise<{ sha: string; mode: "100644" | "100755" | "120000" } | null> {
  const matches = (await readCompleteTree(github, repository, revision)).filter((entry) => entry.path === path);
  if (matches.length === 0) return null;
  if (matches.length !== 1 || matches[0]!.type !== "blob" || !EXACT_COMMIT.test(matches[0]!.sha) || !isBlobMode(matches[0]!.mode)) {
    throw new Error(`artifact path ${path} is ambiguous or is not an exact blob`);
  }
  return { sha: matches[0]!.sha, mode: matches[0]!.mode };
}

function requireArtifactEntry(entry: CleanPlanEntry): NonNullable<CleanPlanEntry["artifact"]> {
  const artifact = entry.artifact;
  if (!artifact
    || entry.target !== artifact.path
    || entry.head !== artifact.blobSha
    || artifact.base !== "dev"
    || artifact.state !== "needed"
    || !safeRepositoryPath(artifact.path)
    || !EXACT_COMMIT.test(artifact.blobSha)
    || !EXACT_COMMIT.test(artifact.baseSha)
    || !isBlobMode(artifact.mode)
    || artifact.branch !== artifactBranch(artifact.findingId, artifact.path, artifact.blobSha, artifact.baseSha)) {
    throw new Error(`clean artifact ${entry.target} lacks exact marker-owned repair evidence`);
  }
  return artifact;
}

async function revalidateArtifactSource(
  github: OperatorGitHubRequester,
  repository: RepositoryRef,
  entry: CleanPlanEntry
): Promise<void> {
  const artifact = requireArtifactEntry(entry);
  const head = await readRefSha(github, repository, artifact.base);
  if (head !== artifact.baseSha) throw new Error(`artifact ${artifact.path} base drifted from exact dev head`);
  const blob = await exactArtifactBlob(github, repository, artifact.baseSha, artifact.path);
  if (!blob || blob.sha !== artifact.blobSha || blob.mode !== artifact.mode) {
    throw new Error(`artifact ${artifact.path} blob or mode drifted before repair`);
  }
  await assertProtectedDevLane(github, repository);
}

function artifactCommitMessage(path: string): string {
  return `chore(clean): remove generated artifact ${path}`;
}

function artifactPullTitle(path: string): string {
  return `chore(clean): remove generated artifact ${path}`;
}

function artifactPullBody(artifact: NonNullable<CleanPlanEntry["artifact"]>, headSha: string): string {
  return [
    artifactMarker({
      findingId: artifact.findingId,
      path: artifact.path,
      blobSha: artifact.blobSha,
      mode: artifact.mode,
      baseSha: artifact.baseSha,
      headSha
    }),
    "## DarkFactory generated artifact cleanup",
    "",
    `Removes only \`${artifact.path}\` at exact blob \`${artifact.blobSha}\` from \`dev@${artifact.baseSha}\`.`,
    "",
    "This pull request is marker-owned, protected by Validate and DarkFactory Autoreview, and may land only through GitHub auto-merge after both trusted App-bound checks are green."
  ].join("\n");
}

async function verifyArtifactCommit(
  github: OperatorGitHubRequester,
  repository: RepositoryRef,
  artifact: NonNullable<CleanPlanEntry["artifact"]>,
  headSha: string
): Promise<void> {
  const ref = await readRefSha(github, repository, artifact.branch);
  if (ref !== headSha) throw new Error(`artifact cleanup branch ${artifact.branch} drifted`);
  const commit = asRecord((await github.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
    ...repository,
    commit_sha: headSha
  })).data, `artifact cleanup commit ${headSha}`);
  if (commit.message !== artifactCommitMessage(artifact.path) || !Array.isArray(commit.parents) || commit.parents.length !== 1) {
    throw new Error(`artifact cleanup commit ${headSha} is not the exact single-parent marker-owned change`);
  }
  const parent = asRecord(commit.parents[0], `artifact cleanup commit ${headSha} parent`);
  if (parent.sha !== artifact.baseSha) throw new Error(`artifact cleanup commit ${headSha} parent drifted`);
  if (await exactArtifactBlob(github, repository, headSha, artifact.path) !== null) {
    throw new Error(`artifact cleanup commit ${headSha} did not remove ${artifact.path}`);
  }
}

async function createOrResumeArtifactCommit(
  github: OperatorGitHubRequester,
  repository: RepositoryRef,
  artifact: NonNullable<CleanPlanEntry["artifact"]>
): Promise<string> {
  const existing = await readRefShaIfPresent(github, repository, artifact.branch);
  if (existing) {
    await verifyArtifactCommit(github, repository, artifact, existing);
    return existing;
  }
  const baseCommit = asRecord((await github.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
    ...repository,
    commit_sha: artifact.baseSha
  })).data, `artifact base commit ${artifact.baseSha}`);
  const baseTree = requiredString(asRecord(baseCommit.tree, `artifact base commit ${artifact.baseSha} tree`).sha, `artifact base tree`);
  const tree = asRecord((await github.request("POST /repos/{owner}/{repo}/git/trees", {
    ...repository,
    base_tree: baseTree,
    tree: [{ path: artifact.path, mode: artifact.mode, type: "blob", sha: null }]
  })).data, `artifact cleanup tree for ${artifact.path}`);
  const treeSha = requiredString(tree.sha, `artifact cleanup tree for ${artifact.path}`).toLowerCase();
  if (!EXACT_COMMIT.test(treeSha)) throw new Error(`artifact cleanup tree for ${artifact.path} is malformed`);
  const commit = asRecord((await github.request("POST /repos/{owner}/{repo}/git/commits", {
    ...repository,
    message: artifactCommitMessage(artifact.path),
    tree: treeSha,
    parents: [artifact.baseSha]
  })).data, `artifact cleanup commit for ${artifact.path}`);
  const headSha = requiredString(commit.sha, `artifact cleanup commit for ${artifact.path}`).toLowerCase();
  if (!EXACT_COMMIT.test(headSha)) throw new Error(`artifact cleanup commit for ${artifact.path} is malformed`);
  try {
    await github.request("POST /repos/{owner}/{repo}/git/refs", {
      ...repository,
      ref: `refs/heads/${artifact.branch}`,
      sha: headSha
    });
  } catch (error) {
    const concurrent = await readRefShaIfPresent(github, repository, artifact.branch);
    if (concurrent === null) throw error;
    await verifyArtifactCommit(github, repository, artifact, concurrent);
    return concurrent;
  }
  await verifyArtifactCommit(github, repository, artifact, headSha);
  return headSha;
}

async function findExactArtifactPull(
  github: OperatorGitHubRequester,
  repository: RepositoryRef,
  artifact: NonNullable<CleanPlanEntry["artifact"]>,
  headSha: string
): Promise<NormalizedPull | null> {
  const values = await listPages(github, "GET /repos/{owner}/{repo}/pulls", {
    ...repository,
    state: "open",
    base: "dev",
    head: `${repository.owner}:${artifact.branch}`
  });
  const pulls = values.map((value, index) => normalizePull(value, index, repository));
  if (pulls.length > 1) throw new Error(`artifact ${artifact.path} has ambiguous open cleanup pull requests`);
  if (pulls.length === 0) return null;
  const pull = pulls[0]!;
  const marker = parseArtifactMarker(pull.body);
  if (!pull.trustedActor
    || !pull.sameRepository
    || pull.draft
    || pull.state !== "open"
    || pull.baseRef !== "dev"
    || pull.baseSha !== artifact.baseSha
    || pull.headRef !== artifact.branch
    || pull.headSha !== headSha
    || pull.title !== artifactPullTitle(artifact.path)
    || !marker
    || marker.findingId !== artifact.findingId
    || marker.path !== artifact.path
    || marker.blobSha !== artifact.blobSha
    || marker.mode !== artifact.mode
    || marker.baseSha !== artifact.baseSha
    || marker.headSha !== headSha) {
    throw new Error(`artifact ${artifact.path} cleanup pull request is not the exact trusted marker-owned lane`);
  }
  const files = await listPages(github, "GET /repos/{owner}/{repo}/pulls/{pull_number}/files", {
    ...repository,
    pull_number: pull.number
  });
  if (files.length !== 1) throw new Error(`artifact ${artifact.path} cleanup pull contains additional changes`);
  const file = asRecord(files[0], `artifact cleanup pull #${pull.number} file`);
  if (file.filename !== artifact.path || file.status !== "removed" || file.sha !== artifact.blobSha) {
    throw new Error(`artifact ${artifact.path} cleanup pull did not preserve the exact removal identity`);
  }
  await verifyArtifactCommit(github, repository, artifact, headSha);
  return pull;
}

async function createOrResumeArtifactPull(
  github: OperatorGitHubRequester,
  repository: RepositoryRef,
  artifact: NonNullable<CleanPlanEntry["artifact"]>,
  headSha: string
): Promise<NormalizedPull> {
  let pull = await findExactArtifactPull(github, repository, artifact, headSha);
  if (!pull) {
    const response = await github.request("POST /repos/{owner}/{repo}/pulls", {
      ...repository,
      title: artifactPullTitle(artifact.path),
      body: artifactPullBody(artifact, headSha),
      head: artifact.branch,
      base: "dev",
      draft: false,
      maintainer_can_modify: false
    });
    const created = normalizePull(response.data, 0, repository);
    if (!created.trustedActor || created.headSha !== headSha || created.headRef !== artifact.branch || created.baseSha !== artifact.baseSha) {
      throw new Error(`artifact ${artifact.path} cleanup pull was not created under the trusted exact actor and refs`);
    }
    pull = await findExactArtifactPull(github, repository, artifact, headSha);
    if (!pull || pull.number !== created.number) throw new Error(`artifact ${artifact.path} cleanup pull was not durably re-observed`);
  }
  return pull;
}

async function armArtifactAutoMerge(
  github: OperatorGitHubRequester,
  repository: RepositoryRef,
  artifact: NonNullable<CleanPlanEntry["artifact"]>,
  headSha: string,
  pull: NormalizedPull
): Promise<NormalizedPull> {
  let current = await findExactArtifactPull(github, repository, artifact, headSha);
  if (!current || current.number !== pull.number) throw new Error(`artifact ${artifact.path} cleanup pull drifted before auto-merge`);
  if (!current.autoMerge) {
    if (!current.nodeId || !github.graphql) throw new Error(`artifact ${artifact.path} cleanup pull cannot arm exact protected auto-merge`);
    const response = asRecord(await github.graphql(
      "mutation EnableDarkFactoryCleanAutoMerge($pullRequestId: ID!) { enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: SQUASH }) { pullRequest { number autoMergeRequest { enabledAt } } } }",
      { pullRequestId: current.nodeId }
    ), `artifact cleanup pull #${current.number} auto-merge response`);
    const enabled = asRecord(response.enablePullRequestAutoMerge, `artifact cleanup pull #${current.number} enable auto-merge`);
    const resultPull = asRecord(enabled.pullRequest, `artifact cleanup pull #${current.number} auto-merge pull`);
    if (resultPull.number !== current.number || !resultPull.autoMergeRequest || typeof resultPull.autoMergeRequest !== "object") {
      throw new Error(`artifact ${artifact.path} cleanup pull auto-merge was not accepted`);
    }
  }
  current = await findExactArtifactPull(github, repository, artifact, headSha);
  if (!current || !current.autoMerge) throw new Error(`artifact ${artifact.path} cleanup pull auto-merge was not durably confirmed`);
  return current;
}

async function applyArtifactRepairAction(
  github: OperatorGitHubRequester,
  repository: RepositoryRef,
  entry: CleanPlanEntry,
  actions: CleanApplyReceipt["actions"],
  options: CleanApplyOptions
): Promise<void> {
  const artifact = requireArtifactEntry(entry);
  await revalidateArtifactSource(github, repository, entry);
  await recordAdmission(actionReceipt(entry, "applied", `Admitted exact generated blob removal through protected dev PR ${artifact.branch}.`), options.onAdmission);
  await revalidateArtifactSource(github, repository, entry);
  const headSha = await createOrResumeArtifactCommit(github, repository, artifact);
  await revalidateArtifactSource(github, repository, entry);
  const pull = await createOrResumeArtifactPull(github, repository, artifact, headSha);
  await revalidateArtifactSource(github, repository, entry);
  const armed = await armArtifactAutoMerge(github, repository, artifact, headSha, pull);
  await revalidateArtifactSource(github, repository, entry);
  await recordCompleted(
    actions,
    actionReceipt(entry, "applied", `Opened exact cleanup PR #${armed.number}, confirmed only ${artifact.path} is removed, and armed protected squash auto-merge behind trusted green checks.`),
    options.onCompletion
  );
}

function actionReceipt(
  entry: CleanPlanEntry,
  status: "applied" | "skipped",
  reason: string
): CleanApplyReceipt["actions"][number] {
  return {
    kind: entry.kind,
    target: entry.target,
    head: entry.head,
    ...(entry.version ? { version: entry.version } : {}),
    ...(entry.base ? { base: entry.base } : {}),
    ...(entry.baseSha ? { baseSha: entry.baseSha } : {}),
    ...(entry.headRef ? { headRef: entry.headRef } : {}),
    ...(entry.successor ? { successor: entry.successor } : {}),
    status,
    reason
  };
}

async function assertAutoreviewWorkflowActive(
  github: OperatorGitHubRequester,
  repository: RepositoryRef
): Promise<void> {
  const workflow = asRecord((await github.request("GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}", {
    ...repository,
    workflow_id: AUTOREVIEW_WORKFLOW
  })).data, "DarkFactory Autoreview workflow metadata");
  if (workflow.state !== "active") throw new Error("DarkFactory Autoreview workflow is unavailable or inactive");
}

function collectLocalEvidence(
  localPath: string,
  repository: RepositoryRef,
  remoteBranches: Map<string, string>,
  remoteTrees = new Map<string, string>(),
  policyBranches = new Set<string>()
): LocalCleanEvidence {
  const root = resolve(localPath);
  assertLocalRepositoryIdentity(root, repository);
  const worktreesByBranch = new Map<string, CleanWorktreeEvidence[]>();
  const rawWorktreeById = new Map<string, string>();
  const detachedWorktrees: CleanWorktreeEvidence[] = [];
  const porcelain = runGit(root, ["worktree", "list", "--porcelain"]);
  const records = porcelain.split(/\r?\n\r?\n/).map((block) => block.trim()).filter(Boolean);
  for (const record of records) {
    const fields = new Map(record.split(/\r?\n/).map((line) => {
      const separator = line.indexOf(" ");
      return separator === -1 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)];
    }));
    const worktreePath = fields.get("worktree") || "";
    const head = fields.get("HEAD") || "";
    const ref = fields.get("branch") || "";
    if (!worktreePath || !head) continue;
    const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : "(detached)";
    const status = runGit(worktreePath, ["status", "--porcelain=v2", "--untracked-files=all", "--ignore-submodules=none"]);
    const lines = status.split(/\r?\n/).filter(Boolean);
    const pathId = `wt-${createHash("sha256").update(resolve(worktreePath).toLowerCase()).digest("hex").slice(0, 16)}`;
    const evidence: CleanWorktreeEvidence = {
      pathId,
      branch,
      head,
      dirty: lines.some((line) => !line.startsWith("? ")),
      untracked: lines.some((line) => line.startsWith("? ")),
      submoduleDirty: lines.some((line) => /^[12u] .{2}S/.test(line)),
      rootCheckout: resolve(worktreePath).toLowerCase() === root.toLowerCase()
    };
    if (ref.startsWith("refs/heads/")) {
      worktreesByBranch.set(branch, [...(worktreesByBranch.get(branch) || []), evidence]);
    } else {
      detachedWorktrees.push(evidence);
    }
    rawWorktreeById.set(pathId, resolve(worktreePath));
  }

  const localBranches = new Map<string, {
    head: string;
    tree: string;
    ahead: number | null;
    unpublished: boolean;
    containedBy: string[];
    treeEquivalentTo: string[];
  }>();
  const refs = runGit(root, ["for-each-ref", "--format=%(refname:short)%09%(objectname)", "refs/heads"]);
  for (const line of refs.split(/\r?\n/).filter(Boolean)) {
    const [name, head] = line.split("\t");
    if (!name || !head) continue;
    const remoteHead = remoteBranches.get(name);
    const tree = runGit(root, ["rev-parse", `${head}^{tree}`]).trim();
    let ahead: number | null = null;
    if (remoteHead === head) {
      ahead = 0;
    } else if (remoteHead && gitObjectExists(root, remoteHead)) {
      const counts = runGit(root, ["rev-list", "--left-right", "--count", `${remoteHead}...${head}`]).trim().split(/\s+/).map(Number);
      ahead = Number.isFinite(counts[1]) ? counts[1] : null;
    }
    const containedBy: string[] = [];
    const treeEquivalentTo: string[] = [];
    for (const policy of policyBranches) {
      const policyHead = remoteBranches.get(policy);
      if (!policyHead) continue;
      if (remoteTrees.get(policy) === tree) treeEquivalentTo.push(policy);
      if (gitObjectExists(root, policyHead) && gitIsAncestor(root, head, policyHead)) containedBy.push(policy);
    }
    const independentlyPreserved = containedBy.length > 0 || treeEquivalentTo.length > 0;
    const unpublished = remoteHead
      ? remoteHead !== head && (ahead === null || ahead > 0)
      : !independentlyPreserved;
    localBranches.set(name, {
      head,
      tree,
      ahead,
      unpublished,
      containedBy: containedBy.sort(),
      treeEquivalentTo: treeEquivalentTo.sort()
    });
  }

  const orphanRefs: CleanEvidence["orphanRefs"] = [];
  const orphanOutput = runGit(root, ["for-each-ref", "--format=%(refname)%09%(objectname)%09%(*objectname)"]);
  const branchPreservation = new Map<string, string[]>();
  for (const [name, head] of remoteBranches) branchPreservation.set(head, [...(branchPreservation.get(head) || []), `branch:${name}`]);
  for (const line of orphanOutput.split(/\r?\n/).filter(Boolean)) {
    const [ref, object, peeled] = line.split("\t");
    const head = peeled || object;
    if (!ref || !head || ref.startsWith("refs/heads/")) continue;
    const treeProbe = spawnGit(root, ["rev-parse", `${head}^{tree}`]);
    const tree = treeProbe.status === 0 ? String(treeProbe.stdout || "").trim() : "unobservable";
    const preserved = [...(branchPreservation.get(head) || [])];
    if (preserved.length === 0 && tree !== "unobservable") {
      for (const [name, branchHead] of remoteBranches) {
        const branchTree = remoteTrees.get(name);
        if (!branchTree) continue;
        if (branchTree === tree) preserved.push(`tree:branch:${name}`);
      }
    }
    const associatedWorktree = detachedWorktrees.find((worktree) => worktree.head === head) || null;
    orphanRefs.push({
      ref,
      head,
      tree,
      independentlyPreservedBy: preserved.sort(),
      worktree: associatedWorktree,
      cleanupCandidate: /^(?:refs\/(?:df|archive|subtree)\/)/.test(ref)
    });
  }
  return {
    worktreesByBranch,
    rawWorktreeById,
    detachedWorktrees: detachedWorktrees.sort((a, b) => a.pathId.localeCompare(b.pathId)),
    localBranches,
    orphanRefs: orphanRefs.sort((a, b) => a.ref.localeCompare(b.ref))
  };
}

function emptyLocalEvidence(): LocalCleanEvidence {
  return { worktreesByBranch: new Map(), rawWorktreeById: new Map(), detachedWorktrees: [], localBranches: new Map(), orphanRefs: [] };
}

function assertLocalRepositoryIdentity(root: string, repository: RepositoryRef): void {
  const remote = runGit(root, ["remote", "get-url", "origin"]).trim();
  const observed = normalizeGithubRepository(remote);
  const expected = `${repository.owner}/${repository.repo}`.toLowerCase();
  if (observed !== expected) {
    throw new Error(`local checkout identity mismatch; expected ${expected}, observed ${observed || "unrecognized-origin"}`);
  }
}

function normalizeGithubRepository(remote: string): string {
  const value = remote.trim().replace(/\\/g, "/");
  const match = value.match(/^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : "";
}

function plannedWorktreeRef(saved: CleanPlan, entry: { target: string; head: string }): string {
  const matches = [...saved.evidence.branches, ...saved.evidence.localBranches]
    .flatMap((branch) => branch.worktrees)
    .filter((worktree) => worktree.pathId === entry.target && worktree.head === entry.head)
    .map((worktree) => worktree.branch);
  const branches = [...new Set(matches)];
  if (branches.length !== 1 || !branches[0] || branches[0] === "(detached)") {
    throw new Error(`clean worktree ${entry.target} lacks one exact planned branch identity; apply aborted`);
  }
  return `refs/heads/${branches[0]}`;
}

function revalidateWorktreeRemoval(
  root: string,
  rawPath: string,
  entry: { target: string; head: string },
  plannedRef: string
): void {
  const resolvedRoot = resolve(root).toLowerCase();
  const resolvedWorktree = resolve(rawPath).toLowerCase();
  if (resolvedRoot === resolvedWorktree) {
    throw new Error(`clean worktree ${entry.target} is the explicitly supplied root checkout; apply aborted`);
  }
  const head = runGit(rawPath, ["rev-parse", "HEAD"]).trim();
  if (head !== entry.head) throw new Error(`clean worktree ${entry.target} head drifted immediately before removal; apply aborted`);
  const status = runGit(rawPath, ["status", "--porcelain=v2", "--untracked-files=all", "--ignore-submodules=none"]);
  if (status.split(/\r?\n/).some(Boolean)) {
    throw new Error(`clean worktree ${entry.target} became dirty immediately before removal; apply aborted`);
  }
  const branch = runGit(rawPath, ["symbolic-ref", "-q", "HEAD"]).trim();
  if (branch !== plannedRef) {
    throw new Error(`clean worktree ${entry.target} branch drifted from ${plannedRef} immediately before removal; apply aborted`);
  }
}

function gitObjectExists(cwd: string, object: string): boolean {
  const result = spawnGit(cwd, ["cat-file", "-e", `${object}^{commit}`]);
  return result.status === 0;
}

function gitIsAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  const result = spawnGit(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error("git ancestry evidence is unobservable");
}

function spawnGit(cwd: string, args: string[]) {
  return spawnSync("git", ["-C", resolve(cwd), ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024
  });
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", resolve(cwd), ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024
  });
}

type NormalizedPull = ReturnType<typeof normalizePull>;

type AutoreviewObservation = Readonly<{
  state: "current" | "pending" | "owner-required" | "failed" | "stale";
  version: string | null;
  timestamp: number;
  id: number;
}>;

function groupIssueComments(values: unknown[]): Map<number, Record<string, unknown>[]> {
  const grouped = new Map<number, Record<string, unknown>[]>();
  for (const [index, value] of values.entries()) {
    const comment = asRecord(value, `issue comment ${index}`);
    const issueUrl = requiredString(comment.issue_url, `issue comment ${index} issue_url`);
    const match = /\/issues\/(\d+)(?:$|[?#])/.exec(issueUrl);
    if (!match) throw new Error(`issue comment ${index} has an unobservable issue identity`);
    const number = Number(match[1]);
    if (!Number.isSafeInteger(number) || number < 1) throw new Error(`issue comment ${index} has an invalid issue identity`);
    grouped.set(number, [...(grouped.get(number) ?? []), comment]);
  }
  for (const comments of grouped.values()) {
    comments.sort((left, right) => timestamp(left.created_at) - timestamp(right.created_at) || commentId(left) - commentId(right));
  }
  return grouped;
}

function successorNumber(body: string): number | null {
  const values = [...body.matchAll(/^\s*(?:[-*]\s*)?(?:successor|superseded[- ]by|replaced[- ]by)\s*:?\s*#(\d+)\s*$/gim)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  const unique = [...new Set(values)];
  return unique.length === 1 ? unique[0] : null;
}

function pullVersion(pull: Pick<NormalizedPull, "baseSha" | "headSha">): string {
  const version = `${pull.baseSha}:${pull.headSha}`;
  if (!PULL_REQUEST_VERSION.test(version)) throw new Error("pull request base/head identity is malformed or unobservable");
  return version;
}

function successorEvidence(
  pull: NormalizedPull,
  proof: "head-ancestry" | "tree-equivalence"
): NonNullable<CleanEvidence["pullRequests"][number]["successor"]> {
  return {
    number: pull.number,
    version: pullVersion(pull),
    base: pull.baseRef,
    baseSha: pull.baseSha,
    headRef: pull.headRef,
    head: pull.headSha,
    proof
  };
}

async function compareCommits(
  github: OperatorGitHubRequester,
  repository: RepositoryRef,
  ancestor: string,
  descendant: string
): Promise<{ ancestor: boolean }> {
  const comparison = asRecord((await github.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
    ...repository,
    basehead: `${ancestor}...${descendant}`
  })).data, `comparison ${ancestor}...${descendant}`);
  const mergeBase = asRecord(comparison.merge_base_commit, `comparison ${ancestor}...${descendant} merge base`);
  return { ancestor: mergeBase.sha === ancestor };
}

async function observePullAutoreview(
  github: OperatorGitHubRequester,
  repository: RepositoryRef,
  pull: NormalizedPull,
  comments: readonly Record<string, unknown>[]
): Promise<CleanEvidence["pullRequests"][number]["autoreview"]> {
  const version = pullVersion(pull);
  const observations = commentAutoreviewObservations(comments);
  for (const check of await listCheckRuns(github, repository, pull.headSha)) {
    const value = asRecord(check, `check run for ${pull.headSha}`);
    const app = asRecord(value.app, `check run app for ${pull.headSha}`);
    if (value.name !== AUTOREVIEW_CHECK_NAME || app.id !== TRUSTED_ACTIONS_APP_ID) continue;
    const headSha = typeof value.head_sha === "string" ? value.head_sha : "";
    const status = typeof value.status === "string" ? value.status : "";
    const exactHeadPending = headSha === pull.headSha && status !== "completed";
    observations.push({
      // A check run binds the head SHA but not the base SHA. It can suppress a
      // duplicate while pending; completed evidence becomes exact only through
      // the versioned App result comment.
      state: exactHeadPending ? "pending" : "stale",
      version: exactHeadPending ? version : null,
      timestamp: timestamp(value.completed_at) || timestamp(value.started_at),
      id: typeof value.id === "number" && Number.isSafeInteger(value.id) ? value.id : 0
    });
  }
  return resolveAutoreviewState(observations, version);
}

function observeIssueAutoreview(
  comments: readonly Record<string, unknown>[],
  version: string
): CleanEvidence["issues"][number]["autoreview"] {
  return resolveAutoreviewState(commentAutoreviewObservations(comments), version);
}

function commentAutoreviewObservations(comments: readonly Record<string, unknown>[]): AutoreviewObservation[] {
  const observations: AutoreviewObservation[] = [];
  for (const comment of comments) {
    if (!isTrustedDarkFactoryComment(comment) || typeof comment.body !== "string") continue;
    const body = comment.body;
    const time = commentTimestamp(comment);
    const id = commentId(comment);
    const cleanMarker = parseCleanAutoreviewMarker(body);
    if (cleanMarker) {
      observations.push({
        state: cleanMarker.status === "pending"
          ? time > 0 && Date.now() - time <= AUTOREVIEW_PENDING_MAX_AGE_MS
            ? "pending"
            : "stale"
          : cleanMarker.status,
        version: cleanMarker.version,
        timestamp: time,
        id
      });
    }
    if (!body.startsWith(AUTOREVIEW_RESULT_MARKER)) continue;
    const version = autoreviewVersionFromBody(body);
    observations.push({
      state: version === null
        ? "stale"
        : /\*\*Verdict:\*\* (?:Clean high confirmation|Auditable owner override)/.test(body)
          ? "current"
          : "failed",
      version,
      timestamp: time,
      id
    });
  }
  return observations;
}

function resolveAutoreviewState(
  observations: readonly AutoreviewObservation[],
  version: string
): "current" | "pending" | "owner-required" | "missing" | "failed" | "stale" {
  const exact = observations
    .filter((observation) => observation.version === version)
    .sort((left, right) => right.timestamp - left.timestamp || right.id - left.id);
  if (exact.length > 0) return exact[0]!.state;
  return observations.length > 0 ? "stale" : "missing";
}

function autoreviewVersionFromBody(body: string): string | null {
  const escaped = AUTOREVIEW_TARGET_VERSION_MARKER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escaped}([0-9a-f]{64}|[0-9a-f]{40}:[0-9a-f]{40}) -->$`, "m").exec(body);
  return match ? match[1] : null;
}

function parseCleanAutoreviewMarker(body: string): {
  kind: "issue" | "pull-request";
  number: number;
  version: string;
  status: "pending" | "failed" | "current" | "owner-required";
} | null {
  if (!body.startsWith(CLEAN_AUTOREVIEW_MARKER)) return null;
  const firstLine = body.split(/\r?\n/, 1)[0] ?? "";
  const match = /^<!-- darkfactory:clean-autoreview schema=1 kind=(issue|pull-request) number=(\d+) version=([0-9a-f]{64}|[0-9a-f]{40}:[0-9a-f]{40}) status=(pending|failed|current|owner-required) -->$/.exec(firstLine);
  if (!match) throw new Error("Trusted clean Autoreview marker is malformed");
  const number = Number(match[2]);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return {
    kind: match[1] as "issue" | "pull-request",
    number,
    version: match[3],
    status: match[4] as "pending" | "failed" | "current" | "owner-required"
  };
}

function renderCleanAutoreviewComment(
  entry: CleanPlanEntry,
  number: number,
  status: "pending" | "failed",
  detail: string
): string {
  if (!entry.version) throw new Error(`clean Autoreview target ${entry.target} lacks an exact version`);
  validateAutoreviewVersion(entry.kind, entry.version);
  return [
    `<!-- darkfactory:clean-autoreview schema=1 kind=${entry.kind} number=${number} version=${entry.version} status=${status} -->`,
    "## DarkFactory clean Autoreview dispatch",
    "",
    detail,
    "",
    `Target: \`${entry.target}\` at exact version \`${entry.version}\`.`
  ].join("\n");
}

function firstPendingAutoreviewComment(
  comments: readonly Record<string, unknown>[],
  kind: CleanPlanEntry["kind"],
  number: number,
  version: string
): number | null {
  const ids = comments.flatMap((comment) => {
    if (!isTrustedDarkFactoryComment(comment) || typeof comment.body !== "string") return [];
    const marker = parseCleanAutoreviewMarker(comment.body);
    if (!marker || marker.status !== "pending" || marker.kind !== kind || marker.number !== number || marker.version !== version) return [];
    const observedAt = commentTimestamp(comment);
    if (observedAt <= 0 || Date.now() - observedAt > AUTOREVIEW_PENDING_MAX_AGE_MS) return [];
    const id = commentId(comment);
    return id > 0 ? [id] : [];
  });
  return ids.length > 0 ? Math.min(...ids) : null;
}

async function listCheckRuns(
  github: OperatorGitHubRequester,
  repository: RepositoryRef,
  head: string
): Promise<unknown[]> {
  const runs: unknown[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const payload = asRecord((await github.request("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", {
      ...repository,
      ref: head,
      filter: "all",
      per_page: 100,
      page
    })).data, `check runs for ${head}`);
    if (!Array.isArray(payload.check_runs)) throw new Error(`check runs for ${head} are malformed or unobservable`);
    runs.push(...payload.check_runs);
    if (payload.check_runs.length < 100) return runs;
  }
  throw new Error(`check runs for ${head} exceeded the bounded 2000-record evidence window`);
}

async function readExactAutoreviewTarget(
  github: OperatorGitHubRequester,
  repository: RepositoryRef,
  entry: CleanPlanEntry,
  number: number
): Promise<{ autoreview: "current" | "pending" | "owner-required" | "missing" | "failed" | "stale"; comments: Record<string, unknown>[] }> {
  if (!entry.version) throw new Error(`clean target ${entry.target} lacks an exact version`);
  if (entry.kind === "issue") {
    const first = asRecord((await github.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
      ...repository,
      issue_number: number
    })).data, `issue ${entry.target}`);
    const firstComments = (await listPages(github, "GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      ...repository,
      issue_number: number
    })).map((comment, index) => asRecord(comment, `issue ${entry.target} comment ${index}`));
    const second = asRecord((await github.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
      ...repository,
      issue_number: number
    })).data, `issue ${entry.target}`);
    const secondComments = (await listPages(github, "GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      ...repository,
      issue_number: number
    })).map((comment, index) => asRecord(comment, `issue ${entry.target} confirmation comment ${index}`));
    for (const [issue, comments] of [[first, firstComments], [second, secondComments]] as const) {
      if (issue.pull_request !== undefined || issue.state !== "open") throw new Error(`issue ${entry.target} is no longer an open issue`);
      const effective = resolveEffectiveIssueContent(issue, comments);
      if (effective.version !== entry.version) throw new Error(`issue ${entry.target} drifted from exact version ${entry.version}`);
    }
    return { autoreview: observeIssueAutoreview(secondComments, entry.version), comments: secondComments };
  }
  if (entry.kind !== "pull-request") throw new Error(`clean target ${entry.target} cannot be Autoreviewed`);
  const first = normalizePull((await github.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    ...repository,
    pull_number: number
  })).data, number, repository);
  assertPullIdentity(first, entry, true);
  const comments = (await listPages(github, "GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
    ...repository,
    issue_number: number
  })).map((comment, index) => asRecord(comment, `pull request ${entry.target} comment ${index}`));
  const autoreview = await observePullAutoreview(github, repository, first, comments);
  const second = normalizePull((await github.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    ...repository,
    pull_number: number
  })).data, number, repository);
  assertPullIdentity(second, entry, true);
  return { autoreview, comments };
}

async function revalidatePullClosure(
  github: OperatorGitHubRequester,
  repository: RepositoryRef,
  number: number,
  entry: CleanPlanEntry
): Promise<string> {
  if (!entry.successor) throw new Error(`clean pull-request closure ${entry.target} lacks a successor`);
  const [sourceValue, successorValue] = await Promise.all([
    github.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { ...repository, pull_number: number }),
    github.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { ...repository, pull_number: entry.successor.number })
  ]);
  const source = normalizePull(sourceValue.data, number, repository);
  const successor = normalizePull(successorValue.data, entry.successor.number, repository);
  assertPullIdentity(source, entry, true);
  assertSuccessorIdentity(successor, entry.successor);
  if (successorNumber(source.body) !== entry.successor.number) {
    throw new Error(`pull request ${entry.target} successor pointer drifted`);
  }
  if (!source.sameRepository || !successor.sameRepository || source.baseRef !== successor.baseRef) {
    throw new Error(`pull request ${entry.target} successor is not a same-repository, same-base preservation lane`);
  }
  if (successor.state !== "open" && !successor.merged) {
    throw new Error(`pull request ${entry.target} successor is neither open nor merged`);
  }
  if (entry.successor.proof === "head-ancestry") {
    const comparison = await compareCommits(github, repository, source.headSha, successor.headSha);
    if (!comparison.ancestor) throw new Error(`pull request ${entry.target} successor ancestry proof drifted`);
  } else {
    const [sourceTree, successorTree] = await Promise.all([
      commitTree(github, repository, source.headSha),
      commitTree(github, repository, successor.headSha)
    ]);
    if (sourceTree !== successorTree) throw new Error(`pull request ${entry.target} successor tree proof drifted`);
  }
  return stableHash(source);
}

function assertPullIdentity(pull: NormalizedPull, entry: CleanPlanEntry, requireOpen: boolean): void {
  if (!entry.version || !entry.base || !entry.baseSha || !entry.headRef) throw new Error(`pull request ${entry.target} plan identity is incomplete`);
  if (pull.number !== cleanTargetNumber(entry)
    || pullVersion(pull) !== entry.version
    || pull.baseRef !== entry.base
    || pull.baseSha !== entry.baseSha
    || pull.headRef !== entry.headRef
    || pull.headSha !== entry.head
    || !pull.sameRepository) {
    throw new Error(`pull request ${entry.target} drifted from its exact base/head identity`);
  }
  if (requireOpen && pull.state !== "open") throw new Error(`pull request ${entry.target} is no longer open`);
}

function assertSuccessorIdentity(
  pull: NormalizedPull,
  expected: NonNullable<CleanPlanEntry["successor"]>
): void {
  if (pull.number !== expected.number
    || pullVersion(pull) !== expected.version
    || pull.baseRef !== expected.base
    || pull.baseSha !== expected.baseSha
    || pull.headRef !== expected.headRef
    || pull.headSha !== expected.head
    || !pull.sameRepository) {
    throw new Error(`successor pull request #${expected.number} drifted from its exact base/head identity`);
  }
}

function renderPullClosureComment(entry: CleanPlanEntry): string {
  if (!entry.version || !entry.successor) throw new Error(`clean pull-request closure ${entry.target} lacks exact evidence`);
  return [
    closureMarker(entry),
    "## DarkFactory clean closure",
    "",
    `This ${entry.classification} pull request is closed only because PR #${entry.successor.number} independently preserves its exact head through ${entry.successor.proof}.`,
    "",
    `Source version: \`${entry.version}\``,
    `Successor version: \`${entry.successor.version}\``
  ].join("\n");
}

function closureMarker(entry: CleanPlanEntry): string {
  if (!entry.version || !entry.successor) throw new Error(`clean pull-request closure ${entry.target} lacks exact evidence`);
  return `${CLEAN_CLOSURE_MARKER} schema=1 source=${entry.version} successor=${entry.successor.number} successor-version=${entry.successor.version} proof=${entry.successor.proof} -->`;
}

function isTrustedClosureComment(value: unknown, entry: CleanPlanEntry): boolean {
  return isTrustedDarkFactoryComment(value)
    && typeof (value as Record<string, unknown>).body === "string"
    && ((value as Record<string, unknown>).body as string).split(/\r?\n/, 1)[0] === closureMarker(entry);
}

function cleanTargetNumber(entry: CleanPlanEntry): number {
  const match = /^#(\d+)$/.exec(entry.target);
  const number = match ? Number(match[1]) : 0;
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`clean target ${entry.target} has an invalid identity`);
  return number;
}

function validateAutoreviewVersion(kind: CleanPlanEntry["kind"], version: string): void {
  const valid = kind === "issue" ? ISSUE_VERSION.test(version) : kind === "pull-request" && PULL_REQUEST_VERSION.test(version);
  if (!valid) throw new Error(`clean ${kind} Autoreview version is malformed`);
}

function commentTimestamp(comment: Record<string, unknown>): number {
  return timestamp(comment.updated_at) || timestamp(comment.created_at);
}

function commentId(comment: Record<string, unknown>): number {
  return typeof comment.id === "number" && Number.isSafeInteger(comment.id) ? comment.id : 0;
}

function timestamp(value: unknown): number {
  if (typeof value !== "string") return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function classifyPullRequest(findingIds: string[], body = ""): PullRequestClassification {
  if (findingIds.some((id) => /(?:superseded|obsolete)/.test(id))) return "superseded";
  if (findingIds.some((id) => /abandoned/.test(id))) return "abandoned";
  if (/^\s*(?:[-*]\s*)?status\s*:\s*superseded\s*$/im.test(body)) return "superseded";
  if (/^\s*(?:[-*]\s*)?status\s*:\s*abandoned\s*$/im.test(body)) return "abandoned";
  if (/^\s*(?:[-*]\s*)?superseded[- ]by\s*:?\s*#\d+\s*$/im.test(body)) return "superseded";
  if (findingIds.some((id) => /(?:-red|-not-mergeable|-checks-(?:missing|stuck|unobservable))$/.test(id))) return "red";
  if (findingIds.some((id) => /-stale$/.test(id))) return "stale";
  return "active";
}

function findingTouchesPull(finding: DoctorFinding, number: number): boolean {
  return new RegExp(`(?:^|-)pr-${number}(?:-|$)`).test(finding.id)
    || (finding.evidence || []).some((item) => new RegExp(`/pull/${number}(?:$|[?#])`).test(item.url || ""));
}

function findingTouchesIssue(finding: DoctorFinding, number: number): boolean {
  return new RegExp(`(?:^|-)issue-${number}(?:-|$)`).test(finding.id)
    || (finding.evidence || []).some((item) => new RegExp(`/issues/${number}(?:$|[?#])`).test(item.url || ""))
    || new RegExp(`(?:^|\\s)#${number}(?!\\d)`).test(finding.message);
}

async function listPages(github: OperatorGitHubRequester, route: string, parameters: Record<string, unknown>): Promise<unknown[]> {
  const values: unknown[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const response = await github.request(route, { ...parameters, per_page: 100, page });
    if (!Array.isArray(response.data)) throw new Error(`${route} returned malformed pagination data`);
    values.push(...response.data);
    if (response.data.length < 100) return values;
  }
  throw new Error(`${route} exceeded the bounded 2000-record evidence window`);
}

async function commitTree(github: OperatorGitHubRequester, repository: RepositoryRef, sha: string): Promise<string> {
  const commit = asRecord((await github.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
    ...repository,
    commit_sha: sha
  })).data, `commit ${sha}`);
  return requiredString(asRecord(commit.tree, `commit ${sha} tree`).sha, `commit ${sha} tree sha`);
}

async function isHeadContainedBy(github: OperatorGitHubRequester, repository: RepositoryRef, branchHead: string, policyBranch: string): Promise<boolean> {
  const comparison = asRecord((await github.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
    ...repository,
    basehead: `${branchHead}...${policyBranch}`
  })).data, `comparison ${branchHead}...${policyBranch}`);
  const mergeBase = asRecord(comparison.merge_base_commit, "comparison merge base");
  return mergeBase.sha === branchHead;
}

async function contentFingerprint(github: OperatorGitHubRequester, repository: RepositoryRef, path: string, ref: string): Promise<string> {
  try {
    const content = asRecord((await github.request("GET /repos/{owner}/{repo}/contents/{path}", { ...repository, path, ref })).data, `${path} content`);
    return typeof content.sha === "string" ? content.sha : stableHash(content);
  } catch (error) {
    if (isStatus(error, 404)) return "missing";
    throw error;
  }
}

function normalizePull(value: unknown, index: number, repository: RepositoryRef): {
  number: number;
  state: string;
  merged: boolean;
  body: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  sameRepository: boolean;
  trustedActor: boolean;
  autoMerge: boolean;
  nodeId: string | null;
  draft: boolean;
  title: string;
  updatedAt: string;
} {
  const pull = asRecord(value, `pull request ${index}`);
  const head = asRecord(pull.head, `pull request ${index} head`);
  const base = asRecord(pull.base, `pull request ${index} base`);
  const headRepo = head.repo ? asRecord(head.repo, `pull request ${index} head repo`) : {};
  const owner = headRepo.owner ? asRecord(headRepo.owner, `pull request ${index} head owner`) : {};
  const user = pull.user && typeof pull.user === "object" && !Array.isArray(pull.user) ? pull.user as Record<string, unknown> : {};
  return {
    number: requiredNumber(pull.number, `pull request ${index} number`),
    state: requiredString(pull.state, `pull request ${index} state`),
    merged: Boolean(pull.merged_at),
    body: typeof pull.body === "string" ? pull.body : "",
    headRef: requiredString(head.ref, `pull request ${index} head ref`),
    headSha: requiredString(head.sha, `pull request ${index} head sha`),
    baseRef: requiredString(base.ref, `pull request ${index} base ref`),
    baseSha: requiredString(base.sha, `pull request ${index} base sha`),
    sameRepository: String(owner.login || "").toLowerCase() === repository.owner.toLowerCase()
      && String(headRepo.name || "").toLowerCase() === repository.repo.toLowerCase(),
    trustedActor: user.login === "darkfactory-agent[bot]" && user.type === "Bot",
    autoMerge: pull.auto_merge !== null && pull.auto_merge !== undefined,
    nodeId: typeof pull.node_id === "string" && pull.node_id ? pull.node_id : null,
    draft: pull.draft === true,
    title: typeof pull.title === "string" ? pull.title : "",
    updatedAt: requiredString(pull.updated_at, `pull request ${index} updated_at`)
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is malformed or unobservable`);
  return value as Record<string, unknown>;
}

function requireExactMutator(options: CleanApplyOptions, label: string): void {
  if (!options.mutateExact) {
    throw new Error(`${label} requires an atomic conditional mutator that GitHub does not currently expose; target preserved`);
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} is malformed or unobservable`);
  return value;
}

function requiredNumber(value: unknown, label: string): number {
  if (!Number.isInteger(value)) throw new Error(`${label} is malformed or unobservable`);
  return value as number;
}

function isStatus(error: unknown, status: number): boolean {
  return Boolean(error && typeof error === "object" && "status" in error && (error as { status?: number }).status === status);
}
