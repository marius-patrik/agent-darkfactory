import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const API_ROOT = "https://api.github.com";
const TOKEN = requiredEnv("DARK_FACTORY_TOKEN");
const CODEX_AUTH_JSON = process.env.CODEX_AUTH_JSON ?? "";
const CONTROL_REPO = parseRepo(requiredEnv("DF_CONTROL_REPO"));
const TARGET_REPO = parseRepo(requiredEnv("DF_TARGET_REPO"));
const TARGET_ISSUE_NUMBER = Number(requiredEnv("DF_TARGET_ISSUE_NUMBER"));
const TRIGGER = process.env.DF_TRIGGER ?? "unknown";
const WORKER_IMAGE = process.env.DF_WORKER_IMAGE ?? "darkfactory-codex-worker";
const CODEX_MODEL = process.env.DF_CODEX_MODEL ?? "gpt-5.5";
const CODEX_EFFORT = process.env.DF_CODEX_EFFORT ?? "medium";
const GIT_BASIC_AUTH = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");

const LABELS = [
  { name: "df:ready", color: "0E8A16", description: "DarkFactory work loop may pick up this issue" },
  { name: "df:running", color: "1D76DB", description: "DarkFactory worker is running for this issue" },
  { name: "df:blocked", color: "B60205", description: "DarkFactory worker is blocked on this issue" },
  { name: "df:done", color: "5319E7", description: "DarkFactory worker completed this issue" }
];

main().catch((error) => {
  console.error(sanitize(error.stack || error.message || String(error)));
  process.exitCode = 1;
});

