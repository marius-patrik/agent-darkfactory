#!/usr/bin/env bash
set -euo pipefail

REVIEW_OUTPUT="${REVIEW_OUTPUT:-codex-review.json}"
BASE_REF="${BASE_REF:-origin/main}"
BASE_BRANCH="${BASE_BRANCH:-main}"
CODEX_HOME="${CODEX_HOME:-/tmp/codex-home}"
SCHEMA_PATH="${SCHEMA_PATH:-/opt/codex-review/schema.json}"
REVIEW_CONTEXT_DIR="${REVIEW_CONTEXT_DIR:-/review-context}"
PR_TITLE="${PR_TITLE:-}"
PR_BODY="${PR_BODY:-}"
MAX_PROMPT_BYTES="${MAX_PROMPT_BYTES:-700000}"

write_blocked_review() {
  local summary="$1"
  local finding="$2"
  REVIEW_SUMMARY="${summary}" REVIEW_FINDING="${finding}" REVIEW_OUTPUT="${REVIEW_OUTPUT}" node <<'NODE'
const fs = require("node:fs");
fs.writeFileSync(process.env.REVIEW_OUTPUT, `${JSON.stringify({
  approved: false,
  summary: process.env.REVIEW_SUMMARY,
  blocking_findings: [process.env.REVIEW_FINDING],
  non_blocking_notes: [],
}, null, 2)}\n`);
NODE
  chmod 600 "${REVIEW_OUTPUT}"
}

write_infra_review() {
  local summary="$1"
  local finding="$2"
  REVIEW_SUMMARY="${summary}" REVIEW_FINDING="${finding}" REVIEW_OUTPUT="${REVIEW_OUTPUT}" node <<'NODE'
const fs = require("node:fs");
fs.writeFileSync(process.env.REVIEW_OUTPUT, `${JSON.stringify({
  approved: false,
  _infra_failure: true,
  summary: process.env.REVIEW_SUMMARY,
  blocking_findings: [process.env.REVIEW_FINDING],
  non_blocking_notes: [],
}, null, 2)}\n`);
NODE
  chmod 600 "${REVIEW_OUTPUT}"
}

append_capped_file() {
  local file_path="$1"
  local label="$2"
  local max_bytes="$3"
  local byte_count
  byte_count="$(wc -c < "${file_path}" | tr -d '[:space:]')"
  if [ "${byte_count}" -gt "${max_bytes}" ]; then
    head -c "${max_bytes}" "${file_path}"
    printf '\n\n[%s truncated from %s to %s bytes for Codex review input limits]\n' "${label}" "${byte_count}" "${max_bytes}"
  else
    cat "${file_path}"
  fi
}

extract_review_json() {
  local input_path="$1"
  local output_path="$2"
  REVIEW_INPUT="${input_path}" REVIEW_OUTPUT="${output_path}" node <<'NODE'
const fs = require("node:fs");

const inputPath = process.env.REVIEW_INPUT;
const outputPath = process.env.REVIEW_OUTPUT;

function tryParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function extractJsonObject(value) {
  // Direct JSON parse.
  const direct = tryParse(value);
  if (direct !== undefined) return direct;

  // Look for a fenced JSON code block.
  const fenceMatch = value.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    const parsed = tryParse(fenceMatch[1]);
    if (parsed !== undefined) return parsed;
  }

  // Scan for the first balanced top-level JSON object.
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      if (start === -1) start = i;
      continue;
    }
    if (ch === "{") {
      if (start === -1) start = i;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (start !== -1 && depth === 0) {
        const parsed = tryParse(value.slice(start, i + 1));
        if (parsed !== undefined) return parsed;
        start = -1;
      }
    }
  }

  return undefined;
}

const content = fs.readFileSync(inputPath, "utf8");
const extracted = extractJsonObject(content);
if (extracted === undefined) {
  process.exit(1);
}
fs.writeFileSync(outputPath, `${JSON.stringify(extracted, null, 2)}\n`);
NODE
}

if [ ! -s "${CODEX_HOME}/auth.json" ]; then
  write_infra_review \
    "Codex autoreview could not run because CODEX_HOME/auth.json is missing." \
    "Configure CODEX_AUTH_JSON in GitHub repository secrets and mount it into the review container as CODEX_HOME/auth.json."
  exit 0
fi

git config --global --add safe.directory /workspace
git fetch origin "${BASE_BRANCH}"

AGENTS_CONTEXT="${REVIEW_CONTEXT_DIR}/AGENTS.md"
ISSUE_CONTEXT="${REVIEW_CONTEXT_DIR}/linked-issues.md"
if [ ! -s "${AGENTS_CONTEXT}" ]; then
  write_infra_review \
    "Codex autoreview could not run because repository rule context is missing." \
    "Prepare and mount ${AGENTS_CONTEXT} before running the Codex review container."
  exit 0
fi
if [ ! -s "${ISSUE_CONTEXT}" ]; then
  write_infra_review \
    "Codex autoreview could not run because linked issue context is missing." \
    "Prepare and mount ${ISSUE_CONTEXT} before running the Codex review container."
  exit 0
fi

