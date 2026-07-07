export interface KeyEvent {
  name?: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  sequence: string;
  char?: string;
}

export type KeyAction =
  | { type: "cycle-provider" }
  | { type: "cycle-model" }
  | { type: "submit" }
  | { type: "quit" }
  | { type: "backspace" }
  | { type: "delete" }
  | { type: "cursor-left" }
  | { type: "cursor-right" }
  | { type: "cursor-home" }
  | { type: "cursor-end" }
  | { type: "scroll-up" }
  | { type: "scroll-down" }
  | { type: "insert"; char: string }
  | { type: "noop" };

export function parseKeySequence(buffer: Buffer | string): KeyEvent {
  const sequence = Buffer.isBuffer(buffer) ? buffer.toString("utf-8") : buffer;
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer, "utf-8");

  if (bytes.length === 0) {
    return { sequence, ctrl: false, meta: false, shift: false };
  }

  // Single-byte control characters.
  if (bytes.length === 1) {
    const byte = bytes[0];
    if (byte === 0x00) return { name: "space", ctrl: true, meta: false, shift: false, sequence };
    if (byte === 0x09) return { name: "tab", ctrl: false, meta: false, shift: false, sequence };
    if (byte === 0x0d) return { name: "return", ctrl: false, meta: false, shift: false, sequence };
    if (byte === 0x0a) return { name: "return", ctrl: false, meta: false, shift: false, sequence };
    if (byte === 0x7f) return { name: "backspace", ctrl: false, meta: false, shift: false, sequence };
    if (byte === 0x1b) return { name: "escape", ctrl: false, meta: false, shift: false, sequence };
    if (byte >= 0x01 && byte <= 0x1a) {
      return {
        name: String.fromCharCode(byte + 0x60),
        ctrl: true,
        meta: false,
        shift: false,
        sequence,
      };
    }
    if (byte >= 0x20 && byte <= 0x7e) {
      return {
        name: sequence,
        ctrl: false,
        meta: false,
        shift: false,
        sequence,
        char: sequence,
      };
    }
  }

  // ESC-prefixed sequences (meta / ANSI).
  if (bytes[0] === 0x1b) {
    // Meta + character: ESC <char>
    if (bytes.length === 2 && bytes[1] >= 0x20 && bytes[1] <= 0x7e) {
      const char = String.fromCharCode(bytes[1]);
      return {
        name: char,
        ctrl: false,
        meta: true,
        shift: false,
        sequence,
        char,
      };
    }

    // CSI sequences: ESC [ ...
    if (bytes.length >= 3 && bytes[1] === 0x5b) {
      const finalByte = bytes[bytes.length - 1];
      const params = bytes.subarray(2, bytes.length - 1).toString("utf-8");

      switch (finalByte) {
        case 0x41:
          return { name: "up", ctrl: false, meta: false, shift: false, sequence };
        case 0x42:
          return { name: "down", ctrl: false, meta: false, shift: false, sequence };
        case 0x43:
          return { name: "right", ctrl: false, meta: false, shift: false, sequence };
        case 0x44:
          return { name: "left", ctrl: false, meta: false, shift: false, sequence };
        case 0x48:
          return { name: "home", ctrl: false, meta: false, shift: false, sequence };
        case 0x46:
          return { name: "end", ctrl: false, meta: false, shift: false, sequence };
        case 0x7e:
          if (params === "3") return { name: "delete", ctrl: false, meta: false, shift: false, sequence };
          if (params === "5") return { name: "pageup", ctrl: false, meta: false, shift: false, sequence };
          if (params === "6") return { name: "pagedown", ctrl: false, meta: false, shift: false, sequence };
          break;
      }

      // Modified arrows: ESC [ 1 ; <mod> <dir>
      if (params.startsWith("1;") && bytes.length === 6) {
        const mod = bytes[4];
        const dir = bytes[5];
        const shift = mod === 0x32 || mod === 0x36;
        const ctrl = mod === 0x35 || mod === 0x36;
        const meta = mod === 0x37 || mod === 0x38;
        switch (dir) {
          case 0x41:
            return { name: "up", ctrl, meta, shift, sequence };
          case 0x42:
            return { name: "down", ctrl, meta, shift, sequence };
          case 0x43:
            return { name: "right", ctrl, meta, shift, sequence };
          case 0x44:
            return { name: "left", ctrl, meta, shift, sequence };
        }
      }
    }
  }

  return { sequence, ctrl: false, meta: false, shift: false };
}

export function keyEventToAction(event: KeyEvent): KeyAction {
  if (event.ctrl && event.name === "c") return { type: "quit" };
  if (event.name === "escape") return { type: "quit" };
  if (event.ctrl && event.name === "p") return { type: "cycle-provider" };
  if (event.ctrl && event.name === "m") return { type: "cycle-model" };
  if (event.name === "return" || event.name === "enter") return { type: "submit" };
  if (event.name === "backspace") return { type: "backspace" };
  if (event.name === "delete") return { type: "delete" };
  if (event.name === "left") return { type: "cursor-left" };
  if (event.name === "right") return { type: "cursor-right" };
  if (event.name === "home") return { type: "cursor-home" };
  if (event.name === "end") return { type: "cursor-end" };
  if (event.name === "up" || event.name === "pageup") return { type: "scroll-up" };
  if (event.name === "down" || event.name === "pagedown") return { type: "scroll-down" };
  if (event.char && event.char.length === 1 && !event.ctrl && !event.meta) {
    return { type: "insert", char: event.char };
  }
  return { type: "noop" };
}

export function parseKeyAction(buffer: Buffer | string): KeyAction {
  return keyEventToAction(parseKeySequence(buffer));
}
