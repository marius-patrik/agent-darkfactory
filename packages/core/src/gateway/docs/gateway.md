# Agent OS Gateway Architecture

## Boundary

The gateway owns local model registry loading, request routing, task-class
resolution, in-process quota windows, and health probes.
It does not own Agent OS identity, memory, capabilities, provider execution,
session continuation, orchestration, or canonical accounting.

## Authority

- Static model definitions: package-owned `registry/models.yaml`.
- Live local-engine endpoints and readiness: inferctl-owned status file at
  `GATEWAY_INFERCTL_STATUS_PATH` or `registry/inferctl-engines.yaml`.
- Traces: `$AGENTS_HOME/runtime/gateway/traces/`.
The inferctl file is a runtime overlay, never a writable registry backend.
Cloud provider
credentials and execution remain exclusively in the manager-owned provider
harnesses.

## Routing

1. The source registry declares immutable local model templates with
   `extra.inferctl_managed: true`; it does not pin loopback ports.
2. Inferctl atomically writes `inferctl-local-engines-v1` YAML with an
   `engines` object keyed by model id. Each ready entry supplies `api_base` and
   either `healthy: true` or a ready status such as `healthy` or `running`.
3. Missing, malformed, stopped, or unhealthy managed engines remain disabled.
   File signature changes refresh live ports at list, route, and health
   boundaries. Static definitions are rebuilt before every overlay, so runtime
   endpoint/status data can never persist into the package registry.
4. Requested role aliases resolve in immutable registry declaration order.
5. The task router maps a work class to ordered live candidates.
6. The request router enforces context limits and local quota policy.
7. Agent OS session provider/model selection remains in canonical TypeScript
   session events.

## Runtime metadata

Health reports the installed package version plus deployment metadata from
`AGENTS_GIT_SHA`, `AGENTS_BUILD_TIME`, and `AGENTS_NODE_ID`.
