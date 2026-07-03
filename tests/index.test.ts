import { describe, expect, test } from "bun:test";

import { createGreeting, parseArgs, runCli } from "../src/index";

describe("parseArgs", () => {
  test("uses defaults when no arguments are provided", () => {
    expect(parseArgs([])).toEqual({
      name: "world",
      shout: false
    });
  });

  test("parses name and shout options", () => {
    expect(parseArgs(["--name", "DarkFactory", "--shout"])).toEqual({
      name: "DarkFactory",
      shout: true
    });
  });

  test("rejects unknown options", () => {
    expect(() => parseArgs(["--unknown"])).toThrow("Unknown option: --unknown");
  });
});

describe("createGreeting", () => {
  test("greets the selected name", () => {
    expect(createGreeting({ name: "CLI", shout: false })).toBe("Hello, CLI.");
  });

  test("can shout the greeting", () => {
    expect(createGreeting({ name: "CLI", shout: true })).toBe("HELLO, CLI.");
  });
});

describe("runCli", () => {
  test("returns help output", () => {
    const result = runCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: template-cli");
    expect(result.stderr).toBe("");
  });

  test("returns validation errors without throwing", () => {
    const result = runCli(["--name"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("--name requires a value");
  });
});
