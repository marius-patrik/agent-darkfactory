import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  publishReviewedIssueDraft,
  readIssueDraftState,
  resumeExpiredIssueDraft,
  writeIssueDraftState,
  type IssueDraftState
} from "../src/issue-development.js";
import { issueContentDigest, issueVersion } from "../src/issue-spec.js";

// @ts-ignore Native ESM trusted-main hygiene controller is exercised directly.
const hygiene: any = await import("../.github/scripts/df-issue-draft-hygiene.mjs?unit=issue-draft-hygiene-test");
const controlRoot = path.resolve(import.meta.dirname, "..");
const NOW = new Date("2026-07-16T12:00:00.000Z");

function reviewedState(draftId: string, reviewedAt: string): IssueDraftState {
  const title = "Owner-reviewed local issue";
  const body = `<!-- darkfactory:local-issue-draft id=${draftId} -->\n# Goal\n\nPreserve this private owner content.`;
  const document = { title, body, digest: issueContentDigest(title, body) };
  const request = (modelTier: "medium" | "high") => ({ schemaVersion: 1 as const, modelTier, effort: "high" as const, purpose: modelTier === "high" ? "finalReview" as const : "iterativeReview" as const });
  const receipt = (modelTier: "medium" | "high") => ({
    schemaVersion: 2,
    requested: { modelTier, effort: "high" },
    routing: {
      policyVersion: "fixture-route-policy-v1",
      primary: { provider: "fixture-primary", model: "fixture/primary-model", agentPreset: "Fixture-Primary", providerVersion: "1.0.0" },
      skipped: []
    },
    resolved: { provider: `fixture-${modelTier}`, model: `fixture/${modelTier}`, agentPreset: `Fixture-${modelTier}`, providerVersion: "1.0.0" },
    attempts: [{ number: 1, outcome: "success", reason: null }],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    outcome: "success",
    blockReason: null
  });
  const prompt = (modelTier: "medium" | "high") => ({ selection: { modelTier, effort: "high" } });
  return {
    schemaVersion: 2,
    draftId,
    repository: "marius-patrik/DarkFactory",
    createdAt: "2026-07-01T12:00:00.000Z",
    updatedAt: reviewedAt,
    status: "reviewed",
    initial: document,
    current: document,
    ownerQuestions: [],
    blockers: [],
    draftTurns: [{ sequence: 1, kind: "initial", inputVersion: null, beforeDigest: null, afterDigest: document.digest, ownerAnswers: [], request: request("high"), prompt: prompt("high") as never, receipt: receipt("high") }],
    review: {
      targetVersion: issueVersion({ title, body, state: "open" }),
      ok: true,
      code: null,
      rounds: [
        { phase: "medium_review", outcome: "reviewed", request: request("medium"), receipt: receipt("medium"), prompt: prompt("medium"), verdict: { approved: true, blockingFindings: [] } },
        { phase: "high_review", outcome: "reviewed", request: request("high"), receipt: receipt("high"), prompt: prompt("high"), verdict: { approved: true, blockingFindings: [] } }
      ]
    },
    publication: null
  };
}

async function draftRoot(prefix: string): Promise<{ root: string; drafts: string }> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const drafts = path.join(root, "runtime", "darkfactory", "drafts");
  await mkdir(drafts, { recursive: true });
  return { root, drafts };
}

