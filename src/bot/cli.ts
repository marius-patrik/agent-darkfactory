#!/usr/bin/env node
import "dotenv/config";

import { App } from "@octokit/app";
import { Octokit } from "@octokit/core";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createBot } from "./bot.js";
import { loadAppCredentials, loadConfig } from "./config.js";
import {
  continueIssueDraft,
  createIssueDraft,
  defaultDraftPath,
  draftExists,
  formatDraftDiff,
  issueDraftFreshness,
  issueDraftConversationVersion,
  issueDraftSummary,
  isRetryableIssueDraftReview,
  parseIssueTarget,
  parseOwnerIssueAnswers,
  parseOwnerIssueIntent,
  publishReviewedIssueDraft,
  readIssueDraftState,
  resumeExpiredIssueDraft,
  reviewIssueDraft,
  validateEffort,
  validateRepository,
  type IssueDevelopmentRuntime,
  type OwnerIssueAnswers,
  type OwnerIssueIntent
} from "./issue-development.js";
import { isTrustedDarkFactoryComment, issueContentDigest, issueVersion, validateIssueVersion } from "./issue-spec.js";
import {
  formatCommandHelp,
  formatRootHelp,
  humanCommandId,
  humanJsonResult,
  parseHumanCliArgs,
  type ParsedHumanCommand
} from "./human-cli.js";
import { ensureManagedRepositorySetup, orderManagedRepositoriesForSync } from "./managed-sync.js";
import { readManagedFiles } from "./managed-files.js";
import { applyCleanPlan, collectCleanEvidence, deleteRemoteBranchWithLease, type OperatorGitHubRequester } from "./clean-evidence.js";
import { convergeMachineRuntime } from "./machine-setup.js";
import { convergeManagedRegistration } from "./registration.js";
import {
  buildCleanPlan,
  persistCleanPlan,
  planSetupConvergence,
  readCleanPlan,
  type DoctorReport
} from "./operator.js";
import { armManagedSetupBootstrap, convergeRepositoryFoundation, convergeRepositorySettings, SetupOwnerActionRequired, type LabelDefinition, type SetupReceipt } from "./setup.js";
import {
  CONTROL_OWNER,
  CONTROL_REPO,
  buildStatusReport,
  formatStatusReport,
  type GitHubRequester
} from "./status.js";
import { createWebhookServer } from "./server.js";

const TRUSTED_ACTIONS_APP_ID = 15368;

