#!/usr/bin/env bun
import path from "node:path";
import { stat } from "node:fs/promises";
import { adapter, adapterEnv, adapterIds, doctorAdapter, pinAdapter, type CliId } from "./adapters";
import { dataRepoManagedRoot, readDataRepos, upsertDataRepo } from "./data-repos";
import { readGitmodules, writeGitmodules } from "./gitmodules";
import { notImplementedPackagesAndEnvironments, readPackagesAndEnvironmentsState } from "./environments";
import {
  ensureSharedState,
  readInstalls,
  readSessionConfig,
  sharedState,
  sharedStateFromEnv,
  updateCreditStore,
  SYSTEM_DATA_REPO_ID,
  type CreditStore,
  type SharedState,
} from "./state";
import { activateIdentityBundle, installCapability, type CapabilityKind } from "./capabilities";
import { canonicalChildEnvironment } from "./runtime-paths";
import {
  readPackageManifest,
  readPackageRegistrations,
  upsertPackageRegistration,
  type AgentsPackageManifest,
} from "./packages";
import { listSecrets, secretPath, syncGitHubSecret, writeSecret } from "./secrets";
import { osCommand } from "./os-lifecycle";
import { runnerCommand } from "./runner-lifecycle";
import { TuiApp, configuredProviderModels } from "./tui";
import { formatToolStatus, readToolStatus, toolStateSpecs } from "./state-consolidation";
import { doctorState, formatStateDoctor } from "./state-doctor";
import { memoryCommand } from "./memory";
import { recordSourceInstall } from "./source-install";
import {
  backupStateRepository,
  inspectStateRepository,
  restoreStateRepository,
  syncStateRepository,
} from "./state-repository";
import {
  disableEventSync,
  enableEventSync,
  eventSyncStatus,
  exportEventBundle,
  importEventBundle,
  recoverPreparedEventImports,
} from "./event-sync";
import {
  createSession,
  describeSession,
  listSessionSummaries,
  listSessions,
  loadSessionState,
  loadTranscript,
  runSessionTurn,
  switchSessionProvider,
  type ProviderAdapter,
  type SessionDescriptor,
  type SessionMode,
} from "../sdk/harness/session";
import { providerSessionAdapter } from "./session-adapters";
import { reconcileDesktopSessions, type DesktopSessionProvider } from "./session-capture";
import {
  installSessionCapture,
  sessionCaptureStatus,
  uninstallSessionCapture,
} from "./session-capture-lifecycle";
import { executeModelRequest } from "./model-execution";
import { modelExecutionRequestFromCli, selectsModelExecution } from "./model-execution-cli";
import {
  MODEL_TIERS,
  formatRouteProbeReport,
  runOrderedRouteProbe,
  type ModelTier,
} from "./route-probe";
import {
  orchestratorSystemPrompt,
  startOrchestratorHeartbeat,
  type OrchestratorHeartbeatController,
} from "./orchestrator";

const invocationRoot = process.cwd();
const root = invocationRoot;
const gitmodulesPath = path.join(root, ".gitmodules");

function systemPromptForMode(mode: SessionMode): string | undefined {
  return mode === "orchestrator" ? orchestratorSystemPrompt() : undefined;
}

async function prepareOrchestratorSession(
  state: SharedState,
  descriptor: SessionDescriptor,
): Promise<OrchestratorHeartbeatController | null> {
  if (descriptor.mode !== "orchestrator") return null;
  return startOrchestratorHeartbeat(state, descriptor.sessionId, {
    provider: descriptor.provider,
    model: descriptor.model,
  });
}
const runModes = new Set<SessionMode>(["orchestrator", "default", "chat", "task"]);
const packageKinds = new Map([
  ["app", "apps"],
  ["data", "data"],
  ["package", "packages"],
  ["template", "templates"],
  ["workspace", "workspaces"],
  ["harness", "packages"],
  ["cli", "packages"],
  ["plugin", "plugins"],
]);

function runtimeState(): SharedState {
  return sharedStateFromEnv(root);
}

function help(): void {
  console.log(`andromeda - Bun agent package manager

Usage:
  andromeda run --model-tier low|medium|high|max --effort low|medium|high --execution-policy read-only|workspace-write --tool-policy standard|none --receipt <absolute-new-path> [--mode orchestrator|default|chat|task] [--prompt-file <absolute-path> | --prompt-stdin | <prompt>]
  andromeda run [--mode orchestrator|default] [--provider <id>] [--model <model>] [--tui] <prompt>
  andromeda route probe [--model-tier low|medium|high|max] [--effort low|medium|high] [--json]
  andromeda tui [--provider <id>] [--model <model>] [--mode <mode>]
  andromeda sessions list [--json]
  andromeda sessions ingest [--provider claude|codex|all] [--json]
  andromeda sessions capture install|status|uninstall [--json]
  andromeda sessions resume <id> <prompt>
  andromeda list [--json]
  andromeda info <name-or-path> [--json]
  andromeda add <name> <git-url> [--kind app|data|package|template|workspace|harness|cli|plugin] [--branch main] [--path path]
  andromeda remove <name-or-path>
  andromeda sync [source]
  andromeda sync enable [--generate-key]
  andromeda sync disable
  andromeda sync status [--json]
  andromeda sync export <bundle-file> [--json]
  andromeda sync import <bundle-file> [--json]
  andromeda sync recover [--json]
  andromeda state init
  andromeda state env
  andromeda state doctor [--json]
  andromeda state record-install
  andromeda state status [--json]
  andromeda state repo-status [--json]
  andromeda state backup [--json]
  andromeda state restore [--json]
  andromeda state sync [--json]
  andromeda memory <remember|list|status|supersede|retract|render> [options]
    mutations require --source <uri> --hash <sha256> --source-class <verified|inferred> --confidence <0..1>
  andromeda identity activate <source-directory> [--replace]
  andromeda cli list|doctor
  andromeda cli pin [codex|claude|kimi|agy|all]
  andromeda cli env <codex|claude|kimi|agy>
  andromeda packages register <path>
  andromeda packages list [--json]
  andromeda packages run <name-or-path> -- <args...>
  andromeda packages distro <define|install|upgrade|remove> ...
  andromeda packages container <define|pull|pin|upgrade|remove> ...
  andromeda env list [--json]
  andromeda env create <id> [--kind host|container|agent-workspace]
  andromeda env switch <id>
  andromeda env sync <id>
  andromeda data repo list [--json]
  andromeda data repo set <id> <owner/name> [--path data/name] [--branch main] [--managed-path path] [--env NAME]
  andromeda data repo path <id>
  andromeda data repo env <id>
  andromeda harness list [--json]
  andromeda harness doctor <name>
  andromeda harness run <name> -- <args...>
  andromeda session run --provider <id> --model <model> [--mode chat|task] [--session <id>] [--stream] <prompt>
  andromeda session list [--json]
  andromeda session show <id> [--json]
  andromeda install <skill|plugin|hook|template|cli|harness> <name> <source-path-or-git-url> [--replace]
  andromeda installs [--json]
  andromeda secrets list [--json]
  andromeda secrets set <NAME> [--from-file path]
  andromeda secrets path <NAME>
  andromeda secrets github sync <NAME> [--as SECRET_NAME] [--repo owner/name | --owner owner] [--dry-run]
  andromeda credits [--json]
  andromeda credits credit <provider> <consumer> <amount> [--note text] [--json]
  andromeda credits debit <provider> <consumer> <amount> [--note text] [--json]
  andromeda credits usage <provider> <consumer> [--amount n] [--tokens-in n] [--tokens-out n] [--note text] [--json]
  andromeda credits provider <provider> [--balance n] [--soft-limit n] [--window-seconds n] [--window-started-at iso] [--json]
  andromeda doctor
  andromeda os doctor [--json]
  andromeda os image list [--json]
  andromeda os image build --image <image> [--channel dev] [--file path] [--context path] [--dry-run]
  andromeda os image pull --image <image> [--channel dev] [--dry-run]
  andromeda os create --name <name> --image <image> [--env andromeda-os] [--channel dev] [--dry-run]
  andromeda os start <name> [--dry-run]
  andromeda os stop <name> [--dry-run]
  andromeda os status <name> [--json]
  andromeda os logs <name> [--follow]
  andromeda os exec <name> -- <args...>
  andromeda os terminal <name> [--shell bash]
  andromeda os remove <name> [--prune-data] [--dry-run]
  andromeda os deploy <profile> [--image andromeda-os] [--env andromeda-os] [--channel dev] [--dry-run]
  andromeda runner install|enable|disable|status|repair [--json]

All runtime data is shared through .agents so every managed CLI sees the same
skills, plugins, CLI metadata, and credit store.`);
}

