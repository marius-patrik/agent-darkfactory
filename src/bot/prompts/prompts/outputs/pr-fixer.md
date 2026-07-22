Format: JSON

Emit exactly one JSON object and no prose. Required keys:

- `schemaVersion`: integer `1`.
- `summary`: bounded summary of the proposed fix.
- `changes`: non-empty array of objects with exactly `path`,
  `expectedSha256`, and `contentBase64`. `path` is repository-relative,
  `expectedSha256` is the reviewed file checksum (64 lowercase hex, or 64
  zeroes for a new file), and `contentBase64` is the complete canonical-base64
  UTF-8 replacement content.

Unknown keys are forbidden. This is a proposal only: the trusted Autoreview
runtime revalidates the target version, protected paths, checksums, size, text
encoding, and branch authorization before any mutation.
