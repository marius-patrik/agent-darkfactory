import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const SETUP_STAGE_ORDER = [
  "machine-wiring",
  "registration",
  "repository-bootstrap",
  "settings-enforcement",
  "issue-lane-cut",
  "readiness-convergence",
  "verification"
] as const;

export type RepairClass = "auto" | "pr" | "owner" | "blocked";
export type SetupStage = (typeof SETUP_STAGE_ORDER)[number];

const MAIN_ONLY_DATA_REPOSITORIES = new Set([
  "marius-patrik/andromeda-data",
  "marius-patrik/darkfactory-data"
]);

export function isMainOnlyDataRepository(repository: string): boolean {
  return MAIN_ONLY_DATA_REPOSITORIES.has(repository.toLowerCase());
}

export interface DoctorFinding {
  id: string;
  category: string;
  message: string;
  severity: string;
  repair_class: RepairClass;
  evidence?: Array<{ label?: string; url?: string }>;
  repair?: string[];
}

export interface DoctorReport {
  schema_version: number;
  target_repository: string;
  lifecycle: string;
  skipped?: boolean;
  reason?: string;
  source_refs: Record<string, string | null>;
  findings: DoctorFinding[];
  observations?: string[];
}

export interface SetupAction {
  id: string;
  repository: string;
  findingId: string;
  stage: SetupStage;
  repairClass: RepairClass;
  operation: string;
  supported: boolean;
  reason: string;
}

export interface SetupPlan {
  schemaVersion: 1;
  planId: string;
  evidenceHash: string;
  actions: SetupAction[];
  residue: Array<{ repository: string; findingId: string; repairClass: RepairClass; message: string }>;
}

export function planSetupConvergence(reports: DoctorReport[]): SetupPlan {
  const actions: SetupAction[] = [];
  const residue: SetupPlan["residue"] = [];

  for (const report of [...reports].sort((a, b) => a.target_repository.localeCompare(b.target_repository))) {
    for (const finding of [...report.findings].sort((a, b) => a.id.localeCompare(b.id))) {
      if (finding.repair_class === "owner" || finding.repair_class === "blocked") {
        residue.push({
          repository: report.target_repository,
          findingId: finding.id,
          repairClass: finding.repair_class,
          message: finding.message
        });
        continue;
      }

      const mapping = setupOperation(report.target_repository, finding);
      actions.push({
        id: `${report.target_repository}:${finding.id}`,
        repository: report.target_repository,
        findingId: finding.id,
        stage: mapping.stage,
        repairClass: finding.repair_class,
        operation: mapping.operation,
        supported: mapping.supported,
        reason: mapping.reason
      });
      if (!mapping.supported) {
        residue.push({
          repository: report.target_repository,
          findingId: finding.id,
          repairClass: "blocked",
          message: `No trusted setup executor is defined for ${finding.category}; refusing to guess.`
        });
      }
    }
  }

  actions.sort((a, b) => stageRank(a.stage) - stageRank(b.stage)
    || a.repository.localeCompare(b.repository)
    || a.findingId.localeCompare(b.findingId));
  residue.sort((a, b) => a.repository.localeCompare(b.repository) || a.findingId.localeCompare(b.findingId));
  const evidenceHash = stableHash({ actions, residue });
  return { schemaVersion: 1, planId: `setup-${evidenceHash.slice(0, 20)}`, evidenceHash, actions, residue };
}

