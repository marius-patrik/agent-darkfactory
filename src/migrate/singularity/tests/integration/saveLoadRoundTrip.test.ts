import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ProjectState } from "../../src/shared/protocol.js";

const EXTENSION_ID = "marius-patrik.vsdaw";

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 30000,
  intervalMs = 250,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Condition was not met within timeout");
}

async function getProjectFilePath(): Promise<string> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspaceFolder, "No workspace folder open");
  const workspacePath = workspaceFolder.uri.fsPath;
  const entries = fs.readdirSync(workspacePath);
  const projectFile = entries.find((name) => name.endsWith(".vsdaw"));
  assert.ok(projectFile, "No .vsdaw project file found");
  return path.join(workspacePath, projectFile);
}

async function tryGetProjectState(): Promise<ProjectState | undefined> {
  try {
    return (await vscode.commands.executeCommand("vsdaw.getProjectState")) as
      | ProjectState
      | undefined;
  } catch {
    return undefined;
  }
}

async function waitForProjectState(
  predicate: (state: ProjectState) => boolean,
  timeoutMs = 30000,
): Promise<ProjectState> {
  let state: ProjectState | undefined;
  await waitForCondition(async () => {
    state = await tryGetProjectState();
    return state !== undefined && predicate(state);
  }, timeoutMs);
  assert.ok(state, "Project state was not available");
  return state;
}

suite("VSDAW Save/Load Round-trip", () => {
  test("saves and restores tracks and regions", async function () {
    this.timeout(120000);

    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `Extension ${EXTENSION_ID} is not installed`);
    await ext.activate();

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder, "No workspace folder open");
    const workspacePath = workspaceFolder.uri.fsPath;

    // Clean up any previous project files.
    for (const entry of fs.readdirSync(workspacePath)) {
      if (entry.endsWith(".vsdaw")) {
        fs.unlinkSync(path.join(workspacePath, entry));
      }
    }

    await vscode.commands.executeCommand("vsdaw.newProject");

    const projectPath = await getProjectFilePath();
    await waitForCondition(() => fs.existsSync(projectPath), 10000);

    // Wait for the engine to report the initial track.
    await waitForProjectState((state) => state.tracks.length > 0, 60000);

    // Create a MIDI track and a bus track. Audio track creation may require
    // capture permissions that are not available in the headless test
    // environment, so we verify the round-trip with track types that are
    // supported there.
    const midiTrackId = (await vscode.commands.executeCommand("vsdaw.createTrack", {
      type: "midi",
      name: "MIDI 1",
    })) as string;

    await waitForProjectState((state) => state.tracks.some((t) => t.id === midiTrackId), 30000);

    const busTrackId = (await vscode.commands.executeCommand("vsdaw.createTrack", {
      type: "bus",
      name: "Bus 1",
    })) as string;

    await waitForProjectState((state) => state.tracks.some((t) => t.id === busTrackId), 30000);

    await vscode.commands.executeCommand("vsdaw.setTrackMute", {
      trackId: busTrackId,
      value: true,
    });
    await waitForProjectState(
      (state) => state.tracks.find((t) => t.id === busTrackId)?.mute === true,
      30000,
    );

    await vscode.commands.executeCommand("vsdaw.setTrackSolo", {
      trackId: midiTrackId,
      value: true,
    });
    await waitForProjectState(
      (state) => state.tracks.find((t) => t.id === midiTrackId)?.solo === true,
      30000,
    );

    const regionId = (await vscode.commands.executeCommand("vsdaw.createMidiRegion", {
      trackId: midiTrackId,
      name: "Lead",
    })) as string;

    const beforeState = await waitForProjectState(
      (state) => state.tracks.length === 3 && state.regions.some((r) => r.id === regionId),
      30000,
    );

    const busTrack = beforeState.tracks.find((t) => t.id === busTrackId);
    const midiTrack = beforeState.tracks.find((t) => t.id === midiTrackId);
    assert.ok(busTrack, "Bus track not found");
    assert.ok(midiTrack, "MIDI track not found");
    assert.strictEqual(busTrack.name, "Bus 1");
    assert.strictEqual(midiTrack.name, "MIDI 1");
    assert.strictEqual(busTrack.mute, true);
    assert.strictEqual(midiTrack.solo, true);

    const region = beforeState.regions.find((r) => r.id === regionId);
    assert.ok(region, "MIDI region not found");
    assert.strictEqual(region.trackId, midiTrackId);

    // Save and close the custom editor.
    await vscode.commands.executeCommand("vsdaw.saveProject");
    await vscode.commands.executeCommand("vsdaw.showTimeline");
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");

    await waitForCondition(
      () =>
        !vscode.window.tabGroups.all
          .flatMap((group) => group.tabs)
          .some((tab) => tab.label.toLowerCase().includes("vsdaw") || tab.label.endsWith(".vsdaw")),
      10000,
    );

    // Reopen the project file.
    const uri = vscode.Uri.file(projectPath);
    await vscode.commands.executeCommand("vscode.openWith", uri, "vsdaw.editor");

    await waitForCondition(
      () =>
        vscode.window.tabGroups.all
          .flatMap((group) => group.tabs)
          .some((tab) => tab.label.toLowerCase().includes("vsdaw") || tab.label.endsWith(".vsdaw")),
      30000,
    );

    // Wait for the engine to restore the same state.
    const afterState = await waitForProjectState(
      (state) => state.tracks.length === beforeState.tracks.length,
      60000,
    );

    assert.strictEqual(afterState.tracks.length, beforeState.tracks.length);
    for (const beforeTrack of beforeState.tracks) {
      const afterTrack = afterState.tracks.find((t) => t.id === beforeTrack.id);
      assert.ok(afterTrack, `Track ${beforeTrack.id} missing after reopen`);
      assert.strictEqual(afterTrack.name, beforeTrack.name);
      assert.strictEqual(afterTrack.type, beforeTrack.type);
      assert.strictEqual(afterTrack.mute, beforeTrack.mute);
      assert.strictEqual(afterTrack.solo, beforeTrack.solo);
    }

    assert.strictEqual(afterState.regions.length, beforeState.regions.length);
    for (const beforeRegion of beforeState.regions) {
      const afterRegion = afterState.regions.find((r) => r.id === beforeRegion.id);
      assert.ok(afterRegion, `Region ${beforeRegion.id} missing after reopen`);
      assert.strictEqual(afterRegion.trackId, beforeRegion.trackId);
      assert.strictEqual(afterRegion.duration, beforeRegion.duration);
    }
  });
});
