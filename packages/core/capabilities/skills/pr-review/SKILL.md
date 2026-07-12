---
name: pr-review
description: "Review the current branch or a target PR for minimality, unnecessary code, structural issues, race conditions, and merge readiness."
---

Review the current branch or target PR with a code-review mindset. Prioritize bugs, behavioral regressions, race conditions, missing tests, unnecessary complexity, and merge blockers.

Return findings first, ordered by severity, with file and line references. If there are no findings, say that explicitly and call out residual testing risk.
