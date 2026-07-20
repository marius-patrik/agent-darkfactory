import path from "node:path";
import { lstat, readlink } from "node:fs/promises";
import { resolvePersonalAgentsHome, resolveUserHome } from "./runtime-paths";

export type ToolStateId = "claude" | "codex" | "kimi" | "agy" | "agents";

export interface ToolStateSpec {
  id: ToolStateId;
  displayName: string;
  forbiddenHomeName: string | null;
  appOwnedPlatforms: NodeJS.Platform[];
}

export interface ToolStatus {
  id: ToolStateId;
  displayName: string;
  forbidden: string | null;
  canonical: string;
  location: "forbidden" | "canonical" | "app-owned" | "split" | "missing";
  forbiddenLinkTarget: string | null;
}

export const toolStateSpecs: ToolStateSpec[] = [
  { id: "claude", displayName: "Claude", forbiddenHomeName: ".claude", appOwnedPlatforms: ["win32"] },
  { id: "codex", displayName: "Codex", forbiddenHomeName: ".codex", appOwnedPlatforms: ["win32"] },
  { id: "kimi", displayName: "Kimi", forbiddenHomeName: ".kimi-code", appOwnedPlatforms: [] },
  // Antigravity resolves its config root from the OS user profile on Windows,
  // so an owner-interactive ~/.gemini coexists with canonical authority the
  // same way the Claude and Codex desktop roots do (#293).
  { id: "agy", displayName: "Agy", forbiddenHomeName: ".gemini", appOwnedPlatforms: ["win32"] },
  { id: "agents", displayName: "Agent OS", forbiddenHomeName: null, appOwnedPlatforms: [] },
];

export function classifyProviderRootLocation(input: {
  canonicalExists: boolean;
  standaloneExists: boolean;
  standaloneLinkTarget: string | null;
  appOwnedAllowed: boolean;
}): ToolStatus["location"] {
  if (!input.standaloneExists) return input.canonicalExists ? "canonical" : "missing";
  if (!input.canonicalExists) return "forbidden";
  if (input.appOwnedAllowed && input.standaloneLinkTarget === null) return "app-owned";
  return "split";
}

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
  platform: NodeJS.Platform = process.platform,
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
  const location = classifyProviderRootLocation({
    canonicalExists: canonicalInfo.exists,
    standaloneExists: forbiddenInfo.exists,
    standaloneLinkTarget: forbiddenInfo.linkTarget,
    appOwnedAllowed: spec.appOwnedPlatforms.includes(platform),
  });

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
