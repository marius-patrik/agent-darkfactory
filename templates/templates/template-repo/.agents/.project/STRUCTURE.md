# Structure

## Project Files

- `src/index.ts` - sample source entrypoint
- `tests/index.test.ts` - sample Bun tests
- `package.json` - Bun package metadata and scripts
- `tsconfig.json` - strict TypeScript configuration
- `.github/workflows/ci.yml` - GitHub Actions validation
- `README.md` - template setup and usage notes

## Agent Files

- `AGENTS.md` - root entrypoint for agents
- `.agents/.global/` - reusable agent protocol, workflow, validation, docs, and skills
- `.agents/.project/` - project-specific context, commands, status, decisions, dialogue, and handoff

## Generated Or Ignored

- `node_modules/`
- `dist/`
- coverage output
- local environment files
- runtime-generated `.agents` metadata
