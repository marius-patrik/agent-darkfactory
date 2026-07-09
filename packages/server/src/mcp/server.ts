import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { KnowledgeBase, runQuery, runMutation } from "@okf-agent/core";

/**
 * Build the OKF MCP server. Each knowledge tool internally drives the LLM
 * agent (OKF spec in its system prompt) against the bundle.
 * Transport-agnostic — used by both the stdio bin and the HTTP endpoint.
 */
export function buildMcpServer(kb: KnowledgeBase): McpServer {
  const server = new McpServer({ name: "okf-knowledge-agent", version: "0.1.0" });

  server.registerTool(
    "kb_query",
    {
      title: "Query the knowledge base",
      description:
        "Ask a natural-language question. An internal agent searches the OKF knowledge base, reads relevant concepts, and answers with cited bundle paths.",
      inputSchema: { question: z.string().describe("The question to answer") },
    },
    async ({ question }) => {
      const { answer } = await runQuery(kb, question);
      return { content: [{ type: "text", text: answer }] };
    }
  );

  server.registerTool(
    "kb_add",
    {
      title: "Add knowledge",
      description:
        "Provide free-form knowledge (facts, docs, decisions, runbooks). An internal agent searches for overlap, then creates or extends OKF concepts; indexes and the update log are maintained automatically.",
      inputSchema: {
        content: z.string().describe("The knowledge to record, in any prose form"),
        suggested_path: z
          .string()
          .optional()
          .describe('Optional bundle path hint, e.g. "/apis/payments.md"'),
      },
    },
    async ({ content, suggested_path }) => {
      // Wrap the payload as an explicit directive. Bare content (e.g. a plain
      // fact like "The user's name is Anirban Kar.") otherwise reads as a chat
      // message and the agent replies conversationally instead of persisting it.
      const instruction =
        `Persist the following knowledge into the knowledge base. Search for an ` +
        `existing concept it belongs to and update it; otherwise create a new ` +
        `concept in a fitting directory. This is content to store, not a message ` +
        `to answer — you must use the write tools.\n\n` +
        `KNOWLEDGE TO RECORD:\n${content}` +
        (suggested_path ? `\n\nIf it fits, place new content at ${suggested_path}.` : "");
      const { summary, filesChanged } = await runMutation(kb, instruction);
      return {
        content: [
          { type: "text", text: `${summary}\n\nFiles changed:\n${filesChanged.map((f) => `- ${f}`).join("\n") || "- none"}` },
        ],
      };
    }
  );

  server.registerTool(
    "kb_update",
    {
      title: "Update knowledge",
      description:
        "Instruct a change to existing knowledge (correct a fact, deprecate a concept, restructure). An internal agent locates the concepts and applies targeted edits.",
      inputSchema: {
        instruction: z.string().describe("What to change, in natural language"),
      },
    },
    async ({ instruction }) => {
      const { summary, filesChanged } = await runMutation(kb, instruction);
      return {
        content: [
          { type: "text", text: `${summary}\n\nFiles changed:\n${filesChanged.map((f) => `- ${f}`).join("\n") || "- none"}` },
        ],
      };
    }
  );

  server.registerTool(
    "kb_status",
    {
      title: "Knowledge base status",
      description:
        "Deterministic (no LLM): bundle statistics and OKF conformance report.",
      inputSchema: {},
    },
    async () => {
      const report = await kb.validate();
      const types = await kb.listTypes();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                conformant: report.conformant,
                concepts: report.conceptCount,
                directories: report.directoryCount,
                types,
                errors: report.issues.filter((i) => i.severity === "error"),
                warnings: report.issues.filter((i) => i.severity === "warning").length,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  return server;
}
