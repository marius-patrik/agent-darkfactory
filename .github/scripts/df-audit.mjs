import {
  DARK_FACTORY_DATA_REPO,
  PLANNING_LABELS,
  WORK_LABELS,
  assertAllowedRepo,
  auditIssueBody,
  createGithubClient,
  ensureLabels,
  findAuditMarker,
  findPrdMarker,
  getBranchProtection,
  getOptionalFileContent,
  getRepository,
  isActiveManagedRepo,
  listActiveManagedRepos,
  listIssues,
  parseRepo,
  readManagedRepoRegistry,
  repoName,
  requiredEnv,
  slug,
  warnReadOnlyRepository,
  writeRunLedger
} from "./df-lib.mjs";

import { fileURLToPath } from "node:url";
import path from "node:path";

export const REQUIRED_FILES = [
  "AGENTS.md",
  "PRD.md",
  ".github/workflows/ci.yml",
  ".github/workflows/codex-review.yml",
  ".github/workflows/df-work.yml",
  ".github/workflows/df-plan.yml"
];
export const DOC_PATHS = ["PRD.md", "AGENTS.md", ".agents/.project/STATUS.md", ".agents/.project/PROJECT.md"];
export const DOC_STALE_DAYS = 90;

let gh;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}

async function main() {
  const token = requiredEnv("DARK_FACTORY_TOKEN");
  const controlRepo = parseRepo(requiredEnv("DF_CONTROL_REPO"));
  const dataRepo = DARK_FACTORY_DATA_REPO;
  const trigger = process.env.DF_TRIGGER ?? "unknown";
  const auditAll = process.env.DF_AUDIT_ALL === "true";
  gh = createGithubClient(token, "darkfactory-audit");

  const registry = await readManagedRepoRegistry();
  const targets = auditAll ? await listActiveManagedRepos(gh, controlRepo, { registry }) : [parseRepo(process.env.DF_TARGET_REPO?.trim() || repoName(controlRepo))];

  for (const target of targets) {
    if (!isActiveManagedRepo(target, registry)) {
      console.warn(`DarkFactory audit skipped ${repoName(target)} because managed lifecycle state is not active.`);
      continue;
    }
    try {
      await auditTargetRepository(gh, target, { controlRepo, dataRepo, trigger });
    } catch (error) {
      if (warnReadOnlyRepository(target, error, "audit")) continue;
      throw error;
    }
  }
}

async function auditTargetRepository(github, repository, options) {
  assertAllowedRepo(repository);
  const repo = await getRepository(github, repository);
  if (repo.archived === true || repo.disabled === true) {
    console.warn(`DarkFactory audit skipped ${repoName(repository)} because GitHub reports archived=${repo.archived === true} disabled=${repo.disabled === true}.`);
    return;
  }

  await ensureLabels(github, repository, [...PLANNING_LABELS, ...WORK_LABELS]);
  const findings = [];
  const defaultBranch = repo.default_branch || "main";

  findings.push(...await auditGitState(github, repository, repo, defaultBranch));
  findings.push(...await auditHealth(repository, defaultBranch, github));
  findings.push(...await auditEnforcement(github, repository, defaultBranch));
  findings.push(...await auditPrdDrift(github, repository, defaultBranch));
  findings.push(...await auditDocStaleness(repository, repo, defaultBranch, github));
  findings.push(...await auditSubmoduleState(github, repository, defaultBranch));

  const ledger = {
    trigger: options.trigger,
    default_branch: defaultBranch,
    findings,
    actions: [],
    token_usage: {
      codex_calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      note: "L5 audit used deterministic GitHub and repository metadata checks only"
    }
  };

  if (findings.length) {
    const issue = await upsertAuditIssue(github, repository, findings);
    ledger.actions.push({ action: "audit-findings-issue", issue, findings });
  } else {
    const closed = await closeResolvedAuditIssue(github, repository);
    if (closed) ledger.actions.push({ action: "close-resolved-audit", issue: closed });
  }

  await writeLedger(github, options.dataRepo, repository, ledger);
  console.log(`DarkFactory audit completed ${findings.length} findings for ${repoName(repository)}.`);
}

async function auditGitState(github, repository, repo, defaultBranch) {
  const findings = [];
  if (!defaultBranch) findings.push(finding("git state", "Repository does not report a default branch."));
  if (repo.has_issues !== true) findings.push(finding("git state", "GitHub issues are disabled, so DarkFactory cannot file findings-as-issues."));
  const protection = await getBranchProtection(github, repository, defaultBranch);
  if (!protection.configured) {
    findings.push(finding("git state", `Default branch \`${defaultBranch}\` does not have readable branch protection.`));
  }
  return findings;
}

