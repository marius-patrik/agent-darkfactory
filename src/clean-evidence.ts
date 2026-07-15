import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";

import {
  buildCleanPlan,
  stableHash,
  verifyCleanPlanAdmission,
  type CleanBranchEvidence,
  type CleanEvidence,
  type CleanPlan,
  type CleanWorktreeEvidence,
  type DoctorFinding,
  type PullRequestClassification
} from "./operator.js";

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

  const stableReviewFindings = reviewFindings.map((finding) => ({
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
  const openPulls = normalizedPulls.filter((pull) => pull.state === "open").map((pull) => {
    const findingIds = reviewFindings.filter((finding) => findingTouchesPull(finding, pull.number)).map((finding) => finding.id).sort();
    return {
      number: pull.number,
      head: pull.headSha,
      classification: classifyPullRequest(findingIds),
      findingIds
    };
  });
  const openIssues = issues.filter((issue) => !asRecord(issue, "issue").pull_request).map((issue) => {
    const value = asRecord(issue, "issue");
    const number = requiredNumber(value.number, "issue number");
    const findingIds = reviewFindings.filter((finding) => findingTouchesIssue(finding, number)).map((finding) => finding.id).sort();
    return {
      number,
      fingerprint: stableHash({
        number,
        title: value.title,
        body: value.body,
        state: value.state,
        labels: Array.isArray(value.labels) ? value.labels : [],
        updated_at: value.updated_at
      }),
      classification: findingIds.length ? "finding" as const : "current" as const,
      findingIds
    };
  });

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
      updatedAt: pull.updatedAt
    }))),
    issueLaneFingerprint: stableHash(issues
      .filter((issue) => !asRecord(issue, "issue").pull_request)
      .map((issue) => {
        const value = asRecord(issue, "issue");
        return {
          number: value.number,
          title: value.title,
          body: value.body,
          state: value.state,
          labels: Array.isArray(value.labels) ? value.labels : [],
          updated_at: value.updated_at
        };
      })),
    prdFingerprint
  };
}

export interface CleanApplyReceipt {
  planId: string;
  repository: string;
  actions: Array<{ kind: string; target: string; head: string; status: "applied" | "skipped"; reason: string }>;
}

export async function applyCleanPlan(
  github: OperatorGitHubRequester,
  repository: RepositoryRef,
  saved: CleanPlan,
  freshEvidence: CleanEvidence,
  options: {
    localPath?: string;
    onAdmission?: (receipt: CleanApplyReceipt["actions"][number]) => Promise<void>;
    onCompletion?: (receipt: CleanApplyReceipt["actions"][number]) => Promise<void>;
  } = {}
): Promise<CleanApplyReceipt> {
  const fresh = buildCleanPlan(freshEvidence, new Date(saved.createdAt));
  verifyCleanPlanAdmission(saved, fresh);
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
    await recordAdmission({ kind: entry.kind, target: entry.target, head: entry.head, status: "applied", reason: "admitted exact clean preserved worktree removal" }, options.onAdmission);
    revalidateWorktreeRemoval(options.localPath, rawPath, entry);
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
    await github.request("DELETE /repos/{owner}/{repo}/git/refs/{ref}", { ...repository, ref: `heads/${entry.target}` });
    await recordCompleted(actions, { kind: entry.kind, target: entry.target, head: entry.head, status: "applied", reason: "exact head independently preserved and re-fetched" }, options.onCompletion);
  }

  for (const entry of saved.entries.filter((candidate) => candidate.action === "preserve")) {
    await recordCompleted(actions, { kind: entry.kind, target: entry.target, head: entry.head, status: "skipped", reason: entry.reasons.join(" ") }, options.onCompletion);
  }
  return { planId: saved.planId, repository: saved.repository, actions };
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

function revalidateWorktreeRemoval(root: string, rawPath: string, entry: { target: string; head: string }): void {
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
  if (!branch.startsWith("refs/heads/")) {
    throw new Error(`clean worktree ${entry.target} became detached immediately before removal; apply aborted`);
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

function classifyPullRequest(findingIds: string[]): PullRequestClassification {
  if (findingIds.some((id) => /(?:superseded|obsolete)/.test(id))) return "superseded";
  if (findingIds.some((id) => /abandoned/.test(id))) return "abandoned";
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
  headRef: string;
  headSha: string;
  baseRef: string;
  sameRepository: boolean;
  updatedAt: string;
} {
  const pull = asRecord(value, `pull request ${index}`);
  const head = asRecord(pull.head, `pull request ${index} head`);
  const base = asRecord(pull.base, `pull request ${index} base`);
  const headRepo = head.repo ? asRecord(head.repo, `pull request ${index} head repo`) : {};
  const owner = headRepo.owner ? asRecord(headRepo.owner, `pull request ${index} head owner`) : {};
  return {
    number: requiredNumber(pull.number, `pull request ${index} number`),
    state: requiredString(pull.state, `pull request ${index} state`),
    merged: Boolean(pull.merged_at),
    headRef: requiredString(head.ref, `pull request ${index} head ref`),
    headSha: requiredString(head.sha, `pull request ${index} head sha`),
    baseRef: requiredString(base.ref, `pull request ${index} base ref`),
    sameRepository: String(owner.login || "").toLowerCase() === repository.owner.toLowerCase()
      && String(headRepo.name || "").toLowerCase() === repository.repo.toLowerCase(),
    updatedAt: requiredString(pull.updated_at, `pull request ${index} updated_at`)
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is malformed or unobservable`);
  return value as Record<string, unknown>;
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