test("trusted local hygiene records deterministic reminder/expiry receipts without exposing content or paths", async () => {
  const local = await draftRoot("df-draft-hygiene-");
  try {
    await writeIssueDraftState(path.join(local.drafts, "reminder.json"), reviewedState("1".repeat(32), "2026-07-12T12:00:00.000Z"));
    await writeIssueDraftState(path.join(local.drafts, "expired.json"), reviewedState("2".repeat(32), "2026-07-08T12:00:00.000Z"));

    const first = await hygiene.maintainIssueDraftInventory({ agentsHome: local.root, controlRoot, now: NOW });
    assert.deepEqual({ reminders: first.reminders, expired: first.expired, newReceipts: first.newReceipts, modelTokens: first.modelTokens }, { reminders: 1, expired: 1, newReceipts: 3, modelTokens: 0 });
    assert.deepEqual(first.drafts.map((draft: any) => [draft.draftId, draft.action]), [
      ["1".repeat(32), "owner-reminder"],
      ["2".repeat(32), "owner-resume-required"]
    ]);
    const serialized = JSON.stringify(first);
    assert.doesNotMatch(serialized, new RegExp(local.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(serialized, /Preserve this private owner content/);
    assert.equal(first.sanitized, true);

    const second = await hygiene.maintainIssueDraftInventory({ agentsHome: local.root, controlRoot, now: NOW });
    assert.equal(second.newReceipts, 0);
    const receiptRoot = path.join(local.root, "runtime", "darkfactory", "draft-hygiene", "receipts");
    const receiptFiles = (await Promise.all((await readdir(receiptRoot)).map(async (draftId) => (await readdir(path.join(receiptRoot, draftId))).map((name) => `${draftId}/${name}`)))).flat().sort();
    assert.equal(receiptFiles.length, 3);
  } finally {
    await rm(local.root, { recursive: true, force: true });
  }
});

test("draft inventory fails closed before receipts on duplicate, malformed, or ambiguous local state", async () => {
  const local = await draftRoot("df-draft-hygiene-denied-");
  try {
    const duplicate = reviewedState("3".repeat(32), "2026-07-12T12:00:00.000Z");
    await writeIssueDraftState(path.join(local.drafts, "one.json"), duplicate);
    await writeIssueDraftState(path.join(local.drafts, "two.json"), duplicate);
    await assert.rejects(() => hygiene.maintainIssueDraftInventory({ agentsHome: local.root, controlRoot, now: NOW }), /duplicate identity/);
    assert.equal(existsSync(path.join(local.root, "runtime", "darkfactory", "draft-hygiene")), false);

    await rm(path.join(local.drafts, "two.json"));
    await writeFile(path.join(local.drafts, "partial.tmp"), "secret", "utf8");
    await assert.rejects(() => hygiene.maintainIssueDraftInventory({ agentsHome: local.root, controlRoot, now: NOW }), /ambiguous entry/);
    await rm(path.join(local.drafts, "partial.tmp"));

    const malformed = JSON.parse(await readFile(path.join(local.drafts, "one.json"), "utf8"));
    malformed.updatedAt = "2026-07-17T12:00:00.000Z";
    await writeFile(path.join(local.drafts, "one.json"), `${JSON.stringify(malformed)}\n`, "utf8");
    await assert.rejects(() => hygiene.maintainIssueDraftInventory({ agentsHome: local.root, controlRoot, now: NOW }), /chronology/);
  } finally {
    await rm(local.root, { recursive: true, force: true });
  }
});

test("expired reviewed drafts cannot publish until explicit owner resume clears stale review evidence", async () => {
  const local = await draftRoot("df-draft-expiry-");
  try {
    const draftPath = path.join(local.drafts, "expired.json");
    const expired = reviewedState("4".repeat(32), "2026-07-08T12:00:00.000Z");
    await writeIssueDraftState(draftPath, expired);
    let githubWrites = 0;
    const ledgers: Array<{ kind: string; payload: unknown }> = [];
    const runtime = {
      agentsHome: local.root,
      controlRevision: "0".repeat(40),
      now: () => NOW,
      ledger: async (kind: string, _repository: string, payload: unknown) => { ledgers.push({ kind, payload }); },
      github: {
        async request(method: string, requestPath: string) {
          if (method === "GET" && requestPath.includes("issues?state=all")) return [];
          githubWrites += 1;
          return {};
        }
      }
    };

    await assert.rejects(() => publishReviewedIssueDraft(draftPath, expired.current.digest, runtime), /review expired.*explicit owner resume/i);
    assert.equal(githubWrites, 0);

    const resumed = await resumeExpiredIssueDraft(draftPath, runtime);
    assert.equal(resumed.status, "drafted");
    assert.equal(resumed.review, null);
    assert.equal(resumed.current.title, expired.current.title);
    assert.equal(resumed.current.body, expired.current.body);
    assert.equal(resumed.current.digest, expired.current.digest);
    assert.deepEqual(ledgers.map((entry) => entry.kind), ["issue-draft-owner-resume"]);
    await assert.rejects(() => publishReviewedIssueDraft(draftPath, expired.current.digest, runtime), /clean high Autoreview confirmation/);
    assert.equal((await readIssueDraftState(draftPath)).status, "drafted");
  } finally {
    await rm(local.root, { recursive: true, force: true });
  }
});
