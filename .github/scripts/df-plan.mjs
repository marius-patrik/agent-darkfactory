import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_DATA_REPO,
  PLANNING_LABELS,
  WORK_LABELS,
  assertAllowedRepo,
  createGithubClient,
  driftIssueBody,
  ensureLabels,
  extractClosingIssueNumbers,
  findDriftMarker,
  findPrdMarker,
  getOptionalFileContent,
  getRepository,
  humanClosedPrdAskOwnerBody,
  isActiveManagedRepo,
  isDarkFactoryActor,
  listActiveManagedRepos,
  listIssues,
  readManagedRepoRegistry,
  parsePrdItems,
  parseRepo,
  plannedIssueLabelDiff,
  prdIssueBody,
  repoName,
  requiredEnv,
  slug,
  warnReadOnlyRepository,
  writeRunLedger
} from "./df-lib.mjs";

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}

async function main() {
  const token = requiredEnv("DARK_FACTORY_TOKEN");
  const controlRepo = parseRepo(requiredEnv("DF_CONTROL_REPO"));
  const dataRepo = process.env.DF_DATA_REPO ?? DEFAULT_DATA_REPO;
  const trigger = process.env.DF_TRIGGER ?? "unknown";
  const targetRef = process.env.DF_TARGET_REF?.trim() || "";
  const planAll = process.env.DF_PLAN_ALL === "true";
  const gh = createGithubClient(token, "darkfactory-plan");
  let targetRepo = parseRepo(process.env.DF_TARGET_REPO?.trim() || repoName(controlRepo));

  const registry = await readManagedRepoRegistry();
  const targets = planAll ? await listActiveManagedRepos(gh, controlRepo, { registry }) : [targetRepo];
  for (const target of targets) {
    targetRepo = target;
    if (!isActiveManagedRepo(targetRepo, registry)) {
      console.warn(`DarkFactory planning skipped ${repoName(targetRepo)} because managed lifecycle state is not active.`);
      continue;
    }
    try {
      await reconcileRepository({ gh, targetRepo, controlRepo, dataRepo, trigger, sourceRef: targetRef, planAll });
    } catch (error) {
      if (warnReadOnlyRepository(targetRepo, error, "planning")) continue;
      throw error;
    }
  }
}

