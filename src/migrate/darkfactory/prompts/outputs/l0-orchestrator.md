Format: JSON

Emit exactly one JSON object and no prose. Required keys:

- `schemaVersion`: integer `1`.
- `status`: `decided`, `needs-owner`, or `blocked`.
- `snapshot`: object with `id`, `observedAt`, and `evidence`.
- `decisions`: array of objects with stable `id`, `target`, `action`, `reason`,
  `dependencies`, `capacity`, `idempotencyKey`, and `evidence`.
- `ownerQuestions`: array of exact unresolved decisions.
- `deterministicActions`: empty array; mechanics remain outside this role.
- `evidence` and `blockers`: arrays.

Unknown keys are forbidden. Never report a transition not proven by the trusted snapshot.
