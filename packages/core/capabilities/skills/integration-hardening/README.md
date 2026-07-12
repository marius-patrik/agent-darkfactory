---
name: integration-hardening
description: "Harden external integrations during development. Use when touching third-party APIs, SDK clients, webhook handlers, payload parsing, retry logic, provider-specific mappers, or any code that depends on remote contracts."
---

Use this skill when a change touches an external system and correctness depends on handling bad or drifting inputs, retry semantics, or partial failures.

## Workflow

1. **Identify the contract surface.**
   - Mark the exact boundaries where outside data enters the system: client methods, webhooks, queue consumers, parsers, or mappers.
   - Name the provider-owned fields separately from app-owned normalized fields.

2. **Pressure-test the contract.**
   - Check for field-name drift, optional fields, nulls, missing arrays, empty strings, bad enums, and fenced JSON or markdown wrappers in LLM output.
   - Prefer one normalization point near the boundary instead of defensive patches across the codebase.

3. **Audit failure behavior.**
   - Check which failures are retryable, which are permanent, and whether partial success can occur.
   - Do not infer retryability from error text if a typed signal already exists.
   - Ensure repeated calls are safe or explicitly guarded.

4. **Make the boundary explicit.**
   - Normalize remote data into a local shape with precise names.
   - Validate assumptions close to the boundary and fail with concrete errors.
   - Remove downstream code that still assumes raw provider formats.

5. **Verify the risky paths.**
   - Add or update tests for at least one malformed payload case and one retry or failure-path case.
   - If end-to-end testing is impractical, add the smallest boundary-level test that proves the normalization or retry rule.

## Review Questions

- What exact remote fields can be absent, renamed, or malformed?
- Where is retryability decided, and is it using the strongest signal available?
- Can the same event or response be processed twice without corruption?
- Is there one clear normalization point, or is provider-specific logic leaking everywhere?
- Does the test set cover a bad payload and a failure-mode path?

## Guardrails

- Prefer narrow hardening at the integration boundary over spreading checks throughout the app.
- Prefer typed normalization over stringly-typed downstream access.
- Delete fallback logic that exists only to compensate for avoidable boundary ambiguity.
