#!/usr/bin/env bun
import path from "node:path";
import { cp, mkdir, stat } from "node:fs/promises";
import { adapter, adapterEnv, adapterIds, doctorAdapter, materializeCredentials, type CliId } from "./adapters";
import { readGitmodules, writeGitmodules } from "./gitmodules";
import {
  ensureSharedState,
  readInstalls,
  sharedState,
  writeInstalls,
  type InstallKind,
  type SharedState,
} from "./state";
import {
  readPackageManifest,
  readPackageRegistrations,
  upsertPackageRegistration,
  type AgentsPackageManifest,
} from "./packages";

const root = process.cwd();
const gitmodulesPath = path.join(root, ".gitmodules");
const packageKinds = new Map([
  ["agent", "agents"],
  ["harness", "harnesses"],
  ["cli", "clis"],
  ["private", "private"],
]);

function help(): void {
  console.log(`agents - Bun agent package manager

Usage:
  agents list [--json]
  agents info <name-or-path> [--json]
  agents add <name> <git-url> [--kind agent|cli|private] [--branch main] [--path path]
  agents remove <name-or-path>
  agents sync
  agents state init
  agents state env
  agents cli list|doctor
  agents cli env <codex|claude|kimi|agy>
  agents cli materialize-creds <codex|claude|kimi|agy>
  agents cli exec <codex|claude|kimi|agy> -- <args...>
  agents packages register <path>
  agents packages list [--json]
  agents harness list [--json]
  agents harness doctor <name>
  agents harness run <name> -- <args...>
  agents install <skill|plugin|hook|template|cli|harness> <name> <source-path-or-url>
  agents installs [--json]
  agents credits [--json]
  agents doctor

All runtime data is shared through .agents so every managed CLI sees the same
skills, plugins, CLI metadata, and credit store.`);
}

function parseArgs(args: string[]): { values: string[]; flags: Record<string, string | boolean> } {
  const values: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
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
  if (first === "agents") return "agent";
  if (first === "harnesses") return "harness";
  if (first === "clis") return "cli";
  if (first === "private") return "private";
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
  const kind = String(flags.kind ?? "agent");
  const base = packageKinds.get(kind);
  if (!base) throw new Error(`unsupported package kind: ${kind}`);
  const packagePath = String(flags.path ?? (kind === "private" ? name : path.posix.join(base, name)));
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

async function sync(): Promise<void> {
  await Bun.$`git submodule sync --recursive`;
  await Bun.$`git submodule update --init --recursive`;
}

async function stateCommand(action: string | undefined): Promise<void> {
  const state = sharedState(root);
  await ensureSharedState(state);
  if (!action || action === "init") {
    console.log(`initialized ${path.relative(root, state.stateDir)}`);
    return;
  }
  if (action === "env") {
    console.log(await Bun.file(state.envFile).text());
    return;
  }
  throw new Error(`unknown state action: ${action}`);
}

function printEnv(env: Record<string, string>): void {
  for (const [key, value] of Object.entries(env)) console.log(`${key}=${value}`);
}

async function cliCommand(args: string[]): Promise<void> {
  const [action, rawId, ...rest] = args;
  const state = sharedState(root);
  await ensureSharedState(state);
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
  if (!rawId) throw new Error(`cli ${action} requires an adapter id`);
  const id = rawId as CliId;
  if (action === "env") {
    printEnv(adapterEnv(state, id));
    return;
  }
  if (action === "materialize-creds") {
    const copied = await materializeCredentials(state, id);
    console.log(`materialized ${copied.length} credential file(s) for ${id}`);
    return;
  }
  if (action === "exec") {
    const separator = rest.indexOf("--");
    const execArgs = separator === -1 ? rest : rest.slice(separator + 1);
    await execAdapter(state, id, execArgs);
    return;
  }
  throw new Error(`unknown cli action: ${action}`);
}

async function execAdapter(state: SharedState, id: CliId, args: string[]): Promise<void> {
  const result = await doctorAdapter(state, id);
  if (!result.binary) throw new Error(`cannot execute ${id}: binary not found`);
  const child = Bun.spawn([result.binary, ...args], {
    cwd: root,
    env: { ...process.env, ...adapterEnv(state, id) },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) process.exitCode = code;
}

async function packageCommand(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const [action, packagePath] = args;
  const state = sharedState(root);
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
    console.log(`registered ${packageManifest.kind} ${packageManifest.id}`);
    return;
  }
  throw new Error(`unknown packages action: ${action}`);
}

async function harnessCommand(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const [action = "list", id, ...rest] = args;
  const state = sharedState(root);
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
    env: { ...process.env, ...sharedHarnessEnv(state, harness) },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) process.exitCode = code;
}

