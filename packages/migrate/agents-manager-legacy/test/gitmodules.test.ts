import { describe, expect, test } from "bun:test";
import { parseGitmodules, serializeGitmodules } from "../src/gitmodules";

describe("gitmodules", () => {
  test("parses submodule entries", () => {
    expect(
      parseGitmodules(`[submodule "agents/skyblock-agent"]
\tpath = agents/skyblock-agent
\turl = https://github.com/marius-patrik/skyblock-agent.git
\tbranch = main
`),
    ).toEqual([
      {
        name: "agents/skyblock-agent",
        path: "agents/skyblock-agent",
        url: "https://github.com/marius-patrik/skyblock-agent.git",
        branch: "main",
      },
    ]);
  });

  test("serializes stable entries", () => {
    expect(
      serializeGitmodules([
        {
          name: "os/agents-harness",
          path: "os/agents-harness",
          url: "https://github.com/marius-patrik/agents-harness.git",
          branch: "main",
        },
      ]),
    ).toBe(`[submodule "os/agents-harness"]
\tpath = os/agents-harness
\turl = https://github.com/marius-patrik/agents-harness.git
\tbranch = main
`);
  });
});


