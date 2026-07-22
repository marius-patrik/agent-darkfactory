# Handoff

## Current authority

Branch: `main`

DarkFactory remains a separately owned product and repository. It delegates
local provider execution and personal state to Agent OS while keeping GitHub
control-plane behavior and operational ledgers under DarkFactory authority.
Worker claims remain `df:running` until live GitHub verification succeeds;
follow-through merges only verified (`df:done`) worker PRs.

Human operation uses `df`. Interactive issue drafts remain atomic local state
until the shared issue Autoreview protocol is clean and the owner approves the
exact reviewed digest. `df issue ready` and lane resume request/report machine
evaluation; neither writes `df:ready` directly.

Before handoff, run `npm run check`.
