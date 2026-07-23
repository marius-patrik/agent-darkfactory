import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import path from "node:path";
import {
  parseAgentPackageManifestV2,
  type AgentPackageParseOptions,
} from "../../sdk/shared-ts/plugin-manifest";

function validManifest() {
  return {
    schemaVersion: 2,
    publisher: "andromeda-labs",
    id: "memory-tools",
    name: "Memory Tools",
    kind: "plugin",
    version: "1.2.3",
    license: "Apache-2.0",
    compatibility: {
      andromeda: ">=1.0.0 <2.0.0",
      api: "2",
    },
    description: "Cross-surface memory capabilities.",
    runtime: {
      kind: "declarative",
    },
    contributions: {
      agent: {
        tools: [
          {
            id: "query",
            descriptor: "descriptors/agent/query.json",
          },
        ],
        skills: [],
        roles: [],
        hooks: [],
      },
      commands: [
        {
          id: "query",
          name: "query",
          description: "Query canonical memory.",
          aliases: ["find"],
          requestedTopLevelAlias: "memory-query",
          handler: {
            kind: "declarative",
            action: "memory.query",
          },
        },
      ],
      tui: {
        actions: [],
        panels: [
          {
            id: "memory",
            descriptor: "descriptors/tui/memory.json",
          },
        ],
      },
      web: {
        routes: [
          {
            id: "memory",
            descriptor: "descriptors/web/memory-route.json",
          },
        ],
        panels: [],
        settings: [],
      },
      server: {
        routes: [
          {
            id: "memory-query",
            descriptor: "descriptors/server/query-route.json",
          },
        ],
        jobs: [],
        events: [],
      },
      models: [
        {
          id: "embedding",
          descriptor: "descriptors/models/embedding.json",
        },
      ],
    },
    permissions: {
      workspaces: "read",
      sessions: "read",
      memory: "write",
      models: ["local.embedding"],
      networkOrigins: ["https://memory.example.test"],
      secrets: [],
      clipboard: "none",
      notifications: false,
      externalUrls: ["http://localhost:4567"],
    },
  };
}

function parse(
  manifest: ReturnType<typeof validManifest>,
  options: AgentPackageParseOptions = {},
) {
  return parseAgentPackageManifestV2(manifest, {
    source: "fixture/agent.package.json",
    ...options,
  });
}

async function compilePublishedSchema() {
  const schema = await Bun.file(
    path.resolve(import.meta.dir, "..", "agent-package.schema.json"),
  ).json();
  return new Ajv2020({ allErrors: true, strict: true }).compile(schema);
}

