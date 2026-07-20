#!/usr/bin/env node
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "packages", "migrate", "manager", "src", "cli.ts");
const sandbox = mkdtempSync(path.join(tmpdir(), "andromeda-sync-smoke-"));
const keyFile = path.join(sandbox, "shared-sync-key");
const key = "7b".repeat(32);
const evidenceHash = "a".repeat(64);

function machine(name) {
  const userHome = path.join(sandbox, name, "user");
  const stateHome = path.join(userHome, ".agents");
  mkdirSync(userHome, { recursive: true });
  return {
    name,
    env: {
      ...process.env,
      AGENTS_HOME: stateHome,
      AGENTS_USER_HOME: userHome,
      AGENTS_ROOT: root,
    },
  };
}

function run(instance, args, { json = false } = {}) {
  const result = spawnSync("bun", [cli, ...args], {
    cwd: root,
    env: instance.env,
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`${instance.name}: agents ${args.join(" ")} failed\n${result.stdout}${result.stderr}`);
  }
  return json ? JSON.parse(result.stdout) : result.stdout;
}

function initialize(instance) {
  run(instance, ["state", "init"]);
  run(instance, ["secrets", "set", "AGENTS_SYNC_KEY", "--from-file", keyFile]);
  run(instance, ["sync", "enable"]);
}

function remember(instance, predicate, value) {
  run(instance, [
    "memory",
    "remember",
    "--scope",
    "project",
    "--subject",
    "Andromeda CI",
    "--predicate",
    predicate,
    "--value",
    value,
    "--source",
    "test://ci/encrypted-sync",
    "--hash",
    evidenceHash,
    "--source-class",
    "verified",
    "--confidence",
    "1",
    "--json",
  ], { json: true });
}

const source = machine("source");
const target = machine("target");

try {
  writeFileSync(keyFile, key, { mode: 0o600 });
  initialize(source);
  initialize(target);

  remember(source, "forward", "verified");
  const forwardBundle = path.join(sandbox, "forward.bundle.json");
  const forwardExport = run(source, ["sync", "export", forwardBundle, "--json"], { json: true });
  const forwardImport = run(target, ["sync", "import", forwardBundle, "--json"], { json: true });
  if (forwardImport.projectionHash !== forwardExport.projectionHash || forwardImport.imported < 1) {
    throw new Error("forward encrypted event exchange did not preserve the projection hash");
  }
  const replay = run(target, ["sync", "import", forwardBundle, "--json"], { json: true });
  if (!replay.idempotent || replay.imported !== 0) throw new Error("replayed encrypted bundle was not idempotent");

  remember(target, "reverse", "verified");
  const reverseBundle = path.join(sandbox, "reverse.bundle.json");
  const reverseExport = run(target, ["sync", "export", reverseBundle, "--json"], { json: true });
  const reverseImport = run(source, ["sync", "import", reverseBundle, "--json"], { json: true });
  if (reverseImport.projectionHash !== reverseExport.projectionHash || reverseImport.imported < 1) {
    throw new Error("reverse encrypted event exchange did not preserve the projection hash");
  }

  const sourceStatus = run(source, ["memory", "status", "--json"], { json: true });
  const targetStatus = run(target, ["memory", "status", "--json"], { json: true });
  if (sourceStatus.projectionHash !== targetStatus.projectionHash) {
    throw new Error("round-trip memory projections do not have the same parity digest");
  }
  console.log(`Encrypted event-exchange round trip passed at ${sourceStatus.projectionHash}.`);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
