# Project

Agent OS is one personal-agent product. This `agents-manager` repository owns
the implementation; `agents` is the only operator/runtime CLI and
`/Users/user/.agents` is the personal installation's only state root.

`packages/core` contains the consolidated manager, contracts, harness, gateway,
inference, and bundled plugin domains. Other package directories and `data/`
are Git submodules. Their names identify packages, not alternate Agent OS
products or state authorities.

Historical product names, provider-home paths, launchers, and variables are
recovery evidence only. Do not add aliases, bridges, forwarding shims, or
fallback loaders.

Branch policy: active work uses a feature branch and a PR into `dev`.
