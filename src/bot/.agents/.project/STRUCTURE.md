# Structure

- `src/` — GitHub App, server, configuration, managed sync, setup checks, and status
- `.github/scripts/` — deterministic DarkFactory planning and orchestration logic
- `.github/workflows/` — CI, synchronization, orchestration, and
  provider-agnostic DarkFactory Autoreview jobs
- `.darkfactory/` — repository policy, managed-repository registry, and scheduler
  configuration
- `templates/` — repository templates that carry only project-local agent context
- `prompts/` — versioned, provider-agnostic prompt/skill library (roles, skills,
  tiers, overlays, output schemas, fixtures) with a typed composition contract and
  checksum/snapshot validation (`src/prompts.ts`, `tests/prompts.test.ts`)
- `tests/` — TypeScript and workflow-policy regression suite
- `.agents/.project/` — DarkFactory-specific context only

Shared Agent OS state and capabilities are installed once under `$AGENTS_HOME`.
