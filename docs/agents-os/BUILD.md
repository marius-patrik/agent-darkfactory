# Agent OS Image Build and Release

Status: parked supporting design. The program plan and PRD park custom
distro/container work; this document does not authorize resumption. This
repository currently has no Agent OS Dockerfile, no `image:build` or
`image:smoke` package script, and no image-release workflow. The lifecycle CLI
may render plans, but it must fail rather than claim that a missing image
pipeline ran.

## Required implementation

Before local image build is supported, add and validate:

- a root-owned Dockerfile and pinned toolchain inputs;
- a deterministic build context that excludes live state, Recovery data,
  provider homes, credentials, caches, and unrelated worktrees;
- a disposable-state smoke that runs the installed `agents` launcher and
  `agents state doctor` inside the image;
- package/profile health checks that require no live secrets;
- image metadata labels for version, channel, commit, build time, and digest;
- CI that builds the exact release commit before any publication step.

Before registry publication is supported, also add an explicit workflow that
uses the repository release ref, authenticates only for the push step, publishes
an immutable version tag and digest, and attaches validation evidence. Moving
channel tags may point to that digest only after the immutable push succeeds.

## Safety gate

Secrets and mutable operational state are runtime mounts, never image input.
No command, document, or test may treat a dry-run plan or a locally fabricated
metadata record as proof of an image build, pull, or release.

The current supported install boundary is the source installer in
`install/install.sh`, validated by `bun run smoke:release`.
