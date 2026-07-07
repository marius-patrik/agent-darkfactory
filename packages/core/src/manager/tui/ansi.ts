export const ANSI = {
  clear: "\x1b[2J",
  clearLine: "\x1b[2K",
  clearFromCursor: "\x1b[0J",
  home: "\x1b[H",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  inverse: "\x1b[7m",
  resetInverse: "\x1b[27m",
  fg: {
    black: "\x1b[30m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    magenta: "\x1b[35m",
    cyan: "\x1b[36m",
    white: "\x1b[37m",
    gray: "\x1b[90m",
  },
  bg: {
    black: "\x1b[40m",
    red: "\x1b[41m",
    green: "\x1b[42m",
    yellow: "\x1b[43m",
    blue: "\x1b[44m",
    magenta: "\x1b[45m",
    cyan: "\x1b[46m",
    white: "\x1b[47m",
  },
};

export function moveCursor(x: number, y: number): string {
  return `\x1b[${y + 1};${x + 1}H`;
}

export function moveCursorUp(n: number): string {
  return `\x1b[${n}A`;
}

export function moveCursorDown(n: number): string {
  return `\x1b[${n}B`;
}

export function saveScreen(): string {
  // Alternate screen buffer (supported by most modern terminals).
  return "\x1b[?1049h";
}

export function restoreScreen(): string {
  return "\x1b[?1049l";
}

export function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const rawLine of text.split("\n")) {
    let line = rawLine;
    while (line.length > width) {
      let breakAt = width;
      while (breakAt > 0 && line[breakAt] !== " ") breakAt -= 1;
      if (breakAt === 0) breakAt = width;
      lines.push(line.slice(0, breakAt));
      line = line.slice(breakAt).trimStart();
    }
    lines.push(line);
  }
  return lines;
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

export function visibleLength(text: string): number {
  return stripAnsi(text).length;
}

export function padOrTruncate(text: string, width: number): string {
  const visible = stripAnsi(text);
  if (visible.length === width) return text;
  if (visible.length > width) {
    // Keep trailing reset code if present so color doesn't bleed.
    const reset = text.includes(ANSI.reset) ? ANSI.reset : "";
    return stripAnsi(text).slice(0, width) + reset;
  }
  return text + " ".repeat(width - visible.length);
}
