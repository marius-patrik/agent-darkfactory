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

      const mapping = setupOperation(finding);
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

function setupOperation(finding: DoctorFinding): Pick<SetupAction, "stage" | "operation" | "supported" | "reason"> {
  const id = finding.id.toLowerCase();
  const category = finding.category.toLowerCase();
  if (category === "machine runtime" || category === "runner health" || id.startsWith("canonical-launcher") || id.includes("agents-home")) {
    return { stage: "machine-wiring", operation: "converge-machine-runtime", supported: false, reason: "Canonical Agent OS must expose a trusted machine-runtime repair executor before setup may mutate launcher, route, state, or runner registration." };
  }
  if (category === "source policy" || id.includes("source-policy-contradiction")) {
    return { stage: "registration", operation: "resolve-source-policy-contradiction", supported: false, reason: "Contradictory source policy must be reconciled at its canonical authority; target deletion is forbidden." };
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
  if (id.includes("registry") || category === "configuration prerequisites") {
    return { stage: "registration", operation: "converge-registration", supported: false, reason: "Canonical Andromeda-data registration is externally owned until #255 exposes a trusted mutation API." };
  }
  if (["health", "submodule metadata", "submodule pointer"].includes(category)) {
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
    head: string;
    classification: PullRequestClassification;
    findingIds: string[];
  }>;
  issues: Array<{
    number: number;
    fingerprint: string;
    classification: IssueClassification;
    findingIds: string[];
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
}

export interface CleanPlanEntry {
  kind: "remote-branch" | "local-branch" | "worktree" | "orphan-ref" | "pull-request" | "issue" | "lane-finding";
  target: string;
  head: string;
  classification: CleanClassification;
  action: "preserve" | "delete" | "remove";
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
    entries.push({
      kind: "pull-request",
      target: `#${pull.number}`,
      head: pull.head,
      classification: pull.classification,
      action: "preserve",
      reasons: pull.findingIds.length ? pull.findingIds : ["Open pull request is active and remains preserved for its review lane."]
    });
  }
  for (const issue of [...evidence.issues].sort((a, b) => a.number - b.number)) {
    entries.push({
      kind: "issue",
      target: `#${issue.number}`,
      head: issue.fingerprint,
      classification: issue.classification,
      action: "preserve",
      reasons: issue.findingIds.length ? issue.findingIds : ["Issue contract is current under deterministic lane review."]
    });
  }
  for (const finding of [...evidence.reviewFindings].sort((a, b) => a.id.localeCompare(b.id))) {
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
  if (!agentsHome.trim()) throw new Error("AGENTS_HOME is required for durable clean plans");
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
