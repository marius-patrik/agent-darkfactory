### Python and uv repository overlay

- Treat the project metadata, uv lock, supported interpreter range, package layout,
  and declared validation commands as one reproducible environment contract.
- Use the uv command-line interface when the repository declares uv; do not invoke
  it as a Python module or create an untracked dependency path.
- Preserve lock consistency, isolated environments, type and lint gates, and the
  repository's test selection.
- Never admit a machine-local environment, cache, credential, or generated secret.
