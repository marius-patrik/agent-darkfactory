#!/usr/bin/env node
import { env } from "node:process";

const token = env.GITHUB_TOKEN || env.GH_TOKEN;
if (!token) {
  if (env.CI) {
    console.error("GITHUB_TOKEN/GH_TOKEN is required for branch-protection audit in CI.");
    process.exit(1);
  }
  console.warn("No GITHUB_TOKEN/GH_TOKEN available; skipping branch-protection audit.");
  process.exit(0);
}

const owner = "marius-patrik";
const repos = {
  "darkfactory-templates": { checks: ["Validate"] },
  "template-bot": { checks: ["CI"] },
  "template-cli": { checks: ["CI", "Codex Review"] },
  "template-repo": { checks: ["CI"] },
  "template-web": { checks: ["CI", "Codex Review"] },
};

async function getJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${url} returned ${response.status}: ${body}`);
  }
  return response.json();
}

function collectContexts(statusChecks) {
  const contexts = new Set(statusChecks?.contexts ?? []);
  for (const check of statusChecks?.checks ?? []) {
    if (check.context) contexts.add(check.context);
  }
  return contexts;
}

let allOk = true;

for (const [repo, { checks }] of Object.entries(repos)) {
  const repoUrl = `https://api.github.com/repos/${owner}/${repo}`;
  const protectionUrl = `${repoUrl}/branches/main/protection`;

  try {
    const repoData = await getJson(repoUrl);
    const protection = await getJson(protectionUrl);

    const missing = [];

    if (repoData.allow_auto_merge !== true) missing.push("allow_auto_merge");
    if (repoData.delete_branch_on_merge !== true) missing.push("delete_branch_on_merge");

    const statusChecks = protection.required_status_checks;
    if (!statusChecks) {
      missing.push("required_status_checks");
    } else {
      if (statusChecks.strict !== true) missing.push("strict status check requirement");
      const contexts = collectContexts(statusChecks);
      for (const check of checks) {
        if (!contexts.has(check)) missing.push(`required check '${check}'`);
      }
    }

    const reviews = protection.required_pull_request_reviews;
    if (!reviews) {
      missing.push("required_pull_request_reviews");
    } else {
      if (reviews.require_conversation_resolution !== true) {
        missing.push("require_conversation_resolution");
      }
      if (typeof reviews.required_approving_review_count !== "number") {
        missing.push("required_approving_review_count");
      }
    }

    if (missing.length) {
      allOk = false;
      console.error(`\n${repo}:`);
      for (const item of missing) {
        console.error(`  missing: ${item}`);
      }
    } else {
      const contexts = Array.from(collectContexts(statusChecks)).join(", ");
      console.log(`\n${repo}: OK (checks: ${contexts})`);
    }
  } catch (error) {
    allOk = false;
    console.error(`\n${repo}: audit failed - ${error.message}`);
  }
}

if (!allOk) {
  console.error("\nBranch protection audit failed.");
  process.exit(1);
}

console.log("\nBranch protection audit passed.");
