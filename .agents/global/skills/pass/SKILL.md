---
name: pass
description: "Discover and run the repository's authoritative verification gates for the changed surface."
---

Read `README.md` in this skill directory and follow it exactly.

Use when a change needs the standard local verification pass before it can be
trusted, reviewed, merged, or handed off. This skill is for repository work
where type checking, linting, and build behavior are part of the acceptance
surface, especially after touching shared code, workflows, release scripts,
deploy scripts, CLIs, or test infrastructure.

Workflow:

1. Identify the project root and read the local README, package metadata, or
   existing CI workflow to find the repository's own typecheck, lint, and build
   commands.
2. Prefer the exact commands used by CI or documented by the project. If a
   command is unavailable locally, record the missing tool and run the closest
   narrower verification that still exercises the changed surface.
3. Run type checking first, linting second, and build last unless the project
   explicitly documents a different order.
4. If one command fails, inspect the failure, fix the underlying issue when it
   is in scope, then rerun the failed command and any later commands that depend
   on it.
5. Finish by reporting the commands run, their pass/fail status, and any
   command that could not be run.

Do not replace this pass with a narrower unit test unless the repository has no
typecheck, lint, or build command for the touched surface. Keep the pass scoped
to the current project; avoid running unrelated heavyweight suites unless the
change affects shared behavior that makes the broader suite relevant.
