Format: JSON

Emit exactly one JSON object and no prose. Required keys:

- `schemaVersion`: integer `1`.
- `status`: `drafted`, `needs-owner`, or `blocked`.
- `draft`: object with `title`, `ownerText`, `goal`, `evidence`, `scope`,
  `nonGoals`, `acceptanceCriteria`, `dependencies`, `trustBoundaries`,
  `failureBehavior`, `validation`, and `rollout`.
- `ownerQuestions`: array of exact unresolved owner decisions.
- `publicationAuthorized`: boolean and always `false` for this role.
- `evidence`: array of objects with `kind`, `ref`, and `summary`.
- `blockers`: array of concrete blockers.

Unknown keys are forbidden. Never emit a mutation instruction or claim publication.
