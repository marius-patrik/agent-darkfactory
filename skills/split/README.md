---
name: split
description: "Decide whether the current branch or a target PR should actually be split into smaller PRs."
argument-hint: "[pr-number | pr-url | branch | diff-target] [--: extra context] [--parallel:] [--suggest:] [--persist:]"
---

Additional arguments: $ARGUMENTS

Prompt suffix conventions:
- Parse and strip known suffix flags before choosing the split target.
- `--:` adds free-text context.
- `--parallel:`, `--suggest:`, and `--persist:` are metadata, not targets.
- Unknown `--flag:` tokens should be surfaced explicitly instead of being treated as branches, PRs, or diff targets.

Split target: the remaining non-flag target from `$ARGUMENTS`. If none, analyze the current branch PR.

## Analysis

Focus on:
- Whether the PR is one cohesive change or multiple independent concerns.
- Whether any cleanup, refactor, infra, schema, or generated-file churn should be split out.
- Whether the current commit or file boundaries already support a clean extraction.
- Whether proposed smaller PRs would still be reviewable and mergeable on their own.

Do not recommend a split just because the PR is large. Recommend a split only when the slices are meaningfully independent and can be described as clean mergeable PRs.

## Output Sections

Use these exact sections:

- **Split verdict** — yes or no
- **Why** — the specific reason(s) driving the recommendation
- **Proposed PRs** — concrete description of each proposed smaller PR (only if recommending a split)
- **Coupling and blockers** — what dependencies exist between the proposed slices
- **Recommended order** — merge sequence if splitting
- **Confidence** — how confident you are in this assessment
