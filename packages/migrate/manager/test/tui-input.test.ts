import { describe, expect, test } from "bun:test";
import { keyEventToAction, parseKeyAction, parseKeySequence } from "../src/tui/input";

describe("hotkey handling logic", () => {
  test("parses Ctrl+P as cycle-provider", () => {
    const action = parseKeyAction(Buffer.from([0x10]));
    expect(action).toEqual({ type: "cycle-provider" });
  });

  test("maps Ctrl+M key event to cycle-model", () => {
    // Raw byte 0x0d is ambiguous (Enter vs Ctrl+M); readline distinguishes them
    // by setting ctrl=true for Ctrl+M. The handler must honor that event.
    const action = keyEventToAction({ name: "m", ctrl: true, meta: false, shift: false, sequence: "\r" });
    expect(action).toEqual({ type: "cycle-model" });
  });

  test("parses Ctrl+C as quit", () => {
    const action = parseKeyAction(Buffer.from([0x03]));
    expect(action).toEqual({ type: "quit" });
  });

  test("parses Escape as quit", () => {
    const action = parseKeyAction(Buffer.from([0x1b]));
    expect(action).toEqual({ type: "quit" });
  });

  test("parses Enter as submit", () => {
    // Carriage return is the same byte as Ctrl+M, but our pure parser returns the
    // raw event; the higher-level mapping in the app uses readline's key object
    // which distinguishes Ctrl. Here we assert the raw parse.
    const event = parseKeySequence(Buffer.from([0x0d]));
    expect(event.name).toBe("return");
  });

  test("regular characters insert", () => {
    const action = parseKeyAction(Buffer.from("a"));
    expect(action).toEqual({ type: "insert", char: "a" });
  });

  test("space inserts", () => {
    const action = parseKeyAction(Buffer.from(" "));
    expect(action).toEqual({ type: "insert", char: " " });
  });

  test("backspace removes previous character", () => {
    const action = parseKeyAction(Buffer.from([0x7f]));
    expect(action).toEqual({ type: "backspace" });
  });

  test("delete removes current character", () => {
    const action = parseKeyAction(Buffer.from([0x1b, 0x5b, 0x33, 0x7e]));
    expect(action).toEqual({ type: "delete" });
  });

  test("arrow keys map to navigation", () => {
    expect(parseKeyAction(Buffer.from([0x1b, 0x5b, 0x44]))).toEqual({ type: "cursor-left" });
    expect(parseKeyAction(Buffer.from([0x1b, 0x5b, 0x43]))).toEqual({ type: "cursor-right" });
    expect(parseKeyAction(Buffer.from([0x1b, 0x5b, 0x41]))).toEqual({ type: "scroll-up" });
    expect(parseKeyAction(Buffer.from([0x1b, 0x5b, 0x42]))).toEqual({ type: "scroll-down" });
  });

  test("home and end move cursor", () => {
    expect(parseKeyAction(Buffer.from([0x1b, 0x5b, 0x48]))).toEqual({ type: "cursor-home" });
    expect(parseKeyAction(Buffer.from([0x1b, 0x5b, 0x46]))).toEqual({ type: "cursor-end" });
  });

  test("page up and page down scroll", () => {
    expect(parseKeyAction(Buffer.from([0x1b, 0x5b, 0x35, 0x7e]))).toEqual({ type: "scroll-up" });
    expect(parseKeyAction(Buffer.from([0x1b, 0x5b, 0x36, 0x7e]))).toEqual({ type: "scroll-down" });
  });

  test("ctrl+letters map to control events", () => {
    expect(parseKeySequence(Buffer.from([0x01])).ctrl).toBe(true);
    expect(parseKeySequence(Buffer.from([0x01])).name).toBe("a");
    expect(parseKeySequence(Buffer.from([0x1a])).ctrl).toBe(true);
    expect(parseKeySequence(Buffer.from([0x1a])).name).toBe("z");
  });

  test("unknown sequences are noops", () => {
    const action = parseKeyAction(Buffer.from([0x1b, 0x5b, 0x39, 0x7e]));
    expect(action).toEqual({ type: "noop" });
  });
});