export async function reconcileRepository(options) {
  const {
    gh,
    targetRepo,
    controlRepo,
    dataRepo,
    trigger = "unknown",
    sourceRef: sourceRefInput = "",
    planAll = false,
    writeLedger: shouldWriteLedger = true
  } = options;

  assertAllowedRepo(targetRepo);
  const repo = await getRepository(gh, targetRepo);
  if (repo.archived === true || repo.disabled === true) {
    console.warn(`DarkFactory planning skipped ${repoName(targetRepo)} because GitHub reports archived=${repo.archived === true} disabled=${repo.disabled === true}.`);
    return;
  }

  await ensureLabels(gh, targetRepo, [...PLANNING_LABELS, ...WORK_LABELS]);
  const sourceRef = planAll ? repo.default_branch : sourceRefInput || repo.default_branch;
  const prdSources = await getPrdSources(gh, targetRepo, sourceRef);
  const ledger = {
    trigger,
    default_branch: repo.default_branch,
    source_ref: sourceRef,
    prd_files: prdSources.map((source) => source.path),
    actions: [],
    token_usage: {
      codex_calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      note: "L4 planning used deterministic PRD parsing only"
    }
  };

  if (prdSources.length === 0) {
    const issue = await upsertDriftIssue(targetRepo, [`No \`PRD.md\` files were found on \`${sourceRef}\`.`]);
    ledger.actions.push({ action: "drift-report", reason: "missing-prd", issue });
    await writeLedger(gh, ledger, { shouldWriteLedger });
    return;
  }

  const items = prdSources.flatMap((source) => parsePrdItems(source.content, source.path));
  const issues = await listIssues(gh, targetRepo, "all");
  const byMarker = new Map();
  const driftIssues = [];

  for (const issue of issues) {
    const marker = findPrdMarker(issue.body || "");
    if (marker) byMarker.set(marker, issue);
    if (findDriftMarker(issue.body || "")) driftIssues.push(issue);
  }

  const expectedMarkers = new Set(items.map((item) => item.marker));
  let previousIssueNumber = null;
  let previousOpenIssueNumber = null;

  for (const item of items) {
    const existing = byMarker.get(item.marker);
    const labels = [item.priority, "roadmap", `df:class:${item.taskClass}`];

    if (item.completed) {
      if (!existing) {
        const created = await gh.request("POST", `/repos/${repoName(targetRepo)}/issues`, {
          title: item.title,
          body: prdIssueBody(item, previousIssueNumber ? [previousIssueNumber] : []),
          labels
        });
        const closed = await gh.request("PATCH", `/repos/${repoName(targetRepo)}/issues/${created.number}`, {
          state: "closed"
        });
        await gh.request("POST", `/repos/${repoName(targetRepo)}/issues/${created.number}/comments`, {
          body: "DarkFactory L4 planning created and closed this issue because the PRD already marks this item as completed."
        });
        ledger.actions.push({ action: "create-closed-completed-prd-issue", marker: item.marker, issue: issueRef(closed) });
        previousIssueNumber = closed.number;
        continue;
      }
      if (existing.state === "closed") {
        ledger.actions.push({ action: "keep-closed", marker: item.marker, issue: issueRef(existing) });
        previousIssueNumber = existing.number;
        continue;
      }
      const closed = await gh.request("PATCH", `/repos/${repoName(targetRepo)}/issues/${existing.number}`, {
        state: "closed"
      });
      await gh.request("POST", `/repos/${repoName(targetRepo)}/issues/${existing.number}/comments`, {
        body: "DarkFactory L4 planning closed this issue because the PRD marks this item as completed."
      });
      ledger.actions.push({ action: "close-completed-prd-issue", marker: item.marker, issue: issueRef(closed) });
      previousIssueNumber = closed.number;
      continue;
    }

    // Keep deterministic PRD-order references even when the predecessor is
    // already closed, but only an unfinished predecessor blocks readiness.
    const blockedBy = previousIssueNumber ? [previousIssueNumber] : [];
    if (previousOpenIssueNumber === null) labels.push("df:ready");
    const body = prdIssueBody(item, blockedBy);

    if (!existing) {
      // Create the issue without the df:ready label; add it in a separate call so
      // GitHub emits a trusted `issues:labeled` event that the L3 worker trigger
      // can react to.
      const createLabels = labels.filter((label) => label !== "df:ready");
      const created = await gh.request("POST", `/repos/${repoName(targetRepo)}/issues`, {
        title: item.title,
        body,
        labels: createLabels
      });
      const labelUpdate = await setIssueLabels(gh, targetRepo, created.number, labels);
      const dispatch = await dispatchIfNewlyReady(targetRepo, created.number, labelUpdate);
      ledger.actions.push({ action: "create-issue", marker: item.marker, issue: issueRef(created), labels });
      if (dispatch) ledger.actions.push(dispatch);
      previousIssueNumber = created.number;
      previousOpenIssueNumber = created.number;
      continue;
    }

    if (existing.state === "closed") {
      const closer = await findIssueCloser(gh, targetRepo, existing.number);
      if (closer && !isDarkFactoryActor(closer.login)) {
        const escalation = await escalateHumanClosedPrdIssue(gh, targetRepo, controlRepo, existing, item);
        ledger.actions.push({
          action: "escalate-human-closed-prd-issue",
          marker: item.marker,
          issue: issueRef(existing),
          escalation
        });
        previousIssueNumber = existing.number;
        continue;
      }

      const reopened = await gh.request("PATCH", `/repos/${repoName(targetRepo)}/issues/${existing.number}`, {
        title: item.title,
        body,
        state: "open"
      });
      const labelUpdate = await setIssueLabels(gh, targetRepo, existing.number, labels, { preserveWorkerState: false });
      const dispatch = await dispatchIfNewlyReady(targetRepo, existing.number, labelUpdate);
      ledger.actions.push({ action: "reopen-prd-issue", marker: item.marker, issue: issueRef(reopened), labels });
      if (dispatch) ledger.actions.push(dispatch);
      previousIssueNumber = reopened.number;
      previousOpenIssueNumber = reopened.number;
      continue;
    }

    // For open issues, apply the deterministic current-PRD sequence. Patch only
    // the Blocked-by section when sequencing changes; rewrite the whole body
    // when the PRD item content itself changes.
    const expectedBlockedBy = blockedBy;
    const existingBlockedBy = extractBlockedBy(existing.body || "");
    const contentBody = prdIssueBody(item, []);
    const contentChanged = removeBlockedBySection(existing.body || "").trim() !== contentBody.trim();
    const sequencingChanged = existingBlockedBy.join(",") !== expectedBlockedBy.join(",");

    const update = {};
    if (existing.title !== item.title) update.title = item.title;
    if (contentChanged) {
      update.body = prdIssueBody(item, expectedBlockedBy);
    } else if (sequencingChanged) {
      update.body = applyBlockedBy(existing.body || "", expectedBlockedBy);
    }
    if (Object.keys(update).length) {
      const updated = await gh.request("PATCH", `/repos/${repoName(targetRepo)}/issues/${existing.number}`, update);
      ledger.actions.push({ action: "update-issue", marker: item.marker, issue: issueRef(updated), fields: Object.keys(update) });
    }
    const labelUpdate = await setIssueLabels(gh, targetRepo, existing.number, labels);
    ledger.actions.push({ action: "sequence-labels", marker: item.marker, issue: issueRef(existing), labels });
    const dispatch = await dispatchIfNewlyReady(targetRepo, existing.number, labelUpdate);
    if (dispatch) ledger.actions.push(dispatch);
    previousIssueNumber = existing.number;
    previousOpenIssueNumber = existing.number;
  }

  const staleMarkedIssues = [...byMarker.values()].filter((issue) => {
    const marker = findPrdMarker(issue.body || "");
    return issue.state === "open" && marker && !expectedMarkers.has(marker);
  });

  for (const issue of staleMarkedIssues) {
    await gh.request("POST", `/repos/${repoName(targetRepo)}/issues/${issue.number}/comments`, {
      body: "DarkFactory L4 planning closed this issue because its `df-prd:` marker is no longer present in any tracked `PRD.md` file."
    });
    await gh.request("PATCH", `/repos/${repoName(targetRepo)}/issues/${issue.number}`, { state: "closed" });
    ledger.actions.push({ action: "close-stale-prd-issue", issue: issueRef(issue) });
  }

  const driftFindings = await detectCodeDrift(gh, targetRepo, repo.default_branch, items, staleMarkedIssues);
  if (driftFindings.length) {
    const driftIssue = await upsertDriftIssue(gh, targetRepo, driftFindings);
    ledger.actions.push({ action: "drift-report", issue: driftIssue, findings: driftFindings });
  } else {
    for (const issue of driftIssues.filter((issue) => issue.state === "open")) {
      await gh.request("POST", `/repos/${repoName(targetRepo)}/issues/${issue.number}/comments`, {
        body: "DarkFactory L4 planning no longer detects this drift condition."
      });
      await gh.request("PATCH", `/repos/${repoName(targetRepo)}/issues/${issue.number}`, { state: "closed" });
      ledger.actions.push({ action: "close-resolved-drift", issue: issueRef(issue) });
    }
  }

  await writeLedger(gh, ledger, { shouldWriteLedger });
  console.log(`DarkFactory planning reconciled ${items.length} PRD items for ${repoName(targetRepo)}.`);
  return { ledger };
}

