# Project

- Name: DarkFactory
- Repository: `marius-patrik/DarkFactory`
- Product role: Independent GitHub-native autonomous engineering product
- Runtime: Node.js 22, TypeScript, ESM
- Package manager: npm
- Test runner: Node test runner with `tsx`

DarkFactory receives GitHub App events, synchronizes repository-local policy
from the `managed-repository` child of the canonical `agent-os-data` checkout,
and drives deterministic planning,
orchestration, enforcement, and follow-through. Shared Agent OS state lives only
under `$AGENTS_HOME`. DarkFactory operational ledgers live separately in
`marius-patrik/darkfactory-data`.
