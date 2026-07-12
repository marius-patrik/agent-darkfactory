# Canonical capability floor

These files are the authored source for the shared Agent OS capability floor.
The installer validates every payload, writes an immutable object below
`AGENTS_HOME/store/sha256`, atomically materializes skills below
`AGENTS_HOME/skills`, activates the single Rommie identity, and records exact
hashes in canonical state.

Provider-owned system skills remain inside opaque provider homes. Agent OS does
not copy, link, or alias shared capabilities into provider directories. Managed
provider sessions receive the same generated identity, memory, and capability
startup projection.

The 2026-07-10 reconciliation classified 133 old capability candidates: 15
were retained unchanged, 9 were narrowly rewritten into this 18-capability
floor, and 109 were excluded. The exact audit and original payloads are
preserved in the external reconciliation recovery archive; excluded payloads
are not live loaders.
