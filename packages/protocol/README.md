# protocol

The central protocol layer. Passive, not a process.

Covers every protocol and the orchestration built on them, and is the main wrapper layer: all calls go through it. It defines and carries the conversation between machines — it does not run as a separate active process, and nothing here requires a daemon of its own. Servers and clients both speak it; the server package hosts it, the clients consume it.

## MCP lives here, and this package is more than MCP

There is no separate `mcp` package. The Model Context Protocol surface belongs here because it is one dialect of the same conversation, not a side channel. This package owns:

- **The native protocol** between clients, servers, and agents in a deployment — including orchestration, routing, and receipts.
- **MCP in both directions**: exposing our capabilities to any MCP client, and consuming external MCP servers as capabilities.
- **The integration point for standard agent harnesses.** Third-party harnesses and agent runtimes attach here rather than reaching into the server or the sdk, so a foreign harness is a supported participant instead of a fork.
- **The behaviour integration point.** Roles, presets, tools, and policy are expressed as protocol-level contracts, so behaviour composes across native and foreign runtimes through one definition instead of being reimplemented per surface.

The rule that keeps it coherent: anything crossing a boundary — process, machine, or vendor — is defined here once, and every surface speaks it.
