# Branch Protection

`main` branches are protected with required status checks matching each repository's validation surface.

## Required status checks

| Repository | Required checks |
|------------|-----------------|
| `marius-patrik/darkfactory-templates` | `Validate` |
| `marius-patrik/template-bot` | `CI` |
| `marius-patrik/template-cli` | `CI`, `Codex Review` |
| `marius-patrik/template-repo` | `CI` |
| `marius-patrik/template-web` | `CI`, `Codex Review` |

`Codex Review` is required only where the managed review workflow is already present and passing.

## Pull request requirements

- Required approving review count: `0` (single-owner repositories).
- Dismiss stale reviews when new commits are pushed: enabled.
- Require conversation resolution before merging: enabled.
- Code owner reviews: not required.

## Repository settings

- `allow_auto_merge`: enabled
- `delete_branch_on_merge`: enabled