async function getPrdSources(gh, repository, ref) {
  const paths = await listPrdPaths(gh, repository, ref);
  const sources = [];
  for (const filePath of paths) {
    const content = await getOptionalFileContent(gh, repository, filePath, ref);
    if (content) sources.push({ path: filePath, content });
  }
  return sources;
}

async function listPrdPaths(gh, repository, ref) {
  try {
    const tree = await getRecursiveTree(gh, repository, ref);
    const paths = (tree.tree || [])
      .filter((entry) => entry.type === "blob" && (entry.path === "PRD.md" || entry.path.endsWith("/PRD.md")))
      .map((entry) => entry.path)
      .sort((a, b) => {
        if (a === "PRD.md") return -1;
        if (b === "PRD.md") return 1;
        return a.localeCompare(b);
      });
    return paths;
  } catch (error) {
    if (error.status !== 404) throw error;
    const root = await getOptionalFileContent(gh, repository, "PRD.md", ref);
    return root ? ["PRD.md"] : [];
  }
}

async function getRecursiveTree(gh, repository, ref) {
  try {
    return await gh.request(
      "GET",
      `/repos/${repoName(repository)}/git/trees/${encodeURIComponent(ref)}?recursive=1`
    );
  } catch (error) {
    if (error.status !== 404 && error.status !== 409 && error.status !== 422) throw error;
    const commit = await gh.request("GET", `/repos/${repoName(repository)}/git/commits/${encodeURIComponent(ref)}`);
    const treeSha = commit?.tree?.sha;
    if (typeof treeSha !== "string" || !/^[0-9a-f]{40}$/i.test(treeSha)) throw error;
    return await gh.request(
      "GET",
      `/repos/${repoName(repository)}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`
    );
  }
}