function setupOperation(repository: string, finding: DoctorFinding): Pick<SetupAction, "stage" | "operation" | "supported" | "reason"> {
  const id = finding.id.toLowerCase();
  const category = finding.category.toLowerCase();
  if (isMainOnlyDataRepository(repository)) {
    return {
      stage: "settings-enforcement",
      operation: "main-only-data-boundary",
      supported: false,
      reason: "Canonical private main-only data repositories never enter code-repository setup; unsafe residue requires owner action or its documented compensating control."
    };
  }
  if (category === "machine runtime" || category === "runner health" || id.startsWith("canonical-launcher") || id.includes("agents-home")) {
    return { stage: "machine-wiring", operation: "converge-machine-runtime", supported: true, reason: "Only explicit repairable machine findings are converged through the exact canonical Agent OS launcher; unsafe state, route, or authority findings remain blocked." };
  }
  if (category === "source policy" || id.includes("source-policy-contradiction")) {
    return { stage: "registration", operation: "resolve-source-policy-contradiction", supported: false, reason: "Contradictory source policy must be reconciled at its canonical authority; target deletion is forbidden." };
  }
  if (id === "default-branch-head-missing") {
    return { stage: "repository-bootstrap", operation: "initialize-repository", supported: true, reason: "A fresh repository receives only an empty main commit, canonical main/dev refs, and observable automation settings before any reviewed managed-content PR or gate is installed." };
  }
  if (["dev-behind-main", "main-dev-diverged"].includes(id)) {
    return { stage: "verification", operation: "reconcile-branches", supported: true, reason: "Branch reconciliation is delegated to the trusted release engine, which preserves both histories and escalates semantic conflicts." };
  }
  if (category === "release lane" || id.startsWith("release-pr-")) {
    return { stage: "verification", operation: "converge-release", supported: true, reason: "The trusted release engine creates or updates a current-dev-derived release branch and lands only through green protected gates." };
  }
  if (category === "branch policy" || category === "branch protection" || category === "branch convergence" || id.includes("automerge") || id.includes("label") || id.includes("workflow")) {
    return { stage: "settings-enforcement", operation: "converge-settings", supported: true, reason: "Repository settings and taxonomy are reconciled from canonical policy." };
  }
  if (id.includes("ready") || id.includes("brake") || id.includes("dispatch")) {
    return { stage: "readiness-convergence", operation: "evaluate-readiness", supported: true, reason: "Readiness is machine-evaluated from one explicit repository predicate snapshot." };
  }
  if (category === "prd drift" || category === "issue lane") {
    return { stage: "issue-lane-cut", operation: "reconcile-issue-lane", supported: true, reason: "PRD scaffolding and issue mutations use stable markers and successor-preserving reconciliation." };
  }
  if (["managed file drift", "repository layout", "product layout", "product naming", "runtime authority", "doc staleness", "authority naming"].includes(category)) {
    return { stage: "repository-bootstrap", operation: "open-managed-setup-pr", supported: true, reason: "Protected repository content changes only through the managed setup PR lane." };
  }
  if (category === "repository hygiene") {
    return { stage: "verification", operation: "converge-clean", supported: true, reason: "Typed generated-artifact and managed-label repairs are delegated to the evidence-bound clean lane; all other work remains preserved." };
  }
  if (category === "submodule pointer") {
    return { stage: "verification", operation: "converge-submodules", supported: true, reason: "Released child pointers are delegated to the trusted submodule engine, which changes only an exact admitted gitlink through a reviewed PR." };
  }
  if (id.includes("registry") || category === "registration") {
    return { stage: "registration", operation: "converge-registration", supported: true, reason: "Registration changes only through one exact reviewed private-data source-policy PR, followed by trusted managed sync." };
  }
  if (["health", "submodule metadata"].includes(category)) {
    return { stage: "verification", operation: "verify-only", supported: false, reason: "The owning release or submodule lane must land before setup can verify convergence; setup has no authority to simulate that work." };
  }
  return { stage: "verification", operation: "unsupported", supported: false, reason: "No narrow, trusted mutation is defined for this finding." };
}

function stageRank(stage: SetupStage): number {
  return SETUP_STAGE_ORDER.indexOf(stage);
}

export type BranchClassification =
  | "protected-policy"
  | "open-pr"
  | "active-worktree"
  | "dirty-worktree"
  | "unpublished"
  | "ambiguous"
  | "proven-merged"
  | "proven-redundant";

export type PullRequestClassification = "active" | "stale" | "red" | "superseded" | "abandoned";
export type IssueClassification = "current" | "finding";
export type CleanClassification = BranchClassification | PullRequestClassification | IssueClassification | "review-finding";
export type AutoreviewState = "current" | "pending" | "owner-required" | "missing" | "failed" | "stale";

