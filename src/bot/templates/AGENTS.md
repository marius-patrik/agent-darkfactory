# Agent OS repository guidance

Load repository-local guidance from `.agents/.project/` when it exists.

Shared identity, memory, roles, skills, provider state, and sessions belong only
under `$AGENTS_HOME`. Generated repositories must not copy a global agent floor.
