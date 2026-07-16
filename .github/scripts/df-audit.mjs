import {
  AGENT_OS_DATA_REPO,
  DARK_FACTORY_DATA_REPO,
  createGithubClient,
  findAuditMarker,
  findPrdMarker,
  getBranchProtection,
  getOptionalFileContent,
  getRepository,
  isParkedRepo,
  listActiveManagedRepos,
  managedRepoLifecycleState,
  parseRepo,
  parsePrdItems,
  readManagedRepoRegistry,
  repoName,
  requiredEnv,
  slug,
  writeRunLedger
} from "./df-lib.mjs";

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DOCTOR_SCHEMA_VERSION = 1;
export const DOC_PATHS = ["PRD.md", "AGENTS.md", ".agents/.project/STATUS.md", ".agents/.project/PROJECT.md"];
export const DOC_STALE_DAYS = 90;
export const STALE_PR_DAYS = 7;
export const STALE_ISSUE_DAYS = 30;
export const PENDING_CHECK_HOURS = 2;
export const WORKER_SESSION_LOOKBACK_DAYS = 14;
const COMMIT_EVIDENCE_PAGE_SIZE = 100;
const MAX_COMMIT_EVIDENCE_PAGES = 20;
// Managed Validate and review workflows are GitHub Actions check suites. GitHub's
// public Actions App ID is stable across repositories and prevents a same-name
// status/check from an arbitrary App from satisfying repository-doctor policy.
export const TRUSTED_GATE_APP_ID = 15368;
const TRUSTED_GATE_NAMES = new Set(["Validate", "Codex Review", "DarkFactory Autoreview"]);

export const ANDROMEDA_LAYOUT = [
  { name: "DarkFactory", path: "plugins/DarkFactory", repo: "marius-patrik/DarkFactory" },
  { name: "LifeQuest", path: "plugins/LifeQuest", repo: "marius-patrik/LifeQuest" },
  { name: "SkyAgent", path: "plugins/SkyAgent", repo: "marius-patrik/SkyAgent" },
  { name: "Singularity", path: "apps/Singularity", repo: "marius-patrik/Singularity" },
  { name: "Fabrica", path: "apps/Fabrica", repo: "marius-patrik/Fabrica" },
  { name: "data", path: "data/andromeda", repo: "marius-patrik/Andromeda-data" },
  { name: "darkfactory-data", path: "data/darkfactory", repo: "marius-patrik/darkfactory-data" }
];

const ANDROMEDA_ROOTS = ["apps", "commands", "data", "hooks", "packages", "plugins", "roles", "skills"];
const HEALTHY_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);
const RED_CONCLUSIONS = new Set(["action_required", "cancelled", "failure", "startup_failure", "stale", "timed_out"]);
const DOCTOR_MODES = new Set(["diagnose", "report"]);
const CONTROL_REPO = { owner: "marius-patrik", repo: "DarkFactory" };
const DOCTOR_ISSUE_AUTHORS = new Set(["darkfactory-agent[bot]", "mp-agents[bot]"]);
const MAIN_ONLY_DATA_REPOSITORIES = new Set([AGENT_OS_DATA_REPO, DARK_FACTORY_DATA_REPO].map((name) => name.toLowerCase()));
const REPOSITORY_TREE_ENTRY_TYPES = new Set(["blob", "tree", "commit"]);
export const DOCTOR_REPORT_LABEL_NAMES = ["P0", "P1", "P2", "df:doctor", "df:class:mechanical"];
const GENERATED_SEGMENTS = new Set([
  ".cache",
  ".darkfactory-verification",
  ".pytest_cache",
  ".turbo",
  ".venv",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target"
]);
const PROVIDER_STATE_SEGMENTS = new Set([".agy", ".claude", ".codex", ".gemini", ".kimi-code"]);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}

async function main() {
  const token = requiredEnv("DARK_FACTORY_TOKEN");
  const controlRepo = parseRepo(requiredEnv("DF_CONTROL_REPO"));
  const mode = parseDoctorMode(process.env.DF_DOCTOR_MODE || "diagnose");
  let ledgerGithub;
  if (mode === "report") {
    const ledgerToken = requiredEnv("DF_LEDGER_TOKEN");
    if (ledgerToken === token) throw new Error("Repository-doctor target and ledger tokens must be distinct authorities.");
    ledgerGithub = createGithubClient(ledgerToken, "darkfactory-repository-doctor-ledger");
  }
  const target = process.env.DF_TARGET_REPO?.trim() || "";
  const reports = await runRepositoryDoctor(createGithubClient(token, "darkfactory-repository-doctor"), {
    controlRepo,
    all: process.env.DF_DOCTOR_ALL === "true",
    target: target || repoName(controlRepo),
    trigger: process.env.DF_TRIGGER || "unknown",
    mode,
    ledgerGithub,
    localPath: process.env.DF_LOCAL_PATH?.trim() || "",
    agentsHome: (process.env.DF_AGENTS_HOME || process.env.AGENTS_HOME || "").trim(),
    provenSecrets: (process.env.DF_PROVEN_SECRETS || "").split(",").map((item) => item.trim()).filter(Boolean)
  });

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(reports, null, 2));
  } else {
    console.log(formatDoctorReports(reports));
  }
}

export function parseDoctorMode(value) {
  const mode = String(value || "diagnose").trim().toLowerCase();
  if (mode === "repair") {
    throw new Error("Repository-doctor repair mode is not implemented. Diagnose first, then authorize repair through a separate reviewed work item.");
  }
  if (!DOCTOR_MODES.has(mode)) {
    throw new Error(`Unknown repository-doctor mode '${value}'. Expected diagnose or report.`);
  }
  return mode;
}

export async function runRepositoryDoctor(github, options = {}) {
  const mode = parseDoctorMode(options.mode || "diagnose");
  assertDoctorReportAuthorities(mode, github, options.ledgerGithub);
  const controlRepo = options.controlRepo || CONTROL_REPO;
  const registry = options.registry || await readManagedRepoRegistry(options.root || process.cwd());
  const targets = await resolveDoctorTargets(github, controlRepo, registry, options);
  if (options.localPath && targets.length !== 1) {
    throw new Error("An explicit local checkout can only be inspected with one repository target.");
  }
  const reports = [];

  for (const repository of targets) {
    const lifecycle = doctorLifecycleState(repository, controlRepo, registry);
    if (isParkedRepo(repository) || lifecycle === "parked") {
      const report = skippedReport(repository, mode, "Repository is parked; doctor performed no target-repository writes or repair work.");
      if (mode === "report") await publishSkippedDoctorReport(options.ledgerGithub, repository, report);
      reports.push(report);
      continue;
    }

    if (
      mode === "report"
      && normalizedName(repository) !== normalizedName(controlRepo)
      && lifecycle !== "active"
    ) {
      const report = skippedReport(
        repository,
        mode,
        `Repository lifecycle is ${lifecycle}; report mode is restricted to the control repository and active managed repositories. No target-repository write was attempted.`
      );
      await publishSkippedDoctorReport(options.ledgerGithub, repository, report);
      reports.push(report);
      continue;
    }

    const metadata = await getRepository(github, repository);
    if (metadata.archived === true || metadata.disabled === true || lifecycle === "archived") {
      const report = skippedReport(
        repository,
        mode,
        `Repository is read-only (archived=${metadata.archived === true}, disabled=${metadata.disabled === true}, lifecycle=${lifecycle}).`
      );
      if (mode === "report") await publishSkippedDoctorReport(options.ledgerGithub, repository, report);
      reports.push(report);
      continue;
    }

    const report = await auditTargetRepository(github, repository, metadata, {
      ...options,
      controlRepo,
      lifecycle,
      mode
    });

    if (mode === "report") {
      await publishDoctorReport(github, options.ledgerGithub, repository, report);
    }
    reports.push(report);
  }

  return reports;
}

export function doctorLifecycleState(repository, controlRepo, registry) {
  if (
    normalizedName(repository) === normalizedName(controlRepo)
    || isMainOnlyDataRepository(repository)
  ) {
    return "active";
  }
  return managedRepoLifecycleState(repository, registry);
}

export function assertDoctorReportAuthorities(mode, targetGithub, ledgerGithub) {
  if (mode !== "report") return;
  if (!ledgerGithub) {
    throw new Error("Repository-doctor report mode requires a distinct repository-scoped ledger client; target authority is never a ledger fallback.");
  }
  if (ledgerGithub === targetGithub) {
    throw new Error("Repository-doctor target and ledger clients must be distinct authorities.");
  }
}

export async function assertDoctorReportLabels(github, repository) {
  const available = await listRepositoryLabelNames(github, repository);
  const missing = DOCTOR_REPORT_LABEL_NAMES.filter((name) => !available.has(name));
  if (missing.length) {
    throw new Error(`Repository-doctor report preflight failed for ${repoName(repository)}: required labels are missing (${missing.join(", ")}); label taxonomy must be provisioned outside report mode.`);
  }
}

export async function publishDoctorReport(github, ledgerGithub, repository, report) {
  await assertDoctorReportLabels(github, repository);
  // Complete, validated enumeration is the source of truth for every issue
  // mutation in this publication. A malformed or capped response aborts before
  // either the admission ledger or the target repository is written.
  const issues = await listDoctorIssues(github, repository, "all");
  const plannedActions = planDoctorReportActions(report.findings);
  report.actions.push(await writeDoctorLedger(ledgerGithub, repository, report, { phase: "admission", plannedActions }));
  let mutationError = null;
  try {
    await reconcileDoctorIssues(github, repository, report.findings, issues, report.actions);
    await retireLegacyAuditIssues(github, repository, issues, report.actions);
  } catch (error) {
    mutationError = error;
  }

  let completionError = null;
  try {
    report.actions.push(await writeDoctorLedger(ledgerGithub, repository, report, {
      phase: "completion",
      plannedActions,
      publicationStatus: mutationError ? "partial" : "complete"
    }));
  } catch (error) {
    completionError = error;
  }
  if (mutationError) {
    if (completionError) {
      throw new Error("Repository-doctor target publication failed and its completion ledger could not be written.", { cause: mutationError });
    }
    throw mutationError;
  }
  if (completionError) throw completionError;
  return report;
}

export function planDoctorReportActions(findings) {
  return [
    ...findings.map((finding) => ({ action: "upsert-repair-issue", finding: finding.id })),
    { action: "close-resolved-repair-issues", scope: "trusted df-doctor markers absent from the current finding set" },
    { action: "retire-legacy-audit-issues", scope: "trusted aggregate df-audit marker" }
  ];
}

export async function publishSkippedDoctorReport(ledgerGithub, repository, report) {
  report.actions.push(await writeDoctorLedger(ledgerGithub, repository, report, { phase: "completion", plannedActions: [] }));
  return report;
}

async function resolveDoctorTargets(github, controlRepo, registry, options) {
  if (Array.isArray(options.targets) && options.targets.length > 0) {
    return uniqueRepositories(options.targets.map((item) => typeof item === "string" ? parseRepo(item) : item));
  }
  if (options.all) {
    const active = await listActiveManagedRepos(github, controlRepo, { registry, root: options.root });
    return uniqueRepositories([controlRepo, ...active]);
  }
  return [typeof options.target === "string" ? parseRepo(options.target) : (options.target || controlRepo)];
}