export interface CleanWorktreeEvidence {
  pathId: string;
  branch: string;
  head: string;
  dirty: boolean;
  untracked: boolean;
  submoduleDirty: boolean;
  rootCheckout?: boolean;
}

export interface CleanBranchEvidence {
  name: string;
  head: string;
  tree: string;
  protected: boolean;
  policyBranch: boolean;
  openPullRequest: number | null;
  mergedPullRequest: number | null;
  mergedPullHead: string | null;
  containedBy: string[];
  treeEquivalentTo: string[];
  localAhead: number | null;
  localUnpublished: boolean;
  worktrees: CleanWorktreeEvidence[];
}

export interface CleanRefEvidence {
  ref: string;
  head: string;
  tree: string;
  independentlyPreservedBy: string[];
  worktree: CleanWorktreeEvidence | null;
  cleanupCandidate: boolean;
}

export interface CleanEvidence {
  repository: string;
  defaultBranch: string;
  observedRefs: Record<string, string>;
  branches: CleanBranchEvidence[];
  localBranches: CleanBranchEvidence[];
  orphanRefs: CleanRefEvidence[];
  detachedWorktrees: CleanWorktreeEvidence[];
  pullRequests: Array<{
    number: number;
    version: string;
    base: string;
    baseSha: string;
    headRef: string;
    head: string;
    classification: PullRequestClassification;
    findingIds: string[];
    autoreview: AutoreviewState;
    successor: null | {
      number: number;
      version: string;
      base: string;
      baseSha: string;
      headRef: string;
      head: string;
      proof: "head-ancestry" | "tree-equivalence";
    };
  }>;
  issues: Array<{
    number: number;
    fingerprint: string;
    classification: IssueClassification;
    findingIds: string[];
    reviewable: boolean;
    autoreview: AutoreviewState;
    scopeDigest?: string;
    fold?: {
      findingId: string;
      findingFingerprint: string;
      successorNumber: number;
      successorVersion: string;
      sourceScopeDigest: string;
      successorScopeDigest: string;
      proof: "line-containment-v1";
    };
  }>;
  reviewFindings: Array<{
    id: string;
    category: string;
    severity: string;
    repairClass: RepairClass;
    message: string;
    evidence: Array<{ label?: string; url?: string }>;
    fingerprint: string;
  }>;
  pullRequestFingerprint: string;
  issueLaneFingerprint: string;
  prdFingerprint: string;
  artifactRepairs?: Array<{
    findingId: string;
    findingFingerprint: string;
    path: string;
    blobSha: string;
    mode: "100644" | "100755" | "120000";
    base: "dev";
    baseSha: string;
    branch: string;
    state: "needed" | "watch" | "resolved";
    pull?: {
      number: number;
      version: string;
      headRef: string;
      head: string;
      autoMerge: boolean;
      merged: boolean;
    };
  }>;
  managedLabels?: Array<{
    findingId: string;
    findingFingerprint: string;
    name: string;
    color: string;
    description: string;
    policyPath: ".agents/labels.json";
    policyBlob: string;
    policyRef: "dev";
    policyRevision: string;
  }>;
  markerIssues?: Array<{
    number: number;
    version: string;
    marker: string;
    reason: "resolved-doctor" | "duplicate-doctor" | "legacy-audit" | "duplicate-dashboard";
    findingSetFingerprint: string;
    successor?: { number: number; version: string };
  }>;
}

