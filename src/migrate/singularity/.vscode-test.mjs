import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
  files: "out/tests/integration/**/*.test.cjs",
  workspaceFolder: "tests/integration/workspace",
  mocha: {
    timeout: 60000,
    ui: "tdd",
  },
});