async function auditTargetRepository(github, repository, metadata, options) {
  const observedAt = new Date(options.now || Date.now()).toISOString();
  const isData = isMainOnlyDataRepository(repository);
  const defaultBranch = metadata.default_branch || "";
  const branches = await listBranches(github, repository);
  const branchNames = new Set(branches.map((branch) => branch.name));
  const pulls = await listOpenPullRequests(github, repository);
  const issues = isData ? [] : await listDoctorIssues(github, repository, "all");
  const openIssues = issues.filter((issue) => issue.state === "open");
  const tree = !isData && defaultBranch ? await getRecursiveTree(github, repository, defaultBranch) : null;
  const findings = [];
  const observations = [];

  const branchAudit = await auditBranchAndReleaseState(github, repository, metadata, {
    branches,
    branchNames,
    pulls,
    isData,
    now: options.now
  });
  findings.push(...branchAudit.findings);
  observations.push(...branchAudit.observations);

  if (isData) {
    observations.push("Canonical data repository was inspected only under the main-only protection, administration, force-push, deletion, and branch-hygiene policy; managed-code, workflow, PRD, and submodule requirements do not apply.");
  } else {
    findings.push(...await auditManagedFileDrift(github, repository, defaultBranch, options.controlRepo));
    findings.push(...await auditRepositoryTree(repository, tree, { isData: false }));
    findings.push(...await auditRootLayout(github, repository, defaultBranch, tree));
    findings.push(...await auditRuntimeAuthority(github, repository, defaultBranch, options.controlRepo));
    findings.push(...await auditPrerequisites(github, repository, defaultBranch, options));
    findings.push(...auditIssueLane(repository, issues, { now: options.now }));
    findings.push(...await auditPrdDrift(github, repository, defaultBranch, openIssues));
    findings.push(...await auditDocStaleness(repository, metadata, defaultBranch, github));
    findings.push(...await auditRetiredAuthorityNames(github, repository, defaultBranch));

    for (const branch of ["main", "dev"].filter((name) => branchNames.has(name))) {
      findings.push(...await auditHealth(repository, branch, branchSha(branches, branch), github, { now: options.now }));
      findings.push(...await auditSubmoduleState(github, repository, branch));
    }
  }

  if (options.localPath) {
    const local = auditLocalCheckout(options.localPath, repository);
    findings.push(...local.findings);
    observations.push(...local.observations);
  } else {
    observations.push("Local dirty and recursive submodule worktree state was not observable; only committed GitHub state was inspected.");
  }

  if (normalizedName(repository) === normalizedName(options.controlRepo) && options.agentsHome) {
    const isolation = auditWorkerSessionIsolation(options.agentsHome, { now: options.now });
    findings.push(...isolation.findings);
    observations.push(...isolation.observations);
  } else if (normalizedName(repository) === normalizedName(options.controlRepo)) {
    observations.push("Canonical Agent OS session workdirs were not observable because AGENTS_HOME was not supplied.");
  }

  return {
    schema_version: DOCTOR_SCHEMA_VERSION,
    mode: options.mode,
    trigger: options.trigger || "unknown",
    target_repository: repoName(repository),
    lifecycle: options.lifecycle,
    observed_at: observedAt,
    source_refs: {
      default_branch: defaultBranch,
      main: branchNames.has("main") ? branchSha(branches, "main") : null,
      dev: branchNames.has("dev") ? branchSha(branches, "dev") : null,
      control: `${repoName(options.controlRepo)}@main`
    },
    read_only: options.mode === "diagnose",
    findings: dedupeFindings(findings),
    observations: [...new Set(observations)].sort(),
    actions: [],
    token_usage: {
      model_calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      note: "Repository doctor is deterministic and uses no model tokens."
    }
  };
}

export async function auditBranchAndReleaseState(github, repository, metadata, context) {
  const findings = [];
  const observations = [];
  const { branches, branchNames, pulls, isData } = context;

  if (metadata.default_branch !== "main") {
    findings.push(doctorFinding(
      "default-branch-not-main",
      "branch policy",
      `Default branch is \`${metadata.default_branch || "missing"}\`, expected \`main\`.`,
      { severity: "error", repair: ["Change the repository default branch to main after reconciling refs and protections."] }
    ));
  }
  if (!branchNames.has("main")) {
    findings.push(doctorFinding("main-branch-missing", "branch policy", "Required `main` branch is missing.", {
      severity: "critical",
      repair: ["Restore main only from a verified released commit through an owner-reviewed operation."]
    }));
  }
  if (!isData && !branchNames.has("dev")) {
    findings.push(doctorFinding("dev-branch-missing", "branch policy", "Required integration branch `dev` is missing.", {
      severity: "critical",
      repair: ["Restore dev from the verified convergence point without rewriting main."]
    }));
  }

  let comparison = null;
  if (!isData && branchNames.has("main") && branchNames.has("dev")) {
    const observedComparison = await compareBranches(github, repository, "main", "dev");
    if (!isValidBranchComparison(observedComparison)) {
      findings.push(doctorFinding("main-dev-comparison-malformed", "branch convergence", "The main...dev comparison response is malformed or incomplete, so branch convergence is unobservable.", {
        severity: "critical",
        evidence: [compareEvidence(repository, "main", "dev")]
      }));
    } else {
      comparison = observedComparison;
      observations.push(`main...dev is ${comparison.status} (ahead=${comparison.ahead_by}, behind=${comparison.behind_by}).`);
    }
    if (comparison?.status === "behind") {
      findings.push(doctorFinding("dev-behind-main", "branch convergence", "`dev` is behind `main` and must be synchronized before new work/release.", {
        severity: "error",
        evidence: [compareEvidence(repository, "main", "dev")],
        repair: ["Open a reviewed main-to-dev reconciliation PR; do not force-update dev."]
      }));
    } else if (comparison?.status === "diverged") {
      findings.push(doctorFinding("main-dev-diverged", "branch convergence", "`main` and `dev` have diverged.", {
        severity: "critical",
        evidence: [compareEvidence(repository, "main", "dev")],
        repair: ["Create a reconciliation branch and escalate semantic conflicts; block release until green."]
      }));
    }
  }

  if (!isData && metadata.allow_auto_merge !== true) {
    findings.push(doctorFinding("automerge-disabled", "branch protection", "Repository auto-merge is disabled for a protected automation lane.", {
      severity: "error",
      repair: ["Enable repository auto-merge after confirming required gates are enforced."]
    }));
  }

  for (const branch of ["main", ...(!isData ? ["dev"] : [])].filter((name) => branchNames.has(name))) {
    findings.push(...await auditBranchProtection(github, repository, branch, {
      protectionRequired: true,
      gatesRequired: !isData,
      observations
    }));
  }

  const activeHeads = new Set(
    pulls
      .filter((pull) => sameRepositoryPullHead(pull, repository) && pull.head?.ref && pull.head?.sha)
      .map((pull) => `${pull.head.ref}\0${pull.head.sha}`)
  );
  for (const branch of branches) {
    const verifiedPullHead = activeHeads.has(`${branch.name}\0${branch.commit?.sha || ""}`);
    if (branch.name === "main" || (!isData && branch.name === "dev") || verifiedPullHead) continue;
    findings.push(doctorFinding(`extra-branch-${slug(branch.name)}`, "branch hygiene", `Extra branch \`${branch.name}\` is not the head of an open same-repository PR.`, {
      severity: "warning",
      evidence: [{ label: branch.name, url: `https://github.com/${repoName(repository)}/tree/${encodeURIComponent(branch.name)}` }],
      repair: ["Delete only after re-fetching refs and proving it is not protected, active, or unmerged."]
    }));
  }

  const pullAudit = await auditPullRequests(github, repository, pulls, { now: context.now });
  findings.push(...pullAudit.findings);

  if (!isData && comparison) {
    findings.push(...await auditReleaseLane(github, repository, comparison, pullAudit.pulls));
  }
  return { findings, observations };
}

export async function auditBranchProtection(github, repository, branch, options = {}) {
  const protectionRequired = options.protectionRequired ?? (options.required === true);
  const gatesRequired = options.gatesRequired ?? (options.required === true);
  const protection = await getBranchProtection(github, repository, branch);
  if (!protection.configured) {
    if (protection.status === 403) {
      return [doctorFinding(`protection-${slug(branch)}-unobservable`, "branch protection", `Branch protection for \`${branch}\` is inaccessible (HTTP 403); posture is unknown, not absent.`, {
        severity: "critical",
        evidence: [{ label: `${branch} settings`, url: `https://github.com/${repoName(repository)}/settings/branches` }],
        repair: ["Grant metadata-only administration read to the trusted doctor token, then re-run diagnosis. Do not change branch settings based on this finding alone."]
      })];
    }
    if (!protectionRequired) return [];
    return [doctorFinding(`protection-${slug(branch)}-missing`, "branch protection", `Branch \`${branch}\` has no readable protection.`, {
      severity: "critical",
      evidence: [{ label: `${branch} settings`, url: `https://github.com/${repoName(repository)}/settings/branches` }],
      repair: ["Configure required validation and review gates; block force-push, deletion, and automation bypass."]
    })];
  }

  const findings = [];
  const data = protection.data || {};
  const required = requiredStatusChecks(data);
  const contexts = required.checks.map((check) => check.context);
  const hasValidate = contexts.includes("Validate");
  const hasReview = contexts.includes("Codex Review") || contexts.includes("DarkFactory Autoreview");
  if (gatesRequired) {
    if (required.malformed) {
      findings.push(doctorFinding(`protection-${slug(branch)}-required-checks-malformed`, "branch protection", `Branch \`${branch}\` returned malformed or unobservable required-check metadata.`, {
        severity: "critical",
        repair: ["Re-fetch branch protection with administration-read access and require exact app-bound gate records before treating the branch as protected."]
      }));
    }
    if (!hasValidate) {
      findings.push(doctorFinding(`protection-${slug(branch)}-validate-missing`, "branch protection", `Branch \`${branch}\` does not require the exact \`Validate\` gate. Required contexts: ${formatList(contexts)}.`, {
        severity: "critical",
        repair: ["Require the exact repository Validate check on this branch."]
      }));
    }
    if (!hasReview) {
      findings.push(doctorFinding(`protection-${slug(branch)}-review-missing`, "branch protection", `Branch \`${branch}\` does not require either exact review gate \`Codex Review\` or \`DarkFactory Autoreview\`. Required contexts: ${formatList(contexts)}.`, {
        severity: "critical",
        repair: ["Require the exact DarkFactory Autoreview gate (or the current exact Codex Review migration gate) on this branch."]
      }));
    }
    for (const check of required.checks.filter((item) => ["Validate", "Codex Review", "DarkFactory Autoreview"].includes(item.context))) {
      if (!Number.isInteger(check.appId) || check.appId <= 0) {
        findings.push(doctorFinding(`protection-${slug(branch)}-${slug(check.context)}-app-unbound`, "branch protection", `Required gate \`${check.context}\` on \`${branch}\` is not bound to one observable GitHub App.`, {
          severity: "critical",
          evidence: [{ label: `${branch} ${check.context} observed app_id=unbound`, url: `https://github.com/${repoName(repository)}/settings/branches` }],
          repair: ["Bind the exact required check to its trusted GitHub App identity; do not accept an arbitrary same-name status context."]
        }));
      } else if (check.appId !== TRUSTED_GATE_APP_ID) {
        findings.push(doctorFinding(`protection-${slug(branch)}-${slug(check.context)}-app-mismatch`, "branch protection", `Required gate \`${check.context}\` on \`${branch}\` is bound to app_id \`${check.appId}\`; managed gate producer GitHub Actions requires app_id \`${TRUSTED_GATE_APP_ID}\`.`, {
          severity: "critical",
          evidence: [{ label: `${branch} ${check.context} observed app_id=${check.appId}`, url: `https://github.com/${repoName(repository)}/settings/branches` }],
          repair: ["Bind the exact required check to the GitHub Actions App identity; do not trust a positive but arbitrary App ID with the same context name."]
        }));
      }
    }
    if (data.required_status_checks?.strict !== true) {
      findings.push(doctorFinding(`protection-${slug(branch)}-strict-missing`, "branch protection", `Branch \`${branch}\` does not require branches to be up to date before merge.`, { severity: "critical" }));
    }
  }
  if (data.enforce_admins?.enabled === false) {
    findings.push(doctorFinding(`protection-${slug(branch)}-admin-bypass`, "branch protection", `Branch \`${branch}\` does not enforce protections for administrators.`, {
      severity: "critical", repair: ["Enable administrator enforcement or record an explicit owner decision; automation itself must never use bypass authority."]
    }));
  } else if (data.enforce_admins?.enabled !== true) {
    findings.push(doctorFinding(`protection-${slug(branch)}-admin-bypass-unobservable`, "branch protection", `Administrator enforcement posture for \`${branch}\` is malformed or unobservable.`, { severity: "critical" }));
  }
  if (data.allow_force_pushes?.enabled === true) {
    findings.push(doctorFinding(`protection-${slug(branch)}-force-push`, "branch protection", `Force-push is allowed on \`${branch}\`.`, { severity: "critical" }));
  } else if (data.allow_force_pushes?.enabled !== false) {
    findings.push(doctorFinding(`protection-${slug(branch)}-force-push-unobservable`, "branch protection", `Force-push posture for \`${branch}\` is malformed or unobservable.`, { severity: "critical" }));
  }
  if (data.allow_deletions?.enabled === true) {
    findings.push(doctorFinding(`protection-${slug(branch)}-deletion`, "branch protection", `Deletion is allowed on \`${branch}\`.`, { severity: "critical" }));
  } else if (data.allow_deletions?.enabled !== false) {
    findings.push(doctorFinding(`protection-${slug(branch)}-deletion-unobservable`, "branch protection", `Deletion posture for \`${branch}\` is malformed or unobservable.`, { severity: "critical" }));
  }
  options.observations?.push(`Branch ${branch} protection: protection_required=${protectionRequired}, gates_required=${gatesRequired}, strict=${data.required_status_checks?.strict === true}, enforce_admins=${data.enforce_admins?.enabled === true}, required=${required.checks.map((check) => `${check.context}@app:${check.appId ?? "unbound"}`).join(", ") || "none"}.`);
  return findings;
}

