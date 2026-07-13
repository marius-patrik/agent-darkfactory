import { describe, expect, test } from "bun:test";
import { parseGitmodules, serializeGitmodules } from "../src/gitmodules";

describe("gitmodules", () => {
  test("parses submodule entries", () => {
    expect(
      parseGitmodules(`[submodule "SkyAgent"]
\tpath = plugins/SkyAgent
\turl = https://github.com/marius-patrik/SkyAgent.git
\tbranch = main
`),
    ).toEqual([
      {
        name: "SkyAgent",
        path: "plugins/SkyAgent",
        url: "https://github.com/marius-patrik/SkyAgent.git",
        branch: "main",
      },
    ]);
  });

  test("serializes stable entries", () => {
    expect(
      serializeGitmodules([
        {
          name: "DarkFactory",
          path: "plugins/DarkFactory",
          url: "https://github.com/marius-patrik/DarkFactory.git",
          branch: "main",
        },
      ]),
    ).toBe(`[submodule "DarkFactory"]
\tpath = plugins/DarkFactory
\turl = https://github.com/marius-patrik/DarkFactory.git
\tbranch = main
`);
  });
});


