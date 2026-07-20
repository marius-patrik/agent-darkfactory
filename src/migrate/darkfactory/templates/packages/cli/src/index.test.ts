import { expect, test, spyOn } from "bun:test";
import { main } from "./index";

test("main greets the provided name", () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  main(["Alice"]);
  expect(log).toHaveBeenCalledWith("Hello, Alice.");
  log.mockRestore();
});

test("main defaults to world", () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  main([]);
  expect(log).toHaveBeenCalledWith("Hello, world.");
  log.mockRestore();
});
