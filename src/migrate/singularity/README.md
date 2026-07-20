# VSDAW

OpenDAW-powered digital audio workstation inside Visual Studio Code.

> **License:** AGPL-3.0-or-later  
> VSDAW is built on top of the [OpenDAW](https://github.com/andremichelle/openDAW) SDK, which is licensed under AGPL-3.0-or-later.

## Features

- First-class VS Code tabs: Timeline, Mixer, Piano Roll, Browser, and Graph.
- Custom `.vsdaw` project files stored as OpenDAW-compatible ZIP bundles.
- Audio and MIDI recording with multi-take support.
- OpenDAW stock devices for effects and instruments.
- Offline export to WAV, FLAC, and OGG.
- Native VS Code theming and keyboard shortcuts.

## Pinned OpenDAW SDK versions

This release pins the following OpenDAW packages:

- `@opendaw/studio-sdk@0.0.155`
- `@opendaw/studio-core@0.0.153`

## Development

VSDAW is developed with [Bun](https://bun.sh/). Make sure Bun is installed, then run:

```bash
bun install
bun run build
bun run test
bun run package
```

### Available scripts

| Script | Purpose |
|---|---|
| `bun run build` | Build engine, extension host, and React view bundles. |
| `bun run build:engine` | Bundle the hidden engine webview and copy OpenDAW workers. |
| `bun run build:extension` | Bundle the VS Code extension host and local Bun server. |
| `bun run build:views` | Bundle React view tabs and generate Tailwind CSS. |
| `bun run test` | Run Jest unit tests. |
| `bun run test:integration` | Run VS Code integration tests (`vscode-test`). |
| `bun run test:smoke` | Run smoke tests. |
| `bun run lint` | Run Biome linter/formatter checks. |
| `bun run lint:fix` | Auto-fix Biome issues. |
| `bun run format` | Format code with Biome. |
| `bun run typecheck` | Run TypeScript with `--noEmit`. |
| `bun run package` | Build and package the extension as a `.vsix`. |
| `bun run version` | Bump version and changelog with `standard-version`. |

### Local install verification

After `bun run package`:

```bash
code --install-extension vsdaw-<version>.vsix
```

Open VS Code, run **VSDAW: Open Project**, and verify the engine boots with `crossOriginIsolated === true`.

To uninstall:

```bash
code --uninstall-extension marius-patrik.vsdaw
```

## Usage

See [docs/USAGE.md](./docs/USAGE.md) for a complete usage guide.

## Third-party notices

See [ThirdPartyNotices.txt](./ThirdPartyNotices.txt) for upstream license notices.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).
