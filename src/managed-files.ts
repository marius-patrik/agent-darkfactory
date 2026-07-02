import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const AGENTS_GLOBAL_VERSION_PATH = ".agents/.global/VERSION";
export const GITHUB_BOOTSTRAP_WORKFLOW_PATH = ".github/workflows/vibe-bot-bootstrap.yml";

export interface ManagedFile {
  path: string;
  content: string;
}

const MANAGED_FILE_PATHS = [
  ".agents/.global/AGENT_PROTOCOL.md",
  ".agents/.global/DOCS_AND_MEMORY.md",
  ".agents/.global/VALIDATION.md",
  AGENTS_GLOBAL_VERSION_PATH,
  ".agents/.global/WORKFLOW.md",
  ".agents/.global/skills/status/SKILL.md",
  ".agents/.global/skills/status/scripts/print_status.mjs",
  GITHUB_BOOTSTRAP_WORKFLOW_PATH
] as const;

export function readManagedFiles(root = resolveProjectRoot()): ManagedFile[] {
  return MANAGED_FILE_PATHS.map((path) => ({
    path,
    content: readFileSync(resolve(root, path), "utf8").replace(/\r\n/g, "\n")
  }));
}

function resolveProjectRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}