function parseArgs(args: string[]): { values: string[]; flags: Record<string, string | boolean> } {
  const values: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      values.push(arg, ...args.slice(index + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      values.push(arg);
      continue;
    }
    const [key, inline] = arg.slice(2).split("=", 2);
    if (inline !== undefined) flags[key] = inline;
    else if (args[index + 1] && !args[index + 1].startsWith("--")) flags[key] = args[++index];
    else flags[key] = true;
  }
  return { values, flags };
}

const ROUTE_PROBE_EFFORTS = new Set(["low", "medium", "high"]);

async function routeCommand(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const [action, ...rest] = args;
  if (action !== "probe" || rest.length > 0) throw new Error("usage: andromeda route probe [options]");

  const allowedFlags = new Set(["model-tier", "effort", "json"]);
  if (Object.keys(flags).some((name) => !allowedFlags.has(name))) {
    // Reachability remains an injected-library seam. The CLI cannot safely
    // manufacture a provider executor or fall back to a raw provider command.
    throw new Error("route probe accepts only --model-tier, --effort, and --json");
  }
  if (flags.json !== undefined && flags.json !== true) throw new Error("route probe --json takes no value");

  const requestedTier = flags["model-tier"] ?? "medium";
  const requestedEffort = flags.effort ?? "medium";
  if (typeof requestedTier !== "string") throw new Error("route probe --model-tier requires a value");
  if (typeof requestedEffort !== "string") throw new Error("route probe --effort requires a value");
  if (!(MODEL_TIERS as readonly string[]).includes(requestedTier)) throw new Error("unknown model tier");
  if (!ROUTE_PROBE_EFFORTS.has(requestedEffort)) throw new Error("unknown model effort");

  const tier = requestedTier as ModelTier;
  const state = runtimeState();
  const report = await runOrderedRouteProbe(
    state,
    { tier, effort: requestedEffort, probe: "none" },
    async (doctorState, provider) => (await doctorAdapter(doctorState, provider)).evidence,
  );
  if (flags.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatRouteProbeReport(report));
  if (!report.ok) process.exitCode = 1;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

function inferKind(packagePath: string): string {
  const first = packagePath.split(/[\\/]/)[0];
  const base = path.basename(packagePath);
  if (first === "apps") return "app";
  if (first === "data") return "data";
  if (first === "harnesses") return "harness";
  if (first === "packages") return base.includes("manager") ? "cli" : base.includes("harness") ? "harness" : "package";
  if (first === "plugins") return "plugin";
  if (first === "templates") return "template";
  if (first === "workspaces") return "workspace";
  if (first === "clis") return "cli";
  return "package";
}

async function manifest(packagePath: string): Promise<Record<string, unknown> | null> {
  return (await readPackageManifest(path.join(root, packagePath))) as Record<string, unknown> | null;
}

async function packages() {
  return Promise.all(
    (await readGitmodules(gitmodulesPath)).map(async (mod) => ({
      ...mod,
      kind: inferKind(mod.path ?? mod.name),
      manifest: mod.path ? await manifest(mod.path) : null,
    })),
  );
}

async function list(flags: Record<string, string | boolean>): Promise<void> {
  const loaded = await packages();
  if (flags.json) console.log(JSON.stringify(loaded, null, 2));
  else for (const item of loaded) console.log(`${item.name.padEnd(28)} ${item.kind.padEnd(8)} ${item.path}`);
}

async function info(query: string | undefined, flags: Record<string, string | boolean>): Promise<void> {
  if (!query) throw new Error("info requires a package name or path");
  const item = (await packages()).find((pkg) => {
    const manifestName = typeof pkg.manifest?.name === "string" ? pkg.manifest.name : undefined;
    return pkg.name === query || pkg.path === query || path.basename(pkg.path ?? "") === query || manifestName === query;
  });
  if (!item) throw new Error(`package not found: ${query}`);
  if (flags.json) console.log(JSON.stringify(item, null, 2));
  else {
    console.log(item.name);
    console.log(`  kind:   ${item.kind}`);
    console.log(`  path:   ${item.path}`);
    console.log(`  url:    ${item.url}`);
    console.log(`  branch: ${item.branch ?? "(default)"}`);
  }
}

async function add(values: string[], flags: Record<string, string | boolean>): Promise<void> {
  const [name, url] = values;
  if (!name || !url) throw new Error("add requires a package name and git URL");
  const kind = String(flags.kind ?? "package");
  const base = packageKinds.get(kind);
  if (!base) throw new Error(`unsupported package kind: ${kind}`);
  const packagePath = String(flags.path ?? path.posix.join(base, name));
  const branch = String(flags.branch ?? "main");

  await Bun.$`git submodule add -b ${branch} ${url} ${packagePath}`;
  const modules = await readGitmodules(gitmodulesPath);
  const added = modules.find((mod) => mod.path === packagePath);
  if (added) {
    added.name = packagePath;
    added.branch = branch;
    await writeGitmodules(gitmodulesPath, modules);
  }
  console.log(`added ${packagePath}`);
}

async function remove(query: string | undefined): Promise<void> {
  if (!query) throw new Error("remove requires a package name or path");
  const item = (await packages()).find((pkg) => pkg.name === query || pkg.path === query || path.basename(pkg.path ?? "") === query);
  if (!item?.path) throw new Error(`package not found: ${query}`);
  await Bun.$`git submodule deinit -f -- ${item.path}`;
  await Bun.$`git rm -f ${item.path}`;
  console.log(`removed ${item.path}`);
}

async function syncCommand(values: string[], flags: Record<string, string | boolean>): Promise<void> {
  const action = values[0] ?? "source";
  if (action === "source") {
    await Bun.$`git submodule sync --recursive`;
    await Bun.$`git submodule update --init --recursive`;
    return;
  }
  const state = runtimeState();
  await ensureSharedState(state);
  if (action === "enable") {
    await enableEventSync(state, Boolean(flags["generate-key"]));
    console.log(`event exchange enabled; key remains local at ${secretPath(state, "ANDROMEDA_SYNC_KEY")}`);
    return;
  }
  if (action === "disable") {
    await disableEventSync(state);
    console.log("event exchange disabled");
    return;
  }
  if (action === "status") {
    const status = await eventSyncStatus(state);
    console.log(flags.json ? JSON.stringify(status, null, 2) : Object.entries(status).map(([key, value]) => `${key} ${value}`).join("\n"));
    return;
  }
  if (action === "recover") {
    const results = await recoverPreparedEventImports(state);
    console.log(flags.json ? JSON.stringify(results, null, 2) : `recovered ${results.length} prepared import(s)`);
    return;
  }
  if (action === "export" || action === "import") {
    const bundlePath = values[1];
    if (!bundlePath) throw new Error(`sync ${action} requires a bundle file`);
    const result = action === "export" ? await exportEventBundle(state, bundlePath) : await importEventBundle(state, bundlePath);
    console.log(
      flags.json
        ? JSON.stringify(result, null, 2)
        : `${action} ${result.entries} event(s) ${result.payloadHash}` +
          (action === "export" && result.skippedSessions
            ? `; skipped ${result.skippedSessions} local-only session(s)`
            : ""),
    );
    return;
  }
  throw new Error(`unknown sync action: ${action}`);
}

async function stateCommand(values: string[], flags: Record<string, string | boolean>): Promise<void> {
  const state = runtimeState();
  const action = values[0];
  if (!action || action === "init") {
    await ensureSharedState(state);
    console.log(`initialized ${path.relative(root, state.stateDir)}`);
    return;
  }
  if (action === "env") {
    if (!(await exists(state.envFile))) throw new Error(`state is not initialized: ${state.stateDir}`);
    console.log(await Bun.file(state.envFile).text());
    return;
  }
  if (action === "doctor") {
    const report = await doctorState(state);
    console.log(flags.json ? JSON.stringify(report, null, 2) : formatStateDoctor(report));
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (action === "record-install") {
    await ensureSharedState(state);
    const record = await recordSourceInstall(state);
    console.log(`${record.branch} ${record.commit}`);
    return;
  }
  if (action === "status") {
    const tools = await Promise.all(
      toolStateSpecs.map((spec) => readToolStatus(spec.id, state.userHome, state.stateDir)),
    );
    if (flags.json) {
      console.log(JSON.stringify({ tools }, null, 2));
      return;
    }
    console.log(formatToolStatus(tools));
    return;
  }
  if (action === "repo-status") {
    const status = await inspectStateRepository(state);
    console.log(flags.json ? JSON.stringify(status, null, 2) : Object.entries(status).map(([key, value]) => `${key} ${Array.isArray(value) ? value.join("; ") : value}`).join("\n"));
    if (status.issues.length > 0) process.exitCode = 1;
    return;
  }
  if (action === "backup") {
    const result = await backupStateRepository(state);
    console.log(flags.json ? JSON.stringify(result, null, 2) : `backed up ${result.entries} event(s) to ${result.bundle}`);
    return;
  }
  if (action === "restore") {
    const result = await restoreStateRepository(state);
    console.log(flags.json ? JSON.stringify(result, null, 2) : `restored ${result.imported} event(s) from ${result.bundles} bundle(s)`);
    return;
  }
  if (action === "sync") {
    const result = await syncStateRepository(state);
    console.log(flags.json ? JSON.stringify(result, null, 2) : `synchronized ${result.restored.bundles} bundle(s) and pushed ${result.backup.bundle}`);
    return;
  }
  throw new Error(`unknown state action: ${action}`);
}

function printEnv(env: Record<string, string>): void {
  for (const [key, value] of Object.entries(env)) console.log(`${key}=${value}`);
}

async function cliCommand(args: string[]): Promise<void> {
  const [action, rawId] = args;
  const state = runtimeState();
  if (!action || action === "list") {
    for (const id of adapterIds()) {
      const spec = adapter(id);
      console.log(`${id.padEnd(8)} ${spec.displayName}`);
    }
    return;
  }
  if (action === "doctor") {
    const ids = rawId ? [rawId as CliId] : adapterIds();
    let failed = false;
    for (const id of ids) {
      const result = await doctorAdapter(state, id);
      if (!result.ok) failed = true;
      console.log(`${result.ok ? "ok" : "warn"} ${id} home=${result.home} binary=${result.binary ?? "(missing)"}`);
      for (const note of result.notes) console.log(`  ${note}`);
    }
    if (failed) process.exitCode = 1;
    return;
  }
  if (action === "pin") {
    await ensureSharedState(state);
    const ids = !rawId || rawId === "all" ? adapterIds() : [rawId as CliId];
    for (const id of ids) {
      adapter(id);
      const registration = await pinAdapter(state, id);
      console.log(`${id} ${registration.version} ${registration.executable} sha256=${registration.sha256}`);
    }
    return;
  }
  if (!rawId) throw new Error(`cli ${action} requires an adapter id`);
  const id = rawId as CliId;
  if (action === "env") {
    printEnv(adapterEnv(state, id));
    return;
  }
  throw new Error(`unknown cli action: ${action}`);
}

async function packageCommand(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const [action, packagePath] = args;
  const state = runtimeState();
  await ensureSharedState(state);
  if (!action || action === "list") {
    const registrations = await readPackageRegistrations(state);
    if (flags.json) console.log(JSON.stringify(registrations, null, 2));
    else for (const item of registrations) console.log(`${item.kind.padEnd(8)} ${item.id.padEnd(24)} ${item.path}`);
    return;
  }
  if (action === "register") {
    if (!packagePath) throw new Error("packages register requires a path");
    const fullPath = path.resolve(root, packagePath);
    const packageManifest = await readPackageManifest(fullPath);
    if (!packageManifest) throw new Error(`no package manifest found in ${packagePath}`);
    await upsertPackageRegistration(state, {
      id: packageManifest.id,
      kind: packageManifest.kind,
      path: fullPath,
      manifestPath: path.join(fullPath, "agent.package.json"),
    });
    if (packageManifest.dataRepo) {
      await upsertDataRepo(state, packageManifest.dataRepo);
    }
    console.log(`registered ${packageManifest.kind} ${packageManifest.id}`);
    return;
  }
  if (action === "run") {
    if (!packagePath) throw new Error("packages run requires a package name or path");
    const separator = args.indexOf("--");
    const execArgs = separator === -1 ? args.slice(2) : args.slice(separator + 1);
    const runnable = await findRunnablePackage(state, packagePath);
    if (!runnable) throw new Error(`package not found or missing manifest: ${packagePath}`);
    await runPackage(state, runnable, execArgs);
    return;
  }
  if (action === "distro" || action === "container") {
    throw notImplementedPackagesAndEnvironments(`andromeda packages ${action}`);
  }
  throw new Error(`unknown packages action: ${action}`);
}

async function envCommand(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const [action = "list"] = args;
  const state = runtimeState();
  await ensureSharedState(state);
  const environmentState = await readPackagesAndEnvironmentsState(state);

  if (action === "list") {
    if (flags.json) console.log(JSON.stringify(environmentState.environments, null, 2));
    else for (const item of environmentState.environments) console.log(`${item.kind.padEnd(16)} ${item.id}`);
    return;
  }

  if (action === "create" || action === "switch" || action === "sync") {
    throw notImplementedPackagesAndEnvironments(`andromeda env ${action}`);
  }

  throw new Error(`unknown env action: ${action}`);
}

async function findRunnablePackage(
  state: SharedState,
  query: string,
): Promise<{ id: string; path: string; manifest: AgentsPackageManifest } | null> {
  for (const registration of await readPackageRegistrations(state)) {
    const packageManifest = await readPackageManifest(registration.path);
    if (!packageManifest) continue;
    if (
      registration.id === query ||
      registration.path === query ||
      path.basename(registration.path) === query ||
      packageManifest.name === query
    ) {
      return { id: registration.id, path: registration.path, manifest: packageManifest };
    }
  }

  for (const item of await packages()) {
    if (!item.path) continue;
    const packageManifest = item.manifest as AgentsPackageManifest | null;
    if (!packageManifest) continue;
    if (
      item.name === query ||
      item.path === query ||
      path.basename(item.path) === query ||
      packageManifest.id === query ||
      packageManifest.name === query
    ) {
      return { id: packageManifest.id, path: path.join(root, item.path), manifest: packageManifest };
    }
  }

  return null;
}

async function runPackage(
  state: SharedState,
  item: { id: string; path: string; manifest: AgentsPackageManifest },
  args: string[],
): Promise<void> {
  const entry = item.manifest.entry ?? "";
  if (!entry) throw new Error(`package ${item.id} has no entry command`);
  const command = entry.split(" ").filter(Boolean);
  const cwd = item.manifest.workingDirectory ? path.join(item.path, item.manifest.workingDirectory) : item.path;
  const child = Bun.spawn([...command, ...args], {
    cwd,
    env: { ...canonicalChildEnvironment(), ...sharedPackageEnv(state), ...(await dataRepoEnv(state)) },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) process.exitCode = code;
}

async function harnessCommand(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const [action = "list", id, ...rest] = args;
  const state = runtimeState();
  await ensureSharedState(state);
  const harnesses = await harnessesFromState(state);
  if (action === "list") {
    if (flags.json) console.log(JSON.stringify(harnesses, null, 2));
    else for (const item of harnesses) console.log(`${item.id.padEnd(24)} ${item.path}`);
    return;
  }
  if (!id) throw new Error(`harness ${action} requires a harness id`);
  const harness = harnesses.find((item) => item.id === id);
  if (!harness) throw new Error(`harness not registered: ${id}`);
  if (action === "doctor") {
    await doctorHarness(state, harness);
    return;
  }
  if (action === "run") {
    const separator = rest.indexOf("--");
    const execArgs = separator === -1 ? rest : rest.slice(separator + 1);
    await runHarness(state, harness, execArgs);
    return;
  }
  throw new Error(`unknown harness action: ${action}`);
}

async function sessionCommand(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const [action = "run"] = args;
  const state = runtimeState();
  await ensureSharedState(state);

  if (action === "list") {
    const sessions = await listSessions(state);
    if (flags.json) {
      console.log(JSON.stringify(sessions, null, 2));
      return;
    }
    for (const descriptor of sessions) {
      console.log(`${descriptor.sessionId.padEnd(32)} ${descriptor.provider.padEnd(10)} ${descriptor.model}`);
    }
    return;
  }

  if (action === "show") {
    const sessionId = args[1];
    if (!sessionId) throw new Error("session show requires a session id");
    const sessionState = await loadSessionState(state, sessionId);
    const transcript = await loadTranscript(state, sessionId);
    if (!sessionState || !transcript) throw new Error(`session not found: ${sessionId}`);
    if (flags.json) {
      console.log(JSON.stringify({ state: sessionState, transcript }, null, 2));
      return;
    }
    console.log(describeSession({
      sessionId: sessionState.sessionId,
      provider: sessionState.provider,
      model: sessionState.model,
      mode: sessionState.mode,
      workdir: sessionState.workdir,
      stateDir: state.stateDir,
    }));
    console.log(`turns: ${sessionState.turnCount}`);
    for (const message of transcript.messages) {
      console.log(`\n[${message.role}] ${message.content.slice(0, 200)}${message.content.length > 200 ? "..." : ""}`);
    }
    return;
  }

  if (action === "run") {
    const prompt = args.slice(1).join(" ").trim();
    if (!prompt) throw new Error("session run requires a prompt");

    const provider = typeof flags.provider === "string" ? flags.provider : undefined;
    const model = typeof flags.model === "string" ? flags.model : undefined;
    const sessionId = typeof flags.session === "string" ? flags.session : undefined;
    const mode = (typeof flags.mode === "string" ? flags.mode : "chat") as SessionMode;
    const stream = Boolean(flags.stream);

    if (!sessionId && (!provider || !model)) {
      throw new Error("session run requires --provider and --model, or --session to continue an existing session");
    }

    let descriptor;
    if (sessionId) {
      const existing = await loadSessionState(state, sessionId);
      if (!existing) throw new Error(`session not found: ${sessionId}`);
      if (provider && model) {
        descriptor = await switchSessionProvider(state, sessionId, provider, model);
      } else {
        descriptor = {
          sessionId: existing.sessionId,
          provider: existing.provider,
          model: existing.model,
          mode: existing.mode,
          workdir: existing.workdir,
          stateDir: state.stateDir,
        };
      }
    } else {
      descriptor = await createSession(state, { provider: provider!, model: model!, mode, workdir: root });
    }

    const orchestrator = await prepareOrchestratorSession(state, descriptor);
    const systemPrompt = systemPromptForMode(descriptor.mode);
    try {
      const activeProvider = descriptor.provider;
      const adapter = await managedSessionAdapter(state, activeProvider);

      if (stream && adapter.streamTurn) {
        for await (const chunk of await import("../sdk/harness/session").then((m) => m.streamSessionTurn(state, adapter, descriptor, { prompt, stream, systemPrompt }))) {
          if (chunk.type === "text" && chunk.delta) process.stdout.write(chunk.delta);
          if (chunk.type === "error") console.error(chunk.error);
        }
        console.log();
      } else {
        const result = await runSessionTurn(state, adapter, descriptor, { prompt, systemPrompt });
        if (result.error) {
          console.error(result.error);
          process.exitCode = 1;
        } else {
          console.log(result.content);
        }
      }
      orchestrator?.assertHealthy();
    } finally {
      await orchestrator?.stop();
    }

    console.error(`session: ${descriptor.sessionId}`);
    return;
  }

  throw new Error(`unknown session action: ${action}`);
}

async function resolveSessionDefaults(
  state: SharedState,
  flags: Record<string, string | boolean>,
): Promise<{ provider: string; model: string; mode: SessionMode }> {
  const config = await readSessionConfig(state);
  const provider = typeof flags.provider === "string" ? flags.provider : config.defaultProvider;
  const model = typeof flags.model === "string" ? flags.model : config.defaultModel;
  const modeFlag = typeof flags.mode === "string" ? flags.mode : config.defaultMode;
  const mode = runModes.has(modeFlag as SessionMode) ? (modeFlag as SessionMode) : "default";
  if (!provider || !model) {
    throw new Error("provider and model are required; set defaults in config or use --provider and --model");
  }
  return { provider, model, mode };
}

async function managedSessionAdapter(state: SharedState, provider: string): Promise<ProviderAdapter> {
  if (provider === "fake") return providerSessionAdapter(provider);
  adapter(provider);
  const result = await doctorAdapter(state, provider as CliId);
  if (!result.binary) {
    throw new Error(`provider ${provider} is not ready: ${result.notes.join("; ") || "no verified pinned binary"}`);
  }
  return providerSessionAdapter(provider, result.binary);
}

async function launchTui(
  state: SharedState,
  descriptor: SessionDescriptor,
  systemPrompt?: string,
  orchestrator?: OrchestratorHeartbeatController | null,
): Promise<void> {
  const config = await readSessionConfig(state);
  const { providers, modelsByProvider } = configuredProviderModels(config, descriptor);
  const app = new TuiApp({ state, descriptor, providers, modelsByProvider, systemPrompt, orchestrator });
  await app.start();
  console.error(`session: ${descriptor.sessionId}`);
}

async function tuiCommand(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const state = runtimeState();
  await ensureSharedState(state);
  const { provider, model, mode } = await resolveSessionDefaults(state, flags);
  const descriptor = await createSession(state, { provider, model, mode, workdir: root });
  const orchestrator = await prepareOrchestratorSession(state, descriptor);
  try {
    await launchTui(state, descriptor, systemPromptForMode(mode), orchestrator);
    orchestrator?.assertHealthy();
  } finally {
    await orchestrator?.stop();
  }
}

async function runCommand(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  if (selectsModelExecution(flags)) {
    // Parse and admit the complete logical-tier contract before initializing
    // canonical state. Provider/model/TUI overrides and ambiguous prompt
    // sources therefore fail before any runtime mutation.
    const request = await modelExecutionRequestFromCli({
      values: args,
      flags,
      // ANDROMEDA_ROOT identifies the distribution. Logical-tier authority stays
      // bound to the directory from which the user invoked this process.
      workdir: invocationRoot,
      stdin: process.stdin,
    });
    const state = runtimeState();
    await ensureSharedState(state);
    const result = await executeModelRequest(state, request);
    if (result.ok) console.log(result.content);
    else {
      console.error(`execution blocked: ${result.receipt.blockReason ?? "execution_blocked"}`);
      process.exitCode = 1;
    }
    if (result.sessionId) console.error(`session: ${result.sessionId}`);
    return;
  }

  const prompt = args.join(" ").trim();
  const useTui = Boolean(flags.tui);
  if (!prompt && !useTui) throw new Error("run requires a prompt");

  const state = runtimeState();
  await ensureSharedState(state);
  const { provider, model, mode } = await resolveSessionDefaults(state, flags);

  const descriptor = await createSession(state, { provider, model, mode, workdir: root });
  const orchestrator = await prepareOrchestratorSession(state, descriptor);
  const systemPrompt = systemPromptForMode(mode);
  const executionPolicy = typeof flags["execution-policy"] === "string" ? flags["execution-policy"] as "read-only" | "workspace-write" : undefined;
  const toolPolicy = typeof flags["tool-policy"] === "string" ? flags["tool-policy"] as "standard" | "none" : undefined;

  try {
    if (useTui) {
      if (prompt) {
        const adapter = await managedSessionAdapter(state, descriptor.provider);
        await runSessionTurn(state, adapter, descriptor, { prompt, systemPrompt, executionPolicy, toolPolicy });
      }
      await launchTui(state, descriptor, undefined, orchestrator);
      orchestrator?.assertHealthy();
      return;
    }

    const adapter = await managedSessionAdapter(state, descriptor.provider);
    const result = await runSessionTurn(state, adapter, descriptor, { prompt, systemPrompt, executionPolicy, toolPolicy });

    if (result.error) {
      console.error(result.error);
      process.exitCode = 1;
    } else {
      console.log(result.content);
    }
    orchestrator?.assertHealthy();
  } finally {
    await orchestrator?.stop();
  }
  console.error(`session: ${descriptor.sessionId}`);
}

interface SessionListItem {
  sessionId: string;
  provider: string;
  model: string;
  mode: SessionMode;
  updated: string;
}

async function readSessionListItems(state: SharedState): Promise<SessionListItem[]> {
  return (await listSessionSummaries(state))
    .map((summary) => ({
      sessionId: summary.sessionId,
      provider: summary.provider,
      model: summary.model,
      mode: summary.mode,
      updated: summary.updatedAt,
    }))
    .sort((a, b) => b.updated.localeCompare(a.updated));
}

async function sessionsCommand(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const [action = "list"] = args;
  const state = runtimeState();
  await ensureSharedState(state);

  if (action === "list") {
    const items = await readSessionListItems(state);
    if (flags.json) {
      console.log(JSON.stringify(items, null, 2));
      return;
    }
    for (const item of items) {
      console.log(
        `${item.sessionId.padEnd(32)} ${item.provider.padEnd(10)} ${item.model.padEnd(16)} ${item.mode.padEnd(12)} ${item.updated}`,
      );
    }
    return;
  }

  if (action === "ingest") {
    if (args.length !== 1) throw new Error("usage: andromeda sessions ingest [--provider claude|codex|all] [--json]");
    const allowedFlags = new Set(["provider", "json"]);
    if (Object.keys(flags).some((name) => !allowedFlags.has(name))) {
      throw new Error("sessions ingest accepts only --provider and --json");
    }
    if (flags.json !== undefined && flags.json !== true) throw new Error("sessions ingest --json takes no value");
    const selected = typeof flags.provider === "string" ? flags.provider : "all";
    if (!["claude", "codex", "all"].includes(selected)) {
      throw new Error("sessions ingest --provider must be claude, codex, or all");
    }
    const providers: DesktopSessionProvider[] =
      selected === "all" ? ["claude", "codex"] : [selected as DesktopSessionProvider];
    const report = await reconcileDesktopSessions(state, { providers });
    if (flags.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(
        `sessions: ${report.importedSessions} imported, ${report.existingSessions} existing; ` +
          `messages: ${report.importedMessages} imported, ${report.existingMessages} existing; ` +
          `files: ${report.reconciledFiles} reconciled, ${report.skippedFiles} unchanged, ` +
          `${report.deferredFiles} deferred, ${report.failedFiles} failed`,
      );
      for (const error of report.errors) {
        console.error(`${error.provider} ${error.sourcePath ?? "<root>"}: ${error.message}`);
      }
    }
    if (report.failedFiles > 0) process.exitCode = 1;
    return;
  }

  if (action === "capture") {
    const captureAction = args[1] ?? "status";
    if (args.length > 2 || !["install", "status", "uninstall"].includes(captureAction)) {
      throw new Error("usage: andromeda sessions capture install|status|uninstall [--json]");
    }
    if (Object.keys(flags).some((name) => name !== "json")) {
      throw new Error("sessions capture accepts only --json");
    }
    if (flags.json !== undefined && flags.json !== true) throw new Error("sessions capture --json takes no value");
    const status =
      captureAction === "install"
        ? await installSessionCapture(state)
        : captureAction === "uninstall"
          ? await uninstallSessionCapture(state)
          : await sessionCaptureStatus(state);
    if (flags.json) console.log(JSON.stringify(status, null, 2));
    else {
      console.log(
        `${status.taskName}: ${status.installed ? (status.healthy ? "healthy" : "drifted") : "not installed"} ` +
          `(${status.interval})`,
      );
      for (const issue of status.issues) console.error(issue);
    }
    if (captureAction === "status" && status.supported && !status.healthy) process.exitCode = 1;
    return;
  }

  if (action === "resume") {
    const sessionId = args[1];
    if (!sessionId) throw new Error("sessions resume requires a session id");
    const prompt = args.slice(2).join(" ").trim();
    if (!prompt) throw new Error("sessions resume requires a prompt");

    let descriptor;
    const existing = await loadSessionState(state, sessionId);
    if (!existing) throw new Error(`session not found: ${sessionId}`);

    const provider = typeof flags.provider === "string" ? flags.provider : undefined;
    const model = typeof flags.model === "string" ? flags.model : undefined;
    if (provider && model) {
      descriptor = await switchSessionProvider(state, sessionId, provider, model);
    } else {
      descriptor = {
        sessionId: existing.sessionId,
        provider: existing.provider,
        model: existing.model,
        mode: existing.mode,
        workdir: existing.workdir,
        stateDir: state.stateDir,
      };
    }

    const orchestrator = await prepareOrchestratorSession(state, descriptor);
    const systemPrompt = systemPromptForMode(descriptor.mode);

    try {
      const adapter = await managedSessionAdapter(state, descriptor.provider);
      const result = await runSessionTurn(state, adapter, descriptor, { prompt, systemPrompt });
      if (result.error) {
        console.error(result.error);
        process.exitCode = 1;
      } else {
        console.log(result.content);
      }
      orchestrator?.assertHealthy();
    } finally {
      await orchestrator?.stop();
    }
    console.error(`session: ${descriptor.sessionId}`);
    return;
  }

  throw new Error(`unknown sessions action: ${action}`);
}

async function harnessesFromState(state: SharedState): Promise<Array<{ id: string; path: string; manifest: AgentsPackageManifest }>> {
  const registrations = await readPackageRegistrations(state);
  const out: Array<{ id: string; path: string; manifest: AgentsPackageManifest }> = [];
  for (const registration of registrations.filter((item) => item.kind === "harness")) {
    const packageManifest = await readPackageManifest(registration.path);
    if (packageManifest) out.push({ id: registration.id, path: registration.path, manifest: packageManifest });
  }
  return out;
}

async function doctorHarness(state: SharedState, harness: { id: string; path: string; manifest: AgentsPackageManifest }): Promise<void> {
  const missing: string[] = [];
  if (!(await exists(harness.path))) missing.push(`missing harness path: ${harness.path}`);
  for (const cli of harness.manifest.requires?.clis ?? []) {
    const result = await doctorAdapter(state, cli as CliId);
    if (!result.ok) missing.push(`${cli}: ${result.notes.join("; ") || "adapter not ready"}`);
  }
  if (missing.length > 0) {
    console.error(missing.join("\n"));
    process.exitCode = 1;
  } else console.log(`ok ${harness.id}`);
}

async function runHarness(
  state: SharedState,
  harness: { id: string; path: string; manifest: AgentsPackageManifest },
  args: string[],
): Promise<void> {
  const entry = harness.manifest.entry ?? "";
  if (!entry) throw new Error(`harness ${harness.id} has no entry command`);
  const command = entry.split(" ").filter(Boolean);
  const cwd = harness.manifest.workingDirectory ? path.join(harness.path, harness.manifest.workingDirectory) : harness.path;
  const child = Bun.spawn([...command, ...args], {
    cwd,
    env: { ...canonicalChildEnvironment(), ...sharedHarnessEnv(state, harness), ...(await dataRepoEnv(state)) },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) process.exitCode = code;
}

function sharedHarnessEnv(state: SharedState, harness: { id: string }): Record<string, string> {
  return {
    ANDROMEDA_BIN: process.execPath,
    ANDROMEDA_BIN_SCRIPT: Bun.argv[1] ? path.resolve(Bun.argv[1]) : "",
    ANDROMEDA_HOME: state.stateDir,
    ANDROMEDA_ROOT: state.root,
    ANDROMEDA_WORKSPACE: state.workspaceDir,
    ANDROMEDA_CLIS: state.clisDir,
    ANDROMEDA_HARNESSES: state.harnessesDir,
    ANDROMEDA_SKILLS: state.skillsDir,
    ANDROMEDA_PLUGINS: state.pluginsDir,
    ANDROMEDA_HOOKS: state.hooksDir,
    ANDROMEDA_TEMPLATES: state.templatesDir,
    ANDROMEDA_SECRETS: state.secretsDir,
    ANDROMEDA_ORCHESTRATOR: state.orchestratorDir,
    ANDROMEDA_CREDITS: state.creditsFile,
    ANDROMEDA_DATA_REPOS: state.dataReposFile,
    ANDROMEDA_ENVIRONMENTS: state.environmentsFile,
    ANDROMEDA_HARNESS_HOME: path.join(state.harnessesDir, harness.id, "runtime"),
  };
}

function sharedPackageEnv(state: SharedState): Record<string, string> {
  return {
    ANDROMEDA_BIN: process.execPath,
    ANDROMEDA_BIN_SCRIPT: Bun.argv[1] ? path.resolve(Bun.argv[1]) : "",
    ANDROMEDA_HOME: state.stateDir,
    ANDROMEDA_ROOT: state.root,
    ANDROMEDA_WORKSPACE: state.workspaceDir,
    ANDROMEDA_CLIS: state.clisDir,
    ANDROMEDA_HARNESSES: state.harnessesDir,
    ANDROMEDA_SKILLS: state.skillsDir,
    ANDROMEDA_PLUGINS: state.pluginsDir,
    ANDROMEDA_HOOKS: state.hooksDir,
    ANDROMEDA_TEMPLATES: state.templatesDir,
    ANDROMEDA_SECRETS: state.secretsDir,
    ANDROMEDA_ORCHESTRATOR: state.orchestratorDir,
    ANDROMEDA_CREDITS: state.creditsFile,
    ANDROMEDA_DATA_REPOS: state.dataReposFile,
    ANDROMEDA_ENVIRONMENTS: state.environmentsFile,
  };
}

async function dataRepoEnv(state: SharedState): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const repo of await readDataRepos(state)) {
    const key = repo.env ?? `${repo.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_ROOT`;
    env[key] = dataRepoManagedRoot(repo);
  }
  return env;
}

async function dataCommand(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const [kind = "repo", action = "list", id, repo] = args;
  if (kind !== "repo") throw new Error(`unknown data kind: ${kind}`);
  const state = runtimeState();
  await ensureSharedState(state);

  if (action === "list") {
    const repos = await readDataRepos(state);
    if (flags.json) console.log(JSON.stringify(repos, null, 2));
    else for (const item of repos) console.log(`${item.id.padEnd(24)} ${item.repo.padEnd(32)} ${item.path}`);
    return;
  }

  if (action === "set") {
    if (!id || !repo) throw new Error("data repo set requires an id and owner/name repo");
    const registration = await upsertDataRepo(state, {
      id,
      repo,
      path: String(flags.path ?? (id === SYSTEM_DATA_REPO_ID ? state.stateDir : path.join("data", id))),
      branch: typeof flags.branch === "string" ? flags.branch : "main",
      managedPath: typeof flags["managed-path"] === "string" ? flags["managed-path"] : undefined,
      env: typeof flags.env === "string" ? flags.env : undefined,
    });
    console.log(`configured data repo ${registration.id} -> ${registration.repo}`);
    return;
  }

  if (action === "path") {
    if (!id) throw new Error("data repo path requires an id");
    const repoInfo = (await readDataRepos(state)).find((item) => item.id === id);
    if (!repoInfo) throw new Error(`data repo not configured: ${id}`);
    console.log(dataRepoManagedRoot(repoInfo));
    return;
  }

  if (action === "env") {
    if (!id) throw new Error("data repo env requires an id");
    const repoInfo = (await readDataRepos(state)).find((item) => item.id === id);
    if (!repoInfo) throw new Error(`data repo not configured: ${id}`);
    const key = repoInfo.env ?? `${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_ROOT`;
    console.log(`${key}=${dataRepoManagedRoot(repoInfo)}`);
    return;
  }

  throw new Error(`unknown data repo action: ${action}`);
}

async function install(values: string[], flags: Record<string, string | boolean>): Promise<void> {
  const [kind, name, source] = values as [CapabilityKind | undefined, string | undefined, string | undefined];
  if (!kind || !["skill", "plugin", "hook", "template", "cli", "harness"].includes(kind)) {
    throw new Error("install kind must be skill, plugin, hook, template, cli, or harness");
  }
  if (!name || !source) throw new Error("install requires a name and source");

  const state = runtimeState();
  await ensureSharedState(state);
  const result = await installCapability(state, { kind, name, source, replace: Boolean(flags.replace) });
  const action = result.changed ? (result.replaced ? "replaced" : "installed") : "verified";
  console.log(`${action} ${kind} ${name} sha256=${result.record.sha256}`);
}

async function installs(flags: Record<string, string | boolean>): Promise<void> {
  const state = runtimeState();
  await ensureSharedState(state);
  const records = await readInstalls(state);
  if (flags.json) console.log(JSON.stringify(records, null, 2));
  else for (const record of records) console.log(`${record.kind.padEnd(8)} ${record.name.padEnd(24)} ${record.path}`);
}

async function identityCommand(values: string[], flags: Record<string, string | boolean>): Promise<void> {
  const [action, source] = values;
  if (action !== "activate") throw new Error(`unknown identity action: ${action ?? "(missing)"}`);
  if (!source) throw new Error("identity activate requires a source directory");
  const state = runtimeState();
  await ensureSharedState(state);
  const result = await activateIdentityBundle(state, source, { replace: Boolean(flags.replace) });
  console.log(`${result.changed ? "activated" : "verified"} identity rommie sha256=${result.sha256}`);
}

function requireCreditId(kind: string, value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error(`invalid ${kind}: ${value ?? "(missing)"}`);
  return value;
}

function parsePositiveNumber(name: string, value: string | boolean | undefined): number {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} requires a positive number`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} requires a positive number`);
  return parsed;
}

