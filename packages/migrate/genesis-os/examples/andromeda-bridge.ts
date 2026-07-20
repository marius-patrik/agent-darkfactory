import { GenesisClient } from "../sdk/typescript/src/index.js";

const genesis = new GenesisClient({
  baseUrl: process.env.GENESIS_URL ?? "http://127.0.0.1:8787",
  token: process.env.GENESIS_API_TOKEN,
});

// Call this from Andromeda's event bus. Genesis receives one normalized event and
// returns emitted messages plus the complete audited tool trace for the turn.
export async function forwardAndromedaEvent(event: {
  id: string;
  type: string;
  text: string;
  sessionId: string;
  metadata?: Record<string, unknown>;
}) {
  return genesis.sendAndromedaEvent({
    type: event.type,
    content: event.text,
    sessionId: event.sessionId,
    metadata: { andromeda_event_id: event.id, ...event.metadata },
  });
}
