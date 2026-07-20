# server

Deployment of the cluster system, per machine.

One server instance per machine that participates as a server. It hosts inference, runs agents, and exposes the system through the protocol package. Agent and manager behaviour is implemented here or in the sdk rather than in packages of their own. A full personal deployment spans multiple machines, each joined as either a client or a server.
