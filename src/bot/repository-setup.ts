import {
  DARK_FACTORY_AUTOREVIEW_WORKFLOW_PATH,
  DARK_FACTORY_AUTOUPDATE_WORKFLOW_PATH,
  GITHUB_BOOTSTRAP_WORKFLOW_PATH,
  requiredManagedFilePaths
} from "./managed-files.js";

export const REPOSITORY_SETUP_COMMENT_MARKER = "<!-- dark-factory:repository-setup -->";

const BOOTSTRAP_PATHS = requiredManagedFilePaths()
  .map((path) => ({
    displayPath: path === "AGENTS.md" ? "repository" : path.startsWith(".github/") ? ".github" : ".agents",
    requiredPath: path,
    reason: managedPathReason(path)
  })) as Array<{ displayPath: string; requiredPath: string; reason: string }>;

export interface GitHubRequester {
  request(route: string, parameters: Record<string, unknown>): Promise<{ data: unknown }>;
}

export interface RepositoryRef {
  owner: string;
  repo: string;
  ref: string;
}

export interface RepositorySetupReport {
  bootstrapPaths: BootstrapPathResult[];
}

export interface BootstrapPathResult {
  kind: "bootstrap";
  displayPath: string;
  requiredPath: string;
  reason: string;
  status: "present" | "missing" | "unreadable";
  message?: string;
}

export async function checkRepositorySetup(
  github: GitHubRequester,
  target: RepositoryRef
): Promise<RepositorySetupReport> {
  const bootstrapPaths = await Promise.all(
    BOOTSTRAP_PATHS.map((path) => checkBootstrapPath(github, target, path))
  );

  return {
    bootstrapPaths
  };
}

export function formatRepositorySetupComment(report: RepositorySetupReport): string | null {
  const missingBootstrapPaths = report.bootstrapPaths.filter((path) => path.status !== "present");

  if (missingBootstrapPaths.length === 0) {
    return null;
  }

  const lines = [
    REPOSITORY_SETUP_COMMENT_MARKER,
    "Dark Factory found repository setup that needs attention.",
    "",
    "| Area | Required file | Status |",
    "| --- | --- | --- |"
  ];

  for (const path of missingBootstrapPaths) {
    lines.push(
      `| \`${path.displayPath}\` | \`${path.requiredPath}\` | ${bootstrapStatus(path)} |`
    );
  }

  lines.push(
    "",
    `Bootstrap \`${GITHUB_BOOTSTRAP_WORKFLOW_PATH}\`, \`${DARK_FACTORY_AUTOUPDATE_WORKFLOW_PATH}\`, and \`${DARK_FACTORY_AUTOREVIEW_WORKFLOW_PATH}\` when GitHub workflow scaffolding is missing.`,
    "Keep repository-local `AGENTS.md` and `.agents/project` context aligned with the Agent OS authority in `$ANDROMEDA_HOME`.",
    "Keep `.darkfactory` policy files from canonical private-data so installer, updater, and orchestration expectations stay consistent.",
    "Install the DarkFactory GitHub App credentials and an online `df-local` runner with canonical `$ANDROMEDA_HOME`; provider credentials remain in Agent OS, never repository secrets."
  );

  return lines.join("\n");
}

function managedPathReason(path: string): string {
  if (path === DARK_FACTORY_AUTOREVIEW_WORKFLOW_PATH) return "DarkFactory Autoreview workflow";
  if (path === GITHUB_BOOTSTRAP_WORKFLOW_PATH) return "DarkFactory installer workflow";
  if (path === DARK_FACTORY_AUTOUPDATE_WORKFLOW_PATH) return "DarkFactory auto-update sentinel workflow";
  if (path.startsWith(".agents/")) return "DarkFactory managed policy";
  return "DarkFactory managed workflow support";
}

async function checkBootstrapPath(
  github: GitHubRequester,
  target: RepositoryRef,
  path: (typeof BOOTSTRAP_PATHS)[number]
): Promise<BootstrapPathResult> {
  const content = await fetchTextFile(github, target, path.requiredPath);

  if (content.status === "current") {
    return {
      kind: "bootstrap",
      displayPath: path.displayPath,
      requiredPath: path.requiredPath,
      reason: path.reason,
      status: "present"
    };
  }

  return {
    kind: "bootstrap",
    displayPath: path.displayPath,
    requiredPath: path.requiredPath,
    reason: path.reason,
    status: content.status,
    message: content.message
  };
}

async function fetchTextFile(
  github: GitHubRequester,
  target: RepositoryRef,
  path: string
): Promise<{ status: "current"; text: string } | { status: "missing" | "unreadable"; message?: string }> {
  try {
    const response = await github.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner: target.owner,
      repo: target.repo,
      path,
      ref: target.ref
    });

    const decoded = decodeContentResponse(response.data);

    if (decoded === null) {
      return { status: "unreadable", message: "GitHub returned a non-file content response." };
    }

    return { status: "current", text: decoded };
  } catch (error) {
    if (isRequestError(error) && error.status === 404) {
      return { status: "missing", message: "File not found." };
    }

    return {
      status: "unreadable",
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

function decodeContentResponse(data: unknown): string | null {
  if (!isRecord(data)) {
    return null;
  }

  if (data.type !== "file" || typeof data.content !== "string") {
    return null;
  }

  const encoding = typeof data.encoding === "string" ? data.encoding : "base64";

  if (encoding !== "base64") {
    return null;
  }

  return Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf8");
}

function bootstrapStatus(path: BootstrapPathResult): string {
  if (path.status === "missing") {
    return `missing ${path.reason}`;
  }

  if (path.status === "unreadable") {
    return "unreadable";
  }

  return "present";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequestError(error: unknown): error is { status: number } {
  return isRecord(error) && typeof error.status === "number";
}
