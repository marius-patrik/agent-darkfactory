# clients

Every client that connects to a server.

Clients hold no business logic: anything a client needs must be reachable through the protocol. A machine in a personal deployment joins as either a client or a server, never both.

- `web` - the web application.
- `app` - the standalone desktop application, a Tauri wrapper around `web`.
- `cli` - the terminal client.
