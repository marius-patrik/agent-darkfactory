import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const uv = process.env.UV || "uv";

const checks = [
  {
    name: "Python lint",
    cwd: "python-agent",
    command: uv,
    args: ["run", "ruff", "check", "agent", "tests"],
  },
  {
    name: "Python types",
    cwd: "python-agent",
    command: uv,
    args: ["run", "mypy", "agent"],
  },
  {
    name: "Python tests",
    cwd: "python-agent",
    command: uv,
    args: ["run", "pytest", "-q", "-m", "not live"],
  },
  {
    name: "Python package build",
    cwd: "python-agent",
    command: uv,
    args: ["build"],
  },
  {
    name: "Python package CLI",
    cwd: "python-agent",
    command: uv,
    args: ["run", "agent-os-inference", "--help"],
  },
  {
    name: "generated protocol imports",
    cwd: "python-agent",
    command: uv,
    args: [
      "run",
      "python",
      "-c",
      "import agent.gen; from agent_os.v1 import common_pb2",
    ],
  },
  {
    name: "layering",
    cwd: ".",
    command: uv,
    args: ["run", "--project", "python-agent", "python", "scripts/check_layering.py"],
  },
  {
    name: "layering regression fixtures",
    cwd: ".",
    command: uv,
    args: ["run", "--project", "python-agent", "python", "tests/layering/check_planted_violations.py"],
  },
];

for (const check of checks) {
  console.log(`\n==> ${check.name}`);
  const result = spawnSync(check.command, check.args, {
    cwd: join(root, check.cwd),
    stdio: "inherit",
    shell: false,
  });
  if (result.error) {
    console.error(`${check.name} failed to start: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`${check.name} failed with exit code ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

console.log("\nAgent OS inference validation passed");