function parseNonNegativeInteger(name: string, value: string | boolean | undefined): number {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} requires a non-negative integer`);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} requires a non-negative integer`);
  return parsed;
}

function optionalPositiveNumber(name: string, value: string | boolean | undefined): number | undefined {
  return value === undefined ? undefined : parsePositiveNumber(name, value);
}

function optionalNonNegativeInteger(name: string, value: string | boolean | undefined): number | undefined {
  return value === undefined ? undefined : parseNonNegativeInteger(name, value);
}

function noteFlag(flags: Record<string, string | boolean>): string | undefined {
  return typeof flags.note === "string" && flags.note.trim() ? flags.note : undefined;
}

function ensureProvider(store: CreditStore, provider: string): NonNullable<CreditStore["providers"][string]> {
  store.providers[provider] ??= {};
  return store.providers[provider];
}

async function credits(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const state = runtimeState();
  await ensureSharedState(state);
  const [action, rawProvider, rawConsumer, rawAmount] = args;
  if (!action) {
    const text = await Bun.file(state.creditsFile).text();
    if (flags.json) console.log(text.trim());
    else console.log(`shared credit store: ${path.relative(root, state.creditsFile)}`);
    return;
  }

  const now = new Date().toISOString();
  const provider = requireCreditId("provider", rawProvider);

  if (action === "provider") {
    const balance = optionalPositiveNumber("balance", flags.balance);
    const softLimit = optionalPositiveNumber("soft-limit", flags["soft-limit"]);
    const windowSeconds = optionalNonNegativeInteger("window-seconds", flags["window-seconds"]);
    const windowStartedAt = typeof flags["window-started-at"] === "string" ? flags["window-started-at"] : undefined;
    if (windowStartedAt !== undefined && (!Number.isFinite(Date.parse(windowStartedAt)) || new Date(windowStartedAt).toISOString() !== windowStartedAt)) {
      throw new Error("window-started-at must be a normalized ISO timestamp");
    }
    const store = await updateCreditStore(state, (current) => {
      const record = ensureProvider(current, provider);
      if (balance !== undefined) record.balance = balance;
      if (softLimit !== undefined) record.softLimit = softLimit;
      if (windowSeconds !== undefined) record.windowSeconds = windowSeconds;
      if (windowStartedAt !== undefined) record.windowStartedAt = windowStartedAt;
      current.updatedAt = now;
      return structuredClone(current);
    });
    if (flags.json) console.log(JSON.stringify(store, null, 2));
    else console.log(`updated provider ${provider}`);
    return;
  }

  const consumer = requireCreditId("consumer", rawConsumer);
  const amount = action === "credit" || action === "debit"
    ? parsePositiveNumber("amount", rawAmount)
    : optionalPositiveNumber("amount", flags.amount);
  const tokensIn = action === "usage" ? optionalNonNegativeInteger("tokens-in", flags["tokens-in"]) : undefined;
  const tokensOut = action === "usage" ? optionalNonNegativeInteger("tokens-out", flags["tokens-out"]) : undefined;
  if (action === "usage" && amount === undefined && tokensIn === undefined && tokensOut === undefined) {
    throw new Error("usage requires --amount, --tokens-in, or --tokens-out");
  }
  if (action !== "credit" && action !== "debit" && action !== "usage") {
    throw new Error(`unknown credits action: ${action}`);
  }
  const store = await updateCreditStore(state, (current) => {
    const providerRecord = ensureProvider(current, provider);
    if (action === "credit" || action === "debit") {
      const sign = action === "credit" ? 1 : -1;
      current.balances[consumer] = (current.balances[consumer] ?? 0) + sign * (amount as number);
      providerRecord.balance = (providerRecord.balance ?? 0) - sign * (amount as number);
      current.ledger.push({ provider, consumer, action, amount, at: now, note: noteFlag(flags) });
    } else {
      providerRecord.requests = (providerRecord.requests ?? 0) + 1;
      providerRecord.tokensIn = (providerRecord.tokensIn ?? 0) + (tokensIn ?? 0);
      providerRecord.tokensOut = (providerRecord.tokensOut ?? 0) + (tokensOut ?? 0);
      if (amount !== undefined) {
        current.balances[consumer] = (current.balances[consumer] ?? 0) - amount;
        providerRecord.balance = (providerRecord.balance ?? 0) - amount;
      }
      current.ledger.push({ provider, consumer, action, amount, tokensIn, tokensOut, at: now, note: noteFlag(flags) });
    }
    current.updatedAt = now;
    return structuredClone(current);
  });
  if (flags.json) console.log(JSON.stringify(store, null, 2));
  else console.log(`recorded ${action} for ${consumer} on ${provider}`);
}

