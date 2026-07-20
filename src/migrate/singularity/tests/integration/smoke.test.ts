import * as assert from "node:assert";
import * as vscode from "vscode";

const EXTENSION_ID = "marius-patrik.vsdaw";

suite("VSDAW Smoke", () => {
  test("extension is installed and activates", async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `Extension ${EXTENSION_ID} is not installed`);
    await ext.activate();
    assert.strictEqual(ext.isActive, true);
  });
});
