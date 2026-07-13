import { describe, expect, test } from "bun:test";
import {
  executeToolCalls,
  parseToolCalls,
  renderToolsPrompt,
  type AgentTool,
  type AgentToolContext,
} from "../tools";

const tools: AgentTool[] = [
  {
    name: "echo",
    description: "Return one supplied value.",
    parameters: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
    handler: async (args) => ({ value: args.value }),
  },
];

const context = {} as AgentToolContext;

describe("harness tool boundary", () => {
  test("success: renders, parses, and executes a declared tool", async () => {
    expect(renderToolsPrompt(tools)).toContain("echo: Return one supplied value.");
    const calls = parseToolCalls('<tool_call>{"name":"echo","arguments":{"value":"hello"}}</tool_call>');
    expect(calls).toHaveLength(1);
    expect(await executeToolCalls(calls, tools, context)).toEqual([
      { id: "call_1", name: "echo", content: '{"value":"hello"}' },
    ]);
  });

  test("edge input: ignores a malformed block without losing a later valid call", () => {
    const calls = parseToolCalls(
      '<tool_call>{not-json}</tool_call>\n<tool_call>{"name":"echo","arguments":{}}</tool_call>',
    );
    expect(calls.map((call) => call.function.name)).toEqual(["echo"]);
  });

  test("denied failure: an undeclared tool becomes a bounded error result", async () => {
    const calls = parseToolCalls('<tool_call>{"name":"shell","arguments":{}}</tool_call>');
    expect(await executeToolCalls(calls, tools, context)).toEqual([
      { id: "call_1", name: "shell", content: "error: unknown tool: shell" },
    ]);
  });
});
