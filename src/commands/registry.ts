import type {
  AgentPackageDescriptorV2,
  PluginCommandHandler,
} from "../sdk/shared-ts/plugin-manifest";

export interface HostRpcCommandHandler {
  kind: "host-rpc";
  method: string;
}

export type CommandHandler = HostRpcCommandHandler | PluginCommandHandler;

export type CommandSource =
  | { kind: "builtin" }
  | { kind: "plugin"; pluginId: string };

export interface CommandDescriptor {
  id: string;
  name: string;
  aliases: readonly string[];
  description: string;
  recovery: boolean;
  source: CommandSource;
  handler: CommandHandler;
}

export interface PluginCommandRegistrationOptions {
  /**
   * Approval keys use `<publisher>/<plugin>:<alias>` so permission records
   * cannot accidentally approve the same top-level token for another plugin.
   */
  approvedTopLevelAliases?: Iterable<string>;
}

export interface CommandInvocation {
  command: string;
  args: string[];
}

const COMMAND_TOKEN = /^[a-z0-9][a-z0-9._/:-]{0,511}$/;

/**
 * Bare Andromeda is the TUI. Leading flags are therefore TUI flags, while an
 * explicit command consumes the first token. `--help` remains reachable
 * without initializing state, including when it is the only argument.
 */
export function selectCommandInvocation(
  argv: readonly string[],
): CommandInvocation {
  const [first, ...rest] = argv;
  if (first === undefined) return { command: "tui", args: [] };
  if (first === "--help") return { command: "help", args: rest };
  if (first.startsWith("--")) return { command: "tui", args: [...argv] };
  return { command: first, args: rest };
}

function host(
  id: string,
  name: string,
  description: string,
  recovery = false,
  aliases: readonly string[] = [],
): CommandDescriptor {
  return {
    id,
    name,
    aliases,
    description,
    recovery,
    source: { kind: "builtin" },
    handler: { kind: "host-rpc", method: id },
  };
}

export const RECOVERY_COMMAND_DESCRIPTORS = Object.freeze([
  host("builtin.help", "help", "Show embedded command help.", true),
  host("builtin.version", "version", "Show the Andromeda product version.", true),
  host("builtin.doctor", "doctor", "Inspect the core installation.", true),
  host(
    "builtin.plugins",
    "plugins",
    "Inspect or recover the canonical plugin installation.",
    true,
    ["plugin"],
  ),
] satisfies readonly CommandDescriptor[]);

const OPERATIONAL_COMMANDS = Object.freeze([
  host("builtin.run", "run", "Run an agent request."),
  host("builtin.route", "route", "Inspect or probe model routing."),
  host("builtin.tui", "tui", "Start the terminal user interface."),
  host("builtin.sessions", "sessions", "List or resume managed sessions."),
  host("builtin.list", "list", "List managed packages."),
  host("builtin.info", "info", "Inspect a managed package."),
  host("builtin.add", "add", "Add a managed package."),
  host("builtin.remove", "remove", "Remove a managed package."),
  host("builtin.sync", "sync", "Synchronize configured state."),
  host("builtin.state", "state", "Manage canonical state."),
  host("builtin.memory", "memory", "Manage canonical memory."),
  host("builtin.identity", "identity", "Manage agent identity."),
  host("builtin.cli", "cli", "Manage provider CLIs."),
  host("builtin.packages", "packages", "Manage registered packages."),
  host("builtin.env", "env", "Manage execution environments."),
  host("builtin.data", "data", "Manage data repositories."),
  host("builtin.harness", "harness", "Manage agent harnesses."),
  host("builtin.session", "session", "Run or inspect a session."),
  host("builtin.install", "install", "Install a capability."),
  host("builtin.installs", "installs", "List capability installations."),
  host("builtin.secrets", "secrets", "Manage secret references."),
  host("builtin.credits", "credits", "Manage the shared credit ledger."),
  host("builtin.os", "os", "Manage Andromeda runtime images."),
  host("builtin.runner", "runner", "Manage the background runner."),
] satisfies readonly CommandDescriptor[]);