export async function auditHealth(repository, defaultBranch, github = gh) {
  const findings = [];
  const runs = await listWorkflowRuns(repository, defaultBranch, github);
  const recentRuns = runs.filter((run) => run.status === "completed").slice(0, 10);
  const failing = recentRuns.filter((run) => !["success", "skipped", "neutral"].includes(run.conclusion || ""));
  if (recentRuns.length === 0) {
    findings.push(finding("health", `No completed GitHub Actions workflow runs were found on \`${defaultBranch}\`.`));
  }
  for (const run of failing.slice(0, 5)) {
    findings.push(finding("health", `Workflow \`${run.name || run.workflow_id}\` concluded \`${run.conclusion}\` on \`${defaultBranch}\`.`));
  }
  return findings;
}

async function auditEnforcement(github, repository, defaultBranch) {
  const findings = [];
  for (const filePath of REQUIRED_FILES) {
    const content = await getOptionalFileContent(github, repository, filePath, defaultBranch);
    if (!content) findings.push(finding("enforcement conformance", `Required managed file \`${filePath}\` is missing on \`${defaultBranch}\`.`));
  }
  return findings;
}

async function auditPrdDrift(github, repository, defaultBranch) {
  const findings = [];
  const prd = await getOptionalFileContent(github, repository, "PRD.md", defaultBranch);
  if (!prd) {
    findings.push(finding("PRD drift", `Root \`PRD.md\` is missing on \`${defaultBranch}\`.`));
    return findings;
  }

  const issues = await listIssues(github, repository, "open");
  const hasPrdTrackedIssue = issues.some((issue) => !issue.pull_request && findPrdMarker(issue.body || ""));
  if (!hasPrdTrackedIssue && /\b(core loops|milestones)\b/i.test(prd)) {
    findings.push(finding("PRD drift", "PRD contains planned sections, but no open PRD-tracked backlog issues were found."));
  }
  return findings;
}

export async function auditDocStaleness(repository, repo, defaultBranch, github = gh) {
  const findings = [];
  const pushedAt = Date.parse(repo.pushed_at || "");
  if (!Number.isFinite(pushedAt)) return findings;

  for (const filePath of DOC_PATHS) {
    const commit = await getLatestCommitForPath(repository, filePath, defaultBranch, github);
    if (!commit) continue;
    const committedAt = Date.parse(commit.commit?.committer?.date || commit.commit?.author?.date || "");
    if (!Number.isFinite(committedAt)) continue;
    const ageDays = Math.floor((pushedAt - committedAt) / (24 * 60 * 60 * 1000));
    if (ageDays > DOC_STALE_DAYS) {
      findings.push(finding("doc staleness", `\`${filePath}\` is ${ageDays} days older than recent repository activity.`));
    }
  }
  return findings;
}

export async function auditSubmoduleState(github, repository, defaultBranch) {
  const findings = [];
  const gitmodules = await getOptionalFileContent(github, repository, ".gitmodules", defaultBranch);
  if (!gitmodules) return findings;

  const submodules = parseGitmodules(gitmodules);
  if (submodules.length === 0) return findings;

  for (const submodule of submodules) {
    const childRepo = resolveSubmoduleRepo(repository, submodule.url);
    if (!childRepo) {
      findings.push(finding("git state", `Submodule \`${submodule.path}\` uses a non-GitHub URL \`${submodule.url}\`; cannot verify cleanliness.`));
      continue;
    }

    const recorded = await getSubmoduleCommit(github, repository, submodule.path, defaultBranch);
    if (!recorded) {
      findings.push(finding("git state", `Submodule \`${submodule.path}\` is declared in \`.gitmodules\` but has no recorded commit on \`${defaultBranch}\`.`));
      continue;
    }

    const head = await getSubmoduleHead(github, childRepo);
    if (!head) {
      findings.push(finding("git state", `Submodule \`${submodule.path}\` (${repoName(childRepo)}) default branch HEAD could not be read.`));
      continue;
    }

    if (recorded !== head) {
      findings.push(finding("git state", `Submodule \`${submodule.path}\` is dirty: parent records \`${recorded.slice(0, 12)}\`, but ${repoName(childRepo)} HEAD is \`${head.slice(0, 12)}\`.`));
    }
  }

  return findings;
}

export function parseGitmodules(content) {
  const submodules = [];
  if (typeof content !== "string") return submodules;

  const lines = content.replace(/\r\n/g, "\n").split("\n");
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;

    const section = line.match(/^\[submodule\s+"([^"]+)"\]\s*$/);
    if (section) {
      if (current) submodules.push(current);
      current = { name: section[1], path: "", url: "" };
      continue;
    }

    if (!current) continue;
    const pair = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!pair) continue;

    const key = pair[1].toLowerCase();
    const value = pair[2].trim();
    if (key === "path") current.path = value;
    if (key === "url") current.url = value;
  }

  if (current) submodules.push(current);
  return submodules;
}

