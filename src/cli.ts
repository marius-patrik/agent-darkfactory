#!/usr/bin/env node
import "dotenv/config";

import { App } from "@octokit/app";
import { Octokit } from "@octokit/core";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createBot } from "./bot.js";
import { loadAppCredentials, loadConfig } from "./config.js";
import { ensureManagedRepositorySetup, orderManagedRepositoriesForSync } from "./managed-sync.js";
import { readManagedFiles } from "./managed-files.js";
import { applyCleanPlan, collectCleanEvidence, type OperatorGitHubRequester } from "./clean-evidence.js";
import {
  buildCleanPlan,
  persistCleanPlan,
  planSetupConvergence,
  readCleanPlan,
  type DoctorReport
} from "./operator.js";
import { convergeRepositorySettings, SetupOwnerActionRequired, type LabelDefinition, type SetupReceipt } from "./setup.js";
import {
  CONTROL_OWNER,
  CONTROL_REPO,
  buildStatusReport,
  formatStatusReport,
  type GitHubRequester
} from "./status.js";
import { createWebhookServer } from "./server.js";

export async function runCli(args = process.argv.slice(2)): Promise<void> {
  const [command = "help"] = args;

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "serve") {
    serve();
    return;
  }

  if (command === "install-url") {
    await printInstallationUrl();
    return;
  }

  if (command === "sync-managed") {
    await syncManagedRepositories();
    return;
  }

  if (command === "status") {
    await runStatus(args.slice(1));
    return;
  }

  if (command === "doctor") {
    await runDoctor(args.slice(1));
    return;
  }

  if (command === "setup") {
    await runSetup(args.slice(1));
    return;
  }

  if (command === "clean") {
    await runClean(args.slice(1));
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

function serve(): void {
  const config = loadConfig();
  const app = createBot({
    appId: config.appId,
    privateKey: config.privateKey,
    webhookSecret: config.webhookSecret,
    controlRepo: config.controlRepo
  });
  const server = createWebhookServer(app.webhooks);

  server.listen(config.port, () => {
    console.log(`DarkFactory listening on http://localhost:${config.port}/webhook`);
  });
}

async function printInstallationUrl(): Promise<void> {
  const credentials = loadAppCredentials();
  const app = new App({
    appId: credentials.appId,
    privateKey: credentials.privateKey
  });

  console.log(await app.getInstallationUrl());
}

async function syncManagedRepositories(): Promise<void> {
  const credentials = loadAppCredentials();
  const app = new App({
    appId: credentials.appId,
    privateKey: credentials.privateKey
  });
  const repositories: Array<{
    octokit: Parameters<typeof ensureManagedRepositorySetup>[0];
    repository: {
      owner: { login: string };
      name: string;
      default_branch?: string;
      archived?: boolean;
    };
  }> = [];
  let count = 0;

  for await (const { octokit, repository } of app.eachRepository.iterator()) {
    repositories.push({ octokit, repository });
  }

  for (const { octokit, repository } of orderManagedRepositoriesForSync(repositories, ({ repository }) => ({
    owner: repository.owner.login,
    repo: repository.name
  }))) {
    const result = await ensureManagedRepositorySetup(octokit, {
      owner: repository.owner.login,
      repo: repository.name,
      defaultBranch: repository.default_branch,
      archived: repository.archived
    });

    count += 1;
    console.log(
      `${result.owner}/${result.repo}: ${result.status}${
        result.pullRequestUrl ? ` ${result.pullRequestUrl}` : ""
      }`
    );
  }

  console.log(`Processed ${count} installed repositories.`);
}

async function runStatus(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const credentials = loadAppCredentials();
  const app = new App({
    appId: credentials.appId,
    privateKey: credentials.privateKey
  });
  const octokit = await getInstallationOctokit(app, CONTROL_OWNER);
  const requester = createOctokitRequester(octokit);
  const report = await buildStatusReport(requester);

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatStatusReport(report));
  }
}

export type DoctorCliOptions = {
  all: boolean;
  target: string;
  json: boolean;
  writeIssues: boolean;
  localPath: string;
  agentsHome: string;
};