describe("agent.package.json schema v2", () => {
  test("publishes the strict machine-readable schema", async () => {
    const schema = (await Bun.file(
      path.resolve(import.meta.dir, "..", "agent-package.schema.json"),
    ).json()) as {
      additionalProperties?: unknown;
      required?: unknown[];
      properties?: {
        runtime?: { oneOf?: Array<{ properties?: { kind?: { const?: string } } }> };
      };
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toContain("permissions");
    expect(
      schema.properties?.runtime?.oneOf?.map(
        (entry) => entry.properties?.kind?.const,
      ),
    ).toEqual(["declarative", "wasi"]);
  });

  test("normalizes one manifest across every public surface", () => {
    const descriptor = parse(validManifest(), {
      artifactSha256: "a".repeat(64),
    });

    expect(descriptor.qualifiedId).toBe("andromeda-labs/memory-tools");
    expect(descriptor.artifactDigest).toBe(`sha256:${"a".repeat(64)}`);
    expect(descriptor.contributions.agent.tools[0].id).toBe("query");
    expect(descriptor.contributions.commands[0].handler).toEqual({
      kind: "declarative",
      action: "memory.query",
    });
    expect(descriptor.contributions.tui.panels[0].id).toBe("memory");
    expect(descriptor.contributions.web.routes[0].id).toBe("memory");
    expect(descriptor.contributions.server.routes[0].id).toBe("memory-query");
    expect(descriptor.contributions.models[0].id).toBe("embedding");
    expect(descriptor.permissions.externalUrls).toEqual([
      "http://localhost:4567",
    ]);
    expect(descriptor.provides).toContain("command:query");
  });

  test("rejects malformed and drifting payload fields at the boundary", () => {
    const manifest = validManifest() as ReturnType<typeof validManifest> & {
      executable?: string;
    };
    manifest.executable = "node plugin.js";
    expect(() => parse(manifest)).toThrow(
      "manifest contains unsupported field executable",
    );

    const missingPermission = validManifest();
    delete (missingPermission.permissions as Partial<
      typeof missingPermission.permissions
    >).sessions;
    expect(() => parse(missingPermission)).toThrow(
      "permissions.sessions is required",
    );
  });

  test("rejects native runtime requests and handler/runtime drift", () => {
    const native = validManifest();
    (native.runtime as { kind: string }).kind = "native";
    expect(() => parse(native)).toThrow(
      "native executable and script runtimes are unsupported",
    );

    const mismatch = validManifest();
    (mismatch.contributions.commands[0] as any).handler = {
      kind: "wasi",
      export: "run_query",
    };
    expect(() => parse(mismatch)).toThrow(
      "handler.kind must match runtime.kind declarative",
    );
  });

  test("rejects prose licenses and fake Andromeda version ranges", () => {
    const proseLicense = validManifest();
    proseLicense.license = "use this however you want";
    expect(() => parse(proseLicense)).toThrow(
      "license must be an SPDX license expression",
    );

    const fakeRange = validManifest();
    fakeRange.compatibility.andromeda = "future release";
    expect(() => parse(fakeRange)).toThrow(
      "compatibility.andromeda must be a valid semantic-version range",
    );

    const compound = validManifest();
    compound.license = "(Apache-2.0 OR MIT) AND BSD-3-Clause";
    compound.compatibility.andromeda = "^1.2.3 || >=2.0.0 <3.0.0";
    expect(parse(compound).license).toBe(
      "(Apache-2.0 OR MIT) AND BSD-3-Clause",
    );
  });

  test("keeps published schema aligned for empty contributions and runtime handlers", async () => {
    const validate = await compilePublishedSchema();
    expect(validate(validManifest())).toBe(true);

    const empty = validManifest();
    (empty as any).contributions = { commands: [] };
    expect(validate(empty)).toBe(false);
    expect(() => parse(empty)).toThrow(
      "contributions must declare at least one public contribution",
    );

    const mismatch = validManifest();
    (mismatch.contributions.commands[0] as any).handler = {
      kind: "wasi",
      export: "run_query",
    };
    expect(validate(mismatch)).toBe(false);
    expect(() => parse(mismatch)).toThrow(
      "handler.kind must match runtime.kind declarative",
    );
  });

  test("requires digest-pinned, path-contained WASI modules", () => {
    const manifest = validManifest();
    (manifest as any).runtime = {
      kind: "wasi",
      module: "runtime/plugin.wasm",
      sha256: "b".repeat(64),
    };
    (manifest.contributions.commands[0] as any).handler = {
      kind: "wasi",
      export: "run_query",
    };
    expect(parse(manifest).runtime).toEqual({
      kind: "wasi",
      module: "runtime/plugin.wasm",
      sha256: "b".repeat(64),
    });

    (manifest.runtime as any).module = "../plugin.wasm";
    expect(() => parse(manifest)).toThrow(
      "runtime.module must be a normalized safe relative path",
    );
  });

  test("rejects unsafe origins and malformed observed artifact digests", () => {
    const manifest = validManifest();
    manifest.permissions.networkOrigins = [
      "https://user:password@example.test/private",
    ];
    expect(() => parse(manifest)).toThrow(
      "entries must be normalized origins without credentials or paths",
    );
    expect(() =>
      parse(validManifest(), { artifactSha256: "not-a-digest" }),
    ).toThrow("observed artifact digest must be a lowercase SHA-256 digest");
  });
});
