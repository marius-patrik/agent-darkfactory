# Agent OS Gateway Architecture

## Boundary

The gateway owns local model registry loading, request routing, task-class
resolution, in-process quota windows, and health probes.
It does not own Agent OS identity, memory, capabilities, provider execution,
session continuation, orchestration, or canonical accounting.

## Authority

- Static models and endpoints: package-owned `registry/models.yaml`.
- Traces: `$AGENTS_HOME/runtime/gateway/traces/`.
There is no alternate registry backend or path override. Cloud provider
credentials and execution remain exclusively in the manager-owned provider
harnesses.

## Routing

1. The source registry declares concrete local candidates.
2. Requested role aliases resolve in immutable registry declaration order.
3. The task router maps a work class to ordered candidates.
4. The request router enforces context limits and local quota policy.
5. Agent OS session provider/model selection remains in canonical TypeScript
   session events.

## Runtime metadata

Health reports the installed package version plus deployment metadata from
`AGENTS_GIT_SHA`, `AGENTS_BUILD_TIME`, and `AGENTS_NODE_ID`.
