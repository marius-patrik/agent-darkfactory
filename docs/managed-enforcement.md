# Managed Enforcement

This document records the live enforcement and compensating-control posture for
Andromeda issue [#203](https://github.com/marius-patrik/Andromeda/issues/203).
It describes repository policy and verification evidence; provider routing,
baton ownership, and work dispatch remain outside this scope.

## Protected Andromeda branches

Andromeda uses `dev` for feature integration and `main` for releases. Both
branches use strict branch protection:

- required App-bound status checks: `Validate` and `DarkFactory Autoreview`;
- force pushes: disabled;
- branch deletion: disabled;
- repository auto-merge: enabled, with protected merges waiting for both checks
  and an up-to-date branch;
- separate pull-request approval: not required; `DarkFactory Autoreview` is the
  automated review gate and requires a clean medium round plus an independent
  clean high-tier confirmation;
- administrator enforcement: disabled; automation does not use the
  administrator bypass.

Disposable evidence PRs [#204](https://github.com/marius-patrik/Andromeda/pull/204)
and [#205](https://github.com/marius-patrik/Andromeda/pull/205) proved that red
validation or automated-review changes are blocked on `dev` and `main`. Their
provider-specific historical check implementation has since been replaced by
the App-bound provider-agnostic gate above.

## Managed Validate baseline

The managed `Validate` workflow provisions Bun, Go, and uv before dependency
installation and validation. Python package operations use the `uv` CLI rather
than `python -m uv`.

The pre-convergence `go.work` exception is obsolete. The Go contract module is
now inside this repository at `packages/core/contracts-go/go.mod`; validation no
longer depends on a sibling contracts checkout, and the monorepo has no root
`go.work` file to conditionally discover.

## Base-trusted provider-agnostic Autoreview

`DarkFactory Autoreview` uses `pull_request_target` only as a thin trusted
dispatcher. It mints a bounded DarkFactory App token, checks out protected
`marius-patrik/DarkFactory@main`, records the exact control revision, and
verifies canonical Agent OS health before starting review. The target head is
treated as untrusted evidence and is never used to select a provider, model,
credential transport, or executable control path.

The protected control runtime binds every result to the exact base and head,
runs a complete medium review to clean, and then requires an independent clean
high-tier confirmation. Findings return through bounded review/fix rounds;
malformed output, stale state, unavailable routes, missing evidence, or an
exhausted budget fails closed. Provider routing and authentication remain owned
by Agent OS, so the repository carries no provider-specific review credentials,
container, schema, runner, fallback script, or routing policy.

## Andromeda-data protection posture

`marius-patrik/Andromeda-data` is a private repository. On 2026-07-13 the
branch-protection API returned HTTP 403 with GitHub's plan decision:
"Upgrade to GitHub Pro or make this repository public to enable this feature."
Native required checks therefore cannot protect its `main` branch under the
current plan.

The compensating control is admission enforcement in Andromeda, merged in
[#190](https://github.com/marius-patrik/Andromeda/pull/190), together with the
Andromeda-data contract merged in
[Andromeda-data #1](https://github.com/marius-patrik/Andromeda-data/pull/1):

- mutable Agent OS state may be backed up only as authenticated encrypted event
  bundles under `backups/events/<machine>/<payload-hash>.bundle.json`;
- tracked plaintext credentials, provider state, memory, sessions, runtime
  state, projections, synchronization material, and similar sensitive paths are
  rejected before status, backup, restore, or synchronization can proceed;
- every tracked bundle is inspected and its authenticated payload hash must
  match its content-addressed filename before import;
- static repository policy and documentation may remain tracked, but they are
  not mutable personal state.

No billing or visibility change was made for #203. Enabling native branch
protection requires Patrik to choose either a plan upgrade or public visibility;
that owner decision remains explicit rather than being inferred by automation.
