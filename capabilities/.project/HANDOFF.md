# Handoff

Resume planning from `context/TASK.md` in the `private-data` repository, which
is the owner-facing authorization and sequencing board. Do not reconstruct
completed rows from provider task stores or transcripts; those are evidence,
not authority.

Andromeda v0.9.0 is released with `dev` and `main` tree-identical. The layout
refactor and the template consolidation are complete, and the full CI gate
passes including the DarkFactory managed setup check.

```powershell
$env:ANDROMEDA_HOME = "$HOME\.andromeda"
$env:ANDROMEDA_USER_HOME = "$HOME"
$env:ANDROMEDA_ROOT = "$HOME\marius-patrik\Andromeda"
Set-Location $env:ANDROMEDA_ROOT
bun packages/cli/src/cli.ts state doctor --json
```

## What the next session should know

The target components — `sdk`, `mcp`, `server`, `clients/*`, `plugins` — exist
as contracts without implementation. The work ahead is reimplementing capability
out of `packages/migrate` against the sdk, not extending the frozen tree in place.
Nothing outside a carried tree may depend on one.

Carried trees (`packages/migrate/`, `agents/<project>/`, `templates/<project>/`) hold
former standalone repositories with their full history. Repository-wide
contracts that govern what is built and shipped do not apply inside them; every
live surface is still fully scanned. If a rule needs relaxing for a carried
tree, scope the exemption to that tree rather than weakening the rule.

State lives in the separate `private-data` repository, not as a submodule.
`agents state backup|restore|sync` operates on authenticated encrypted event
bundles there. Never commit plaintext credentials, provider homes, keys, locks,
caches, or projections.

Before deleting any repository that has been folded in, verify coverage first:
compare file counts and branch tips, and preserve anything that will not merge
as an `archive/<repo>/<branch>` tag. Several such tags already exist in this
repository for exactly that reason.
