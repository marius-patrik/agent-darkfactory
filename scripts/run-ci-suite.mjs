#!/usr/bin/env node
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function discoverBunTests(relativeDirectory, repositoryRoot = root) {
  const files = [];
  const visit = (relative) => {
    for (const entry of readdirSync(path.join(repositoryRoot, relative), { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (/\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/.test(entry.name)) files.push(child);
    }
  };
  visit(relativeDirectory);
  return files.sort();
}

function managerTests() {
  return discoverBunTests(path.join("packages", "migrate", "manager", "test"));
}

function harnessTests() {
  return [
    ...discoverBunTests(path.join("packages", "migrate", "harness", "test")),
    path.join("packages", "migrate", "manager", "test", "session.test.ts"),
    path.join("packages", "migrate", "manager", "test", "session-adapters.test.ts"),
    path.join("packages", "migrate", "manager", "test", "tui-tools.test.ts"),
  ];
}

function run(label, command, args, options = {}) {
  console.log(`\n==> ${label}`);
  console.log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status ?? "unknown"}`);
  }
}

function runNpm(label, args, cwd) {
  if (process.platform === "win32") {
    run(label, process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `npm ${args.join(" ")}`], { cwd });
    return;
  }
  run(label, "npm", args, { cwd });
}

function requireUv() {
  run("uv availability", process.env.UV || "uv", ["--version"]);
}

function runGatewayPytest(marker) {
  requireUv();
  const uv = process.env.UV || "uv";
  const cwd = path.join(root, "packages", "migrate", "gateway");
  run("gateway dependency sync", uv, ["sync", "--frozen"], { cwd });
  run(`gateway pytest (${marker})`, uv, ["run", "pytest", "-q", "-m", marker], { cwd });
}

export const CI_SUITE_NAMES = Object.freeze([
  "inventory",
  "core",
  "gateway",
  "gateway-real",
  "engine-real",
  "harness",
  "inference",
  "manager",
  "memory-plugin",
  "release",
  "sync",
  "review",
]);

export function managerTestTimeoutMs(platform = process.platform) {
  return platform === "win32" ? 90_000 : 30_000;
}

const suites = {
  inventory() {
    run("product contract regression tests", process.execPath, [
      "--test",
      "scripts/verify-single-product.test.mjs",
      "scripts/verify-test-inventory.test.mjs",
    ]);
    run("repository layout and suite inventory", "bun", ["run", "layout:check"]);
  },
  core() {
    run("core TypeScript types", "bun", ["./node_modules/typescript/bin/tsc", "--noEmit", "-p", "packages/migrate/core/tsconfig.json"]);
    run("core TypeScript import smoke", "bun", ["packages/migrate/core/tests/ts-import-smoke.ts"]);
    run("core TypeScript tests", "bun", ["test", ...discoverBunTests(path.join("packages", "migrate", "core", "tests"))]);
    run("generated contract freshness", "bun", ["scripts/verify-codegen.ts"]);
    run("core Python import smoke", "bun", ["packages/migrate/core/scripts/python-smoke.mjs"]);
    run("core Go contracts", "go", ["test", "./..."], {
      cwd: path.join(root, "packages", "migrate", "core", "contracts-go"),
    });
  },
  gateway() {
    requireUv();
    const uv = process.env.UV || "uv";
    const cwd = path.join(root, "packages", "migrate", "gateway");
    const sandbox = mkdtempSync(path.join(tmpdir(), "andromeda-gateway-ci-"));
    const userHome = path.join(sandbox, "user");
    const stateHome = path.join(userHome, ".agents");
    mkdirSync(stateHome, { recursive: true });
    const env = {
      ...process.env,
      AGENTS_HOME: stateHome,
      AGENTS_USER_HOME: userHome,
      AGENTS_ROOT: root,
    };
    try {
      run("gateway dependency sync", uv, ["sync", "--frozen"], { cwd, env });
      run("gateway lint", uv, ["run", "ruff", "check", "llm_gateway", "tests", "scripts"], { cwd, env });
      run("gateway types", uv, ["run", "mypy", "llm_gateway"], { cwd, env });
      run("gateway tests", uv, ["run", "pytest", "-q", "-m", "not live"], { cwd, env });
      run("gateway packaging smoke", uv, ["run", "python", "scripts/packaging_smoke.py"], { cwd, env });
      run("gateway build", uv, ["build"], { cwd, env });
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  },
  "gateway-real"() {
    runGatewayPytest("gateway_process");
  },
  "engine-real"() {
    runGatewayPytest("engine_routing");
  },
  harness() {
    run("harness direct and manager-coupled behavior", "bun", ["test", ...harnessTests()]);
  },
  inference() {
    requireUv();
    const uv = process.env.UV || "uv";
    const cwd = path.join(root, "packages", "migrate", "inference", "python-agent");
    run("inference dependency sync", uv, ["sync", "--frozen"], { cwd });
    run("inference validation", "bun", ["packages/migrate/inference/scripts/validate.mjs"]);
  },
  manager() {
    run("manager types", "bun", ["./node_modules/typescript/bin/tsc", "--noEmit"]);
    // Manager fixtures exercise real filesystem locks and temporarily mutate
    // process-wide Git/environment state. Keep them serialized so a slow
    // hosted runner cannot let timed-out cleanup contaminate the next fixture.
    run("manager tests", "bun", ["test", `--timeout=${managerTestTimeoutMs()}`, "--max-concurrency=1", ...managerTests()]);
    run("compact capsule authority", "pwsh", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "packages/mcp/migrate/skills/compact/scripts/test_write_compaction_capsule.ps1",
    ]);
  },
  "memory-plugin"() {
    run("memory plugin types", "bun", ["./node_modules/typescript/bin/tsc", "--noEmit", "-p", "packages/migrate/memory/tsconfig.json"]);
    run("memory plugin tests", "bun", [
      "test",
      "--timeout=30000",
      "--max-concurrency=1",
      ...discoverBunTests(path.join("plugins", "memory", "test")),
    ]);
  },
  release() {
    run("installer and release smoke", "bun", ["scripts/run-release-smoke.mjs"]);
  },
  sync() {
    run("encrypted event-exchange smoke", "bun", ["scripts/run-sync-smoke.mjs"]);
  },
  review() {
    run("review workflow regressions", process.execPath, [
      "--test",
      ".github/scripts/managed-enforcement.test.mjs",
    ]);
  },
};

export function runCiSuite(name) {
  const suite = suites[name];
  if (!suite) throw new Error(`unknown CI suite ${JSON.stringify(name)}; expected one of ${CI_SUITE_NAMES.join(", ")}`);
  suite();
  console.log(`\nCI suite ${name} passed.`);
}

function main() {
  const requested = process.argv[2] ?? "all";
  const names = requested === "all" ? CI_SUITE_NAMES : [requested];
  for (const name of names) runCiSuite(name);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
