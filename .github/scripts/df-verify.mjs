import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DARK_FACTORY_DATA_REPO,
  WORK_LABELS,
  assertAllowedRepo,
  createGithubClient,
  ensureLabels,
  isVerifiedWorkerIssue,
  parseRepo,
  parseWorkerClaim,
  readLatestRunLedger,
  repoName,
  requiredEnv,
  sanitize,
  slug,
  verifyWorkerClaim,
  writeRunLedger
} from "./df-lib.mjs";

const CONTROL_ROOT = pathToFileURL(new URL("../../", import.meta.url).href).pathname;
const TRIGGER = process.env.DF_TRIGGER ?? "unknown";
const DATA_REPO = process.env.DF_DATA_REPO ?? DARK_FACTORY_DATA_REPO;
const VERIFICATION_MARKER = "<!-- dark-factory:worker-verification -->";
const BLOCKER_ISSUE_MARKER = "<!-- dark-factory:verification-blocker";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const token = process.env.DARK_FACTORY_TOKEN || "";
    console.error(String(error.stack || error.message || error).split(token).join("***"));
    process.exitCode = 1;
  });
}

export async function main(options = {}) {
  const token = options.token || requiredEnv("DARK_FACTORY_TOKEN");
  const controlRepo = options.controlRepo || parseRepo(requiredEnv("DF_CONTROL_REPO"));
  const target = options.targetRepo && options.issueNumber
    ? { targetRepo: options.targetRepo, issueNumber: options.issueNumber }
    : await readVerificationTarget(options.verificationTargetFile || requiredEnv("DF_VERIFICATION_TARGET_FILE"));
  const targetRepo = target.targetRepo;
  const issueNumber = target.issueNumber;
  const dataRepo = options.dataRepo || DATA_REPO;
  const trigger = options.trigger || TRIGGER;
  const gh = options.gh || createGithubClient(token, "darkfactory-verify");

  assertAllowedRepo(targetRepo);

  const result = await verifyWorkerRun(gh, {
    controlRepo,
    targetRepo,
    issueNumber,
    dataRepo,
    trigger,
    dryRun: options.dryRun === true,
    log: options.log || console.log,
    warn: options.warn || console.warn
  });

  if (!options.gh && !options.dryRun) {
    try {
      await writeRunLedger(gh, dataRepo, "df-verify", repoName(targetRepo), {
        trigger,
        issue: `${repoName(targetRepo)}#${issueNumber}`,
        verified: result.verified,
        mismatches: result.mismatches,
        claim: result.claim,
        pull_request: result.pullRequest ? {
          number: result.pullRequest.number,
          url: result.pullRequest.html_url || result.pullRequest.url
        } : null,
        actions: result.actions,
        token_usage: {
          codex_calls: 0,
          input_tokens: 0,
          output_tokens: 0,
          note: "Worker claim verification is deterministic and uses no model calls"
        }
      });
    } catch (error) {
      console.warn(`DarkFactory verification ledger warning: ${sanitize(error.message || String(error), token)}`);
    }
  }

  return result;
}