export function requiredStatusChecks(protection) {
  const required = protection?.required_status_checks;
  if (!required || typeof required !== "object") return { checks: [], malformed: true };
  if (Array.isArray(required.checks)) {
    const checks = [];
    let malformed = false;
    for (const check of required.checks) {
      if (typeof check?.context !== "string" || !check.context.trim()) {
        malformed = true;
        continue;
      }
      if (check.app_id !== null && check.app_id !== undefined && !Number.isInteger(check.app_id)) malformed = true;
      checks.push({ context: check.context, appId: Number.isInteger(check.app_id) ? check.app_id : null });
    }
    return { checks, malformed };
  }
  if (Array.isArray(required.contexts)) {
    const valid = required.contexts.filter((context) => typeof context === "string" && context.trim());
    return {
      checks: valid.map((context) => ({ context, appId: null })),
      malformed: valid.length !== required.contexts.length
    };
  }
  return { checks: [], malformed: true };
}

async function auditPullRequests(github, repository, pulls, options = {}) {
  const findings = [];
  const enriched = [];
  const now = new Date(options.now || Date.now()).getTime();

  for (const pull of pulls) {
    const details = await getPullRequest(github, repository, pull.number);
    const checks = await getCommitChecks(github, repository, pull.head?.sha);
    const ageDays = ageIn(now, details.updated_at, 24 * 60 * 60 * 1000);
    const pullUrl = details.html_url || `https://github.com/${repoName(repository)}/pull/${pull.number}`;
    const evidence = [{ label: `PR #${pull.number}`, url: pullUrl }];
    const red = checks.filter((check) => check.state === "red");
    const pending = checks.filter((check) => check.state === "pending");
    const unknown = checks.filter((check) => check.state === "unknown");
    const wrongApp = checks.filter((check) => TRUSTED_GATE_NAMES.has(check.name) && check.appId !== TRUSTED_GATE_APP_ID);

    if (ageDays >= STALE_PR_DAYS) {
      findings.push(doctorFinding(`pr-${pull.number}-stale`, "pull request health", `PR #${pull.number} has not changed for ${ageDays} days.`, {
        severity: "warning", evidence, repair: ["Rebase/reconcile, close as superseded, or document the active blocker."]
      }));
    }
    if (red.length) {
      findings.push(doctorFinding(`pr-${pull.number}-red`, "pull request health", `PR #${pull.number} has failing checks: ${red.map(checkLabel).join(", ")}.`, {
        severity: "error",
        evidence: [...evidence, ...red.flatMap((check) => check.url ? [{ label: check.name, url: check.url }] : [])],
        repair: ["Run bounded review/fix or implementation repair; never merge while red."]
      }));
    }
    if (unknown.length) {
      findings.push(doctorFinding(`pr-${pull.number}-checks-unobservable`, "pull request health", `PR #${pull.number} has malformed or unknown check conclusions: ${unknown.map(checkLabel).join(", ")}.`, {
        severity: "critical",
        evidence,
        repair: ["Re-fetch checks from the trusted API and repair the check producer/schema; never treat an unknown conclusion as green."]
      }));
    }
    if (wrongApp.length) {
      findings.push(doctorFinding(`pr-${pull.number}-trusted-gate-app-mismatch`, "pull request health", `PR #${pull.number} has trusted gate names produced by an untrusted or unobservable App: ${wrongApp.map((check) => `${check.name}@app:${check.appId ?? "unbound"}`).join(", ")}; GitHub Actions app_id ${TRUSTED_GATE_APP_ID} is required.`, {
        severity: "critical",
        evidence: [...evidence, ...wrongApp.flatMap((check) => check.url ? [{ label: `${check.name}@app:${check.appId ?? "unbound"}`, url: check.url }] : [])],
        repair: ["Restore the base-trusted managed workflow producer; never accept a same-name gate from another App or an unbound commit status."]
      }));
    }
    const oldPending = pending.filter((check) => ageIn(now, check.startedAt, 60 * 60 * 1000) >= PENDING_CHECK_HOURS);
    if (oldPending.length) {
      findings.push(doctorFinding(`pr-${pull.number}-checks-stuck`, "pull request health", `PR #${pull.number} has checks pending longer than ${PENDING_CHECK_HOURS} hours: ${oldPending.map(checkLabel).join(", ")}.`, {
        severity: "error", evidence
      }));
    }
    if (checks.length === 0) {
      findings.push(doctorFinding(`pr-${pull.number}-checks-missing`, "pull request health", `PR #${pull.number} has no observable checks.`, {
        severity: "error", evidence, repair: ["Restore required Validate and review workflows before merge."]
      }));
    }
    if (["blocked", "dirty"].includes(String(details.mergeable_state || "").toLowerCase()) || details.mergeable === false) {
      findings.push(doctorFinding(`pr-${pull.number}-not-mergeable`, "pull request health", `PR #${pull.number} is not mergeable (${details.mergeable_state || "conflicting"}).`, {
        severity: "error", evidence, repair: ["Reconcile through a normal branch update; never force-push or bypass."]
      }));
    }
    enriched.push({ ...details, checks });
  }
  return { findings, pulls: enriched };
}

async function auditReleaseLane(github, repository, comparison, pulls) {
  const findings = [];
  const releaseCandidates = pulls.filter((pull) => pull.base?.ref === "main" && (pull.head?.ref === "dev" || pull.head?.ref?.startsWith("release/")));
  const trustedCandidates = releaseCandidates.filter((pull) => sameRepositoryPullHead(pull, repository));
  const eligible = [];

  for (const pull of releaseCandidates.filter((item) => !sameRepositoryPullHead(item, repository))) {
    findings.push(doctorFinding(`release-pr-${pull.number}-untrusted-head`, "release lane", `Release PR #${pull.number} does not use a same-repository head and cannot satisfy release policy.`, {
      severity: "critical", evidence: [{ label: `PR #${pull.number}`, url: pull.html_url }]
    }));
  }

  for (const pull of trustedCandidates) {
    if (pull.head?.ref === "dev") {
      findings.push(doctorFinding(`release-pr-${pull.number}-uses-dev-head`, "release lane", `Release PR #${pull.number} uses long-lived \`dev\` as its head.`, {
        severity: "error",
        evidence: [{ label: `PR #${pull.number}`, url: pull.html_url }],
        repair: ["Use a protected release/<id> branch so delete-after-merge cannot remove dev."]
      }));
      continue;
    }

    let relation;
    try {
      relation = await compareBranches(github, repository, "dev", pull.head?.sha || pull.head?.ref);
    } catch (error) {
      if (![403, 404, 409, 422].includes(error?.status)) throw error;
      findings.push(doctorFinding(`release-pr-${pull.number}-dev-lineage-unobservable`, "release lane", `Current-dev ancestry for release PR #${pull.number} is unobservable; it cannot satisfy release policy.`, {
        severity: "critical", evidence: [{ label: `PR #${pull.number}`, url: pull.html_url }]
      }));
      continue;
    }
    if (!isValidBranchComparison(relation)) {
      findings.push(doctorFinding(`release-pr-${pull.number}-dev-lineage-malformed`, "release lane", `Current-dev ancestry for release PR #${pull.number} returned malformed comparison evidence; it cannot satisfy release policy.`, {
        severity: "critical", evidence: [{ label: `PR #${pull.number}`, url: pull.html_url }]
      }));
      continue;
    }
    if (!["identical", "ahead"].includes(relation?.status)) {
      findings.push(doctorFinding(`release-pr-${pull.number}-not-current-dev-derived`, "release lane", `Release PR #${pull.number} does not contain current \`dev\` (dev...release is \`${relation?.status || "malformed"}\`).`, {
        severity: "critical",
        evidence: [{ label: `PR #${pull.number}`, url: pull.html_url }],
        repair: ["Recreate or update the release branch from current dev through a reviewed, non-force-pushed branch update."]
      }));
      continue;
    }
    eligible.push(pull);
  }

  if (comparison.status === "ahead") {
    if (eligible.length === 0) {
      findings.push(doctorFinding("release-pr-missing", "release lane", "`dev` is ahead of `main`, but no eligible current-dev-derived release PR targets `main`.", {
        severity: "error",
        evidence: [compareEvidence(repository, "main", "dev")],
        repair: ["Create or update a protected release branch and reviewed release PR."]
      }));
    }
  } else if (comparison.status === "identical" && trustedCandidates.length) {
    for (const pull of trustedCandidates) {
      findings.push(doctorFinding(`release-pr-${pull.number}-obsolete`, "release lane", `Release PR #${pull.number} remains open although main and dev are identical.`, {
        severity: "warning", evidence: [{ label: `PR #${pull.number}`, url: pull.html_url }]
      }));
    }
  }
  return findings;
}

export async function auditManagedFileDrift(github, repository, targetRef, controlRepo = CONTROL_REPO) {
  if (!targetRef) return [doctorFinding("managed-target-ref-missing", "managed file drift", "Cannot inspect managed files without a target ref.", { severity: "critical" })];
  const findings = [];
  const manifestText = await getOptionalFileContent(github, controlRepo, ".darkfactory/managed-repository.json", "main");
  const manifest = parseManagedManifest(manifestText);
  if (!manifest.ok) {
    return [doctorFinding("managed-baseline-invalid", "managed file drift", manifest.error, {
      severity: "critical", repair: ["Repair the trusted control manifest before any managed sync or repair."]
    })];
  }

  for (const filePath of manifest.value.requiredFiles) {
    const packageOwned = manifest.value.packageFiles.includes(filePath);
    const sourceRepo = packageOwned ? controlRepo : parseRepo(AGENT_OS_DATA_REPO);
    const sourcePath = packageOwned ? filePath : `managed-repository/${filePath}`;
    const expected = await getOptionalFileContent(github, sourceRepo, sourcePath, "main");
    if (expected === null) {
      findings.push(doctorFinding(`managed-source-missing-${slug(filePath)}`, "managed file drift", `Authoritative source \`${repoName(sourceRepo)}:${sourcePath}\` is missing.`, {
        severity: "critical", repair: ["Restore the baseline source; do not infer or copy from the target repository."]
      }));
      continue;
    }
    const actual = await getOptionalFileContent(github, repository, filePath, targetRef);
    if (actual === null) {
      findings.push(doctorFinding(`managed-file-missing-${slug(filePath)}`, "managed file drift", `Required managed file \`${filePath}\` is missing on \`${targetRef}\`.`, {
        severity: "error", repair: ["Open/update the marker-owned managed setup PR from the authoritative source."]
      }));
    } else if (normalizeText(actual) !== normalizeText(expected)) {
      findings.push(doctorFinding(`managed-file-drift-${slug(filePath)}`, "managed file drift", `Managed file \`${filePath}\` differs from \`${repoName(sourceRepo)}:${sourcePath}\`.`, {
        severity: "error", repair: ["Reconcile through the managed setup PR; preserve repository-owned files outside the manifest."]
      }));
    }
  }

  for (const filePath of manifest.value.removedFiles) {
    const actual = await getOptionalFileContent(github, repository, filePath, targetRef);
    if (actual !== null) {
      findings.push(doctorFinding(`managed-removed-file-${slug(filePath)}`, "managed file drift", `Retired managed file \`${filePath}\` is still present.`, {
        severity: "error", repair: ["Remove it through the managed setup PR after verifying no active workflow depends on it."]
      }));
    }
  }

  findings.push(...await auditProjectOverlay(github, repository, targetRef));
  return findings;
}

function parseManagedManifest(text) {
  if (!text) return { ok: false, error: "Trusted control managed-repository manifest is missing." };
  try {
    const value = JSON.parse(text);
    if (
      value?.schemaVersion !== 1 ||
      !Array.isArray(value.requiredFiles) ||
      !Array.isArray(value.packageFiles) ||
      !Array.isArray(value.removedFiles)
    ) {
      return { ok: false, error: "Trusted control managed-repository manifest has an invalid schema." };
    }
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: `Trusted control managed-repository manifest is invalid JSON: ${error.message || String(error)}` };
  }
}