export async function runCli(args = process.argv.slice(2)): Promise<void> {
  const [command = "help"] = args;

  if (command === "help" || command === "--help" || command === "-h") {
    if (command === "help" && args.length > 1) {
      const parsed = parseHumanCliArgs([...args.slice(1), "--help"]);
      if (!parsed) throw new Error(`unknown help target: ${args.slice(1).join(" ")}`);
      console.log(formatCommandHelp(parsed.spec));
    } else {
      console.log(formatRootHelp());
    }
    return;
  }

  const human = parseHumanCliArgs(args);
  if (human?.help) {
    console.log(formatCommandHelp(human.spec));
    return;
  }
  if (human && await runHumanCommand(human)) return;

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

  if (command === "release") {
    await runRelease(args.slice(1));
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

async function runStatus(args: string[], commandId = "status"): Promise<void> {
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
    console.log(JSON.stringify(humanJsonResult(commandId, "ok", report), null, 2));
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
    agentsHome: process.env.ANDROMEDA_HOME?.trim() || ""
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

async function runDoctor(args: string[], commandId = "doctor"): Promise<void> {
  const options = parseDoctorCliArgs(args);
  const credentials = loadAppCredentials();
  const app = new App({ appId: credentials.appId, privateKey: credentials.privateKey });
  const { doctor, reports } = await collectDoctorReports(app, options);

  if (options.json) console.log(JSON.stringify(humanJsonResult(commandId, "ok", reports), null, 2));
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
  const moduleUrl = new URL("../../scripts/df-audit.mjs", import.meta.url);
  const doctor = await import(moduleUrl.href) as {
    runRepositoryDoctor: (github: unknown, options: Record<string, unknown>) => Promise<DoctorReport[]>;
    formatDoctorReports: (reports: DoctorReport[]) => string;
  };
  if (!options.all) {
    const [targetOwner, targetRepo] = splitRepository(options.target);
    try {
      await octokit.request("GET /repos/{owner}/{repo}", { owner: targetOwner, repo: targetRepo });
    } catch (error) {
      if (!isRecord(error) || error.status !== 404) throw error;
      const message = `The configured DarkFactory GitHub App cannot observe ${options.target}. Run df install-url and grant that exact repository to the App installation, or verify that the repository exists; setup cannot degrade to user credentials.`;
      return {
        doctor,
        reports: [{
          schema_version: 2,
          mode: "diagnose",
          trigger: "cli",
          target_repository: options.target,
          lifecycle: "removed",
          read_only: true,
          source_refs: {},
          findings: [{
            id: "github-app-installation-required",
            category: "registration",
            message,
            severity: "critical",
            repair_class: "owner",
            evidence: [],
            repair: ["Run df install-url and grant this exact repository to the configured DarkFactory GitHub App installation."]
          }],
          accepted_residue: [],
          observations: ["Target inspection stopped before any repository read or write because App installation authority was absent."],
          actions: [],
          token_usage: { model_calls: 0, input_tokens: 0, output_tokens: 0 }
        } as unknown as DoctorReport]
      };
    }
  }
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

async function runSetup(args: string[], commandId = "setup"): Promise<void> {
  const options = parseSetupCliArgs(args);
  const credentials = loadAppCredentials();
  const app = new App({ appId: credentials.appId, privateKey: credentials.privateKey });
  const dataGithub = await operatorLedgerGithub(app);
  const ledger = await operatorLedgerModule();
  const receipts: SetupReceipt[] = [];
  const dispatchedIssueLanePlans = new Set<string>();
  const dispatchedReadinessPlans = new Set<string>();
  const dispatchedRegistrationSyncs = new Set<string>();
  const dispatchedReleasePlans = new Set<string>();
  const dispatchedCleanPlans = new Set<string>();
  const dispatchedSubmodulePlans = new Set<string>();
  const maxPasses = options.watch ? boundedInteger(process.env.DF_SETUP_WATCH_PASSES, 120, 1, 240) : 1;
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
    const passReceipts = await executeSetupPlan(
      app,
      reports,
      plan,
      dispatchedIssueLanePlans,
      dispatchedReadinessPlans,
      dispatchedRegistrationSyncs,
      dispatchedReleasePlans,
      dispatchedCleanPlans,
      dispatchedSubmodulePlans,
      { agentsHome: options.agentsHome, packageRoot: fileURLToPath(new URL("..", import.meta.url)) }
    );
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
    const asynchronous = plan.actions.some((action) => action.supported && [
      "converge-registration",
      "open-managed-setup-pr",
      "reconcile-issue-lane",
      "evaluate-readiness",
      "reconcile-branches",
      "converge-release",
      "converge-clean",
      "converge-submodules"
    ].includes(action.operation));
    if (stableEvidencePasses >= 2 && !asynchronous) {
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
  const blocked = !converged;
  if (options.json) console.log(JSON.stringify(humanJsonResult(
    commandId,
    blocked ? "blocked" : "ok",
    result,
    blocked ? { code: "setup_not_converged", message: `Setup stopped without convergence: ${stopReason}` } : null
  ), null, 2));
  else printSetupResult(result);
  if (blocked) process.exitCode = 1;
}

async function executeSetupPlan(
  app: App,
  reports: DoctorReport[],
  plan: ReturnType<typeof planSetupConvergence>,
  dispatchedIssueLanePlans: Set<string>,
  dispatchedReadinessPlans: Set<string>,
  dispatchedRegistrationSyncs: Set<string>,
  dispatchedReleasePlans: Set<string>,
  dispatchedCleanPlans: Set<string>,
  dispatchedSubmodulePlans: Set<string>,
  machine: { agentsHome: string; packageRoot: string }
): Promise<SetupReceipt[]> {
  const receipts: SetupReceipt[] = [];
  for (const report of reports) {
    const repositoryActions = plan.actions.filter((action) => action.repository === report.target_repository && action.supported);
    const registrationAdmission = report.lifecycle === "removed"
      && repositoryActions.some((action) => action.stage === "registration" && action.operation === "converge-registration");
    if (report.lifecycle !== "active" && !registrationAdmission) {
      receipts.push({ action: "lifecycle", target: report.target_repository, status: "owner-required", detail: `Repository lifecycle is ${report.lifecycle}; setup refuses it.` });
      continue;
    }
    if (repositoryActions.length === 0) continue;
    const [owner, repo] = splitRepository(report.target_repository);
    const octokit = await getInstallationOctokit(app, owner);
    const github = createOperatorRequester(octokit);
    const activeStage = repositoryActions[0]?.stage;
    // Execute one proven dependency stage per observation. Later stages must
    // see a fresh doctor snapshot after this stage's synchronous postcondition
    // or asynchronous reviewed workflow has actually landed.
    const operations = new Set(repositoryActions
      .filter((action) => action.stage === activeStage)
      .map((action) => action.operation));

    if (operations.has("converge-machine-runtime")) {
      receipts.push(...await convergeMachineRuntime({
        agentsHome: machine.agentsHome,
        packageRoot: machine.packageRoot,
        trustedRevision: exactControlRevision(),
        findingIds: repositoryActions
          .filter((action) => action.stage === activeStage)
          .map((action) => action.findingId)
      }));
    }

    if (operations.has("converge-registration")) {
      const registryOctokit = await getScopedInstallationOctokit(
        app,
        CONTROL_OWNER,
        { checks: "read", contents: "write", pull_requests: "write" },
        ["Andromeda-data"]
      );
      const registration = await convergeManagedRegistration(createOperatorRequester(registryOctokit), report.target_repository);
      receipts.push(registration.receipt);
      const syncKey = `${plan.planId}:${report.target_repository}`;
      if (registration.sourceActive && !dispatchedRegistrationSyncs.has(syncKey)) {
        const control = await getScopedInstallationOctokit(app, CONTROL_OWNER, { actions: "write", contents: "read" }, [CONTROL_REPO]);
        await control.request("POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches", {
          owner: CONTROL_OWNER,
          repo: CONTROL_REPO,
          workflow_id: "sync-managed-repos.yml",
          ref: "main"
        });
        dispatchedRegistrationSyncs.add(syncKey);
        receipts.push({
          action: "managed-registration-sync",
          target: report.target_repository,
          status: "applied",
          detail: "Dispatched trusted managed baseline sync after re-observing the active canonical source entry."
        });
      }
    }

    if (operations.has("initialize-repository")) {
      try {
        receipts.push(...await convergeRepositoryFoundation(github, { owner, repo }, { createDev: false }));
      } catch (error) {
        if (!(error instanceof SetupOwnerActionRequired)) throw error;
        receipts.push({ action: error.action, target: report.target_repository, status: "owner-required", detail: error.message });
      }
    }

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
      if (result.pullRequestUrl) {
        receipts.push(...await armManagedSetupBootstrap(github, { owner, repo }, result.pullRequestUrl));
      }
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
          inputs: { repo: report.target_repository, ref: "dev" }
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

    if (operations.has("converge-clean")) {
      const dispatchKey = `${plan.planId}:${report.target_repository}:clean`;
      if (!dispatchedCleanPlans.has(dispatchKey)) {
        const control = await getScopedInstallationOctokit(app, CONTROL_OWNER, { actions: "write", contents: "read" }, [CONTROL_REPO]);
        await control.request("POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches", {
          owner: CONTROL_OWNER,
          repo: CONTROL_REPO,
          workflow_id: "df-clean.yml",
          ref: "main",
          inputs: { repo: report.target_repository }
        });
        dispatchedCleanPlans.add(dispatchKey);
        receipts.push({ action: "repository-hygiene", target: report.target_repository, status: "applied", detail: "Dispatched the trusted evidence-bound clean lane; ambiguous or non-atomic cleanup remains preserved." });
      } else {
        receipts.push({ action: "repository-hygiene", target: report.target_repository, status: "current", detail: "This exact evidence plan already dispatched repository hygiene; waiting for its trusted run." });
      }
    }

    if (operations.has("converge-submodules")) {
      const dispatchKey = `${plan.planId}:${report.target_repository}:submodules`;
      if (!dispatchedSubmodulePlans.has(dispatchKey)) {
        const control = await getScopedInstallationOctokit(app, CONTROL_OWNER, { actions: "write", contents: "read" }, [CONTROL_REPO]);
        await control.request("POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches", {
          owner: CONTROL_OWNER,
          repo: CONTROL_REPO,
          workflow_id: "df-submodule-autoupdate.yml",
          ref: "main",
          inputs: { repo: "" }
        });
        dispatchedSubmodulePlans.add(dispatchKey);
        receipts.push({ action: "submodule-convergence", target: report.target_repository, status: "applied", detail: "Dispatched the trusted released-child scan; only an exact policy-owned gitlink may enter a reviewed pointer PR." });
      } else {
        receipts.push({ action: "submodule-convergence", target: report.target_repository, status: "current", detail: "This exact evidence plan already dispatched released pointer convergence; waiting for its trusted run." });
      }
    }

    for (const [operation, mode] of [["reconcile-branches", "reconcile"], ["converge-release", "run"]] as const) {
      if (!operations.has(operation)) continue;
      // Reconciliation changes the release predicate. Never enqueue a release
      // from the same stale observation; the next doctor pass may request it.
      if (operation === "converge-release" && operations.has("reconcile-branches")) continue;
      const dispatchKey = `${plan.planId}:${report.target_repository}:${mode}`;
      if (!dispatchedReleasePlans.has(dispatchKey)) {
        const control = await getScopedInstallationOctokit(app, CONTROL_OWNER, { actions: "write", contents: "read" }, [CONTROL_REPO]);
        await control.request("POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches", {
          owner: CONTROL_OWNER,
          repo: CONTROL_REPO,
          workflow_id: "df-release.yml",
          ref: "main",
          inputs: { repo: report.target_repository, mode }
        });
        dispatchedReleasePlans.add(dispatchKey);
        receipts.push({ action: "release-convergence", target: report.target_repository, status: "applied", detail: `Dispatched trusted release ${mode}; no direct main/dev write or bypass was used.` });
      } else {
        receipts.push({ action: "release-convergence", target: report.target_repository, status: "current", detail: `This exact evidence plan already dispatched trusted release ${mode}; waiting for protected convergence.` });
      }
    }

    for (const operation of operations) {
      if (["converge-machine-runtime", "converge-registration", "initialize-repository", "open-managed-setup-pr", "converge-settings", "reconcile-issue-lane", "evaluate-readiness", "reconcile-branches", "converge-release", "converge-clean", "converge-submodules"].includes(operation)) continue;
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

export type ReleaseCliOptions = {
  mode: "status" | "plan" | "reconcile" | "run" | "verify";
  target: string;
  watch: boolean;
  json: boolean;
};

export function parseReleaseCliArgs(args: string[]): ReleaseCliOptions {
  const options: ReleaseCliOptions = {
    mode: "status",
    target: `${CONTROL_OWNER}/${CONTROL_REPO}`,
    watch: false,
    json: false
  };
  let index = 0;
  if (["status", "plan", "reconcile", "run", "verify"].includes(args[0])) {
    options.mode = args[0] as ReleaseCliOptions["mode"];
    index += 1;
  }
  let targetSeen = false;
  for (; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--watch") { options.watch = true; continue; }
    if (argument === "--json") { options.json = true; continue; }
    if (["--force", "--bypass", "--admin", "--delete-dev"].includes(argument)) {
      throw new Error(`${argument} is intentionally unavailable for release`);
    }
    if (argument.startsWith("-")) throw new Error(`unknown release option: ${argument}`);
    if (targetSeen || !/^[^/\s]+\/[^/\s]+$/.test(argument)) throw new Error("release accepts at most one owner/repo target");
    options.target = argument;
    targetSeen = true;
  }
  if (options.watch && options.mode !== "run") throw new Error("release --watch is available only with release run");
  return options;
}

async function runRelease(args: string[], commandId?: string): Promise<void> {
  const options = parseReleaseCliArgs(args);
  const credentials = loadAppCredentials();
  const app = new App({ appId: credentials.appId, privateKey: credentials.privateKey });
  const [owner] = splitRepository(options.target);
  const mutating = ["reconcile", "run", "verify"].includes(options.mode);
  const targetGithub = createDoctorRequester(await getScopedInstallationOctokit(app, owner, {
    administration: "read",
    actions: "read",
    checks: "read",
    contents: mutating ? "write" : "read",
    issues: mutating ? "write" : "read",
    pull_requests: mutating ? "write" : "read",
    statuses: "read"
  }));
  const dataGithub = mutating
    ? createDoctorRequester(await getScopedInstallationOctokit(app, CONTROL_OWNER, { contents: "write" }, ["darkfactory-data"]))
    : targetGithub;
  const release = await import(new URL("../../scripts/df-release.mjs", import.meta.url).href) as {
    configureReleaseRuntime(options: Record<string, unknown>): void;
    runReleaseCommand(options: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  release.configureReleaseRuntime({
    gh: targetGithub,
    ledgerGh: dataGithub,
    controlRepo: { owner: CONTROL_OWNER, repo: CONTROL_REPO }
  });
  const repository = { owner, repo: options.target.split("/")[1] };
  const maxPasses = options.watch ? boundedInteger(process.env.DF_RELEASE_WATCH_PASSES, 40, 1, 240) : 1;
  let result: Record<string, unknown> = {};
  let completedPasses = 0;
  for (let pass = 1; pass <= maxPasses; pass += 1) {
    completedPasses = pass;
    result = await release.runReleaseCommand({ mode: options.mode, repository });
    const status = typeof result.status === "string" ? result.status : "unknown";
    if (!options.watch || releaseResultIsTerminal({ status })) break;
    if (pass < maxPasses) await delay(15_000);
  }
  const watchTimedOut = options.watch && !releaseResultIsTerminal(result);
  if (watchTimedOut) {
    result = {
      ...result,
      status: "blocked",
      watch: { timedOut: true, passes: completedPasses, lastStatus: String(result.status || "unknown") }
    };
  }
  const blocked = releaseResultIsBlocked(result);
  if (options.json) console.log(JSON.stringify(humanJsonResult(
    commandId ?? `release-${options.mode}`,
    blocked ? "blocked" : "ok",
    result,
    blocked ? { code: "release_convergence_blocked", message: "Release convergence is blocked by current evidence" } : null
  ), null, 2));
  else printReleaseResult(result);
  if (blocked) process.exitCode = 1;
}

export function releaseResultIsBlocked(result: Record<string, unknown>): boolean {
  return ["blocked", "failed", "owner-required"].includes(String(result.status || ""));
}

export function releaseResultIsTerminal(result: Record<string, unknown>): boolean {
  return ["verified", "blocked", "failed", "owner-required", "skipped"].includes(String(result.status || ""));
}

export type SubmoduleCliOptions = {
  mode: "status" | "update" | "verify";
  child: string;
  watch: boolean;
  json: boolean;
};

type SubmoduleEngine = {
  run(options: { mode: SubmoduleCliOptions["mode"]; child: string }): Promise<Record<string, unknown>>;
};

export function parseSubmoduleCliArgs(args: string[]): SubmoduleCliOptions {
  const options: SubmoduleCliOptions = { mode: "status", child: "", watch: false, json: false };
  let index = 0;
  if (["status", "update", "verify"].includes(args[0])) {
    options.mode = args[0] as SubmoduleCliOptions["mode"];
    index += 1;
  }
  let childSeen = false;
  for (; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--watch") { options.watch = true; continue; }
    if (argument === "--json") { options.json = true; continue; }
    if (["--force", "--bypass", "--admin"].includes(argument)) throw new Error(`${argument} is intentionally unavailable for submodule convergence`);
    if (argument.startsWith("-")) throw new Error(`unknown submodules option: ${argument}`);
    if (childSeen) throw new Error("submodules accepts at most one released child owner/repo target");
    options.child = validateRepository(argument);
    childSeen = true;
  }
  return options;
}

export function submoduleGithubPermissions(mode: SubmoduleCliOptions["mode"]): Record<string, "read" | "write"> {
  const mutating = mode === "update";
  return {
    administration: "read",
    actions: mutating ? "write" : "read",
    checks: "read",
    contents: mutating ? "write" : "read",
    issues: mutating ? "write" : "read",
    pull_requests: mutating ? "write" : "read",
    statuses: "read"
  };
}

function submoduleWatchSettled(result: Record<string, unknown>): boolean {
  const status = typeof result.status === "string" ? result.status : "";
  if (["blocked", "current", "released", "verified", "automerge-armed", "failed", "skipped"].includes(status)) return true;
  const plan = isRecord(result.plan) ? result.plan : null;
  return result.mode === "status" && plan !== null && ["block", "current", "released"].includes(String(plan.action || ""));
}

export async function executeSubmoduleEngine(
  options: SubmoduleCliOptions,
  engine: SubmoduleEngine,
  runtime: { maxPasses?: number; wait?: (milliseconds: number) => Promise<void> } = {}
): Promise<Record<string, unknown>> {
  const maxPasses = options.watch ? (runtime.maxPasses ?? boundedInteger(process.env.DF_SUBMODULE_WATCH_PASSES, 40, 1, 240)) : 1;
  const wait = runtime.wait ?? (async (milliseconds: number) => { await delay(milliseconds); });
  let result: Record<string, unknown> = {};
  for (let pass = 1; pass <= maxPasses; pass += 1) {
    result = await engine.run({ mode: options.mode, child: options.child });
    if (!options.watch || submoduleWatchSettled(result)) return result;
    if (pass < maxPasses) await wait(15_000);
  }
  throw new Error(`Timed out waiting for submodule ${options.mode} convergence`);
}

export function submoduleJsonResult(options: SubmoduleCliOptions, result: Record<string, unknown>): ReturnType<typeof humanJsonResult> {
  const blocked = result.status === "blocked";
  return humanJsonResult(
    `submodules-${options.mode}`,
    blocked ? "blocked" : "ok",
    result,
    blocked ? { code: "submodule_convergence_blocked", message: "Submodule convergence is blocked by current evidence" } : null
  );
}

async function runSubmodules(args: string[]): Promise<void> {
  const options = parseSubmoduleCliArgs(args);
  const credentials = loadAppCredentials();
  const app = new App({ appId: credentials.appId, privateKey: credentials.privateKey });
  const mutating = options.mode === "update";
  const github = createDoctorRequester(await getScopedInstallationOctokit(app, CONTROL_OWNER, submoduleGithubPermissions(options.mode)));
  const ledgerGithub = mutating
    ? createDoctorRequester(await getScopedInstallationOctokit(app, CONTROL_OWNER, { contents: "write" }, ["darkfactory-data"]))
    : github;
  const module = await import(new URL("../../scripts/df-submodule-autoupdate.mjs", import.meta.url).href) as unknown as {
    configureSubmoduleRuntime(options: Record<string, unknown>): void;
    runSubmoduleCommand(options: { mode: SubmoduleCliOptions["mode"]; child: string }): Promise<Record<string, unknown>>;
  };
  module.configureSubmoduleRuntime({
    gh: github,
    ledgerGh: ledgerGithub,
    controlRepo: { owner: CONTROL_OWNER, repo: CONTROL_REPO },
    root: fileURLToPath(new URL("..", import.meta.url))
  });
  const result = await executeSubmoduleEngine(options, { run: module.runSubmoduleCommand });
  const blocked = result.status === "blocked";
  if (options.json) {
    console.log(JSON.stringify(submoduleJsonResult(options, result), null, 2));
  } else {
    const plan = isRecord(result.plan) ? result.plan : {};
    console.log(`Submodule ${options.mode}: ${String(result.status || "observed")}.`);
    console.log(`- Plan: ${String(plan.planId || "read-only")} (${String(plan.action || "observe")})`);
    console.log("Rerun with --watch to observe the same evidence-bound lane; no force or bypass mode exists.");
  }
  if (blocked) process.exitCode = 1;
}

export function parseCleanCliArgs(args: string[]): CleanCliOptions {
  const options: CleanCliOptions = {
    mode: "plan",
    target: `${CONTROL_OWNER}/${CONTROL_REPO}`,
    planId: "",
    localPath: "",
    agentsHome: process.env.ANDROMEDA_HOME?.trim() || "",
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
  if (!options.agentsHome) throw new Error("clean requires canonical ANDROMEDA_HOME for durable plan storage");
  return options;
}

async function runClean(args: string[], commandId?: string): Promise<void> {
  const options = parseCleanCliArgs(args);
  const controlRevision = exactControlRevision();
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
      control_revision: controlRevision,
      plan_id: plan.planId,
      evidence_hash: plan.evidenceHash,
      entries: plan.entries,
      local_plan_path_id: stableLocalPathId(path)
    });
    const result = { schemaVersion: 1, mode: "plan", plan, durable: true };
    if (options.json) console.log(JSON.stringify(humanJsonResult(commandId ?? "clean-plan", "ok", result), null, 2));
    else printCleanPlan(plan);
    return;
  }

  if (options.mode === "verify") {
    const actionable = plan.entries.filter((entry) => entry.action !== "preserve");
    const reviewResidue = plan.entries.filter((entry) => entry.kind === "lane-finding");
    const result = { schemaVersion: 1, mode: "verify", repository: target, controlRevision, clean: actionable.length === 0 && reviewResidue.length === 0, actionable, reviewResidue };
    await ledger.writeRunLedger(dataGithub, "marius-patrik/darkfactory-data", "clean-verify", target, result);
    if (options.json) console.log(JSON.stringify(humanJsonResult(
      commandId ?? "clean-verify",
      result.clean ? "ok" : "blocked",
      result,
      result.clean ? null : { code: "clean_verification_blocked", message: "Repository hygiene still has actionable or review residue" }
    ), null, 2));
    else console.log(result.clean ? `${target}: clean (proven no-op)` : `${target}: ${actionable.length} admitted hygiene actions and ${reviewResidue.length} deterministic review findings remain; run df clean plan.`);
    if (!result.clean) process.exitCode = 1;
    return;
  }

  if (!saved) throw new Error("clean apply plan disappeared before admission");
  const remoteDeletion = saved.entries.some((entry) => entry.kind === "remote-branch" && entry.action === "delete");
  if (remoteDeletion && !options.localPath) {
    throw new Error("clean apply requires --local for atomic remote branch deletion");
  }
  const remoteDeletionToken = remoteDeletion
    ? await getScopedInstallationToken(app, owner, { contents: "write" }, [repo])
    : "";
  await ledger.writeRunLedger(dataGithub, "marius-patrik/darkfactory-data", "clean-apply-admission", target, {
    control_revision: controlRevision,
    plan_id: saved.planId,
    evidence_hash: saved.evidenceHash,
    intended_actions: saved.entries.filter((entry) => entry.action !== "preserve")
  });
  const receipt = await applyCleanPlan(github, { owner, repo }, saved, evidence, {
    localPath: options.localPath,
    observeReviewFindings: async () => await collectCleanReviewFindings(app, options, target),
    ...(remoteDeletion ? {
      deleteRemoteBranchExact: async (branch: string, expectedHead: string) => {
        await deleteRemoteBranchWithLease(
          options.localPath,
          `https://github.com/${owner}/${repo}.git`,
          branch,
          expectedHead,
          remoteDeletionToken
        );
      }
    } : {}),
    onAdmission: async (action) => {
      await ledger.writeRunLedger(dataGithub, "marius-patrik/darkfactory-data", "clean-action-admission", target, {
        control_revision: controlRevision,
        plan_id: saved!.planId,
        evidence_hash: saved!.evidenceHash,
        action
      });
    },
    onCompletion: async (action) => {
      await ledger.writeRunLedger(dataGithub, "marius-patrik/darkfactory-data", "clean-action-receipt", target, {
        control_revision: controlRevision,
        plan_id: saved!.planId,
        evidence_hash: saved!.evidenceHash,
        action
      });
    }
  });
  await ledger.writeRunLedger(dataGithub, "marius-patrik/darkfactory-data", "clean-apply-completion", target, {
    control_revision: controlRevision,
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
        control_revision: controlRevision,
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
  const blocked = options.watch && watchVerification?.clean !== true;
  if (options.json) console.log(JSON.stringify(humanJsonResult(
    commandId ?? "clean-apply",
    blocked ? "blocked" : "ok",
    { ...receipt, controlRevision, watchVerification },
    blocked ? { code: "clean_convergence_blocked", message: "Clean apply completed but watch verification did not converge" } : null
  ), null, 2));
  else {
    console.log(`${target}: applied ${receipt.actions.filter((action) => action.status === "applied").length} admitted actions; ${receipt.actions.filter((action) => action.status === "skipped").length} entries preserved.`);
    if (watchVerification) console.log(`${target}: watch verification clean=${watchVerification.clean}, stalled=${watchVerification.stalled} after ${watchVerification.passes} pass(es); actions=${watchVerification.actionable}, review findings=${watchVerification.reviewResidue}.`);
  }
  if (blocked) process.exitCode = 1;
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
  const moduleUrl = new URL("../../scripts/df-lib.mjs", import.meta.url);
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

function printReleaseResult(result: Record<string, unknown>): void {
  const plan = isRecord(result.plan) ? result.plan : {};
  const action = isRecord(result.action) ? result.action : {};
  console.log(`Release ${String(result.mode || "status")} for ${String(result.repository || (isRecord(result.observation) ? result.observation.repository : "unknown"))}.`);
  console.log(`- Plan: ${String(plan.planId || "read-only")} (${String(plan.action || "observe")}: ${String(plan.reason || "current")})`);
  if (Object.keys(action).length) console.log(`- Result: ${String(action.status || result.status || "complete")} (${String(action.action || "release")})`);
  console.log("Rerun the same command to resume marker-owned work; no force or bypass mode exists.");
}

function printCleanPlan(plan: ReturnType<typeof buildCleanPlan>): void {
  const actions = plan.entries.filter((entry) => entry.action !== "preserve");
  const reviewFindings = plan.entries.filter((entry) => entry.kind === "lane-finding");
  console.log(`Clean plan ${plan.planId} for ${plan.repository}: ${actions.length} admitted actions, ${plan.entries.length - actions.length} preserved entries, ${reviewFindings.length} deterministic review findings.`);
  for (const entry of plan.entries) console.log(`- ${entry.action}: ${entry.kind} ${entry.target} @ ${entry.head.slice(0, 12)} (${entry.classification})`);
  console.log(`Apply only with: df clean apply ${plan.planId}`);
}

async function runHumanCommand(command: ParsedHumanCommand): Promise<boolean> {
  switch (command.spec.id) {
    case "issue-draft":
      await runIssueDraftCommand(command);
      return true;
    case "issue-review":
    case "issue-fix":
      await runIssueAutoreviewCommand(command);
      return true;
    case "issue-ready":
      await runIssueReadyCommand(command);
      return true;
    case "issue-ask":
      await runIssueAskCommand(command);
      return true;
    case "repo-doctor": {
      const args = [command.arguments[0]];
      if (typeof command.options["--local"] === "string") args.push("--local", command.options["--local"] as string);
      if (command.options["--json"] === true) args.push("--json");
      await runDoctor(args, "repo-doctor");
      return true;
    }
    case "repo-sync":
    case "baseline-sync":
      await syncOneManagedRepository(command);
      return true;
    case "repo-status":
    case "baseline-status":
    case "baseline-verify": {
      const target = command.arguments[0] || `${CONTROL_OWNER}/${CONTROL_REPO}`;
      await runDoctor([target, ...(command.options["--json"] === true ? ["--json"] : [])], command.spec.id);
      return true;
    }
    case "plan":
    case "work":
    case "resume":
    case "verify":
      await runWorkflowBackedCommand(command);
      return true;
    case "streams":
    case "dashboard":
      await runLaneObservationCommand(command);
      return true;
    case "pr-review":
    case "pr-fix":
      await runPullAutoreviewCommand(command);
      return true;
    case "pr-status":
    case "pr-merge":
      await runPullCommand(command);
      return true;
    case "explain":
      await runExplainCommand(command);
      return true;
    case "runs-list":
    case "runs-show":
    case "runs-watch":
    case "runs-retry":
      await runRunsCommand(command);
      return true;
    case "receipts-list":
    case "receipts-show":
    case "receipts-verify":
      await runReceiptsCommand(command);
      return true;
    case "lane-pause":
    case "lane-resume":
      await runLaneBrakeCommand(command);
      return true;
    case "runners-status":
      await runRunnersStatusCommand(command);
      return true;
    case "logs":
      await runLogsCommand(command);
      return true;
    case "repo-init":
    case "setup":
      await runSetup(setupArgumentsForHumanCommand(command), command.spec.id);
      return true;
    case "clean-plan":
    case "clean-apply":
    case "clean-verify": {
      const mode = command.spec.id.slice("clean-".length);
      await runClean([
        mode,
        ...command.arguments,
        ...(typeof command.options["--local"] === "string" ? ["--local", command.options["--local"] as string] : []),
        ...(command.options["--watch"] === true ? ["--watch"] : []),
        ...(command.options["--json"] === true ? ["--json"] : [])
      ], command.spec.id);
      return true;
    }
    case "release-status":
    case "release-plan":
    case "release-reconcile":
    case "release-run":
    case "release-verify": {
      const mode = command.spec.id.slice("release-".length);
      await runRelease([
        mode,
        ...command.arguments,
        ...(command.options["--watch"] === true ? ["--watch"] : []),
        ...(command.options["--json"] === true ? ["--json"] : [])
      ], command.spec.id);
      return true;
    }
    case "submodules-status":
    case "submodules-update":
    case "submodules-verify": {
      await runSubmodules([
        command.spec.id.slice("submodules-".length),
        ...command.arguments,
        ...(command.options["--watch"] === true ? ["--watch"] : []),
        ...(command.options["--json"] === true ? ["--json"] : [])
      ]);
      return true;
    }
    default:
      return false;
  }
}

export function setupArgumentsForHumanCommand(command: ParsedHumanCommand): string[] {
  return [
    ...command.arguments,
    ...(command.options["--all"] === true ? ["--all"] : []),
    ...(typeof command.options["--local"] === "string" ? ["--local", command.options["--local"] as string] : []),
    ...(typeof command.options["--agents-home"] === "string" ? ["--agents-home", command.options["--agents-home"] as string] : []),
    ...(command.options["--watch"] === true ? ["--watch"] : []),
    ...(command.options["--json"] === true ? ["--json"] : [])
  ];
}

function optionString(command: ParsedHumanCommand, name: string): string {
  const value = command.options[name];
  return typeof value === "string" ? value : "";
}

function splitOwnerValues(value: string): string[] {
  return value.split(";").map((entry) => entry.trim()).filter(Boolean);
}

async function gatherOwnerIssueIntent(): Promise<OwnerIssueIntent> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Interactive issue drafting requires a terminal; use --input with a schemaVersion 1 JSON file");
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ask = async (question: string, required = true): Promise<string> => {
      const value = (await readline.question(question)).trim();
      if (required && !value) throw new Error(`${question.trim()} is required`);
      return value;
    };
    const intent = {
      schemaVersion: 1,
      goal: await ask("Goal: "),
      evidence: splitOwnerValues(await ask("Current evidence (semicolon-separated; blank if none): ", false)),
      scope: splitOwnerValues(await ask("Scope items (semicolon-separated): ")),
      nonGoals: splitOwnerValues(await ask("Non-goals (semicolon-separated; blank if none): ", false)),
      acceptanceCriteria: splitOwnerValues(await ask("Acceptance criteria (semicolon-separated): ")),
      dependencies: splitOwnerValues(await ask("Dependencies (semicolon-separated; blank if none): ", false)),
      trustBoundaries: splitOwnerValues(await ask("Trust boundaries (semicolon-separated): ")),
      failureBehavior: splitOwnerValues(await ask("Failure behavior (semicolon-separated): ")),
      validation: splitOwnerValues(await ask("Validation and evidence (semicolon-separated): ")),
      rollout: splitOwnerValues(await ask("Rollout steps (semicolon-separated): ")),
      ownerDecisions: splitOwnerValues(await ask("Owner decisions already made (semicolon-separated; blank if none): ", false))
    };
    return parseOwnerIssueIntent(intent);
  } finally {
    readline.close();
  }
}

async function gatherOwnerIssueAnswers(questions: readonly string[]): Promise<OwnerIssueAnswers> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Interactive owner continuation requires a terminal; use --answers with a schemaVersion 1 JSON file");
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answers = [];
    for (const [index, question] of questions.entries()) {
      const answer = (await readline.question(`Owner question ${index + 1}: ${question}\nAnswer: `)).trim();
      if (!answer) throw new Error(`Owner answer ${index + 1} is required`);
      answers.push({ question, answer });
    }
    return parseOwnerIssueAnswers({ schemaVersion: 1, answers });
  } finally {
    readline.close();
  }
}

function packageRoot(): string {
  return fileURLToPath(new URL("..", import.meta.url));
}

function exactControlRevision(): string {
  const supplied = process.env.DF_CONTROL_REVISION?.trim() || "";
  if (supplied && !/^[0-9a-f]{40}$/i.test(supplied)) throw new Error("DF_CONTROL_REVISION must be an exact commit");
  try {
    const root = packageRoot();
    const revision = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/i.test(revision)) throw new Error("invalid revision");
    const dirty = execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8", windowsHide: true }).trim();
    if (dirty) throw new Error("DarkFactory control checkout is dirty; use an exact reviewed control revision");
    if (supplied && revision !== supplied.toLowerCase()) {
      throw new Error("DarkFactory control checkout does not match DF_CONTROL_REVISION");
    }
    return revision;
  } catch (error) {
    if (error instanceof Error && (error.message.includes("dirty") || error.message.includes("does not match"))) throw error;
    throw new Error("An exact trusted DarkFactory control revision is unavailable");
  }
}

async function createIssueDevelopmentRuntime(repository: string, writeIssues: boolean): Promise<IssueDevelopmentRuntime> {
  const [owner, repo] = validateRepository(repository).split("/");
  if (owner.toLowerCase() !== CONTROL_OWNER.toLowerCase()) throw new Error("DarkFactory human development commands are restricted to the managed owner");
  const credentials = loadAppCredentials();
  const app = new App({ appId: credentials.appId, privateKey: credentials.privateKey });
  const target = await getScopedInstallationOctokit(app, owner, {
    contents: "read",
    issues: writeIssues ? "write" : "read",
    pull_requests: "read"
  }, [repo]);
  const data = await getScopedInstallationOctokit(app, owner, { contents: "write" }, ["darkfactory-data"]);
  const ledgerModule = await import(new URL("../../scripts/df-lib.mjs", import.meta.url).href) as unknown as {
    writeRunLedger(github: unknown, dataRepo: string, kind: string, target: string, payload: unknown): Promise<unknown>;
  };
  return {
    github: createDoctorRequester(target),
    ledger: async (kind, targetRepository, payload) => {
      await ledgerModule.writeRunLedger(createDoctorRequester(data), "marius-patrik/darkfactory-data", kind, targetRepository, payload);
    },
    agentsHome: process.env.ANDROMEDA_HOME?.trim() || "",
    controlRevision: exactControlRevision(),
    environment: process.env
  };
}

async function runIssueDraftCommand(command: ParsedHumanCommand): Promise<void> {
  const json = command.options["--json"] === true;
  let repository = validateRepository(command.arguments[0] || `${CONTROL_OWNER}/${CONTROL_REPO}`);
  const agentsHome = process.env.ANDROMEDA_HOME?.trim() || "";
  let draftPath = optionString(command, "--draft");
  draftPath = draftPath ? path.resolve(draftPath) : defaultDraftPath(agentsHome, repository);
  const existingDraft = draftExists(draftPath);
  const ownerResume = command.options["--resume"] === true;
  const continueVersion = optionString(command, "--continue");
  const answersPath = optionString(command, "--answers");
  if (answersPath && !continueVersion) throw new Error("issue draft --answers requires --continue with the exact current conversation version");
  if (continueVersion && ownerResume) throw new Error("issue draft --continue and --resume are separate owner actions");
  if (continueVersion && optionString(command, "--approve")) throw new Error("issue draft --continue requires reviewing the replacement draft before a new digest can be approved");
  if (json && continueVersion && !answersPath) throw new Error("issue draft --json continuation requires --answers so interactive prompts cannot corrupt JSON output");
  if (json && !optionString(command, "--input") && !existingDraft) {
    throw new Error("issue draft --json requires --input or an existing --draft so interactive prompts cannot corrupt JSON output");
  }
  let state;
  if (existingDraft) {
    if (optionString(command, "--input") || optionString(command, "--effort")) throw new Error("Resuming an issue draft cannot replace its input or model effort");
    state = await readIssueDraftState(draftPath);
    if (command.arguments[0] && state.repository.toLowerCase() !== repository.toLowerCase()) throw new Error("Issue draft repository does not match the explicit target");
    repository = state.repository;
    if (continueVersion) {
      const ownerAnswers = answersPath
        ? parseOwnerIssueAnswers(JSON.parse(await readFile(path.resolve(answersPath), "utf8")))
        : await gatherOwnerIssueAnswers(state.ownerQuestions);
      state = await continueIssueDraft(draftPath, continueVersion, ownerAnswers, await createIssueDevelopmentRuntime(repository, false));
    } else if (ownerResume) {
      state = await resumeExpiredIssueDraft(draftPath, await createIssueDevelopmentRuntime(repository, false));
    } else if (state.status === "reviewed" && (await issueDraftFreshness(state)).resumeRequired) {
      throw new Error("Issue draft review expired; rerun this exact local draft with --resume to require a fresh high confirmation before publication");
    }
  } else {
    if (ownerResume) throw new Error("issue draft --resume requires one existing expired local draft");
    if (continueVersion || answersPath) throw new Error("issue draft --continue requires one existing blocked local draft");
    const effort = validateEffort(optionString(command, "--effort") || "high");
    const inputPath = optionString(command, "--input");
    const intent = inputPath
      ? parseOwnerIssueIntent(JSON.parse(await readFile(path.resolve(inputPath), "utf8")))
      : await gatherOwnerIssueIntent();
    state = await createIssueDraft(repository, intent, effort, draftPath, await createIssueDevelopmentRuntime(repository, false));
  }
  if (state.status === "drafted" || isRetryableIssueDraftReview(state)) {
    state = await reviewIssueDraft(draftPath, await createIssueDevelopmentRuntime(repository, false));
  }
  const diff = formatDraftDiff(state);
  let approval = optionString(command, "--approve");
  if (!json) {
    console.log(diff);
    console.log(`\nReviewed draft digest: ${state.current.digest}`);
    console.log(`Local draft state: ${draftPath}`);
    if (state.ownerQuestions.length > 0) {
      const version = issueDraftConversationVersion(state);
      console.log(`\nOwner questions for conversation ${version}:`);
      for (const question of state.ownerQuestions) console.log(`- ${question}`);
      console.log(`Continue this exact conversation with: df issue draft --draft "${draftPath}" --continue ${version}`);
    }
  }
  if (!approval && state.status === "reviewed" && !json && process.stdin.isTTY && process.stdout.isTTY) {
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    try {
      approval = (await readline.question("Type the exact reviewed digest to publish, or press Enter to keep the draft local: ")).trim();
    } finally {
      readline.close();
    }
  }
  if (approval) {
    state = await publishReviewedIssueDraft(draftPath, approval, await createIssueDevelopmentRuntime(repository, true));
  }
  const summary = issueDraftSummary(state, draftPath);
  if (json) console.log(JSON.stringify(humanJsonResult("issue-draft", state.status === "blocked" ? "blocked" : "ok", summary), null, 2));
  else if (state.status === "published") console.log(`Published ${state.publication?.issueUrl}`);
  else if (state.status === "blocked") console.log(`Draft blocked closed: ${state.blockers.join("; ")}`);
  else console.log("Draft remains local and unpublished.");
  if (state.status === "blocked") process.exitCode = 1;
}

async function scopedAutoreviewToken(repository: string): Promise<string> {
  const [owner, repo] = validateRepository(repository).split("/");
  if (owner.toLowerCase() !== CONTROL_OWNER.toLowerCase()) throw new Error("Autoreview CLI is restricted to the managed owner");
  const credentials = loadAppCredentials();
  const app = new App({ appId: credentials.appId, privateKey: credentials.privateKey });
  return getScopedInstallationToken(app, owner, {
    contents: "write",
    issues: "write",
    pull_requests: "write"
  }, [...new Set([repo, CONTROL_REPO, "darkfactory-data"])]);
}

async function runIssueAutoreviewCommand(command: ParsedHumanCommand): Promise<void> {
  const target = parseIssueTarget(command.arguments[0]);
  const expectedVersion = validateIssueVersion(optionString(command, "--version"));
  const module = await import(new URL("../../scripts/run-darkfactory-autoreview.mjs", import.meta.url).href) as unknown as {
    executeAutoreview(environment: NodeJS.ProcessEnv): Promise<{ ok: boolean; state: string; code?: string; rounds?: unknown[] }>;
  };
  const result = await module.executeAutoreview({
    ...process.env,
    DARK_FACTORY_TOKEN: await scopedAutoreviewToken(target.repository),
    DF_TARGET_REPO: target.repository,
    DF_TARGET_KIND: "issue",
    DF_TARGET_NUMBER: String(target.number),
    DF_EXPECTED_ISSUE_VERSION: expectedVersion,
    DF_CONTROL_REVISION: exactControlRevision()
  });
  const status = result.ok ? "ok" : "blocked";
  if (command.options["--json"] === true) console.log(JSON.stringify(humanJsonResult(command.spec.id, status, result, result.ok ? null : { code: result.code || "autoreview_blocked", message: "Issue Autoreview blocked closed" }), null, 2));
  else console.log(result.ok ? `${target.repository}#${target.number}: clean high Autoreview confirmation.` : `${target.repository}#${target.number}: blocked closed (${result.code || "unknown"}).`);
  if (!result.ok) process.exitCode = 1;
}

async function fetchAllRecords(
  github: ReturnType<typeof createDoctorRequester>,
  pathPrefix: string,
  context: string,
  maximumPages = 10
): Promise<Record<string, unknown>[]> {
  const records: Record<string, unknown>[] = [];
  const separator = pathPrefix.includes("?") ? "&" : "?";
  for (let page = 1; page <= maximumPages; page += 1) {
    const result = await github.request("GET", `${pathPrefix}${separator}per_page=100&page=${page}`);
    if (!Array.isArray(result)) throw new Error(`GitHub returned an invalid ${context} inventory`);
    records.push(...result.filter(isRecord));
    if (result.length < 100) return records;
  }
  throw new Error(`Complete ${context} inventory exceeds the bounded pagination limit`);
}

async function issueReadContext(repository: string): Promise<{ github: ReturnType<typeof createDoctorRequester> }> {
  const octokit = await createRepositoryOctokit(repository, { contents: "read", issues: "read", pull_requests: "read" });
  return { github: createDoctorRequester(octokit) };
}

async function runIssueReadyCommand(command: ParsedHumanCommand): Promise<void> {
  const target = parseIssueTarget(command.arguments[0]);
  const expectedVersion = validateIssueVersion(optionString(command, "--version"));
  const result = await observedIssueReadiness(command.arguments[0], expectedVersion);
  if (command.options["--json"] === true) console.log(JSON.stringify(humanJsonResult("issue-ready", result.ready ? "ok" : "blocked", result, result.ready ? null : { code: "not_ready", message: "Issue readiness predicates are not satisfied" }), null, 2));
  else {
    console.log(`${target.repository}#${target.number}: ${result.ready ? "ready" : "not ready"} at ${result.targetVersion}`);
    for (const finding of result.findings as Array<{ id: string; message: string }>) console.log(`- BLOCK ${finding.id}: ${finding.message}`);
  }
  if (!result.ready) process.exitCode = 1;
}

async function runIssueAskCommand(command: ParsedHumanCommand): Promise<void> {
  const target = parseIssueTarget(command.arguments[0]);
  const expectedVersion = validateIssueVersion(optionString(command, "--version"));
  const message = optionString(command, "--message").trim();
  if (!message || Buffer.byteLength(message, "utf8") > 16_384 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(message)) throw new Error("Owner question is invalid");
  const runtime = await createIssueDevelopmentRuntime(target.repository, true);
  const github = runtime.github;
  const issue = await github.request("GET", `/repos/${target.repository}/issues/${target.number}`);
  if (!isRecord(issue) || issue.pull_request || issue.state !== "open") throw new Error("Selected owner-question target must be an open issue");
  const observedVersion = issueVersion(issue);
  if (observedVersion !== expectedVersion) throw new Error(`stale issue version: expected ${expectedVersion}, observed ${observedVersion}`);
  await github.request("GET", `/repos/${target.repository}/labels/${encodeURIComponent("df:ask-owner")}`);
  const questionId = issueContentDigest(expectedVersion, message);
  const marker = `<!-- darkfactory:owner-question id=${questionId} version=${expectedVersion} -->`;
  let comments = await fetchAllRecords(github as ReturnType<typeof createDoctorRequester>, `/repos/${target.repository}/issues/${target.number}/comments`, "issue comment");
  let existing = comments.find((comment) => isTrustedDarkFactoryComment(comment) && typeof comment.body === "string" && comment.body.startsWith(marker));
  await runtime.ledger("issue-owner-question-admission", target.repository, {
    schemaVersion: 1,
    target: `${target.repository}#${target.number}`,
    targetVersion: expectedVersion,
    questionId,
    mutation: existing ? "ensure-owner-brake" : "label-and-comment"
  });
  const admittedIssue = await github.request("GET", `/repos/${target.repository}/issues/${target.number}`);
  if (!isRecord(admittedIssue) || admittedIssue.pull_request || admittedIssue.state !== "open" || issueVersion(admittedIssue) !== expectedVersion) {
    throw new Error("Issue changed after owner-question admission");
  }
  comments = await fetchAllRecords(github as ReturnType<typeof createDoctorRequester>, `/repos/${target.repository}/issues/${target.number}/comments`, "issue comment");
  existing = comments.find((comment) => isTrustedDarkFactoryComment(comment) && typeof comment.body === "string" && comment.body.startsWith(marker));
  await github.request("POST", `/repos/${target.repository}/issues/${target.number}/labels`, { labels: ["df:ask-owner"] });
  let comment = existing;
  if (!comment) {
    const created = await github.request("POST", `/repos/${target.repository}/issues/${target.number}/comments`, {
      body: `${marker}\n## Owner decision required\n\n${message}\n\nThe lane remains blocked until an owner answer is recorded and the evaluator re-observes this exact issue.`
    });
    if (!isRecord(created)) throw new Error("GitHub returned an invalid owner-question comment");
    comment = created;
  }
  await runtime.ledger("issue-owner-question-completion", target.repository, {
    schemaVersion: 1,
    target: `${target.repository}#${target.number}`,
    targetVersion: expectedVersion,
    questionId,
    commentId: comment.id ?? null
  });
  const result = { schemaVersion: 1, target: `${target.repository}#${target.number}`, targetVersion: expectedVersion, questionId, commentUrl: comment.html_url ?? null };
  if (command.options["--json"] === true) console.log(JSON.stringify(humanJsonResult("issue-ask", "ok", result), null, 2));
  else console.log(`Owner question recorded for ${result.target}: ${result.commentUrl || questionId}`);
}

async function syncOneManagedRepository(command: ParsedHumanCommand): Promise<void> {
  const target = validateRepository(command.arguments[0]);
  const [owner, repo] = target.split("/");
  const credentials = loadAppCredentials();
  const app = new App({ appId: credentials.appId, privateKey: credentials.privateKey });
  const octokit = await getInstallationOctokit(app, owner);
  const metadata = await octokit.request("GET /repos/{owner}/{repo}", { owner, repo });
  if (!isRecord(metadata.data) || typeof metadata.data.id !== "number" || typeof metadata.data.default_branch !== "string") throw new Error("GitHub returned invalid repository metadata");
  if (metadata.data.archived === true || metadata.data.disabled === true) throw new Error("Managed baseline mutation requires an active repository");
  const repositoryId = metadata.data.id;
  const defaultBranch = metadata.data.default_branch;
  const branch = await octokit.request("GET /repos/{owner}/{repo}/branches/{branch}", { owner, repo, branch: defaultBranch });
  if (!isRecord(branch.data) || !isRecord(branch.data.commit) || typeof branch.data.commit.sha !== "string" || !/^[0-9a-f]{40}$/.test(branch.data.commit.sha)) {
    throw new Error("GitHub returned invalid managed baseline revision evidence");
  }
  const admittedRevision = branch.data.commit.sha;
  const ledger = await createLedgerWriter();
  await ledger("cli-baseline-sync-admission", target, { schemaVersion: 1, command: command.spec.id, target, defaultBranch, admittedRevision });
  const currentMetadata = await octokit.request("GET /repos/{owner}/{repo}", { owner, repo });
  const currentBranch = await octokit.request("GET /repos/{owner}/{repo}/branches/{branch}", { owner, repo, branch: defaultBranch });
  if (
    !isRecord(currentMetadata.data)
    || currentMetadata.data.id !== repositoryId
    || currentMetadata.data.archived === true
    || currentMetadata.data.disabled === true
    || currentMetadata.data.default_branch !== defaultBranch
    || !isRecord(currentBranch.data)
    || !isRecord(currentBranch.data.commit)
    || currentBranch.data.commit.sha !== admittedRevision
  ) {
    throw new Error("Managed baseline target changed after admission");
  }
  const result = await ensureManagedRepositorySetup(createOctokitRequester(octokit), {
    owner,
    repo,
    defaultBranch,
    archived: false
  });
  await ledger("cli-baseline-sync-completion", target, { schemaVersion: 1, command: command.spec.id, target, defaultBranch, admittedRevision, result });
  if (command.options["--json"] === true) console.log(JSON.stringify(humanJsonResult(command.spec.id, "ok", result), null, 2));
  else console.log(`${result.owner}/${result.repo}: ${result.status}${result.pullRequestUrl ? ` ${result.pullRequestUrl}` : ""}`);
}

async function createRepositoryOctokit(
  repository: string,
  permissions: Record<string, "read" | "write">
): Promise<Octokit> {
  const [owner, repo] = validateRepository(repository).split("/");
  const credentials = loadAppCredentials();
  const app = new App({ appId: credentials.appId, privateKey: credentials.privateKey });
  return getScopedInstallationOctokit(app, owner, permissions, [repo]);
}

async function createLedgerWriter(): Promise<(kind: string, repository: string, payload: unknown) => Promise<void>> {
  const credentials = loadAppCredentials();
  const app = new App({ appId: credentials.appId, privateKey: credentials.privateKey });
  const data = await getScopedInstallationOctokit(app, CONTROL_OWNER, { contents: "write" }, ["darkfactory-data"]);
  const github = createDoctorRequester(data);
  const ledgerModule = await import(new URL("../../scripts/df-lib.mjs", import.meta.url).href) as unknown as {
    writeRunLedger(github: unknown, dataRepo: string, kind: string, target: string, payload: unknown): Promise<unknown>;
  };
  return async (kind, repository, payload) => {
    await ledgerModule.writeRunLedger(github, "marius-patrik/darkfactory-data", kind, repository, payload);
  };
}

async function dispatchControlWorkflow(
  workflow: string,
  inputs: Record<string, string>,
  watch: boolean
): Promise<Record<string, unknown>> {
  const credentials = loadAppCredentials();
  const app = new App({ appId: credentials.appId, privateKey: credentials.privateKey });
  const octokit = await getScopedInstallationOctokit(app, CONTROL_OWNER, { actions: "write", contents: "read" }, [CONTROL_REPO]);
  const github = createDoctorRequester(octokit);
  const metadata = await github.request("GET", `/repos/${CONTROL_OWNER}/${CONTROL_REPO}/actions/workflows/${encodeURIComponent(workflow)}`);
  if (!isRecord(metadata) || metadata.state !== "active" || typeof metadata.id !== "number") throw new Error(`Shared workflow ${workflow} is unavailable or inactive on protected main`);
  const priorRunIds = new Set<number>();
  if (watch) {
    const before = await github.request("GET", `/repos/${CONTROL_OWNER}/${CONTROL_REPO}/actions/workflows/${metadata.id}/runs?event=workflow_dispatch&branch=main&per_page=100`);
    if (!isRecord(before) || !Array.isArray(before.workflow_runs)) throw new Error("GitHub returned an invalid pre-dispatch workflow-run inventory");
    for (const entry of before.workflow_runs) if (isRecord(entry) && typeof entry.id === "number") priorRunIds.add(entry.id);
  }
  const dispatchedAt = new Date();
  await github.request("POST", `/repos/${CONTROL_OWNER}/${CONTROL_REPO}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, { ref: "main", inputs });
  const result: Record<string, unknown> = {
    schemaVersion: 1,
    workflow,
    workflowId: metadata.id,
    controlRef: "main",
    inputs,
    dispatchedAt: dispatchedAt.toISOString(),
    run: null
  };
  if (!watch) return result;
  let candidateId: number | null = null;
  let candidateObservations = 0;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await github.request("GET", `/repos/${CONTROL_OWNER}/${CONTROL_REPO}/actions/workflows/${metadata.id}/runs?event=workflow_dispatch&branch=main&per_page=20`);
    if (!isRecord(response) || !Array.isArray(response.workflow_runs)) throw new Error("GitHub returned an invalid workflow-run inventory");
    const candidates = response.workflow_runs.filter((entry) => {
      if (!isRecord(entry) || typeof entry.created_at !== "string") return false;
      return typeof entry.id === "number"
        && !priorRunIds.has(entry.id)
        && new Date(entry.created_at).getTime() >= dispatchedAt.getTime() - 5_000;
    });
    if (candidates.length > 1) throw new Error(`Ambiguous ${workflow} dispatch evidence; refusing to guess a workflow run`);
    if (candidates.length === 1) {
      const observedId = candidates[0].id as number;
      if (candidateId !== null && candidateId !== observedId) throw new Error(`Ambiguous ${workflow} dispatch evidence changed during observation`);
      candidateId = observedId;
      candidateObservations += 1;
    }
    if (candidateId !== null && candidateObservations >= 2) {
      const run = await github.request("GET", `/repos/${CONTROL_OWNER}/${CONTROL_REPO}/actions/runs/${candidateId}`);
      if (!isRecord(run) || run.id !== candidateId || run.workflow_id !== metadata.id || run.event !== "workflow_dispatch") {
        throw new Error(`GitHub did not confirm the exact ${workflow} dispatch run`);
      }
      result.run = run;
      if (run.status === "completed") return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Timed out waiting for exact ${workflow} dispatch evidence`);
}

async function runWorkflowBackedCommand(command: ParsedHumanCommand): Promise<void> {
  if (command.spec.id === "verify") {
    await runWorkVerification(command);
    return;
  }
  let workflow: string;
  let inputs: Record<string, string>;
  let repository: string;
  let targetVersion: string | null = null;
  let revalidateTarget: () => Promise<void>;
  if (command.spec.id === "plan") {
    repository = validateRepository(command.arguments[0]);
    const github = createDoctorRequester(await createRepositoryOctokit(repository, { contents: "read" }));
    const readRepository = async (): Promise<Record<string, unknown>> => {
      const metadata = await github.request("GET", `/repos/${repository}`);
      if (!isRecord(metadata) || metadata.archived === true || metadata.disabled === true || typeof metadata.id !== "number") throw new Error("Planning target must be an active observable repository");
      return metadata;
    };
    const initial = await readRepository();
    revalidateTarget = async () => {
      const current = await readRepository();
      if (current.id !== initial.id || current.default_branch !== initial.default_branch || current.archived !== initial.archived || current.disabled !== initial.disabled) {
        throw new Error("Planning repository changed after dispatch admission");
      }
    };
    workflow = "df-plan.yml";
    inputs = { repo: repository, ref: "" };
  } else {
    const target = parseIssueTarget(command.arguments[0]);
    repository = target.repository;
    targetVersion = validateIssueVersion(optionString(command, "--version"));
    const github = createDoctorRequester(await createRepositoryOctokit(repository, { contents: "read", issues: "read" }));
    revalidateTarget = async () => {
      const issue = await github.request("GET", `/repos/${repository}/issues/${target.number}`);
      if (!isRecord(issue) || issue.pull_request || issue.state !== "open" || issueVersion(issue) !== targetVersion) throw new Error("Work target is stale or no longer an open issue");
    };
    await revalidateTarget();
    workflow = "df-orchestrate.yml";
    inputs = {
      repo: repository,
      issue_number: String(target.number),
      source_event: `cli-${command.spec.id}`
    };
  }
  const ledger = await createLedgerWriter();
  await ledger("cli-workflow-dispatch-admission", repository, {
    schemaVersion: 1,
    command: command.spec.id,
    workflow,
    inputs,
    targetVersion,
    controlRef: "main"
  });
  await revalidateTarget();
  const result = await dispatchControlWorkflow(workflow, inputs, command.options["--watch"] === true);
  await ledger("cli-workflow-dispatch-completion", repository, {
    schemaVersion: 1,
    command: command.spec.id,
    workflow,
    inputs,
    targetVersion,
    dispatch: result
  });
  if (command.options["--json"] === true) console.log(JSON.stringify(humanJsonResult(command.spec.id, "ok", result), null, 2));
  else console.log(`Dispatched ${workflow} from protected main for ${Object.values(inputs).filter(Boolean).join(" ")}.`);
}

async function runWorkVerification(command: ParsedHumanCommand): Promise<void> {
  const target = parseIssueTarget(command.arguments[0]);
  const octokit = await createRepositoryOctokit(target.repository, { actions: "read", checks: "read", contents: "read", issues: "read", pull_requests: "read", statuses: "read" });
  const github = createDoctorRequester(octokit);
  const issue = await github.request("GET", `/repos/${target.repository}/issues/${target.number}`);
  if (!isRecord(issue) || issue.pull_request) throw new Error("Work verification target must be an issue");
  const pulls = await fetchAllRecords(github, `/repos/${target.repository}/pulls?state=closed`, "closed pull request");
  const closingPattern = new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${target.number}\\b`, "i");
  const pull = pulls.find((entry) => typeof entry.body === "string" && closingPattern.test(entry.body) && typeof entry.merged_at === "string");
  const labels = new Set(Array.isArray(issue.labels) ? issue.labels.map((entry) => isRecord(entry) ? String(entry.name || "") : String(entry)) : []);
  let gates: Record<string, unknown>[] = [];
  if (pull && isRecord(pull.head) && typeof pull.head.sha === "string") {
    const response = await github.request("GET", `/repos/${target.repository}/commits/${pull.head.sha}/check-runs?per_page=100`);
    if (!isRecord(response) || !Array.isArray(response.check_runs)) throw new Error("GitHub returned invalid verification checks");
    gates = response.check_runs.filter(isRecord);
  }
  const required = ["Validate", "DarkFactory Autoreview"];
  const predicates = [
    { id: "issue-done", passed: labels.has("df:done"), evidence: labels.has("df:done") ? "df:done is present." : "df:done is missing." },
    { id: "merged-worker-pr", passed: Boolean(pull), evidence: pull ? `Merged PR #${pull.number}.` : "No merged closing worker PR was found in the bounded inventory." },
    ...required.map((name) => {
      const check = gates.find((entry) => entry.name === name && isRecord(entry.app) && entry.app.id === TRUSTED_ACTIONS_APP_ID);
      return { id: `gate-${name.toLowerCase().replaceAll(" ", "-")}`, passed: check?.conclusion === "success", evidence: check ? `${name} concluded ${String(check.conclusion)} from App ${String((check.app as Record<string, unknown>).id)}.` : `${name} from the trusted App is missing.` };
    })
  ];
  const ok = predicates.every((entry) => entry.passed);
  const result = { schemaVersion: 1, target: command.arguments[0], verified: ok, issueVersion: issueVersion(issue), pull: pull ? { number: pull.number, url: pull.html_url, mergedAt: pull.merged_at } : null, predicates };
  await (await createLedgerWriter())("cli-work-verify", target.repository, result);
  if (command.options["--json"] === true) console.log(JSON.stringify(humanJsonResult("verify", ok ? "ok" : "blocked", result, ok ? null : { code: "verification_blocked", message: "Work verification predicates are not satisfied" }), null, 2));
  else {
    console.log(`${command.arguments[0]}: ${ok ? "verified" : "not verified"}`);
    for (const predicate of predicates) console.log(`- ${predicate.passed ? "PASS" : "BLOCK"} ${predicate.id}: ${predicate.evidence}`);
  }
  if (!ok) process.exitCode = 1;
}

async function runLaneObservationCommand(command: ParsedHumanCommand): Promise<void> {
  const repository = validateRepository(command.arguments[0]);
  const github = createDoctorRequester(await createRepositoryOctokit(repository, { actions: "read", checks: "read", contents: "read", issues: "read", pull_requests: "read" }));
  const [issues, pulls] = await Promise.all([
    fetchAllRecords(github, `/repos/${repository}/issues?state=open`, "open issue"),
    fetchAllRecords(github, `/repos/${repository}/pulls?state=open`, "open pull request")
  ]);
  const actualIssues = issues.filter((entry) => !entry.pull_request);
  const lanes = new Map<string, number>();
  for (const issue of actualIssues) {
    const labels = Array.isArray(issue.labels) ? issue.labels.map((entry) => isRecord(entry) ? String(entry.name || "") : String(entry)) : [];
    const streams = labels.filter((label) => label.startsWith("stream:"));
    for (const stream of streams.length > 0 ? streams : ["stream:unassigned"]) lanes.set(stream, (lanes.get(stream) || 0) + 1);
  }
  const result = {
    schemaVersion: 1,
    repository,
    openIssues: actualIssues.length,
    openPullRequests: pulls.length,
    ready: actualIssues.filter((issue) => Array.isArray(issue.labels) && issue.labels.some((entry) => (isRecord(entry) ? entry.name : entry) === "df:ready")).length,
    running: actualIssues.filter((issue) => Array.isArray(issue.labels) && issue.labels.some((entry) => (isRecord(entry) ? entry.name : entry) === "df:running")).length,
    blocked: actualIssues.filter((issue) => Array.isArray(issue.labels) && issue.labels.some((entry) => ["df:blocked", "df:ask-owner"].includes(String(isRecord(entry) ? entry.name : entry)))).length,
    streams: [...lanes.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, count]) => ({ name, count }))
  };
  if (command.options["--json"] === true) console.log(JSON.stringify(humanJsonResult(command.spec.id, "ok", result), null, 2));
  else {
    console.log(`${repository}: ${result.openIssues} open issues, ${result.openPullRequests} open PRs, ${result.ready} ready, ${result.running} running, ${result.blocked} blocked.`);
    for (const lane of result.streams) console.log(`- ${lane.name}: ${lane.count}`);
  }
}

async function pullSnapshot(repository: string, number: number): Promise<{
  github: ReturnType<typeof createDoctorRequester>;
  pull: Record<string, unknown>;
  checks: Record<string, unknown>[];
  protection: Record<string, unknown>;
  version: string;
}> {
  const octokit = await createRepositoryOctokit(repository, {
    administration: "read",
    checks: "read",
    contents: "read",
    pull_requests: "read",
    statuses: "read"
  });
  const github = createDoctorRequester(octokit);
  const pull = await github.request("GET", `/repos/${repository}/pulls/${number}`);
  if (!isRecord(pull) || !isRecord(pull.base) || !isRecord(pull.head) || typeof pull.base.sha !== "string" || typeof pull.head.sha !== "string") {
    throw new Error("GitHub returned an invalid pull request snapshot");
  }
  const [checkResponse, protection] = await Promise.all([
    github.request("GET", `/repos/${repository}/commits/${pull.head.sha}/check-runs?per_page=100`),
    github.request("GET", `/repos/${repository}/branches/${encodeURIComponent(String(pull.base.ref || ""))}/protection`)
  ]);
  if (!isRecord(checkResponse) || !Array.isArray(checkResponse.check_runs) || !isRecord(protection)) throw new Error("GitHub returned incomplete pull-request gate evidence");
  return {
    github,
    pull,
    checks: checkResponse.check_runs.filter(isRecord),
    protection,
    version: `${pull.base.sha}:${pull.head.sha}`
  };
}

function pullResult(snapshot: Awaited<ReturnType<typeof pullSnapshot>>): Record<string, unknown> {
  const pull = snapshot.pull;
  const required = isRecord(snapshot.protection.required_status_checks) && Array.isArray(snapshot.protection.required_status_checks.checks)
    ? snapshot.protection.required_status_checks.checks.filter(isRecord).map((entry) => ({ context: entry.context, appId: entry.app_id }))
    : [];
  return {
    schemaVersion: 1,
    repository: isRecord(pull.base) && isRecord(pull.base.repo) ? pull.base.repo.full_name : null,
    number: pull.number,
    state: pull.state,
    draft: pull.draft === true,
    version: snapshot.version,
    base: isRecord(pull.base) ? { ref: pull.base.ref, sha: pull.base.sha } : null,
    head: isRecord(pull.head) ? { ref: pull.head.ref, sha: pull.head.sha, repository: isRecord(pull.head.repo) ? pull.head.repo.full_name : null } : null,
    autoMerge: pull.auto_merge ?? null,
    requiredChecks: required,
    checks: snapshot.checks.map((entry) => ({ name: entry.name, status: entry.status, conclusion: entry.conclusion, appId: isRecord(entry.app) ? entry.app.id : null, url: entry.html_url ?? entry.details_url ?? null }))
  };
}

async function runPullAutoreviewCommand(command: ParsedHumanCommand): Promise<void> {
  const target = parseIssueTarget(command.arguments[0]);
  const expectedVersion = optionString(command, "--version");
  if (!/^[0-9a-f]{40}:[0-9a-f]{40}$/i.test(expectedVersion)) throw new Error("Pull-request version must be exact BASE_SHA:HEAD_SHA");
  const snapshot = await pullSnapshot(target.repository, target.number);
  if (snapshot.version.toLowerCase() !== expectedVersion.toLowerCase()) throw new Error(`stale pull-request version: expected ${expectedVersion}, observed ${snapshot.version}`);
  const base = snapshot.pull.base as Record<string, unknown>;
  const head = snapshot.pull.head as Record<string, unknown>;
  const module = await import(new URL("../../scripts/run-darkfactory-autoreview.mjs", import.meta.url).href) as unknown as {
    executeAutoreview(environment: NodeJS.ProcessEnv): Promise<{ ok: boolean; state: string; code?: string; rounds?: unknown[] }>;
  };
  const result = await module.executeAutoreview({
    ...process.env,
    DARK_FACTORY_TOKEN: await scopedAutoreviewToken(target.repository),
    DF_TARGET_REPO: target.repository,
    DF_TARGET_KIND: "pull_request",
    DF_TARGET_NUMBER: String(target.number),
    DF_EXPECTED_BASE: String(base.ref || ""),
    DF_EXPECTED_BASE_SHA: String(base.sha || ""),
    DF_EXPECTED_HEAD_SHA: String(head.sha || ""),
    DF_CONTROL_REVISION: exactControlRevision()
  });
  if (command.options["--json"] === true) console.log(JSON.stringify(humanJsonResult(command.spec.id, result.ok ? "ok" : "blocked", result, result.ok ? null : { code: result.code || "autoreview_blocked", message: "Pull-request Autoreview blocked closed" }), null, 2));
  else console.log(`${command.arguments[0]}: ${result.ok ? "clean high Autoreview confirmation" : `blocked closed (${result.code || "unknown"})`}.`);
  if (!result.ok) process.exitCode = 1;
}

function requiredProtectionChecks(protection: Record<string, unknown>): Array<{ context: string; appId: number | null }> {
  if (!isRecord(protection.required_status_checks) || !Array.isArray(protection.required_status_checks.checks)) return [];
  return protection.required_status_checks.checks.filter(isRecord).map((entry) => ({
    context: typeof entry.context === "string" ? entry.context : "",
    appId: typeof entry.app_id === "number" ? entry.app_id : null
  })).filter((entry) => entry.context);
}

function assertPullMergeAdmission(
  snapshot: Awaited<ReturnType<typeof pullSnapshot>>,
  repository: string,
  expectedVersion: string
): void {
  if (snapshot.version.toLowerCase() !== expectedVersion.toLowerCase()) throw new Error(`stale pull-request version: expected ${expectedVersion}, observed ${snapshot.version}`);
  const pull = snapshot.pull;
  if (pull.state !== "open" || pull.draft === true || !isRecord(pull.base) || !isRecord(pull.head)) throw new Error("Pull request must be open and ready for review");
  if (!new Set(["main", "dev"]).has(String(pull.base.ref || ""))) throw new Error("Pull request base must be protected main or dev");
  if (!isRecord(pull.head.repo) || String(pull.head.repo.full_name || "").toLowerCase() !== repository.toLowerCase()) throw new Error("Pull request auto-merge requires a same-repository head");
  const required = requiredProtectionChecks(snapshot.protection);
  for (const name of ["Validate", "DarkFactory Autoreview"]) {
    const policyCheck = required.find((entry) => entry.context === name);
    if (!policyCheck || policyCheck.appId !== TRUSTED_ACTIONS_APP_ID) throw new Error(`${name} is not required from the trusted GitHub Actions App`);
    const check = snapshot.checks.find((entry) => entry.name === name && isRecord(entry.app) && entry.app.id === TRUSTED_ACTIONS_APP_ID);
    if (!check || check.status !== "completed" || check.conclusion !== "success") throw new Error(`${name} is not currently green from the trusted GitHub Actions App`);
  }
}

async function runPullCommand(command: ParsedHumanCommand): Promise<void> {
  const target = parseIssueTarget(command.arguments[0]);
  let snapshot = await pullSnapshot(target.repository, target.number);
  if (command.spec.id === "pr-status") {
    const result = pullResult(snapshot);
    if (command.options["--json"] === true) console.log(JSON.stringify(humanJsonResult("pr-status", "ok", result), null, 2));
    else {
      console.log(`${command.arguments[0]} ${String(snapshot.pull.state)} at ${snapshot.version}`);
      for (const check of (result.checks as Record<string, unknown>[])) console.log(`- ${String(check.name)}: ${String(check.status)}/${String(check.conclusion)} App ${String(check.appId)}`);
    }
    return;
  }
  const expectedVersion = optionString(command, "--version");
  if (!/^[0-9a-f]{40}:[0-9a-f]{40}$/i.test(expectedVersion)) throw new Error("Pull-request version must be exact BASE_SHA:HEAD_SHA");
  assertPullMergeAdmission(snapshot, target.repository, expectedVersion);
  if (snapshot.pull.auto_merge) {
    const result = { ...pullResult(snapshot), alreadyArmed: true };
    await (await createLedgerWriter())("cli-pr-merge-completion", target.repository, { schemaVersion: 1, target: command.arguments[0], targetVersion: expectedVersion, alreadyArmed: true, recovered: true, autoMerge: snapshot.pull.auto_merge });
    if (command.options["--json"] === true) console.log(JSON.stringify(humanJsonResult("pr-merge", "ok", result), null, 2));
    else console.log(`${command.arguments[0]} is already armed for normal auto-merge.`);
    return;
  }
  const ledger = await createLedgerWriter();
  await ledger("cli-pr-merge-admission", target.repository, { schemaVersion: 1, target: command.arguments[0], targetVersion: expectedVersion, requiredChecks: ["Validate", "DarkFactory Autoreview"], mergeMethod: "MERGE" });
  snapshot = await pullSnapshot(target.repository, target.number);
  assertPullMergeAdmission(snapshot, target.repository, expectedVersion);
  if (snapshot.pull.auto_merge) {
    const result = { ...pullResult(snapshot), alreadyArmed: true };
    await ledger("cli-pr-merge-completion", target.repository, { schemaVersion: 1, target: command.arguments[0], targetVersion: expectedVersion, alreadyArmed: true, autoMerge: snapshot.pull.auto_merge });
    if (command.options["--json"] === true) console.log(JSON.stringify(humanJsonResult("pr-merge", "ok", result), null, 2));
    else console.log(`${command.arguments[0]} is already armed for normal auto-merge.`);
    return;
  }
  if (typeof snapshot.pull.node_id !== "string") throw new Error("GitHub did not provide the pull-request node ID required for auto-merge");
  const response = await snapshot.github.graphql(
    "mutation EnableDarkFactoryAutoMerge($pullRequestId: ID!) { enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: MERGE }) { pullRequest { number autoMergeRequest { enabledAt } } } }",
    { pullRequestId: snapshot.pull.node_id }
  );
  if (!isRecord(response) || !isRecord(response.enablePullRequestAutoMerge) || !isRecord(response.enablePullRequestAutoMerge.pullRequest) || !isRecord(response.enablePullRequestAutoMerge.pullRequest.autoMergeRequest)) {
    throw new Error("GitHub did not confirm normal auto-merge admission");
  }
  const result = { ...pullResult(snapshot), alreadyArmed: false, autoMerge: response.enablePullRequestAutoMerge.pullRequest.autoMergeRequest };
  await ledger("cli-pr-merge-completion", target.repository, { schemaVersion: 1, target: command.arguments[0], targetVersion: expectedVersion, autoMerge: result.autoMerge });
  if (command.options["--json"] === true) console.log(JSON.stringify(humanJsonResult("pr-merge", "ok", result), null, 2));
  else console.log(`${command.arguments[0]} armed for normal protected auto-merge.`);
}

async function observedIssueReadiness(targetValue: string, expectedVersion = ""): Promise<Record<string, any>> {
  const target = parseIssueTarget(targetValue);
  const credentials = loadAppCredentials();
  const app = new App({ appId: credentials.appId, privateKey: credentials.privateKey });
  const octokit = await getScopedInstallationOctokit(app, target.repository.split("/")[0], {
    administration: "read",
    actions: "read",
    checks: "read",
    contents: "read",
    issues: "read",
    pull_requests: "read",
    secrets: "read",
    statuses: "read"
  });
  const github = createDoctorRequester(octokit);
  const orchestrator = await import(new URL("../../scripts/df-orchestrate.mjs", import.meta.url).href) as unknown as {
    evaluateTargetIssueReadiness(
      github: unknown,
      controlRepo: { owner: string; repo: string },
      repository: { owner: string; repo: string },
      issueNumber: number,
      options?: Record<string, unknown>
    ): Promise<Record<string, any>>;
  };
  return orchestrator.evaluateTargetIssueReadiness(
    github,
    { owner: CONTROL_OWNER, repo: CONTROL_REPO },
    { owner: target.repository.split("/")[0], repo: target.repository.split("/")[1] },
    target.number,
    { root: packageRoot(), ...(expectedVersion ? { expectedVersion } : {}) }
  );
}

async function observedRun(targetValue: string): Promise<Record<string, unknown>> {
  const target = parseIssueTarget(targetValue);
  const github = createDoctorRequester(await createRepositoryOctokit(target.repository, { actions: "read", contents: "read" }));
  const run = await github.request("GET", `/repos/${target.repository}/actions/runs/${target.number}`);
  if (!isRecord(run)) throw new Error("GitHub returned an invalid workflow run");
  return run;
}

async function runExplainCommand(command: ParsedHumanCommand): Promise<void> {
  const [kind, target] = command.arguments;
  let result: unknown;
  if (kind === "issue") result = await observedIssueReadiness(target);
  else if (kind === "pr") {
    const parsed = parseIssueTarget(target);
    result = pullResult(await pullSnapshot(parsed.repository, parsed.number));
  } else if (kind === "run") result = await observedRun(target);
  else if (kind === "repo" || kind === "release") {
    const repository = validateRepository(target);
    const credentials = loadAppCredentials();
    const app = new App({ appId: credentials.appId, privateKey: credentials.privateKey });
    const octokit = await getScopedInstallationOctokit(app, repository.split("/")[0], {
      administration: "read", actions: "read", checks: "read", contents: "read", issues: "read", pull_requests: "read", secrets: "read", statuses: "read"
    }, [repository.split("/")[1]]);
    const doctorModule = await import(new URL("../../scripts/df-audit.mjs", import.meta.url).href) as unknown as {
      runRepositoryDoctor(github: unknown, options: Record<string, unknown>): Promise<unknown[]>;
    };
    result = await doctorModule.runRepositoryDoctor(createDoctorRequester(octokit), {
      root: packageRoot(),
      controlRepo: { owner: CONTROL_OWNER, repo: CONTROL_REPO },
      target: repository,
      all: false,
      mode: "diagnose",
      trigger: `cli-explain-${kind}`,
      localPath: "",
      agentsHome: ""
    });
  } else throw new Error(`unknown explain target kind: ${kind}`);
  if (command.options["--json"] === true) console.log(JSON.stringify(humanJsonResult("explain", "ok", { kind, target, evidence: result }), null, 2));
  else console.log(JSON.stringify({ kind, target, evidence: result }, null, 2));
}

async function runRunsCommand(command: ParsedHumanCommand): Promise<void> {
  let repository: string;
  let runId: number | null = null;
  if (command.spec.id === "runs-list") repository = validateRepository(command.arguments[0]);
  else {
    const target = parseIssueTarget(command.arguments[0]);
    repository = target.repository;
    runId = target.number;
  }
  const mutate = command.spec.id === "runs-retry";
  const github = createDoctorRequester(await createRepositoryOctokit(repository, { actions: mutate ? "write" : "read", contents: "read" }));
  let result: unknown;
  if (command.spec.id === "runs-list") {
    const response = await github.request("GET", `/repos/${repository}/actions/runs?per_page=100`);
    if (!isRecord(response) || !Array.isArray(response.workflow_runs)) throw new Error("GitHub returned an invalid workflow-run inventory");
    result = response.workflow_runs.map((entry) => isRecord(entry) ? ({ id: entry.id, name: entry.name, event: entry.event, status: entry.status, conclusion: entry.conclusion, headSha: entry.head_sha, url: entry.html_url, createdAt: entry.created_at }) : null).filter(Boolean);
  } else {
    let run = await github.request("GET", `/repos/${repository}/actions/runs/${runId}`);
    if (!isRecord(run)) throw new Error("GitHub returned an invalid workflow run");
    if (command.spec.id === "runs-watch") {
      for (let attempt = 0; run.status !== "completed" && attempt < 120; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        run = await github.request("GET", `/repos/${repository}/actions/runs/${runId}`);
        if (!isRecord(run)) throw new Error("GitHub returned an invalid workflow run while watching");
      }
      if (run.status !== "completed") throw new Error("Timed out waiting for workflow run completion");
    }
    if (command.spec.id === "runs-retry") {
      if (optionString(command, "--approve") !== String(runId)) throw new Error("runs retry --approve must equal the exact run ID");
      if (run.status !== "completed" || !new Set(["failure", "cancelled", "timed_out", "action_required", "stale"]).has(String(run.conclusion || ""))) {
        throw new Error("Only an exact completed non-success run may be retried");
      }
      const ledger = await createLedgerWriter();
      await ledger("cli-run-retry-admission", repository, { schemaVersion: 1, runId, workflowId: run.workflow_id, headSha: run.head_sha, conclusion: run.conclusion });
      const admittedRun = await github.request("GET", `/repos/${repository}/actions/runs/${runId}`);
      if (
        !isRecord(admittedRun)
        || admittedRun.id !== run.id
        || admittedRun.workflow_id !== run.workflow_id
        || admittedRun.head_sha !== run.head_sha
        || admittedRun.status !== run.status
        || admittedRun.conclusion !== run.conclusion
        || admittedRun.run_attempt !== run.run_attempt
      ) {
        throw new Error("Workflow run changed after retry admission");
      }
      await github.request("POST", `/repos/${repository}/actions/runs/${runId}/rerun-failed-jobs`);
      await ledger("cli-run-retry-completion", repository, { schemaVersion: 1, runId, workflowId: admittedRun.workflow_id, headSha: admittedRun.head_sha, requested: true });
      result = { ...admittedRun, retryRequested: true };
    } else result = run;
  }
  if (command.options["--json"] === true) console.log(JSON.stringify(humanJsonResult(command.spec.id, "ok", result), null, 2));
  else console.log(JSON.stringify(result, null, 2));
}

function encodeContentsPath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

type ReceiptRequester = {
  request(method: string, path: string, body?: unknown): Promise<unknown>;
};

type ReceiptLedgerSnapshot = Readonly<{
  headSha: string;
  rootTreeSha: string;
}>;

export type ReceiptFileEvidence = Readonly<{
  name: string;
  path: string;
  sha: string;
  ledgerRevision: string;
  commitSha: string;
  actor: Readonly<{ login: string; type: string }>;
}>;

export type ReceiptVerification = Readonly<{
  schemaVersion: 1;
  kind: string;
  targetRepository: string;
  immutableRefs: readonly string[];
  authorizingIntent: unknown;
  actor: Readonly<{ login: string; type: "Bot"; commitSha: string }>;
  gates: readonly unknown[];
  outcome: string;
  handoff: unknown;
}>;

type ReceiptKindVerification = Omit<ReceiptVerification, "schemaVersion" | "kind" | "targetRepository" | "actor">;

const RECEIPT_SHA = /^[0-9a-f]{40}$/;
const RECEIPT_DIGEST = /^[0-9a-f]{64}$/;
const TRUSTED_RECEIPT_ACTORS = new Set(["darkfactory-agent[bot]", "mp-agents[bot]"]);

function receiptRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Receipt ${field} must be an object`);
  return value;
}

function receiptString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Receipt ${field} must be a nonblank string`);
  return value;
}

function receiptSha(value: unknown, field: string): string {
  const sha = receiptString(value, field).toLowerCase();
  if (!RECEIPT_SHA.test(sha)) throw new Error(`Receipt ${field} must be an exact 40-character commit SHA`);
  return sha;
}

function receiptVersion(value: unknown, field: string): string {
  const version = receiptString(value, field).toLowerCase();
  if (!RECEIPT_DIGEST.test(version) && !/^[0-9a-f]{40}:[0-9a-f]{40}$/.test(version)) {
    throw new Error(`Receipt ${field} must be an exact issue digest or BASE_SHA:HEAD_SHA`);
  }
  return version;
}

function receiptSchemaVersion(receipt: Record<string, unknown>, required: boolean): void {
  if ((required || "schemaVersion" in receipt) && receipt.schemaVersion !== 1) {
    throw new Error("Receipt schemaVersion must be 1 for this kind");
  }
}

function greenReceiptChecks(value: unknown, requiredNames: readonly string[], field: string): Record<string, unknown>[] {
  const summary = receiptRecord(value, field);
  if (summary.green !== true || !Array.isArray(summary.checks) || summary.checks.length === 0) {
    throw new Error(`Receipt ${field} must contain a green, non-empty check set`);
  }
  const checks = summary.checks.map((entry, index) => {
    const check = receiptRecord(entry, `${field}.checks[${index}]`);
    const name = receiptString(check.name, `${field}.checks[${index}].name`);
    if (check.state !== "green" || check.actualAppId !== TRUSTED_ACTIONS_APP_ID) {
      throw new Error(`Receipt ${field} check ${name} is not green and App-bound to ${TRUSTED_ACTIONS_APP_ID}`);
    }
    return check;
  });
  const names = new Set(checks.map((check) => check.name));
  for (const required of requiredNames) {
    if (!names.has(required)) throw new Error(`Receipt ${field} is missing required gate ${required}`);
  }
  return checks;
}

function validateWorkVerificationReceipt(receipt: Record<string, unknown>, targetRepository: string): ReceiptKindVerification {
  receiptSchemaVersion(receipt, true);
  const target = receiptString(receipt.target, "target");
  if (!target.startsWith(`${targetRepository}#`) || !/^.+#[1-9][0-9]*$/.test(target)) throw new Error("Receipt work target does not match the requested repository");
  const issueVersion = receiptVersion(receipt.issueVersion, "issueVersion");
  if (receipt.verified !== true) throw new Error("Receipt work verification outcome is not verified");
  const pull = receiptRecord(receipt.pull, "pull");
  if (!Number.isSafeInteger(pull.number) || Number(pull.number) < 1 || !/^https:\/\/github\.com\//.test(receiptString(pull.url, "pull.url"))) {
    throw new Error("Receipt work verification handoff pull request is invalid");
  }
  const mergedAt = receiptString(pull.mergedAt, "pull.mergedAt");
  if (!Number.isFinite(Date.parse(mergedAt))) throw new Error("Receipt work verification merge time is invalid");
  if (!Array.isArray(receipt.predicates)) throw new Error("Receipt work verification predicates are missing");
  const predicates = receipt.predicates.map((entry, index) => {
    const predicate = receiptRecord(entry, `predicates[${index}]`);
    const id = receiptString(predicate.id, `predicates[${index}].id`);
    if (predicate.passed !== true || typeof predicate.evidence !== "string" || !predicate.evidence.trim()) {
      throw new Error(`Receipt work verification predicate ${id} is incomplete or failed`);
    }
    return predicate;
  });
  const requiredPredicates = ["issue-done", "merged-worker-pr", "gate-validate", "gate-darkfactory-autoreview"];
  const predicateIds = new Set(predicates.map((predicate) => predicate.id));
  for (const id of requiredPredicates) if (!predicateIds.has(id)) throw new Error(`Receipt work verification is missing predicate ${id}`);
  return {
    immutableRefs: [issueVersion],
    authorizingIntent: { target, issueVersion },
    gates: predicates,
    outcome: "verified",
    handoff: { pullRequest: pull.number, url: pull.url, mergedAt }
  };
}

function validateReleaseReceipt(receipt: Record<string, unknown>, targetRepository: string): ReceiptKindVerification {
  receiptSchemaVersion(receipt, false);
  if (receipt.status !== "verified" || receipt.repository !== targetRepository) throw new Error("Receipt release outcome or repository is invalid");
  const planId = receiptString(receipt.plan_id, "plan_id");
  if (!/^release-[0-9a-f]{20}$/.test(planId)) throw new Error("Receipt release authorizing plan ID is invalid");
  const mainSha = receiptSha(receipt.main_sha, "main_sha");
  const devSha = receiptSha(receipt.dev_sha, "dev_sha");
  const mainTreeSha = receipt.main_tree_sha === null ? null : receiptSha(receipt.main_tree_sha, "main_tree_sha");
  const devTreeSha = receipt.dev_tree_sha === null ? null : receiptSha(receipt.dev_tree_sha, "dev_tree_sha");
  if (mainSha !== devSha && (!mainTreeSha || mainTreeSha !== devTreeSha)) throw new Error("Receipt release immutable refs are not converged");
  const policyMode = receiptString(receipt.policy_mode, "policy_mode");
  if (!new Set(["branch-only", "tagged", "packaged", "artifact", "deployed"]).has(policyMode)) throw new Error("Receipt release policy mode is invalid");
  const release = receiptRecord(receipt.release, "release");
  if (release.green !== true || receiptSha(release.head_sha, "release.head_sha") !== mainSha || !/^https:\/\/github\.com\//.test(receiptString(release.pull_request, "release.pull_request"))) {
    throw new Error("Receipt release pull identity or outcome is invalid");
  }
  if (mainTreeSha && receiptSha(release.tree_sha, "release.tree_sha") !== mainTreeSha) throw new Error("Receipt release pull tree does not match the released tree");
  const gates = greenReceiptChecks(release.checks, ["Validate", "DarkFactory Autoreview"], "release.checks");
  const publication = receiptRecord(receipt.publication, "publication");
  if (publication.green !== true || publication.mode !== policyMode) throw new Error("Receipt release publication handoff is incomplete");
  return {
    immutableRefs: [mainSha, devSha, ...(mainTreeSha ? [mainTreeSha] : []), ...(devTreeSha ? [devTreeSha] : [])],
    authorizingIntent: { planId, policyMode },
    gates,
    outcome: "verified",
    handoff: publication
  };
}

function validateSubmoduleReceipt(receipt: Record<string, unknown>, targetRepository: string): ReceiptKindVerification {
  receiptSchemaVersion(receipt, true);
  if (receipt.status !== "released") throw new Error("Receipt submodule outcome is not released");
  const plan = receiptRecord(receipt.plan, "plan");
  if (plan.schemaVersion !== 1 || !/^submodule-[0-9a-f]{20}$/.test(receiptString(plan.planId, "plan.planId")) || plan.action !== "released") {
    throw new Error("Receipt submodule authorizing plan is invalid");
  }
  if (!Array.isArray(plan.blockers) || plan.blockers.length !== 0) throw new Error("Receipt submodule plan contains blockers");
  const evidence = receiptRecord(plan.evidence, "plan.evidence");
  if (evidence.parent !== targetRepository) throw new Error("Receipt submodule parent does not match the requested repository");
  const childSha = receiptSha(evidence.child_sha, "plan.evidence.child_sha");
  const parentMain = receiptSha(evidence.parent_main, "plan.evidence.parent_main");
  const parentDev = receiptSha(evidence.parent_dev, "plan.evidence.parent_dev");
  const mainPointer = receiptSha(evidence.main_pointer, "plan.evidence.main_pointer");
  const devPointer = receiptSha(evidence.dev_pointer, "plan.evidence.dev_pointer");
  if (childSha !== mainPointer || childSha !== devPointer) throw new Error("Receipt submodule pointers do not match the released child SHA");
  const action = receiptRecord(receipt.action, "action");
  if (action.status !== "released" || action.verified !== true || receiptSha(action.sha, "action.sha") !== childSha || action.downstream_handoff !== "darkfactory-release-verified") {
    throw new Error("Receipt submodule outcome or downstream handoff is incomplete");
  }
  const observation = receiptRecord(receipt.observation, "observation");
  const childRelease = receiptRecord(observation.child_release, "observation.child_release");
  if (receiptSha(childRelease.sha, "observation.child_release.sha") !== childSha || !/^https:\/\/github\.com\//.test(receiptString(childRelease.receipt, "observation.child_release.receipt"))) {
    throw new Error("Receipt submodule child release authority is invalid");
  }
  const gates = greenReceiptChecks(childRelease.main_checks, ["Validate"], "observation.child_release.main_checks");
  return {
    immutableRefs: [childSha, parentMain, parentDev, mainPointer, devPointer],
    authorizingIntent: { planId: plan.planId, child: evidence.child, parent: evidence.parent, path: evidence.path },
    gates,
    outcome: "released",
    handoff: action.downstream_handoff
  };
}

function validateAutoreviewReceipt(receipt: Record<string, unknown>, targetRepository: string): ReceiptKindVerification {
  receiptSchemaVersion(receipt, false);
  if (receipt.check !== "DarkFactory Autoreview") throw new Error("Receipt Autoreview check identity is invalid");
  const target = receiptString(receipt.target, "target");
  if (!target.startsWith(`${targetRepository}#`) || !/^.+#[1-9][0-9]*$/.test(target)) throw new Error("Receipt Autoreview target does not match the requested repository");
  const result = receiptRecord(receipt.result, "result");
  if (result.ok !== true || result.state !== "clean" || result.code !== null) throw new Error("Receipt Autoreview outcome is not a clean confirmation");
  const targetVersion = receiptVersion(result.targetVersion, "result.targetVersion");
  if (!Array.isArray(result.rounds)) throw new Error("Receipt Autoreview rounds are missing");
  const rounds = result.rounds.map((entry, index) => receiptRecord(entry, `result.rounds[${index}]`));
  const cleanRound = (phase: string, tier: string): Record<string, unknown> => {
    const round = rounds.find((entry) => entry.phase === phase && entry.outcome === "clean");
    if (!round) throw new Error(`Receipt Autoreview is missing clean ${phase}`);
    if (round.targetVersion !== targetVersion) throw new Error(`Receipt Autoreview ${phase} target version is stale`);
    const requested = receiptRecord(round.requested, `${phase}.requested`);
    const resolved = receiptRecord(round.resolved, `${phase}.resolved`);
    const verdict = receiptRecord(round.verdict, `${phase}.verdict`);
    if (requested.modelTier !== tier || typeof requested.effort !== "string" || !requested.effort
        || !receiptString(resolved.provider, `${phase}.resolved.provider`)
        || !receiptString(resolved.model, `${phase}.resolved.model`)
        || !receiptString(resolved.agentPreset, `${phase}.resolved.agentPreset`)
        || !receiptString(resolved.providerVersion, `${phase}.resolved.providerVersion`)
        || verdict.approved !== true || verdict.findingsComplete !== true
        || !Array.isArray(verdict.blockingFindings) || verdict.blockingFindings.length !== 0) {
      throw new Error(`Receipt Autoreview ${phase} route or verdict is incomplete`);
    }
    return round;
  };
  const medium = cleanRound("medium_review", "medium");
  const high = cleanRound("high_review", "high");
  return {
    immutableRefs: [targetVersion],
    authorizingIntent: { target, targetVersion },
    gates: [medium, high],
    outcome: "clean",
    handoff: { targetVersion, state: result.state }
  };
}

function validateReceiptKind(receipt: Record<string, unknown>, targetRepository: string): ReceiptKindVerification {
  switch (receipt.kind) {
    case "cli-work-verify": return validateWorkVerificationReceipt(receipt, targetRepository);
    case "df-release": return validateReleaseReceipt(receipt, targetRepository);
    case "df-submodule-update": return validateSubmoduleReceipt(receipt, targetRepository);
    case "autoreview-result": return validateAutoreviewReceipt(receipt, targetRepository);
    default: throw new Error(`Receipt kind ${String(receipt.kind || "missing")} has no explicit verifier`);
  }
}

function receiptFileTimestamp(name: string, kind: string): number {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-([a-z][a-z0-9-]*)\.json$/.exec(name);
  if (!match || match[6] !== kind) throw new Error("Receipt filename does not bind the declared kind");
  return Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
}

export function validateReceiptDocument(value: unknown, targetRepository: string, evidence: ReceiptFileEvidence): ReceiptVerification {
  const target = validateRepository(targetRepository);
  const receipt = receiptRecord(value, "document");
  const kind = receiptString(receipt.kind, "kind");
  if (!/^[a-z][a-z0-9-]*$/.test(kind)) throw new Error("Receipt kind is invalid");
  if (receipt.target_repo !== target) throw new Error("Receipt target repository does not match the requested ledger");
  const createdAt = receiptString(receipt.created_at, "created_at");
  const createdTime = Date.parse(createdAt);
  if (!Number.isFinite(createdTime) || new Date(createdTime).toISOString() !== createdAt) throw new Error("Receipt created_at must be a canonical ISO timestamp");
  if (!RECEIPT_SHA.test(evidence.sha) || !RECEIPT_SHA.test(evidence.ledgerRevision) || !RECEIPT_SHA.test(evidence.commitSha)) {
    throw new Error("Receipt file, ledger revision, or commit identity is invalid");
  }
  if (evidence.path !== `runs/${target}/${evidence.name}`) throw new Error("Receipt file path is outside the bounded target ledger");
  const fileTime = receiptFileTimestamp(evidence.name, kind);
  if (!Number.isFinite(fileTime) || Math.abs(fileTime - createdTime) > 5_000) throw new Error("Receipt filename timestamp does not match created_at; stale or replayed evidence refused");
  if (evidence.actor.type !== "Bot" || !TRUSTED_RECEIPT_ACTORS.has(evidence.actor.login)) throw new Error("Receipt ledger commit actor is not an exact trusted DarkFactory App identity");
  assertNoReceiptSecrets(receipt);
  const verified = validateReceiptKind(receipt, target);
  return Object.freeze({
    schemaVersion: 1,
    kind,
    targetRepository: target,
    ...verified,
    actor: Object.freeze({ login: evidence.actor.login, type: "Bot" as const, commitSha: evidence.commitSha })
  });
}

async function readReceiptLedgerSnapshot(data: ReceiptRequester): Promise<ReceiptLedgerSnapshot> {
  const ref = await data.request("GET", "/repos/marius-patrik/darkfactory-data/git/ref/heads/main");
  if (!isRecord(ref) || !isRecord(ref.object)) throw new Error("DarkFactory receipt ledger main ref is malformed");
  const headSha = receiptSha(ref.object.sha, "ledger main ref");
  const commit = await data.request("GET", `/repos/marius-patrik/darkfactory-data/git/commits/${headSha}`);
  if (!isRecord(commit) || !isRecord(commit.tree)) throw new Error("DarkFactory receipt ledger main commit is malformed");
  return Object.freeze({ headSha, rootTreeSha: receiptSha(commit.tree.sha, "ledger main tree") });
}

export async function listReceiptFilesFromTree(
  data: ReceiptRequester,
  targetRepository: string,
  snapshot: ReceiptLedgerSnapshot
): Promise<Array<{ name: string; path: string; sha: string; url: unknown }>> {
  const target = validateRepository(targetRepository);
  const directory = `runs/${target}`;
  let treeSha = snapshot.rootTreeSha;
  for (const segment of directory.split("/")) {
    const tree = await data.request("GET", `/repos/marius-patrik/darkfactory-data/git/trees/${treeSha}`);
    if (!isRecord(tree) || tree.truncated === true || !Array.isArray(tree.tree)) throw new Error(`DarkFactory receipt tree evidence is truncated or malformed at ${segment}`);
    const child = tree.tree.find((entry) => isRecord(entry) && entry.type === "tree" && entry.path === segment);
    if (!child || !isRecord(child)) return [];
    treeSha = receiptSha(child.sha, `ledger tree ${segment}`);
  }
  const directoryTree = await data.request("GET", `/repos/marius-patrik/darkfactory-data/git/trees/${treeSha}`);
  if (!isRecord(directoryTree) || directoryTree.truncated === true || !Array.isArray(directoryTree.tree)) throw new Error("DarkFactory receipt directory tree evidence is truncated or malformed");
  return directoryTree.tree
    .filter((entry) => isRecord(entry) && entry.type === "blob" && typeof entry.path === "string" && entry.path.endsWith(".json"))
    .map((entry) => ({
      name: entry.path as string,
      path: `${directory}/${String(entry.path)}`,
      sha: receiptSha(entry.sha, `ledger blob ${String(entry.path)}`),
      url: entry.url ?? null
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function receiptHttpStatus(error: unknown): number | null {
  return isRecord(error) && Number.isInteger(error.status) ? Number(error.status) : null;
}

function decodeReceiptFile(value: unknown, expectedPath: string): { name: string; path: string; sha: string; content: string } {
  if (!isRecord(value) || value.type !== "file" || value.path !== expectedPath || typeof value.name !== "string") {
    throw new Error("GitHub returned invalid exact receipt file evidence");
  }
  return { name: value.name, path: expectedPath, sha: receiptSha(value.sha, "file blob"), content: decodeGithubContent(value) };
}

export async function readExactReceiptFile(
  data: ReceiptRequester,
  targetRepository: string,
  receiptName: string,
  snapshot: ReceiptLedgerSnapshot
): Promise<{ name: string; path: string; sha: string; content: string }> {
  const target = validateRepository(targetRepository);
  const candidates = receiptName.endsWith(".json") ? [receiptName] : [receiptName, `${receiptName}.json`];
  for (const name of candidates) {
    const filePath = `runs/${target}/${name}`;
    try {
      const value = await data.request("GET", `/repos/marius-patrik/darkfactory-data/contents/${encodeContentsPath(filePath)}?ref=${snapshot.headSha}`);
      return decodeReceiptFile(value, filePath);
    } catch (error) {
      if (receiptHttpStatus(error) !== 404) throw error;
    }
  }
  throw new Error(`Receipt ${receiptName} was not found in the bounded target ledger`);
}

async function readReceiptCommitEvidence(
  data: ReceiptRequester,
  file: { name: string; path: string; sha: string },
  snapshot: ReceiptLedgerSnapshot
): Promise<ReceiptFileEvidence> {
  const commits = await data.request("GET", `/repos/marius-patrik/darkfactory-data/commits?path=${encodeURIComponent(file.path)}&sha=${snapshot.headSha}&per_page=1`);
  if (!Array.isArray(commits) || commits.length !== 1 || !isRecord(commits[0]) || !isRecord(commits[0].author)) {
    throw new Error("DarkFactory receipt commit provenance is missing or ambiguous");
  }
  const actor = commits[0].author;
  return Object.freeze({
    name: file.name,
    path: file.path,
    sha: file.sha,
    ledgerRevision: snapshot.headSha,
    commitSha: receiptSha(commits[0].sha, "file commit"),
    actor: Object.freeze({ login: receiptString(actor.login, "commit actor login"), type: receiptString(actor.type, "commit actor type") })
  });
}

function decodeGithubContent(value: unknown): string {
  if (!isRecord(value) || value.type !== "file" || value.encoding !== "base64" || typeof value.content !== "string") throw new Error("GitHub returned invalid receipt content");
  return Buffer.from(value.content.replace(/\s/g, ""), "base64").toString("utf8");
}

function receiptTarget(value: string, requireReceipt: boolean): { repository: string; receipt: string } {
  if (!requireReceipt) return { repository: validateRepository(value), receipt: "" };
  const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([A-Za-z0-9_.-]+)$/.exec(value);
  if (!match) throw new Error(`invalid receipt target: ${value}`);
  return { repository: match[1], receipt: match[2] };
}

function assertNoReceiptSecrets(value: unknown, pathPrefix = "receipt"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoReceiptSecrets(entry, `${pathPrefix}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:token|accessToken|refreshToken|secret|secrets|credential|credentials|privateKey|authorization|auth)$/i.test(key)) throw new Error(`Receipt contains forbidden secret-like key ${pathPrefix}.${key}`);
    assertNoReceiptSecrets(child, `${pathPrefix}.${key}`);
  }
}

async function runReceiptsCommand(command: ParsedHumanCommand): Promise<void> {
  const target = receiptTarget(command.arguments[0], command.spec.id !== "receipts-list");
  const data = createDoctorRequester(await createRepositoryOctokit("marius-patrik/darkfactory-data", { contents: "read" }));
  const snapshot = await readReceiptLedgerSnapshot(data);
  if (command.spec.id === "receipts-list") {
    const files = await listReceiptFilesFromTree(data, target.repository, snapshot);
    const result = files.map((entry) => ({ name: entry.name, sha: entry.sha, url: entry.url, ledgerRevision: snapshot.headSha }));
    if (command.options["--json"] === true) console.log(JSON.stringify(humanJsonResult("receipts-list", "ok", result), null, 2));
    else for (const entry of result) console.log(`${entry.name} ${entry.sha}`);
    return;
  }
  let file: { name: string; path: string; sha: string; content: string };
  if (RECEIPT_SHA.test(target.receipt.toLowerCase())) {
    const files = await listReceiptFilesFromTree(data, target.repository, snapshot);
    const matches = files.filter((entry) => entry.sha === target.receipt.toLowerCase());
    if (matches.length !== 1) throw new Error(`Receipt SHA ${target.receipt} was not found exactly once in the bounded target ledger`);
    const match = matches[0];
    const content = await data.request("GET", `/repos/marius-patrik/darkfactory-data/contents/${encodeContentsPath(match.path)}?ref=${snapshot.headSha}`);
    file = decodeReceiptFile(content, match.path);
  } else {
    file = await readExactReceiptFile(data, target.repository, target.receipt, snapshot);
  }
  let receipt: unknown;
  try {
    receipt = JSON.parse(file.content);
  } catch (error) {
    throw new Error(`Receipt JSON is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  let verification: ReceiptVerification | null = null;
  if (command.spec.id === "receipts-verify") {
    verification = validateReceiptDocument(receipt, target.repository, await readReceiptCommitEvidence(data, file, snapshot));
  }
  const result = { file: file.name, sha: file.sha, ledgerRevision: snapshot.headSha, receipt, verified: command.spec.id === "receipts-verify" ? true : null, verification };
  if (command.options["--json"] === true) console.log(JSON.stringify(humanJsonResult(command.spec.id, "ok", result), null, 2));
  else console.log(JSON.stringify(result, null, 2));
}

async function runLaneBrakeCommand(command: ParsedHumanCommand): Promise<void> {
  const target = parseIssueTarget(command.arguments[0]);
  const expectedVersion = validateIssueVersion(optionString(command, "--version"));
  const runtime = await createIssueDevelopmentRuntime(target.repository, true);
  const github = runtime.github;
  const issue = await github.request("GET", `/repos/${target.repository}/issues/${target.number}`);
  if (!isRecord(issue) || issue.pull_request || issue.state !== "open") throw new Error("Lane brake target must be an open issue");
  const observedVersion = issueVersion(issue);
  if (observedVersion !== expectedVersion) throw new Error(`stale lane version: expected ${expectedVersion}, observed ${observedVersion}`);
  let comments = await fetchAllRecords(github as ReturnType<typeof createDoctorRequester>, `/repos/${target.repository}/issues/${target.number}/comments`, "issue comment");
  const pauseMarker = `<!-- darkfactory:lane-brake pause version=${expectedVersion} -->`;
  const resumeRequestMarker = `<!-- darkfactory:lane-brake resume-request version=${expectedVersion} -->`;
  const resumeCompleteMarker = `<!-- darkfactory:lane-brake resume-complete version=${expectedVersion} -->`;
  const refreshAfterAdmission = async (): Promise<Record<string, unknown>[]> => {
    const admittedIssue = await github.request("GET", `/repos/${target.repository}/issues/${target.number}`);
    if (!isRecord(admittedIssue) || admittedIssue.pull_request || admittedIssue.state !== "open" || issueVersion(admittedIssue) !== expectedVersion) {
      throw new Error("Lane target changed after admission");
    }
    return fetchAllRecords(github as ReturnType<typeof createDoctorRequester>, `/repos/${target.repository}/issues/${target.number}/comments`, "issue comment");
  };
  const assertActiveBrake = (entries: Record<string, unknown>[]): void => {
    const lastPause = [...entries].reverse().find((entry) => isTrustedDarkFactoryComment(entry) && typeof entry.body === "string" && entry.body.startsWith("<!-- darkfactory:lane-brake pause"));
    const lastResume = [...entries].reverse().find((entry) => isTrustedDarkFactoryComment(entry) && typeof entry.body === "string" && entry.body.startsWith("<!-- darkfactory:lane-brake resume-complete"));
    if (!lastPause || (typeof lastResume?.created_at === "string" && typeof lastPause.created_at === "string" && new Date(lastResume.created_at) >= new Date(lastPause.created_at))) {
      throw new Error("No active owner lane brake is observable for this issue");
    }
  };
  if (command.spec.id === "lane-pause") {
    await runtime.ledger("lane-pause-admission", target.repository, { schemaVersion: 1, target: command.arguments[0], targetVersion: expectedVersion });
    comments = await refreshAfterAdmission();
    const existing = comments.find((entry) => isTrustedDarkFactoryComment(entry) && typeof entry.body === "string" && entry.body.startsWith(pauseMarker));
    // Apply the conservative brake first. If the explanatory comment fails,
    // the lane remains safely blocked and the admission receipt explains why.
    await github.request("POST", `/repos/${target.repository}/issues/${target.number}/labels`, { labels: ["df:blocked"] });
    let comment = existing;
    if (!comment) {
      const created = await github.request("POST", `/repos/${target.repository}/issues/${target.number}/comments`, {
        body: `${pauseMarker}\n## DarkFactory lane paused\n\nThe owner brake is active for this exact issue version. No new worker dispatch is authorized until an explicit resume requests re-evaluation.`
      });
      if (!isRecord(created)) throw new Error("GitHub returned an invalid lane-pause comment");
      comment = created;
    }
    await runtime.ledger("lane-pause-completion", target.repository, { schemaVersion: 1, target: command.arguments[0], targetVersion: expectedVersion, commentId: comment.id ?? null });
    const result = { schemaVersion: 1, target: command.arguments[0], targetVersion: expectedVersion, state: "paused", commentUrl: comment.html_url ?? null };
    if (command.options["--json"] === true) console.log(JSON.stringify(humanJsonResult("lane-pause", "ok", result), null, 2));
    else console.log(`${command.arguments[0]} paused at ${expectedVersion}.`);
    return;
  }
  assertActiveBrake(comments);
  await runtime.ledger("lane-resume-admission", target.repository, { schemaVersion: 1, target: command.arguments[0], targetVersion: expectedVersion, action: "request-reevaluation" });
  comments = await refreshAfterAdmission();
  assertActiveBrake(comments);
  let requestComment = comments.find((entry) => isTrustedDarkFactoryComment(entry) && typeof entry.body === "string" && entry.body.startsWith(resumeRequestMarker));
  if (!requestComment) {
    const created = await github.request("POST", `/repos/${target.repository}/issues/${target.number}/comments`, {
      body: `${resumeRequestMarker}\n## DarkFactory lane resume requested\n\nThe owner authorized re-evaluation of this exact issue version. The brake remains active until dispatch is confirmed.`
    });
    if (!isRecord(created)) throw new Error("GitHub returned an invalid lane-resume comment");
    requestComment = created;
  }
  const dispatch = await dispatchControlWorkflow("df-orchestrate.yml", {
    repo: target.repository,
    issue_number: String(target.number),
    source_event: "cli-lane-resume"
  }, false);
  let completionComment = comments.find((entry) => isTrustedDarkFactoryComment(entry) && typeof entry.body === "string" && entry.body.startsWith(resumeCompleteMarker));
  if (!completionComment) {
    const created = await github.request("POST", `/repos/${target.repository}/issues/${target.number}/comments`, {
      body: `${resumeCompleteMarker}\n## DarkFactory lane resume dispatched\n\nMachine re-evaluation was requested successfully. The CLI did not write \`df:ready\` or bypass any predicate.`
    });
    if (!isRecord(created)) throw new Error("GitHub returned an invalid lane-resume completion comment");
    completionComment = created;
  }
  await runtime.ledger("lane-resume-completion", target.repository, { schemaVersion: 1, target: command.arguments[0], targetVersion: expectedVersion, requestCommentId: requestComment.id ?? null, completionCommentId: completionComment.id ?? null, dispatch });
  const result = { schemaVersion: 1, target: command.arguments[0], targetVersion: expectedVersion, state: "reevaluation-requested", commentUrl: completionComment.html_url ?? null, dispatch };
  if (command.options["--json"] === true) console.log(JSON.stringify(humanJsonResult("lane-resume", "ok", result), null, 2));
  else console.log(`${command.arguments[0]} re-evaluation requested; df:ready was not written by the CLI.`);
}

async function runRunnersStatusCommand(command: ParsedHumanCommand): Promise<void> {
  const repository = validateRepository(command.arguments[0] || `${CONTROL_OWNER}/${CONTROL_REPO}`);
  const github = createDoctorRequester(await createRepositoryOctokit(repository, { administration: "read", actions: "read", contents: "read" }));
  const response = await github.request("GET", `/repos/${repository}/actions/runners?per_page=100`);
  if (!isRecord(response) || !Array.isArray(response.runners)) throw new Error("GitHub returned an invalid runner inventory");
  const runners = response.runners.filter(isRecord).map((runner) => ({
    id: runner.id,
    name: runner.name,
    os: runner.os,
    status: runner.status,
    busy: runner.busy === true,
    labels: Array.isArray(runner.labels) ? runner.labels.map((entry) => isRecord(entry) ? entry.name : null).filter(Boolean) : []
  }));
  const result = { schemaVersion: 1, repository, total: response.total_count, runners, dfLocal: runners.filter((runner) => runner.labels.includes("df-local")) };
  if (command.options["--json"] === true) console.log(JSON.stringify(humanJsonResult("runners-status", "ok", result), null, 2));
  else {
    console.log(`${repository}: ${runners.length} runners (${result.dfLocal.length} df-local).`);
    for (const runner of runners) console.log(`- ${String(runner.name)}: ${String(runner.status)}${runner.busy ? ", busy" : ""} [${runner.labels.join(", ")}]`);
  }
}

async function runLogsCommand(command: ParsedHumanCommand): Promise<void> {
  const target = parseIssueTarget(command.arguments[0]);
  const github = createDoctorRequester(await createRepositoryOctokit(target.repository, { actions: "read", contents: "read" }));
  const [run, jobsResponse] = await Promise.all([
    github.request("GET", `/repos/${target.repository}/actions/runs/${target.number}`),
    github.request("GET", `/repos/${target.repository}/actions/runs/${target.number}/jobs?per_page=100`)
  ]);
  if (!isRecord(run) || !isRecord(jobsResponse) || !Array.isArray(jobsResponse.jobs)) throw new Error("GitHub returned invalid run log evidence");
  const result = {
    schemaVersion: 1,
    repository: target.repository,
    run: { id: run.id, name: run.name, status: run.status, conclusion: run.conclusion, headSha: run.head_sha, url: run.html_url, logsUrl: run.logs_url },
    jobs: jobsResponse.jobs.filter(isRecord).map((job) => ({ id: job.id, name: job.name, status: job.status, conclusion: job.conclusion, url: job.html_url, steps: Array.isArray(job.steps) ? job.steps.map((step) => isRecord(step) ? ({ name: step.name, status: step.status, conclusion: step.conclusion, number: step.number }) : null).filter(Boolean) : [] }))
  };
  if (command.options["--json"] === true) console.log(JSON.stringify(humanJsonResult("logs", "ok", result), null, 2));
  else {
    console.log(`${target.repository} run ${target.number}: ${String(run.status)}/${String(run.conclusion)} ${String(run.html_url || "")}`.trim());
    for (const job of result.jobs) console.log(`- ${String(job.name)}: ${String(job.status)}/${String(job.conclusion)} ${String(job.url || "")}`.trim());
  }
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
  return new Octokit({ auth: await getScopedInstallationToken(app, owner, permissions, repositoryNames) });
}

async function getScopedInstallationToken(
  app: App,
  owner: string,
  permissions: Record<string, "read" | "write">,
  repositoryNames?: string[]
): Promise<string> {
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
  return authentication.token;
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

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2);
  runCli(args).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (args.includes("--json")) {
      console.log(JSON.stringify(humanJsonResult(humanCommandId(args) ?? "unknown", "error", null, { code: "command_failed", message }), null, 2));
    } else {
      console.error(`darkfactory: ${message}`);
    }
    process.exitCode = 1;
  });
}
