# Agents Manager PRD

## Overview

`agents-manager` owns the standalone Bun TypeScript `agents` CLI. The CLI manages local agents-mono package checkouts, shared `.agents` runtime state, provider CLI homes, harness execution, installs, data repositories, secrets, and credits.

## Goals

- Keep the repo independently runnable with Bun.
- Manage git-backed package checkouts and local package registrations.
- Provide shared state under `.agents` for provider CLIs, skills, plugins, hooks, templates, secrets, credits, installs, data repositories, and package registrations.
- Keep harness runtime data under `.agents/harnesses/<id>/runtime`.
- Expose one CLI surface for package, state, provider, harness, install, secret, credit, and diagnostic operations.
- Validate with `bun run check`, `bun run test`, and the equivalent `bun run ci`.

## Non-Goals

- Replace Bun, npm, uv, apt, pacman, Docker, or other package managers in the current implementation.
- Implement real OS package, container image, or environment switching behavior before the agents-mono #8 and #9 contracts are ready.
- Perform live GitHub mutations in tests.

## Current Command Surface

```text
agents list [--json]
agents info <name-or-path> [--json]
agents add <name> <git-url> [--kind agent|app|data|package|template|workspace|harness|cli|plugin] [--branch main] [--path path]
agents remove <name-or-path>
agents sync
agents state init
agents state env
agents cli list|doctor
agents cli env <codex|claude|kimi|agy>
agents cli materialize-creds <codex|claude|kimi|agy>
agents cli exec <codex|claude|kimi|agy> -- <args...>
agents packages register <path>
agents packages list [--json]
agents packages run <name-or-path> -- <args...>
agents packages distro <define|install|upgrade|remove> ...
agents packages container <define|pull|pin|upgrade|remove> ...
agents env list [--json]
agents env create <id> [--kind host|container|agent-workspace]
agents env switch <id>
agents env sync <id>
agents data repo list [--json]
agents data repo set <id> <owner/name> [--path data/name] [--branch main] [--managed-path path] [--env NAME]
agents data repo path <id>
agents data repo env <id>
agents harness list [--json]
agents harness doctor <name>
agents harness run <name> -- <args...>
agents install <skill|plugin|hook|template|cli|harness> <name> <source-path-or-url>
agents installs [--json]
agents secrets list [--json]
agents secrets set <NAME> [--from-file path]
agents secrets path <NAME>
agents secrets github sync <NAME> [--as SECRET_NAME] [--repo owner/name | --owner owner] [--dry-run]
agents credits [--json]
agents credits credit <provider> <consumer> <amount> [--note text] [--json]
agents credits debit <provider> <consumer> <amount> [--note text] [--json]
agents credits usage <provider> <consumer> [--amount n] [--tokens-in n] [--tokens-out n] [--note text] [--json]
agents credits provider <provider> [--balance n] [--soft-limit n] [--window-seconds n] [--window-started-at iso] [--json]
agents doctor
agents os doctor [--json]
agents os image list [--json]
agents os image build --image <image> [--channel dev] [--file path] [--context path] [--dry-run]
agents os image pull --image <image> [--channel dev] [--dry-run]
agents os create --name <name> --image <image> [--env agents-os] [--channel dev] [--dry-run]
agents os start <name> [--dry-run]
agents os stop <name> [--dry-run]
agents os status <name> [--json]
agents os logs <name> [--follow]
agents os exec <name> -- <args...>
agents os terminal <name> [--shell bash]
agents os remove <name> [--prune-data] [--dry-run]
agents os deploy <profile> [--image agents-os] [--env agents-os] [--channel dev] [--dry-run]
```

## State Layout

```text
.agents/
  clis/
  harnesses/
    <id>/
      runtime/
  skills/
  plugins/
  hooks/
  templates/
  secrets/
  credits.json
  data-repos.json
  installs.json
  packages.json
  environments.json
  env
```

The CLI exports `AGENTS_HOME`, `AGENTS_ROOT`, `AGENTS_CLIS`, `AGENTS_HARNESSES`, `AGENTS_SKILLS`, `AGENTS_PLUGINS`, `AGENTS_HOOKS`, `AGENTS_TEMPLATES`, `AGENTS_SECRETS`, `AGENTS_CREDITS`, `AGENTS_DATA_REPOS`, and `AGENTS_ENVIRONMENTS`. Package and harness execution also exports configured data repository variables such as `AGENTOS_DATA_ROOT`.

## Roadmap

### TUI and OS Launcher (#8)

The launcher should expose the existing CLI management surface for local operators. It must use the same state files and package contracts rather than creating a parallel registry.

### Single Management Surface (#7)

Packages, environments, provider adapters, secrets, harnesses, credits, and launcher operations should remain manageable through `agents`. New work should extend the CLI surface instead of adding sidecar tools.

### OS/Container Packages and Environments (#10)

The package manager must grow into real distro package, container image, and named environment management. Groundwork should define typed records, state-file layout, and explicit not-yet-implemented command skeletons. Real distro and image plumbing depends on agents-mono #8 and #9, so current docs must not claim those behaviors exist.

The first groundwork slice is documented in `docs/packages-and-environments.md`.
