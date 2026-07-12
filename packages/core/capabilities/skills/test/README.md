---
name: test
description: "Discover a branch or PR's behavior and execute the strongest safe verification available."
argument-hint: "[pr-number | base-branch] [--: extra context] [--parallel:] [--suggest:] [--persist:]"
---

Additional arguments: $ARGUMENTS

Prompt suffix conventions:
- Parse and strip known suffix flags before using `$ARGUMENTS`.
- `--:` adds free-text context.
- `--parallel:`, `--suggest:`, and `--persist:` are metadata, not PR numbers or base branches.
- Unknown `--flag:` tokens should be surfaced explicitly instead of being treated as branch names or review targets.

## Phase 1: PR Discovery

1. **Fetch the PR** for this branch, or use a PR number from the remaining non-flag arguments:

   ```bash
   gh pr view --json number,title,url,body,state,isDraft,labels,closingIssuesReferences,baseRefName
   ```

   If no PR exists, note "No PR found" and derive the base from branch tracking,
   the remote default, or repository instructions. Common bases include `dev`,
   `develop`, and `main`; do not guess when Git can answer.

2. **Fetch linked issues** from `closingIssuesReferences`:

   ```bash
   gh issue view <number> --json number,title,body,labels
   ```

3. **Analyze changed files** against the base branch:

   ```bash
   git diff --name-only <base-branch>...HEAD
   git log --oneline <base-branch>...HEAD
   ```

4. **Read the key changed files** — identify:
   - Feature type: new feature / bug fix / refactor / integration / schema change
   - Affected layers: frontend / backend / database / external API / auth
   - Entry points: pages, API routes, procedures, components
   - Data flows: what goes in, what comes out, what gets stored

## Phase 2: System Mapping

Based on file changes, explore relevant areas:

- **New pages/routes** → read the component and its data dependencies
- **New procedures** → read the router, understand inputs/outputs/auth guards
- **Schema changes** → read the migration and affected models
- **New server files** → read the service/integration logic
- **New UI components** → understand what they render and what interactions they expose

Map the complete user journey: trigger → UI → API → data → response.

## Phase 3: Test Plan Output

```
## PR Testing Guide: <PR title>

### What This PR Does
<2-3 sentence summary>

### Affected Systems
- Frontend: <pages/components changed>
- Backend: <procedures/services changed>
- Database: <schema/data changes>
- Integrations: <external APIs/services>

### Prerequisites
<env vars, feature flags, test accounts, seed data>

### Test Scenarios

#### Happy Path
1. <step>
Expected: <result>

#### Edge Cases
- <scenario>: <how to test> → Expected: <result>

#### Error Cases
- <scenario>: <how to trigger> → Expected: <error message or behavior>

#### Regression Checks
- <thing that must still work> → <how to verify>

### Verification Checklist
- [ ] <specific thing to confirm works>
- [ ] <data integrity check>
- [ ] <UI state check>
- [ ] <API response check>

### Known Gotchas
<anything tricky, env-specific, or non-obvious from the code>
```

Be concrete. Reference actual URLs, procedure names, field names, and expected values from the code.

## Testing Mode: Autonomous by Default

Execute every safe, in-scope test that the available tools can perform. This
includes browser interaction in disposable or explicitly in-scope test
environments. Ask the user only for a genuinely physical, credential, consent,
financial, production, or otherwise irreversible gate that cannot be crossed
safely under the task's authority.

Record actual observations and artifacts. Do not turn an automatable test into
a checklist for the user, and do not claim a manual-only boundary was proven.
