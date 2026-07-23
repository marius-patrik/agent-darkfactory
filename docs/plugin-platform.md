# Public plugin platform

`agent.package.json` schema version 2 is Andromeda's single public extension
contract. The machine-readable schema is published from
`src/sdk/agent-package.schema.json`; the SDK parser is the authoritative
normalization and validation boundary. The published schema is exercised with
a strict Draft 2020-12 validator; semantic checks use the maintained semver and
SPDX expression parsers instead of permissive string patterns.

Every v2 manifest declares:

- publisher, package id, semantic version, SPDX license, and supported
  Andromeda/API versions;
- one declarative or digest-pinned WASI runtime;
- agent, command, TUI, web, server, and model contributions;
- explicit workspace, session, memory, model, network, secret, clipboard,
  notification, and external-URL permissions.

Native executable and script entries are not part of schema v2. Installation
also validates the observed artifact digest, every referenced JSON descriptor,
and the declared WASI module and digest before canonical state changes.

Commands are registered once through `src/commands`. Third-party commands use
`<publisher>.<plugin>:<command>` names by default. A manifest may request one
top-level alias, but the registry exposes it only when the corresponding
`<publisher>/<plugin>:<alias>` grant is present. Collisions fail atomically,
and plugins cannot shadow the embedded `help`, `version`, `doctor`, or
`plugins` recovery commands.

Version 1 manifests remain readable only for internal legacy packages while
their runtimes are folded into Andromeda. The public capability installer
requires version 2. This is a migration boundary, not a second public format.

The initial distribution surface is direct local/Git installation. Signing,
grant persistence, activation, rollback UI, WASI execution, and sandboxed web
bridging build on the normalized descriptor and are intentionally outside this
foundation.