export const BUILTIN_COMMAND_DESCRIPTORS = Object.freeze([
  ...RECOVERY_COMMAND_DESCRIPTORS,
  ...OPERATIONAL_COMMANDS,
] satisfies readonly CommandDescriptor[]);

function assertDescriptor(descriptor: CommandDescriptor): void {
  if (!COMMAND_TOKEN.test(descriptor.id)) {
    throw new Error(`invalid command descriptor id: ${descriptor.id}`);
  }
  for (const token of [descriptor.name, ...descriptor.aliases]) {
    if (!COMMAND_TOKEN.test(token)) {
      throw new Error(`invalid command token: ${token}`);
    }
  }
  if (!descriptor.description.trim()) {
    throw new Error(`command ${descriptor.id} requires a description`);
  }
  if (
    descriptor.source.kind === "plugin" &&
    descriptor.handler.kind === "host-rpc"
  ) {
    throw new Error(
      `plugin command ${descriptor.id} cannot use a host-rpc handler`,
    );
  }
}

export class CommandRegistry {
  readonly #byId = new Map<string, CommandDescriptor>();
  readonly #byToken = new Map<string, CommandDescriptor>();

  constructor(
    descriptors: readonly CommandDescriptor[] = BUILTIN_COMMAND_DESCRIPTORS,
  ) {
    this.register(descriptors);
  }

  resolve(token: string): CommandDescriptor | null {
    return this.#byToken.get(token) ?? null;
  }

  list(): CommandDescriptor[] {
    return [...this.#byId.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }

  registerPluginCommands(
    plugin: AgentPackageDescriptorV2,
    options: PluginCommandRegistrationOptions = {},
  ): CommandDescriptor[] {
    const approvals = new Set(options.approvedTopLevelAliases ?? []);
    const namespace = plugin.qualifiedId;
    const descriptors = plugin.contributions.commands.map((contribution) => {
      const aliases = contribution.aliases.map(
        (alias) => `${namespace}:${alias}`,
      );
      if (
        contribution.requestedTopLevelAlias &&
        approvals.has(
          `${plugin.qualifiedId}:${contribution.requestedTopLevelAlias}`,
        )
      ) {
        aliases.push(contribution.requestedTopLevelAlias);
      }
      return {
        id: `${plugin.qualifiedId}/${contribution.id}`,
        name: `${namespace}:${contribution.name}`,
        aliases,
        description: contribution.description,
        recovery: false,
        source: { kind: "plugin", pluginId: plugin.qualifiedId } as const,
        handler: contribution.handler,
      };
    });
    this.register(descriptors);
    return descriptors;
  }

  private register(descriptors: readonly CommandDescriptor[]): void {
    const pendingIds = new Set<string>();
    const pendingTokens = new Set<string>();
    for (const descriptor of descriptors) {
      assertDescriptor(descriptor);
      if (this.#byId.has(descriptor.id) || pendingIds.has(descriptor.id)) {
        throw new Error(`duplicate command descriptor id: ${descriptor.id}`);
      }
      pendingIds.add(descriptor.id);
      for (const token of [descriptor.name, ...descriptor.aliases]) {
        if (this.#byToken.has(token) || pendingTokens.has(token)) {
          const existing = this.#byToken.get(token);
          const protectedSuffix = existing?.recovery
            ? " (embedded recovery command)"
            : "";
          throw new Error(
            `command token collision: ${token}${protectedSuffix}`,
          );
        }
        pendingTokens.add(token);
      }
    }
    for (const descriptor of descriptors) {
      this.#byId.set(descriptor.id, descriptor);
      for (const token of [descriptor.name, ...descriptor.aliases]) {
        this.#byToken.set(token, descriptor);
      }
    }
  }
}

export function createBuiltinCommandRegistry(): CommandRegistry {
  return new CommandRegistry();
}