function sharedHarnessEnv(state: SharedState, harness: { id: string }): Record<string, string> {
  return {
    AGENTS_HOME: state.stateDir,
    AGENTS_CLIS: state.clisDir,
    AGENTS_SKILLS: state.skillsDir,
    AGENTS_PLUGINS: state.pluginsDir,
    AGENTS_HOOKS: state.hooksDir,
    AGENTS_CREDITS: state.creditsFile,
    ROMMIE_HOME: path.join(state.harnessesDir, harness.id, "runtime"),
  };
}

async function install(values: string[]): Promise<void> {
  const [kind, name, source] = values as [InstallKind | undefined, string | undefined, string | undefined];
  if (!kind || !["skill", "plugin", "hook", "template", "cli", "harness"].includes(kind)) {
    throw new Error("install kind must be skill, plugin, hook, template, cli, or harness");
  }
  if (!name || !source) throw new Error("install requires a name and source");

  const state = sharedState(root);
  await ensureSharedState(state);
  const targetBase =
    kind === "skill"
      ? state.skillsDir
      : kind === "plugin"
        ? state.pluginsDir
        : kind === "hook"
          ? state.hooksDir
          : kind === "template"
            ? state.templatesDir
            : kind === "harness"
              ? state.harnessesDir
              : state.clisDir;
  const target = path.join(targetBase, name);
  if (await exists(target)) throw new Error(`install target already exists: ${target}`);

  if (source.startsWith("http") || source.endsWith(".git")) await Bun.$`git clone ${source} ${target}`;
  else {
    await mkdir(target, { recursive: true });
    await cp(source, target, { recursive: true });
  }

  const installs = await readInstalls(state);
  installs.push({ name, kind, source, path: target, installedAt: new Date().toISOString() });
  await writeInstalls(state, installs);
  const packageManifest = await readPackageManifest(target);
  if (packageManifest) {
    await upsertPackageRegistration(state, {
      id: packageManifest.id,
      kind: packageManifest.kind,
      source,
      path: target,
      manifestPath: path.join(target, "agent.package.json"),
    });
  }
  console.log(`installed ${kind} ${name}`);
}

async function installs(flags: Record<string, string | boolean>): Promise<void> {
  const state = sharedState(root);
  await ensureSharedState(state);
  const records = await readInstalls(state);
  if (flags.json) console.log(JSON.stringify(records, null, 2));
  else for (const record of records) console.log(`${record.kind.padEnd(8)} ${record.name.padEnd(24)} ${record.path}`);
}

async function credits(flags: Record<string, string | boolean>): Promise<void> {
  const state = sharedState(root);
  await ensureSharedState(state);
  const text = await Bun.file(state.creditsFile).text();
  if (flags.json) console.log(text.trim());
  else console.log(`shared credit store: ${path.relative(root, state.creditsFile)}`);
}

async function doctor(): Promise<void> {
  const state = sharedState(root);
  await ensureSharedState(state);
  const missing: string[] = [];
  for (const item of await packages()) {
    if (!item.path) missing.push(`${item.name}: missing path`);
    else if (!(await exists(path.join(root, item.path)))) missing.push(`${item.name}: missing checkout at ${item.path}`);
  }
  for (const file of [state.envFile, state.creditsFile, state.installsFile]) {
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
  if (command === "list") return list(flags);
  if (command === "info") return info(values[0], flags);
  if (command === "add") return add(values, flags);
  if (command === "remove") return remove(values[0]);
  if (command === "sync") return sync();
  if (command === "state") return stateCommand(values[0]);
  if (command === "cli") return cliCommand(rest);
  if (command === "packages") return packageCommand(values, flags);
  if (command === "harness") return harnessCommand(values, flags);
  if (command === "install") return install(values);
  if (command === "installs") return installs(flags);
  if (command === "credits") return credits(flags);
  if (command === "doctor") return doctor();
  throw new Error(`unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`agents: ${error.message}`);
  process.exitCode = 1;
});
