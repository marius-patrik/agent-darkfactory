import { UndoManager } from "../../src/extension/undoManager.js";

describe("UndoManager", () => {
  test("starts with no undo or redo available", () => {
    const manager = new UndoManager<string>();

    expect(manager.canUndo).toBe(false);
    expect(manager.canRedo).toBe(false);
    expect(manager.current).toBeUndefined();
  });

  test("setBase establishes the initial snapshot", () => {
    const manager = new UndoManager<string>();
    manager.setBase("initial");

    expect(manager.current).toBe("initial");
    expect(manager.canUndo).toBe(false);
    expect(manager.canRedo).toBe(false);
  });

  test("pushing snapshots enables undo", () => {
    const manager = new UndoManager<string>();
    manager.setBase("state-0");

    manager.push("state-1");
    expect(manager.current).toBe("state-1");
    expect(manager.canUndo).toBe(true);
    expect(manager.canRedo).toBe(false);

    manager.push("state-2");
    expect(manager.current).toBe("state-2");
    expect(manager.length).toBe(2);
  });

  test("undo restores the previous snapshot", () => {
    const manager = new UndoManager<string>();
    manager.setBase("state-0");
    manager.push("state-1");
    manager.push("state-2");

    expect(manager.undo()).toBe("state-1");
    expect(manager.current).toBe("state-1");
    expect(manager.canUndo).toBe(true);
    expect(manager.canRedo).toBe(true);

    expect(manager.undo()).toBe("state-0");
    expect(manager.current).toBe("state-0");
    expect(manager.canUndo).toBe(false);
    expect(manager.canRedo).toBe(true);
  });

  test("redo restores the next snapshot", () => {
    const manager = new UndoManager<string>();
    manager.setBase("state-0");
    manager.push("state-1");
    manager.push("state-2");

    manager.undo();
    manager.undo();

    expect(manager.redo()).toBe("state-1");
    expect(manager.current).toBe("state-1");

    expect(manager.redo()).toBe("state-2");
    expect(manager.current).toBe("state-2");
    expect(manager.canRedo).toBe(false);
  });

  test("pushing after undo discards redo history", () => {
    const manager = new UndoManager<string>();
    manager.setBase("state-0");
    manager.push("state-1");
    manager.push("state-2");

    manager.undo();
    manager.push("state-3");

    expect(manager.length).toBe(2);
    expect(manager.current).toBe("state-3");
    expect(manager.canRedo).toBe(false);
    expect(manager.undo()).toBe("state-1");
  });

  test("undo and redo are no-ops at the boundaries", () => {
    const manager = new UndoManager<string>();
    manager.setBase("state-0");
    manager.push("state-1");

    manager.undo();
    expect(manager.undo()).toBeUndefined();

    manager.redo();
    manager.redo();
    expect(manager.redo()).toBeUndefined();
  });

  test("limit drops oldest entries", () => {
    const manager = new UndoManager<number>({ limit: 2 });
    manager.setBase(0);
    manager.push(1);
    manager.push(2);
    manager.push(3);

    expect(manager.length).toBe(2);
    expect(manager.current).toBe(3);
    expect(manager.canUndo).toBe(true);

    // The oldest entry (1) should have been dropped, so undoing from 3 should
    // land on 2, not 1.
    expect(manager.undo()).toBe(2);
    expect(manager.undo()).toBe(0);
    expect(manager.canUndo).toBe(false);
  });
});
