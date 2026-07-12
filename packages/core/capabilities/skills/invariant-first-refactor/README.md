---
name: invariant-first-refactor
description: "Refactor multi-step flows by making invariants explicit before changing code. Use when editing orchestration functions, state transitions, routing decisions, workflow code, or any path where callers and persisted state can disagree."
---

Use this skill before refactoring a flow that crosses multiple functions, jobs, or persistence boundaries.

## Workflow

1. **Write the invariant first.**
   - State in one sentence what must always be true.
   - Examples: caller declares intent, DB is source of truth, only one active job may claim this record, evaluation searches never go through the sourcing path.

2. **Locate the enforcement boundary.**
   - Choose where the invariant belongs: function signature, DB constraint, transaction, routing switch, or validation step.
   - Prefer the narrowest boundary that all callers must pass through.

3. **Remove implicit duplication.**
   - Delete comments or duplicated checks that try to restate the same rule in multiple places.
   - If two layers can disagree, decide which one is authoritative and simplify the other.

4. **Refactor around the chosen source of truth.**
   - Make parameters, enum values, and return shapes reflect the invariant directly.
   - Replace boolean folklore and call-site conventions with explicit names and typed inputs.

5. **Verify disagreement cases.**
   - Test or inspect what happens when caller intent, persisted state, or prior assumptions diverge.
   - Prefer one clear failure path over silent fallback behavior.

## Decision Rules

- If the caller must declare intent, enforce it in the signature.
- If persisted state is authoritative, derive routing from state instead of re-supplying it at call sites.
- If both are needed, validate agreement explicitly and fail loudly on mismatch.

## Refactor Questions

- What is the single-sentence invariant for this flow?
- Which layer is authoritative?
- Can two call sites pass different assumptions into the same record?
- Is a comment carrying meaning that should live in code instead?
- What is the smallest place to enforce the rule once?

## Guardrails

- Do not start by extracting helpers.
- Do not keep both old and new sources of truth alive. Migrate to one authority and remove the retired path.
- Prefer deleting ambiguous parameters over keeping them "just in case."
