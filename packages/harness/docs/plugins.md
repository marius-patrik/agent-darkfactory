# Harness Capability Policy

User-installed skills, plugins, hooks, and templates live only in their
canonical paths under `AGENTS_HOME`. The runtime harness may consume a
capability selected by Agent OS, but it does not vendor, copy, or project that
capability into provider-specific or harness-specific state.

Package-owned capability sources stay with the package that implements them.
Examples and fixtures stay with the tests that exercise them. Canonical memory
records and generated startup views remain manager-owned; the harness must not
load provider-generated memory as an alternative authority.