async function secretsCommand(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const [action = "list", name, ...rest] = args;
  const state = runtimeState();
  await ensureSharedState(state);

  if (action === "list") {
    const names = await listSecrets(state);
    if (flags.json) console.log(JSON.stringify(names, null, 2));
    else for (const item of names) console.log(item);
    return;
  }

  if (action === "set") {
    if (!name) throw new Error("secrets set requires a name");
    const fromFile = typeof flags["from-file"] === "string" ? flags["from-file"] : undefined;
    const value = fromFile ? await Bun.file(fromFile).text() : await new Response(Bun.stdin.stream()).text();
    await writeSecret(state, name, value);
    console.log(`stored secret ${name}`);
    return;
  }

  if (action === "path") {
    if (!name) throw new Error("secrets path requires a name");
    console.log(secretPath(state, name));
    return;
  }

  if (action === "github") {
    const [githubAction, secretName] = [name, rest[0]];
    if (githubAction !== "sync") throw new Error(`unknown secrets github action: ${githubAction ?? "(missing)"}`);
    if (!secretName) throw new Error("secrets github sync requires a secret name");
    const results = await syncGitHubSecret(state, {
      name: secretName,
      targetName: typeof flags.as === "string" ? flags.as : undefined,
      owner: typeof flags.owner === "string" ? flags.owner : undefined,
      repo: typeof flags.repo === "string" ? flags.repo : undefined,
      includeArchived: Boolean(flags["include-archived"]),
      dryRun: Boolean(flags["dry-run"]),
    });
    for (const result of results) console.log(`${result.status} ${result.repo} ${result.targetName}`);
    return;
  }

  throw new Error(`unknown secrets action: ${action}`);
}

