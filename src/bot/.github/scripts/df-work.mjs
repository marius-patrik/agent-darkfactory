import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DARK_FACTORY_DATA_REPO,
  WORK_LABELS,
  assertAllowedRepo,
  classifyWorkerBranchRefs,
  cleanupTempRoot,
  createGithubClient,
  darkFactoryWorkerIssueNumber,
  ensureLabels,
  findOpenWorkerPullRequestForIssue,
  getRepository,
  isDarkFactoryWorkerPullRequest,
  preflightMergePolicy,
  parseRepo,
  readManagedRepoRegistry,
  repoName,
  requiredEnv,
  sanitize,
  slug,
  taskClassFromLabels,
  writeRunLedger
} from "./df-lib.mjs";
import { evaluateEnforcementRules, loadEnforcementRules } from "./df-enforcement.mjs";
import {
  agentRunArguments,
  loadModelPolicy,
  modelRequestForPurpose,
  validateAgentExecutionReceipt
} from "./df-model-policy.mjs";
import {
  ModelTurnError,
  agentProcessEnvironment,
  executeModelTurn,
  validationCommandsForRepository
} from "../../src/model-turn.ts";

const CONTROL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TOKEN = requiredEnv("DARK_FACTORY_TOKEN");
const CONTROL_REPO = parseRepo(requiredEnv("DF_CONTROL_REPO"));
const TARGET_REPO = parseRepo(requiredEnv("DF_TARGET_REPO"));
const TARGET_ISSUE_NUMBER = Number(requiredEnv("DF_TARGET_ISSUE_NUMBER"));
const TARGET_BASE_REF = process.env.DF_TARGET_BASE_REF?.trim() || "";
const RESUME_PR_NUMBER = process.env.DF_RESUME_PR?.trim() ? Number(process.env.DF_RESUME_PR.trim()) : 0;
const RESUME_BRANCH = process.env.DF_RESUME_BRANCH?.trim() || "";
const RESUME_HEAD = process.env.DF_RESUME_HEAD?.trim().toLowerCase() || "";
const IS_RESUME = (Number.isInteger(RESUME_PR_NUMBER) && RESUME_PR_NUMBER > 0) || RESUME_BRANCH.length > 0 || RESUME_HEAD.length > 0;
const TRIGGER = process.env.DF_TRIGGER ?? "unknown";
const DATA_REPO = DARK_FACTORY_DATA_REPO;
const GIT_BASIC_AUTH = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
const gh = createGithubClient(TOKEN, "darkfactory-worker");

main().catch((error) => {
  console.error(sanitize(error.stack || error.message || String(error), TOKEN));
  process.exitCode = 1;
});

