import { describe, expect, test } from "bun:test";
import { parseGitmodules, serializeGitmodules } from "../src/gitmodules";

describe("gitmodules", () => {
  test("parses submodule entries", () => {
    expect(
      parseGitmodules(`[submodule "plugins/skyblock-agent"]
\tpath = plugins/skyblock-agent
\turl = https://github.com/marius-patrik/skyblock-agent.git
\tbranch = main
`),
    ).toEqual([
      {
        name: "plugins/skyblock-agent",
        path: "plugins/skyblock-agent",
        url: "https://github.com/marius-patrik/skyblock-agent.git",
        branch: "main",
      },
    ]);
  });

  test("serializes stable entries", () => {
    expect(
      serializeGitmodules([
        {
          name: "plugins/darkfactory",
          path: "plugins/darkfactory",
          url: "https://github.com/marius-patrik/agent-darkfactory.git",
          branch: "main",
        },
      ]),
    ).toBe(`[submodule "plugins/darkfactory"]
\tpath = plugins/darkfactory
\turl = https://github.com/marius-patrik/agent-darkfactory.git
\tbranch = main
`);
  });
});


