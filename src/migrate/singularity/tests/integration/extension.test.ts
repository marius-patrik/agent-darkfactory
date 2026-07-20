import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { createEmptyProject, writeBundle } from "../../src/shared/bundle.js";

const EXTENSION_ID = "marius-patrik.vsdaw";
const FIXTURE_PATH = path.resolve(
  process.cwd(),
  "tests",
  "integration",
  "fixtures",
  "sample.vsdaw",
);

async function ensureSampleFixture(): Promise<void> {
  if (fs.existsSync(FIXTURE_PATH)) return;

  const project = createEmptyProject("Sample", 48000);
  const bytes = await writeBundle(project);
  fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
  fs.writeFileSync(FIXTURE_PATH, bytes);
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 5000,
  intervalMs = 100,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Condition was not met within timeout");
}

suite("VSDAW Extension Integration", () => {
  test("activates the extension", async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `Extension ${EXTENSION_ID} is not installed`);
    await ext.activate();
    assert.strictEqual(ext.isActive, true);
  });

  test("creates a new project", async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder, "No workspace folder open");
    const workspacePath = workspaceFolder.uri.fsPath;
    fs.mkdirSync(workspacePath, { recursive: true });

    // Remove any existing untitled projects.
    for (const name of ["Untitled.vsdaw", "Untitled-1.vsdaw"]) {
      const candidate = path.join(workspacePath, name);
      if (fs.existsSync(candidate)) {
        fs.unlinkSync(candidate);
      }
    }

    await vscode.commands.executeCommand("vsdaw.newProject");

    await waitForCondition(
      () =>
        fs.existsSync(path.join(workspacePath, "Untitled.vsdaw")) ||
        fs.existsSync(path.join(workspacePath, "Untitled-1.vsdaw")),
    );
  });

  test("opens a .vsdaw file and starts the background engine", async () => {
    await ensureSampleFixture();
    const uri = vscode.Uri.file(FIXTURE_PATH);
    await vscode.commands.executeCommand("vscode.openWith", uri, "vsdaw.editor");

    await waitForCondition(
      () => {
        const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs);
        return tabs.some(
          (tab) =>
            tab.label.includes("VSDAW") ||
            tab.label.includes("Sample") ||
            tab.label.includes("Timeline") ||
            tab.label.includes(".vsdaw"),
        );
      },
      30000,
      250,
    );
  });
});