async function main() {
  canonicalAgentsLauncher();

  if (!Number.isInteger(TARGET_ISSUE_NUMBER) || TARGET_ISSUE_NUMBER <= 0) {
    throw new Error(`Invalid issue number: ${process.env.DF_TARGET_ISSUE_NUMBER}`);
  }

  assertAllowedRepo(TARGET_REPO);

  const issue = await getIssue(TARGET_REPO, TARGET_ISSUE_NUMBER);
  const issueComments = await getIssueComments(TARGET_REPO, TARGET_ISSUE_NUMBER);
  const taskRouting = taskClassFromLabels(issue.labels);
  const modelPolicy = await loadModelPolicy(CONTROL_ROOT);
  const modelRequest = modelRequestForPurpose(modelPolicy, "implementation", taskRouting);
  const target = `${repoName(TARGET_REPO)}#${TARGET_ISSUE_NUMBER}`;
  const resumeInfo = await buildResumeInfo(TARGET_REPO, TARGET_ISSUE_NUMBER);
  const branch = resumeInfo?.branch || `df/${TARGET_ISSUE_NUMBER}-${slug(issue.title)}`;

  const ledger = {
    trigger: TRIGGER,
    issue: target,
    branch,
    status: "started",
    actions: [],
    model_request: modelRequest,
    agent_os: {
      turns: 0,
      receipt: null,
      note: "Provider, model, identity, memory, and session state are resolved only by the canonical agents launcher."
    }
  };

  ledger.resume = resumeInfo ? { type: resumeInfo.type, branch: resumeInfo.branch } : null;
  let tempRoot = "";
  let pullRequest = null;

  const repo = await getRepository(gh, TARGET_REPO);
  const workBaseBranch = resumeInfo?.baseRef || await resolveWorkBaseBranch(TARGET_REPO, repo.default_branch, TARGET_BASE_REF);
  ledger.base_branch = workBaseBranch;

  const enforcementRules = await loadEnforcementRules(CONTROL_ROOT);
  const enforcement = await evaluateEnforcementRules(enforcementRules, {
    gh,
    repository: TARGET_REPO,
    baseBranch: workBaseBranch,
    registry: await readManagedRepoRegistry(CONTROL_ROOT),
    token: TOKEN
  });
  ledger.actions.push({ action: "enforcement-rules", result: enforcement });
  if (!enforcement.ok) {
    ledger.status = "blocked";
    ledger.error = enforcement.findings.map((finding) => `${finding.rule}: ${finding.message}`).join("\n");
    await replaceIssueLabels(TARGET_REPO, TARGET_ISSUE_NUMBER, ["df:blocked"], ["df:ready", "df:running", "df:done"]);
    await createIssueComment(
      TARGET_REPO,
      TARGET_ISSUE_NUMBER,
      enforcementBlockedComment(target, workBaseBranch, enforcement)
    );
    return;
  }

  // Ensure work labels exist before any preflight failure path tries to apply
  // `df:blocked` to the issue, so the blocker comment is always left reliably.
  // The control repo labels are best-effort: issue/comment triggers in managed
  // repositories run with the repository token, which cannot write to the
  // control repository.
  try {
    await ensureLabels(gh, CONTROL_REPO, WORK_LABELS);
  } catch (error) {
    console.warn(`Could not ensure labels in ${repoName(CONTROL_REPO)}: ${sanitize(error.message || String(error), TOKEN)}`);
  }
  await ensureLabels(gh, TARGET_REPO, WORK_LABELS);

  if (!resumeInfo) {
    const existingPullRequest = await findOpenWorkerPullRequestForIssue(gh, TARGET_REPO, TARGET_ISSUE_NUMBER);
    if (existingPullRequest) {
      ledger.status = "success";
      ledger.pull_request = existingPullRequest.url;
      ledger.actions.push({
        action: "existing-worker-pr",
        result: "noop",
        url: existingPullRequest.url,
        branch: existingPullRequest.headRefName
      });
      await replaceIssueLabels(TARGET_REPO, TARGET_ISSUE_NUMBER, ["df:running"], ["df:ready", "df:blocked", "df:done"]);
      await createIssueComment(
        TARGET_REPO,
        TARGET_ISSUE_NUMBER,
        [
          `DarkFactory worker skipped \`${target}\` because an open worker PR already exists.`,
          "",
          `PR: ${existingPullRequest.url || `#${existingPullRequest.number}`}`,
          `Branch: \`${existingPullRequest.headRefName || branch}\``,
          "",
          "No new worker run is needed; follow-through will evaluate the existing PR."
        ].join("\n")
      );
      return;
    }
  }

  const mergePolicy = await preflightMergePolicy(gh, TARGET_REPO, workBaseBranch, repo);
  ledger.actions.push({ action: "preflight-merge-policy", result: mergePolicy });
  if (mergePolicy.blocked) {
    ledger.status = "blocked";
    ledger.error = mergePolicy.reason;
    await replaceIssueLabels(TARGET_REPO, TARGET_ISSUE_NUMBER, ["df:blocked"], ["df:ready", "df:running", "df:done"]);
    await createIssueComment(
      TARGET_REPO,
      TARGET_ISSUE_NUMBER,
      preflightBlockedComment(target, workBaseBranch, mergePolicy)
    );
    return;
  }

  try {
    verifyAgentOs();
    await replaceIssueLabels(TARGET_REPO, TARGET_ISSUE_NUMBER, ["df:running"], ["df:ready", "df:blocked", "df:done"]);
    await createIssueComment(
      TARGET_REPO,
      TARGET_ISSUE_NUMBER,
      workerStartedComment(target, branch, taskRouting, modelRequest, mergePolicy.summary, resumeInfo)
    );

    tempRoot = await mkdtemp(path.join(tmpdir(), "df-work-"));
    const worktree = path.join(tempRoot, "repo");

    await cloneRepository(TARGET_REPO, worktree, workBaseBranch);
    if (resumeInfo) {
      if (resumeInfo.type === "branch") {
        const remoteRef = `refs/remotes/origin/${branch}`;
        runGit(["fetch", "origin", `refs/heads/${branch}:${remoteRef}`], worktree);
        const fetchedHead = gitOutput(["rev-parse", remoteRef], worktree).toLowerCase();
        if (fetchedHead !== resumeInfo.head) {
          throw new Error("Resume branch changed after exact admission; recovery stopped before checkout or push.");
        }
        runGit(["checkout", "-B", branch, remoteRef], worktree);
      } else {
        runGit(["fetch", "origin", branch], worktree);
        runGit(["checkout", branch], worktree);
      }
    } else {
      if (await remoteBranchExists(TARGET_REPO, branch)) {
        const staleBranchResult = await blockStaleWorkerBranch(branch);
        ledger.status = "blocked";
        ledger.error = staleBranchResult.message;
        ledger.actions.push(staleBranchResult);
        return;
      }
      runGit(["checkout", "-b", branch], worktree);
    }

    const repositoryPaths = gitOutput(["ls-files"], worktree).split(/\r?\n/).filter(Boolean);
    const validationCommands = validationCommandsForRepository(TARGET_REPO, repositoryPaths);
    const modelTurn = await runAgentWorker({
      worktree,
      issue,
      issueComments,
      defaultBranch: workBaseBranch,
      taskRouting,
      modelRequest,
      resumeInfo,
      branch,
      repositoryPaths,
      validationCommands,
      tempRoot
    });
    const executionReceipt = modelTurn.receipt;
    ledger.agent_os.turns = 1;
    ledger.agent_os.receipt = executionReceipt;
    ledger.agent_os.prompt = modelTurn.prompt;
    ledger.token_usage = {
      requested_model_tier: executionReceipt.requested.modelTier,
      requested_effort: executionReceipt.requested.effort,
      provider: executionReceipt.resolved.provider,
      model: executionReceipt.resolved.model,
      provider_version: executionReceipt.resolved.providerVersion,
      agent_preset: executionReceipt.resolved.agentPreset,
      attempts: executionReceipt.attempts.length,
      input_tokens: executionReceipt.usage.inputTokens,
      output_tokens: executionReceipt.usage.outputTokens,
      total_tokens: executionReceipt.usage.totalTokens
    };

    const currentIssue = await getIssue(TARGET_REPO, TARGET_ISSUE_NUMBER);
    const currentComments = await getIssueComments(TARGET_REPO, TARGET_ISSUE_NUMBER);
    if (
      issueVersion(currentIssue) !== issueVersion(issue) ||
      JSON.stringify(currentComments) !== JSON.stringify(issueComments)
    ) {
      throw new Error("Worker issue changed during the model turn; refusing to publish stale implementation work.");
    }

    ledger.agent_os.turn_ledger = await writeRunLedger(
      gh,
      DATA_REPO,
      "df-work-model-turn",
      repoName(TARGET_REPO),
      {
        issue: target,
        branch,
        base_branch: workBaseBranch,
        status: "model-turn-complete",
        model_request: modelRequest,
        prompt: modelTurn.prompt,
        receipt: executionReceipt,
        token_usage: ledger.token_usage
      }
    );

    const summary = workerSummary(modelTurn.output);

    const changed = gitOutput(["status", "--porcelain"], worktree);
    if (changed.trim()) {
      runGit(["config", "user.name", "DarkFactory"], worktree);
      runGit(["config", "user.email", "darkfactory@users.noreply.github.com"], worktree);
      runGit(["add", "--all"], worktree);
      runGit(["commit", "-m", `feat: implement issue #${TARGET_ISSUE_NUMBER}`], worktree);
    }

    const ahead = Number(gitOutput(["rev-list", "--count", `origin/${workBaseBranch}..HEAD`], worktree));
    if (!Number.isInteger(ahead) || ahead < 0 || (ahead === 0 && !resumeInfo)) {
      throw new Error("Worker completed without producing a commit.");
    }

    runGit(["push", "origin", `HEAD:refs/heads/${branch}`], worktree);
    pullRequest = await openOrReusePullRequest(TARGET_REPO, workBaseBranch, branch, issue, summary, resumeInfo);
    ledger.pull_request = pullRequest.html_url;

    let automerge;
    try {
      automerge = await enableAutoMerge(pullRequest.node_id);
    } catch (automergeError) {
      automerge = {
        enabled: false,
        reason: sanitize(automergeError.message || String(automergeError), TOKEN)
      };
    }

    await createIssueComment(
      TARGET_REPO,
      TARGET_ISSUE_NUMBER,
      workerSuccessComment(pullRequest, summary, automerge, resumeInfo)
    );
    ledger.status = "success";
    ledger.actions.push({
      action: resumeInfo ? "resume-pr" : "open-pr",
      url: pullRequest.html_url,
      automerge,
      execution: "agent-os",
      resumed: !!resumeInfo
    });
  } catch (error) {
    ledger.status = "blocked";
    if (error instanceof ModelTurnError) {
      ledger.agent_os.prompt = error.prompt;
      ledger.agent_os.receipt = error.receipt;
    }
    const baseError = sanitize(error.stack || error.message || String(error), TOKEN);
    ledger.error = baseError;
    if (pullRequest) {
      ledger.pull_request = pullRequest.html_url;
    }
    try {
      await markWorkerBlocked(TARGET_REPO, TARGET_ISSUE_NUMBER, ledger.error);
    } catch (updateError) {
      console.warn(`DarkFactory failed to mark issue blocked: ${sanitize(updateError.stack || updateError.message || String(updateError), TOKEN)}`);
    }
    throw error;
  } finally {
    const cleanup = await cleanupTempRoot(tempRoot, (warning) => console.warn(sanitize(warning, TOKEN)));
    ledger.cleanup = cleanup;
    await writeLedger(ledger);
  }
}

