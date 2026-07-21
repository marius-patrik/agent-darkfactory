import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CreditStore } from "../src/state";

const repoRoot = path.resolve(import.meta.dir, "..");
const cliPath = path.join(repoRoot, "src", "cli.ts");

function cleanEnv(): Record<string, string | undefined> {
  const copy = { ...process.env };
  for (const key of Object.keys(copy)) {
    if (key.startsWith("ANDROMEDA_")) delete copy[key];
  }
  return copy;
}

async function runAgents(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, cliPath, ...args], {
    cwd,
    env: { ...cleanEnv(), ANDROMEDA_HOME: path.join(cwd, ".agents"), ANDROMEDA_ROOT: cwd },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

async function readCredits(root: string): Promise<CreditStore> {
  return JSON.parse(await Bun.file(path.join(root, ".agents", "credits.json")).text()) as CreditStore;
}

describe("credits CLI", () => {
  test("records credit, debit, usage, and provider updates", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-credits-"));
    try {
      const provider = await runAgents(root, [
        "credits",
        "provider",
        "codex",
        "--balance",
        "100",
        "--soft-limit",
        "80",
        "--window-seconds",
        "3600",
      ]);
      expect(provider.code).toBe(0);

      const credit = await runAgents(root, ["credits", "credit", "codex", "stream-worker", "25", "--note", "seed"]);
      expect(credit.code).toBe(0);
      const debit = await runAgents(root, ["credits", "debit", "codex", "stream-worker", "5"]);
      expect(debit.code).toBe(0);
      const usage = await runAgents(root, [
        "credits",
        "usage",
        "codex",
        "stream-worker",
        "--amount",
        "2.5",
        "--tokens-in",
        "100",
        "--tokens-out",
        "40",
      ]);
      expect(usage.code).toBe(0);

      const store = await readCredits(root);
      expect(store.balances["stream-worker"]).toBe(17.5);
      expect(store.providers.codex.balance).toBe(77.5);
      expect(store.providers.codex.softLimit).toBe(80);
      expect(store.providers.codex.windowSeconds).toBe(3600);
      expect(store.providers.codex.requests).toBe(1);
      expect(store.providers.codex.tokensIn).toBe(100);
      expect(store.providers.codex.tokensOut).toBe(40);
      expect(store.ledger.map((entry) => entry.action)).toEqual(["credit", "debit", "usage"]);
      expect(store.ledger[0].note).toBe("seed");
      expect(Date.parse(store.updatedAt)).not.toBeNaN();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("prints mutated store as JSON", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-credits-json-"));
    try {
      const run = await runAgents(root, ["credits", "credit", "claude", "tester", "3", "--json"]);
      expect(run.code).toBe(0);
      const store = JSON.parse(run.stdout) as CreditStore;
      expect(store.balances.tester).toBe(3);
      expect(store.providers.claude.balance).toBe(-3);
      expect(store.ledger).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects unsafe ids and incomplete usage records", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-credits-invalid-"));
    try {
      const badId = await runAgents(root, ["credits", "credit", "../codex", "tester", "1"]);
      expect(badId.code).toBe(1);
      expect(badId.stderr).toContain("invalid provider");

      const missingUsage = await runAgents(root, ["credits", "usage", "codex", "tester"]);
      expect(missingUsage.code).toBe(1);
      expect(missingUsage.stderr).toContain("usage requires");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