async function auditProjectOverlay(github, repository, targetRef) {
  const findings = [];
  const dataRepo = parseRepo(AGENT_OS_DATA_REPO);
  const prefix = `managed-repository/repositories/${repository.owner}/${repository.repo}/.agents/.project`;
  const files = await listRemoteDirectoryFiles(github, dataRepo, prefix, "main");
  for (const source of files) {
    const relative = source.path.slice(prefix.length + 1);
    const targetPath = `.agents/.project/${relative}`;
    const expected = await getOptionalFileContent(github, dataRepo, source.path, "main");
    const actual = await getOptionalFileContent(github, repository, targetPath, targetRef);
    if (actual === null || normalizeText(actual) !== normalizeText(expected)) {
      findings.push(doctorFinding(`managed-project-overlay-${slug(targetPath)}`, "managed file drift", `Project overlay \`${targetPath}\` is ${actual === null ? "missing" : "drifted"}.`, {
        severity: "error", repair: ["Reconcile from the repository-specific Andromeda-data overlay through managed setup."]
      }));
    }
  }
  return findings;
}

export async function auditRepositoryTree(repository, tree, options = {}) {
  if (!tree) return [doctorFinding("repository-tree-unavailable", "repository layout", "Recursive repository tree is unavailable.", { severity: "critical" })];
  if (tree.truncated === true || !Array.isArray(tree.tree)) {
    return [doctorFinding("repository-tree-incomplete", "repository layout", "GitHub returned a truncated or malformed recursive tree.", { severity: "critical" })];
  }

  const findings = [];
  let malformedEntries = 0;
  for (const entry of tree.tree) {
    if (typeof entry?.path !== "string" || !entry.path.trim() || !REPOSITORY_TREE_ENTRY_TYPES.has(entry?.type)) {
      malformedEntries += 1;
      continue;
    }
    const filePath = entry.path.replace(/\\/g, "/");
    const segments = filePath.split("/");
    const lower = segments.map((segment) => segment.toLowerCase());
    const allowedProjectAuthority = filePath === ".agents" || filePath === ".agents/.project" || filePath.startsWith(".agents/.project/");
    const allowedDarkFactoryAuthority = filePath === ".darkfactory" || filePath.startsWith(".darkfactory/");
    const nestedAgents = lower.includes(".agents") && !allowedProjectAuthority;
    const nestedDarkFactory = lower.includes(".darkfactory") && !allowedDarkFactoryAuthority;
    const providerState = lower.some((segment) => PROVIDER_STATE_SEGMENTS.has(segment));
    const generated = lower.some((segment) => GENERATED_SEGMENTS.has(segment));
    const sensitive = lower.some((segment) => ["agents_secrets", "secrets"].includes(segment)) || /(^|\/)(auth\.json|\.env)$/i.test(filePath);
    const nestedGitMetadata = /(^|\/)\.git($|\/)/i.test(filePath) || (filePath !== ".gitmodules" && filePath.endsWith("/.gitmodules"));

    if (!options.isData && (nestedAgents || nestedDarkFactory)) {
      findings.push(doctorFinding(`state-boundary-${slug(filePath)}`, "state boundary", `Repository-local control/state path \`${filePath}\` is outside the allowed root authority.`, { severity: "critical" }));
    }
    if (providerState || sensitive) {
      findings.push(doctorFinding(`sensitive-artifact-${slug(filePath)}`, "state boundary", `Provider/auth/secret artifact \`${filePath}\` is committed.`, {
        severity: "critical", repair: ["Rotate exposed credentials if applicable, remove through reviewed history policy, and preserve only canonical encrypted/data authority."]
      }));
    }
    if (generated) {
      findings.push(doctorFinding(`generated-artifact-${slug(filePath)}`, "repository hygiene", `Generated/runtime artifact \`${filePath}\` is committed.`, { severity: "warning" }));
    }
    if (nestedGitMetadata) {
      findings.push(doctorFinding(`nested-git-metadata-${slug(filePath)}`, "nested repository state", `Nested Git metadata \`${filePath}\` is committed outside the root submodule contract.`, { severity: "error" }));
    }
  }
  if (malformedEntries > 0) {
    findings.push(doctorFinding("repository-tree-entry-malformed", "repository layout", `GitHub returned ${malformedEntries} malformed recursive tree ${malformedEntries === 1 ? "entry" : "entries"}; repository layout evidence is incomplete.`, {
      severity: "critical"
    }));
  }
  return findings;
}

export async function auditRootLayout(github, repository, ref, tree) {
  if (!ref || !tree?.tree) return [];
  const normalized = normalizedName(repository);
  const findings = [];
  const paths = new Map(tree.tree.map((entry) => [entry.path, entry]));

  if (normalized === "marius-patrik/andromeda") {
    for (const root of ANDROMEDA_ROOTS) {
      if (!paths.has(root)) {
        findings.push(doctorFinding(`andromeda-root-${slug(root)}-missing`, "product layout", `Required Andromeda root \`${root}/\` is missing.`, { severity: "error" }));
      }
    }
    const gitmodules = await getOptionalFileContent(github, repository, ".gitmodules", ref);
    const entries = parseGitmodules(gitmodules || "");
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    for (const expected of ANDROMEDA_LAYOUT) {
      const actual = byPath.get(expected.path);
      if (!actual) {
        findings.push(doctorFinding(`andromeda-submodule-${slug(expected.path)}-missing`, "product layout", `Required gitlink \`${expected.path}\` (${expected.name}) is missing or misplaced.`, { severity: "critical" }));
        continue;
      }
      const resolved = resolveSubmoduleRepo(repository, actual.url);
      if (actual.name !== expected.name || !resolved || normalizedName(resolved) !== expected.repo.toLowerCase()) {
        const observedRepository = resolved
          ? `GitHub repository \`${repoName(resolved)}\``
          : describeSubmoduleUrl(actual.url);
        findings.push(doctorFinding(`andromeda-submodule-${slug(expected.path)}-identity`, "product layout", `Gitlink \`${expected.path}\` has a mismatched name or repository identity (${observedRepository}); expected \`${expected.name}\` / \`${expected.repo}\`.`, { severity: "critical" }));
      }
      if (paths.get(expected.path)?.type !== "commit") {
        findings.push(doctorFinding(`andromeda-submodule-${slug(expected.path)}-mode`, "product layout", `Path \`${expected.path}\` is not a gitlink (tree type commit).`, { severity: "critical" }));
      }
    }
    for (const actual of entries) {
      if (!ANDROMEDA_LAYOUT.some((expected) => expected.path === actual.path)) {
        findings.push(doctorFinding(`andromeda-submodule-unexpected-${slug(actual.path)}`, "product layout", `Unexpected Andromeda submodule declaration \`${actual.name}\` at \`${actual.path}\`.`, { severity: "error" }));
      }
    }
    const readme = await getOptionalFileContent(github, repository, "README.md", ref);
    if (!/^# Andromeda\s*$/m.test(readme || "")) {
      findings.push(doctorFinding("andromeda-product-name", "product naming", "README does not declare `# Andromeda` as the repository name.", { severity: "error" }));
    }
  }

  if (normalized === "marius-patrik/darkfactory") {
    const readme = await getOptionalFileContent(github, repository, "README.md", ref);
    const packageJson = await getOptionalFileContent(github, repository, "package.json", ref);
    if (!/^# DarkFactory\s*$/m.test(readme || "")) {
      findings.push(doctorFinding("darkfactory-product-name", "product naming", "README does not declare `# DarkFactory` as the separate product name.", { severity: "error" }));
    }
    try {
      if (JSON.parse(packageJson || "{}").name !== "@agent-os/darkfactory") {
        findings.push(doctorFinding("darkfactory-package-name", "product naming", "Root package is not named `@agent-os/darkfactory`.", { severity: "error" }));
      }
    } catch {
      findings.push(doctorFinding("darkfactory-package-json-invalid", "product naming", "Root package.json is invalid JSON.", { severity: "critical" }));
    }
  }
  return findings;
}

export async function auditRuntimeAuthority(github, repository, ref, controlRepo = CONTROL_REPO) {
  if (!ref) return [];
  const findings = [];
  const work = await getOptionalFileContent(github, controlRepo, ".github/workflows/df-work.yml", "main");
  if (!work) {
    return [doctorFinding("canonical-worker-workflow-missing", "runtime authority", "Trusted control df-work workflow is missing.", { severity: "critical" })];
  }
  if (!/AGENTS_HOME/.test(work) || !/bin\\agents\.ps1/.test(work) || !/state doctor --json/.test(work)) {
    findings.push(doctorFinding("canonical-launcher-binding-invalid", "runtime authority", "df-work does not prove absolute AGENTS_HOME, exact `bin\\agents.ps1`, and `state doctor --json` before execution.", { severity: "critical" }));
  }
  if (/\b(kimi|agy|claude)\s+(?:-p|--|\$)/i.test(work) || /\bcodex\s+exec\b/i.test(work)) {
    findings.push(doctorFinding("direct-provider-cli-in-worker", "runtime authority", "df-work contains a direct provider CLI invocation instead of canonical `agents` execution.", { severity: "critical" }));
  }
  const agents = await getOptionalFileContent(github, repository, "AGENTS.md", ref);
  if (!/\$AGENTS_HOME|AGENTS_HOME/.test(agents || "")) {
    findings.push(doctorFinding("agents-home-authority-undocumented", "runtime authority", "AGENTS.md does not point to canonical AGENTS_HOME authority.", { severity: "error" }));
  }
  const enforcementText = await getOptionalFileContent(github, repository, ".darkfactory/enforcement-rules.json", ref);
  try {
    const rules = JSON.parse(enforcementText || "{}");
    const noBypass = Array.isArray(rules.rules) && rules.rules.some((rule) => rule?.id === "no-admin-bypass" && rule.enabled !== false && rule.severity === "block");
    if (!noBypass) {
      findings.push(doctorFinding("automation-admin-bypass-guard-missing", "runtime authority", "Managed enforcement does not fail closed on automation admin/bypass merge attempts.", { severity: "critical" }));
    }
  } catch {
    findings.push(doctorFinding("enforcement-rules-invalid", "runtime authority", "Managed enforcement rules are invalid JSON, so automation bypass posture is unproven.", { severity: "critical" }));
  }
  return findings;
}

export async function auditPrerequisites(github, repository, ref, options = {}) {
  const findings = [];
  if (!ref) return findings;
  const manifestText = await getOptionalFileContent(github, repository, ".darkfactory/managed-repository.json", ref);
  let requiredSecrets = [];
  try {
    const manifest = JSON.parse(manifestText || "{}");
    requiredSecrets = Array.isArray(manifest.requiredSecrets) ? manifest.requiredSecrets.filter((item) => typeof item === "string") : [];
  } catch {
    findings.push(doctorFinding("target-managed-config-invalid", "configuration prerequisites", "Target managed-repository.json is invalid JSON.", { severity: "critical" }));
  }

  const secretNames = await listRepositorySecretNames(github, repository);
  const proven = new Set(options.provenSecrets || []);
  if (secretNames === null && requiredSecrets.length) {
    findings.push(doctorFinding("required-secret-presence-unobservable", "configuration prerequisites", `Required secret names could not be read; unproven: ${requiredSecrets.join(", ")}.`, {
      severity: "warning", repair: ["Run doctor with metadata-only secret-read permission or prove presence through a trusted workflow without exposing values."]
    }));
  } else {
    for (const name of requiredSecrets) {
      if (!secretNames?.has(name) && !proven.has(name)) {
        findings.push(doctorFinding(`required-secret-${slug(name)}-missing`, "configuration prerequisites", `Required repository secret \`${name}\` is not present.`, { severity: "critical" }));
      }
    }
  }

  if (normalizedName(repository) === normalizedName(options.controlRepo || CONTROL_REPO)) {
    const runners = await listRepositoryRunners(github, repository);
    if (runners === null) {
      findings.push(doctorFinding("runner-health-unobservable", "runner health", "Self-hosted runner health could not be read.", { severity: "error" }));
    } else {
      const eligible = runners.filter((runner) => (runner.labels || []).some((label) => label.name === "df-local"));
      if (eligible.length === 0) {
        findings.push(doctorFinding("df-local-runner-missing", "runner health", "No self-hosted runner has the `df-local` label.", { severity: "critical" }));
      } else if (!eligible.some((runner) => runner.status === "online")) {
        findings.push(doctorFinding("df-local-runner-offline", "runner health", "All `df-local` runners are offline.", { severity: "critical" }));
      }
    }
  }
  return findings;
}

