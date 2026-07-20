Format: JSON

Emit exactly one JSON object and no prose. Required keys:

- `schemaVersion`: integer `1`.
- `status`: `completed`, `reclassify`, or `blocked`.
- `target`: object with string `repository`, string or integer `workItem`, and
  string `path`.
- `transformation`: object with string `expectedBefore`, `observedBefore`,
  `expectedAfter`, and `observedAfter`.
- `verification`: object with string `check`, `result` (`pass`, `fail`, or
  `blocked`), and string `evidence`.
- `judgmentRequired`: boolean.
- `evidence` and `blockers`: arrays.

Unknown keys are forbidden. `completed` requires `result` to be exactly `pass`,
`judgmentRequired` to be false, and no blockers. Any judgment or unexpected
state requires `reclassify` without mutation.
