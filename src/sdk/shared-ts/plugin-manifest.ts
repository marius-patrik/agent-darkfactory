import path from "node:path";
import { satisfies, valid, validRange } from "semver";
import parseSpdxExpression from "spdx-expression-parse";

export const AGENT_PACKAGE_SCHEMA_VERSION = 2 as const;

export const AGENT_PACKAGE_PERMISSION_KEYS = [
  "workspaces",
  "sessions",
  "memory",
  "models",
  "networkOrigins",
  "secrets",
  "clipboard",
  "notifications",
  "externalUrls",
] as const;

export type PackageKind =
  | "app"
  | "data"
  | "package"
  | "workspace"
  | "harness"
  | "cli"
  | "skill"
  | "plugin"
  | "hook"
  | "template";

export type ResourcePermission = "none" | "read" | "write";
export type ClipboardPermission = "none" | "read" | "write";

export interface DeclarativePluginRuntime {
  kind: "declarative";
}

export interface WasiPluginRuntime {
  kind: "wasi";
  module: string;
  sha256: string;
}

export type PluginRuntime = DeclarativePluginRuntime | WasiPluginRuntime;

export interface DeclarativeCommandHandler {
  kind: "declarative";
  action: string;
}

export interface WasiCommandHandler {
  kind: "wasi";
  export: string;
}

export type PluginCommandHandler =
  | DeclarativeCommandHandler
  | WasiCommandHandler;

export interface PluginCommandContribution {
  id: string;
  name: string;
  description: string;
  aliases: string[];
  requestedTopLevelAlias?: string;
  handler: PluginCommandHandler;
}

export interface DescriptorContribution {
  id: string;
  descriptor: string;
}

export interface AgentContributions {
  tools: DescriptorContribution[];
  skills: DescriptorContribution[];
  roles: DescriptorContribution[];
  hooks: DescriptorContribution[];
}

export interface TuiContributions {
  actions: DescriptorContribution[];
  panels: DescriptorContribution[];
}

export interface WebContributions {
  routes: DescriptorContribution[];
  panels: DescriptorContribution[];
  settings: DescriptorContribution[];
}

export interface ServerContributions {
  routes: DescriptorContribution[];
  jobs: DescriptorContribution[];
  events: DescriptorContribution[];
}

export interface PluginContributions {
  agent: AgentContributions;
  commands: PluginCommandContribution[];
  tui: TuiContributions;
  web: WebContributions;
  server: ServerContributions;
  models: DescriptorContribution[];
}

export interface PluginPermissions {
  workspaces: ResourcePermission;
  sessions: ResourcePermission;
  memory: ResourcePermission;
  models: string[];
  networkOrigins: string[];
  secrets: string[];
  clipboard: ClipboardPermission;
  notifications: boolean;
  externalUrls: string[];
}

export interface AgentPackageCompatibility {
  andromeda: string;
  api: "2";
}

export interface AgentPackageDescriptorV2 {
  schemaVersion: typeof AGENT_PACKAGE_SCHEMA_VERSION;
  publisher: string;
  id: string;
  qualifiedId: string;
  name: string;
  kind: PackageKind;
  version: string;
  license: string;
  compatibility: AgentPackageCompatibility;
  description?: string;
  runtime: PluginRuntime;
  contributions: PluginContributions;
  permissions: PluginPermissions;
  artifactDigest: `sha256:${string}` | null;
  entry?: undefined;
  workingDirectory?: undefined;
  requires?: undefined;
  dataRepo?: undefined;
  provides: string[];
}

export interface AgentPackageParseOptions {
  source?: string;
  artifactSha256?: string;
}

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SAFE_ACTION = /^[a-z0-9][a-z0-9._:/-]{0,191}$/;
const SAFE_COMMAND = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SAFE_EXPORT = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const PORTABLE_PATH_SEGMENT =
  /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9_-])?$/;
