---
name: regression-triplet
description: "Add a focused three-case regression set after bug fixes. Use when fixing a bug, permission issue, data edge case, or integration failure and you need the smallest durable test coverage that proves the fix."
---

Use this skill after a bug fix to avoid shipping a one-case test that misses the real failure surface.

## The Triplet

1. **Primary path** — prove the intended success case now works.
2. **Edge input path** — cover the null, malformed, migrated, or provider-shaped input that made the bug realistic.
3. **Denied or failure path** — prove the system still rejects or fails correctly when access, validation, or upstream behavior is wrong.

## Workflow

1. **Identify the smallest stable boundary** for the tests. Prefer the narrowest unit or integration boundary that proves behavior without recreating the whole app.

2. **Draft all three cases before writing the first test.** Name them as success, edge-input, and denied-failure. If one does not apply, replace it with the next-most-likely regression mode and state why.

3. **Keep the fixture shape realistic.** Reuse the bug's real data pattern: null workspace, malformed provider field, duplicate retry event, inaccessible record.

4. **Stop when the regression surface is covered.** Do not turn the triplet into a giant matrix. Add more cases only when the bug truly has another independent failure mode.

## Typical Mappings

- **Permissions bug:** allowed path, null ownership path, forbidden path.
- **Integration bug:** valid payload, malformed or drifted payload, retry or upstream failure path.
- **State-flow bug:** correct transition, stale state, invalid transition.

## Guardrails

- Favor three sharp tests over one broad snapshot or many weak variants.
- Keep each case tied to a distinct failure mode.
- If the suite already covers one leg of the triplet, extend it instead of duplicating coverage.