export interface CleanPlanEntry {
  kind: "remote-branch" | "local-branch" | "worktree" | "orphan-ref" | "pull-request" | "issue" | "lane-finding" | "artifact" | "managed-label" | "marker-issue";
  target: string;
  head: string;
  classification: CleanClassification;
  action: "preserve" | "delete" | "remove" | "autoreview" | "close" | "fold" | "repair-artifact" | "delete-label" | "watch";
  version?: string;
  base?: string;
  baseSha?: string;
  headRef?: string;
  successor?: {
    number: number;
    version: string;
    base: string;
    baseSha: string;
    headRef: string;
    head: string;
    proof: "head-ancestry" | "tree-equivalence";
  };
  issueFold?: NonNullable<CleanEvidence["issues"][number]["fold"]>;
  artifact?: NonNullable<CleanEvidence["artifactRepairs"]>[number];
  managedLabel?: NonNullable<CleanEvidence["managedLabels"]>[number];
  markerIssue?: NonNullable<CleanEvidence["markerIssues"]>[number];
  reasons: string[];
}

export interface CleanPlan {
  schemaVersion: 1;
  planId: string;
  evidenceHash: string;
  repository: string;
  createdAt: string;
  evidence: CleanEvidence;
  entries: CleanPlanEntry[];
}

