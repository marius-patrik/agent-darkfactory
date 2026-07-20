# app

The standalone desktop application.

A Tauri shell wrapping the `web` package. The desktop build adds packaging and native integration only; product behaviour stays in `web`.

Clients hold no business logic: anything a client needs must be reachable through the protocol. A machine in a personal deployment joins as either a client or a server, never both.
