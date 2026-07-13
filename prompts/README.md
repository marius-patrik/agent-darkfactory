# DarkFactory prompt/skill library

This directory is the versioned, provider-agnostic prompt/skill library defined
by parent issue #37 (epic #35) and scaffolded by issue #49. It owns **what** a
role should do and **what** it should emit — never **how** to run a model.
Concrete provider, model, auth, and session execution is resolved exclusively by
the canonical Agent OS runtime through the `agents` launcher (issue #24).

## Layout

- `manifest.json` — the versioned, checksummed index of every artifact,
  typed fixture, and generated snapshot.
- `manifest.recovery.json` — the durable, structurally validated recovery copy
  for an interrupted write that leaves `manifest.json` malformed.
- `roles/` — role prompts (planner, implementer, issue drafter/reviewer, PR
  reviewer/fixer, releaser, verifier, auditor, L0 orchestrator, low mechanic,
  and explicit max escalation).
- `skills/` — reusable capability snippets composed into a role.
- `tiers/` — logical model tiers (`low`, `medium`, `high`, `max`) describing
  behavior and output only; tier selection remains independent from effort.
- `overlays/` — cross-cutting context (GitHub control plane, Agent OS boundary,
  token economy).
- `outputs/` — versioned output-schema artifacts selected by typed ID.
- `fixtures/compose/` — typed composition inputs, one per composable role.
- `fixtures/snapshots/` — deterministic composed output for each fixture.
- `schema/manifest.schema.json` — the manifest contract.

## Composition contract

A prompt is composed deterministically (no model in the loop) from typed inputs:

1. role and non-goals;
2. immutable policy skills and the trusted policy snapshot;
3. logical `modelTier` plus independent effort and run context;
4. issue/PR/comment content or interactive draft intent as delimited untrusted
   data;
5. selected overlays, repository context, and validation commands;
6. minimal verified live state; and
7. the selected versioned output-schema artifact.

Typed inputs are `run` (including a typed kind and purpose), `repository`,
`workItem` (issue/PR or explicit null), `draftIntent` (required only for an
interactive `draft-issue` run and otherwise explicit null), `policy`
(immutable), `validation`, `effort` (independent effort), `selection` (role +
skills + `modelTier` + overlays), `verified` (verified state), and `output.id`
(a manifest-owned output schema). The logical model tier and effort describe
behavior only.

Purpose is fail-closed: low is reserved for trivial mechanical work, medium for
implementation/iterative review/fixes/verification, high for planning,
orchestration, interactive issue drafting, final review, release, and audit,
and max for explicit escalation. Effort remains an independent low/medium/high
budget and never changes that tier policy.

Interactive drafting requires the reserved `owner-interactive` trigger and max
escalation requires `owner-escalation`; neither signal is admitted in any other
lane. Callers must derive those signals from authenticated owner actions, never
from issue, PR, comment, or draft-intent text.

Issue, pull request, comment, and interactive draft-intent content are
**untrusted data**. Work-item `title`/`body`/`comments` and draft-intent
`intent`/`comments` are rendered only inside `<<<UNTRUSTED-INPUT …>>>`
delimiters and can never override the trusted policy, the instructions, or any
authorization. Untrusted content that contains a reserved delimiter is
rejected outright.

Trusted rendered scalars are admitted separately: run/repository/work-item
metadata must match bounded single-line grammars, and `workItem.url` must be the
exact GitHub URL implied by repository, kind, and number. Free-form trusted
policy labels/text, validation commands, and verified facts are single-line,
deduplicated where applicable, and scanned for provider/model/auth/runtime
mechanics. Provider-like repository or author names remain valid inert
identities and are not mechanics-scanned.

Role admission is exact and fail-closed. Every manifest role must have a
declared role-to-run-kind, permitted-purpose, and output binding in the runtime
contract. The dedicated low-mechanic role is admitted only for
`mechanic`/`trivial-mechanical`; the dedicated max-escalation role is admitted
only for `escalate`/`explicit-escalation`. An unknown or newly added role cannot
compose until its semantics are bound explicitly.

## Schema, versioning, and checksums

- Every artifact declares a semver `version` and a `sha256:` `checksum` of its
  normalized content in `manifest.json`.
- Every typed fixture declares a semver version plus checksums for both its JSON
  input and generated snapshot. Output schemas are normal manifest artifacts,
  so they carry the same version/checksum/coverage guarantees as roles.
- Every manifest reference must exist on disk and hash to its declared checksum.
- The manifest is the exact case-insensitive inventory of `roles/`, `skills/`,
  `tiers/`, `overlays/`, `outputs/`, `fixtures/compose/`, and
  `fixtures/snapshots/`; unlisted files, path aliases, links, and wrong-root
  destinations fail validation.
- Every artifact declares the `variables` it uses (a subset of the trusted
  template variables) and the `requiredVariables` that must be present to
  compose it, plus fixture coverage in `fixtures[].covers`.

## Editing rules

- Edit an artifact or fixture, then run `npm run prompts:sync` to build and
  verify an isolated copy, pin every pre-existing live snapshot and manifest
  destination, write snapshots through retained file handles, and write the
  manifest handle last. Parent-path swaps cannot redirect those writes. A
  synchronous failure or process interruption may leave a partial destination;
  checksum validation fails that state closed until sync is rerun.
- Sync exclusion is held by one machine-wide OS-owned local endpoint. The
  conservative global scope serializes direct, UNC, mapped-drive, symlink, and
  replacement-path access without relying on path spelling; the admitted root
  filesystem identity is rechecked at every live publication boundary. Process
  exit releases the endpoint without filesystem lock cleanup.
  Before publication, the current manifest is written and verified through a
  pinned recovery handle. If an interrupted manifest write leaves malformed
  JSON, the next sync restores that structurally valid recovery copy first. If
  both copies are invalid, restore `manifest.json` from VCS or backup.
- When adding a brand-new fixture, seed its tracked snapshot path before sync
  (an empty regular file is sufficient). Publication intentionally refuses to
  create a missing destination because creation cannot be bound safely to an
  already admitted file handle.
- `npm run check` (via `tests/prompts.test.ts`) fails on: a missing reference, a
  checksum/version mismatch, an unknown or raw untrusted variable, a missing
  required input, an untrusted-data delimiter escape, missing fixture coverage,
  or any provider CLI mechanic, auth path, or concrete runtime command.
- Prompt content is filled in by follow-up issue #50; this scaffold provides the
  structure, contract, and validation harness.
