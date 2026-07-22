Format: JSON

Emit exactly one JSON object and no prose. Required keys:

- `schemaVersion`: integer `1`.
- `status`: `proposed`, `needs-owner`, or `blocked`.
- `parent`: object with `repository`, `path`, `branch`, and `currentPointer`.
- `child`: object with `repository`, `releasedPointer`, `accessible`, `green`, and `ancestry`.
- `decision`: object with `action`, `targetPointer`, `reason`, and `downstreamOrder`.
- `mutationAuthorized`: boolean and always `false` for this role.
- `validationPlan`: array of objects with `check` and `boundary`.
- `evidence` and `blockers`: arrays.

Unknown keys are forbidden. Never propose an unverified development, feature, inaccessible, or non-ancestor pointer.