async function main() {
  if (!Number.isInteger(TARGET_ISSUE_NUMBER) || TARGET_ISSUE_NUMBER <= 0) {
    throw new Error(`Invalid issue number: ${process.env.DF_TARGET_ISSUE_NUMBER}`);
  }

  assertAllowedRepo(TARGET_REPO);
  await ensureLabels(CONTROL_REPO);
  if (repoName(CONTROL_REPO) !== repoName(TARGET_REPO)) {
    await ensureLabels(TARGET_REPO);
  }

  const issue = await getIssue(TARGET_REPO, TARGET_ISSUE_NUMBER);
  const target = `${repoName(TARGET_REPO)}#${TARGET_ISSUE_NUMBER}`;
  const branch = `df/${TARGET_ISSUE_NUMBER}-${slug(issue.title)}`;
  let tempRoot = "";

  try {
    await replaceIssueLabels(TARGET_REPO, TARGET_ISSUE_NUMBER, ["df:running"], ["df:ready", "df:blocked", "df:done"]);
    await createIssueComment(
      TARGET_REPO,
      TARGET_ISSUE_NUMBER,
      `DarkFactory worker started for \`${target}\` from \`${TRIGGER}\`.\n\nBranch: \`${branch}\``
    );

    if (!CODEX_AUTH_JSON.trim()) {
      throw new Error("CODEX_AUTH_JSON is not configured for the worker.");
    }

    const repo = await getRepository(TARGET_REPO);
    tempRoot = await mkdtemp(path.join(tmpdir(), "df-work-"));
    const worktree = path.join(tempRoot, "repo");
    const codexHome = path.join(tempRoot, "codex-home");

    await cloneRepository(TARGET_REPO, worktree);
    ensureNoRemoteBranch(TARGET_REPO, branch);
    runGit(["checkout", "-b", branch], worktree);

    await writeCodexAuth(codexHome);
    await writeTaskBrief(worktree, issue, repo.default_branch);
    buildWorkerImage();
    runCodexWorker(worktree, codexHome);

    const summary = await readWorkerSummary(worktree);
    await removeWorkerScratch(worktree);

    const changed = gitOutput(["status", "--porcelain"], worktree);
    if (changed.trim()) {
      runGit(["config", "user.name", "DarkFactory"], worktree);
      runGit(["config", "user.email", "darkfactory@users.noreply.github.com"], worktree);
      runGit(["add", "--all"], worktree);
      runGit(["commit", "-m", `feat: implement issue #${TARGET_ISSUE_NUMBER}`], worktree);
    }

    const ahead = Number(gitOutput(["rev-list", "--count", `origin/${repo.default_branch}..HEAD`], worktree));
    if (!Number.isInteger(ahead) || ahead <= 0) {
      throw new Error("Worker completed without producing a commit.");
    }

    runGit(["push", "origin", `HEAD:refs/heads/${branch}`], worktree);
    const pullRequest = await createPullRequest(TARGET_REPO, repo.default_branch, branch, issue, summary);
    const automerge = await enableAutoMerge(pullRequest.node_id);

    await replaceIssueLabels(TARGET_REPO, TARGET_ISSUE_NUMBER, ["df:done"], ["df:ready", "df:running", "df:blocked"]);
    await createIssueComment(
      TARGET_REPO,
      TARGET_ISSUE_NUMBER,
      [
        `DarkFactory worker opened ${pullRequest.html_url}.`,
        "",
        `Automerge: ${automerge.enabled ? "enabled" : `not enabled (${automerge.reason})`}.`,
        "",
        "Worker summary:",
        "",
        truncate(summary, 5000)
      ].join("\n")
    );
  } catch (error) {
    await replaceIssueLabels(TARGET_REPO, TARGET_ISSUE_NUMBER, ["df:blocked"], ["df:running"]);
    await createIssueComment(
      TARGET_REPO,
      TARGET_ISSUE_NUMBER,
      [
        "DarkFactory worker blocked.",
        "",
        "Blocker:",
        "",
        "```text",
        truncate(sanitize(error.stack || error.message || String(error)), 6000),
        "```"
      ].join("\n")
    );
    throw error;
  } finally {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
}

async function ensureLabels(repository) {
  for (const label of LABELS) {
    try {
      await ghRequest("POST", `/repos/${repoName(repository)}/labels`, label);
    } catch (error) {
      if (error.status !== 422) throw error;
      await ghRequest("PATCH", `/repos/${repoName(repository)}/labels/${encodeURIComponent(label.name)}`, {
        color: label.color,
        description: label.description
      });
    }
  }
}

async function getIssue(repository, issueNumber) {
  const issue = await ghRequest("GET", `/repos/${repoName(repository)}/issues/${issueNumber}`);
  if (issue.pull_request) {
    throw new Error(`${repoName(repository)}#${issueNumber} is a pull request, not an issue.`);
  }
  if (issue.state !== "open") {
    throw new Error(`${repoName(repository)}#${issueNumber} is not open.`);
  }
  return issue;
}

async function getRepository(repository) {
  return await ghRequest("GET", `/repos/${repoName(repository)}`);
}

async function replaceIssueLabels(repository, issueNumber, add, remove) {
  if (add.length) {
    await ghRequest("POST", `/repos/${repoName(repository)}/issues/${issueNumber}/labels`, { labels: add });
  }
  for (const label of remove) {
    try {
      await ghRequest("DELETE", `/repos/${repoName(repository)}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`);
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
}

async function createIssueComment(repository, issueNumber, body) {
  await ghRequest("POST", `/repos/${repoName(repository)}/issues/${issueNumber}/comments`, { body });
}

async function cloneRepository(repository, worktree) {
  const url = `https://github.com/${repoName(repository)}.git`;
  runGitWithAuth(["clone", "--depth", "1", url, worktree], process.cwd());
}

function ensureNoRemoteBranch(repository, branch) {
  const result = spawnSync(
    "git",
    ["-c", authHeader(), "ls-remote", "--heads", `https://github.com/${repoName(repository)}.git`, branch],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
  );
  if (result.status !== 0) {
    throw new Error(`git ls-remote failed: ${sanitize(result.stderr || result.stdout)}`);
  }
  if (result.stdout.trim()) {
    throw new Error(`Remote branch already exists: ${branch}`);
  }
}

async function writeCodexAuth(codexHome) {
  await mkdir(codexHome, { recursive: true });
  await writeFile(path.join(codexHome, "auth.json"), CODEX_AUTH_JSON, { mode: 0o600 });
}

async function writeTaskBrief(worktree, issue, defaultBranch) {
  const scratchDir = path.join(worktree, ".darkfactory");
  await mkdir(scratchDir, { recursive: true });

  const agentsContext = await readOptional(path.join(worktree, "AGENTS.md"));
  const prdContext = await readOptional(path.join(worktree, "PRD.md"));
  const issueLabels = Array.isArray(issue.labels)
    ? issue.labels.map((label) => typeof label === "string" ? label : label.name).filter(Boolean).join(", ")
    : "";

  const brief = [
    "# DarkFactory Worker Brief",
    "",
    `Target repository: ${repoName(TARGET_REPO)}`,
    `Default branch: ${defaultBranch}`,
    `Issue: #${TARGET_ISSUE_NUMBER}`,
    `Title: ${issue.title}`,
    `Labels: ${issueLabels || "(none)"}`,
    "",
    "## Contract",
    "",
    "The issue body, especially any Acceptance Criteria section, is the definition of done.",
    "Implement only this issue. Do not push, create pull requests, merge, or force-push; DarkFactory handles GitHub writes after you finish.",
    "Run the repository's documented validation commands before finishing. If validation cannot be run, explain the blocker in the final summary.",
    "Keep secrets out of files and logs.",
    "",
    "## Issue Body",
    "",
    issue.body?.trim() || "(issue body is empty)",
    "",
    "## Acceptance Criteria",
    "",
    extractAcceptanceCriteria(issue.body || "") || "Use the issue body as the acceptance criteria.",
    "",
    "## Root AGENTS.md",
    "",
    agentsContext || "(AGENTS.md not present)",
    "",
    "## Root PRD.md",
    "",
    prdContext || "(PRD.md not present)"
  ].join("\n");

  await writeFile(path.join(scratchDir, "df-task-brief.md"), `${brief}\n`);
}

function buildWorkerImage() {
  runCommand("docker", ["build", "-f", ".github/codex-review.Dockerfile", "-t", WORKER_IMAGE, "."], process.cwd());
}

function runCodexWorker(worktree, codexHome) {
  const script = [
    "set -euo pipefail",
    "git config --global --add safe.directory /workspace",
    "cd /workspace",
    "codex exec --cd /workspace --model \"${CODEX_MODEL}\" -c \"model_reasoning_effort=\\\"${CODEX_EFFORT}\\\"\" --sandbox danger-full-access --output-last-message .darkfactory/df-worker-summary.md - < .darkfactory/df-task-brief.md"
  ].join("\n");

  runCommand(
    "docker",
    [
      "run",
      "--rm",
      "--entrypoint",
      "bash",
      "-e",
      "CODEX_HOME=/codex-home",
      "-e",
      "HOME=/codex-home",
      "-e",
      `CODEX_MODEL=${CODEX_MODEL}`,
      "-e",
      `CODEX_EFFORT=${CODEX_EFFORT}`,
      "-v",
      `${worktree}:/workspace`,
      "-v",
      `${codexHome}:/codex-home`,
      WORKER_IMAGE,
      "-lc",
      script
    ],
    process.cwd()
  );
}

async function readWorkerSummary(worktree) {
  const summary = await readOptional(path.join(worktree, ".darkfactory", "df-worker-summary.md"));
  return summary?.trim() || "Worker completed without a written summary.";
}

async function removeWorkerScratch(worktree) {
  await rm(path.join(worktree, ".darkfactory", "df-task-brief.md"), { force: true });
  await rm(path.join(worktree, ".darkfactory", "df-worker-summary.md"), { force: true });
}

async function createPullRequest(repository, base, branch, issue, summary) {
  return await ghRequest("POST", `/repos/${repoName(repository)}/pulls`, {
    title: issue.title,
    head: branch,
    base,
    body: [
      "## DarkFactory Worker Summary",
      "",
      truncate(summary, 10000),
      "",
      `Closes #${TARGET_ISSUE_NUMBER}`
    ].join("\n")
  });
}

async function enableAutoMerge(pullRequestId) {
  try {
    await ghGraphql(
      `mutation EnableAutoMerge($pullRequestId: ID!) {
        enablePullRequestAutoMerge(input: {pullRequestId: $pullRequestId, mergeMethod: SQUASH}) {
          pullRequest { url }
        }
      }`,
      { pullRequestId }
    );
    return { enabled: true, reason: "" };
  } catch (error) {
    return { enabled: false, reason: sanitize(error.message || String(error)) };
  }
}

async function ghRequest(method, pathName, body) {
  const response = await fetch(`${API_ROOT}${pathName}`, {
    method,
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "darkfactory-worker"
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`${method} ${pathName} failed with ${response.status}: ${sanitize(text)}`);
    error.status = response.status;
    throw error;
  }

  if (response.status === 204) return null;
  return await response.json();
}

async function ghGraphql(query, variables) {
  const response = await fetch(`${API_ROOT}/graphql`, {
    method: "POST",
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "darkfactory-worker"
    },
    body: JSON.stringify({ query, variables })
  });
  const payload = await response.json();
  if (!response.ok || payload.errors?.length) {
    throw new Error(JSON.stringify(payload.errors || payload));
  }
  return payload.data;
}

function runGit(args, cwd) {
  return runGitWithAuth(args, cwd);
}

function gitOutput(args, cwd) {
  return runGitWithAuth(args, cwd).trim();
}

function runGitWithAuth(args, cwd) {
  return runCommand("git", ["-c", authHeader(), ...args], cwd);
}

function authHeader() {
  return `http.https://github.com/.extraheader=AUTHORIZATION: basic ${GIT_BASIC_AUTH}`;
}

function runCommand(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    env: process.env
  });
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit ${result.status}\n${sanitize(result.stdout || "")}\n${sanitize(result.stderr || "")}`.trim());
  }
  return result.stdout || "";
}

async function readOptional(filePath) {
  if (!existsSync(filePath)) return "";
  return await readFile(filePath, "utf8");
}

function parseRepo(value) {
  const match = value.trim().match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) throw new Error(`Invalid repository name: ${value}`);
  return { owner: match[1], repo: match[2] };
}

function repoName(repository) {
  return `${repository.owner}/${repository.repo}`;
}

function assertAllowedRepo(repository) {
  const name = repoName(repository).toLowerCase();
  const repo = repository.repo.toLowerCase();
  if (name === "marius-patrik/fabrica" || repo === "fabrica" || name === "marius-patrik/skyblock-agent" || repo === "skyblock-agent") {
    throw new Error(`Refusing to run on parked repository: ${repoName(repository)}`);
  }
}

function slug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "issue";
}

function extractAcceptanceCriteria(body) {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => /^#{1,6}\s+acceptance criteria\s*$/i.test(line.trim()));
  if (start === -1) return "";
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s+\S/.test(line.trim())) break;
    out.push(line);
  }
  return out.join("\n").trim();
}

function truncate(value, maxLength) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n\n[truncated from ${value.length} characters]`;
}

function sanitize(value) {
  return value.split(TOKEN).join("***").split(GIT_BASIC_AUTH).join("***");
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}
