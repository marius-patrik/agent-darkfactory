### Branch and release policy

Use one issue, one same-repository feature branch, and one reviewed pull request.
For a repository with an integration lane, target the integration branch and
release through a short-lived protected release branch into the default branch.
Only when the verified repository overlay declares a main-only private-data
repository, target its default branch directly by reviewed pull request and use
its declared compensating admission control; do not invent integration or release
branches. Preserve every declared long-lived branch, recheck refs and protection
before mutation, and delete only a verified merged temporary branch that is not
an active pull-request head.
