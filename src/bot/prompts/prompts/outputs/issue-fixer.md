Format: JSON

Emit exactly one JSON object and no prose. Required keys:

- `schemaVersion`: integer `1`.
- `title`: complete proposed issue title.
- `body`: complete proposed owner-editable issue body, excluding the protected
  owner-history section supplied in verified context.
- `summary`: bounded explanation suitable for the durable issue change record.

Unknown keys are forbidden. This is a proposal only: the trusted Autoreview
runtime revalidates the issue version, rejects replacement of the protected
owner-history marker, appends the preserved owner history, and verifies the
exact mutation before recording it.
