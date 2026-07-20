---
name: abstraction-pressure-test
description: "Pressure-test new helpers and abstractions before adding them. Use when considering a utility file, wrapper, helper function, shared mapper, extracted hook, service layer, or any refactor that adds indirection."
---

Use this skill before creating a new helper, wrapper, utility, or extracted layer.

## Workflow

1. **Ask the two hard questions.**
   - What concrete repetition exists today?
   - What invariant does this abstraction protect that inline code would not?

2. **Classify the candidate.**
   - Inline logic: one call site, obvious behavior, no protected invariant.
   - Shared invariant: centralizes a rule that must stay identical everywhere.
   - Shared plumbing: multiple real call sites already exist and the code is materially duplicated.

3. **Choose the smallest outcome.**
   - Inline logic stays inline.
   - Shared invariant may justify a narrowly named helper.
   - Shared plumbing may justify extraction only when it reduces real duplication now, not hypothetically later.

4. **Name it defensibly.**
   - File and function names must answer "what exactly does this do?" without generic words like `utils` or `helpers`.
   - If the best name is vague, the abstraction is probably vague too.

5. **Re-check after extraction.**
   - Ensure the new layer did not just move simple code away from the main flow.
   - Delete any wrapper that only forwards arguments or hides a single obvious call.

## Red Flags

- "We might reuse this later."
- The extracted code has one caller and no invariant.
- The helper name is broader than its actual job.
- The caller is now harder to read than before.
- The abstraction exists mainly to make the diff look cleaner.

## Keep / Delete Rule

- Keep when it centralizes a real invariant or removes present-tense duplication.
- Delete or inline when it only adds indirection.

## Guardrails

- Prefer duplication over the wrong abstraction when the code is still settling.
- Narrow domain helpers are acceptable; generic dumping grounds are not.
- If you cannot answer "why is this not inline?" in one sentence, inline it.