DIFF_FILE="$(mktemp)"
PROMPT_FILE="$(mktemp)"
PR_BODY_FILE="$(mktemp)"
printf '%s\n' "${PR_BODY}" > "${PR_BODY_FILE}"
DIFF_EXCLUDES=(
  ':!dist/**'
  ':!build/**'
  ':!coverage/**'
  ':!node_modules/**'
  ':!packages/web/dist/**'
  ':!.codex-plugin/runtime/modules/**'
)
git diff --stat "${BASE_REF}...HEAD" -- . "${DIFF_EXCLUDES[@]}" > "${DIFF_FILE}"
printf '\n--- FULL DIFF ---\n' >> "${DIFF_FILE}"
git diff --find-renames "${BASE_REF}...HEAD" -- . "${DIFF_EXCLUDES[@]}" >> "${DIFF_FILE}"

{
cat <<EOF
You are reviewing a pull request for a DarkFactory-managed repository.

Review the PR against the linked issue/spec, the managed repository agent context, and the diff below.

The generated review diff intentionally excludes common generated output directories such as dist/**, build/**, coverage/**, node_modules/**, packages/web/dist/**, and .codex-plugin/runtime/modules/**. Review source generators and validation logic for generated payloads instead; CI must validate generated payloads directly.

You may use tools (read files, run read-only commands, etc.) as needed to understand the change. Your FINAL message must be ONLY a JSON object matching the provided schema. Do not wrap the JSON in markdown fences or add commentary outside the JSON object.

Set approved=true only when:
- the implementation satisfies the stated PR/issue spec,
- there are no blocking correctness, security, CI, secret-handling, or workflow-regression findings,
- the change preserves the repo rules.

Set approved=false if the PR exposes secrets to untrusted PR code, fails to meet the spec, has broken CI behavior, or needs implementation changes.

PR title:
${PR_TITLE}

PR body:
EOF

append_capped_file "${PR_BODY_FILE}" "PR body" 40000

cat <<EOF

Managed repository agent context:
EOF

append_capped_file "${AGENTS_CONTEXT}" "managed agent context" 120000

cat <<EOF

Linked issue/spec context:
EOF

append_capped_file "${ISSUE_CONTEXT}" "linked issue context" 220000

cat <<EOF

Schema:
EOF

cat "${SCHEMA_PATH}"

cat <<EOF

PR diff:
EOF

append_capped_file "${DIFF_FILE}" "PR diff" 520000
} > "${PROMPT_FILE}"

PROMPT_BYTES="$(wc -c < "${PROMPT_FILE}" | tr -d '[:space:]')"
if [ "${PROMPT_BYTES}" -gt "${MAX_PROMPT_BYTES}" ]; then
  TRUNCATED_PROMPT_FILE="$(mktemp)"
  TRUNCATION_MARKER="$(printf '\n\n[Codex review prompt truncated from %s to %s bytes for input limits]\n' "${PROMPT_BYTES}" "${MAX_PROMPT_BYTES}")"
  MARKER_BYTES="$(printf '%s' "${TRUNCATION_MARKER}" | wc -c | tr -d '[:space:]')"
  HEAD_BYTES="$((MAX_PROMPT_BYTES - MARKER_BYTES))"
  if [ "${HEAD_BYTES}" -lt 1 ]; then
    HEAD_BYTES=1
  fi
  head -c "${HEAD_BYTES}" "${PROMPT_FILE}" > "${TRUNCATED_PROMPT_FILE}"
  printf '%s' "${TRUNCATION_MARKER}" >> "${TRUNCATED_PROMPT_FILE}"
  mv "${TRUNCATED_PROMPT_FILE}" "${PROMPT_FILE}"
fi

CODEX_EXIT=0
# GitHub-hosted Docker blocks the unprivileged user namespaces required by
# Codex's default bubblewrap backend. The pinned CLI's legacy Landlock backend
# retains filesystem sandboxing without requiring extra container privileges.
codex --enable use_legacy_landlock exec \
  --cd /workspace \
  --sandbox read-only \
  --ephemeral \
  --output-last-message "${REVIEW_OUTPUT}" \
  - < "${PROMPT_FILE}" || CODEX_EXIT=$?

if [ "${CODEX_EXIT}" -ne 0 ] || [ ! -s "${REVIEW_OUTPUT}" ]; then
  write_infra_review \
    "Codex autoreview command failed before producing a valid review." \
    "Inspect the Codex Review workflow logs and retry if the failure is transient (quota, network, Codex CLI error, or schema/tool-use conflict)."
  exit 0
fi

EXTRACTED_REVIEW="$(mktemp)"
if ! extract_review_json "${REVIEW_OUTPUT}" "${EXTRACTED_REVIEW}"; then
  RAW_REVIEW="$(cat "${REVIEW_OUTPUT}" || true)"
  write_infra_review \
    "Codex autoreview produced non-JSON output." \
    "${RAW_REVIEW:-Codex review output was empty or invalid.}"
  rm -f "${EXTRACTED_REVIEW}"
  exit 0
fi

mv "${EXTRACTED_REVIEW}" "${REVIEW_OUTPUT}"
chmod 600 "${REVIEW_OUTPUT}"