export function auditIssueLane(repository, issues, options = {}) {
  const findings = [];
  const now = new Date(options.now || Date.now()).getTime();
  const untrustedDoctorMarkers = (issues || []).filter((issue) => findDoctorMarker(issue.body || "") && !isTrustedDoctorIssue(issue));
  for (const issue of untrustedDoctorMarkers) {
    findings.push(doctorFinding(`untrusted-doctor-marker-${issue.number}`, "issue lane", `Issue #${issue.number} contains a doctor marker but was not created by a trusted DarkFactory actor; it will never be mutated as doctor-owned state.`, {
      severity: "critical",
      evidence: issue.html_url ? [{ label: `Issue #${issue.number}`, url: issue.html_url }] : []
    }));
  }
  const candidates = (issues || []).filter((issue) => !isTrustedDoctorIssue(issue));
  const open = candidates.filter((issue) => issue.state === "open");
  const byNumber = new Map(candidates.map((issue) => [issue.number, issue]));
  const byTitle = new Map();
  const byMarker = new Map();
  const stale = [];
  const blockerGraph = new Map();

  for (const issue of open) {
    const title = normalizeIssueTitle(issue.title || "");
    if (title) byTitle.set(title, [...(byTitle.get(title) || []), issue]);
    const marker = ownershipMarker(issue.body || "");
    if (marker) byMarker.set(marker, [...(byMarker.get(marker) || []), issue]);
    if (ageIn(now, issue.updated_at, 24 * 60 * 60 * 1000) >= STALE_ISSUE_DAYS && !hasActiveWorkState(issue)) stale.push(issue);
    if (/^\s*(?:[-*]\s*)?(?:status:\s*)?superseded[- ]by:\s*#\d+/im.test(issue.body || "")) {
      findings.push(doctorFinding(`superseded-issue-${issue.number}-open`, "issue lane", `Issue #${issue.number} says it is superseded but remains open.`, {
        severity: "warning", evidence: [{ label: `Issue #${issue.number}`, url: issue.html_url }]
      }));
    }
    if (findPrdMarker(issue.body || "") && /(?:^|\/)templates?\//i.test(issue.body || "")) {
      findings.push(doctorFinding(`template-prd-issue-${issue.number}`, "issue lane", `Issue #${issue.number} was generated from a template/example PRD path.`, {
        severity: "error", evidence: [{ label: `Issue #${issue.number}`, url: issue.html_url }]
      }));
    }

    const blockers = extractBlockedByIssueNumbers(issue.body || "");
    blockerGraph.set(issue.number, blockers.filter((number) => byNumber.get(number)?.state === "open"));
    for (const blocker of blockers) {
      const evidence = issue.html_url ? [{ label: `Issue #${issue.number}`, url: issue.html_url }] : [];
      if (blocker === issue.number) {
        findings.push(doctorFinding(`issue-${issue.number}-blocker-self-reference`, "issue lane", `Issue #${issue.number} blocks itself.`, {
          severity: "critical", evidence
        }));
        continue;
      }
      const dependency = byNumber.get(blocker);
      if (!dependency) {
        findings.push(doctorFinding(`issue-${issue.number}-blocker-${blocker}-missing`, "issue lane", `Issue #${issue.number} declares missing or non-issue blocker #${blocker}.`, {
          severity: "error", evidence
        }));
      } else if (dependency.state !== "open") {
        findings.push(doctorFinding(`issue-${issue.number}-blocker-${blocker}-satisfied`, "issue lane", `Issue #${issue.number} still declares closed blocker #${blocker}.`, {
          severity: "warning", evidence: [...evidence, ...(dependency.html_url ? [{ label: `Closed blocker #${blocker}`, url: dependency.html_url }] : [])]
        }));
      }
    }
  }

  for (const cycle of findIssueBlockerCycles(blockerGraph)) {
    findings.push(doctorFinding(`issue-blocker-cycle-${cycle.join("-")}`, "issue lane", `Open issues form a blocker cycle: ${cycle.map((number) => `#${number}`).join(" -> ")} -> #${cycle[0]}.`, {
      severity: "critical",
      evidence: cycle.flatMap((number) => byNumber.get(number)?.html_url ? [{ label: `Issue #${number}`, url: byNumber.get(number).html_url }] : [])
    }));
  }

  for (const [title, matches] of byTitle) {
    if (matches.length < 2) continue;
    findings.push(doctorFinding(`duplicate-issue-title-${slug(title)}`, "issue lane", `Open issues share the same normalized title: ${matches.map((issue) => `#${issue.number}`).join(", ")}.`, {
      severity: "error", evidence: matches.map((issue) => ({ label: `Issue #${issue.number}`, url: issue.html_url }))
    }));
  }
  for (const [marker, matches] of byMarker) {
    if (matches.length < 2) continue;
    findings.push(doctorFinding(`duplicate-issue-marker-${slug(marker)}`, "issue lane", `Open issues share ownership marker \`${marker}\`: ${matches.map((issue) => `#${issue.number}`).join(", ")}.`, {
      severity: "critical", evidence: matches.map((issue) => ({ label: `Issue #${issue.number}`, url: issue.html_url }))
    }));
  }
  if (stale.length) {
    findings.push(doctorFinding("stale-open-issues", "issue lane", `Open issues have no update for at least ${STALE_ISSUE_DAYS} days: ${stale.slice(0, 20).map((issue) => `#${issue.number}`).join(", ")}${stale.length > 20 ? "…" : ""}.`, {
      severity: "warning", evidence: stale.slice(0, 20).map((issue) => ({ label: `Issue #${issue.number}`, url: issue.html_url }))
    }));
  }
  return findings;
}

