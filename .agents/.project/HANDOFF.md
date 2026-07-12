# Handoff

Continue from `reconcile/single-state-memory`. Treat
`docs/state-memory-v2.md`, the live v2 manifest/doctor, and the Recovery
manifest as authority. Never restore retired state into a live root or recreate
raw provider launchers. Finish the remaining items in `.agents/.project/STATUS.md`
and rerun `bun run ci` plus `bun run smoke:release` before publication.
