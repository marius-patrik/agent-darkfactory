# Decisions

## 2026-07-02

### Bun TypeScript Baseline

- Decision: Use Bun 1.3.14 and strict TypeScript for the template baseline.
- Rationale: Matches the requested Bun project setup and sibling template direction.
- Status: Accepted.

### Reusable Agent Split

- Decision: Separate agent files into `.agents/.global/` and `.agents/.project/`.
- Rationale: The same agent operating content should be reusable across repositories, while project facts remain easy to replace.
- Status: Accepted.

### Runtime Agent Metadata Excluded

- Decision: Do not commit `.agents/env`, `.agents/credits.json`, or `.agents/installs.json`.
- Rationale: Existing repositories show these as runtime or local agent metadata, not portable project instructions.
- Status: Accepted.
