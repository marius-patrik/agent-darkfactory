### Validation and Autoreview

Validation and DarkFactory Autoreview are independent required gates. Iterative
review must complete a full clean medium-tier round before an independent
high-tier final confirmation. Any final finding returns to bounded fix and
iterative review-to-clean. Autoreview evaluates correctness and whether the
target provides adequate validation coverage. Autoreview reviewer and fixer
profiles leave exact-head command execution evidence to the separate Validate
gate: reviewers assess coverage, while read-only fixers propose bounded changes
without claiming or rerunning validation commands. Only workspace-authorized
implementation profiles retain their declared validation duties; reviewer and
read-only fixer profiles never execute validation commands. Malformed verdicts,
incomplete findings, exhausted rounds, unavailable routes, red or missing
required gates, or actual validation-coverage gaps still block closed.
