import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DARK_FACTORY_DATA_REPO,
  PLANNING_LABELS,
  WORK_LABELS,
  assertAllowedRepo,
  createGithubClient,
  driftIssueBody,
  ensureLabels,
  extractClosingIssueNumbers,
  extractReadmeFirstParagraph,
  findDriftMarker,
  findPrdMarker,
  getOptionalFileContent,
  getRepository,
  isActiveManagedRepo,
  isNonProductPlanningPath,
  listActiveManagedRepos,
  listIssues,
  listPackagePaths,
  normalizeWorkerPullRequestActor,
  readManagedRepoRegistry,
  parsePrdItems,
  parseRepo,
  plannedIssueLabelDiff,
  prdIssueBody,
  prdScaffoldPullRequestBody,
  repoName,
  requiredEnv,
  scaffoldPackagePrd,
  slug,
  warnReadOnlyRepository,
  writeRunLedger
} from "./df-lib.mjs";
import { loadModelPolicy, modelRequestForPurpose } from "./df-model-policy.mjs";

const PLANNER_BOT_ACTORS = new Map([
  ["darkfactory-agent[bot]", "current-app"],
  ["github-actions[bot]", "repository-actions"],
  ["mp-agents[bot]", "legacy-app"]
]);
const PLANNER_BOT_LOGINS = new Set(PLANNER_BOT_ACTORS.keys());
const PRD_SCAFFOLD_MARKER = "<!-- dark-factory:prd-scaffold";
const SHA = /^[0-9a-f]{40}$/i;
const REQUIRED_SCAFFOLD_CHECKS = ["Validate", "DarkFactory Autoreview"];
const ACTIONS_APP_ID = 15368;

const DATA_REPO = DARK_FACTORY_DATA_REPO;
const TRIGGER = process.env.DF_TRIGGER ?? "unknown";
const TARGET_REF = process.env.DF_TARGET_REF?.trim() || "";
const PLAN_ALL = process.env.DF_PLAN_ALL === "true";

let gh;
let TARGET_REPO;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}

async function main() {
  const TOKEN = requiredEnv("DARK_FACTORY_TOKEN");
  const CONTROL_REPO = parseRepo(requiredEnv("DF_CONTROL_REPO"));
  TARGET_REPO = parseRepo(process.env.DF_TARGET_REPO?.trim() || repoName(CONTROL_REPO));
  gh = createGithubClient(TOKEN, "darkfactory-plan");

  const registry = await readManagedRepoRegistry();
  const targets = PLAN_ALL ? await listActiveManagedRepos(gh, CONTROL_REPO, { registry }) : [TARGET_REPO];
  for (const target of targets) {
    TARGET_REPO = target;
    if (!isActiveManagedRepo(TARGET_REPO, registry)) {
      console.warn(`DarkFactory planning skipped ${repoName(TARGET_REPO)} because managed lifecycle state is not active.`);
      continue;
    }
    const repo = await getRepository(gh, TARGET_REPO);
    if (repo.archived === true || repo.disabled === true) {
      console.warn(`DarkFactory planning skipped ${repoName(TARGET_REPO)} because GitHub reports archived=${repo.archived === true} disabled=${repo.disabled === true}.`);
      continue;
    }
    try {
      await reconcileTargetRepository(repo, CONTROL_REPO);
    } catch (error) {
      if (warnReadOnlyRepository(TARGET_REPO, error, "planning")) {
        try {
          await upsertPrdBlockerIssue(TARGET_REPO, repo.default_branch || "main", `Planning could not write to ${repoName(TARGET_REPO)} because the repository is archived, disabled, or read-only: ${error.message || String(error)}`);
        } catch (blockerError) {
          console.warn(`DarkFactory failed to file PRD blocker issue for ${repoName(TARGET_REPO)}: ${blockerError.message || String(blockerError)}`);
        }
        continue;
      }
      throw error;
    }
  }
}