function workerStartedComment(target, branch, taskRouting, modelRequest, mergePolicySummary, resumeInfo) {
  const lines = resumeInfo
    ? [
        `DarkFactory worker resumed for \`${target}\` from \`${TRIGGER}\`.`,
        "",
        resumeInfo.type === "pr"
          ? `Resuming against existing PR: ${resumeInfo.pr.html_url || `#${resumeInfo.pr.number}`}`
          : `Resuming from pushed branch: \`${resumeInfo.branch}\``,
        `Branch: \`${branch}\``,
        `Task class: \`${taskRouting.taskClass}\``,
        `Requested model tier / effort: \`${modelRequest.modelTier}\` / \`${modelRequest.effort}\``,
        "Execution authority: canonical Agent OS manager state.",
        `Merge policy: ${mergePolicySummary}`
      ]
    : [
        `DarkFactory worker started for \`${target}\` from \`${TRIGGER}\`.`,
        "",
        `Branch: \`${branch}\``,
        `Task class: \`${taskRouting.taskClass}\``,
        `Requested model tier / effort: \`${modelRequest.modelTier}\` / \`${modelRequest.effort}\``,
        "Execution authority: canonical Agent OS manager state.",
        `Merge policy: ${mergePolicySummary}`
      ];
  return lines.join("\n");
}