export function parseDoctorCliArgs(args: string[]): DoctorCliOptions {
  const options: DoctorCliOptions = {
    all: false,
    target: `${CONTROL_OWNER}/${CONTROL_REPO}`,
    json: false,
    writeIssues: false,
    localPath: "",
    agentsHome: process.env.AGENTS_HOME?.trim() || ""
  };
  let explicitTarget = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--all") {
      options.all = true;
      continue;
    }
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    if (argument === "--write-issues") {
      options.writeIssues = true;
      continue;
    }
    if (argument === "--repair") {
      throw new Error("doctor repair is intentionally unavailable; diagnose first and use a separately reviewed repair lane");
    }
    if (argument === "--local" || argument === "--agents-home") {
      const value = args[index + 1]?.trim();
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a path`);
      if (argument === "--local") options.localPath = value;
      else options.agentsHome = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) throw new Error(`unknown doctor option: ${argument}`);
    if (explicitTarget) throw new Error("doctor accepts at most one owner/repo target");
    if (!/^[^/\s]+\/[^/\s]+$/.test(argument)) throw new Error(`invalid doctor repository: ${argument}`);
    options.target = argument;
    explicitTarget = true;
  }

  if (options.all && explicitTarget) throw new Error("doctor --all cannot be combined with an owner/repo target");
  if (options.all && options.localPath) throw new Error("doctor --all cannot inspect one ambiguous --local checkout");
  return options;
}

async function runDoctor(args: string[]): Promise<void> {
  const options = parseDoctorCliArgs(args);
  const credentials = loadAppCredentials();
  const app = new App({ appId: credentials.appId, privateKey: credentials.privateKey });
  const { doctor, reports } = await collectDoctorReports(app, options);

  if (options.json) console.log(JSON.stringify(reports, null, 2));
  else console.log(doctor.formatDoctorReports(reports));
}

async function collectDoctorReports(app: App, options: DoctorCliOptions): Promise<{
  doctor: { formatDoctorReports: (reports: DoctorReport[]) => string };
  reports: DoctorReport[];
}> {
  const owner = options.all ? CONTROL_OWNER : options.target.split("/", 1)[0];
  const octokit = await getScopedInstallationOctokit(app, owner, {
    administration: "read",
    actions: "read",
    checks: "read",
    contents: "read",
    issues: options.writeIssues ? "write" : "read",
    pull_requests: "read",
    secrets: "read",
    statuses: "read"
  });
  const github = createDoctorRequester(octokit);
  const ledgerGithub = options.writeIssues
    ? createDoctorRequester(await getScopedInstallationOctokit(app, CONTROL_OWNER, { contents: "write" }, ["darkfactory-data"]))
    : undefined;
  const moduleUrl = new URL("../.github/scripts/df-audit.mjs", import.meta.url);
  const doctor = await import(moduleUrl.href) as {
    runRepositoryDoctor: (github: unknown, options: Record<string, unknown>) => Promise<DoctorReport[]>;
    formatDoctorReports: (reports: DoctorReport[]) => string;
  };
  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  const reports = await doctor.runRepositoryDoctor(github, {
    root: packageRoot,
    controlRepo: { owner: CONTROL_OWNER, repo: CONTROL_REPO },
    target: options.target,
    all: options.all,
    mode: options.writeIssues ? "report" : "diagnose",
    ledgerGithub,
    trigger: "cli",
    localPath: options.localPath,
    agentsHome: options.agentsHome
  });
  return { doctor, reports };
}

export type SetupCliOptions = Omit<DoctorCliOptions, "writeIssues"> & { watch: boolean };

export function parseSetupCliArgs(args: string[]): SetupCliOptions {
  for (const argument of args) {
    if (["--force", "--bypass", "--prune"].includes(argument)) throw new Error(`${argument} is intentionally unavailable for setup`);
  }
  const doctor = parseDoctorCliArgs(args.filter((argument) => argument !== "--watch"));
  if (doctor.writeIssues) throw new Error("setup does not accept --write-issues; setup receipts are written to canonical DarkFactory data");
  return { ...doctor, watch: args.includes("--watch") };
}

async function runSetup(args: string[]): Promise<void> {
  const options = parseSetupCliArgs(args);
  const credentials = loadAppCredentials();
  const app = new App({ appId: credentials.appId, privateKey: credentials.privateKey });
  const dataGithub = await operatorLedgerGithub(app);
  const ledger = await operatorLedgerModule();
  const receipts: SetupReceipt[] = [];
  const dispatchedIssueLanePlans = new Set<string>();
  const dispatchedReadinessPlans = new Set<string>();
  const maxPasses = options.watch ? boundedInteger(process.env.DF_SETUP_WATCH_PASSES, 40, 1, 240) : 1;
  let finalPlan = planSetupConvergence([]);
  let previousEvidenceHash = "";
  let stableEvidencePasses = 0;
  let completedPasses = 0;
  let stopReason = options.watch ? "max-passes" : "single-pass";

  for (let pass = 1; pass <= maxPasses; pass += 1) {
    const { reports } = await collectDoctorReports(app, { ...options, writeIssues: false });
    const plan = planSetupConvergence(reports);
    finalPlan = plan;
    completedPasses = pass;
    stableEvidencePasses = previousEvidenceHash === plan.evidenceHash ? stableEvidencePasses + 1 : 0;
    previousEvidenceHash = plan.evidenceHash;
    await ledger.writeRunLedger(dataGithub, "marius-patrik/darkfactory-data", "setup-admission", options.all ? "fleet" : options.target, {
      plan_id: plan.planId,
      evidence_hash: plan.evidenceHash,
      pass,
      planned_actions: plan.actions,
      residue: plan.residue
    });
    const passReceipts = await executeSetupPlan(app, reports, plan, dispatchedIssueLanePlans, dispatchedReadinessPlans);
    receipts.push(...passReceipts);
    await ledger.writeRunLedger(dataGithub, "marius-patrik/darkfactory-data", "setup-completion", options.all ? "fleet" : options.target, {
      plan_id: plan.planId,
      evidence_hash: plan.evidenceHash,
      pass,
      receipts: passReceipts,
      residue: plan.residue,
      watch_requested: options.watch
    });
    if (!options.watch) break;
    if (plan.actions.length === 0) {
      stopReason = plan.residue.length === 0 ? "converged" : "owner-or-blocked-residue";
      break;
    }
    if (plan.actions.every((action) => !action.supported)) {
      stopReason = "unsupported-residue";
      break;
    }
    // An unchanged evidence-bound plan means setup has no proof of progress.
    // Two consecutive unchanged re-observations allow asynchronous workflow
    // dispatches time to land while bounding repeated writes and polling.
    if (stableEvidencePasses >= 2) {
      stopReason = "stable-evidence";
      break;
    }
    if (pass < maxPasses) await delay(15_000);
  }

  const converged = finalPlan.actions.length === 0 && finalPlan.residue.length === 0;
  const result = {
    schemaVersion: 1,
    plan: finalPlan,
    receipts,
    converged,
    passes: completedPasses,
    stopReason: converged ? "converged" : stopReason
  };
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else printSetupResult(result);
}

async function executeSetupPlan(
  app: App,
  reports: DoctorReport[],
  plan: ReturnType<typeof planSetupConvergence>,
  dispatchedIssueLanePlans: Set<string>,
  dispatchedReadinessPlans: Set<string>
): Promise<SetupReceipt[]> {
  const receipts: SetupReceipt[] = [];
  for (const report of reports) {
    if (report.lifecycle !== "active") {
      receipts.push({ action: "lifecycle", target: report.target_repository, status: "owner-required", detail: `Repository lifecycle is ${report.lifecycle}; setup refuses it.` });
      continue;
    }
    const [owner, repo] = splitRepository(report.target_repository);
    const octokit = await getInstallationOctokit(app, owner);
    const github = createOperatorRequester(octokit);
    const repositoryActions = plan.actions.filter((action) => action.repository === report.target_repository && action.supported);
    const activeStage = repositoryActions[0]?.stage;
    // Execute one proven dependency stage per observation. Later stages must
    // see a fresh doctor snapshot after this stage's synchronous postcondition
    // or asynchronous reviewed workflow has actually landed.
    const operations = new Set(repositoryActions
      .filter((action) => action.stage === activeStage)
      .map((action) => action.operation));

    const sourcePolicyContradiction = report.findings.some((finding) => finding.category.toLowerCase() === "source policy" || finding.id.includes("source-policy-contradiction"));
    if (operations.has("open-managed-setup-pr") && sourcePolicyContradiction) {
      receipts.push({
        action: "managed-setup-pr",
        target: report.target_repository,
        status: "owner-required",
        detail: "Canonical source policy contradicts repository-owned controls; managed setup is blocked before tree creation or target deletion."
      });
    } else if (operations.has("open-managed-setup-pr")) {
      const metadata = await octokit.request("GET /repos/{owner}/{repo}", { owner, repo });
      const value: Record<string, unknown> = isRecord(metadata.data) ? metadata.data : {};
      const result = await ensureManagedRepositorySetup(createOctokitRequester(octokit), {
        owner,
        repo,
        defaultBranch: typeof value.default_branch === "string" ? value.default_branch : undefined,
        archived: value.archived === true
      });
      receipts.push({
        action: "managed-setup-pr",
        target: report.target_repository,
        status: result.status === "current" ? "current" : result.status === "skipped" ? "owner-required" : "applied",
        detail: result.pullRequestUrl || result.reason || `${result.changedPaths.length} managed paths reconciled`
      });
    }

    if (operations.has("converge-settings")) {
      try {
        const files = readManagedFiles({ owner, repo });
        const labels = parseLabelDefinitions(files.find((file) => file.path === ".darkfactory/labels.json")?.content || "");
        const workflows = files.map((file) => file.path).filter((path) => path.startsWith(".github/workflows/") && path.endsWith(".yml"));
        receipts.push(...await convergeRepositorySettings(github, { owner, repo }, labels, workflows));
      } catch (error) {
        if (!(error instanceof SetupOwnerActionRequired)) throw error;
        receipts.push({ action: error.action, target: report.target_repository, status: "owner-required", detail: error.message });
      }
    }

    if (operations.has("reconcile-issue-lane")) {
      const dispatchKey = `${plan.planId}:${report.target_repository}`;
      if (!dispatchedIssueLanePlans.has(dispatchKey)) {
        const control = await getInstallationOctokit(app, CONTROL_OWNER);
        await control.request("POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches", {
          owner: CONTROL_OWNER,
          repo: CONTROL_REPO,
          workflow_id: "df-plan.yml",
          ref: "main",
          inputs: { repo: report.target_repository, ref: report.source_refs.default_branch || "main" }
        });
        dispatchedIssueLanePlans.add(dispatchKey);
        receipts.push({ action: "issue-lane", target: report.target_repository, status: "applied", detail: "Dispatched trusted PRD reconciliation; workflow-run chaining will re-evaluate readiness." });
      } else {
        receipts.push({ action: "issue-lane", target: report.target_repository, status: "current", detail: "This exact evidence plan already dispatched PRD reconciliation; waiting for its trusted run." });
      }
    }

    if (operations.has("evaluate-readiness")) {
      const dispatchKey = `${plan.planId}:${report.target_repository}`;
      if (!dispatchedReadinessPlans.has(dispatchKey)) {
        const control = await getInstallationOctokit(app, CONTROL_OWNER);
        await control.request("POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches", {
          owner: CONTROL_OWNER,
          repo: CONTROL_REPO,
          workflow_id: "df-orchestrate.yml",
          ref: "main",
          inputs: { repo: report.target_repository, source_event: "df-setup" }
        });
        dispatchedReadinessPlans.add(dispatchKey);
        receipts.push({ action: "readiness", target: report.target_repository, status: "applied", detail: "Dispatched trusted machine evaluation; dispatch will recompute the predicate rather than trust a label." });
      } else {
        receipts.push({ action: "readiness", target: report.target_repository, status: "current", detail: "This exact evidence plan already requested readiness evaluation; waiting for the trusted run." });
      }
    }

    for (const operation of operations) {
      if (["open-managed-setup-pr", "converge-settings", "reconcile-issue-lane", "evaluate-readiness"].includes(operation)) continue;
      receipts.push({ action: operation, target: report.target_repository, status: "owner-required", detail: "The owning prerequisite has not yet exposed a trusted setup executor; setup refused to improvise." });
    }
  }

  return receipts;
}

export type CleanCliOptions = {
  mode: "plan" | "apply" | "verify";
  target: string;
  planId: string;
  localPath: string;
  agentsHome: string;
  json: boolean;
  watch: boolean;
};

export function parseCleanCliArgs(args: string[]): CleanCliOptions {
  const options: CleanCliOptions = {
    mode: "plan",
    target: `${CONTROL_OWNER}/${CONTROL_REPO}`,
    planId: "",
    localPath: "",
    agentsHome: process.env.AGENTS_HOME?.trim() || "",
    json: false,
    watch: false
  };
  let index = 0;
  if (["plan", "apply", "verify"].includes(args[0])) {
    options.mode = args[0] as CleanCliOptions["mode"];
    index += 1;
  }
  if (options.mode === "apply") {
    options.planId = args[index]?.trim() || "";
    if (!options.planId) throw new Error("clean apply requires a durable plan ID");
    index += 1;
  }
  let targetSeen = false;
  for (; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") { options.json = true; continue; }
    if (argument === "--watch") { options.watch = true; continue; }
    if (["--force", "--bypass", "--prune"].includes(argument)) throw new Error(`${argument} is intentionally unavailable for clean`);
    if (argument === "--local" || argument === "--agents-home") {
      const value = args[index + 1]?.trim();
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a path`);
      if (argument === "--local") options.localPath = value;
      else options.agentsHome = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) throw new Error(`unknown clean option: ${argument}`);
    if (options.mode === "apply" || targetSeen || !/^[^/\s]+\/[^/\s]+$/.test(argument)) throw new Error(`invalid or ambiguous clean repository: ${argument}`);
    options.target = argument;
    targetSeen = true;
  }
  if (!options.agentsHome) throw new Error("clean requires canonical AGENTS_HOME for durable plan storage");
  return options;
}

