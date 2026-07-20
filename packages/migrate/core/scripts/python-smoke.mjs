#!/usr/bin/env node
/**
 * Generate Python protobuf stubs to a temp directory and run a consumer-style
 * import smoke test (`tests/python-import-smoke.py`).
 *
 * This proves that the generated Python stubs are importable by the intended
 * consumer pattern used by the in-repository inference Python agent:
 *
 *   import agent.gen
 *   from agent_os.v1 import session_frames_pb2, registry_pb2
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = dirname(__dirname);

function run(label, cmd, args, options = {}) {
  console.log(`$ ${label}: ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, {
    stdio: "inherit",
    shell: false,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed with exit code ${result.status}`,
    );
  }
}

function findPython() {
  for (const candidate of ["python3.14", "python3.13", "python3.12", "python3", "python"]) {
    const result = spawnSync(candidate, ["-c", "import sys; assert sys.version_info >= (3, 12); print(sys.executable)"], {
      shell: false,
      encoding: "utf8",
    });
    if (result.status === 0 && result.stdout.trim()) {
      return candidate;
    }
  }
  throw new Error(
    "Python 3.12 or newer is required for the generated Agent OS contract smoke test.",
  );
}

const pythonCmd = findPython();
const tmp = await mkdtemp(join(tmpdir(), "agent-os-core-py-smoke-"));

try {
  // Generate Python stubs into the temp directory using the smoke template.
  run(
    "buf python smoke generate",
    "bun",
    [
      "x",
      "--bun",
      "@bufbuild/buf",
      "generate",
      "proto",
      "--template",
      join(repoRoot, "buf.gen.python.smoke.yaml"),
      "-o",
      tmp,
    ],
    { cwd: repoRoot },
  );

  // Replicate the intended consumer layout: agent/gen/agent_os/v1/...
  const agentGen = join(tmp, "agent", "gen");
  await mkdir(agentGen, { recursive: true });
  await rename(join(tmp, "agent_os"), join(agentGen, "agent_os"));
  await writeFile(join(tmp, "agent", "__init__.py"), "");
  await writeFile(
    join(agentGen, "__init__.py"),
    "import os as _os, sys as _sys\n" +
      "_gen_root = _os.path.dirname(__file__)\n" +
      "if _gen_root not in _sys.path:\n" +
      "    _sys.path.insert(0, _gen_root)\n",
  );
  await writeFile(join(agentGen, "agent_os", "__init__.py"), "");
  await writeFile(join(agentGen, "agent_os", "v1", "__init__.py"), "");

  // Create a temporary venv with the protobuf runtime.
  const venvDir = join(tmp, ".venv");
  run("venv create", pythonCmd, ["-m", "venv", venvDir]);
  const binDir = process.platform === "win32" ? "Scripts" : "bin";
  const venvPython = join(venvDir, binDir, process.platform === "win32" ? "python.exe" : "python");
  const venvPip = join(venvDir, binDir, process.platform === "win32" ? "pip.exe" : "pip");
  run("protobuf install", venvPip, ["install", "protobuf==7.35.0"]);

  // Run the consumer import smoke test with the temp agent package on PYTHONPATH.
  const env = { ...process.env, PYTHONPATH: tmp };
  run(
    "python smoke test",
    venvPython,
    [join(repoRoot, "tests", "python-import-smoke.py")],
    { env, cwd: repoRoot },
  );
} finally {
  await rm(tmp, { recursive: true, force: true });
}
