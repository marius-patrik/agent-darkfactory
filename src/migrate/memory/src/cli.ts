#!/usr/bin/env bun
import { ensureSharedState, sharedStateFromEnv } from "../../manager/src/state";
import {
  applyMemoryCandidate,
  memoryPluginStatus,
  migrateDreamV13Cursor,
  processHistoricalCorpus,
  reflectCanonicalSession,
  restoreDreamV13CursorProjection,
  runIdleDreamCycle,
} from "./index";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function positiveInteger(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function usage(): never {
  throw new Error(
    "usage: memory <reflect SESSION_ID | dream | corpus ROOT [--apply] | migrate SOURCE | restore | status>",
  );
}

export async function runMemoryCli(args = process.argv.slice(2)): Promise<unknown> {
  const [command, operand] = args;
  if (!command) usage();
  const state = sharedStateFromEnv(process.cwd());
  await ensureSharedState(state);
  if (command === "reflect") {
    if (!operand || operand.startsWith("--")) usage();
    const candidate = await reflectCanonicalSession(state, operand, {
      maximumEvents: positiveInteger(option(args, "--maximum-events"), 10_000, "maximum events"),
      maximumBytes: positiveInteger(option(args, "--maximum-bytes"), 16 * 1024 * 1024, "maximum bytes"),
      maximumScannedEntries: positiveInteger(
        option(args, "--maximum-scanned-entries"),
        20_000,
        "maximum scanned entries",
      ),
    });
    const record = await applyMemoryCandidate(state, candidate, { authorId: "memory-plugin:reflection" });
    return { candidate, record };
  }
  if (command === "dream") {
    return runIdleDreamCycle(state, {
      minimumIdleMs: positiveInteger(option(args, "--minimum-idle-ms"), 30 * 60_000, "minimum idle milliseconds"),
      maximumSessions: positiveInteger(option(args, "--maximum-sessions"), 8, "maximum sessions"),
      maximumScannedSessions: positiveInteger(
        option(args, "--maximum-scanned-sessions"),
        1_000,
        "maximum scanned sessions",
      ),
      maximumScannedSessionEntries: positiveInteger(
        option(args, "--maximum-scanned-session-entries"),
        2_000,
        "maximum scanned session entries",
      ),
      maximumEventsPerSession: positiveInteger(
        option(args, "--maximum-events-per-session"),
        10_000,
        "maximum events per session",
      ),
      maximumTotalEvents: positiveInteger(
        option(args, "--maximum-total-events"),
        50_000,
        "maximum total events",
      ),
      maximumBytesPerSession: positiveInteger(
        option(args, "--maximum-bytes-per-session"),
        16 * 1024 * 1024,
        "maximum bytes per session",
      ),
      maximumTotalBytes: positiveInteger(
        option(args, "--maximum-total-bytes"),
        64 * 1024 * 1024,
        "maximum total bytes",
      ),
      maximumScannedEntriesPerSession: positiveInteger(
        option(args, "--maximum-scanned-entries-per-session"),
        20_000,
        "maximum scanned entries per session",
      ),
      authorId: "memory-plugin:dream",
    });
  }
  if (command === "corpus") {
    if (!operand || operand.startsWith("--")) usage();
    const batch = await processHistoricalCorpus(operand, {
      maxFiles: positiveInteger(option(args, "--maximum-files"), 1_000, "maximum files"),
      maxDirectories: positiveInteger(option(args, "--maximum-directories"), 10_000, "maximum directories"),
      maxFileBytes: positiveInteger(option(args, "--maximum-file-bytes"), 1024 * 1024, "maximum file bytes"),
      maxTotalBytes: positiveInteger(option(args, "--maximum-total-bytes"), 64 * 1024 * 1024, "maximum total bytes"),
    });
    const records = [];
    if (args.includes("--apply")) {
      for (const candidate of batch.candidates) {
        records.push(await applyMemoryCandidate(state, candidate, { authorId: "memory-plugin:corpus" }));
      }
    }
    return { ...batch, records };
  }
  if (command === "migrate") {
    if (!operand || operand.startsWith("--")) usage();
    return migrateDreamV13Cursor(state, operand);
  }
  if (command === "restore") return restoreDreamV13CursorProjection(state);
  if (command === "status") return memoryPluginStatus(state);
  return usage();
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(await runMemoryCli(), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
