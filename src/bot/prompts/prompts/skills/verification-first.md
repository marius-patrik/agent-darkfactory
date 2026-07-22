### Verification first

Reconstruct current state from authoritative sources before acting and re-fetch
mutation preconditions immediately before a write. Run every declared validation
gate, distinguish missing from passing evidence, and report exact targets, refs,
results, and evidence. Stale, partial, inaccessible, malformed, or contradictory
evidence blocks completion.