async function setIssueLabels(gh, repository, issueNumber, labels, options = {}) {
  const current = await gh.request("GET", `/repos/${repoName(repository)}/issues/${issueNumber}`);
  const currentNames = new Set(
    (current.labels || []).map((label) => typeof label === "string" ? label : label.name).filter(Boolean)
  );
  const { add, remove } = plannedIssueLabelDiff([...currentNames], labels, options);

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
  return { add, remove };
}

async function dispatchIfNewlyReady(repository, issueNumber, labelUpdate) {
  if (!labelUpdate.add.includes("df:ready")) return null;
  return await dispatchReadyWorker(repository, issueNumber);
}

async function dispatchReadyWorker(repository, issueNumber) {
  // Planning never dispatches privileged workers with a repository-scoped token.
  // It queues readiness; the trusted control orchestrator dispatches workers
  // with the GitHub App installation token.
  return {
    action: "queue-worker",
    repo: repoName(repository),
    issue: `#${issueNumber}`,
    reason: "await-control-orchestrator"
  };
}

async function detectCodeDrift(gh, repository, ref, items, staleMarkedIssues) {
  const findings = staleMarkedIssues.map((issue) => {
    const marker = findPrdMarker(issue.body || "");
    return `Backlog issue #${issue.number} still had stale marker \`${marker}\` after the PRD item was removed.`;
  });
  const itemText = items.map((item) => `${item.name} ${item.description}`).join("\n").toLowerCase();

  findings.push(...await detectPrdArtifactDrift(gh, repository, ref, itemText));

  if (itemText.includes("l4 planning")) {
    const workflow = await getOptionalFileContent(gh, repository, ".github/workflows/df-plan.yml", ref);
    if (!workflow) findings.push("PRD requires L4 Planning, but `.github/workflows/df-plan.yml` is absent.");
  }

  if (itemText.includes("l3 work")) {
    const workflow = await getOptionalFileContent(gh, repository, ".github/workflows/df-work.yml", ref);
    if (!workflow) findings.push("PRD requires L3 Work, but `.github/workflows/df-work.yml` is absent.");
  }

  // General drift: open issues or PRs that are not tied to a PRD-tracked issue.
  // The PRD is the source of truth, so open planned work without a PRD marker is
  // a contradiction between the backlog and the PRD.
  const openIssues = await listIssues(gh, repository, "open");
  const prdTrackedNumbers = new Set(
    openIssues
      .filter((issue) => !issue.pull_request && findPrdMarker(issue.body || ""))
      .map((issue) => issue.number)
  );

  for (const issue of openIssues) {
    if (issue.pull_request) continue;
    if (findPrdMarker(issue.body || "")) continue;
    const labels = (issue.labels || []).map((label) => typeof label === "string" ? label : label.name);
    if (labels.includes("df:prd-drift") || labels.includes("df:ask-owner")) continue;
    if (!isDarkFactoryManagedIssue(labels)) continue;
    findings.push(`Open issue #${issue.number} is not tracked by any PRD item.`);
  }

  const pulls = await listOpenPullRequests(gh, repository);
  for (const pull of pulls) {
    const closes = extractClosingIssueNumbers(pull.body || "", repoName(repository));
    const linkedToPrd = closes.some((number) => prdTrackedNumbers.has(number));
    if (!linkedToPrd) {
      findings.push(`Open PR #${pull.number} is not linked to a PRD-tracked issue.`);
    }
  }

  return findings;
}

