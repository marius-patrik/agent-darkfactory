Format: JSON

Emit exactly one JSON object and no prose. Required keys:

- `schemaVersion`: integer `1`.
- `verdict`: `verified`, `mismatch`, `unobservable`, or `blocked`.
- `target`: object with `repository`, `workItem`, `branch`, and `revision`.
- `claim`: object containing the normalized untrusted claim.
- `observations`: array of objects with `field`, `claimed`, `observed`, `result`, and `evidence`.
- `discrepancies`: array of objects with stable `id`, `field`, `summary`, and `evidence`.
- `laneAdvanceAllowed`: boolean.
- `evidence`: array of objects with `kind`, `ref`, and `summary`.
- `blockers`: array of concrete blockers.

Unknown keys are forbidden. Only `verified` may set `laneAdvanceAllowed` to `true`.