function preflightBlockedComment(target, baseBranch, mergePolicy) {
  return [
    `DarkFactory blocked \`${target}\` before cloning or running a worker.`,
    "",
    "Blocker:",
    "",
    "```text",
    mergePolicy.reason,
    "```",
    "",
    `Target branch: \`${baseBranch}\``,
    `Repository auto-merge enabled: \`${mergePolicy.autoMergeSupported ? "yes" : "no"}\``,
    "",
    "This is target repository setup work, not a code implementation failure."
  ].join("\n");
}

function enforcementBlockedComment(target, baseBranch, enforcement) {
  return [
    `DarkFactory enforcement gate blocked \`${target}\` before cloning or running a worker.`,
    "",
    "Target branch:",
    "",
    `\`${baseBranch}\``,
    "",
    "Failed enforcement rules:",
    "",
    ...enforcement.findings
      .filter((finding) => finding.severity === "block")
      .map((finding) => `- **${finding.rule}**: ${finding.message}`),
    "",
    "This is a policy failure, not a code implementation failure."
  ].join("\n");
}

async function getIssue(repository, issueNumber) {
  const issue = await gh.request("GET", `/repos/${repoName(repository)}/issues/${issueNumber}`);
  if (issue.pull_request) {
    throw new Error(`${repoName(repository)}#${issueNumber} is a pull request, not an issue.`);
  }
  if (issue.state !== "open") {
    throw new Error(`${repoName(repository)}#${issueNumber} is not open.`);
  }
  return issue;
}

async function getIssueComments(repository, issueNumber) {
  const comments = [];
  for (let page = 1; page <= 10; page += 1) {
    const payload = await gh.request(
      "GET",
      `/repos/${repoName(repository)}/issues/${issueNumber}/comments?per_page=100&page=${page}`
    );
    if (!Array.isArray(payload)) throw new Error("GitHub issue comments response is malformed");
    comments.push(...payload.map((comment) => String(comment.body || "")));
    if (payload.length < 100) return comments;
  }
  throw new Error("Issue comment context exceeds the bounded pagination limit");
}

function issueVersion(issue) {
  return JSON.stringify({
    number: issue.number,
    state: issue.state,
    title: issue.title || "",
    body: issue.body || "",
    updatedAt: issue.updated_at || ""
  });
}

async function resolveWorkBaseBranch(repository, defaultBranch, requestedBranch = "") {
  if (requestedBranch) {
    await ensureBranchExists(repository, requestedBranch);
    return requestedBranch;
  }

  try {
    await ensureBranchExists(repository, "dev");
    return "dev";
  } catch (error) {
    if (error.status === 404) return defaultBranch;
    throw error;
  }
}

async function ensureBranchExists(repository, branch) {
  await gh.request("GET", `/repos/${repoName(repository)}/git/ref/heads/${encodeRefPath(branch)}`);
}

async function buildResumeInfo(repository, issueNumber) {
  if (RESUME_PR_NUMBER > 0) {
    if (RESUME_BRANCH || RESUME_HEAD) throw new Error("Resume PR cannot be combined with resume branch evidence");
    const pr = await fetchResumePullRequest(repository, RESUME_PR_NUMBER);
    if (darkFactoryWorkerIssueNumber(pr) !== issueNumber) {
      throw new Error(`Resume PR #${RESUME_PR_NUMBER} is not a worker PR for issue #${issueNumber}`);
    }
    if (!isDarkFactoryWorkerPullRequest(pr, repository)) {
      throw new Error(`Resume PR #${RESUME_PR_NUMBER} is not a DarkFactory worker PR`);
    }
    return {
      type: "pr",
      pr: {
        number: pr.number,
        html_url: pr.html_url,
        node_id: pr.node_id
      },
      branch: pr.headRefName,
      baseRef: pr.baseRefName
    };
  }

  if (RESUME_BRANCH || RESUME_HEAD) {
    if (!RESUME_BRANCH || !RESUME_HEAD) throw new Error("Resume branch and exact resume head are required together");
    const prefix = `df/${issueNumber}-`;
    const refs = await gh.request("GET", `/repos/${repoName(repository)}/git/matching-refs/heads/${encodeURIComponent(prefix)}`);
    const candidate = classifyWorkerBranchRefs(refs, issueNumber);
    if (candidate.type !== "branch" || candidate.branch !== RESUME_BRANCH || candidate.head !== RESUME_HEAD) {
      throw new Error("Resume branch evidence is missing, ambiguous, malformed, or changed");
    }
    return { type: "branch", branch: candidate.branch, head: candidate.head, baseRef: "" };
  }

  return null;
}

