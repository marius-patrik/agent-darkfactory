---
name: ctx
description: "Read the active branch's PR, linked issues, and anything passed as a parameter for context."
argument-hint: "[pr-number | issue-number | url | text]... [--: extra context] [--parallel:] [--suggest:] [--persist:]"
---

Additional arguments: $ARGUMENTS

Prompt suffix conventions:
- Parse and strip known suffix flags before classifying `$ARGUMENTS`.
- `--:` adds free-text context.
- `--parallel:`, `--suggest:`, and `--persist:` are metadata, not PR or issue targets.
- Unknown `--flag:` tokens should be surfaced explicitly instead of shown under `Additional Context`.

## Steps

1. **Fetch the PR for the current branch** using `gh`:

   ```bash
   gh pr view --json number,title,url,body,state,isDraft,labels,reviewDecision,statusCheckRollup,closingIssuesReferences
   ```

   If no PR exists, note "No PR found for this branch" and skip PR steps.

2. **Fetch linked GitHub issues** from `closingIssuesReferences`. For each:

   ```bash
   gh issue view <number> --json number,title,body,labels,state
   ```

3. **Process the remaining non-flag arguments:**
   - PR number (`#NNN` or plain number) → `gh pr view <number> --json number,title,url,body,state,isDraft,labels,reviewDecision,statusCheckRollup,closingIssuesReferences`
   - GitHub PR URL → extract number, fetch same as above
   - GitHub issue URL → extract number, `gh issue view <number> --json number,title,body,labels,state`
   - Any other text or `--:` payload → display as-is under "Additional Context"

4. **Present a concise summary:**

   ```
   ## Context: <branch-name>

   ### PR: [#NNN Title](url) — <state> <isDraft? "(draft)" : "">
   <Review decision>

   **CI:** <pass/fail/pending summary>

   **Description:**
   <PR body, trimmed to first ~300 chars>

   ### Linked Issues
   - [#NNN Title](url) — <state>
     <issue body, trimmed to first ~200 chars>

   ### Additional Context
   <extra fetched PRs/issues or text>
   ```

   Only show sections that have content.