export async function readVerificationTarget(filePath) {
  let payload;
  try {
    payload = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid DarkFactory verification target artifact: ${error.message || String(error)}`);
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid DarkFactory verification target artifact: expected an object.");
  }

  const targetRepo = parseRepo(typeof payload.repo === "string" ? payload.repo : "");
  const issueNumber = Number(payload.issue_number);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`Invalid DarkFactory verification target issue: ${payload.issue_number}`);
  }

  return { targetRepo, issueNumber };
}

export async function verifyWorkerRun(gh, options) {
  const {
    controlRepo,
    targetRepo,
    issueNumber,
    dataRepo,
    trigger,
    dryRun = false,
    log = console.log,
    warn = console.warn
  } = options;

  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`Invalid issue number: ${issueNumber}`);
  }

  await ensureLabels(gh, targetRepo, WORK_LABELS);

  const ledger = await readLatestRunLedger(gh, dataRepo, "df-work", repoName(targetRepo));
  const claim = ledger ? parseWorkerClaim(ledger) : null;
  const targetRef = `${repoName(targetRepo)}#${issueNumber}`;

  if (!ledger) {
    const mismatches = [`No df-work ledger found for ${targetRef}; cannot verify an unreported worker run.`];
    if (!dryRun) {
      await blockWorkerIssue(gh, targetRepo, issueNumber, mismatches);
      await upsertVerificationBlockerIssue(gh, controlRepo, targetRepo, issueNumber, mismatches);
    }
    return {
      verified: false,
      mismatches,
      claim: null,
      issue: null,
      pullRequest: null,
      actions: [{ action: "block", reason: "missing-ledger" }]
    };
  }

  if (!claim) {
    const mismatches = [`Latest df-work ledger for ${targetRef} does not contain a parseable worker claim.`];
    if (!dryRun) {
      await blockWorkerIssue(gh, targetRepo, issueNumber, mismatches);
      await upsertVerificationBlockerIssue(gh, controlRepo, targetRepo, issueNumber, mismatches);
    }
    return {
      verified: false,
      mismatches,
      claim: null,
      issue: null,
      pullRequest: null,
      actions: [{ action: "block", reason: "unparseable-claim" }]
    };
  }

  log(`DarkFactory verifying worker claim for ${targetRef}: branch=${claim.branch}, provider=${claim.provider}`);
  const verification = await verifyWorkerClaim(gh, claim, targetRepo, issueNumber);

  if (verification.verified) {
    if (!dryRun) {
      await markWorkerVerified(gh, targetRepo, issueNumber, claim, verification.pullRequest);
    }
    log(`DarkFactory verified worker claim for ${targetRef}: PR #${verification.pullRequest.number}.`);
    return {
      verified: true,
      mismatches: [],
      claim,
      issue: verification.issue,
      pullRequest: verification.pullRequest,
      actions: [{ action: "verify", pr: verification.pullRequest.number }]
    };
  }

  if (!dryRun) {
    await blockWorkerIssue(gh, targetRepo, issueNumber, verification.mismatches);
    await upsertVerificationBlockerIssue(gh, controlRepo, targetRepo, issueNumber, verification.mismatches);
  }
  warn(`DarkFactory rejected worker claim for ${targetRef}: ${verification.mismatches.join("; ")}`);
  return {
    verified: false,
    mismatches: verification.mismatches,
    claim,
    issue: verification.issue,
    pullRequest: verification.pullRequest,
    actions: [{ action: "block", reason: "claim-mismatch" }]
  };
}

async function markWorkerVerified(gh, repository, issueNumber, claim, pullRequest) {
  await replaceIssueLabels(gh, repository, issueNumber, ["df:done"], ["df:ready", "df:running", "df:blocked"]);
  const marker = `${VERIFICATION_MARKER} issue=${issueNumber}`;
  const comments = await listIssueComments(gh, repository, issueNumber);
  const alreadyCommented = comments.some((comment) => String(comment.body || "").includes(marker));
  if (!alreadyCommented) {
    await gh.request("POST", `/repos/${repoName(repository)}/issues/${issueNumber}/comments`, {
      body: [
        marker,
        "DarkFactory verified this worker result against GitHub reality.",
        "",
        `- Claimed PR: ${pullRequest.html_url || `#${pullRequest.number}`}`,
        `- Branch: \`${claim.branch}\``,
        `- Base: \`${pullRequest.base?.ref || claim.baseBranch || "unknown"}\``,
        `- Requested tier / effort: \`${claim.requestedModelTier}\` / \`${claim.requestedEffort}\``,
        `- Resolved route: \`${claim.provider}\` / \`${claim.model}\` / \`${claim.agentPreset}\``,
        `- Provider version: \`${claim.providerVersion}\``,
        `- Attempts: \`${claim.attempts}\``,
        `- Usage: \`${claim.usage.inputTokens}\` input / \`${claim.usage.outputTokens}\` output tokens`,
        "",
        "The issue is marked `df:done` and follow-through may merge the verified PR."
      ].join("\n")
    });
  }
}

async function blockWorkerIssue(gh, repository, issueNumber, mismatches) {
  await replaceIssueLabels(gh, repository, issueNumber, ["df:blocked"], ["df:ready", "df:running", "df:done"]);
  const marker = `${VERIFICATION_MARKER} issue=${issueNumber} reason=claim-mismatch`;
  const comments = await listIssueComments(gh, repository, issueNumber);
  const alreadyCommented = comments.some((comment) => String(comment.body || "").includes(marker));
  if (!alreadyCommented) {
    await gh.request("POST", `/repos/${repoName(repository)}/issues/${issueNumber}/comments`, {
      body: [
        marker,
        "DarkFactory rejected this worker result because the claim does not match GitHub reality.",
        "",
        "Mismatches:",
        ...mismatches.map((mismatch) => `- ${mismatch}`),
        "",
        "The issue is marked `df:blocked` until the mismatch is resolved."
      ].join("\n")
    });
  }
}

async function upsertVerificationBlockerIssue(gh, controlRepo, targetRepo, issueNumber, mismatches) {
  const marker = `${BLOCKER_ISSUE_MARKER} repo=${repoName(targetRepo)} issue=${issueNumber} -->`;
  const title = `DarkFactory verification blocker: ${repoName(targetRepo)}#${issueNumber}`;
  const body = [
    marker,
    "## Worker Claim Rejected",
    "",
    `Target repository: \`${repoName(targetRepo)}\``,
    `Worker issue: #${issueNumber}`,
    "",
    "### Mismatches",
    ...mismatches.map((mismatch) => `- ${mismatch}`),
    "",
    "## Acceptance Criteria",
    "",
    "- Resolve the mismatch between the worker claim and GitHub reality.",
    "- Remove `df:blocked` from the original worker issue and reapply `df:ready` if a new worker run is needed.",
    "",
    "## Token Use",
    "",
    "- AI tokens: 0 (deterministic claim verification)."
  ].join("\n");

  const existing = await findOpenIssueByMarker(gh, controlRepo, marker);
  if (existing) {
    await gh.request("PATCH", `/repos/${repoName(controlRepo)}/issues/${existing.number}`, { title, body });
    await gh.request("POST", `/repos/${repoName(controlRepo)}/issues/${existing.number}/labels`, {
      labels: ["df:ask-owner"]
    });
    return `#${existing.number}`;
  }

  const created = await gh.request("POST", `/repos/${repoName(controlRepo)}/issues`, {
    title,
    body,
    labels: ["df:ask-owner"]
  });
  return `#${created.number}`;
}

async function findOpenIssueByMarker(gh, repository, marker) {
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

async function listIssueComments(gh, repository, issueNumber) {
  const comments = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await gh.request(
      "GET",
      `/repos/${repoName(repository)}/issues/${issueNumber}/comments?per_page=100&page=${page}`
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    comments.push(...batch);
    if (batch.length < 100) break;
  }
  return comments;
}

async function replaceIssueLabels(gh, repository, issueNumber, add, remove) {
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