const WINDOWS_RESERVED_PATH_SEGMENT =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/;
const MAXIMUM_PORTABLE_PATH_LENGTH = 240;
const TOP_LEVEL_FIELDS = new Set([
  "schemaVersion",
  "publisher",
  "id",
  "name",
  "kind",
  "version",
  "license",
  "compatibility",
  "description",
  "runtime",
  "contributions",
  "permissions",
]);
const PACKAGE_KINDS = new Set<PackageKind>([
  "app",
  "data",
  "package",
  "workspace",
  "harness",
  "cli",
  "skill",
  "plugin",
  "hook",
  "template",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function context(options: AgentPackageParseOptions): string {
  return options.source?.trim() || "agent.package.json";
}

function fail(
  options: AgentPackageParseOptions,
  message: string,
): never {
  throw new Error(`${context(options)}: ${message}`);
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  field: string,
  options: AgentPackageParseOptions,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(options, `${field} contains unsupported field ${key}`);
  }
}

function requiredString(
  value: unknown,
  field: string,
  options: AgentPackageParseOptions,
): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value !== value.trim() ||
    value.includes("\0")
  ) {
    fail(options, `${field} must be a trimmed non-empty string`);
  }
  return value;
}

function optionalString(
  value: unknown,
  field: string,
  options: AgentPackageParseOptions,
): string | undefined {
  return value === undefined
    ? undefined
    : requiredString(value, field, options);
}

function safeId(
  value: unknown,
  field: string,
  options: AgentPackageParseOptions,
): string {
  const parsed = requiredString(value, field, options);
  if (!SAFE_ID.test(parsed)) {
    fail(options, `${field} must use lowercase package-id syntax`);
  }
  return parsed;
}

function safeCommand(
  value: unknown,
  field: string,
  options: AgentPackageParseOptions,
): string {
  const parsed = requiredString(value, field, options);
  if (!SAFE_COMMAND.test(parsed)) {
    fail(options, `${field} must use lowercase command syntax`);
  }
  return parsed;
}

function safeRelativePath(
  value: unknown,
  field: string,
  options: AgentPackageParseOptions,
): string {
  const parsed = requiredString(value, field, options);
  const segments = parsed.split(/[\\/]/);
  if (
    parsed.length > MAXIMUM_PORTABLE_PATH_LENGTH ||
    path.isAbsolute(parsed) ||
    segments.includes("..") ||
    segments.includes(".") ||
    segments.some((segment) => !segment) ||
    parsed.includes("\\") ||
    segments.some(
      (segment) =>
        !PORTABLE_PATH_SEGMENT.test(segment) ||
        WINDOWS_RESERVED_PATH_SEGMENT.test(segment),
    )
  ) {
    fail(
      options,
      `${field} must be a normalized portable lowercase ASCII relative path`,
    );
  }
  return parsed;
}

function sortedUniqueStrings(
  value: unknown,
  field: string,
  options: AgentPackageParseOptions,
  validate: (item: string) => boolean = (item) => Boolean(item),
): string[] {
  if (!Array.isArray(value)) fail(options, `${field} must be an array`);
  const seen = new Set<string>();
  for (const item of value) {
    if (
      typeof item !== "string" ||
      !item.trim() ||
      item !== item.trim() ||
      item.includes("\0") ||
      !validate(item) ||
      seen.has(item)
    ) {
      fail(options, `${field} contains an invalid or duplicate value`);
    }
    seen.add(item);
  }
  return [...seen].sort();
}

function normalizedOrigin(
  value: string,
  field: string,
  options: AgentPackageParseOptions,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail(options, `${field} contains an invalid URL origin`);
  }
  const localHttp =
    url.protocol === "http:" &&
    (url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "::1");
  if (url.protocol !== "https:" && !localHttp) {
    fail(options, `${field} permits only HTTPS origins or loopback HTTP`);
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    value !== url.origin
  ) {
    fail(options, `${field} entries must be normalized origins without credentials or paths`);
  }
  return url.origin;
}

function parseRuntime(
  value: unknown,
  options: AgentPackageParseOptions,
): PluginRuntime {
  if (!isRecord(value)) fail(options, "runtime must be an object");
  if (value.kind === "declarative") {
    exactKeys(value, new Set(["kind"]), "runtime", options);
    return { kind: "declarative" };
  }
  if (value.kind === "wasi") {
    exactKeys(value, new Set(["kind", "module", "sha256"]), "runtime", options);
    const module = safeRelativePath(value.module, "runtime.module", options);
    if (!module.endsWith(".wasm")) {
      fail(options, "runtime.module must name a .wasm payload");
    }
    const sha256 = requiredString(value.sha256, "runtime.sha256", options);
    if (!SHA256.test(sha256)) {
      fail(options, "runtime.sha256 must be a lowercase SHA-256 digest");
    }
    return { kind: "wasi", module, sha256 };
  }
  fail(
    options,
    "runtime.kind must be declarative or wasi; native executable and script runtimes are unsupported",
  );
}