async function fetchResumePullRequest(repository, pullNumber) {
  const pull = await gh.request("GET", `/repos/${repoName(repository)}/pulls/${pullNumber}`);
  if (pull.state !== "open") {
    throw new Error(`Resume PR #${pullNumber} is not open`);
  }
  return {
    number: pull.number,
    html_url: pull.html_url,
    node_id: pull.node_id,
    title: pull.title || "",
    body: pull.body || "",
    headRefName: pull.head?.ref || "",
    baseRefName: pull.base?.ref || "",
    headRepository: {
      name: pull.head?.repo?.name || "",
      owner: { login: pull.head?.repo?.owner?.login || "" }
    },
    author: { login: pull.user?.login || "", type: pull.user?.type || "" }
  };
}

async function openOrReusePullRequest(repository, base, branch, issue, summary, resumeInfo) {
  if (resumeInfo?.type === "pr") {
    return resumeInfo.pr;
  }

  const existing = await findOpenWorkerPullRequestForIssue(gh, repository, TARGET_ISSUE_NUMBER);
  if (existing) return existing;

  return createPullRequest(repository, base, branch, issue, summary);
}

function workerSuccessComment(pullRequest, summary, automerge, resumeInfo) {
  const action = resumeInfo ? "updated" : "opened";
  return [
    `DarkFactory worker ${action} ${pullRequest.html_url}.`,
    "",
    "Execution authority: canonical Agent OS manager state.",
    `Automerge: ${automerge.enabled ? "enabled" : `not enabled (${automerge.reason})`}.`,
    "The issue stays `df:running` until DarkFactory verifies the worker claim against GitHub reality.",
    "",
    "Worker summary:",
    "",
    truncate(summary, 5000)
  ].join("\n");
}

