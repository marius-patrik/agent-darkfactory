Format: JSON

Emit exactly one JSON object and no prose. Required keys:

- `schemaVersion`: integer `1`.
- `status`: `resolved`, `needs-owner`, or `blocked`.
- `target`: object with `repository`, `workItem`, and `escalationEvidence`.
- `decision`: object with `question`, `answer`, `reasoningSummary`, and `evidence`.
- `authorizationPreserved`: boolean.
- `residualRisks`: array of strings.
- `continuation`: object with `action`, `scope`, and `preconditions`.
- `evidence` and `blockers`: arrays.

Unknown keys are forbidden. `resolved` never authorizes an action beyond the recorded owner escalation.
