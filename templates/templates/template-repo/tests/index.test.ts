import { describe, expect, test } from "bun:test";

import { createGreeting } from "../src/index";

describe("createGreeting", () => {
  test("greets the default audience", () => {
    expect(createGreeting()).toBe("Hello, world!");
  });

  test("trims a provided name", () => {
    expect(createGreeting("  Bun  ")).toBe("Hello, Bun!");
  });
});