async function replaceIssueLabels(repository, issueNumber, add, remove) {
  if (add.length) {
    await gh.request("POST", `/repos/${repoName(repository)}/issues/${issueNumber}/labels`, { labels: add });
  }
  for (const label of remove) {
    try {
      await gh.request("DELETE", `/repos/${repoName(repository)}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`);
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
}

async function createIssueComment(repository, issueNumber, body) {
  await gh.request("POST", `/repos/${repoName(repository)}/issues/${issueNumber}/comments`, { body });
}

async function markWorkerBlocked(repository, issueNumber, blocker) {
  // Removing df:running releases the stream lane for the next orchestrator tick.
  await replaceIssueLabels(repository, issueNumber, ["df:blocked"], ["df:ready", "df:running", "df:done"]);
  await createIssueComment(
    repository,
    issueNumber,
    [
      "DarkFactory worker blocked.",
      "",
      "Blocker:",
      "",
      "```text",
      truncate(blocker, 6000),
      "```"
    ].join("\n")
  );
}

async function cloneRepository(repository, worktree, branch) {
  const url = `https://github.com/${repoName(repository)}.git`;
  runGitWithAuth(["clone", "--depth", "1", "--branch", branch, url, worktree], process.cwd());
}

async function remoteBranchExists(repository, branch) {
  const refs = await gh.request(
    "GET",
    `/repos/${repoName(repository)}/git/matching-refs/heads/${encodeURIComponent(branch)}`
  );
  return Array.isArray(refs) && refs.some((ref) => ref.ref === `refs/heads/${branch}`);
}

async function blockStaleWorkerBranch(branch) {
  const message = [
    `Stale worker branch exists without an open worker PR. Owner/manual recovery is required.`,
    `Branch: ${branch}`,
    `DarkFactory found the branch before creating a new worker branch, but no open worker PR was found for #${TARGET_ISSUE_NUMBER}.`
  ].join(" ");

  await replaceIssueLabels(TARGET_REPO, TARGET_ISSUE_NUMBER, ["df:ask-owner", "df:blocked"], ["df:ready", "df:running", "df:done"]);
  await createIssueComment(
    TARGET_REPO,
    TARGET_ISSUE_NUMBER,
    [
      "DarkFactory blocked this worker before starting Agent OS execution.",
      "",
      "Blocker:",
      "",
      "```text",
      message,
      "```",
      "",
      "The stale branch must be deleted, connected to an open worker PR, or otherwise resolved by the owner before this issue can be retried."
    ].join("\n")
  );

  const askOwner = await upsertStaleBranchAskOwnerIssue(branch);
  return {
    action: "stale-worker-branch",
    result: "blocked",
    reason: "stale-worker-branch",
    branch,
    issue: `#${TARGET_ISSUE_NUMBER}`,
    ask_owner_issue: askOwner,
    message
  };
}

async function upsertStaleBranchAskOwnerIssue(branch) {
  // Recovery issues live in the CONTROL repository so owner decisions stay on
  // the central DarkFactory queue/dashboard regardless of which managed repo
  // the stale branch belongs to.
  const marker = `<!-- dark-factory:stale-worker-branch repo=${repoName(TARGET_REPO)} issue=${TARGET_ISSUE_NUMBER} branch=${slug(branch)} -->`;
  const title = `DarkFactory stale worker branch: ${repoName(TARGET_REPO)}#${TARGET_ISSUE_NUMBER}`;
  const body = [
    marker,
    "## Owner Decision Required",
    "",
    `Target repository: \`${repoName(TARGET_REPO)}\``,
    `Worker issue: #${TARGET_ISSUE_NUMBER}`,
    `Stale branch: \`${branch}\``,
    "",
    "DarkFactory cannot safely reuse or overwrite this branch because no open worker PR was found for the target issue.",
    "",
    "## Acceptance Criteria",
    "",
    "- Delete the stale branch, restore the missing worker PR, or document why the branch should be preserved.",
    "- Resolve the recorded owner decision and blocker; the system re-evaluates readiness automatically when it is safe to retry.",
    "",
    "## Token Use",
    "",
    "- AI tokens: 0 (deterministic worker preflight)."
  ].join("\n");
  const existing = await findOpenIssueByMarker(CONTROL_REPO, marker);

  if (existing) {
    const updated = await gh.request("PATCH", `/repos/${repoName(CONTROL_REPO)}/issues/${existing.number}`, {
      title,
      body
    });
    // The upsert path must enforce the escalation label on update as well as
    // create, or a recovery issue that lost df:ask-owner disappears from
    // label-driven dashboards and queues.
    await gh.request("POST", `/repos/${repoName(CONTROL_REPO)}/issues/${existing.number}/labels`, {
      labels: ["df:ask-owner"]
    });
    return `#${updated.number || existing.number}`;
  }

  const created = await gh.request("POST", `/repos/${repoName(CONTROL_REPO)}/issues`, {
    title,
    body,
    labels: ["df:ask-owner"]
  });
  return `#${created.number}`;
}

async function findOpenIssueByMarker(repository, marker) {
  for (let page = 1; page <= 10; page += 1) {
    const issues = await gh.request(
      "GET",
      `/repos/${repoName(repository)}/issues?state=open&per_page=100&page=${page}`
    );
    if (!Array.isArray(issues) || issues.length === 0) break;
    const found = issues.find((issue) => !issue.pull_request && String(issue.body || "").includes(marker));
    if (found) return found;
    if (issues.length < 100) break;
  }
  return null;
}

function verifyAgentOs() {
  runAgentCommand(["state", "doctor", "--json"], CONTROL_ROOT);
}

async function runAgentWorker({
  worktree,
  issue,
  issueComments,
  defaultBranch,
  taskRouting,
  modelRequest,
  resumeInfo,
  branch,
  repositoryPaths,
  validationCommands,
  tempRoot
}) {
  const controlRevision = gitOutput(["rev-parse", "HEAD"], CONTROL_ROOT);
  const checkedOutRevision = gitOutput(["rev-parse", "HEAD"], worktree);
  const issueLabels = Array.isArray(issue.labels)
    ? issue.labels.map((label) => typeof label === "string" ? label : label.name).filter(Boolean)
    : [];
  const verifiedFacts = [
    `Issue ${TARGET_ISSUE_NUMBER} is open and was read from ${repoName(TARGET_REPO)}.`,
    `Issue updated timestamp is ${issue.updated_at || "unavailable"}.`,
    `The checked-out base is ${defaultBranch}.`,
    `The checked-out repository revision before the turn is ${checkedOutRevision}.`,
    `Task classification is ${taskRouting.taskClass}.`
  ];
  if (resumeInfo?.type === "pr") {
    verifiedFacts.push(`This run resumes pull request ${resumeInfo.pr.number} on branch ${resumeInfo.branch}.`);
  } else if (resumeInfo?.type === "branch") {
    verifiedFacts.push(`This run resumes branch ${resumeInfo.branch}.`);
  }

  const turn = await executeModelTurn(
    {
      intent: {
        runId: `work-${TARGET_ISSUE_NUMBER}-${controlRevision.slice(0, 12)}`,
        triggeredBy: "workflow",
        profile: taskRouting.taskClass === "mechanical" ? "profile/low-mechanic" : "profile/implementer",
        repository: {
          owner: TARGET_REPO.owner,
          repo: TARGET_REPO.repo,
          defaultBranch
        },
        repositoryPaths,
        workItem: {
          kind: "issue",
          number: TARGET_ISSUE_NUMBER,
          author: issue.user?.login || "unknown",
          url: issue.html_url || `https://github.com/${repoName(TARGET_REPO)}/issues/${TARGET_ISSUE_NUMBER}`,
          title: issue.title || "",
          body: issue.body || "",
          comments: issueComments
        },
        draftIntent: null,
        policy: {
          branching: `Work only on the current issue branch from ${defaultBranch}; DarkFactory owns remote publication.`,
          labels: issueLabels,
          enforcement: "Do not push, merge, bypass gates, alter protected branches, or modify Agent OS state."
        },
        validation: { commands: validationCommands },
        effort: modelRequest.effort,
        verified: {
          observedAt: new Date().toISOString(),
          facts: verifiedFacts
        },
        controlRevision
      },
      request: modelRequest,
      promptsRoot: path.join(CONTROL_ROOT, "prompts"),
      tempRoot: path.join(tempRoot, "model-turns"),
      turnName: "implementation",
      cwd: worktree,
      executionPolicy: "workspace-write"
    },
    { agentRunArguments, validateAgentExecutionReceipt }
  );
  if (turn.receipt.outcome !== "success") {
    throw new ModelTurnError("provider_route_blocked", "Canonical Agent OS implementation route is unavailable", {
      prompt: turn.prompt,
      receipt: turn.receipt
    });
  }
  return {
    ...turn,
    output: validateWorkerOutput(turn.output, turn.prompt.selection.output, {
      repository: repoName(TARGET_REPO),
      workItem: TARGET_ISSUE_NUMBER,
      base: defaultBranch,
      head: branch
    })
  };
}

function validateWorkerOutput(raw, outputId, expectedTarget) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Worker result must be an object");
  if (Buffer.byteLength(JSON.stringify(raw), "utf8") > 256000) throw new Error("Worker result exceeds its evidence bound");
  const expected = outputId === "output/low-mechanic"
    ? ["schemaVersion", "status", "target", "transformation", "verification", "judgmentRequired", "evidence", "blockers"]
    : ["schemaVersion", "status", "target", "acceptance", "filesChanged", "validation", "residualRisks", "blockers", "evidence"];
  const actualKeys = Object.keys(raw).sort();
  const expectedKeys = [...expected].sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error(`Worker result must contain exactly: ${expectedKeys.join(", ")}`);
  }
  if (raw.schemaVersion !== 1) throw new Error("Worker result schemaVersion must be 1");
  const targetKeys = outputId === "output/low-mechanic"
    ? ["repository", "workItem", "path"]
    : ["repository", "workItem", "base", "head"];
  validateWorkerTarget(raw.target, targetKeys, expectedTarget);
  validateTextArray(raw.blockers, "Worker result blockers");
  validateEvidence(raw.evidence, "Worker result evidence");
  const expectedStatus = "completed";
  if (raw.status !== expectedStatus || raw.blockers.length > 0 || (outputId === "output/low-mechanic" && raw.judgmentRequired !== false)) {
    throw new Error(`Worker result blocked closed with status ${String(raw.status)}`);
  }
  if (outputId === "output/low-mechanic") {
    validateTextObject(
      raw.transformation,
      ["expectedBefore", "observedBefore", "expectedAfter", "observedAfter"],
      "Worker result transformation"
    );
    validateResultEvidence(raw.verification, ["check", "result", "evidence"], "Worker result verification");
    if (raw.verification.result !== "pass") throw new Error("Worker verification did not pass");
    return raw;
  }
  if (!Array.isArray(raw.acceptance) || raw.acceptance.length === 0 || raw.acceptance.length > 500) {
    throw new Error("Worker result acceptance must be a non-empty bounded array");
  }
  for (const [index, criterion] of raw.acceptance.entries()) {
    validateResultEvidence(criterion, ["criterionId", "result", "evidence"], `Worker acceptance ${index}`);
    if (criterion.result !== "pass") throw new Error(`Worker acceptance ${index} did not pass`);
  }
  validateTextArray(raw.filesChanged, "Worker result filesChanged");
  if ([...raw.filesChanged].sort().some((entry, index) => entry !== raw.filesChanged[index])) {
    throw new Error("Worker result filesChanged must be sorted");
  }
  if (!Array.isArray(raw.validation) || raw.validation.length === 0 || raw.validation.length > 100) {
    throw new Error("Worker result validation must be a non-empty bounded array");
  }
  for (const [index, validation] of raw.validation.entries()) {
    validateResultEvidence(validation, ["command", "result", "exitCode", "evidence"], `Worker validation ${index}`);
    if (validation.result !== "pass" || validation.exitCode !== 0) {
      throw new Error(`Worker validation ${index} did not pass`);
    }
  }
  validateTextArray(raw.residualRisks, "Worker result residualRisks");
  return raw;
}

