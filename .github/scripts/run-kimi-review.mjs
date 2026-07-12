#!/usr/bin/env node

import fs from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const DEFAULT_API_BASE = "https://api.kimi.com/coding/v1";
const DEFAULT_OAUTH_HOST = "https://auth.kimi.com";
const DEFAULT_REVIEW_TIMEOUT_MS = 600_000;
const KIMI_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function reviewTimeoutMs(value) {
  const timeout = Number(value ?? DEFAULT_REVIEW_TIMEOUT_MS);
  if (!Number.isSafeInteger(timeout) || timeout < 30_000 || timeout > 900_000) {
    throw new Error("KIMI_REVIEW_TIMEOUT_MS must be an integer between 30000 and 900000");
  }
  return timeout;
}

function reviewShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("review must be a JSON object");
  if (typeof value.approved !== "boolean") throw new Error("review.approved must be boolean");
  if (typeof value.summary !== "string") throw new Error("review.summary must be string");
  for (const key of ["blocking_findings", "non_blocking_notes"]) {
    if (!Array.isArray(value[key]) || value[key].some((item) => typeof item !== "string")) {
      throw new Error(`review.${key} must be a string array`);
    }
  }
  const blockingFindings = value.blocking_findings;
  return {
    approved: value.approved && blockingFindings.length === 0,
    summary: `Kimi quota-takeover review: ${value.summary}`,
    blocking_findings: blockingFindings,
    non_blocking_notes: value.non_blocking_notes,
  };
}

function balancedJsonObjects(text) {
  const objects = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (start < 0) {
      if (character === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        objects.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return objects;
}

export function parseReview(text) {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) candidates.push(fenced[1]);
  candidates.push(...balancedJsonObjects(trimmed));
  let shapeError = null;
  let validReview = null;
  for (const candidate of new Set(candidates)) {
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    try {
      validReview = reviewShape(parsed);
    } catch (error) {
      shapeError = error instanceof Error ? error : new Error(String(error));
    }
  }
  if (validReview) return validReview;
  throw new Error(`Kimi returned invalid review JSON: ${shapeError?.message ?? "response was not parseable JSON"}`);
}

export function parseCredential(raw) {
  const parsed = JSON.parse(raw);
  const candidates = [parsed, parsed?.token, parsed?.credential, parsed?.["kimi-code"]];
  const token = candidates.find((item) => item && typeof item === "object" && typeof item.access_token === "string");
  if (!token?.access_token) throw new Error("KIMI_AUTH_JSON does not contain an access_token");
  return token;
}

async function refreshCredential(credential, fetchImpl, env) {
  if (!credential.refresh_token) throw new Error("Kimi OAuth token expired without a refresh_token");
  const body = new URLSearchParams({
    client_id: KIMI_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: credential.refresh_token,
  });
  const response = await fetchImpl(`${env.KIMI_OAUTH_HOST || DEFAULT_OAUTH_HOST}/api/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Kimi OAuth refresh failed with HTTP ${response.status}`);
  const refreshed = await response.json();
  if (!refreshed?.access_token) throw new Error("Kimi OAuth refresh returned no access_token");
  const expiresIn = Number(refreshed.expires_in || 0);
  return {
    ...credential,
    ...refreshed,
    refresh_token: refreshed.refresh_token || credential.refresh_token,
    expires_at: expiresIn > 0 ? Math.floor(Date.now() / 1000) + expiresIn : 0,
  };
}

export function shouldTakeOver(exitCode) {
  return Number(exitCode) === 42;
}

export async function persistRefreshedCredential(credential, env = process.env, spawnImpl = spawn) {
  if (!env.GH_TOKEN) throw new Error("GH_TOKEN is required to persist rotated Kimi OAuth credentials");
  if (!env.GITHUB_REPOSITORY) throw new Error("GITHUB_REPOSITORY is required to persist rotated Kimi OAuth credentials");
  const child = spawnImpl("gh", ["secret", "set", "KIMI_AUTH_JSON", "--repo", env.GITHUB_REPOSITORY], {
    env,
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  const completed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`GitHub secret rotation failed${stderr.trim() ? `: ${stderr.trim()}` : ` with exit ${code}`}`));
    });
  });
  child.stdin.end(`${JSON.stringify(credential)}\n`);
  await completed;
}