async function runClean(args: string[]): Promise<void> {
  const options = parseCleanCliArgs(args);
  const credentials = loadAppCredentials();
  const app = new App({ appId: credentials.appId, privateKey: credentials.privateKey });
  let target = options.target;
  let saved = options.planId ? await readCleanPlan(options.agentsHome, options.planId) : null;
  if (saved) target = saved.repository;
  const [owner, repo] = splitRepository(target);
  const octokit = await getInstallationOctokit(app, owner);
  const github = createOperatorRequester(octokit);
  const reviewFindings = await collectCleanReviewFindings(app, options, target);
  const evidence = await collectCleanEvidence(github, { owner, repo }, options.localPath, reviewFindings);
  const plan = buildCleanPlan(evidence);
  const dataGithub = await operatorLedgerGithub(app);
  const ledger = await operatorLedgerModule();

  if (options.mode === "plan") {
    const path = await persistCleanPlan(options.agentsHome, plan);
    await ledger.writeRunLedger(dataGithub, "marius-patrik/darkfactory-data", "clean-plan", target, {
      plan_id: plan.planId,
      evidence_hash: plan.evidenceHash,
      entries: plan.entries,
      local_plan_path_id: stableLocalPathId(path)
    });
    const result = { schemaVersion: 1, mode: "plan", plan, durable: true };
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else printCleanPlan(plan);
    return;
  }

  if (options.mode === "verify") {
    const actionable = plan.entries.filter((entry) => entry.action !== "preserve");
    const reviewResidue = plan.entries.filter((entry) => entry.kind === "lane-finding");
    const result = { schemaVersion: 1, mode: "verify", repository: target, clean: actionable.length === 0 && reviewResidue.length === 0, actionable, reviewResidue };
    await ledger.writeRunLedger(dataGithub, "marius-patrik/darkfactory-data", "clean-verify", target, result);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else console.log(result.clean ? `${target}: clean (proven no-op)` : `${target}: ${actionable.length} admitted hygiene actions and ${reviewResidue.length} deterministic review findings remain; run df clean plan.`);
    return;
  }

  if (!saved) throw new Error("clean apply plan disappeared before admission");
  await ledger.writeRunLedger(dataGithub, "marius-patrik/darkfactory-data", "clean-apply-admission", target, {
    plan_id: saved.planId,
    evidence_hash: saved.evidenceHash,
    intended_actions: saved.entries.filter((entry) => entry.action !== "preserve")
  });
  const receipt = await applyCleanPlan(github, { owner, repo }, saved, evidence, {
    localPath: options.localPath,
    onAdmission: async (action) => {
      await ledger.writeRunLedger(dataGithub, "marius-patrik/darkfactory-data", "clean-action-admission", target, {
        plan_id: saved!.planId,
        evidence_hash: saved!.evidenceHash,
        action
      });
    },
    onCompletion: async (action) => {
      await ledger.writeRunLedger(dataGithub, "marius-patrik/darkfactory-data", "clean-action-receipt", target, {
        plan_id: saved!.planId,
        evidence_hash: saved!.evidenceHash,
        action
      });
    }
  });
  await ledger.writeRunLedger(dataGithub, "marius-patrik/darkfactory-data", "clean-apply-completion", target, {
    plan_id: saved.planId,
    evidence_hash: saved.evidenceHash,
    actions: receipt.actions,
    watch_requested: options.watch
  });
  let watchVerification: { clean: boolean; actionable: number; reviewResidue: number; passes: number; stalled: boolean } | null = null;
  if (options.watch) {
    const maxPasses = boundedInteger(process.env.DF_CLEAN_WATCH_PASSES, 40, 1, 240);
    let previousEvidenceHash = "";
    for (let pass = 1; pass <= maxPasses; pass += 1) {
      const freshReview = await collectCleanReviewFindings(app, options, target);
      const freshEvidence = await collectCleanEvidence(github, { owner, repo }, options.localPath, freshReview);
      const freshPlan = buildCleanPlan(freshEvidence);
      const actionable = freshPlan.entries.filter((entry) => entry.action !== "preserve");
      const reviewResidue = freshPlan.entries.filter((entry) => entry.kind === "lane-finding");
      const stalled: boolean = previousEvidenceHash.length > 0 && previousEvidenceHash === freshPlan.evidenceHash;
      watchVerification = { clean: actionable.length === 0 && reviewResidue.length === 0, actionable: actionable.length, reviewResidue: reviewResidue.length, passes: pass, stalled };
      await ledger.writeRunLedger(dataGithub, "marius-patrik/darkfactory-data", "clean-watch-verify", target, {
        plan_id: saved.planId,
        evidence_hash: freshPlan.evidenceHash,
        pass,
        actionable,
        review_residue: reviewResidue
      });
      if (watchVerification.clean || watchVerification.stalled) break;
      previousEvidenceHash = freshPlan.evidenceHash;
      if (pass < maxPasses) await delay(15_000);
    }
  }
  if (options.json) console.log(JSON.stringify({ ...receipt, watchVerification }, null, 2));
  else {
    console.log(`${target}: applied ${receipt.actions.filter((action) => action.status === "applied").length} admitted actions; ${receipt.actions.filter((action) => action.status === "skipped").length} entries preserved.`);
    if (watchVerification) console.log(`${target}: watch verification clean=${watchVerification.clean}, stalled=${watchVerification.stalled} after ${watchVerification.passes} pass(es); actions=${watchVerification.actionable}, review findings=${watchVerification.reviewResidue}.`);
  }
}