export function extractBlockedByIssueNumbers(body) {
  const numbers = new Set();
  for (const line of String(body || "").split(/\r?\n/)) {
    if (!/^\s*(?:[-*]\s*)?(?:blocked[- ]by|depends[- ]on)\s*:/i.test(line)) continue;
    for (const match of line.matchAll(/#(\d+)\b/g)) numbers.add(Number(match[1]));
  }
  return [...numbers].filter((number) => Number.isInteger(number) && number > 0).sort((a, b) => a - b);
}

export function findIssueBlockerCycles(graph) {
  const cycles = new Map();
  const active = new Set();
  const stack = [];
  const visited = new Set();

  function visit(node) {
    if (active.has(node)) {
      const start = stack.indexOf(node);
      const cycle = stack.slice(start);
      const canonical = canonicalCycle(cycle);
      cycles.set(canonical.join("-"), canonical);
      return;
    }
    if (visited.has(node)) return;
    active.add(node);
    stack.push(node);
    for (const next of graph.get(node) || []) visit(next);
    stack.pop();
    active.delete(node);
    visited.add(node);
  }

  for (const node of [...graph.keys()].sort((a, b) => a - b)) visit(node);
  return [...cycles.values()].sort((a, b) => a[0] - b[0]);
}

async function auditPrdDrift(github, repository, ref, issues) {
  const findings = [];
  const prd = await getOptionalFileContent(github, repository, "PRD.md", ref);
  if (!prd) {
    findings.push(doctorFinding("root-prd-missing", "PRD drift", `Root \`PRD.md\` is missing on \`${ref}\`.`, { severity: "error" }));
    return findings;
  }
  const hasIncompleteItems = parsePrdItems(prd).some((item) => !item.completed);
  const hasTracked = issues.some((issue) => findPrdMarker(issue.body || ""));
  if (hasIncompleteItems && !hasTracked) {
    findings.push(doctorFinding("prd-backlog-missing", "PRD drift", "PRD has incomplete loop/milestone items but no open PRD-tracked backlog issues.", { severity: "error" }));
  }
  return findings;
}

export async function auditHealth(repository, branch, headSha, github, options = {}) {
  const findings = [];
  if (!headSha) {
    return [doctorFinding(`workflow-${slug(branch)}-head-sha-missing`, "health", `Current \`${branch}\` head SHA is unavailable, so post-branch health is unobservable.`, { severity: "critical" })];
  }
  const now = new Date(options.now || Date.now()).getTime();
  const runs = await listWorkflowRuns(repository, branch, github);
  if (runs === null) {
    findings.push(doctorFinding(`workflow-${slug(branch)}-runs-unobservable`, "health", `Workflow runs for current \`${branch}\` are inaccessible or malformed.`, { severity: "critical" }));
  }
  const currentRuns = (runs || []).filter((run) => run?.head_sha === headSha);
  if (runs !== null && currentRuns.length === 0) {
    findings.push(doctorFinding(`workflow-${slug(branch)}-head-runs-missing`, "health", `No workflow run is bound to current \`${branch}\` head \`${headSha.slice(0, 12)}\`.`, { severity: "error" }));
  }
  const latestByWorkflow = new Map();
  for (const run of currentRuns) {
    const key = run.name || String(run.workflow_id || run.id || "unknown");
    if (!latestByWorkflow.has(key)) latestByWorkflow.set(key, run);
  }
  const latestRuns = [...latestByWorkflow.values()];
  for (const run of latestRuns.filter((item) => item.status === "completed" && !HEALTHY_CONCLUSIONS.has(item.conclusion || ""))) {
    findings.push(doctorFinding(`workflow-${slug(branch)}-${slug(run.name || run.workflow_id)}-red`, "health", `Workflow \`${run.name || run.workflow_id}\` concluded \`${run.conclusion}\` on \`${branch}\`.`, {
      severity: "error", evidence: run.html_url ? [{ label: run.name || "workflow run", url: run.html_url }] : []
    }));
  }
  for (const run of latestRuns.filter((item) => item.status !== "completed")) {
    const ageHours = ageIn(now, run.run_started_at || run.started_at || run.created_at, 60 * 60 * 1000);
    const stuck = ageHours >= PENDING_CHECK_HOURS;
    findings.push(doctorFinding(`workflow-${slug(branch)}-${slug(run.name || run.workflow_id)}-${stuck ? "stuck" : "pending"}`, "health", `Workflow \`${run.name || run.workflow_id}\` is \`${run.status || "unknown"}\` on current \`${branch}\`${stuck ? ` for ${ageHours} hours` : ""}.`, {
      severity: stuck ? "error" : "warning", evidence: run.html_url ? [{ label: run.name || "workflow run", url: run.html_url }] : []
    }));
  }

  const checks = await getCommitChecks(github, repository, headSha);
  const red = checks.filter((check) => check.state === "red");
  const unknown = checks.filter((check) => check.state === "unknown");
  const pending = checks.filter((check) => check.state === "pending");
  if (checks.length === 0) {
    findings.push(doctorFinding(`workflow-${slug(branch)}-head-checks-missing`, "health", `Current \`${branch}\` head has no observable checks.`, { severity: "error" }));
  }
  const protection = await getBranchProtection(github, repository, branch);
  if (protection.configured) {
    const expected = requiredStatusChecks(protection.data).checks;
    const missing = expected.filter((required) => !checks.some((check) => (
      check.name === required.context &&
      (!Number.isInteger(required.appId) || required.appId <= 0 || check.appId === required.appId)
    )));
    if (missing.length) {
      findings.push(doctorFinding(`workflow-${slug(branch)}-head-required-checks-missing`, "health", `Current \`${branch}\` head is missing required app-bound checks: ${missing.map((check) => `${check.context}@app:${check.appId ?? "unbound"}`).join(", ")}.`, {
        severity: "critical"
      }));
    }
  }
  if (red.length) {
    findings.push(doctorFinding(`workflow-${slug(branch)}-head-checks-red`, "health", `Current \`${branch}\` head has failing checks: ${red.map(checkLabel).join(", ")}.`, { severity: "error" }));
  }
  if (unknown.length) {
    findings.push(doctorFinding(`workflow-${slug(branch)}-head-checks-unobservable`, "health", `Current \`${branch}\` head has malformed or inaccessible check evidence: ${unknown.map(checkLabel).join(", ")}.`, { severity: "critical" }));
  }
  if (pending.length) {
    const stuck = pending.filter((check) => ageIn(now, check.startedAt, 60 * 60 * 1000) >= PENDING_CHECK_HOURS);
    findings.push(doctorFinding(`workflow-${slug(branch)}-head-checks-${stuck.length ? "stuck" : "pending"}`, "health", `Current \`${branch}\` head has ${stuck.length ? "stuck" : "pending"} checks: ${pending.map(checkLabel).join(", ")}.`, {
      severity: stuck.length ? "error" : "warning"
    }));
  }
  return findings;
}

export async function auditDocStaleness(repository, metadata, branch, github) {
  const findings = [];
  const pushedAt = Date.parse(metadata.pushed_at || "");
  if (!Number.isFinite(pushedAt) || !branch) return findings;
  for (const filePath of DOC_PATHS) {
    const commit = await getLatestCommitForPath(repository, filePath, branch, github);
    if (!commit) continue;
    const committedAt = Date.parse(commit.commit?.committer?.date || commit.commit?.author?.date || "");
    if (!Number.isFinite(committedAt)) continue;
    const ageDays = Math.floor((pushedAt - committedAt) / (24 * 60 * 60 * 1000));
    if (ageDays > DOC_STALE_DAYS) {
      findings.push(doctorFinding(`doc-${slug(filePath)}-stale`, "doc staleness", `\`${filePath}\` is ${ageDays} days older than recent repository activity.`, { severity: "warning" }));
    }
  }
  return findings;
}

export async function auditRetiredAuthorityNames(github, repository, ref) {
  if (!ref) return [];
  const authorityPaths = [
    "README.md",
    "PRD.md",
    "AGENTS.md",
    ".agents/.project/AGENTS.md",
    ".darkfactory/branching-policy.md",
    ".darkfactory/installer-policy.json",
    ".darkfactory/managed-repository.json",
    ".github/workflows/sync-managed-repos.yml",
    ".agents/.project/PROJECT.md",
    ".agents/.project/STATUS.md",
    "src/managed-files.ts"
  ];
  const documents = [];
  for (const filePath of authorityPaths) {
    const content = await getOptionalFileContent(github, repository, filePath, ref);
    if (content) documents.push({ filePath, content });
  }

  const retired = [
    {
      id: "retired-agents-data-repository-name",
      pattern: /marius-patrik\/(?:agents-data|agent-os-data)\b/i,
      message: "Active authority still names the retired Agent OS data repository; canonical repository is `marius-patrik/Andromeda-data`."
    },
    {
      id: "retired-agent-os-data-path",
      pattern: /(?:\$AGENTS_ROOT|AGENTS_ROOT|\.agents)\s*[\\/]data[\\/]agent-os\b/i,
      message: "Active authority still names the retired nested Agent OS data path; canonical state is the `$AGENTS_HOME` checkout of Andromeda-data."
    },
    {
      id: "retired-agents-manager-owner-name",
      pattern: /marius-patrik\/agents-manager\b/i,
      message: "Active authority still names the retired `agents-manager` repository; repository ownership must name Andromeda or DarkFactory explicitly."
    }
  ];
  const findings = [];
  for (const rule of retired) {
    const paths = documents.filter((document) => rule.pattern.test(document.content)).map((document) => document.filePath);
    if (!paths.length) continue;
    findings.push(doctorFinding(rule.id, "authority naming", `${rule.message} Found in ${formatList(paths)}.`, {
      severity: "error",
      repair: ["Update active authority through a reviewed migration; preserve genuinely historical evidence only in explicitly marked historical sections."]
    }));
  }
  return findings;
}

export async function auditSubmoduleState(github, repository, branch) {
  const findings = [];
  const gitmodules = await getOptionalFileContent(github, repository, ".gitmodules", branch);
  if (!gitmodules) return findings;
  const submodules = parseGitmodules(gitmodules);
  const seenPaths = new Set();

  for (const submodule of submodules) {
    if (!submodule.name || !submodule.path || !submodule.url) {
      findings.push(doctorFinding(`submodule-declaration-${slug(submodule.name || submodule.path || "unknown")}-invalid`, "submodule metadata", `Submodule declaration \`${submodule.name || "unknown"}\` is missing name, path, or URL.`, { severity: "critical" }));
      continue;
    }
    if (seenPaths.has(submodule.path)) {
      findings.push(doctorFinding(`submodule-path-${slug(submodule.path)}-duplicate`, "submodule metadata", `Submodule path \`${submodule.path}\` is declared more than once.`, { severity: "critical" }));
      continue;
    }
    seenPaths.add(submodule.path);
    const childRepo = resolveSubmoduleRepo(repository, submodule.url);
    if (!childRepo) {
      findings.push(doctorFinding(`submodule-${slug(submodule.path)}-url-invalid`, "submodule metadata", `Submodule \`${submodule.path}\` uses an unsupported ${describeSubmoduleUrl(submodule.url)}.`, { severity: "critical" }));
      continue;
    }
    const recorded = await getSubmoduleCommit(github, repository, submodule.path, branch);
    if (!recorded) {
      findings.push(doctorFinding(`submodule-${slug(submodule.path)}-gitlink-missing-${slug(branch)}`, "submodule pointer", `Submodule \`${submodule.path}\` is declared but has no gitlink on \`${branch}\`.`, { severity: "critical" }));
      continue;
    }
    const child = await getSubmoduleHead(github, childRepo);
    if (!child) {
      findings.push(doctorFinding(`submodule-${slug(submodule.path)}-head-unavailable`, "submodule pointer", `Child head for \`${submodule.path}\` (${repoName(childRepo)}) is inaccessible.`, { severity: "error" }));
      continue;
    }
    if (submodule.branch && submodule.branch !== child.branch) {
      findings.push(doctorFinding(`submodule-${slug(submodule.path)}-branch-drift`, "submodule metadata", `Submodule \`${submodule.path}\` tracks \`${submodule.branch}\`, but child default branch is \`${child.branch}\`.`, { severity: "error" }));
    }
    if (recorded !== child.sha) {
      findings.push(doctorFinding(`submodule-${slug(submodule.path)}-pointer-drift-${slug(branch)}`, "submodule pointer", `Submodule \`${submodule.path}\` records \`${recorded.slice(0, 12)}\` on \`${branch}\`, while ${repoName(childRepo)} \`${child.branch}\` is \`${child.sha.slice(0, 12)}\`.`, {
        severity: "warning",
        evidence: [{ label: "compare", url: `https://github.com/${repoName(childRepo)}/compare/${recorded}...${child.sha}` }],
        repair: ["Update only after proving the child head is the eligible released/default commit and parent validation is green."]
      }));
    }
  }
  return findings;
}

export function parseGitmodules(content) {
  const submodules = [];
  if (typeof content !== "string") return submodules;
  let current = null;
  for (const rawLine of content.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const section = line.match(/^\[submodule\s+"([^"]+)"\]\s*$/);
    if (section) {
      if (current) submodules.push(current);
      current = { name: section[1], path: "", url: "", branch: "" };
      continue;
    }
    if (!current) continue;
    const pair = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!pair) continue;
    const key = pair[1].toLowerCase();
    if (["path", "url", "branch"].includes(key)) current[key] = pair[2].trim();
  }
  if (current) submodules.push(current);
  return submodules;
}

export function resolveSubmoduleRepo(parentRepo, url) {
  if (typeof url !== "string" || !url.trim()) return null;
  const value = url.trim();
  const github = value.match(/^(?:https?:\/\/github\.com\/|git@github\.com:|github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/.*)?$/);
  if (github) return { owner: github[1], repo: github[2] };
  if (value.startsWith("./") || value.startsWith("../")) {
    try {
      const resolved = new URL(value, `https://github.com/${repoName(parentRepo)}/`).pathname.split("/").filter(Boolean);
      if (resolved.length >= 2) return {
        owner: resolved[resolved.length - 2],
        repo: resolved[resolved.length - 1].replace(/\.git$/, "")
      };
    } catch {
      return null;
    }
  }
  return null;
}

function describeSubmoduleUrl(url) {
  if (typeof url !== "string" || !url.trim()) return "missing URL";
  const value = url.trim();
  if (/^(?:[A-Za-z]:[\\/]|\\\\)/.test(value)) return "machine-local path";
  if (/^file:/i.test(value)) return "machine-local file URL";
  if (value.startsWith("./") || value.startsWith("../")) return "relative repository URL";
  if (/^(?:https?:\/\/github\.com\/|git@github\.com:|github\.com:)/i.test(value)) return "malformed GitHub repository URL";
  const scheme = value.match(/^([A-Za-z][A-Za-z0-9+.-]*):/i)?.[1]?.toLowerCase();
  if (scheme === "http" || scheme === "https") return "non-GitHub web URL";
  if (scheme === "ssh" || scheme === "git") return "non-GitHub remote URL";
  if (scheme) return "URL with an unsupported scheme";
  return "unrecognized repository URL";
}

export function auditLocalCheckout(localPath, repository) {
  const findings = [];
  const observations = [];
  const resolved = path.resolve(localPath);
  if (!existsSync(resolved)) {
    return { findings: [doctorFinding("local-checkout-missing", "local checkout", "The explicitly supplied local checkout does not exist.", { severity: "critical" })], observations };
  }
  const origin = git(resolved, ["remote", "get-url", "origin"]);
  const remote = resolveSubmoduleRepo(repository, origin.stdout.trim());
  if (!origin.ok || !remote || normalizedName(remote) !== normalizedName(repository)) {
    return { findings: [doctorFinding("local-checkout-origin-mismatch", "local checkout", `Local checkout origin does not match ${repoName(repository)}.`, { severity: "critical" })], observations };
  }
  const status = git(resolved, ["status", "--porcelain=v2", "--untracked-files=all"]);
  if (!status.ok) {
    findings.push(doctorFinding("local-status-failed", "local checkout", "Local git status failed, so checkout state is unobservable.", { severity: "critical" }));
  } else if (status.stdout.trim()) {
    findings.push(doctorFinding("local-checkout-dirty", "local checkout", "Explicit local checkout has modified or untracked state.", {
      severity: "error", repair: ["Preserve user changes; reconcile intentionally before any automated repair."]
    }));
  }
  const submodules = git(resolved, ["submodule", "status", "--recursive"]);
  if (submodules.ok) {
    for (const line of submodules.stdout.split(/\r?\n/).filter(Boolean)) {
      const match = line.match(/^(.)([0-9a-f]{40})\s+(.+?)(?:\s+\(.+\))?$/i);
      if (!match) continue;
      const [_, prefix, _sha, subPath] = match;
      if (prefix === "-") findings.push(doctorFinding(`local-submodule-${slug(subPath)}-uninitialized`, "local checkout", `Submodule \`${subPath}\` is uninitialized.`, { severity: "error" }));
      if (prefix === "+") findings.push(doctorFinding(`local-submodule-${slug(subPath)}-pointer`, "local checkout", `Submodule \`${subPath}\` is checked out at a different commit than the parent gitlink.`, { severity: "error" }));
      if (prefix === "U") findings.push(doctorFinding(`local-submodule-${slug(subPath)}-conflict`, "local checkout", `Submodule \`${subPath}\` has a merge conflict.`, { severity: "critical" }));
      const nestedPath = path.resolve(resolved, subPath);
      if (existsSync(nestedPath) && prefix !== "-") {
        const nested = git(nestedPath, ["status", "--porcelain", "--untracked-files=all"]);
        if (nested.ok && nested.stdout.trim()) findings.push(doctorFinding(`local-submodule-${slug(subPath)}-dirty`, "local checkout", `Submodule \`${subPath}\` has local modified/untracked state.`, { severity: "error" }));
      }
    }
  }
  observations.push("The explicitly supplied local checkout origin and recursive submodule state were inspected read-only.");
  return { findings, observations };
}

export function auditWorkerSessionIsolation(agentsHome, options = {}) {
  const findings = [];
  const observations = [];
  const sessionsRoot = path.join(path.resolve(agentsHome), "sessions");
  if (!existsSync(sessionsRoot)) {
    return {
      findings: [doctorFinding("worker-session-state-missing", "worker isolation", "Canonical Agent OS session state is unavailable.", { severity: "error" })],
      observations
    };
  }

  const now = new Date(options.now || Date.now()).getTime();
  const cutoff = now - WORKER_SESSION_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const workerPrompt = "Read .darkfactory/df-task-brief.md and implement that task in the current repository.";
  let inspectedCount = 0;
  let mismatchCount = 0;

  for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sessionDir = path.join(sessionsRoot, entry.name);
    const state = readJsonFile(path.join(sessionDir, "state.json"));
    const transcript = readJsonFile(path.join(sessionDir, "transcript.json"));
    if (!state || !transcript) continue;
    const lastTurn = Date.parse(state.lastTurnAt || transcript.updatedAt || transcript.createdAt || "");
    if (Number.isFinite(lastTurn) && lastTurn < cutoff) continue;
    const firstUserMessage = (transcript.messages || []).find((message) => message?.role === "user")?.content || "";
    if (!String(firstUserMessage).startsWith(workerPrompt)) continue;
    inspectedCount += 1;
    if (!isIsolatedWorkerWorkdir(state.workdir)) {
      mismatchCount += 1;
    }
  }

  if (mismatchCount > 0) {
    findings.push(doctorFinding("worker-session-workdir-isolation", "worker isolation", `${mismatchCount} canonical worker session(s) used a workdir outside the required ephemeral task-clone boundary.`, {
      severity: "critical",
      repair: ["Fix canonical Agent OS session creation/resume so each df-work turn records and uses the exact ephemeral worker clone as its workdir; do not reuse an unrelated repository session."]
    }));
  }
  observations.push(`Inspected ${inspectedCount} canonical df-work session(s) from the last ${WORKER_SESSION_LOOKBACK_DAYS} days for task-clone cwd isolation.`);
  return { findings, observations };
}

