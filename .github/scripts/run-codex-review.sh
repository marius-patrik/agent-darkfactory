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
PROMPT_EXPORT="${PROMPT_EXPORT:-}"

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

git config --global --add safe.directory /workspace
if ! git rev-parse --verify "${BASE_REF}^{commit}" >/dev/null 2>&1; then
  write_blocked_review \
    "Codex autoreview could not resolve the configured base ref." \
    "Ensure the PR checkout includes ${BASE_REF} before running the read-only review container."
  exit 1
fi

AGENTS_CONTEXT="${REVIEW_CONTEXT_DIR}/AGENTS.md"
ISSUE_CONTEXT="${REVIEW_CONTEXT_DIR}/linked-issues.md"
if [ ! -s "${AGENTS_CONTEXT}" ]; then
  write_blocked_review \
    "Codex autoreview could not run because repository rule context is missing." \
    "Prepare and mount ${AGENTS_CONTEXT} before running the Codex review container."
  exit 1
fi
if [ ! -s "${ISSUE_CONTEXT}" ]; then
  write_blocked_review \
    "Codex autoreview could not run because linked issue context is missing." \
    "Prepare and mount ${ISSUE_CONTEXT} before running the Codex review container."
  exit 1
fi

DIFF_FILE="$(mktemp)"
GENERATED_FILE="$(mktemp)"
PROMPT_FILE="$(mktemp)"
PR_BODY_FILE="$(mktemp)"
cleanup_review_temp() {
  rm -f "${DIFF_FILE}" "${GENERATED_FILE}" "${PROMPT_FILE}" "${PR_BODY_FILE}"
}
trap cleanup_review_temp EXIT
printf '%s\n' "${PR_BODY}" > "${PR_BODY_FILE}"
DIFF_EXCLUDES=(
  ':!dist/**'
  ':!build/**'
  ':!coverage/**'
  ':!node_modules/**'
  ':!packages/web/dist/**'
  ':!packages/core/contracts-go/gen/**'
  ':!packages/core/clients/shared-ts/src/gen/**'
  ':!packages/gateway/agent_os/**'
  ':!packages/inference/python-agent/agent/gen/**'
)
GENERATED_PATHS=(
  'packages/core/contracts-go/gen/**'
  'packages/core/clients/shared-ts/src/gen/**'
  'packages/gateway/agent_os/**'
  'packages/inference/python-agent/agent/gen/**'
)
git diff --stat "${BASE_REF}...HEAD" -- . "${DIFF_EXCLUDES[@]}" > "${DIFF_FILE}"
printf '\n--- FULL DIFF ---\n' >> "${DIFF_FILE}"
git diff --find-renames "${BASE_REF}...HEAD" -- . "${DIFF_EXCLUDES[@]}" >> "${DIFF_FILE}"
git diff --find-renames --name-status "${BASE_REF}...HEAD" -- "${GENERATED_PATHS[@]}" > "${GENERATED_FILE}"

{
cat <<EOF
You are reviewing a pull request for a DarkFactory-managed repository.

Review the PR against the linked issue/spec, the managed repository agent context, and the diff below.

The generated review diff intentionally excludes common generated output directories such as dist/**, build/**, coverage/**, node_modules/**, and packages/web/dist/**. Review source generators and validation logic for generated payloads instead; CI must validate generated payloads directly.

Return only JSON that matches the provided schema.

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

Generated payload file summary (bodies omitted; review generators and CI verification):
EOF

append_capped_file "${GENERATED_FILE}" "generated payload file summary" 40000

cat <<EOF

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

if [ -n "${PROMPT_EXPORT}" ]; then
  cp "${PROMPT_FILE}" "${PROMPT_EXPORT}"
  # The review container runs as root while the provider-isolated takeover runs
  # as the host runner. The prompt contains repository context, not credentials.
  chmod 0644 "${PROMPT_EXPORT}"
fi
PROMPT_DIGEST="$(sha256sum "${PROMPT_FILE}" | awk '{print $1}')"

if [ ! -s "${CODEX_HOME}/auth.json" ]; then
  write_blocked_review \
    "Codex autoreview could not run because CODEX_HOME/auth.json is missing." \
    "Configure CODEX_AUTH_JSON in GitHub repository secrets and mount it into the review container as CODEX_HOME/auth.json."
  exit 42
fi

CODEX_EXIT=0
codex exec \
  --cd /workspace \
  --sandbox read-only \
  --ephemeral \
  --output-schema "${SCHEMA_PATH}" \
  --output-last-message "${REVIEW_OUTPUT}" \
  - < "${PROMPT_FILE}" || CODEX_EXIT=$?

CURRENT_PROMPT_DIGEST="$(sha256sum "${PROMPT_FILE}" | awk '{print $1}')"
EXPORTED_PROMPT_DIGEST="${PROMPT_DIGEST}"
if [ -n "${PROMPT_EXPORT}" ]; then
  if [ -s "${PROMPT_EXPORT}" ]; then
    EXPORTED_PROMPT_DIGEST="$(sha256sum "${PROMPT_EXPORT}" | awk '{print $1}')"
  else
    EXPORTED_PROMPT_DIGEST="missing"
  fi
fi
if [ "${CURRENT_PROMPT_DIGEST}" != "${PROMPT_DIGEST}" ] || [ "${EXPORTED_PROMPT_DIGEST}" != "${PROMPT_DIGEST}" ]; then
  write_blocked_review \
    "The immutable review prompt changed during primary-provider execution." \
    "Rejecting provider takeover because the exported prompt no longer matches the trusted pre-execution digest."
  exit 1
fi

AUTOMATION_FAILED=0
if ! node -e "const r=JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8')); if(typeof r.approved!=='boolean'||typeof r.summary!=='string'||!Array.isArray(r.blocking_findings)||r.blocking_findings.some(x=>typeof x!=='string')||!Array.isArray(r.non_blocking_notes)||r.non_blocking_notes.some(x=>typeof x!=='string')) process.exit(1)" "${REVIEW_OUTPUT}"; then
  write_blocked_review \
    "Codex autoreview command exited ${CODEX_EXIT} without producing a valid review." \
    "Inspect the Codex Review workflow logs and fix the automation before allowing automerge."
  AUTOMATION_FAILED=1
fi

if [ "${AUTOMATION_FAILED}" -eq 1 ]; then
  exit 42
fi
