# agent

A full agent implementation, used by the system for all agents.

An agent is a fully contained server that connects to the network: it authenticates to the mainframe, receives work, executes turns through the sdk, and emits receipts. Every agent in the system is this implementation with a different role, preset, and configuration.
