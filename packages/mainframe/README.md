# mainframe

The backend that handles inference, runs agents, and runs the manager.

Owns the network with its protocols and connection lifecycle, an API for everything the system exposes, and a daemon. Embeds the manager rather than reimplementing it: the mainframe is the process, the manager is the capability.