export function isIsolatedWorkerWorkdir(workdir) {
  if (typeof workdir !== "string" || !workdir.trim()) return false;
  const resolved = path.resolve(workdir);
  return path.basename(resolved).toLowerCase() === "repo" && /^df-work-/i.test(path.basename(path.dirname(resolved)));
}

export function dedupeFindings(findings) {
  const byId = new Map();
  for (const item of findings.filter(Boolean)) {
    if (!byId.has(item.id)) {
      byId.set(item.id, { ...item, evidence: [...(item.evidence || [])], repair: [...(item.repair || [])] });
      continue;
    }
    const existing = byId.get(item.id);
    existing.evidence = dedupeEvidence([...existing.evidence, ...(item.evidence || [])]);
    existing.repair = [...new Set([...existing.repair, ...(item.repair || [])])];
  }
  return [...byId.values()].map((item) => ({ ...item, evidence: dedupeEvidence(item.evidence) })).sort((a, b) => a.id.localeCompare(b.id));
}

export function doctorFinding(id, category, message, options = {}) {
  return {
    id: slug(id),
    severity: options.severity || "warning",
    category,
    message,
    evidence: options.evidence || [],
    repair: options.repair || []
  };
}

export function doctorIssueBody(targetRepo, finding) {
  const evidence = finding.evidence.length
    ? finding.evidence.map((item) => `- [${escapeMarkdown(item.label || "evidence")}](${item.url})`).join("\n")
    : "- Deterministic repository-doctor observation; see the latest workflow/ledger report.";
  const repair = finding.repair.length
    ? finding.repair.map((item) => `- ${item}`).join("\n")
    : "- Reconcile the observed state with the stated repository policy through a reviewed, separately authorized change.";
  return [
    `<!-- df-doctor:${slug(targetRepo)}:${finding.id} -->`,
    "## Repository Doctor Finding",
    "",
    `Target: \`${targetRepo}\``,
    `Finding ID: \`${finding.id}\``,
    `Severity: \`${finding.severity}\``,
    `Priority: \`${priorityForFinding(finding)}\``,
    `Category: \`${finding.category}\``,
    "",
    "## Observed State",
    "",
    finding.message,
    "",
    "## Evidence",
    "",
    evidence,
    "",
    "## Repair Guidance",
    "",
    repair,
    "",
    "## Acceptance Criteria",
    "",
    "- Repair is implemented through a normal feature branch and reviewed PR; doctor itself performs no repair.",
    "- Re-run repository doctor in diagnose mode and confirm this stable finding ID is absent.",
    "- Re-run in explicitly authorized report mode and confirm this issue closes without creating a duplicate.",
    "",
    "## Source",
    "",
    "- Repository doctor foundation: [marius-patrik/DarkFactory#12](https://github.com/marius-patrik/DarkFactory/issues/12)",
    "- Autonomous development epic: [marius-patrik/DarkFactory#35](https://github.com/marius-patrik/DarkFactory/issues/35)",
    "- AI tokens: 0 (deterministic diagnosis)."
  ].join("\n");
}

export function findDoctorMarker(body) {
  return body?.match(/<!--\s*(df-doctor:[a-z0-9-]+:[a-z0-9-]+)\s*-->/i)?.[1]?.toLowerCase() || "";
}

export function isTrustedDoctorIssue(issue) {
  return !!findDoctorMarker(issue?.body || "") && isTrustedDoctorActor(issue);
}

function isTrustedDoctorActor(issue) {
  return DOCTOR_ISSUE_AUTHORS.has(issue?.user?.login || issue?.author?.login || "");
}

export async function reconcileDoctorIssues(github, repository, findings, enumeratedIssues, recordedActions = []) {
  const actions = recordedActions;
  if (!Array.isArray(actions)) throw new Error("Repository-doctor action recorder must be an array.");
  const issues = enumeratedIssues || await listDoctorIssues(github, repository, "all");
  const prefix = `df-doctor:${slug(repoName(repository))}:`;
  const expected = new Set(findings.map((finding) => `${prefix}${finding.id}`));
  const byMarker = new Map();

  for (const issue of issues) {
    const marker = findDoctorMarker(issue.body || "");
    if (!marker.startsWith(prefix) || !isTrustedDoctorIssue(issue)) continue;
    byMarker.set(marker, [...(byMarker.get(marker) || []), issue]);
  }

  for (const finding of findings) {
    const marker = `${prefix}${finding.id}`;
    const matches = (byMarker.get(marker) || []).sort((a, b) => a.number - b.number);
    const existing = matches[0];
    const body = doctorIssueBody(repoName(repository), finding);
    const title = `[repo doctor] ${finding.category}: ${finding.id}`;
    const labels = [priorityForFinding(finding), "df:doctor", "df:class:mechanical"];
    if (existing) {
      await github.request("PATCH", `/repos/${repoName(repository)}/issues/${existing.number}`, { title, body, state: "open", labels });
      actions.push({ action: "update-repair-issue", finding: finding.id, issue: issueRef(existing) });
    } else {
      const created = await github.request("POST", `/repos/${repoName(repository)}/issues`, { title, body, labels });
      actions.push({ action: "create-repair-issue", finding: finding.id, issue: issueRef(created) });
    }
    for (const duplicate of matches.slice(1)) {
      if (duplicate.state === "open") {
        await github.request("POST", `/repos/${repoName(repository)}/issues/${duplicate.number}/comments`, { body: `Closing duplicate doctor marker; canonical issue is #${existing.number}.` });
        actions.push({ action: "comment-duplicate-repair-issue", issue: issueRef(duplicate) });
        await github.request("PATCH", `/repos/${repoName(repository)}/issues/${duplicate.number}`, { state: "closed" });
        actions.push({ action: "close-duplicate-repair-issue", issue: issueRef(duplicate) });
      }
    }
  }

  for (const [marker, matches] of byMarker) {
    if (expected.has(marker)) continue;
    for (const issue of matches.filter((item) => item.state === "open")) {
      await github.request("POST", `/repos/${repoName(repository)}/issues/${issue.number}/comments`, { body: "Repository doctor no longer detects this stable finding ID." });
      actions.push({ action: "comment-resolved-repair-issue", issue: issueRef(issue) });
      await github.request("PATCH", `/repos/${repoName(repository)}/issues/${issue.number}`, { state: "closed" });
      actions.push({ action: "close-resolved-repair-issue", issue: issueRef(issue) });
    }
  }

  return actions;
}

export async function retireLegacyAuditIssues(github, repository, enumeratedIssues, recordedActions = []) {
  const actions = recordedActions;
  if (!Array.isArray(actions)) throw new Error("Repository-doctor action recorder must be an array.");
  const issues = enumeratedIssues || await listDoctorIssues(github, repository, "all");
  const legacy = issues.filter((issue) => issue.state === "open" && isTrustedDoctorActor(issue) && findAuditMarker(issue.body || "") === `df-audit:${slug(repoName(repository))}`);
  for (const issue of legacy) {
    await github.request("POST", `/repos/${repoName(repository)}/issues/${issue.number}/comments`, { body: "Superseded by the per-finding repository doctor ([marius-patrik/DarkFactory#12](https://github.com/marius-patrik/DarkFactory/issues/12)); all replacement findings use stable `df-doctor:` markers." });
    actions.push({ action: "comment-legacy-audit-issue", issue: issueRef(issue) });
    await github.request("PATCH", `/repos/${repoName(repository)}/issues/${issue.number}`, { state: "closed" });
    actions.push({ action: "close-legacy-audit-issue", issue: issueRef(issue) });
  }
  return actions;
}

async function writeDoctorLedger(ledgerGithub, repository, report, options) {
  const phase = options?.phase;
  if (!["admission", "completion"].includes(phase)) throw new Error("Repository-doctor ledger phase must be admission or completion.");
  const kind = phase === "admission" ? "repo-doctor-admission" : "repo-doctor";
  const written = await writeRunLedger(ledgerGithub, DARK_FACTORY_DATA_REPO, kind, repoName(repository), {
    phase,
    mode: report.mode,
    trigger: report.trigger,
    source_refs: report.source_refs,
    findings: report.findings,
    observations: report.observations,
    publication_status: phase === "admission" ? "admitted" : (options.publicationStatus || "complete"),
    actions: phase === "admission"
      ? options.plannedActions.map((action) => ({ ...action, state: "admitted" }))
      : report.actions,
    planned_actions: options.plannedActions,
    token_usage: report.token_usage
  });
  return { action: phase === "admission" ? "write-doctor-admission-ledger" : "write-doctor-ledger", repository: written.repository, path: written.path };
}

export function formatDoctorReports(reports) {
  const lines = [];
  for (const report of reports) {
    lines.push(`${report.target_repository}: ${report.skipped ? "SKIPPED" : report.findings.length ? "FINDINGS" : "HEALTHY"} (${report.mode}, read_only=${report.read_only})`);
    if (report.reason) lines.push(`  ${report.reason}`);
    for (const finding of report.findings || []) lines.push(`  [${finding.severity}] ${finding.id}: ${finding.message}`);
    for (const observation of report.observations || []) lines.push(`  note: ${observation}`);
  }
  return lines.join("\n");
}

function skippedReport(repository, mode, reason) {
  return {
    schema_version: DOCTOR_SCHEMA_VERSION,
    mode,
    target_repository: repoName(repository),
    read_only: true,
    skipped: true,
    reason,
    source_refs: {},
    findings: [],
    observations: [reason],
    actions: [],
    token_usage: { model_calls: 0, input_tokens: 0, output_tokens: 0 }
  };
}

export async function listBranches(github, repository) {
  return await listCompletePages(github, repository, "branches", 10, (page) => `/repos/${repoName(repository)}/branches?per_page=100&page=${page}`);
}

export async function listOpenPullRequests(github, repository) {
  return await listCompletePages(github, repository, "open pull requests", 10, (page) => `/repos/${repoName(repository)}/pulls?state=open&per_page=100&page=${page}`);
}

export async function listDoctorIssues(github, repository, state = "all") {
  if (!["all", "open", "closed"].includes(state)) {
    throw new Error(`Repository-doctor issue state is invalid: ${state}.`);
  }
  const items = await listCompletePages(github, repository, `${state} issues`, 20, (page) => `/repos/${repoName(repository)}/issues?state=${state}&per_page=100&page=${page}`);
  return items.filter((issue) => !issue?.pull_request);
}

async function listCompletePages(github, repository, evidenceKind, maxPages, requestPath) {
  const items = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const batch = await github.request("GET", requestPath(page));
    if (!Array.isArray(batch)) {
      throw new Error(`Repository doctor received a malformed ${evidenceKind} page for ${repoName(repository)}.`);
    }
    items.push(...batch);
    if (batch.length < 100) return items;
  }
  throw new Error(`Repository doctor cannot prove complete ${evidenceKind} enumeration for ${repoName(repository)} within ${maxPages} pages.`);
}