async function detectPrdArtifactDrift(gh, repository, ref, itemText) {
  const findings = [];
  const rules = [
    {
      capability: "PRD editing to automatically reconcile sequenced backlog issues",
      pattern: /\b(l4 planning|planning loop|prd enforcement|prd\W*backlog|reconciliation|editing prd\.md|prd edits?|sequenced issues)\b/i,
      artifacts: [
        {
          path: ".github/workflows/df-plan.yml",
          checks: [
            { snippet: "PRD.md", reason: "listen for PRD file changes" },
            { snippet: "schedule:", reason: "run recurring reconciliation" },
            { snippet: "workflow_dispatch:", reason: "support manual reconciliation" }
          ]
        },
        {
          path: ".github/scripts/df-plan.mjs",
          checks: [
            { snippet: "parsePrdItems", reason: "parse PRD items deterministically" },
            { snippet: "prdIssueBody", reason: "write PRD-backed issue bodies" },
            { snippet: "Blocked-by", reason: "maintain sequencing references" },
            { snippet: "df:ready", reason: "queue newly unblocked PRD issues" }
          ]
        }
      ]
    },
    {
      capability: "PRD drift reporting when code or backlog contradicts the PRD",
      pattern: /\b(drift report|prd drift|code contradicts prd|contradicts the prd|not tracked by any prd item|not linked to a prd-tracked issue)\b/i,
      artifacts: [
        {
          path: ".github/scripts/df-plan.mjs",
          checks: [
            { snippet: "detectCodeDrift", reason: "detect PRD contradictions" },
            { snippet: "upsertDriftIssue", reason: "file or update a drift report issue" },
            { snippet: "df-prd-drift", reason: "mark drift reports for idempotent updates" }
          ]
        }
      ]
    }
  ];

  for (const rule of rules) {
    if (!rule.pattern.test(itemText)) continue;
    for (const artifact of rule.artifacts) {
      const content = await getOptionalFileContent(gh, repository, artifact.path, ref);
      if (!content) {
        findings.push(`PRD requires ${rule.capability}, but \`${artifact.path}\` is absent.`);
        continue;
      }
      const checkContent = artifactContentForChecks(artifact.path, content);
      for (const check of artifact.checks) {
        if (!checkContent.includes(check.snippet)) {
          findings.push(`PRD requires ${rule.capability}, but \`${artifact.path}\` does not ${check.reason}.`);
        }
      }
    }
  }

  return findings;
}

function artifactContentForChecks(filePath, content) {
  if (filePath !== ".github/scripts/df-plan.mjs") return content;
  return content.replace(
    /\nasync function detectPrdArtifactDrift[\s\S]*?\nfunction isDarkFactoryManagedIssue/,
    "\nfunction isDarkFactoryManagedIssue"
  );
}

function isDarkFactoryManagedIssue(labels) {
  return labels.includes("roadmap") || labels.some((label) => /^df:(ready|running|blocked|done|class:)/.test(label));
}

async function listOpenPullRequests(gh, repository) {
  const pulls = [];
  for (let page = 1; page <= 20; page += 1) {
    const batch = await gh.request(
      "GET",
      `/repos/${repoName(repository)}/pulls?state=open&per_page=100&page=${page}`
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    pulls.push(...batch);
    if (batch.length < 100) break;
  }
  return pulls;
}

async function upsertDriftIssue(gh, repository, findings) {
  const marker = `df-prd-drift:${slug(repoName(repository))}`;
  const issues = await listIssues(gh, repository, "all");
  const existing = issues.find((issue) => (issue.body || "").includes(marker));
  const body = driftIssueBody(repoName(repository), findings);
  const title = `PRD drift report - ${repoName(repository)}`;

  if (existing) {
    const updated = await gh.request("PATCH", `/repos/${repoName(repository)}/issues/${existing.number}`, {
      title,
      body,
      state: "open"
    });
    await setIssueLabels(gh, repository, existing.number, ["P1", "df:prd-drift", "df:class:standard"]);
    return issueRef(updated);
  }

  const created = await gh.request("POST", `/repos/${repoName(repository)}/issues`, {
    title,
    body,
    labels: ["P1", "df:prd-drift", "df:class:standard"]
  });
  return issueRef(created);
}

async function findIssueCloser(gh, repository, issueNumber) {
  const events = [];
  for (let page = 1; page <= 5; page += 1) {
    const batch = await gh.request(
      "GET",
      `/repos/${repoName(repository)}/issues/${issueNumber}/timeline?per_page=100&page=${page}`
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    events.push(...batch);
    if (batch.length < 100) break;
  }
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].event === "closed") {
      return events[i].actor || null;
    }
  }
  return null;
}

