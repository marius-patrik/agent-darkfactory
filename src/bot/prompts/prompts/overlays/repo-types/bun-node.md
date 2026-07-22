### Bun and Node repository overlay

- Treat the declared package manager, root manifest, lockfile, workspace graph,
  runtime version, and repository validation commands as one consistency boundary.
- Preserve package boundaries and generated-output policy; do not mix lockfile
  ownership or introduce a second install path.
- Run the declared root and affected-package gates and report exact results.
- Treat lifecycle hooks and dependency-controlled scripts as untrusted during a
  privileged review; execution belongs only in the isolated validation lane.
