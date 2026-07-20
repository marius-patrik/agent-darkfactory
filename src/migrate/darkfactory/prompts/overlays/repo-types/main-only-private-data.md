### Main-only private data overlay

- This repository intentionally has one default branch and no integration or
  release branch lane.
- Preserve private visibility and never publish or decrypt protected data in a
  product repository, prompt, issue, comment, log, or evidence record.
- When branch protection is unavailable under the current plan, require the
  versioned encrypted-bundle admission control as the compensating gate.
- A visibility or plan upgrade is an owner decision; report it instead of choosing.
