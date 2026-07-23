import { describe, expect, test } from "bun:test";
import {
  BUILTIN_COMMAND_DESCRIPTORS,
  CommandRegistry,
  RECOVERY_COMMAND_DESCRIPTORS,
  selectCommandInvocation,
} from "../../commands/registry";
import { parseAgentPackageManifestV2 } from "../../sdk/shared-ts/plugin-manifest";

function plugin(
  requestedTopLevelAlias = "memory-query",
  publisher = "acme",
  id = "memory",
) {
  return parseAgentPackageManifestV2({
    schemaVersion: 2,
    publisher,
    id,
    name: "Memory",
    kind: "plugin",
    version: "1.0.0",
    license: "Apache-2.0",
    compatibility: { andromeda: ">=1.0.0 <2.0.0", api: "2" },
    runtime: { kind: "declarative" },
    contributions: {
      commands: [
        {
          id: "query",
          name: "query",
          description: "Query memory.",
          aliases: ["find"],
          requestedTopLevelAlias,
          handler: { kind: "declarative", action: "memory.query" },
        },
      ],
    },
    permissions: {
      workspaces: "none",
      sessions: "read",
      memory: "read",
      models: [],
      networkOrigins: [],
      secrets: [],
      clipboard: "none",
      notifications: false,
      externalUrls: [],
    },
  });
}

describe("command contribution registry", () => {
  test("routes bare and flag-only invocation to the TUI", () => {
    expect(selectCommandInvocation([])).toEqual({
      command: "tui",
      args: [],
    });
    expect(
      selectCommandInvocation(["--provider", "local", "--model", "glm"]),
    ).toEqual({
      command: "tui",
      args: ["--provider", "local", "--model", "glm"],
    });
    expect(selectCommandInvocation(["--help"])).toEqual({
      command: "help",
      args: [],
    });
    expect(selectCommandInvocation(["doctor", "--json"])).toEqual({
      command: "doctor",
      args: ["--json"],
    });
  });

  test("keeps embedded recovery descriptors independent of plugin state", () => {
    const registry = new CommandRegistry();
    expect(RECOVERY_COMMAND_DESCRIPTORS.map((item) => item.name)).toEqual([
      "help",
      "version",
      "doctor",
      "plugins",
    ]);
    for (const descriptor of BUILTIN_COMMAND_DESCRIPTORS) {
      expect(registry.resolve(descriptor.name)?.id).toBe(descriptor.id);
    }
    expect(registry.resolve("plugin")?.id).toBe("builtin.plugins");
  });

  test("namespaces plugin commands and grants top-level aliases explicitly", () => {
    const unapproved = new CommandRegistry();
    unapproved.registerPluginCommands(plugin());
    expect(unapproved.resolve("acme/memory:query")?.source).toEqual({
      kind: "plugin",
      pluginId: "acme/memory",
    });
    expect(unapproved.resolve("acme/memory:find")?.id).toBe(
      "acme/memory/query",
    );
    expect(unapproved.resolve("memory-query")).toBeNull();

    const approved = new CommandRegistry();
    approved.registerPluginCommands(plugin(), {
      approvedTopLevelAliases: ["acme/memory:memory-query"],
    });
    expect(approved.resolve("memory-query")?.id).toBe("acme/memory/query");
  });

  test("preserves schema-valid underscores in command namespaces", () => {
    const registry = new CommandRegistry();
    registry.registerPluginCommands(
      plugin("memory-query", "acme_co", "memory_tools"),
    );
    expect(registry.resolve("acme_co/memory_tools:query")?.id).toBe(
      "acme_co/memory_tools/query",
    );
  });

  test("does not flatten distinct publisher/id identities into one namespace", () => {
    const registry = new CommandRegistry();
    registry.registerPluginCommands(plugin("first", "a.b", "c"));
    registry.registerPluginCommands(plugin("second", "a", "b.c"));
    expect(registry.resolve("a.b/c:query")?.source).toEqual({
      kind: "plugin",
      pluginId: "a.b/c",
    });
    expect(registry.resolve("a/b.c:query")?.source).toEqual({
      kind: "plugin",
      pluginId: "a/b.c",
    });
  });

  test("rejects collisions atomically and cannot shadow recovery commands", () => {
    const registry = new CommandRegistry();
    expect(() =>
      registry.registerPluginCommands(plugin("help"), {
        approvedTopLevelAliases: ["acme/memory:help"],
      }),
    ).toThrow("command token collision: help (embedded recovery command)");

    expect(registry.resolve("help")?.id).toBe("builtin.help");
    expect(registry.resolve("acme/memory:query")).toBeNull();
  });
});