function validateResultEvidence(value, keys, context) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${context} must be an object`);
  validateExactKeys(value, keys, context);
  for (const key of keys.filter((entry) => entry !== "exitCode")) validateBoundedText(value[key], `${context}.${key}`);
  if (keys.includes("exitCode") && (!Number.isSafeInteger(value.exitCode) || value.exitCode < 0)) {
    throw new Error(`${context}.exitCode must be a non-negative integer`);
  }
}

function validateTextObject(value, keys, context) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${context} must be an object`);
  validateExactKeys(value, keys, context);
  for (const key of keys) validateBoundedText(value[key], `${context}.${key}`);
}

function validateWorkerTarget(value, keys, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Worker result target must be an object");
  validateExactKeys(value, keys, "Worker result target");
  for (const key of keys.filter((entry) => entry !== "workItem")) {
    validateBoundedText(value[key], `Worker result target.${key}`);
  }
  if ((!Number.isSafeInteger(value.workItem) || value.workItem <= 0) && (typeof value.workItem !== "string" || !value.workItem.trim())) {
    throw new Error("Worker result target.workItem must identify the work item");
  }
  if (value.repository !== expected.repository || String(value.workItem) !== String(expected.workItem)) {
    throw new Error("Worker result target does not match the authorized repository and work item");
  }
  if (keys.includes("base") && (value.base !== expected.base || value.head !== expected.head)) {
    throw new Error("Worker result target does not match the authorized base and head");
  }
}

