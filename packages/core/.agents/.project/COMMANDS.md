# Commands

Install dependencies from the repository root:

```sh
cd ../..
bun install --frozen-lockfile
```

Validate the direct `packages/core` component from the repository root:

```sh
bunx tsc --noEmit -p packages/core/tsconfig.json
bun scripts/verify-codegen.ts
cd packages/core/contracts-go && go test ./...
```

Focused commands:

```sh
bunx buf lint packages/core/proto
bun scripts/verify-codegen.ts
cd packages/core/contracts-go && go test ./...
bunx tsc --noEmit -p packages/core/tsconfig.json
```