export function resolveSubmoduleRepo(parentRepo, url) {
  if (typeof url !== "string" || !url.trim()) return null;
  const trimmed = url.trim();

  const sshMatch = trimmed.match(/^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };

  const httpsMatch = trimmed.match(/^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/.*)?$/);
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };

  if (trimmed.startsWith("github.com:")) {
    const scpLike = trimmed.match(/^github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
    if (scpLike) return { owner: scpLike[1], repo: scpLike[2] };
  }

  if (trimmed.startsWith("./") || trimmed.startsWith("../")) {
    try {
      // Resolve relative to the parent repository's directory, not the .git file,
      // so ../shared.git maps to owner/shared.git under the same owner.
      const resolved = new URL(trimmed, `https://github.com/${repoName(parentRepo)}/`).pathname;
      const parts = resolved.split("/").filter(Boolean);
      if (parts.length >= 2) {
        const repoPart = parts[parts.length - 1].replace(/\.git$/, "");
        const ownerPart = parts[parts.length - 2];
        if (ownerPart && repoPart) return { owner: ownerPart, repo: repoPart };
      }
    } catch {
      return null;
    }
  }

  return null;
}

async function getSubmoduleCommit(github, repository, submodulePath, defaultBranch) {
  try {
    const data = await github.request(
      "GET",
      `/repos/${repoName(repository)}/contents/${encodeURIComponent(submodulePath)}?ref=${encodeURIComponent(defaultBranch)}`
    );
    if (data && data.type === "submodule" && typeof data.sha === "string") return data.sha;
    return null;
  } catch (error) {
    if (error.status === 404) return null;
    if (error.status === 403) return null;
    throw error;
  }
}

async function getSubmoduleHead(github, childRepo) {
  try {
    const repo = await getRepository(github, childRepo);
    const branch = repo.default_branch || "main";
    const data = await github.request(
      "GET",
      `/repos/${repoName(childRepo)}/commits/${encodeURIComponent(branch)}`
    );
    if (data && typeof data.sha === "string") return data.sha;
    return null;
  } catch (error) {
    if (error.status === 404 || error.status === 403) return null;
    throw error;
  }
}

async function listWorkflowRuns(repository, branch, github) {
  try {
    const data = await github.request(
      "GET",
      `/repos/${repoName(repository)}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=20`
    );
    return Array.isArray(data.workflow_runs) ? data.workflow_runs : [];
  } catch (error) {
    if (error.status === 403 || error.status === 404) {
      return [];
    }
    throw error;
  }
}

async function getLatestCommitForPath(repository, filePath, branch, github) {
  try {
    const data = await github.request(
      "GET",
      `/repos/${repoName(repository)}/commits?sha=${encodeURIComponent(branch)}&path=${encodeURIComponent(filePath)}&per_page=1`
    );
    return Array.isArray(data) ? data[0] : null;
  } catch (error) {
    if (error.status === 404 || error.status === 409) return null;
    throw error;
  }
}

async function upsertAuditIssue(github, repository, findings) {
  const marker = `df-audit:${slug(repoName(repository))}`;
  const issues = await listIssues(github, repository, "all");
  const existing = issues.find((issue) => findAuditMarker(issue.body || "") === marker);
  const body = auditIssueBody(repoName(repository), findings);
  const title = `Audit findings - ${repoName(repository)}`;

  if (existing) {
    const updated = await github.request("PATCH", `/repos/${repoName(repository)}/issues/${existing.number}`, {
      title,
      body,
      state: "open"
    });
    await setAuditIssueLabels(github, repository, existing.number);
    return issueRef(updated);
  }

  const created = await github.request("POST", `/repos/${repoName(repository)}/issues`, {
    title,
    body,
    labels: ["P1", "df:audit", "df:class:standard"]
  });
  return issueRef(created);
}

async function closeResolvedAuditIssue(github, repository) {
  const marker = `df-audit:${slug(repoName(repository))}`;
  const issues = await listIssues(github, repository, "open");
  const existing = issues.find((issue) => findAuditMarker(issue.body || "") === marker);
  if (!existing) return null;
  await github.request("POST", `/repos/${repoName(repository)}/issues/${existing.number}/comments`, {
    body: "DarkFactory L5 audit no longer detects this audit condition."
  });
  const closed = await github.request("PATCH", `/repos/${repoName(repository)}/issues/${existing.number}`, { state: "closed" });
  return issueRef(closed);
}

async function setAuditIssueLabels(github, repository, issueNumber) {
  await github.request("POST", `/repos/${repoName(repository)}/issues/${issueNumber}/labels`, {
    labels: ["P1", "df:audit", "df:class:standard"]
  });
}

async function writeLedger(github, dataRepo, repository, ledger) {
  try {
    const written = await writeRunLedger(github, dataRepo, "df-audit", repoName(repository), ledger);
    console.log(`DarkFactory ledger written to ${written.repository}/${written.path}`);
  } catch (error) {
    console.warn(`DarkFactory ledger warning: ${error.message || String(error)}`);
  }
}

function finding(category, message) {
  return { category, message };
}

function issueRef(issue) {
  return { number: issue.number, url: issue.html_url };
}
