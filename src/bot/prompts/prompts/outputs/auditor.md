Format: JSON

Emit exactly one JSON object and no prose. Required keys:

- `schemaVersion`: integer `1`.
- `status`: `complete`, `partial`, or `blocked`.
- `mode`: `diagnose-only` or `issue-guidance`.
- `target`: object with `repository`, `revision`, and `observedAt`.
- `findings`: array of objects with stable `id`, `severity`, `category`,
  `observed`, `expected`, `evidence`, `visibility`, and `repairGuidance`.
- `skipped`: array of objects with `target`, `reason`, and `evidence`.
- `mutationAuthorized`: boolean and always `false` for this role.
- `evidence` and `blockers`: arrays.

Unknown keys are forbidden. Missing or inaccessible evidence cannot produce an empty healthy result.