export function buildCleanPlan(evidence: CleanEvidence, now = new Date()): CleanPlan {
  const entries: CleanPlanEntry[] = [];
  const admittedFindingRepairs = new Set<string>();
  for (const branch of [...evidence.branches].sort((a, b) => a.name.localeCompare(b.name))) {
    const classification = classifyBranch(branch);
    const safe = classification === "proven-merged" || classification === "proven-redundant";
    entries.push({
      kind: "remote-branch",
      target: branch.name,
      head: branch.head,
      classification,
      action: safe ? "delete" : "preserve",
      reasons: branchReasons(branch, classification)
    });
    for (const worktree of [...branch.worktrees].sort((a, b) => a.pathId.localeCompare(b.pathId))) {
      const removable = safe && !worktree.rootCheckout && !worktree.dirty && !worktree.untracked && !worktree.submoduleDirty && worktree.head === branch.head;
      entries.push({
        kind: "worktree",
        target: worktree.pathId,
        head: worktree.head,
        classification: removable ? classification : worktree.dirty || worktree.untracked || worktree.submoduleDirty ? "dirty-worktree" : "active-worktree",
        action: removable ? "remove" : "preserve",
        reasons: removable
          ? ["Clean worktree exactly matches an independently preserved branch head."]
          : [worktree.rootCheckout
            ? "The explicitly supplied root checkout is never a cleanup target."
            : "Worktree is active, dirty, untracked, submodule-dirty, or does not exactly match the observed branch head."]
      });
    }
  }

  const remoteBranchNames = new Set(evidence.branches.map((branch) => branch.name));
  for (const branch of [...evidence.localBranches].sort((a, b) => a.name.localeCompare(b.name))) {
    const classification = classifyBranch(branch);
    const safe = classification === "proven-merged" || classification === "proven-redundant";
    entries.push({
      kind: "local-branch",
      target: branch.name,
      head: branch.head,
      classification,
      action: safe ? "delete" : "preserve",
      reasons: branchReasons(branch, classification)
    });
    if (!remoteBranchNames.has(branch.name)) {
      for (const worktree of [...branch.worktrees].sort((a, b) => a.pathId.localeCompare(b.pathId))) {
        const removable = safe && !worktree.rootCheckout && !worktree.dirty && !worktree.untracked && !worktree.submoduleDirty && worktree.head === branch.head;
        entries.push({
          kind: "worktree",
          target: worktree.pathId,
          head: worktree.head,
          classification: removable ? classification : worktree.dirty || worktree.untracked || worktree.submoduleDirty ? "dirty-worktree" : "active-worktree",
          action: removable ? "remove" : "preserve",
          reasons: removable
            ? ["Clean worktree exactly matches an independently preserved local branch head."]
            : [worktree.rootCheckout
              ? "The explicitly supplied root checkout is never a cleanup target."
              : "Worktree is active, dirty, untracked, submodule-dirty, or lacks exact independent preservation proof."]
        });
      }
    }
  }

  for (const ref of [...evidence.orphanRefs].sort((a, b) => a.ref.localeCompare(b.ref))) {
    const preserved = ref.independentlyPreservedBy.length > 0;
    const clean = !ref.worktree || (!ref.worktree.dirty && !ref.worktree.untracked && !ref.worktree.submoduleDirty);
    const safe = ref.cleanupCandidate && preserved && clean && !ref.worktree?.rootCheckout;
    entries.push({
      kind: "orphan-ref",
      target: ref.ref,
      head: ref.head,
      classification: safe ? "proven-redundant" : ref.worktree && !clean ? "dirty-worktree" : "ambiguous",
      action: safe ? "delete" : "preserve",
      reasons: safe
        ? [`Exact tree/head is independently preserved by ${ref.independentlyPreservedBy.join(", ")}.`]
        : [ref.worktree?.rootCheckout
          ? "The explicitly supplied root checkout references this object; its ref is never a cleanup target."
          : ref.cleanupCandidate
          ? "No exact independent preservation proof, or associated worktree state is not clean."
          : "Ref namespace is not an admitted cleanup namespace and remains preserved."]
    });
  }

  for (const worktree of [...evidence.detachedWorktrees].sort((a, b) => a.pathId.localeCompare(b.pathId))) {
    entries.push({
      kind: "worktree",
      target: worktree.pathId,
      head: worktree.head,
      classification: worktree.dirty || worktree.untracked || worktree.submoduleDirty ? "dirty-worktree" : "active-worktree",
      action: "preserve",
      reasons: ["Detached worktrees are always preserved; no branch/ref deletion authority can be inferred."]
    });
  }


  for (const pull of [...evidence.pullRequests].sort((a, b) => a.number - b.number)) {
    const canClose = (pull.classification === "superseded" || pull.classification === "abandoned") && pull.successor !== null;
    const shouldReview = !canClose
      && pull.classification !== "abandoned"
      && pull.autoreview !== "current"
      && pull.autoreview !== "pending"
      && pull.autoreview !== "owner-required";
    entries.push({
      kind: "pull-request",
      target: `#${pull.number}`,
      head: pull.head,
      classification: pull.classification,
      action: canClose ? "close" : shouldReview ? "autoreview" : "preserve",
      version: pull.version,
      base: pull.base,
      baseSha: pull.baseSha,
      headRef: pull.headRef,
      ...(pull.successor ? { successor: pull.successor } : {}),
      reasons: canClose
        ? [`Exact head is independently preserved by PR #${pull.successor!.number} through ${pull.successor!.proof}; close with a durable successor receipt.`]
        : shouldReview
        ? [`Exact ${pull.version} is a live PR version requiring the shared Autoreview/fix protocol.`, ...pull.findingIds]
        : pull.classification === "abandoned" || pull.classification === "superseded"
        ? ["A successor was claimed but exact independent preservation was not proved; the PR remains preserved.", ...pull.findingIds]
        : pull.autoreview === "pending"
        ? ["The exact PR version already has an in-progress Autoreview; duplicate dispatch is suppressed."]
        : pull.autoreview === "owner-required"
        ? ["Trusted recovery could not bind the exact PR gate safely; the PR remains preserved for owner action.", ...pull.findingIds]
        : ["The exact PR version already has clean Autoreview evidence and remains in its normal merge lane."]
    });
  }
  for (const issue of [...evidence.issues].sort((a, b) => a.number - b.number)) {
    const shouldFold = issue.fold !== undefined;
    const ambiguousDuplicate = issue.findingIds.some((id) => id.startsWith("duplicate-issue-") || /-issue-duplicate$/.test(id));
    const shouldReview = !shouldFold
      && !ambiguousDuplicate
      && issue.classification === "finding"
      && issue.reviewable
      && issue.autoreview !== "current"
      && issue.autoreview !== "pending"
      && issue.autoreview !== "owner-required";
    entries.push({
      kind: "issue",
      target: `#${issue.number}`,
      head: issue.fingerprint,
      classification: issue.classification,
      action: shouldFold ? "fold" : shouldReview ? "autoreview" : "preserve",
      version: issue.fingerprint,
      ...(issue.fold ? { issueFold: issue.fold } : {}),
      reasons: shouldFold
        ? [`Exact source scope ${issue.fold!.sourceScopeDigest} is contained by open successor #${issue.fold!.successorNumber} at ${issue.fold!.successorVersion}; close only after revalidating both versions and publishing a durable receipt.`]
        : shouldReview
        ? ["The exact issue version has reviewable lane defects; invoke the shared issue Autoreview/autofix protocol without closing or dropping scope.", ...issue.findingIds]
        : issue.autoreview === "pending"
        ? ["The exact issue version already has an in-progress Autoreview; duplicate dispatch is suppressed.", ...issue.findingIds]
        : issue.autoreview === "current"
        ? ["The exact issue version already has clean Autoreview evidence; any remaining deterministic finding stays visible without duplicate model work.", ...issue.findingIds]
        : issue.autoreview === "owner-required"
        ? ["Trusted recovery could not safely dispatch this exact issue version; preserve it for owner action.", ...issue.findingIds]
        : issue.findingIds.length
        ? ["The finding is blocked or owner-owned; issue text and scope remain immutable.", ...issue.findingIds]
        : ["Issue contract is current under deterministic lane review."]
    });
    if (issue.fold) admittedFindingRepairs.add(issue.fold.findingId);
  }

  for (const artifact of [...(evidence.artifactRepairs ?? [])].sort((a, b) => a.path.localeCompare(b.path))) {
    admittedFindingRepairs.add(artifact.findingId);
    entries.push({
      kind: "artifact",
      target: artifact.path,
      head: artifact.blobSha,
      classification: "review-finding",
      action: artifact.state === "needed" ? "repair-artifact" : artifact.state === "watch" ? "watch" : "preserve",
      artifact,
      reasons: artifact.state === "needed"
        ? [`Exact generated blob ${artifact.blobSha} on ${artifact.base}@${artifact.baseSha} can be removed only through the marker-owned reviewed cleanup PR.`]
        : artifact.state === "watch"
        ? [`Exact cleanup PR #${artifact.pull!.number} is already admitted${artifact.pull!.autoMerge ? " with protected auto-merge armed" : ""}; wait for GitHub's green gates.`]
        : [`Merged cleanup PR #${artifact.pull!.number} is the durable exact receipt for this generated blob removal.`]
    });
  }

  for (const label of [...(evidence.managedLabels ?? [])].sort((a, b) => a.name.localeCompare(b.name))) {
    admittedFindingRepairs.add(label.findingId);
    entries.push({
      kind: "managed-label",
      target: label.name,
      head: label.findingFingerprint,
      classification: "review-finding",
      action: "delete-label",
      managedLabel: label,
      reasons: [`Exact policy-owned label is absent from the current managed taxonomy and may be deleted only while its color and description remain unchanged.`]
    });
  }

  for (const markerIssue of [...(evidence.markerIssues ?? [])].sort((a, b) => a.number - b.number)) {
    entries.push({
      kind: "marker-issue",
      target: `#${markerIssue.number}`,
      head: markerIssue.version,
      classification: "review-finding",
      action: "close",
      version: markerIssue.version,
      markerIssue,
      reasons: [`Exact trusted ${markerIssue.reason} marker is stale; close only after actor, marker, version${markerIssue.successor ? ", and successor" : ""} revalidation.`]
    });
  }

  for (const finding of [...evidence.reviewFindings].sort((a, b) => a.id.localeCompare(b.id))) {
    if (admittedFindingRepairs.has(finding.id)) continue;
    entries.push({
      kind: "lane-finding",
      target: finding.id,
      head: finding.fingerprint,
      classification: "review-finding",
      action: "preserve",
      reasons: [
        `${finding.severity}/${finding.repairClass}: ${finding.message}`,
        ...finding.evidence.filter((item) => item.url).map((item) => `${item.label || "evidence"}: ${item.url}`)
      ]
    });
  }

  const evidenceHash = stableHash(evidence);
  const planId = `clean-${evidenceHash.slice(0, 24)}`;
  return {
    schemaVersion: 1,
    planId,
    evidenceHash,
    repository: evidence.repository,
    createdAt: now.toISOString(),
    evidence,
    entries
  };
}