async function reconcileTargetRepository(repo, controlRepo) {
  assertAllowedRepo(TARGET_REPO);
  if (repo.archived === true || repo.disabled === true) {
    console.warn(`DarkFactory planning skipped ${repoName(TARGET_REPO)} because GitHub reports archived=${repo.archived === true} disabled=${repo.disabled === true}.`);
    return;
  }

  await ensureLabels(gh, TARGET_REPO, [...PLANNING_LABELS, ...WORK_LABELS]);
  // Setup dispatches an exact dev source. Scheduled/default and push planning
  // may still observe their normal refs, but only admitted dev can authorize a
  // scaffold PR below.
  const sourceRef = PLAN_ALL ? repo.default_branch : TARGET_REF || repo.default_branch;
  const ledger = {
    trigger: TRIGGER,
    default_branch: repo.default_branch,
    source_ref: sourceRef,
    prd_files: [],
    actions: [],
    token_usage: {
      model_calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      note: "L4 planning used deterministic PRD parsing only"
    }
  };

  const prdPresence = await ensurePrdPresence(TARGET_REPO, repo, sourceRef);
  ledger.prd_coverage = {
    root_present: prdPresence.rootPresent,
    package_prds: prdPresence.packagePrds.length,
    total_packages: prdPresence.packagePaths.length,
    missing: prdPresence.missingPaths
  };

  if (!prdPresence.rootPresent) {
    if (prdPresence.scaffoldPullRequest) {
      ledger.actions.push({
        action: "prd-scaffold-pr",
        state: prdPresence.scaffoldPullRequest.isNew ? "created" : "exists",
        pull_request: prdPresence.scaffoldPullRequest.ref,
        missing: prdPresence.missingPaths
      });
      console.log(`DarkFactory planning opened PRD scaffold PR ${prdPresence.scaffoldPullRequest.ref.url} for ${repoName(TARGET_REPO)}.`);
    } else {
      const issue = await upsertPrdBlockerIssue(TARGET_REPO, sourceRef, "Root PRD.md is missing and DarkFactory could not open a scaffold PR.");
      ledger.actions.push({ action: "prd-blocker-issue", reason: "missing-prd", issue });
    }
    await writeLedger(ledger);
    return;
  }

  if (prdPresence.scaffoldPullRequest) {
    ledger.actions.push({
      action: "package-prd-scaffold-pr",
      state: prdPresence.scaffoldPullRequest.isNew ? "created" : "exists",
      pull_request: prdPresence.scaffoldPullRequest.ref,
      missing: prdPresence.missingPaths
    });
  }

  const prdSources = await getPrdSources(TARGET_REPO, sourceRef, prdPresence.tree);
  ledger.prd_files = prdSources.map((source) => source.path);

  const modelPolicy = await loadModelPolicy(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."));
  const items = prdSources
    .flatMap((source) => parsePrdItems(source.content, source.path))
    .map((item) => ({
      ...item,
      modelRequest: modelRequestForPurpose(modelPolicy, "implementation", { taskClass: item.taskClass })
    }));
  ledger.work_units = items.map((item) => ({
    marker: item.marker,
    task_class: item.taskClass,
    model_tier: item.modelRequest.modelTier,
    effort: item.modelRequest.effort
  }));
  const issues = await listIssues(gh, TARGET_REPO, "all");
  const byMarker = indexOwnedPrdIssues(issues);
  const driftIssues = [...indexOwnedIssuesByMarker(issues, findDriftMarker, "PRD drift").values()];

  const expectedMarkers = new Set(items.map((item) => item.marker));
  let previousIssueNumber = null;

  for (const item of items) {
    const existing = byMarker.get(item.marker);
    const labels = [item.priority, "roadmap", `df:class:${item.taskClass}`];

    if (item.completed) {
      if (!existing) {
        const created = await gh.request("POST", `/repos/${repoName(TARGET_REPO)}/issues`, {
          title: item.title,
          body: prdIssueBody(item, previousIssueNumber ? [previousIssueNumber] : []),
          labels
        });
        await revalidateOwnedIssue(gh, TARGET_REPO, created.number, item.marker, findPrdMarker);
        const closed = await gh.request("PATCH", `/repos/${repoName(TARGET_REPO)}/issues/${created.number}`, {
          state: "closed"
        });
        await gh.request("POST", `/repos/${repoName(TARGET_REPO)}/issues/${created.number}/comments`, {
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
      await revalidateOwnedIssue(gh, TARGET_REPO, existing.number, item.marker, findPrdMarker);
      const closed = await gh.request("PATCH", `/repos/${repoName(TARGET_REPO)}/issues/${existing.number}`, {
        state: "closed"
      });
      await gh.request("POST", `/repos/${repoName(TARGET_REPO)}/issues/${existing.number}/comments`, {
        body: "DarkFactory L4 planning closed this issue because the PRD marks this item as completed."
      });
      ledger.actions.push({ action: "close-completed-prd-issue", marker: item.marker, issue: issueRef(closed) });
      previousIssueNumber = closed.number;
      continue;
    }

    // Keep deterministic PRD-order references even when the predecessor is
    // already closed. Planning owns sequencing, never readiness: only the
    // exact current-version issue Autoreview evaluator may publish df:ready.
    const blockedBy = previousIssueNumber ? [previousIssueNumber] : [];
    const body = prdIssueBody(item, blockedBy);

    if (!existing) {
      const created = await gh.request("POST", `/repos/${repoName(TARGET_REPO)}/issues`, {
        title: item.title,
        body,
        labels
      });
      ledger.actions.push({ action: "create-issue", marker: item.marker, issue: issueRef(created), labels });
      previousIssueNumber = created.number;
      continue;
    }

    if (existing.state === "closed") {
      const { action, previousIssueNumber: nextPrevious } = await handleClosedIncompletePrdIssue(gh, TARGET_REPO, controlRepo, item, existing, labels, blockedBy);
      ledger.actions.push(action);
      previousIssueNumber = nextPrevious;
      continue;
    }

    // For open issues, apply the deterministic current-PRD sequence. Patch only
    // the Blocked-by section when sequencing changes; rewrite the whole body
    // when the PRD item content itself changes.
    const expectedBlockedBy = blockedBy;
    const current = await revalidateOwnedIssue(gh, TARGET_REPO, existing.number, item.marker, findPrdMarker);
    const existingBlockedBy = extractBlockedBy(current.body || "");
    const contentBody = prdIssueBody(item, []);
    const contentChanged = removeBlockedBySection(current.body || "").trim() !== contentBody.trim();
    const sequencingChanged = existingBlockedBy.join(",") !== expectedBlockedBy.join(",");

    const update = {};
    if (current.title !== item.title) update.title = item.title;
    if (contentChanged) {
      update.body = prdIssueBody(item, expectedBlockedBy);
    } else if (sequencingChanged) {
      update.body = applyBlockedBy(current.body || "", expectedBlockedBy);
    }
    if (Object.keys(update).length) {
      const updated = await gh.request("PATCH", `/repos/${repoName(TARGET_REPO)}/issues/${existing.number}`, update);
      ledger.actions.push({ action: "update-issue", marker: item.marker, issue: issueRef(updated), fields: Object.keys(update) });
    }
    await setIssueLabels(gh, TARGET_REPO, existing.number, labels, {
      invalidateReadiness: Object.keys(update).length > 0,
      expectedMarker: item.marker,
      markerFinder: findPrdMarker
    });
    ledger.actions.push({ action: "sequence-labels", marker: item.marker, issue: issueRef(existing), labels });
    previousIssueNumber = existing.number;
  }

  const staleMarkedIssues = [...byMarker.values()].filter((issue) => {
    const marker = findPrdMarker(issue.body || "");
    return issue.state === "open" && marker && !expectedMarkers.has(marker);
  });

  for (const issue of staleMarkedIssues) {
    const marker = findPrdMarker(issue.body || "");
    await revalidateOwnedIssue(gh, TARGET_REPO, issue.number, marker, findPrdMarker);
    await gh.request("POST", `/repos/${repoName(TARGET_REPO)}/issues/${issue.number}/comments`, {
      body: "DarkFactory L4 planning closed this issue because its `df-prd:` marker is no longer present in any tracked `PRD.md` file."
    });
    await revalidateOwnedIssue(gh, TARGET_REPO, issue.number, marker, findPrdMarker);
    await gh.request("PATCH", `/repos/${repoName(TARGET_REPO)}/issues/${issue.number}`, { state: "closed" });
    ledger.actions.push({ action: "close-stale-prd-issue", issue: issueRef(issue) });
  }

  const driftFindings = await detectCodeDrift(TARGET_REPO, repo.default_branch, items, staleMarkedIssues);
  if (driftFindings.length) {
    const driftIssue = await upsertDriftIssue(TARGET_REPO, driftFindings);
    ledger.actions.push({ action: "drift-report", issue: driftIssue, findings: driftFindings });
  } else {
    for (const issue of driftIssues.filter((issue) => issue.state === "open")) {
      const marker = findDriftMarker(issue.body || "");
      await revalidateOwnedIssue(gh, TARGET_REPO, issue.number, marker, findDriftMarker);
      await gh.request("POST", `/repos/${repoName(TARGET_REPO)}/issues/${issue.number}/comments`, {
        body: "DarkFactory L4 planning no longer detects this drift condition."
      });
      await revalidateOwnedIssue(gh, TARGET_REPO, issue.number, marker, findDriftMarker);
      await gh.request("PATCH", `/repos/${repoName(TARGET_REPO)}/issues/${issue.number}`, { state: "closed" });
      ledger.actions.push({ action: "close-resolved-drift", issue: issueRef(issue) });
    }
  }

  await writeLedger(ledger);
  console.log(`DarkFactory planning reconciled ${items.length} PRD items for ${repoName(TARGET_REPO)}.`);
}

async function getPrdSources(repository, ref, tree) {
  const paths = await listPrdPaths(repository, ref, tree);
  const sources = [];
  for (const filePath of paths) {
    const content = await getOptionalFileContent(gh, repository, filePath, ref);
    if (content) sources.push({ path: filePath, content });
  }
  return sources;
}

export async function listPrdPaths(repository, ref, tree) {
  if (!tree) {
    try {
      tree = await getRecursiveTree(repository, ref);
    } catch (error) {
      if (error.status !== 404) throw error;
      const root = await getOptionalFileContent(gh, repository, "PRD.md", ref);
      return root ? ["PRD.md"] : [];
    }
  }

  const paths = (tree.tree || [])
    .filter((entry) => (
      entry.type === "blob" &&
      (entry.path === "PRD.md" || entry.path.endsWith("/PRD.md")) &&
      (entry.path === "PRD.md" || !isNonProductPlanningPath(entry.path))
    ))
    .map((entry) => entry.path)
    .sort((a, b) => {
      if (a === "PRD.md") return -1;
      if (b === "PRD.md") return 1;
      return a.localeCompare(b);
    });
  return paths;
}

async function getRecursiveTree(repository, ref) {
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

async function ensurePrdPresence(repository, repo, sourceRef) {
  const tree = await getRecursiveTree(repository, sourceRef);
  const prdPaths = await listPrdPaths(repository, sourceRef, tree);
  const packagePaths = listPackagePaths(tree.tree);
  const rootPresent = prdPaths.includes("PRD.md");
  const missingPackagePrds = packagePaths.filter((dir) => {
    const expected = dir === "." ? "PRD.md" : `${dir}/PRD.md`;
    return !prdPaths.includes(expected);
  });
  const missingPaths = [];
  if (!rootPresent) {
    missingPaths.push("PRD.md");
  }
  for (const pkg of missingPackagePrds) {
    missingPaths.push(pkg === "." ? "PRD.md" : `${pkg}/PRD.md`);
  }

  if (missingPaths.length === 0) {
    return {
      rootPresent: true,
      tree,
      prdPaths,
      packagePaths,
      packagePrds: packagePaths.map((dir) => dir === "." ? "PRD.md" : `${dir}/PRD.md`),
      missingPaths: [],
      scaffoldPullRequest: null
    };
  }

  if (sourceRef !== "dev") {
    return {
      rootPresent,
      tree,
      prdPaths,
      packagePaths,
      packagePrds: [],
      missingPaths,
      scaffoldPullRequest: null
    };
  }

  const files = await buildScaffoldFiles(repository, sourceRef, missingPaths);
  const source = await gh.request("GET", `/repos/${repoName(repository)}/git/ref/heads/dev`);
  const sourceSha = source?.object?.sha;
  if (!SHA.test(sourceSha || "")) throw new Error("GitHub returned invalid admitted dev evidence for PRD scaffolding.");
  const expected = { baseRef: "dev", sourceSha: sourceSha.toLowerCase(), files };
  const existingPr = await findOpenPrdScaffoldPullRequest(gh, repository, expected);
  if (existingPr) {
    const merge = await armPrdScaffoldAutoMerge(gh, repository, existingPr, expected);
    return {
      rootPresent,
      tree,
      prdPaths,
      packagePaths,
      packagePrds: [],
      missingPaths,
      scaffoldPullRequest: { ref: issueRef(existingPr), isNew: false, status: merge.status }
    };
  }

  const pr = await createPrdScaffoldPullRequest(gh, repository, "dev", sourceSha.toLowerCase(), files);
  const merge = await armPrdScaffoldAutoMerge(gh, repository, pr, expected);
  return {
    rootPresent,
    tree,
    prdPaths,
    packagePaths,
    packagePrds: [],
    missingPaths,
    scaffoldPullRequest: { ref: issueRef(pr), isNew: true, status: merge.status }
  };
}

async function findOpenPrdScaffoldPullRequest(github, repository, expected) {
  const candidates = [];
  for (let page = 1; page <= 20; page += 1) {
    const pulls = await github.request("GET", `/repos/${repoName(repository)}/pulls?state=open&per_page=100&page=${page}`);
    if (!Array.isArray(pulls)) throw new Error("GitHub returned malformed PRD scaffold pull-request evidence.");
    candidates.push(...pulls.filter((pull) => typeof pull?.body === "string" && pull.body.includes(PRD_SCAFFOLD_MARKER)));
    if (pulls.length < 100) break;
    if (page === 20) throw new Error("PRD scaffold pull-request inventory exceeded the bounded complete scan.");
  }
  if (candidates.length > 1) throw new Error("Multiple pull requests claim the DarkFactory PRD scaffold marker; refusing ambiguous ownership.");
  if (candidates.length === 0) return null;
  const pull = await github.request("GET", `/repos/${repoName(repository)}/pulls/${candidates[0].number}`);
  await assertTrustedPrdScaffoldPullRequest(github, repository, pull, expected);
  return pull;
}

async function buildScaffoldFiles(repository, ref, missingPaths) {
  const readme = await getOptionalFileContent(gh, repository, "README.md", ref);
  const rootVision = extractReadmeFirstParagraph(readme);
  const files = [];

  for (const path of missingPaths) {
    const isRoot = path === "PRD.md";
    const dir = isRoot ? "." : path.slice(0, -"/PRD.md".length);
    let packageName = "";
    let vision = "";

    if (!isRoot) {
      packageName = dir.split("/").pop() || "";
      const packageReadme = await getOptionalFileContent(gh, repository, `${dir}/README.md`, ref);
      const packageJson = await getOptionalFileContent(gh, repository, `${dir}/package.json`, ref);
      vision = extractReadmeFirstParagraph(packageReadme);
      if (!vision && packageJson) {
        try {
          const parsed = JSON.parse(packageJson);
          vision = typeof parsed.description === "string" ? parsed.description : "";
        } catch {
          vision = "";
        }
      }
    } else {
      vision = rootVision;
    }

    files.push({
      path,
      content: scaffoldPackagePrd(repoName(repository), { vision, packageName, isRoot })
    });
  }

  return files;
}

async function createPrdScaffoldPullRequest(github, repository, baseBranch, sourceSha, files) {
  if (baseBranch !== "dev") throw new Error("PRD scaffolding is restricted to the admitted dev source and base.");
  if (!SHA.test(sourceSha || "")) throw new Error("PRD scaffold source SHA is invalid.");
  const timestamp = Date.now();
  const branch = `dark-factory/prd-scaffold-${timestamp}`;
  const baseRef = await github.request("GET", `/repos/${repoName(repository)}/git/ref/heads/${encodeURIComponent(baseBranch)}`);
  const baseSha = baseRef?.object?.sha;
  if (!SHA.test(baseSha || "") || baseSha.toLowerCase() !== sourceSha.toLowerCase()) throw new Error("Admitted dev changed before PRD scaffold tree creation.");

  const baseCommit = await github.request("GET", `/repos/${repoName(repository)}/git/commits/${encodeURIComponent(baseSha)}`);
  const baseTreeSha = baseCommit?.tree?.sha;
  if (typeof baseTreeSha !== "string") {
    throw new Error(`GitHub returned an invalid base commit tree for ${baseBranch}`);
  }

  const newTree = await github.request("POST", `/repos/${repoName(repository)}/git/trees`, {
    base_tree: baseTreeSha,
    tree: files.map((file) => ({
      path: file.path,
      mode: "100644",
      type: "blob",
      content: file.content
    }))
  });

  const newCommit = await github.request("POST", `/repos/${repoName(repository)}/git/commits`, {
    message: "Add DarkFactory PRD scaffold",
    tree: newTree.sha,
    parents: [baseSha]
  });

  if (!SHA.test(newCommit?.sha || "")) throw new Error("GitHub returned an invalid PRD scaffold commit identity.");
  const currentBase = await github.request("GET", `/repos/${repoName(repository)}/git/ref/heads/${encodeURIComponent(baseBranch)}`);
  if (String(currentBase?.object?.sha || "").toLowerCase() !== sourceSha.toLowerCase()) throw new Error("Admitted dev changed before PRD scaffold branch creation.");
  await github.request("POST", `/repos/${repoName(repository)}/git/refs`, {
    ref: `refs/heads/${branch}`,
    sha: newCommit.sha
  });

  const pull = await github.request("POST", `/repos/${repoName(repository)}/pulls`, {
    title: "Add DarkFactory PRD scaffold",
    head: branch,
    base: baseBranch,
    body: prdScaffoldPullRequestBody(repoName(repository), files.map((file) => file.path), {
      baseRef: baseBranch,
      sourceSha: sourceSha.toLowerCase(),
      headSha: newCommit.sha.toLowerCase(),
      contentDigest: scaffoldContentDigest(files)
    })
  });
  if (!Number.isInteger(pull?.number) || pull.number <= 0) throw new Error("GitHub returned an invalid PRD scaffold pull request.");
  const current = await github.request("GET", `/repos/${repoName(repository)}/pulls/${pull.number}`);
  await assertTrustedPrdScaffoldPullRequest(github, repository, current, { baseRef: baseBranch, sourceSha, files });
  return current;
}

function scaffoldContentDigest(files) {
  return createHash("sha256").update(JSON.stringify(
    [...files].map((file) => ({ path: file.path, content: file.content })).sort((a, b) => a.path.localeCompare(b.path))
  )).digest("hex");
}

function parsePrdScaffoldMarker(body) {
  const match = String(body || "").match(
    /<!-- dark-factory:prd-scaffold schema=1 repo=([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+) base=(dev) source=([0-9a-f]{40}) head=([0-9a-f]{40}) content=([0-9a-f]{64}) -->/i
  );
  return match ? { repository: match[1], baseRef: match[2], sourceSha: match[3].toLowerCase(), headSha: match[4].toLowerCase(), contentDigest: match[5].toLowerCase() } : null;
}

async function assertTrustedPrdScaffoldPullRequest(github, repository, pull, expected) {
  const marker = parsePrdScaffoldMarker(pull?.body);
  const expectedRepository = repoName(repository).toLowerCase();
  const expectedContent = scaffoldContentDigest(expected.files);
  if (!marker
    || marker.repository.toLowerCase() !== expectedRepository
    || marker.baseRef !== expected.baseRef
    || marker.sourceSha !== expected.sourceSha.toLowerCase()
    || marker.contentDigest !== expectedContent) {
    throw new Error("PRD scaffold pull request lacks exact current provenance.");
  }
  if (normalizeWorkerPullRequestActor(pull?.user) === null) throw new Error("PRD scaffold pull request is not owned by the exact current DarkFactory App actor.");
  if (pull?.state !== "open"
    || pull?.base?.ref !== expected.baseRef
    || String(pull?.base?.sha || "").toLowerCase() !== expected.sourceSha.toLowerCase()
    || !String(pull?.head?.ref || "").startsWith("dark-factory/prd-scaffold-")
    || String(pull?.head?.sha || "").toLowerCase() !== marker.headSha
    || String(pull?.head?.repo?.full_name || "").toLowerCase() !== expectedRepository) {
    throw new Error("PRD scaffold pull request does not match its same-repository dev/base/head claim.");
  }
  const [baseRef, headRef, commit] = await Promise.all([
    github.request("GET", `/repos/${repoName(repository)}/git/ref/heads/${encodeURIComponent(expected.baseRef)}`),
    github.request("GET", `/repos/${repoName(repository)}/git/ref/heads/${encodeURIComponent(pull.head.ref)}`),
    github.request("GET", `/repos/${repoName(repository)}/git/commits/${marker.headSha}`)
  ]);
  if (String(baseRef?.object?.sha || "").toLowerCase() !== marker.sourceSha
    || String(headRef?.object?.sha || "").toLowerCase() !== marker.headSha
    || !Array.isArray(commit?.parents)
    || commit.parents.length !== 1
    || String(commit.parents[0]?.sha || "").toLowerCase() !== marker.sourceSha) {
    throw new Error("PRD scaffold refs or commit ancestry changed after admission.");
  }
  const changedPaths = [];
  for (let page = 1; page <= 20; page += 1) {
    const files = await github.request("GET", `/repos/${repoName(repository)}/pulls/${pull.number}/files?per_page=100&page=${page}`);
    if (!Array.isArray(files)) throw new Error("GitHub returned malformed PRD scaffold file evidence.");
    changedPaths.push(...files.map((file) => file?.filename));
    if (files.length < 100) break;
    if (page === 20) throw new Error("PRD scaffold file inventory exceeded the bounded complete scan.");
  }
  const expectedPaths = expected.files.map((file) => file.path).sort();
  if (changedPaths.some((file) => typeof file !== "string") || JSON.stringify(changedPaths.sort()) !== JSON.stringify(expectedPaths)) {
    throw new Error("PRD scaffold pull request changes paths outside the exact scaffold plan.");
  }
  for (const file of expected.files) {
    const content = await getOptionalFileContent(github, repository, file.path, marker.headSha);
    if (content !== file.content) throw new Error(`PRD scaffold content drifted at ${file.path}.`);
  }
  return marker;
}

async function armPrdScaffoldAutoMerge(github, repository, pull, expected) {
  let current = await github.request("GET", `/repos/${repoName(repository)}/pulls/${pull.number}`);
  await assertTrustedPrdScaffoldPullRequest(github, repository, current, expected);
  const protection = await github.request("GET", `/repos/${repoName(repository)}/branches/${encodeURIComponent(expected.baseRef)}/protection`);
  assertPrdScaffoldProtection(protection, expected.baseRef);
  if (current.auto_merge) return { status: "automerge-armed", pull: current };
  if (typeof github.graphql !== "function" || typeof current.node_id !== "string") throw new Error("PRD scaffold auto-merge authority is unavailable.");
  let enabled = null;
  try {
    enabled = await github.graphql(
      `mutation EnablePrdScaffoldAutoMerge($pullRequestId: ID!) {
        enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: SQUASH }) {
          pullRequest { number autoMergeRequest { enabledAt } }
        }
      }`,
      { pullRequestId: current.node_id }
    );
  } catch (error) {
    current = await github.request("GET", `/repos/${repoName(repository)}/pulls/${pull.number}`);
    await assertTrustedPrdScaffoldPullRequest(github, repository, current, expected);
    if (!current.auto_merge) throw error;
    return { status: "automerge-armed", pull: current };
  }
  current = await github.request("GET", `/repos/${repoName(repository)}/pulls/${pull.number}`);
  await assertTrustedPrdScaffoldPullRequest(github, repository, current, expected);
  const enabledAt = enabled?.enablePullRequestAutoMerge?.pullRequest?.autoMergeRequest?.enabledAt;
  if (!current.auto_merge && typeof enabledAt !== "string") throw new Error("GitHub did not confirm PRD scaffold auto-merge admission.");
  return { status: "automerge-armed", pull: current };
}

function assertPrdScaffoldProtection(protection, branch) {
  const checks = protection?.required_status_checks?.checks;
  const safe = protection?.required_status_checks?.strict === true
    && protection?.enforce_admins?.enabled === true
    && protection?.allow_force_pushes?.enabled === false
    && protection?.allow_deletions?.enabled === false
    && Array.isArray(checks)
    && REQUIRED_SCAFFOLD_CHECKS.every((name) => {
      const matches = checks.filter((check) => check?.context === name);
      return matches.length === 1 && matches[0]?.app_id === ACTIONS_APP_ID;
    });
  if (!safe) throw new Error(`PRD scaffold base ${branch} lacks exact App-bound protected auto-merge gates.`);
}

function normalizePlannerBotActor(actor) {
  if (!actor || typeof actor !== "object" || actor.type !== "Bot" || actor.__typename !== undefined || typeof actor.login !== "string") return null;
  return PLANNER_BOT_ACTORS.get(actor.login) || null;
}

function exactMarkerCount(body, marker) {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...String(body || "").matchAll(new RegExp(`<!--\\s*${escaped}\\s*-->`, "g"))].length;
}

function assertOwnedPlannerIssue(issue, marker, kind = "planner") {
  if (!issue || issue.pull_request || normalizePlannerBotActor(issue.user) === null || exactMarkerCount(issue.body, marker) !== 1) {
    throw new Error(`${kind} marker ${marker} is not owned by one exact trusted planner Bot issue.`);
  }
  return issue;
}

function indexOwnedIssuesByMarker(issues, markerFinder, kind) {
  const candidates = new Map();
  for (const issue of issues || []) {
    if (issue?.pull_request) continue;
    const marker = markerFinder(issue?.body || "");
    if (!marker) continue;
    candidates.set(marker, [...(candidates.get(marker) || []), issue]);
  }
  const owned = new Map();
  for (const [marker, matches] of candidates) {
    if (matches.length !== 1) throw new Error(`Multiple issues claim ${kind} marker ${marker}; refusing ambiguous ownership.`);
    owned.set(marker, assertOwnedPlannerIssue(matches[0], marker, kind));
  }
  return owned;
}

function indexOwnedPrdIssues(issues) {
  const candidates = new Map();
  for (const issue of issues || []) {
    if (issue?.pull_request) continue;
    const rawMarker = findPrdMarker(issue?.body || "");
    if (!rawMarker) continue;
    const exactMarkers = [...String(issue.body || "").matchAll(/<!--\s*(df-prd:[a-z0-9-]+)\s*-->/g)].map((match) => match[1]);
    if (exactMarkers.length !== 1 || exactMarkers[0] !== rawMarker) {
      throw new Error(`PRD issue #${issue.number || "unknown"} does not carry one exact marker comment.`);
    }
    candidates.set(rawMarker, [...(candidates.get(rawMarker) || []), issue]);
  }
  const owned = new Map();
  for (const [marker, matches] of candidates) {
    if (matches.length !== 1) throw new Error(`Multiple issues claim PRD marker ${marker}; refusing ambiguous ownership.`);
    owned.set(marker, assertOwnedPlannerIssue(matches[0], marker, "PRD"));
  }
  return owned;
}

function findUniqueOwnedIssue(issues, marker, kind) {
  const candidates = (issues || []).filter((issue) => !issue?.pull_request && exactMarkerCount(issue?.body, marker) > 0);
  if (candidates.length > 1) throw new Error(`Multiple issues claim ${kind} marker ${marker}; refusing ambiguous ownership.`);
  if (candidates.length === 0) return null;
  return assertOwnedPlannerIssue(candidates[0], marker, kind);
}

async function revalidateOwnedIssue(github, repository, issueNumber, marker, markerFinder) {
  const issues = await listIssues(github, repository, "all");
  const matches = issues.filter((issue) => markerFinder(issue?.body || "") === marker);
  if (matches.length !== 1 || matches[0]?.number !== issueNumber) {
    throw new Error(`Planner issue marker ${marker} no longer has one exact admitted owner.`);
  }
  assertOwnedPlannerIssue(matches[0], marker, "planner");
  const current = await github.request("GET", `/repos/${repoName(repository)}/issues/${issueNumber}`);
  if (current?.number !== issueNumber || markerFinder(current?.body || "") !== marker) {
    throw new Error(`Planner issue #${issueNumber} changed marker after admission.`);
  }
  return assertOwnedPlannerIssue(current, marker, "planner");
}

async function upsertPrdBlockerIssue(repository, sourceRef, reason) {
  const marker = `df-prd-blocker:${slug(repoName(repository))}`;
  const issues = await listIssues(gh, repository, "all");
  const existing = findUniqueOwnedIssue(issues, marker, "PRD blocker");
  const body = [
    `<!-- ${marker} -->`,
    "## PRD Blocker",
    "",
    `Target repository: \`${repoName(repository)}\``,
    `Source ref: \`${sourceRef}\``,
    "",
    reason,
    "",
    "## Acceptance Criteria",
    "",
    "- Resolve the blocker so DarkFactory can open a PRD scaffold PR (e.g., enable writes, unarchive the repository, or create the PRD manually).",
    "- Re-run DarkFactory planning and confirm this blocker is closed.",
    "",
    "## Token Use",
    "",
    "- AI tokens: 0 (deterministic fleet bootstrap check)."
  ].join("\n");
  const title = `PRD scaffold blocked - ${repoName(repository)}`;
  const labels = ["P1", "df:ask-owner", "df:class:standard"];

  if (existing) {
    await revalidateOwnedIssue(gh, repository, existing.number, marker, (body) => body.includes(marker) ? marker : "");
    const updated = await gh.request("PATCH", `/repos/${repoName(repository)}/issues/${existing.number}`, {
      title,
      body,
      state: "open"
    });
    await setIssueLabels(gh, repository, existing.number, labels, { preserveWorkerState: false, expectedMarker: marker, markerFinder: (body) => body.includes(marker) ? marker : "" });
    return issueRef(updated);
  }

  const created = await gh.request("POST", `/repos/${repoName(repository)}/issues`, {
    title,
    body,
    labels
  });
  return issueRef(created);
}

async function setIssueLabels(gh, repository, issueNumber, labels, options = {}) {
  const markerFinder = options.markerFinder || ((body) => body.includes(options.expectedMarker) ? options.expectedMarker : "");
  const current = options.expectedMarker
    ? await revalidateOwnedIssue(gh, repository, issueNumber, options.expectedMarker, markerFinder)
    : await gh.request("GET", `/repos/${repoName(repository)}/issues/${issueNumber}`);
  const currentNames = new Set(
    (current.labels || []).map((label) => typeof label === "string" ? label : label.name).filter(Boolean)
  );
  const { add, remove } = plannedIssueLabelDiff([...currentNames], labels, options);
  if (options.invalidateReadiness === true) {
    for (const staleLabel of ["df:ready", "df:reviewed"]) {
      if (currentNames.has(staleLabel) && !remove.includes(staleLabel)) remove.push(staleLabel);
    }
  }

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

async function detectCodeDrift(repository, ref, items, staleMarkedIssues) {
  const findings = staleMarkedIssues.map((issue) => {
    const marker = findPrdMarker(issue.body || "");
    return `Backlog issue #${issue.number} still had stale marker \`${marker}\` after the PRD item was removed.`;
  });
  const itemText = items.map((item) => `${item.name} ${item.description}`).join("\n").toLowerCase();

  findings.push(...await detectPrdArtifactDrift(repository, ref, itemText));

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

  const pulls = await listOpenPullRequests(repository);
  for (const pull of pulls) {
    const closes = extractClosingIssueNumbers(pull.body || "", repoName(repository));
    const linkedToPrd = closes.some((number) => prdTrackedNumbers.has(number));
    if (!linkedToPrd) {
      findings.push(`Open PR #${pull.number} is not linked to a PRD-tracked issue.`);
    }
  }

  return findings;
}

async function detectPrdArtifactDrift(repository, ref, itemText) {
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
            { snippet: "setIssueLabels", reason: "reconcile PRD-backed issue metadata without dispatch authority" }
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

async function listOpenPullRequests(repository) {
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

async function upsertDriftIssue(repository, findings) {
  const marker = `df-prd-drift:${slug(repoName(repository))}`;
  const issues = await listIssues(gh, repository, "all");
  const existing = findUniqueOwnedIssue(issues, marker, "PRD drift");
  const body = driftIssueBody(repoName(repository), findings);
  const title = `PRD drift report - ${repoName(repository)}`;

  if (existing) {
    await revalidateOwnedIssue(gh, repository, existing.number, marker, findDriftMarker);
    const updated = await gh.request("PATCH", `/repos/${repoName(repository)}/issues/${existing.number}`, {
      title,
      body,
      state: "open"
    });
    await setIssueLabels(gh, repository, existing.number, ["P1", "df:prd-drift", "df:class:standard"], { expectedMarker: marker, markerFinder: findDriftMarker });
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

function isPlannerBotClosure(issue) {
  return normalizePlannerBotActor(issue?.closed_by) !== null;
}

function humanClosedPrdComment(item) {
  return [
    "DarkFactory L4 planning noticed this issue is closed, but the tracked PRD item is still marked as incomplete.",
    "",
    `PRD source: ${item.sourcePath || "PRD.md"} > ${item.section} > ${item.name}`,
    "",
    "If this work is done, please edit the PRD to mark the item `[x]`; otherwise reopen this issue so DarkFactory can continue tracking it.",
    "",
    "This disagreement has been escalated to a `df:ask-owner` planning issue in the control repository."
  ].join("\n");
}

function askOwnerIssueMarker(repository, item) {
  return `df-ask-owner:human-closed-prd:${slug(repoName(repository))}:${item.slug}`;
}

function askOwnerIssueTitle(repository, item) {
  return `Human-closed PRD item - ${repoName(repository)} > ${item.name}`;
}

function askOwnerIssueBody(repository, item, issue) {
  const marker = askOwnerIssueMarker(repository, item);
  return [
    `<!-- ${marker} -->`,
    "## Human-closed PRD item",
    "",
    `Target repository: \`${repoName(repository)}\``,
    `Closed issue: ${issue.html_url || `#${issue.number}`}`,
    `PRD source: ${item.sourcePath || "PRD.md"} > ${item.section} > ${item.name}`,
    "",
    "### Question",
    "",
    `The PRD still lists **${item.name}** as incomplete, but the linked issue was closed by a human. Should DarkFactory:`,
    "",
    "- Mark the PRD item as completed by editing it to `[x]`, or",
    "- Reopen the issue so the loop continues to track it.",
    "",
    "### Acceptance Criteria",
    "",
    "- Edit the PRD or reopen the issue so the PRD/backlog contradiction is resolved.",
    "- Re-run DarkFactory planning and confirm this ask-owner issue is closed.",
    "",
    "### Token Use",
    "",
    "- AI tokens: 0 (deterministic planning escalation)."
  ].join("\n");
}

async function escalateHumanClosedPrdIssue(gh, controlRepo, repository, item, issue) {
  await ensureLabels(gh, controlRepo, [...PLANNING_LABELS, ...WORK_LABELS]);
  const marker = askOwnerIssueMarker(repository, item);
  const issues = await listIssues(gh, controlRepo, "all");
  const existing = findUniqueOwnedIssue(issues, marker, "ask-owner");
  const title = askOwnerIssueTitle(repository, item);
  const body = askOwnerIssueBody(repository, item, issue);
  const labels = ["P1", "df:ask-owner", "df:class:standard"];

  if (existing) {
    await revalidateOwnedIssue(gh, controlRepo, existing.number, marker, (body) => body.includes(marker) ? marker : "");
    const updated = await gh.request("PATCH", `/repos/${repoName(controlRepo)}/issues/${existing.number}`, {
      title,
      body,
      state: "open"
    });
    await setIssueLabels(gh, controlRepo, existing.number, labels, { preserveWorkerState: false, expectedMarker: marker, markerFinder: (body) => body.includes(marker) ? marker : "" });
    return {
      action: "escalate-human-closed-prd-issue",
      marker: item.marker,
      issue: issueRef(issue),
      ask_owner_issue: issueRef(updated)
    };
  }

  await gh.request("POST", `/repos/${repoName(repository)}/issues/${issue.number}/comments`, {
    body: humanClosedPrdComment(item)
  });
  const created = await gh.request("POST", `/repos/${repoName(controlRepo)}/issues`, {
    title,
    body,
    labels
  });
  return {
    action: "escalate-human-closed-prd-issue",
    marker: item.marker,
    issue: issueRef(issue),
    ask_owner_issue: issueRef(created),
    comment: true
  };
}

async function handleClosedIncompletePrdIssue(gh, repository, controlRepo, item, existing, labels, blockedBy) {
  const current = await revalidateOwnedIssue(gh, repository, existing.number, item.marker, findPrdMarker);
  if (isPlannerBotClosure(current)) {
    const reopened = await gh.request("PATCH", `/repos/${repoName(repository)}/issues/${existing.number}`, {
      title: item.title,
      body: prdIssueBody(item, blockedBy),
      state: "open"
    });
    await setIssueLabels(gh, repository, existing.number, labels, {
      preserveWorkerState: false,
      invalidateReadiness: true,
      expectedMarker: item.marker,
      markerFinder: findPrdMarker
    });
    const action = { action: "reopen-prd-issue", marker: item.marker, issue: issueRef(reopened), labels };
    return { action, previousIssueNumber: reopened.number };
  }

  const escalation = await escalateHumanClosedPrdIssue(gh, controlRepo, repository, item, current);
  return { action: escalation, previousIssueNumber: current.number };
}

function issueRef(issue) {
  return { number: issue.number, url: issue.html_url };
}

export {
  PLANNER_BOT_LOGINS,
  normalizePlannerBotActor,
  assertOwnedPlannerIssue,
  indexOwnedPrdIssues,
  findOpenPrdScaffoldPullRequest,
  createPrdScaffoldPullRequest,
  assertTrustedPrdScaffoldPullRequest,
  armPrdScaffoldAutoMerge,
  scaffoldContentDigest,
  parsePrdScaffoldMarker,
  isPlannerBotClosure,
  humanClosedPrdComment,
  askOwnerIssueMarker,
  askOwnerIssueTitle,
  askOwnerIssueBody,
  escalateHumanClosedPrdIssue,
  handleClosedIncompletePrdIssue
};
