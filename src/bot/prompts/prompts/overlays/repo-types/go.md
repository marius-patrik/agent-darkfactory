### Go repository overlay

- Respect the root workspace and module graph as committed repository state.
- Keep module paths, replace directives, generated code, formatting, static checks,
  and tests consistent across affected modules.
- In a monorepo, resolve workspace modules from the repository tree; do not assume
  a former cross-repository workspace layout or copy sibling state into the run.
- Report module and package coverage for each changed surface.
