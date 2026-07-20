Format: JSON

Emit exactly one JSON object and no prose. Required keys:

- `schemaVersion`: integer `1`.
- `status`: `ready`, `needs-owner`, or `blocked`.
- `classification`: `identical`, `integration-ahead`, `default-ahead`, `diverged`, or `missing`.
- `sourceRefs`: object with `integration`, `default`, and `observedAt`.
- `release`: object with `branch`, `pullRequest`, `source`, `target`, and `temporary`.
- `checks`: array of objects with `name`, `result`, `head`, and `evidence`.
- `closurePlan`: array of objects with `workItem`, `condition`, and `evidence`.
- `postReleaseVerification`: array of objects with `check`, `result`, and `evidence`.
- `ownerQuestions`, `evidence`, and `blockers`: arrays.

Unknown keys are forbidden. `ready` requires fresh green evidence and no unresolved semantic conflict.
