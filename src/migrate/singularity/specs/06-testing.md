# 06 — Testing

## Goal

Ensure the extension is stable, regressions are caught early, and releases are trustworthy.

## Test levels

### Unit tests (Jest)

- Target: `src/extension/**/*.ts` utilities and `src/shared/**/*.ts`.
- Examples:
  - Message protocol serialization/deserialization.
  - Project bundle read/write.
  - Peak generation math.
  - Zod schema validation.
  - Time conversion helpers.

### Integration tests (`@vscode/test-cli`)

- Launch VS Code with the extension under test.
- Scenarios:
  - Activate extension.
  - Run `VSDAW: New Project` and verify a `.vsdaw` file is created.
  - Open a `.vsdaw` file and verify the Timeline webview loads.
  - Save and reopen project.
  - Server starts/stops correctly.

### Smoke tests (manual / scripted)

- Engine boots and reports `crossOriginIsolated === true`.
- Audio playback produces sound (verified via loopback or meter).
- Recording creates a region.
- Export produces a non-empty file.

## CI matrix

GitHub Actions runs on:

- macOS (arm64) — primary dev platform
- Ubuntu (x64)
- Windows (x64)

Node/Bun versions:

- Bun latest stable
- Node 23+ fallback for compatibility checks

## Coverage

- Minimum 70% line coverage for unit tests.
- Coverage reported to GitHub Actions summary.

## Lint and format

- Biome runs in CI for `src/`, `specs/`, `tests/`.
- Pre-commit hook runs `biome check --write` on staged files.

## Test scripts

```json
{
  "test": "jest",
  "test:integration": "vscode-test",
  "test:smoke": "node scripts/smoke.js",
  "lint": "biome check .",
  "lint:fix": "biome check --write .",
  "format": "biome format --write ."
}
```

## Acceptance criteria

1. `bun run test` passes locally.
2. CI passes on macOS, Ubuntu, and Windows.
3. Integration test verifies a project can be created and opened.
4. Coverage report is generated and meets the 70% threshold.