async function doctor(): Promise<void> {
  const state = runtimeState();
  await ensureSharedState(state);
  const missing: string[] = [];
  for (const item of await packages()) {
    if (!item.path) missing.push(`${item.name}: missing path`);
    else if (!(await exists(path.join(root, item.path)))) missing.push(`${item.name}: missing checkout at ${item.path}`);
  }
  for (const file of [state.envFile, state.creditsFile, state.installsFile, state.dataReposFile, state.environmentsFile]) {
    if (!(await exists(file))) missing.push(`missing shared state file: ${file}`);
  }
  if (missing.length > 0) {
    console.error(missing.join("\n"));
    process.exitCode = 1;
  } else console.log("ok");
}

async function main(): Promise<void> {
  const [command = "help", ...rest] = Bun.argv.slice(2);
  const { values, flags } = parseArgs(rest);
  if (command === "help" || flags.help) return help();
  if (command === "run") return runCommand(values, flags);
  if (command === "route") return routeCommand(values, flags);
  if (command === "tui") return tuiCommand(values, flags);
  if (command === "sessions") return sessionsCommand(values, flags);
  if (command === "list") return list(flags);
  if (command === "info") return info(values[0], flags);
  if (command === "add") return add(values, flags);
  if (command === "remove") return remove(values[0]);
  if (command === "sync") return syncCommand(values, flags);
  if (command === "state") return stateCommand(values, flags);
  if (command === "memory") return memoryCommand(runtimeState(), values, flags);
  if (command === "identity") return identityCommand(values, flags);
  if (command === "cli") return cliCommand(rest);
  if (command === "packages") return packageCommand(values, flags);
  if (command === "env") return envCommand(values, flags);
  if (command === "data") return dataCommand(values, flags);
  if (command === "harness") return harnessCommand(values, flags);
  if (command === "session") return sessionCommand(values, flags);
  if (command === "install") return install(values, flags);
  if (command === "installs") return installs(flags);
  if (command === "secrets") return secretsCommand(values, flags);
  if (command === "credits") return credits(values, flags);
  if (command === "doctor") return doctor();
  if (command === "os") return osCommand(rest);
  if (command === "runner") return runnerCommand(rest);
  throw new Error(`unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`andromeda: ${error.message}`);
  process.exitCode = 1;
});
