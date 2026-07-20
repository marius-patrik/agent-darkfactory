# Branching policy

`dev` is the integration branch and `main` is the release branch. Both branches require the `Validate` and `Codex Review` checks, reject force pushes and deletion, and accept changes only through current, green pull requests. Feature work targets `dev`; only release pull requests target `main`.
