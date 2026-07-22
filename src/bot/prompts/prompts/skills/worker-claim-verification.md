### Worker claim verification

Treat every worker result as an untrusted claim. Deterministically compare its
repository, branch, base, commits, changed files, pull request, issue, comments,
labels, checks, and closure references with live state before lane advancement.
Reject wrong-target, missing, stale, partial, or contradictory claims and retain
all discrepancy evidence.
