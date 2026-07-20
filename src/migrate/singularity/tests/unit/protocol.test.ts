import {
  type MessageEnvelope,
  ProtocolError,
  deserialize,
  serialize,
} from "../../src/shared/protocol.js";

describe("protocol", () => {
  const validEnvelope: MessageEnvelope = {
    projectId: "project-1",
    direction: "host-to-engine",
    type: "ping",
    payload: { count: 1 },
  };

  test("serialize round-trips through deserialize", () => {
    const json = serialize(validEnvelope);
    expect(typeof json).toBe("string");
    const parsed = deserialize(json);
    expect(parsed).toEqual(validEnvelope);
  });

  test("deserialize accepts plain objects", () => {
    const parsed = deserialize({ ...validEnvelope });
    expect(parsed).toEqual(validEnvelope);
  });

  test("deserialize rejects invalid JSON", () => {
    expect(() => deserialize("not json")).toThrow(ProtocolError);
  });

  test("deserialize rejects non-object input", () => {
    expect(() => deserialize(42)).toThrow(ProtocolError);
    expect(() => deserialize(null)).toThrow(ProtocolError);
  });

  test("deserialize rejects missing fields", () => {
    expect(() => deserialize({ projectId: "x", direction: "host-to-engine" })).toThrow(
      ProtocolError,
    );
  });

  test("deserialize rejects invalid direction", () => {
    expect(() => deserialize({ ...validEnvelope, direction: "invalid" })).toThrow(ProtocolError);
  });

  test("serialize rejects invalid envelope", () => {
    expect(() => serialize({ ...validEnvelope, projectId: "" })).toThrow(ProtocolError);
  });

  test("optional requestId is preserved", () => {
    const envelope: MessageEnvelope = { ...validEnvelope, requestId: "req-123" };
    expect(deserialize(serialize(envelope))).toEqual(envelope);
  });
});
