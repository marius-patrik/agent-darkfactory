### Submodule root overlay

- Treat each gitlink path, child repository identity, configured URL, recorded
  commit, released child head, and ancestry proof as one pointer contract.
- Update only trusted policy-owned paths to accessible released default-branch
  commits with green required evidence.
- Reject missing, renamed, misplaced, dirty, conflicted, uninitialized, inaccessible,
  non-ancestor, parked, or ambiguous children with exact evidence.
- Do not initialize or execute submodule code with privileged diagnostic credentials.
