import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = validateCheckoutEvidence({
      checkout: requiredEnv("DF_PARENT_CHECKOUT"),
      repository: requiredEnv("DF_PARENT_REPO"),
      headSha: requiredEnv("DF_PARENT_HEAD_SHA"),
      gitlinkPath: requiredEnv("DF_GITLINK_PATH"),
      childSha: requiredEnv("DF_CHILD_SHA")
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message || String(error));
    process.exitCode = 1;
  }
}

export function validateCheckoutEvidence(input, run = runGit) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository || "")) {
    throw new Error("parent repository identity is invalid");
  }
  if (!isSha(input.headSha) || !isSha(input.childSha) || !isSafePath(input.gitlinkPath)) {
    throw new Error("pointer validation input is malformed");
  }
  const checkout = path.resolve(input.checkout);
  const origin = run(checkout, ["remote", "get-url", "origin"]);
  if (!origin.ok || normalizeOrigin(origin.stdout) !== input.repository.toLowerCase()) {
    throw new Error("least-privilege checkout origin does not match the planned parent");
  }
  const head = run(checkout, ["rev-parse", "HEAD"]);
  if (!head.ok || head.stdout.trim() !== input.headSha) {
    throw new Error("least-privilege checkout head does not match the planned PR head");
  }
  const entry = run(checkout, ["ls-tree", "HEAD", "--", input.gitlinkPath]);
  const match = entry.stdout.trim().match(/^160000 commit ([0-9a-f]{40})\t(.+)$/);
  if (!entry.ok || !match || match[1] !== input.childSha || match[2] !== input.gitlinkPath) {
    throw new Error("planned path is not the exact released child gitlink");
  }
  const status = run(checkout, ["status", "--porcelain=v2", "--untracked-files=all"]);
  if (!status.ok || status.stdout.trim()) throw new Error("parent checkout is dirty after recursive materialization");
  const submodules = run(checkout, ["submodule", "status", "--recursive"]);
  if (!submodules.ok) throw new Error("recursive submodule state is unobservable");
  const lines = submodules.stdout.split(/\r?\n/).filter(Boolean);
  if (lines.some((line) => !/^ [0-9a-f]{40}\s+/.test(line))) {
    throw new Error("recursive submodule checkout is uninitialized, divergent, or conflicted");
  }
  const target = lines.find((line) => line.includes(` ${input.gitlinkPath} `) || line.endsWith(` ${input.gitlinkPath}`));
  if (!target || target.slice(1, 41) !== input.childSha) {
    throw new Error("recursive checkout did not materialize the exact released child pointer");
  }
  return {
    schemaVersion: 1,
    repository: input.repository,
    head_sha: input.headSha,
    gitlink_path: input.gitlinkPath,
    child_sha: input.childSha,
    recursive_entries: lines.length,
    clean: true,
    executed_child_code: false
  };
}

function runGit(cwd, args) {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1"
    }
  });
  return { ok: result.status === 0, stdout: result.stdout || "" };
}

function normalizeOrigin(value) {
  const match = String(value || "").trim().match(/^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/i);
  return match?.[1]?.toLowerCase() || "";
}

function isSafePath(value) {
  return typeof value === "string" && value.length > 0 && !value.startsWith("/") && !value.includes("\\")
    && value.split("/").every((segment) => segment && segment !== "." && segment !== ".." && /^[A-Za-z0-9_.-]+$/.test(segment));
}

function isSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}
