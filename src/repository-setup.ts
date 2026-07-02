import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { GITHUB_BOOTSTRAP_WORKFLOW_PATH } from "./managed-files.js";

export const REPOSITORY_SETUP_COMMENT_MARKER = "<!-- vibe-bot:repository-setup -->";

const VERSIONED_FOLDERS = [
  {
    displayPath: ".agents/.global",
    versionPath: ".agents/.global/VERSION"
  }
] as const;

const BOOTSTRAP_PATHS = [
  {
    displayPath: ".github",
    requiredPath: GITHUB_BOOTSTRAP_WORKFLOW_PATH,
    reason: "Vibe Bot bootstrap workflow"
  }
] as const;

export interface GitHubRequester {
  request(route: string, parameters: Record<string, unknown>): Promise<{ data: unknown }>;
}

export interface RepositoryRef {
  owner: string;
  repo: string;
  ref: string;
}

export interface RepositorySetupReport {
  expectedVersion: string;
  versionedFolders: VersionedFolderResult[];
  bootstrapPaths: BootstrapPathResult[];
}

export interface VersionedFolderResult {
  kind: "versioned";
  displayPath: string;
  versionPath: string;
  expectedVersion: string;
  status: "current" | "missing" | "stale" | "unreadable";
  actualVersion?: string;
  message?: string;
}

export interface BootstrapPathResult {
  kind: "bootstrap";
  displayPath: string;
  requiredPath: string;
  reason: string;
  status: "present" | "missing" | "unreadable";
  message?: string;
}

export function expectedManagedFolderVersion(packageVersion = readPackageVersion()): string {
  return `vibe-bot@${packageVersion}`;
}

export async function checkRepositorySetup(
  github: GitHubRequester,
  target: RepositoryRef,
  expectedVersion = expectedManagedFolderVersion()
): Promise<RepositorySetupReport> {
  const versionedFolders = await Promise.all(
    VERSIONED_FOLDERS.map((folder) => checkVersionedFolder(github, target, folder, expectedVersion))
  );
  const bootstrapPaths = await Promise.all(
    BOOTSTRAP_PATHS.map((path) => checkBootstrapPath(github, target, path))
  );

  return {
    expectedVersion,
    versionedFolders,
    bootstrapPaths
  };
}

export function formatRepositorySetupComment(report: RepositorySetupReport): string | null {
  const staleVersionedFolders = report.versionedFolders.filter((folder) => folder.status !== "current");
  const missingBootstrapPaths = report.bootstrapPaths.filter((path) => path.status !== "present");

  if (staleVersionedFolders.length === 0 && missingBootstrapPaths.length === 0) {
    return null;
  }

  const lines = [
    REPOSITORY_SETUP_COMMENT_MARKER,
    "Vibe Bot found repository setup that needs attention.",
    "",
    `Expected managed agent version: \`${report.expectedVersion}\`.`,
    "",
    "| Area | Required file | Status | Found |",
    "| --- | --- | --- | --- |"
  ];

  for (const folder of staleVersionedFolders) {
    lines.push(
      `| \`${folder.displayPath}\` | \`${folder.versionPath}\` | ${versionedStatus(folder)} | ${
        folder.actualVersion ? `\`${folder.actualVersion}\`` : "-"
      } |`
    );
  }

  for (const path of missingBootstrapPaths) {
    lines.push(
      `| \`${path.displayPath}\` | \`${path.requiredPath}\` | ${bootstrapStatus(path)} | - |`
    );
  }

  lines.push(
    "",
    "Update `.agents/.global` from the current Vibe Bot template when the agent version is stale or missing.",
    `Bootstrap \`${GITHUB_BOOTSTRAP_WORKFLOW_PATH}\` when the GitHub workflow scaffold is missing.`
  );

  return lines.join("\n");
}

async function checkVersionedFolder(
  github: GitHubRequester,
  target: RepositoryRef,
  folder: (typeof VERSIONED_FOLDERS)[number],
  expectedVersion: string
): Promise<VersionedFolderResult> {
  const content = await fetchTextFile(github, target, folder.versionPath);

  if (content.status !== "current") {
    return {
      kind: "versioned",
      displayPath: folder.displayPath,
      versionPath: folder.versionPath,
      expectedVersion,
      status: content.status,
      message: content.message
    };
  }

  const actualVersion = content.text.trim();

  return {
    kind: "versioned",
    displayPath: folder.displayPath,
    versionPath: folder.versionPath,
    expectedVersion,
    status: actualVersion === expectedVersion ? "current" : "stale",
    actualVersion
  };
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

function versionedStatus(folder: VersionedFolderResult): string {
  if (folder.status === "missing") {
    return "missing";
  }

  if (folder.status === "stale") {
    return "stale";
  }

  if (folder.status === "unreadable") {
    return "unreadable";
  }

  return "current";
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

function readPackageVersion(): string {
  const packageJsonPath = resolve(dirname(fileURLToPath(import.meta.url)), "../package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as unknown;

  if (!isRecord(packageJson) || typeof packageJson.version !== "string") {
    throw new Error("package.json is missing a string version");
  }

  return packageJson.version;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequestError(error: unknown): error is { status: number } {
  return isRecord(error) && typeof error.status === "number";
}
