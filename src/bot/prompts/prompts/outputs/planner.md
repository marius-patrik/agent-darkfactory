Format: JSON

Emit exactly one JSON object and no prose. Required keys:

- `schemaVersion`: integer `1`.
- `status`: `planned`, `needs-owner`, or `blocked`.
- `target`: object with `repository`, `workItem`, and `observedVersion`.
- `steps`: ordered array of objects with stable `id`, `goal`, `dependencies`,
  `surfaces`, `deterministic`, `acceptanceChecks`, and `failureBehavior`.
- `ownerQuestions`: array of exact unresolved decisions.
- `evidence`: array of objects with `kind`, `ref`, and `summary`.
- `blockers`: array of concrete blockers; empty only when `status` is `planned`.

Unknown keys are forbidden. Preserve stable step identifiers across equivalent reruns.
