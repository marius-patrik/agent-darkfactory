import {
  DEFAULT_DATA_REPO,
  PLANNING_LABELS,
  WORK_LABELS,
  assertAllowedRepo,
  createGithubClient,
  driftIssueBody,
  ensureLabels,
  findDriftMarker,
  findPrdMarker,
  getOptionalFileContent,
  getRepository,
  listIssues,
  parsePrdItems,
  parseRepo,
  prdIssueBody,
  repoName,
  requiredEnv,
  slug,
  writeRunLedger
} from "./df-lib.mjs";

const TOKEN = requiredEnv("DARK_FACTORY_TOKEN");
const CONTROL_REPO = parseRepo(requiredEnv("DF_CONTROL_REPO"));
let TARGET_REPO = parseRepo(process.env.DF_TARGET_REPO?.trim() || repoName(CONTROL_REPO));
const DATA_REPO = process.env.DF_DATA_REPO ?? DEFAULT_DATA_REPO;
const TRIGGER = process.env.DF_TRIGGER ?? "unknown";
const TARGET_REF = process.env.DF_TARGET_REF?.trim() || "";
const PLAN_ALL = process.env.DF_PLAN_ALL === "true";
const gh = createGithubClient(TOKEN, "darkfactory-plan");

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const targets = PLAN_ALL ? await targetRepositories() : [TARGET_REPO];
  for (const target of targets) {
    TARGET_REPO = target;
    await reconcileTargetRepository();
  }
}

async function reconcileTargetRepository() {
  assertAllowedRepo(TARGET_REPO);
  await ensureLabels(gh, TARGET_REPO, [...PLANNING_LABELS, ...WORK_LABELS]);

  const repo = await getRepository(gh, TARGET_REPO);
  const sourceRef = PLAN_ALL ? repo.default_branch : TARGET_REF || repo.default_branch;
  const prd = await getOptionalFileContent(gh, TARGET_REPO, "PRD.md", sourceRef);
  const ledger = {
    trigger: TRIGGER,
    default_branch: repo.default_branch,
    source_ref: sourceRef,
    actions: [],
    token_usage: {
      codex_calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      note: "L4 planning used deterministic PRD parsing only"
    }
  };

  if (!prd) {
    const issue = await upsertDriftIssue(TARGET_REPO, [`Root \`PRD.md\` is missing on \`${repo.default_branch}\`.`]);
    ledger.actions.push({ action: "drift-report", reason: "missing-prd", issue });
    await writeLedger(ledger);
    return;
  }

  const items = parsePrdItems(prd);
  const issues = await listIssues(gh, TARGET_REPO, "all");
  const byMarker = new Map();
  const driftIssues = [];

  for (const issue of issues) {
    const marker = findPrdMarker(issue.body || "");
    if (marker) byMarker.set(marker, issue);
    if (findDriftMarker(issue.body || "")) driftIssues.push(issue);
  }

  const expectedMarkers = new Set(items.map((item) => item.marker));
  let previousOpenIssueNumber = null;

  for (const item of items) {
    const existing = byMarker.get(item.marker);
    const blockedBy = previousOpenIssueNumber ? [previousOpenIssueNumber] : [];
    const body = prdIssueBody(item, blockedBy);
    const labels = [item.priority, "roadmap", `df:class:${item.taskClass}`];

    if (!existing) {
      const created = await gh.request("POST", `/repos/${repoName(TARGET_REPO)}/issues`, {
        title: item.title,
        body,
        labels
      });
      ledger.actions.push({ action: "create-issue", marker: item.marker, issue: issueRef(created) });
      previousOpenIssueNumber = created.number;
      continue;
    }

    if (existing.state === "closed") {
      ledger.actions.push({ action: "keep-closed", marker: item.marker, issue: issueRef(existing) });
      continue;
    }

    const update = {};
    if (existing.title !== item.title) update.title = item.title;
    if ((existing.body || "").trim() !== body.trim()) update.body = body;
    if (Object.keys(update).length) {
      const updated = await gh.request("PATCH", `/repos/${repoName(TARGET_REPO)}/issues/${existing.number}`, update);
      ledger.actions.push({ action: "update-issue", marker: item.marker, issue: issueRef(updated), fields: Object.keys(update) });
    }
    await setIssueLabels(TARGET_REPO, existing.number, labels);
    ledger.actions.push({ action: "sequence-labels", marker: item.marker, issue: issueRef(existing), labels });
    previousOpenIssueNumber = existing.number;
  }

  const staleMarkedIssues = [...byMarker.values()].filter((issue) => {
    const marker = findPrdMarker(issue.body || "");
    return issue.state === "open" && marker && !expectedMarkers.has(marker);
  });

  for (const issue of staleMarkedIssues) {
    await setIssueLabels(TARGET_REPO, issue.number, []);
    await gh.request("POST", `/repos/${repoName(TARGET_REPO)}/issues/${issue.number}/comments`, {
      body: "DarkFactory L4 planning closed this issue because its `df-prd:` marker is no longer present in the root PRD."
    });
    await gh.request("PATCH", `/repos/${repoName(TARGET_REPO)}/issues/${issue.number}`, { state: "closed" });
    ledger.actions.push({ action: "close-stale-prd-issue", issue: issueRef(issue) });
  }

  const driftFindings = await detectCodeDrift(TARGET_REPO, repo.default_branch, items, staleMarkedIssues);
  if (driftFindings.length) {
    const driftIssue = await upsertDriftIssue(TARGET_REPO, driftFindings);
    ledger.actions.push({ action: "drift-report", issue: driftIssue, findings: driftFindings });
  } else {
    for (const issue of driftIssues.filter((issue) => issue.state === "open")) {
      await gh.request("POST", `/repos/${repoName(TARGET_REPO)}/issues/${issue.number}/comments`, {
        body: "DarkFactory L4 planning no longer detects this drift condition."
      });
      await gh.request("PATCH", `/repos/${repoName(TARGET_REPO)}/issues/${issue.number}`, { state: "closed" });
      ledger.actions.push({ action: "close-resolved-drift", issue: issueRef(issue) });
    }
  }

  await writeLedger(ledger);
  console.log(`DarkFactory planning reconciled ${items.length} PRD items for ${repoName(TARGET_REPO)}.`);
}