async function listRepositoryLabelNames(github, repository) {
  const labels = new Set();
  for (let page = 1; page <= 10; page += 1) {
    const batch = await github.request("GET", `/repos/${repoName(repository)}/labels?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) {
      throw new Error(`Repository-doctor report label preflight returned a malformed payload for ${repoName(repository)}.`);
    }
    for (const label of batch) {
      if (typeof label?.name === "string" && label.name.trim()) labels.add(label.name);
    }
    if (batch.length < 100) break;
  }
  return labels;
}

async function compareBranches(github, repository, base, head) {
  return await github.request("GET", `/repos/${repoName(repository)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
}

function isValidBranchComparison(comparison) {
  return ["identical", "ahead", "behind", "diverged"].includes(comparison?.status) &&
    Number.isInteger(comparison?.ahead_by) && comparison.ahead_by >= 0 &&
    Number.isInteger(comparison?.behind_by) && comparison.behind_by >= 0;
}

async function getPullRequest(github, repository, number) {
  return await github.request("GET", `/repos/${repoName(repository)}/pulls/${number}`);
}

async function getCommitChecks(github, repository, sha) {
  if (!sha) return [];
  const results = await Promise.allSettled([
    listCompleteCommitEvidencePages(github, repository, sha, "check runs", "check_runs", "check-runs"),
    listCompleteCommitEvidencePages(github, repository, sha, "commit statuses", "statuses", "status")
  ]);
  const latest = new Map();
  for (const [index, result] of results.entries()) {
    if (result.status !== "rejected") continue;
    if (![403, 404].includes(result.reason?.status)) throw result.reason;
    const name = index === 0 ? "check-runs API" : "commit status API";
    latest.set(`unobservable:${index}`, {
      name,
      state: "unknown",
      conclusion: `HTTP ${result.reason.status}`,
      appId: null,
      url: "",
      startedAt: ""
    });
  }
  const checkRuns = results[0].status === "fulfilled" ? results[0].value : [];
  const statuses = results[1].status === "fulfilled" ? results[1].value : [];
  for (const [index, run] of checkRuns.entries()) {
    const validName = typeof run?.name === "string" && !!run.name.trim();
    const name = validName ? run.name.trim() : "malformed check run";
    const completed = run?.status === "completed";
    const knownPending = ["queued", "in_progress", "pending", "requested", "waiting"].includes(run?.status);
    const state = !validName
      ? "unknown"
      : (completed
          ? (HEALTHY_CONCLUSIONS.has(run?.conclusion) ? "green" : (RED_CONCLUSIONS.has(run?.conclusion) ? "red" : "unknown"))
          : (knownPending ? "pending" : "unknown"));
    const key = `check:${validName ? name : `malformed-${index}`}`;
    if (!latest.has(key)) latest.set(key, {
      name,
      state,
      conclusion: run?.conclusion || run?.status || "malformed",
      appId: Number.isInteger(run?.app?.id) ? run.app.id : null,
      url: run?.html_url || run?.details_url || "",
      startedAt: run?.started_at || run?.created_at || ""
    });
  }
  for (const [index, item] of statuses.entries()) {
    const validContext = typeof item?.context === "string" && !!item.context.trim();
    const context = validContext ? item.context.trim() : "malformed status";
    const state = !validContext
      ? "unknown"
      : (item?.state === "success"
          ? "green"
          : (item?.state === "pending" ? "pending" : (["error", "failure"].includes(item?.state) ? "red" : "unknown")));
    const key = `status:${validContext ? context : `malformed-${index}`}`;
    if (!latest.has(key)) latest.set(key, {
      name: context,
      state,
      conclusion: item?.state || "malformed",
      appId: null,
      url: item?.target_url || "",
      startedAt: item?.created_at || item?.updated_at || ""
    });
  }
  return [...latest.values()];
}

async function listCompleteCommitEvidencePages(github, repository, sha, evidenceKind, collectionKey, endpoint) {
  const items = [];
  let expectedTotal = null;
  const encodedSha = encodeURIComponent(sha);

  for (let page = 1; page <= MAX_COMMIT_EVIDENCE_PAGES; page += 1) {
    const response = await github.request("GET", `/repos/${repoName(repository)}/commits/${encodedSha}/${endpoint}?per_page=${COMMIT_EVIDENCE_PAGE_SIZE}&page=${page}`);
    const total = response?.total_count;
    const batch = response?.[collectionKey];
    if (!Number.isInteger(total) || total < 0 || !Array.isArray(batch) || batch.length > COMMIT_EVIDENCE_PAGE_SIZE) {
      throw new Error(`Repository doctor received a malformed ${evidenceKind} page for ${repoName(repository)} at ${sha}.`);
    }
    if (expectedTotal === null) expectedTotal = total;
    else if (total !== expectedTotal) {
      throw new Error(`Repository doctor observed changing ${evidenceKind} totals for ${repoName(repository)} at ${sha}.`);
    }
    if (expectedTotal > COMMIT_EVIDENCE_PAGE_SIZE * MAX_COMMIT_EVIDENCE_PAGES) {
      throw new Error(`Repository doctor cannot prove complete ${evidenceKind} enumeration for ${repoName(repository)} at ${sha} within ${MAX_COMMIT_EVIDENCE_PAGES} pages.`);
    }

    items.push(...batch);
    if (items.length > expectedTotal) {
      throw new Error(`Repository doctor received excess ${evidenceKind} evidence for ${repoName(repository)} at ${sha}.`);
    }
    if (items.length === expectedTotal) return items;
    if (batch.length < COMMIT_EVIDENCE_PAGE_SIZE) {
      throw new Error(`Repository doctor received incomplete ${evidenceKind} evidence for ${repoName(repository)} at ${sha}.`);
    }
  }

  throw new Error(`Repository doctor cannot prove complete ${evidenceKind} enumeration for ${repoName(repository)} at ${sha} within ${MAX_COMMIT_EVIDENCE_PAGES} pages.`);
}

async function getRecursiveTree(github, repository, ref) {
  try {
    return await github.request("GET", `/repos/${repoName(repository)}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
  } catch (error) {
    if (![404, 409, 422].includes(error.status)) throw error;
    const commit = await github.request("GET", `/repos/${repoName(repository)}/git/commits/${encodeURIComponent(ref)}`);
    const sha = commit?.tree?.sha;
    if (!sha) throw error;
    return await github.request("GET", `/repos/${repoName(repository)}/git/trees/${encodeURIComponent(sha)}?recursive=1`);
  }
}

async function listRemoteDirectoryFiles(github, repository, dir, ref) {
  const files = [];
  const visited = new Set();

  async function walk(currentDir, allowMissing) {
    if (visited.has(currentDir)) {
      throw new Error(`Repository doctor observed a repeated managed project overlay directory in ${repoName(repository)}.`);
    }
    visited.add(currentDir);
    let entries;
    try {
      entries = await github.request("GET", `/repos/${repoName(repository)}/contents/${encodePath(currentDir)}?ref=${encodeURIComponent(ref)}`);
    } catch (error) {
      if (allowMissing && error.status === 404) return;
      if (error.status === 404) {
        throw new Error(`Repository doctor could not complete managed project overlay enumeration for ${repoName(repository)}.`);
      }
      throw error;
    }
    if (!Array.isArray(entries)) {
      throw new Error(`Repository doctor received a malformed managed project overlay directory listing for ${repoName(repository)}.`);
    }
    const childPaths = new Set();
    for (const entry of entries) {
      const entryPath = entry && typeof entry === "object" && !Array.isArray(entry) ? entry.path : null;
      const type = entry && typeof entry === "object" && !Array.isArray(entry) ? entry.type : null;
      const prefix = `${currentDir}/`;
      const relative = typeof entryPath === "string" && entryPath.startsWith(prefix) ? entryPath.slice(prefix.length) : "";
      if (!relative || relative.includes("/") || !["file", "dir"].includes(type) || childPaths.has(entryPath)) {
        throw new Error(`Repository doctor received a malformed managed project overlay entry for ${repoName(repository)}.`);
      }
      childPaths.add(entryPath);
      if (type === "file") files.push(entry);
      else await walk(entryPath, false);
    }
  }

  await walk(dir, true);
  return files;
}

async function listWorkflowRuns(repository, branch, github) {
  try {
    const data = await github.request("GET", `/repos/${repoName(repository)}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=20`);
    return Array.isArray(data?.workflow_runs) ? data.workflow_runs : null;
  } catch (error) {
    if (error.status === 403 || error.status === 404) return null;
    throw error;
  }
}

async function getLatestCommitForPath(repository, filePath, branch, github) {
  try {
    const data = await github.request("GET", `/repos/${repoName(repository)}/commits?sha=${encodeURIComponent(branch)}&path=${encodeURIComponent(filePath)}&per_page=1`);
    return Array.isArray(data) ? data[0] : null;
  } catch (error) {
    if (error.status === 404 || error.status === 409) return null;
    throw error;
  }
}

async function getSubmoduleCommit(github, repository, submodulePath, branch) {
  try {
    const data = await github.request("GET", `/repos/${repoName(repository)}/contents/${encodePath(submodulePath)}?ref=${encodeURIComponent(branch)}`);
    const legacySubmodule = data?.type === "submodule";
    const currentSubmodule = data?.type === "file" && typeof data?.submodule_git_url === "string" && Boolean(data.submodule_git_url.trim());
    return (legacySubmodule || currentSubmodule) && /^[0-9a-f]{40}$/i.test(data?.sha || "") ? data.sha : null;
  } catch (error) {
    if (error.status === 403 || error.status === 404) return null;
    throw error;
  }
}

async function getSubmoduleHead(github, repository) {
  try {
    const metadata = await getRepository(github, repository);
    const branch = metadata.default_branch || "main";
    const data = await github.request("GET", `/repos/${repoName(repository)}/commits/${encodeURIComponent(branch)}`);
    return typeof data?.sha === "string" ? { sha: data.sha, branch } : null;
  } catch (error) {
    if (error.status === 403 || error.status === 404) return null;
    throw error;
  }
}

async function listRepositorySecretNames(github, repository) {
  try {
    const data = await github.request("GET", `/repos/${repoName(repository)}/actions/secrets?per_page=100`);
    return new Set((data.secrets || []).map((secret) => secret.name).filter(Boolean));
  } catch (error) {
    if (error.status === 403 || error.status === 404) return null;
    throw error;
  }
}

async function listRepositoryRunners(github, repository) {
  try {
    const data = await github.request("GET", `/repos/${repoName(repository)}/actions/runners?per_page=100`);
    return Array.isArray(data.runners) ? data.runners : [];
  } catch (error) {
    if (error.status === 403 || error.status === 404) return null;
    throw error;
  }
}

export function isMainOnlyDataRepository(repository) {
  return MAIN_ONLY_DATA_REPOSITORIES.has(normalizedName(repository));
}

function sameRepositoryPullHead(pull, repository) {
  const fullName = pull.head?.repo?.full_name || pull.headRepository?.nameWithOwner || "";
  return fullName.toLowerCase() === normalizedName(repository);
}

function branchSha(branches, name) {
  return branches.find((branch) => branch.name === name)?.commit?.sha || null;
}

function compareEvidence(repository, base, head) {
  return { label: `${base}...${head}`, url: `https://github.com/${repoName(repository)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}` };
}

function checkLabel(check) {
  return `${check.name}:${check.conclusion}`;
}

function normalizeIssueTitle(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function ownershipMarker(body) {
  return body.match(/<!--\s*((?:darkfactory|df)(?:-|:)[a-z0-9:-]+)\s*-->/i)?.[1]?.toLowerCase() || "";
}

function canonicalCycle(cycle) {
  if (!cycle.length) return [];
  const rotations = cycle.map((_, index) => [...cycle.slice(index), ...cycle.slice(0, index)]);
  rotations.sort((a, b) => a.join("-").localeCompare(b.join("-"), undefined, { numeric: true }));
  return rotations[0];
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function hasActiveWorkState(issue) {
  const labels = new Set((issue.labels || []).map((label) => typeof label === "string" ? label : label.name));
  return labels.has("df:running") || labels.has("df:ready") || labels.has("df:ask-owner");
}

function priorityForFinding(finding) {
  if (finding.severity === "critical") return "P0";
  if (finding.severity === "error") return "P1";
  return "P2";
}

function issueRef(issue) {
  return { number: issue.number, url: issue.html_url };
}

function uniqueRepositories(repositories) {
  const byName = new Map();
  for (const repository of repositories) byName.set(normalizedName(repository), repository);
  return [...byName.values()].sort((a, b) => normalizedName(a).localeCompare(normalizedName(b)));
}

function normalizedName(repository) {
  return repoName(repository).toLowerCase();
}

function normalizeText(value) {
  return String(value ?? "").replace(/\r\n/g, "\n");
}

function encodePath(filePath) {
  return filePath.split("/").map(encodeURIComponent).join("/");
}

function ageIn(now, timestamp, unit) {
  const then = Date.parse(timestamp || "");
  return Number.isFinite(then) ? Math.max(0, Math.floor((now - then) / unit)) : 0;
}

function formatList(values) {
  return values.length ? values.map((value) => `\`${value}\``).join(", ") : "none";
}

function dedupeEvidence(evidence) {
  const byKey = new Map();
  for (const item of evidence || []) byKey.set(`${item.label || ""}|${item.url || ""}`, item);
  return [...byKey.values()].sort((a, b) => `${a.label}|${a.url}`.localeCompare(`${b.label}|${b.url}`));
}

function escapeMarkdown(value) {
  return String(value).replace(/[\[\]]/g, "\\$&");
}

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
  return { ok: result.status === 0, stdout: result.stdout || "", stderr: result.stderr || "" };
}
