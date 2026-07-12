import assert from "node:assert/strict";
import test from "node:test";

import { parseCredential, parseReview, requestReview } from "./run-kimi-review.mjs";

const validReview = {
  approved: true,
  summary: "No blocking findings.",
  blocking_findings: [],
  non_blocking_notes: ["Keep the focused test."],
};

test("parses fenced review JSON into the canonical result shape", () => {
  const review = parseReview(`\`\`\`json\n${JSON.stringify(validReview)}\n\`\`\``);
  assert.equal(review.approved, true);
  assert.match(review.summary, /^Kimi quota-takeover review:/);
  assert.deepEqual(Object.keys(review), ["approved", "summary", "blocking_findings", "non_blocking_notes"]);
});

test("rejects malformed credential envelopes", () => {
  assert.throws(() => parseCredential('{"refresh_token":"secret"}'), /access_token/);
  assert.equal(parseCredential('{"kimi-code":{"access_token":"token"}}').access_token, "token");
});

test("uses the review API without placing credentials in model input", async () => {
  let request;
  const fetchImpl = async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(validReview) } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const review = await requestReview({
    prompt: "review this diff",
    credential: { access_token: "top-secret", expires_at: Math.floor(Date.now() / 1000) + 3600 },
    fetchImpl,
    env: {},
  });
  assert.equal(review.approved, true);
  assert.equal(request.init.headers.authorization, "Bearer top-secret");
  assert.doesNotMatch(request.init.body, /top-secret/);
  assert.match(request.init.body, /review this diff/);
  assert.equal(JSON.parse(request.init.body).temperature, 1);
});

test("refreshes an expired OAuth token before the review request", async () => {
  const calls = [];
  let rotated;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/api/oauth/token")) {
      return new Response(JSON.stringify({ access_token: "fresh", refresh_token: "next", expires_in: 3600 }), { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(validReview) } }] }), { status: 200 });
  };
  await requestReview({
    prompt: "review",
    credential: { access_token: "expired", refresh_token: "refresh", expires_at: 1 },
    fetchImpl,
    env: {},
    onCredentialRefresh: async (credential) => {
      rotated = credential;
    },
  });
  assert.equal(calls.length, 2);
  assert.match(String(calls[0].init.body), /grant_type=refresh_token/);
  assert.equal(calls[1].init.headers.authorization, "Bearer fresh");
  assert.equal(rotated.access_token, "fresh");
  assert.ok(rotated.expires_at > Math.floor(Date.now() / 1000));
});
