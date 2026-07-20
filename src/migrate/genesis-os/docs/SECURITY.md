# Security Model

## 1. Threat model

Genesis executes model-selected actions and can optionally execute generated code. Treat the model, observations, imported histories, websites, tool output, and teacher output as potentially adversarial.

The repository provides application-layer controls. It is not a complete hardened sandbox.

## 2. Default posture

By default:

- generated Python tools are denied;
- arbitrary process execution is denied;
- network tools are denied;
- API authentication is optional but strongly recommended;
- personal secret patterns are redacted and quarantined;
- canonical Wake weights are read-only at the model API level;
- release promotion verifies artifact hashes;
- exact events cannot be updated or deleted through SQLite.

## 3. Prompt injection persistence

A malicious observation can attempt to make the model store or later train on an instruction. The design limits, but does not eliminate, persistence:

- all observations are labeled by actor/source;
- failed actions are not positive-imitation examples;
- Sleep produces a candidate instead of editing production weights;
- foundation replay and held-out gates can detect regressions;
- exact source events remain inspectable;
- rejected candidates do not advance the cursor.

A production Sleep compiler should add explicit trust labels, contradiction detection, adversarial-content classifiers, and source-specific consolidation policies.

## 4. Personal data

Do not place private data in a public repository or shared workspace. Raw files are content-addressed but not encrypted by the current artifact store. Use full-disk encryption or replace `ArtifactStore` with an encrypted backend before loading sensitive archives.

Never train credentials, private keys, recovery codes, authentication cookies, or encryption keys into weights. The regex quarantine is a first pass, not a complete secret scanner.

## 5. Tool capabilities

Capabilities are checked before every invocation. Workflow capabilities are the union of nested tools. Do not mark a high-impact operation as a harmless capability to make a policy check pass.

Network tools should use destination allowlists, request/response size limits, TLS validation, and scoped service credentials. Process tools should run under a dedicated unprivileged account inside a container or VM.

## 6. Generated Python

The AST validator and subprocess limits prevent common accidental damage. They do not defend against all Python interpreter exploits, dependency exploits, covert channels, resource attacks, or kernel vulnerabilities.

For generated code:

- run a separate container/VM per tool or task;
- mount only a disposable workspace;
- use a read-only root filesystem;
- disable or allowlist network access;
- apply CPU, memory, process, file, and wall-clock limits;
- use seccomp/AppArmor/SELinux or equivalent;
- discard the environment after execution;
- promote artifacts by explicit hash.

## 7. Training worker separation

Recommended deployment:

```text
Wake service
  read-only release mount
  ledger append access
  restricted tool worker access

Sleep worker
  read parent release
  write candidate directory
  read training event ranges
  no production service credentials

Promotion controller
  verify evaluation artifacts and hashes
  atomically update current.json
```

Do not give the acting organism write access to the held-out evaluation suite or promotion controller credentials.

## 8. API

Set `GENESIS_API_TOKEN`. Bind to loopback unless a reverse proxy supplies TLS, authentication, rate limiting, request limits, and audit logs. WebSocket authentication uses the query token in the current SDK; avoid logging full WebSocket URLs.

CORS is disabled unless `GENESIS_CORS_ORIGINS` is set.

## 9. Ledger limitations

The hash chain detects content mutation inside the ledger when verified. An attacker with filesystem/database control can replace the entire database and related trust anchors. For stronger tamper evidence, periodically anchor the latest event hash in an external append-only system or signed transparency log.

## 10. Reporting

Security-sensitive deployments should fork privately until a disclosure process and contact are defined. Include the source commit, configuration, tool manifest, event range, and reproduction steps in reports.
