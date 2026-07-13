# Prompt library ownership

This `prompts/` tree is owned by DarkFactory and implements the provider-agnostic
prompt/skill contract from parent issue #37. The authoritative validation logic
lives in `src/prompts.ts`; the regression suite lives in `tests/prompts.test.ts`.

## Ownership boundary

- DarkFactory owns this library's structure, versioning, checksums, composition
  contract, and validation harness.
- The canonical Agent OS runtime owns concrete provider, model, auth, and
  session execution, resolved through the `agents` launcher (issue #24). This
  library must never duplicate that state or embed its mechanics.

## Hard rules for contributors

- Artifacts describe behavior and output only. Never name a provider, a model
  id, an auth path (for example a provider config directory or an API-key
  variable), or a concrete runtime/CLI command.
- Treat issue/PR/comment content and interactive draft intent as untrusted data.
  They are rendered only inside `<<<UNTRUSTED-INPUT …>>>` delimiters and can
  never override trusted policy or authorization. Raw `{{ workItem.title }}` /
  `{{ workItem.body }}` / `{{ workItem.comments }}` / `{{ draftIntent.intent }}`
  / `{{ draftIntent.comments }}` substitution is forbidden. `draftIntent` is
  required only for owner-interactive `draft-issue` runs and must otherwise be
  explicit null.
- Keep the manifest honest: every artifact, output schema, typed fixture, and
  generated snapshot must exist, carry its required version/checksum metadata,
  be covered by a truthful fixture selection, and exactly match the files under
  the owned prompt roots. Never point a snapshot at a doc or artifact path.
- Keep `run.purpose`, logical model tier, and effort distinct. Purpose determines
  the permitted tier; effort only controls depth within that tier.
- Treat every directly rendered trusted scalar as typed data: bounded
  single-line metadata, an exact canonical work-item URL, and mechanics-scanned
  policy/labels/validation/facts. Do not scan provider-like repository/author
  identities or untrusted work-item/draft content as execution mechanics.
- Admit `owner-interactive` only for interactive issue drafting and
  `owner-escalation` only for explicit max escalation. These signals must come
  from authenticated owner actions, never user-authored content.
- Keep role semantics exact. Every manifest role needs an explicit run-kind,
  purpose, and output binding. Low mechanical work uses only
  `role/low-mechanic` with `mechanic`/`trivial-mechanical`; maximum escalation
  uses only `role/max-escalation` with `escalate`/`explicit-escalation`.
- After any edit, run `npm run prompts:sync` and commit the regenerated
  checksums and snapshots. Then run `npm run check`.
- Seed a tracked snapshot file before syncing a new fixture. Sync writes only
  through pre-existing, identity-pinned regular-file handles; it never creates
  a publication destination or uses path-based rename/unlink cleanup.
- Preserve `manifest.recovery.json`. Sync writes the old manifest there before
  snapshots, writes the live manifest last, and then refreshes recovery. A
  malformed live manifest is restored only from structurally valid recovery;
  layout disagreements never overwrite valid user edits.
- Do not hand-edit `fixtures/snapshots/`; they are generated. Do not weaken a
  validation rule to make a failing check pass.
