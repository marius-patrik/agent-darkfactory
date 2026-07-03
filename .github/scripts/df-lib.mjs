import { readFile, rm } from "node:fs/promises";

export const API_ROOT = "https://api.github.com";
export const DEFAULT_DATA_REPO = "marius-patrik/darkfactory-data";
export const PARKED_REPOS = new Set([
  "marius-patrik/fabrica",
  "marius-patrik/skyblock-agent",
  "marius-patrik/singularity",
  "marius-patrik/life-support"
]);

export const WORK_LABELS = [
  { name: "df:ready", color: "0E8A16", description: "DarkFactory work loop may pick up this issue" },
  { name: "df:running", color: "1D76DB", description: "DarkFactory worker is running for this issue" },
  { name: "df:blocked", color: "B60205", description: "DarkFactory worker is blocked on this issue" },
  { name: "df:done", color: "5319E7", description: "DarkFactory worker completed this issue" },
  { name: "df:class:mechanical", color: "C5DEF5", description: "DarkFactory mechanical task; use low reasoning effort" },
  { name: "df:class:standard", color: "BFDADC", description: "DarkFactory standard task; use medium reasoning effort" },
  { name: "df:class:hard", color: "D4C5F9", description: "DarkFactory hard task; use high reasoning effort" }
];

export const PLANNING_LABELS = [
  { name: "roadmap", color: "5319E7", description: "DarkFactory roadmap item" },
  { name: "P0", color: "B60205", description: "Priority 0: urgent or release-blocking" },
  { name: "P1", color: "D93F0B", description: "Priority 1: important planned work" },
  { name: "P2", color: "FBCA04", description: "Priority 2: follow-up or lower urgency" },
  { name: "df:prd-drift", color: "B60205", description: "DarkFactory PRD drift report" }
];

export function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export function parseRepo(value) {
  const match = value.trim().match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) throw new Error(`Invalid repository name: ${value}`);
  return { owner: match[1], repo: match[2] };
}

export function repoName(repository) {
  return `${repository.owner}/${repository.repo}`;
}

export function assertAllowedRepo(repository) {
  const name = repoName(repository).toLowerCase();
  if (PARKED_REPOS.has(name)) {
    throw new Error(`Refusing to touch parked repository: ${repoName(repository)}`);
  }
}

export function slug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "item";
}

export function taskClassFromLabels(labels) {
  const names = new Set(
    (Array.isArray(labels) ? labels : [])
      .map((label) => typeof label === "string" ? label : label?.name)
      .filter(Boolean)
  );

  if (names.has("df:class:mechanical")) return { taskClass: "mechanical", effort: "low" };
  if (names.has("df:class:hard")) return { taskClass: "hard", effort: "high" };
  return { taskClass: "standard", effort: "medium" };
}

export async function cleanupTempRoot(tempRoot, warn = console.warn) {
  if (!tempRoot) return { ok: true, warning: "" };

  try {
    await rm(tempRoot, { recursive: true, force: true });
    return { ok: true, warning: "" };
  } catch (error) {
    const warning = `DarkFactory cleanup warning: ${error.message || String(error)}`;
    warn(warning);
    return { ok: false, warning };
  }
}