function validateEvidence(value, context) {
  if (!Array.isArray(value) || value.length > 500) throw new Error(`${context} must be a bounded array`);
  value.forEach((entry, index) => validateTextObject(entry, ["kind", "ref", "summary"], `${context} ${index}`));
}

function validateTextArray(value, context) {
  if (!Array.isArray(value) || value.length > 500) throw new Error(`${context} must be a bounded array`);
  value.forEach((entry, index) => validateBoundedText(entry, `${context}[${index}]`));
}

function validateBoundedText(value, context) {
  if (typeof value !== "string" || !value.trim() || value.length > 16000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new Error(`${context} must be bounded safe text`);
  }
}

function validateExactKeys(value, expected, context) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${context} must contain exactly: ${wanted.join(", ")}`);
  }
}

function workerSummary(output) {
  return truncate(JSON.stringify(output, null, 2), 10000);
}

function agentOsEnvironment() {
  return agentProcessEnvironment(process.env);
}

function runAgentCommand(args, cwd) {
  const agentsLauncher = canonicalAgentsLauncher();
  return runCommand(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-File", agentsLauncher, ...args],
    cwd,
    agentOsEnvironment()
  );
}

function canonicalAgentsLauncher() {
  const agentsHome = requiredEnv("AGENTS_HOME");
  if (!path.isAbsolute(agentsHome)) {
    throw new Error("AGENTS_HOME must be an absolute path");
  }
  const agentsLauncher = path.join(agentsHome, "bin", "agents.ps1");
  if (!existsSync(agentsLauncher)) {
    throw new Error(`Canonical Agent OS launcher is missing at ${agentsLauncher}`);
  }
  return agentsLauncher;
}

async function createPullRequest(repository, base, branch, issue, summary) {
  return await gh.request("POST", `/repos/${repoName(repository)}/pulls`, {
    title: issue.title,
    head: branch,
    base,
    body: [
      `<!-- dark-factory:worker-pr issue=${TARGET_ISSUE_NUMBER} -->`,
      "## DarkFactory Worker Summary",
      "",
      truncate(summary, 10000),
      "",
      "Executed through the canonical Agent OS manager state.",
      "",
      `Closes #${TARGET_ISSUE_NUMBER}`
    ].join("\n")
  });
}

async function enableAutoMerge(pullRequestId) {
  try {
    await gh.graphql(
      `mutation EnableAutoMerge($pullRequestId: ID!) {
        enablePullRequestAutoMerge(input: {pullRequestId: $pullRequestId, mergeMethod: SQUASH}) {
          pullRequest { url }
        }
      }`,
      { pullRequestId }
    );
    return { enabled: true, reason: "" };
  } catch (error) {
    return { enabled: false, reason: sanitize(error.message || String(error), TOKEN) };
  }
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

function encodeRefPath(ref) {
  return String(ref || "").split("/").map(encodeURIComponent).join("/");
}

function runCommand(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    env
  });
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit ${result.status}\n${sanitize(result.stdout || "", TOKEN)}\n${sanitize(result.stderr || "", TOKEN)}`.trim());
  }
  return result.stdout || "";
}

function truncate(value, maxLength) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n\n[truncated from ${value.length} characters]`;
}

async function writeLedger(ledger) {
  try {
    ledger.ledger = await writeRunLedger(gh, DATA_REPO, "df-work", repoName(TARGET_REPO), ledger);
    console.log(`DarkFactory ledger written to ${ledger.ledger.repository}/${ledger.ledger.path}`);
  } catch (error) {
    console.warn(sanitize(`DarkFactory ledger warning: ${error.message || String(error)}`, TOKEN));
  }
}