function parseDescriptorList(
  value: unknown,
  field: string,
  options: AgentPackageParseOptions,
): DescriptorContribution[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(options, `${field} must be an array`);
  const ids = new Set<string>();
  return value
    .map((item, index) => {
      if (!isRecord(item)) fail(options, `${field}[${index}] must be an object`);
      exactKeys(
        item,
        new Set(["id", "descriptor"]),
        `${field}[${index}]`,
        options,
      );
      const id = safeId(item.id, `${field}[${index}].id`, options);
      if (ids.has(id)) fail(options, `${field} contains duplicate id ${id}`);
      ids.add(id);
      const descriptor = safeRelativePath(
        item.descriptor,
        `${field}[${index}].descriptor`,
        options,
      );
      if (!descriptor.endsWith(".json")) {
        fail(options, `${field}[${index}].descriptor must name a JSON descriptor`);
      }
      return { id, descriptor };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function parseContributionGroup<T extends string>(
  value: unknown,
  field: string,
  keys: readonly T[],
  options: AgentPackageParseOptions,
): Record<T, DescriptorContribution[]> {
  if (value === undefined) {
    return Object.fromEntries(keys.map((key) => [key, []])) as unknown as Record<
      T,
      DescriptorContribution[]
    >;
  }
  if (!isRecord(value)) fail(options, `${field} must be an object`);
  exactKeys(value, new Set(keys), field, options);
  return Object.fromEntries(
    keys.map((key) => [
      key,
      parseDescriptorList(value[key], `${field}.${key}`, options),
    ]),
  ) as Record<T, DescriptorContribution[]>;
}

function parseCommandHandler(
  value: unknown,
  runtime: PluginRuntime,
  field: string,
  options: AgentPackageParseOptions,
): PluginCommandHandler {
  if (!isRecord(value)) fail(options, `${field} must be an object`);
  if (value.kind !== runtime.kind) {
    fail(options, `${field}.kind must match runtime.kind ${runtime.kind}`);
  }
  if (value.kind === "declarative") {
    exactKeys(value, new Set(["kind", "action"]), field, options);
    const action = requiredString(value.action, `${field}.action`, options);
    if (!SAFE_ACTION.test(action)) {
      fail(options, `${field}.action is invalid`);
    }
    return { kind: "declarative", action };
  }
  if (value.kind === "wasi") {
    exactKeys(value, new Set(["kind", "export"]), field, options);
    const exportName = requiredString(value.export, `${field}.export`, options);
    if (!SAFE_EXPORT.test(exportName)) {
      fail(options, `${field}.export is invalid`);
    }
    return { kind: "wasi", export: exportName };
  }
  fail(
    options,
    `${field}.kind must be declarative or wasi; native execution is unsupported`,
  );
}

function parseCommands(
  value: unknown,
  runtime: PluginRuntime,
  options: AgentPackageParseOptions,
): PluginCommandContribution[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(options, "contributions.commands must be an array");
  const ids = new Set<string>();
  const names = new Set<string>();
  return value
    .map((item, index) => {
      const field = `contributions.commands[${index}]`;
      if (!isRecord(item)) fail(options, `${field} must be an object`);
      exactKeys(
        item,
        new Set([
          "id",
          "name",
          "description",
          "aliases",
          "requestedTopLevelAlias",
          "handler",
        ]),
        field,
        options,
      );
      const id = safeId(item.id, `${field}.id`, options);
      if (ids.has(id)) fail(options, `contributions.commands contains duplicate id ${id}`);
      ids.add(id);
      const name = safeCommand(item.name, `${field}.name`, options);
      const aliases =
        item.aliases === undefined
          ? []
          : sortedUniqueStrings(
              item.aliases,
              `${field}.aliases`,
              options,
              (alias) => SAFE_COMMAND.test(alias),
            );
      for (const token of [name, ...aliases]) {
        if (names.has(token)) {
          fail(options, `contributions.commands contains duplicate command token ${token}`);
        }
        names.add(token);
      }
      const requestedTopLevelAlias =
        item.requestedTopLevelAlias === undefined
          ? undefined
          : safeCommand(
              item.requestedTopLevelAlias,
              `${field}.requestedTopLevelAlias`,
              options,
            );
      return {
        id,
        name,
        description: requiredString(
          item.description,
          `${field}.description`,
          options,
        ),
        aliases,
        requestedTopLevelAlias,
        handler: parseCommandHandler(
          item.handler,
          runtime,
          `${field}.handler`,
          options,
        ),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function parseContributions(
  value: unknown,
  runtime: PluginRuntime,
  options: AgentPackageParseOptions,
): PluginContributions {
  if (!isRecord(value)) fail(options, "contributions must be an object");
  exactKeys(
    value,
    new Set(["agent", "commands", "tui", "web", "server", "models"]),
    "contributions",
    options,
  );
  const agent = parseContributionGroup(
    value.agent,
    "contributions.agent",
    ["tools", "skills", "roles", "hooks"] as const,
    options,
  );
  const tui = parseContributionGroup(
    value.tui,
    "contributions.tui",
    ["actions", "panels"] as const,
    options,
  );
  const web = parseContributionGroup(
    value.web,
    "contributions.web",
    ["routes", "panels", "settings"] as const,
    options,
  );
  const server = parseContributionGroup(
    value.server,
    "contributions.server",
    ["routes", "jobs", "events"] as const,
    options,
  );
  const models = parseDescriptorList(
    value.models,
    "contributions.models",
    options,
  );
  const commands = parseCommands(value.commands, runtime, options);
  const count =
    Object.values(agent).flat().length +
    commands.length +
    Object.values(tui).flat().length +
    Object.values(web).flat().length +
    Object.values(server).flat().length +
    models.length;
  if (count === 0) {
    fail(options, "contributions must declare at least one public contribution");
  }
  return { agent, commands, tui, web, server, models };
}

function parsePermissionLevel(
  value: unknown,
  field: string,
  options: AgentPackageParseOptions,
): ResourcePermission {
  if (value !== "none" && value !== "read" && value !== "write") {
    fail(options, `${field} must be none, read, or write`);
  }
  return value;
}

function parsePermissions(
  value: unknown,
  options: AgentPackageParseOptions,
): PluginPermissions {
  if (!isRecord(value)) fail(options, "permissions must be an object");
  exactKeys(
    value,
    new Set(AGENT_PACKAGE_PERMISSION_KEYS),
    "permissions",
    options,
  );
  for (const key of AGENT_PACKAGE_PERMISSION_KEYS) {
    if (!(key in value)) fail(options, `permissions.${key} is required`);
  }
  const networkOrigins = sortedUniqueStrings(
    value.networkOrigins,
    "permissions.networkOrigins",
    options,
  ).map((origin) =>
    normalizedOrigin(origin, "permissions.networkOrigins", options),
  );
  const externalUrls = sortedUniqueStrings(
    value.externalUrls,
    "permissions.externalUrls",
    options,
  ).map((origin) =>
    normalizedOrigin(origin, "permissions.externalUrls", options),
  );
  if (typeof value.notifications !== "boolean") {
    fail(options, "permissions.notifications must be a boolean");
  }
  return {
    workspaces: parsePermissionLevel(
      value.workspaces,
      "permissions.workspaces",
      options,
    ),
    sessions: parsePermissionLevel(
      value.sessions,
      "permissions.sessions",
      options,
    ),
    memory: parsePermissionLevel(
      value.memory,
      "permissions.memory",
      options,
    ),
    models: sortedUniqueStrings(
      value.models,
      "permissions.models",
      options,
      (item) => SAFE_ACTION.test(item),
    ),
    networkOrigins,
    secrets: sortedUniqueStrings(
      value.secrets,
      "permissions.secrets",
      options,
      (item) => SAFE_ACTION.test(item),
    ),
    clipboard: parsePermissionLevel(
      value.clipboard,
      "permissions.clipboard",
      options,
    ),
    notifications: value.notifications,
    externalUrls,
  };
}

function parseCompatibility(
  value: unknown,
  options: AgentPackageParseOptions,
): AgentPackageCompatibility {
  if (!isRecord(value)) fail(options, "compatibility must be an object");
  exactKeys(value, new Set(["andromeda", "api"]), "compatibility", options);
  const andromeda = requiredString(
    value.andromeda,
    "compatibility.andromeda",
    options,
  );
  if (
    andromeda.length > 160 ||
    validRange(andromeda, { loose: false }) === null
  ) {
    fail(
      options,
      "compatibility.andromeda must be a valid semantic-version range",
    );
  }
  if (value.api !== "2") fail(options, "compatibility.api must be 2");
  return { andromeda, api: "2" };
}

export function assertAgentPackageCompatibilityV2(
  manifest: AgentPackageDescriptorV2,
  andromedaVersion: string,
  options: AgentPackageParseOptions = {},
): void {
  const normalizedVersion = valid(andromedaVersion, { loose: false });
  if (
    normalizedVersion === null ||
    andromedaVersion !== andromedaVersion.trim() ||
    !/^[0-9]/.test(andromedaVersion)
  ) {
    fail(options, "authoritative Andromeda product version is not semantic versioning");
  }
  if (
    !satisfies(normalizedVersion, manifest.compatibility.andromeda, {
      loose: false,
    })
  ) {
    fail(
      options,
      `requires Andromeda ${manifest.compatibility.andromeda}, current version is ${normalizedVersion}`,
    );
  }
}

function parseLicense(
  value: unknown,
  options: AgentPackageParseOptions,
): string {
  const license = requiredString(value, "license", options);
  if (license.length > 160) {
    fail(options, "license must be an SPDX license expression");
  }
  try {
    parseSpdxExpression(license);
  } catch {
    fail(options, "license must be an SPDX license expression");
  }
  return license;
}

function artifactDigest(
  options: AgentPackageParseOptions,
): `sha256:${string}` | null {
  if (options.artifactSha256 === undefined) return null;
  if (!SHA256.test(options.artifactSha256)) {
    fail(options, "observed artifact digest must be a lowercase SHA-256 digest");
  }
  return `sha256:${options.artifactSha256}`;
}

function contributionLabels(contributions: PluginContributions): string[] {
  const labels = [
    ...Object.entries(contributions.agent).flatMap(([kind, items]: [string, DescriptorContribution[]]) =>
      items.map((item) => `agent.${kind}:${item.id}`),
    ),
    ...contributions.commands.map((item) => `command:${item.id}`),
    ...Object.entries(contributions.tui).flatMap(([kind, items]: [string, DescriptorContribution[]]) =>
      items.map((item) => `tui.${kind}:${item.id}`),
    ),
    ...Object.entries(contributions.web).flatMap(([kind, items]: [string, DescriptorContribution[]]) =>
      items.map((item) => `web.${kind}:${item.id}`),
    ),
    ...Object.entries(contributions.server).flatMap(([kind, items]: [string, DescriptorContribution[]]) =>
      items.map((item) => `server.${kind}:${item.id}`),
    ),
    ...contributions.models.map((item) => `model:${item.id}`),
  ];
  return labels.sort();
}

export function parseAgentPackageManifestV2(
  value: unknown,
  options: AgentPackageParseOptions = {},
): AgentPackageDescriptorV2 {
  if (!isRecord(value)) fail(options, "manifest must be an object");
  exactKeys(value, TOP_LEVEL_FIELDS, "manifest", options);
  if (value.schemaVersion !== AGENT_PACKAGE_SCHEMA_VERSION) {
    fail(options, `schemaVersion must be ${AGENT_PACKAGE_SCHEMA_VERSION}`);
  }
  const publisher = safeId(value.publisher, "publisher", options);
  const id = safeId(value.id, "id", options);
  const version = requiredString(value.version, "version", options);
  if (
    valid(version, { loose: false }) === null ||
    !/^[0-9]/.test(version)
  ) {
    fail(options, "version must be semantic versioning");
  }
  const license = parseLicense(value.license, options);
  const kind = requiredString(value.kind, "kind", options);
  if (!PACKAGE_KINDS.has(kind as PackageKind)) {
    fail(options, `unsupported package kind ${kind}`);
  }
  const runtime = parseRuntime(value.runtime, options);
  const contributions = parseContributions(
    value.contributions,
    runtime,
    options,
  );
  const descriptor: AgentPackageDescriptorV2 = {
    schemaVersion: AGENT_PACKAGE_SCHEMA_VERSION,
    publisher,
    id,
    qualifiedId: `${publisher}/${id}`,
    name: optionalString(value.name, "name", options) ?? id,
    kind: kind as PackageKind,
    version,
    license,
    compatibility: parseCompatibility(value.compatibility, options),
    description: optionalString(value.description, "description", options),
    runtime,
    contributions,
    permissions: parsePermissions(value.permissions, options),
    artifactDigest: artifactDigest(options),
    provides: contributionLabels(contributions),
  };
  return descriptor;
}
