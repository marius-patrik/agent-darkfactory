import path from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import type { SharedState } from "./state";
import { stateV2Paths, writeTextAtomic } from "./state-v2";
import { withStateFileLock } from "./state-lock";

export type ProviderId = "codex" | "claude" | "kimi" | "agy";

export interface ProviderRegistration {
  id: ProviderId;
  executable: string;
  resolvedExecutable: string;
  sha256: string;
  version: string;
  pinnedAt: string;
}

export interface ProviderRegistry {
  schemaVersion: 1;
  providers: Partial<Record<ProviderId, ProviderRegistration>>;
}

export interface ProviderVerification {
  registration: ProviderRegistration;
  ok: boolean;
  issues: string[];
}

function emptyRegistry(): ProviderRegistry {
  return { schemaVersion: 1, providers: {} };
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

export async function readProviderRegistry(state: SharedState): Promise<ProviderRegistry> {
  const filePath = stateV2Paths(state).providersFile;
  if (!(await Bun.file(filePath).exists())) return emptyRegistry();
  const parsed = JSON.parse(await Bun.file(filePath).text()) as Partial<ProviderRegistry>;
  if (parsed.schemaVersion !== 1 || !parsed.providers || typeof parsed.providers !== "object" || Array.isArray(parsed.providers)) {
    throw new Error(`invalid provider registry: ${filePath}`);
  }
  for (const [key, value] of Object.entries(parsed.providers)) {
    if (!new Set<ProviderId>(["codex", "claude", "kimi", "agy"]).has(key as ProviderId)) {
      throw new Error(`invalid provider id in registry: ${key}`);
    }
    const record = value as Partial<ProviderRegistration>;
    if (
      !record ||
      record.id !== key ||
      typeof record.executable !== "string" ||
      !path.isAbsolute(record.executable) ||
      typeof record.resolvedExecutable !== "string" ||
      !path.isAbsolute(record.resolvedExecutable) ||
      typeof record.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(record.sha256) ||
      typeof record.version !== "string" ||
      !record.version.trim() ||
      typeof record.pinnedAt !== "string" ||
      new Date(record.pinnedAt).toISOString() !== record.pinnedAt
    ) {
      throw new Error(`invalid provider registration: ${key}`);
    }
  }
  return parsed as ProviderRegistry;
}

export async function inspectProviderExecutable(
  id: ProviderId,
  executable: string,
  version: string,
  pinnedAt = new Date().toISOString(),
): Promise<ProviderRegistration> {
  if (!path.isAbsolute(executable)) throw new Error(`provider executable must be absolute: ${executable}`);
  const resolvedExecutable = await realpath(executable);
  const info = await stat(resolvedExecutable);
  if (!info.isFile()) throw new Error(`provider executable is not a file: ${resolvedExecutable}`);
  return {
    id,
    executable: path.resolve(executable),
    resolvedExecutable,
    sha256: await sha256File(resolvedExecutable),
    version: version.trim(),
    pinnedAt,
  };
}

export async function writeProviderRegistration(
  state: SharedState,
  registration: ProviderRegistration,
): Promise<ProviderRegistry> {
  return withStateFileLock(state, "providers", async () => {
    const registry = await readProviderRegistry(state);
    registry.providers[registration.id] = registration;
    const ordered: ProviderRegistry = {
      schemaVersion: 1,
      providers: Object.fromEntries(
        (Object.entries(registry.providers) as Array<[ProviderId, ProviderRegistration]>).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ) as ProviderRegistry["providers"],
    };
    await writeTextAtomic(stateV2Paths(state).providersFile, `${JSON.stringify(ordered, null, 2)}\n`);
    return ordered;
  });
}

export async function verifyProviderRegistration(
  registration: ProviderRegistration,
): Promise<ProviderVerification> {
  const issues: string[] = [];
  let resolvedExecutable: string | null = null;
  try {
    resolvedExecutable = await realpath(registration.executable);
  } catch {
    issues.push(`pinned executable is missing: ${registration.executable}`);
  }
  if (resolvedExecutable && resolvedExecutable !== registration.resolvedExecutable) {
    issues.push(`pinned executable target changed: ${registration.executable}`);
  }
  if (resolvedExecutable) {
    const digest = await sha256File(resolvedExecutable);
    if (digest !== registration.sha256) issues.push(`pinned executable checksum changed: ${registration.executable}`);
  }
  return { registration, ok: issues.length === 0, issues };
}