export async function requestReview({
  prompt,
  credential,
  fetchImpl = fetch,
  env = process.env,
  onCredentialRefresh,
  waitImpl = delay,
}) {
  let active = credential;
  if (Number(active.expires_at || 0) <= Math.floor(Date.now() / 1000) + 60) {
    active = await refreshCredential(active, fetchImpl, env);
    await onCredentialRefresh?.(active);
  }
  const base = (env.KIMI_REVIEW_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, "");
  const requestBody = JSON.stringify({
      model: env.KIMI_REVIEW_MODEL || "kimi-for-coding",
      // Kimi Code's coding models currently accept temperature=1 only.
      temperature: 1,
      max_tokens: 8192,
      prompt_cache_key: createHash("sha256").update(prompt).digest("hex"),
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "Perform a read-only pull-request review from the supplied context.",
            "Do not request tools or external data.",
            "Return only one JSON object with exactly these fields:",
            '{"approved":boolean,"summary":string,"blocking_findings":string[],"non_blocking_notes":string[]}.',
            "Set approved to false whenever blocking_findings is non-empty.",
            "Keep summary under 150 words and return at most 10 concise items in each findings array.",
          ].join(" "),
        },
        { role: "user", content: prompt },
      ],
  });
  let response;
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      response = await fetchImpl(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${active.access_token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: requestBody,
        signal: AbortSignal.timeout(reviewTimeoutMs(env.KIMI_REVIEW_TIMEOUT_MS)),
      });
      if (response.ok || (response.status !== 429 && response.status < 500)) break;
      lastError = new Error(`Kimi review API failed with retryable HTTP ${response.status}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    if (attempt < 2) await waitImpl(1_000);
  }
  if (!response) throw lastError ?? new Error("Kimi review API request failed");
  if (!response.ok) throw new Error(`Kimi review API failed with HTTP ${response.status}`);
  const payload = await response.json();
  const choice = payload?.choices?.[0];
  if (choice?.finish_reason === "length") {
    throw new Error("Kimi review reached the completion-token limit before producing a complete verdict");
  }
  const content = choice?.message?.content;
  if (typeof content !== "string") throw new Error("Kimi review API returned no message content");
  try {
    return parseReview(content);
  } catch (error) {
    const finishReason = typeof choice?.finish_reason === "string" && /^[a-z_]+$/.test(choice.finish_reason)
      ? choice.finish_reason
      : "unknown";
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message} (finish_reason=${finishReason}, content_chars=${content.length})`);
  }
}

function blockedReview(error) {
  return {
    approved: false,
    summary: "Codex failed and the credential-isolated Kimi takeover could not produce a valid review.",
    blocking_findings: [`Review automation failed: ${error instanceof Error ? error.message : String(error)}`],
    non_blocking_notes: [],
  };
}

export async function main(env = process.env) {
  const output = env.KIMI_REVIEW_OUTPUT || "codex-review.json";
  try {
    const prompt = fs.readFileSync(env.KIMI_REVIEW_PROMPT, "utf8");
    const credential = parseCredential(env.KIMI_AUTH_JSON || "");
    const review = await requestReview({
      prompt,
      credential,
      env,
      onCredentialRefresh: (refreshed) => persistRefreshedCredential(refreshed, env),
    });
    fs.writeFileSync(output, `${JSON.stringify(review, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    fs.writeFileSync(output, `${JSON.stringify(blockedReview(error), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "--should-takeover") {
    process.exitCode = shouldTakeOver(process.argv[3]) ? 0 : 1;
  } else {
    await main();
  }
}
