# Andromeda Integration

## 1. Integration strategy

Genesis OS is standalone and treats Andromeda as an environment/event source. This avoids coupling the model lifecycle to undocumented Andromeda internals while providing a stable seam that can be placed behind Andromeda's event bus, API layer, or application state manager.

```text
Andromeda UI/services
        |
        | normalized event
        v
POST /v1/andromeda/events
        |
        v
Genesis Wake -> audited tools -> messages/results
        |
        +-> REST response
        +-> immutable event stream
```

## 2. Run Genesis

```bash
export GENESIS_API_TOKEN='strong-local-token'
genesis serve \
  --workspace .genesis/andromeda \
  --lineage <LINEAGE_ID> \
  --host 127.0.0.1 \
  --port 8787
```

Keep high-impact tool flags disabled until the integration has an OS-level sandbox.

## 3. TypeScript client

The client lives under `sdk/typescript`.

```bash
cd sdk/typescript
npm install
npm run typecheck
npm run build
```

An event adapter is provided in `examples/andromeda-bridge.ts`.

```ts
const result = await genesis.sendAndromedaEvent({
  type: event.type,
  content: event.text,
  sessionId: event.sessionId,
  metadata: {
    andromeda_event_id: event.id,
    project_id: event.projectId,
  },
});
```

Use a stable `sessionId` to preserve recurrent cognitive state across related events. Use distinct sessions for unrelated task contexts while retaining one shared autobiographical ledger.

## 4. Tool trace handling

The response contains:

```ts
interface WakeResult {
  session_id: string;
  messages: string[];
  tool_results: ToolResult[];
  yielded: boolean;
  sleep_requested: boolean;
  final_sequence: number;
}
```

Andromeda should render `messages` to the user and retain/display `tool_results` as an inspectable execution trace. Do not treat a successful HTTP response as proof every nested action succeeded; inspect each `ToolResult.ok`.

## 5. Event stream

Poll:

```text
GET /v1/events?after_sequence=<cursor>&limit=500
```

Or subscribe:

```text
WS /v1/events/ws?after_sequence=<cursor>&token=<token>
```

Persist the latest processed sequence in Andromeda. Event IDs are immutable; sequence is the total ledger order.

## 6. Sleep handoff

When a Wake result has `sleep_requested=true`, Andromeda may:

1. show the request to the user;
2. check compute/budget/policy;
3. call `POST /v1/sleep`;
4. inspect the promotion decision;
5. continue against the reloaded promoted runtime.

Genesis does not automatically execute durable training merely because the organism invoked `sleep.request`.

## 7. Native Andromeda tools

Andromeda-specific operations should become dynamic tools. Two patterns are recommended:

### Local workflow

Compose existing workspace/process/network primitives into a manifest when the operation is local and deterministic.

### Bridge service tool

Implement a narrowly scoped tool that calls an authenticated Andromeda service endpoint. Give it only the network capability and credentials required for that operation. Never expose a general Andromeda admin token to generated tool code.

Examples:

- `andromeda.project.read`
- `andromeda.task.create`
- `andromeda.artifact.publish`
- `andromeda.experiment.schedule`

Each should have a strict schema, idempotency semantics, explicit output, and test fixtures.

## 8. Direct repository integration

When the Andromeda repository is available, integrate in this order:

1. add `sdk/typescript` as a workspace package;
2. instantiate one `GenesisClient` in Andromeda's backend, not the browser, when using privileged tools;
3. map Andromeda events to the normalized event contract;
4. surface tool traces in the developer UI;
5. persist the Genesis sequence cursor;
6. add Andromeda-specific tools with least privilege;
7. add end-to-end tests using a tiny Genesis lineage;
8. run Sleep in a separate worker/queue.

No changes to Genesis model code should be required for ordinary Andromeda event types.