const CLEAN_REVIEW_CATEGORIES = new Set([
  "branch hygiene",
  "pull request health",
  "release lane",
  "issue lane",
  "PRD drift",
  "repository hygiene",
  "state boundary",
  "nested repository state",
  "local checkout"
]);

async function collectCleanReviewFindings(app: App, options: CleanCliOptions, target: string) {
  const { reports } = await collectDoctorReports(app, {
    all: false,
    target,
    json: false,
    writeIssues: false,
    localPath: options.localPath,
    agentsHome: options.agentsHome
  });
  if (reports.length !== 1 || reports[0].skipped || reports[0].lifecycle !== "active") {
    throw new Error(`clean refuses ${target} because its active lifecycle and complete doctor review are unproven`);
  }
  return reports[0].findings.filter((finding) => CLEAN_REVIEW_CATEGORIES.has(finding.category));
}

function splitRepository(value: string): [string, string] {
  const match = value.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) throw new Error(`invalid repository: ${value}`);
  return [match[1], match[2]];
}

function parseLabelDefinitions(source: string): LabelDefinition[] {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`canonical label taxonomy is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.labels)) {
    throw new Error("canonical label taxonomy must use schemaVersion 1 with a labels array");
  }
  return value.labels.map((item) => {
    if (!isRecord(item) || typeof item.name !== "string" || typeof item.color !== "string" || typeof item.description !== "string") {
      throw new Error("canonical label taxonomy contains a malformed label");
    }
    return { name: item.name, color: item.color, description: item.description };
  });
}

async function operatorLedgerModule(): Promise<{
  writeRunLedger: (github: unknown, dataRepo: string, kind: string, target: string, ledger: Record<string, unknown>) => Promise<unknown>;
}> {
  const moduleUrl = new URL("../.github/scripts/df-lib.mjs", import.meta.url);
  return await import(moduleUrl.href) as {
    writeRunLedger: (github: unknown, dataRepo: string, kind: string, target: string, ledger: Record<string, unknown>) => Promise<unknown>;
  };
}

async function operatorLedgerGithub(app: App): Promise<ReturnType<typeof createDoctorRequester>> {
  return createDoctorRequester(await getScopedInstallationOctokit(app, CONTROL_OWNER, { contents: "write" }, ["darkfactory-data"]));
}

function createOperatorRequester(octokit: Octokit): OperatorGitHubRequester {
  return {
    async request(route, parameters) {
      const response = await octokit.request(route, parameters);
      return { data: response.data };
    },
    async graphql(query, variables) {
      return await octokit.graphql(query, variables);
    }
  };
}

function stableLocalPathId(path: string): string {
  return `local-${createHash("sha256").update(path.toLowerCase()).digest("hex").slice(0, 16)}`;
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`bounded integer must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function printSetupResult(result: {
  plan: ReturnType<typeof planSetupConvergence>;
  receipts: SetupReceipt[];
  converged: boolean;
  passes: number;
  stopReason: string;
}): void {
  console.log(`Setup plan ${result.plan.planId}: ${result.plan.actions.length} ordered actions, ${result.plan.residue.length} owner/blocked findings.`);
  for (const receipt of result.receipts) console.log(`- ${receipt.status}: ${receipt.action} ${receipt.target} — ${receipt.detail}`);
  console.log(`Observation stopped after ${result.passes} pass(es): ${result.stopReason}.`);
  console.log(result.converged ? "Setup is a proven no-op." : "Setup is resumable; rerun after reviewed PRs and owner residue resolve.");
}

function printCleanPlan(plan: ReturnType<typeof buildCleanPlan>): void {
  const actions = plan.entries.filter((entry) => entry.action !== "preserve");
  const reviewFindings = plan.entries.filter((entry) => entry.kind === "lane-finding");
  console.log(`Clean plan ${plan.planId} for ${plan.repository}: ${actions.length} admitted actions, ${plan.entries.length - actions.length} preserved entries, ${reviewFindings.length} deterministic review findings.`);
  for (const entry of plan.entries) console.log(`- ${entry.action}: ${entry.kind} ${entry.target} @ ${entry.head.slice(0, 12)} (${entry.classification})`);
  console.log(`Apply only with: df clean apply ${plan.planId}`);
}

async function getInstallationOctokit(app: App, owner: string): Promise<Octokit> {
  return app.getInstallationOctokit(await getInstallationId(app, owner));
}

async function getScopedInstallationOctokit(
  app: App,
  owner: string,
  permissions: Record<string, "read" | "write">,
  repositoryNames?: string[]
): Promise<Octokit> {
  const installationId = await getInstallationId(app, owner);
  const authentication = await app.octokit.auth({
    type: "installation",
    installationId,
    permissions,
    ...(repositoryNames ? { repositoryNames } : {})
  }) as unknown;
  if (!isRecord(authentication) || typeof authentication.token !== "string" || !authentication.token) {
    throw new Error("GitHub returned an invalid scoped installation authentication response");
  }
  return new Octokit({ auth: authentication.token });
}

async function getInstallationId(app: App, owner: string): Promise<number> {
  const { data } = await app.octokit.request("GET /app/installations");

  if (!Array.isArray(data)) {
    throw new Error("GitHub returned an invalid app installations response");
  }

  const installation = data.find(
    (item) =>
      isRecord(item) &&
      isRecord(item.account) &&
      typeof item.account.login === "string" &&
      item.account.login.toLowerCase() === owner.toLowerCase()
  );

  if (!installation || !isRecord(installation) || typeof installation.id !== "number") {
    throw new Error(`GitHub App is not installed for owner ${owner}`);
  }

  return installation.id;
}

function createOctokitRequester(octokit: Octokit): GitHubRequester {
  return {
    async request(route, parameters) {
      const response = await octokit.request(route, parameters);
      return { data: response.data };
    }
  };
}

function createDoctorRequester(octokit: Octokit): {
  request(method: string, path: string, body?: unknown): Promise<unknown>;
  graphql(query: string, variables?: Record<string, unknown>): Promise<unknown>;
} {
  return {
    async request(method, path, body) {
      const response = await octokit.request(`${method} ${path}`, body as Record<string, unknown> | undefined);
      return response.data;
    },
    async graphql(query, variables) {
      return await octokit.graphql(query, variables);
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function printHelp(): void {
  console.log(`darkfactory - DarkFactory GitHub agent

Usage:
  darkfactory serve
  darkfactory install-url
  darkfactory sync-managed
  darkfactory status [--json]
  darkfactory doctor [owner/repo | --all] [--json] [--local PATH] [--agents-home PATH]
  darkfactory doctor [owner/repo | --all] --write-issues [--json]
  df setup [owner/repo | --all] [--watch] [--json] [--local PATH] [--agents-home PATH]
  df clean [plan] [owner/repo] [--local PATH] [--json]
  df clean apply <plan-id> [--local PATH] [--watch] [--json]
  df clean verify [owner/repo] [--local PATH] [--json]

Command information:
  serve         Run the GitHub App webhook server.
  install-url   Print the GitHub App installation URL.
  sync-managed  Reconcile managed setup PRs for installed repositories.
  status        Read DarkFactory orchestration and backlog status.
  doctor        Diagnose deterministic repository, workflow, branch, issue, and local-state drift.
  setup         Run doctor, execute ordered auto/PR convergence, and stop only at exact owner/blocked residue.
  clean         Plan, apply, or verify evidence-backed hygiene without force or prune bypasses.

Doctor safety:
  Diagnose mode is the default and performs no writes or repairs.
  --write-issues explicitly enables stable per-finding issue reconciliation and the doctor ledger.
  Repair is intentionally a separate reviewed work lane; --repair is rejected.
Setup and clean safety:
  setup is resumable; reviewed PR repairs continue on later --watch or scheduled invocations.
  clean defaults to a read-only durable plan. Apply re-fetches every fact and aborts on drift.
  Dirty, unpublished, protected, open-PR, and ambiguous work is always preserved.
Secrets are read from environment variables first, then AGENTS_SECRETS/*.secret.`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runCli().catch((error) => {
    console.error(`darkfactory: ${error.message}`);
    process.exitCode = 1;
  });
}