async function escalateHumanClosedPrdIssue(gh, targetRepo, controlRepo, issue, item) {
  const targetRepoName = repoName(targetRepo);
  const closer = await findIssueCloser(gh, targetRepo, issue.number);
  const closerName = closer?.login ? `@${closer.login}` : "a human";
  const commentBody = `DarkFactory L4 planning noticed this issue was closed by ${closerName}, but the PRD still lists \`${item.name}\` as incomplete. DarkFactory will not reopen it automatically. An ask-owner escalation has been created in the control repository to resolve the disagreement.`;
  await gh.request("POST", `/repos/${targetRepoName}/issues/${issue.number}/comments`, { body: commentBody });
  const askOwner = await upsertAskOwnerIssue(gh, controlRepo, targetRepoName, issue, item);
  return { target_issue: issueRef(issue), ask_owner_issue: askOwner, closer: closer?.login || null };
}

async function upsertAskOwnerIssue(gh, controlRepo, targetRepoName, targetIssue, item) {
  const marker = `df-ask-owner:human-closed-prd:${slug(targetRepoName)}:${item.slug}`;
  const issues = await listIssues(gh, controlRepo, "all");
  const existing = issues.find((issue) => (issue.body || "").includes(marker));
  const title = `Human-closed PRD item in ${targetRepoName} — ${item.name}`;
  const body = humanClosedPrdAskOwnerBody(targetRepoName, targetIssue, item);
  const labels = [item.priority || "P1", "df:ask-owner", `df:class:${item.taskClass || "standard"}`];

  await ensureLabels(gh, controlRepo, WORK_LABELS);

  if (existing) {
    const updated = await gh.request("PATCH", `/repos/${repoName(controlRepo)}/issues/${existing.number}`, {
      title,
      body,
      state: "open"
    });
    await setIssueLabels(gh, controlRepo, existing.number, labels, { preserveWorkerState: false });
    return issueRef(updated);
  }

  const created = await gh.request("POST", `/repos/${repoName(controlRepo)}/issues`, {
    title,
    body,
    labels
  });
  return issueRef(created);
}

async function writeLedger(gh, ledger, { shouldWriteLedger = true } = {}) {
  if (!shouldWriteLedger) return;
  try {
    const written = await writeRunLedger(gh, dataRepo, "df-plan", repoName(targetRepo), ledger);
    console.log(`DarkFactory ledger written to ${written.repository}/${written.path}`);
  } catch (error) {
    console.warn(`DarkFactory ledger warning: ${error.message || String(error)}`);
  }
}

function extractBlockedBy(body) {
  const numbers = [];
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^Blocked-by:\s*#(\d+)\s*$/i);
    if (match) numbers.push(Number(match[1]));
  }
  return numbers;
}

function removeBlockedBySection(body) {
  const parts = body.split("\n## Planning Notes\n");
  let prefix = parts[0];
  prefix = prefix.replace(/\n## Sequencing\n[\s\S]*$/, "");
  return parts.length > 1 ? `${prefix}\n## Planning Notes\n${parts.slice(1).join("\n## Planning Notes\n")}` : prefix;
}

function applyBlockedBy(body, blockedBy) {
  const parts = body.split("\n## Planning Notes\n");
  let prefix = parts[0].replace(/\n## Sequencing\n[\s\S]*$/, "");
  if (blockedBy.length) {
    prefix += `\n## Sequencing\n\n${blockedBy.map((number) => `Blocked-by: #${number}`).join("\n")}`;
  }
  return parts.length > 1 ? `${prefix}\n## Planning Notes\n${parts.slice(1).join("\n## Planning Notes\n")}` : prefix;
}

function issueRef(issue) {
  return { number: issue.number, url: issue.html_url };
}
