# sdk

The core package everything is implemented through.

Protocol definitions, message and receipt types, client bindings, and the plugin contract. A pure library: no daemon, no state, no side effects. This is the only package other components may import — if two components must agree on something, the agreement lives here as a typed contract.
