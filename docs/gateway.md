# Agent OS Gateway Architecture

## Boundary

The gateway owns local model registry loading, request routing, task-class
resolution, quota enforcement, health probes, generated Connect control-plane
handlers, and the transient protobuf WebSocket session relay.
It does not own Agent OS identity, memory, capabilities, provider execution,
orchestration, canonical accounting, or the durable Agent OS session event
store. Gateway relay history is bounded runtime state, not a second authority.

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

## VS2 control plane and session stream

`buf generate proto --template buf.gen.gateway-python.yaml` runs from
`packages/core` and produces the checked-in `agent_os.v1` Python
messages and Connect handlers. The gateway mounts the generated Health,
Registry, Session, and Switcher services at their canonical
`/agent_os.v1.<Service>/<Method>` paths. These are protocol handlers, not
method-shaped JSON substitutes.

The gateway pins `connectrpc==0.11.0` and directly pins Buf's Apache-2.0
`protobuf-py==0.1.1` message runtime; wheel installs do not depend on an
undeclared transitive `protobuf` provider.

Live clients attach at `/v1/sessions/{session_id}/ws` and exchange the binary
`ClientFrame`/`ServerFrame` messages from `session_frames.proto`. The relay
supports replay, multiple clients, fork-at-sequence, and monotonic sequence
numbers. A failed client is removed without aborting delivery to healthy
clients; every WebSocket exit detaches in a `finally` boundary. Configure
`GATEWAY_SESSION_HISTORY_FRAMES` and `GATEWAY_WS_MAX_FRAME_BYTES` to bound the
runtime log and input frames.

Attachment only accepts session IDs already created through the control plane.
Switcher scopes are per-axis overlays (`session > project > global`), so a
narrow override does not freeze unrelated broader selections or leak a session
value into project/global state.

## Edge mTLS

Set `GATEWAY_MTLS_MODE=require` only behind an edge that strips untrusted
verification headers, verifies the client certificate, and injects
`GATEWAY_MTLS_VERIFY_HEADER` (default `x-client-cert-verified`) with
`GATEWAY_MTLS_VERIFY_VALUE` (default `SUCCESS`). The edge must also inject the
shared `GATEWAY_MTLS_EDGE_TOKEN` through `GATEWAY_MTLS_EDGE_TOKEN_HEADER`
(default `x-gateway-edge-token`); the gateway compares it in constant time.
Certificate identity headers such as `x-forwarded-client-cert`, or a spoofed
verification result without the edge token, are never accepted as proof. The
same gate runs before both HTTP handling and WebSocket acceptance. Invalid or
incomplete mTLS configuration fails closed.

Relay writes are concurrent per publication and bounded by
`GATEWAY_WS_SEND_TIMEOUT_SECONDS` (default 5 seconds), so one slow peer cannot
hold every healthy peer indefinitely. An attaching client's complete history
replay has a separate total `GATEWAY_WS_REPLAY_TIMEOUT_SECONDS` deadline
(default 5 seconds), rather than multiplying the send timeout by every retained
frame. `GATEWAY_WS_MAX_FRAME_BYTES` is an application processing limit after
Starlette receives a message; deployments that need a transport-level buffer
cap must enforce it at the ASGI server or edge proxy.

## Durable budgets and cluster axes

`GATEWAY_BUDGETS_PATH` (or `AGENTS_CREDITS`) is a read-only durable budget
authority. `GATEWAY_BUDGETS_PATH` takes precedence when both are set;
`AGENTS_CREDITS` is the canonical Agent OS fallback. When a cloud provider is exhausted—or the configured budget file
cannot be validated—the request/task routers skip it and use an enabled local
model with the same role. Cloud is also local-by-default unless the caller sets
`allow_cloud=true`. The gateway never writes the shared credit store.

`user_input` relay frames produce a `status(state="input")` event whose `detail`
carries the submitted text; attached peers consume that status event rather than
a byte-for-byte echo of the original client frame. Invalid switch requests return
a `status(state="switch_error")` frame and leave the WebSocket attached.

`GATEWAY_CLUSTER_HOSTS` accepts comma-separated `node=url` entries. Live
registry `extra.node_id`/`extra.backend_node_id` values also populate the host
and node inventory. The Connect registry and switcher services derive cluster
host and fabric availability from those sources instead of exposing fixed
placeholders.

Operator rollout order: deploy generated bindings and gateway together; place
the service behind the verified mTLS edge; configure budgets and cluster host
inventory; exercise Connect registry calls; attach two WebSocket clients and
verify replay/relay; then enable production traffic. Roll back by disabling
traffic at the edge—the source registry and Agent OS canonical event stores are
not mutated by this runtime surface.

## Runtime metadata

Health reports the installed package version plus deployment metadata from
`AGENTS_GIT_SHA`, `AGENTS_BUILD_TIME`, and `AGENTS_NODE_ID`.
