# Project

- Name: DarkFactory
- Repository: `marius-patrik/DarkFactory`
- Product role: Independent GitHub-native autonomous engineering product
- Runtime: Node.js 22, TypeScript, ESM
- Package manager: npm
- Test runner: Node test runner with `tsx`

DarkFactory receives GitHub App events, synchronizes repository-local policy
from the `managed-repository` child of canonical Andromeda-data, and drives
deterministic planning, repository diagnosis, orchestration, enforcement, and
follow-through. Shared Agent OS state lives only under `$AGENTS_HOME`.
DarkFactory operational ledgers live separately in
`marius-patrik/darkfactory-data`. Managed sync enforces the exact canonical
repository and checkout root before reading the `managed-repository` child.
