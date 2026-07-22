### Mixed monorepo overlay

- Reconstruct package ownership, dependency edges, gitlinks, and root validation
  from the repository tree before changing a package.
- Validate each affected language boundary plus the authoritative root integration
  gate; a green leaf package does not prove the root.
- Keep package-local documentation and tooling at their owned roots while shared
  capabilities remain at the declared repository root.
- Sequence cross-package changes and pointer updates so every intermediate pull
  request is reviewable and references exact revisions.
