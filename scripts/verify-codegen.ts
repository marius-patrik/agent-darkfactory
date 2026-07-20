import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { TextDecoder } from "node:util";

const root = resolve(import.meta.dir, "..");
const core = join(root, "src/migrate/core");
const buf = join(root, "node_modules/.bin", process.platform === "win32" ? "buf.exe" : "buf");
const outputs = [
  "src/migrate/core/contracts-go/gen",
  "src/migrate/core/clients/shared-ts/src/gen",
  "src/migrate/inference/python-agent/agent/gen",
  "src/migrate/gateway/agent_os",
];
const TRANSIENT_RETRY_DELAYS_MS = [5_000, 15_000] as const;

export function isRetryableBufFailure(output: string): boolean {
  if (/unauthenticated|authentication required|permission denied|forbidden|invalid[_ -]?argument|invalid (?:proto|schema|syntax)|(?:schema|syntax|parse) error/i.test(output)) {
    return false;
  }
  return /resource_exhausted|too many requests|rate[- ]?limit|temporarily unavailable|deadline exceeded|connection reset|timed out/i.test(output);
}

function generatedFilter(source: string): boolean {
  return basename(source) !== "__pycache__" && !source.endsWith(".pyc");
}

function filesUnder(directory: string): string[] {
  const files: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "__pycache__" || entry.name.endsWith(".pyc")) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(relative(directory, path).replaceAll("\\", "/"));
    }
  };
  visit(directory);
  return files.sort();
}

// Extend this allowlist when a pinned generator adds another text format.
const GENERATED_TEXT_EXTENSIONS = new Set([".go", ".py", ".pyi", ".ts"]);

function comparableGeneratedContent(file: string): Buffer {
  const content = readFileSync(file);
  if (!GENERATED_TEXT_EXTENSIONS.has(extname(file))) return content;
  // Git may materialize generated text as CRLF on Windows while the pinned
  // generators emit LF. Codegen freshness is a content invariant, so compare
  // one canonical newline representation. Unknown and future binary artifacts
  // remain byte-exact.
  try {
    return Buffer.from(new TextDecoder("utf-8", { fatal: true }).decode(content).replaceAll("\r\n", "\n"));
  } catch {
    return content;
  }
}

function assertTreesEqual(expected: string, actual: string, label: string): void {
  const expectedFiles = filesUnder(expected);
  const actualFiles = filesUnder(actual);
  if (expectedFiles.join("\n") !== actualFiles.join("\n")) {
    const missing = expectedFiles.filter((file) => !actualFiles.includes(file));
    const stale = actualFiles.filter((file) => !expectedFiles.includes(file));
    throw new Error(`${label} file set differs; missing after generation: ${missing.join(", ") || "none"}; stale in checkout: ${stale.join(", ") || "none"}`);
  }
  for (const file of expectedFiles) {
    if (!comparableGeneratedContent(join(expected, file)).equals(comparableGeneratedContent(join(actual, file)))) {
      throw new Error(`${label} differs from clean generation: ${file}`);
    }
  }
}

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function run(args: string[], retryTransient = false): string {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return execFileSync(buf, args, {
        cwd: core,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string };
      const output = [failure.stdout, failure.stderr, failure.message].filter(Boolean).join("\n");
      const delay = TRANSIENT_RETRY_DELAYS_MS[attempt];
      if (retryTransient && delay !== undefined && isRetryableBufFailure(output)) {
        console.warn(`Buf transient failure; retrying ${args.join(" ")} in ${delay / 1_000}s (${attempt + 2}/${TRANSIENT_RETRY_DELAYS_MS.length + 1})`);
        sleep(delay);
        continue;
      }
      if (failure.stdout) process.stdout.write(failure.stdout);
      if (failure.stderr) process.stderr.write(failure.stderr);
      throw error;
    }
  }
}

function main(): void {
  const temp = mkdtempSync(join(tmpdir(), "andromeda-codegen-"));
  const beforeRoot = join(temp, "before");

  if (!existsSync(buf)) throw new Error("pinned Buf executable is missing; run bun install --frozen-lockfile");
  if (run(["--version"]) !== "1.71.0") throw new Error("Buf must be exactly 1.71.0");

  try {
    for (const output of outputs) {
      const source = join(root, output);
      const backup = join(beforeRoot, output);
      if (!existsSync(source)) throw new Error(`generated output is missing: ${output}`);
      mkdirSync(dirname(backup), { recursive: true });
      cpSync(source, backup, { recursive: true, filter: generatedFilter });
      rmSync(source, { recursive: true, force: true });
      mkdirSync(source, { recursive: true });
    }

    // This package-owned barrel is intentionally not emitted by Buf.
    cpSync(
      join(beforeRoot, "src/migrate/core/clients/shared-ts/src/gen/index.ts"),
      join(root, "src/migrate/core/clients/shared-ts/src/gen/index.ts"),
    );
    for (const init of ["__init__.py", "agent_os/__init__.py", "agent_os/v1/__init__.py"]) {
      const source = join(beforeRoot, "src/migrate/inference/python-agent/agent/gen", init);
      const destination = join(root, "src/migrate/inference/python-agent/agent/gen", init);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(source, destination);
    }

    run(["lint", "proto"]);
    run(["generate", "proto"], true);
    run(["generate", "proto", "--template", "buf.gen.python.yaml"], true);
    run(["generate", "proto", "--template", "buf.gen.gateway-python.yaml"], true);

    for (const output of outputs) {
      assertTreesEqual(join(beforeRoot, output), join(root, output), output);
    }
    for (const output of outputs) {
      if (filesUnder(join(root, output)).some((file) => file.split("/").includes("rommie"))) {
        throw new Error(`retired rommie wire namespace remains in ${output}`);
      }
    }
    console.log("Agent OS code generation is current and complete.");
  } finally {
    for (const output of outputs) {
      const destination = join(root, output);
      const backup = join(beforeRoot, output);
      rmSync(destination, { recursive: true, force: true });
      mkdirSync(dirname(destination), { recursive: true });
      if (existsSync(backup)) cpSync(backup, destination, { recursive: true });
    }
    rmSync(temp, { recursive: true, force: true });
  }
}

if (import.meta.main) main();
