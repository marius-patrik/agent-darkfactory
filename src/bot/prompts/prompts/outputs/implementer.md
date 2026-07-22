Format: JSON

Emit exactly one JSON object and no prose. Required keys:

- `schemaVersion`: integer `1`.
- `status`: `completed` or `blocked`.
- `target`: object with string `repository`, string or integer `workItem`, and
  string `base` and `head`.
- `acceptance`: non-empty array of objects with stable string `criterionId`,
  `result` (`pass`, `fail`, or `blocked`), and string `evidence`.
- `filesChanged`: sorted array of repository-relative paths.
- `validation`: non-empty array of objects with string `command`, `result`
  (`pass`, `fail`, or `blocked`), non-negative integer `exitCode`, and string
  `evidence`.
- `residualRisks`: array of strings.
- `blockers`: array of concrete blockers.
- `evidence`: array of objects with `kind`, `ref`, and `summary`.

Unknown keys are forbidden. `completed` requires every acceptance and
validation result to be exactly `pass`, every exit code to be zero, and no
blockers.
