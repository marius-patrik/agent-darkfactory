# 07 — Release

## Goal

Ship a public release-ready VS Code extension with proper versioning, packaging, and distribution.

## Versioning

- Semantic Versioning (`MAJOR.MINOR.PATCH`).
- Initial release: `0.1.0` (public beta), then `1.0.0` when v1.0 criteria are met.
- Version bumps via `bun run version <patch|minor|major>` using `standard-version` or manual `package.json` edit + git tag.

## Changelog

- Maintain `CHANGELOG.md` following Keep a Changelog format.
- Auto-generate from Conventional Commits during release.

## Packaging

- Build command: `bun run package`.
- Uses `vsce package` or `bunx @vscode/vsce` to produce `vsdaw-<version>.vsix`.
- `.vsceignore` excludes `src/`, `tests/`, `specs/`, `node_modules/`, `.git/`, etc.

## Distribution

| Channel | Tool | Trigger |
|---|---|---|
| GitHub Releases | `gh release create` | Tag push |
| VS Code Marketplace | `vsce publish` | Release workflow |
| Open VSX Registry | `ovsx publish` | Release workflow |

## Release workflow

`.github/workflows/release.yml`:

1. Checkout code.
2. Install Bun and dependencies.
3. Run lint, typecheck, tests.
4. Build extension and webview bundles.
5. Package `.vsix`.
6. Create GitHub Release with `.vsix` asset.
7. Publish to VS Code Marketplace and Open VSX.

## Marketplace metadata

`package.json` fields:

```json
{
  "name": "vsdaw",
  "displayName": "VSDAW",
  "description": "OpenDAW-powered digital audio workstation inside VS Code.",
  "version": "0.1.0",
  "publisher": "marius-patrik",
  "license": "AGPL-3.0-or-later",
  "repository": { "type": "git", "url": "https://github.com/marius-patrik/vsdaw" },
  "bugs": { "url": "https://github.com/marius-patrik/vsdaw/issues" },
  "homepage": "https://github.com/marius-patrik/vsdaw#readme",
  "icon": "media/icon.png",
  "categories": ["Visualization", "Debuggers", "Other"],
  "keywords": ["daw", "audio", "music", "midi", "opendaw", "production"]
}
```

## License compliance

- Include full `LICENSE` file (AGPL-3.0).
- Include OpenDAW attribution and upstream license notice in `README.md` and ` ThirdPartyNotices.txt`.
- Source code is published on GitHub.
- No proprietary OpenDAW commercial license is used.

## Local install verification

After each release build:

1. Run `code --install-extension vsdaw-<version>.vsix`.
2. Open VS Code, run `VSDAW: New Project`.
3. Verify Timeline opens and engine boots.
4. Uninstall: `code --uninstall-extension marius-patrik.vsdaw`.

## Acceptance criteria

1. `bun run package` produces a valid `.vsix`.
2. The `.vsix` installs locally in VS Code and activates without errors.
3. Release workflow publishes to GitHub Releases, Marketplace, and Open VSX.
4. `LICENSE` and third-party notices are included.
