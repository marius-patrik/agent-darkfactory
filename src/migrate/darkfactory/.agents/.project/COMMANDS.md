# Commands

## Setup

```powershell
npm ci
```

## Development

```powershell
npm run dev
```

## Validation

```powershell
npm run check
npm run typecheck
npm test
npm run build
```

## CI

GitHub Actions runs:

```powershell
npm ci
npm run check
```

## Managed Sync

```powershell
npm run install:url
df baseline sync owner/repo
```

## Human development surface

```powershell
df help issue draft
df issue draft owner/repo
df issue review owner/repo#123 --version <sha256>
df issue ready owner/repo#123 --version <sha256>
df pr status owner/repo#456
df runs list owner/repo --json
df receipts verify owner/repo#receipt-name --json
```

`df` is canonical; `darkfactory` uses the same parser and implementation.
Deterministic commands reject model flags. Drafting fixes tier to `high` and
accepts effort independently. Mutations require an exact target, current-state
revalidation, policy authority, and a durable receipt. Use
`df help <command> [subcommand]` for command-specific defaults, permissions,
trust boundaries, examples, and exit semantics.

## Product boundary

DarkFactory owns its repository versioning and releases. Agent OS integration
may launch a pinned revision but does not own DarkFactory publication.