export function verifyCleanPlanAdmission(saved: CleanPlan, fresh: CleanPlan): void {
  if (saved.schemaVersion !== 1 || fresh.schemaVersion !== 1) throw new Error("clean plan schema is unsupported");
  if (saved.planId !== fresh.planId || saved.evidenceHash !== fresh.evidenceHash) {
    throw new Error("clean plan evidence drifted; apply aborted before mutation");
  }
  if (stableHash(saved.evidence) !== saved.evidenceHash) {
    throw new Error("clean plan evidence hash is invalid; apply aborted before mutation");
  }
  if (stableHash(saved.entries) !== stableHash(fresh.entries)) {
    throw new Error("clean plan actions drifted; apply aborted before mutation");
  }
}

export async function persistCleanPlan(agentsHome: string, plan: CleanPlan): Promise<string> {
  if (!agentsHome.trim()) throw new Error("ANDROMEDA_HOME is required for durable clean plans");
  const directory = join(resolve(agentsHome), "runtime", "transactions", "darkfactory", "clean-plans");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${plan.planId}.json`);
  await writeFile(path, `${JSON.stringify(plan, null, 2)}\n`, { encoding: "utf8", flag: "wx" }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
    const existing = JSON.parse(await readFile(path, "utf8")) as CleanPlan;
    if (existing.planId !== plan.planId || existing.evidenceHash !== plan.evidenceHash || stableHash(existing.entries) !== stableHash(plan.entries)) {
      throw new Error(`clean plan ID collision at ${path}`);
    }
  });
  return path;
}

export async function readCleanPlan(agentsHome: string, planId: string): Promise<CleanPlan> {
  if (!/^clean-[a-f0-9]{24}$/.test(planId)) throw new Error("invalid clean plan ID");
  const path = join(resolve(agentsHome), "runtime", "transactions", "darkfactory", "clean-plans", `${planId}.json`);
  const value = JSON.parse(await readFile(path, "utf8")) as CleanPlan;
  if (value.planId !== planId) throw new Error("clean plan file identity mismatch");
  return value;
}

function classifyBranch(branch: CleanBranchEvidence): BranchClassification {
  if (branch.policyBranch || branch.protected) return "protected-policy";
  if (branch.openPullRequest !== null) return "open-pr";
  if (branch.worktrees.some((worktree) => worktree.dirty || worktree.untracked || worktree.submoduleDirty)) return "dirty-worktree";
  if (branch.localUnpublished || (branch.localAhead !== null && branch.localAhead > 0)) return "unpublished";
  if (branch.worktrees.some((worktree) => worktree.rootCheckout)) return "active-worktree";
  if (branch.containedBy.length > 0 || (branch.mergedPullRequest !== null && branch.mergedPullHead === branch.head)) return "proven-merged";
  if (branch.treeEquivalentTo.length > 0) return "proven-redundant";
  if (branch.worktrees.length > 0) return "active-worktree";
  return "ambiguous";
}

function branchReasons(branch: CleanBranchEvidence, classification: BranchClassification): string[] {
  switch (classification) {
    case "protected-policy": return ["Protected or policy branch is immutable."];
    case "open-pr": return [`Exact head belongs to open PR #${branch.openPullRequest}.`];
    case "dirty-worktree": return ["At least one worktree has dirty, untracked, or recursively dirty submodule state."];
    case "unpublished": return ["Local branch has unpublished commits or is ahead of its observed remote."];
    case "active-worktree": return ["Branch is checked out in an active worktree."];
    case "proven-merged": return [
      branch.containedBy.length > 0
        ? `Head is contained by ${branch.containedBy.join(", ")}.`
        : `Exact head was independently preserved by merged PR #${branch.mergedPullRequest}.`
    ];
    case "proven-redundant": return [`Tree is exactly equivalent to ${branch.treeEquivalentTo.join(", ")}.`];
    default: return ["No exact ancestry, tree-equivalence, or merged-PR preservation proof."];
  }
}

export function stableHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