export function createGithubClient(token, userAgent = "darkfactory") {
  return {
    async request(method, pathName, body) {
      const response = await fetch(`${API_ROOT}${pathName}`, {
        method,
        headers: {
          "Accept": "application/vnd.github+json",
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": userAgent
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });

      if (!response.ok) {
        const text = await response.text();
        const error = new Error(`${method} ${pathName} failed with ${response.status}: ${sanitize(text, token)}`);
        error.status = response.status;
        throw error;
      }

      if (response.status === 204) return null;
      return await response.json();
    },

    async graphql(query, variables) {
      const response = await fetch(`${API_ROOT}/graphql`, {
        method: "POST",
        headers: {
          "Accept": "application/vnd.github+json",
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": userAgent
        },
        body: JSON.stringify({ query, variables })
      });
      const payload = await response.json();
      if (!response.ok || payload.errors?.length) {
        throw new Error(sanitize(JSON.stringify(payload.errors || payload), token));
      }
      return payload.data;
    }
  };
}

export async function ensureLabels(gh, repository, labels) {
  for (const label of labels) {
    try {
      await gh.request("POST", `/repos/${repoName(repository)}/labels`, label);
    } catch (error) {
      if (error.status !== 422) throw error;
      await gh.request("PATCH", `/repos/${repoName(repository)}/labels/${encodeURIComponent(label.name)}`, {
        color: label.color,
        description: label.description
      });
    }
  }
}

export async function getRepository(gh, repository) {
  return await gh.request("GET", `/repos/${repoName(repository)}`);
}

export async function getOptionalFileContent(gh, repository, filePath, ref) {
  try {
    const data = await gh.request(
      "GET",
      `/repos/${repoName(repository)}/contents/${encodePath(filePath)}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`
    );
    return decodeContentResponse(data);
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

export async function listIssues(gh, repository, state = "all") {
  const issues = [];
  for (let page = 1; page <= 20; page += 1) {
    const batch = await gh.request(
      "GET",
      `/repos/${repoName(repository)}/issues?state=${state}&per_page=100&page=${page}`
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    issues.push(...batch.filter((issue) => !issue.pull_request));
    if (batch.length < 100) break;
  }
  return issues;
}

export function parsePrdItems(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const items = [];
  let section = "";

  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      section = heading[1].trim();
      continue;
    }

    const bullet = line.match(/^-\s+\*\*(.+?)\*\*:?\s*(.*)$/);
    if (!bullet) continue;
    if (!/^(core loops|milestones)$/i.test(section)) continue;

    const name = bullet[1].trim();
    const detail = bullet[2].trim();
    const acceptanceMatch = detail.match(/\bAcceptance:\s*(.+)$/i);
    const description = acceptanceMatch ? detail.slice(0, acceptanceMatch.index).trim() : detail;
    const acceptance = acceptanceMatch ? acceptanceMatch[1].trim() : "";
    const priority = /^M[1-3]\b/i.test(name) || /^L[0-4]\b/i.test(name) ? "P1" : "P2";
    const marker = `df-prd:${slug(`${section}-${name}`)}`;

    items.push({
      marker,
      slug: marker.slice("df-prd:".length),
      section,
      name,
      title: prdIssueTitle(name),
      description,
      acceptance,
      priority,
      taskClass: classifyPrdItem(name, description)
    });
  }

  return items;
}

export function prdIssueBody(item, blockedBy = []) {
  const acceptance = item.acceptance
    ? `- ${item.acceptance}`
    : "- Keep implementation aligned with the PRD item and update this issue when the PRD changes.";
  const blockedByLines = blockedBy.length
    ? ["", "## Sequencing", "", ...blockedBy.map((issueNumber) => `Blocked-by: #${issueNumber}`)]
    : [];

  return [
    `<!-- ${item.marker} -->`,
    "## Source",
    "",
    `PRD.md > ${item.section} > ${item.name}`,
    "",
    "## PRD Item",
    "",
    item.description || item.name,
    "",
    "## Acceptance Criteria",
    "",
    acceptance,
    ...blockedByLines,
    "",
    "## Planning Notes",
    "",
    "- Generated by DarkFactory L4 planning using deterministic PRD parsing.",
    "- Stable marker keeps this issue linked to the PRD across title/body edits.",
    "- Harness migration path: this remains GitHub-native state until L0/L4 scheduling moves into the harness scheduler."
  ].join("\n");
}

export function driftIssueBody(targetRepoName, driftItems) {
  return [
    `<!-- df-prd-drift:${slug(targetRepoName)} -->`,
    "## Drift Report",
    "",
    `Target repository: \`${targetRepoName}\``,
    "",
    "DarkFactory found backlog or code state that no longer matches the root PRD.",
    "",
    "## Findings",
    "",
    driftItems.map((item) => `- ${item}`).join("\n") || "- No drift details were provided.",
    "",
    "## Acceptance Criteria",
    "",
    "- Reconcile the repository state, backlog, or PRD so the contradiction is gone.",
    "- Re-run DarkFactory planning and confirm this drift report is no longer updated.",
    "",
    "## Token Use",
    "",
    "- AI tokens: 0 (deterministic drift detection)."
  ].join("\n");
}

export function findPrdMarker(body) {
  return body?.match(/df-prd:[a-z0-9-]+/)?.[0] ?? "";
}

export function findDriftMarker(body) {
  return body?.match(/df-prd-drift:[a-z0-9-]+/)?.[0] ?? "";
}

export function checksAreGreen(statusCheckRollup) {
  if (!Array.isArray(statusCheckRollup) || statusCheckRollup.length === 0) return true;

  return statusCheckRollup.every((check) => {
    if (check.__typename === "CheckRun") {
      return check.status === "COMPLETED" && ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(check.conclusion);
    }
    if (check.__typename === "StatusContext") {
      return check.state === "SUCCESS";
    }
    return false;
  });
}

export function checksSummary(statusCheckRollup) {
  if (!Array.isArray(statusCheckRollup) || statusCheckRollup.length === 0) return "no checks configured";
  return statusCheckRollup.map((check) => {
    if (check.__typename === "CheckRun") return `${check.name}:${check.status}/${check.conclusion ?? "none"}`;
    if (check.__typename === "StatusContext") return `${check.context}:${check.state}`;
    return check.__typename ?? "unknown";
  }).join(", ");
}

export function extractClosingIssueNumbers(body) {
  const refs = new Set();
  const matches = body?.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi) ?? [];
  for (const match of matches) refs.add(Number(match[1]));
  return [...refs].filter((number) => Number.isInteger(number) && number > 0);
}

export async function writeRunLedger(gh, dataRepo, kind, targetRepoName, ledger) {
  const repository = parseRepo(dataRepo || DEFAULT_DATA_REPO);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = `runs/${targetRepoName}/${timestamp}-${kind}.json`;
  const body = `${JSON.stringify({
    kind,
    target_repo: targetRepoName,
    created_at: new Date().toISOString(),
    ...ledger
  }, null, 2)}\n`;
  const existing = await getOptionalContentWithSha(gh, repository, path);

  await gh.request("PUT", `/repos/${repoName(repository)}/contents/${encodePath(path)}`, {
    message: `Add DarkFactory ${kind} ledger for ${targetRepoName}`,
    content: Buffer.from(body, "utf8").toString("base64"),
    sha: existing?.sha
  });

  return { repository: repoName(repository), path };
}

export async function readLocalJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export function sanitize(value, ...secrets) {
  let out = String(value);
  for (const secret of secrets.filter(Boolean)) {
    out = out.split(secret).join("***");
    out = out.split(Buffer.from(`x-access-token:${secret}`).toString("base64")).join("***");
  }
  return out;
}

function prdIssueTitle(name) {
  const normalized = name.replace(/\s+[—-]\s+/, " - ");
  return normalized.match(/^(M\d+|L\d+)\b/i) ? normalized : `PRD - ${normalized}`;
}

function classifyPrdItem(name, description) {
  const text = `${name} ${description}`.toLowerCase();
  if (/\b(label|docs?|comment|cleanup|mechanical|managed file)\b/.test(text)) return "mechanical";
  if (/\b(orchestrator|audit|semantic|cross-repo|cluster|scheduler|review gate)\b/.test(text)) return "hard";
  return "standard";
}

async function getOptionalContentWithSha(gh, repository, filePath) {
  try {
    const data = await gh.request("GET", `/repos/${repoName(repository)}/contents/${encodePath(filePath)}`);
    if (data?.type !== "file" || typeof data.sha !== "string") return null;
    return { sha: data.sha };
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

function decodeContentResponse(data) {
  if (!data || data.type !== "file" || typeof data.content !== "string") return null;
  const encoding = typeof data.encoding === "string" ? data.encoding : "base64";
  if (encoding !== "base64") return null;
  return Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf8").replace(/\r\n/g, "\n");
}

function encodePath(filePath) {
  return filePath.split("/").map(encodeURIComponent).join("/");
}