async function targetRepositories() {
  try {
    const repositories = [];
    for (let page = 1; page <= 20; page += 1) {
      const data = await gh.request("GET", `/installation/repositories?per_page=100&page=${page}`);
      if (!Array.isArray(data.repositories) || data.repositories.length === 0) break;
      repositories.push(...data.repositories);
      if (data.repositories.length < 100) break;
    }
    return repositories
      .map((repo) => parseRepo(repo.full_name))
      .filter((repo) => repo.owner === CONTROL_REPO.owner);
  } catch {
    return [CONTROL_REPO];
  }

  return [CONTROL_REPO];
}

async function setIssueLabels(repository, issueNumber, labels) {
  const current = await gh.request("GET", `/repos/${repoName(repository)}/issues/${issueNumber}`);
  const currentNames = new Set(
    (current.labels || []).map((label) => typeof label === "string" ? label : label.name).filter(Boolean)
  );
  const reconciledLabels = [
    "df:class:mechanical",
    "df:class:standard",
    "df:class:hard",
    "df:prd-drift",
    "roadmap",
    "P0",
    "P1",
    "P2"
  ];
  const remove = reconciledLabels.filter((label) => currentNames.has(label) && !labels.includes(label));
  const add = labels.filter((label) => !currentNames.has(label));

  if (add.length) {
    await gh.request("POST", `/repos/${repoName(repository)}/issues/${issueNumber}/labels`, { labels: add });
  }
  for (const label of remove) {
    await gh.request("DELETE", `/repos/${repoName(repository)}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`);
  }
}

async function detectCodeDrift(repository, ref, items, staleMarkedIssues) {
  const findings = staleMarkedIssues.map((issue) => {
    const marker = findPrdMarker(issue.body || "");
    return `Backlog issue #${issue.number} still had stale marker \`${marker}\` after the PRD item was removed.`;
  });
  const itemText = items.map((item) => `${item.name} ${item.description}`).join("\n").toLowerCase();

  if (itemText.includes("l4 planning")) {
    const workflow = await getOptionalFileContent(gh, repository, ".github/workflows/df-plan.yml", ref);
    if (!workflow) findings.push("PRD requires L4 Planning, but `.github/workflows/df-plan.yml` is absent.");
  }

  if (itemText.includes("l3 work")) {
    const workflow = await getOptionalFileContent(gh, repository, ".github/workflows/df-work.yml", ref);
    if (!workflow) findings.push("PRD requires L3 Work, but `.github/workflows/df-work.yml` is absent.");
  }

  return findings;
}

async function upsertDriftIssue(repository, findings) {
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
    await setIssueLabels(repository, existing.number, ["P1", "df:prd-drift", "df:class:standard"]);
    return issueRef(updated);
  }

  const created = await gh.request("POST", `/repos/${repoName(repository)}/issues`, {
    title,
    body,
    labels: ["P1", "df:prd-drift", "df:class:standard"]
  });
  return issueRef(created);
}

async function writeLedger(ledger) {
  try {
    const written = await writeRunLedger(gh, DATA_REPO, "df-plan", repoName(TARGET_REPO), ledger);
    console.log(`DarkFactory ledger written to ${written.repository}/${written.path}`);
  } catch (error) {
    console.warn(`DarkFactory ledger warning: ${error.message || String(error)}`);
  }
}

function issueRef(issue) {
  return { number: issue.number, url: issue.html_url };
}
