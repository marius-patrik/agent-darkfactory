import path from "node:path";
import { lstat, readlink } from "node:fs/promises";
import { resolvePersonalAgentsHome, resolveUserHome } from "./runtime-paths";

export type ToolStateId = "claude" | "codex" | "kimi" | "agy" | "agents";

export interface ToolStateSpec {
  id: ToolStateId;
  displayName: string;
  forbiddenHomeName: string | null;
}

export interface ToolStatus {
  id: ToolStateId;
  displayName: string;
  forbidden: string | null;
  canonical: string;
  location: "forbidden" | "canonical" | "split" | "missing";
  forbiddenLinkTarget: string | null;
}

export const toolStateSpecs: ToolStateSpec[] = [
  { id: "claude", displayName: "Claude", forbiddenHomeName: ".claude" },
  { id: "codex", displayName: "Codex", forbiddenHomeName: ".codex" },
  { id: "kimi", displayName: "Kimi", forbiddenHomeName: ".kimi-code" },
  { id: "agy", displayName: "Agy", forbiddenHomeName: ".gemini" },
  { id: "agents", displayName: "Agent OS", forbiddenHomeName: null },
];

function toolStateSpec(id: ToolStateId): ToolStateSpec {
  const spec = toolStateSpecs.find((candidate) => candidate.id === id);
  if (!spec) throw new Error(`unknown tool state id: ${id}`);
  return spec;
}

export function defaultAgentsHome(): string {
  return resolvePersonalAgentsHome();
}

export function toolForbiddenPath(id: Exclude<ToolStateId, "agents">, homeDir = resolveUserHome()): string {
  const name = toolStateSpec(id).forbiddenHomeName;
  if (!name) throw new Error(`tool has no forbidden standalone home: ${id}`);
  return path.join(homeDir, name);
}

export function toolCanonicalPath(id: ToolStateId, agentsHome = defaultAgentsHome()): string {
  return id === "agents" ? agentsHome : path.join(agentsHome, "clis", id);
}

async function pathInfo(filePath: string): Promise<{ exists: boolean; linkTarget: string | null }> {
  try {
    const info = await lstat(filePath);
    if (!info.isSymbolicLink()) return { exists: true, linkTarget: null };
    const target = await readlink(filePath);
    return { exists: true, linkTarget: path.resolve(path.dirname(filePath), target) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, linkTarget: null };
    throw error;
  }
}

export async function readToolStatus(
  id: ToolStateId,
  homeDir = resolveUserHome(),
  agentsHome = defaultAgentsHome(),
): Promise<ToolStatus> {
  const spec = toolStateSpec(id);
  const canonical = toolCanonicalPath(id, agentsHome);
  const canonicalInfo = await pathInfo(canonical);

  if (id === "agents") {
    return {
      id,
      displayName: spec.displayName,
      forbidden: null,
      canonical,
      location: canonicalInfo.exists ? "canonical" : "missing",
      forbiddenLinkTarget: null,
    };
  }

  const forbidden = toolForbiddenPath(id, homeDir);
  const forbiddenInfo = await pathInfo(forbidden);
  const location: ToolStatus["location"] =
    forbiddenInfo.exists && canonicalInfo.exists
      ? "split"
      : forbiddenInfo.exists
        ? "forbidden"
        : canonicalInfo.exists
          ? "canonical"
          : "missing";

  return {
    id,
    displayName: spec.displayName,
    forbidden,
    canonical,
    location,
    forbiddenLinkTarget: forbiddenInfo.linkTarget,
  };
}

export function formatToolStatus(tools: ToolStatus[]): string {
  return tools
    .map((tool) => {
      const violation = tool.forbidden
        ? `${tool.forbidden}${tool.forbiddenLinkTarget ? ` -> ${tool.forbiddenLinkTarget}` : ""}`
        : "-";
      return `${tool.displayName.padEnd(10)} ${tool.location.padEnd(10)} canonical=${tool.canonical} forbidden=${violation}`;
    })
    .join("\n");
}
