---
name: pass
description: "Discover and run the repository's authoritative verification gates for the changed surface."
---

Discover the repository's own verification contract before running commands.
Read its contributor instructions, package metadata, build files, and CI
workflow. Select every gate that covers the changed surface, including tests,
type checking, linting, formatting, builds, generated-file checks, installer
smokes, or platform-specific probes when those gates actually exist.

Run independent checks in parallel when that preserves useful diagnostics.
Run dependent checks in the order required by the project. A failed check is a
diagnostic to investigate and fix when the cause is in scope; it is not a
reason to skip the remaining independent evidence.

Finish with the exact commands and outcomes. Do not report a green pass when a
required gate was skipped, unavailable, narrowed, or run against the wrong
artifact. State any unproven boundary explicitly.
