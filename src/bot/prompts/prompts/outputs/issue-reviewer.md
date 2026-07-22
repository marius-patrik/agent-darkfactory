Format: JSON

Emit exactly one JSON object and no prose. Required keys:

- `schemaVersion`: integer `1`.
- `approved`: boolean; true exactly when there are no blocking findings.
- `summary`: bounded review summary.
- `findingsComplete`: literal `true`, confirming the response contains the
  complete current blocking finding set.
- `blockingFindings`: array of objects with exactly `title`, `details`, `path`,
  and `line`. Use null for an inapplicable path or line.
- `nonBlockingNotes`: array of bounded strings. Surface unresolved owner
  decisions here and keep `approved` false by emitting a blocking finding.

Unknown keys are forbidden. Do not invent finding identifiers; the trusted
Autoreview runtime derives stable identifiers from the complete finding data.
