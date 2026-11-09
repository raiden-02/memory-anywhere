// The stub's MCP server: three tools with the real descriptions (m0-spike.md §1).

import { fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import type { JsonlStore } from "./store.ts";
import { DESC_MEMORY_RECALL, DESC_MEMORY_SAVE, DESC_MEMORY_STATUS, SERVER_INSTRUCTIONS } from "./texts.ts";

export interface StubInfo {
  version: string;
  store: JsonlStore;
  /** Recorded with each save, so M0 can tell which client wrote what. */
  client: string;
}

/** M0 Q07: MA_STUB_ALWAYS_LOAD_META=1 marks every tool with _meta["anthropic/alwaysLoad"]. */
function toolMeta(): { _meta?: Record<string, unknown> } {
  return process.env["MA_STUB_ALWAYS_LOAD_META"] === "1" ? { _meta: { "anthropic/alwaysLoad": true } } : {};
}

/**
 * Tool input schemas are plain JSON Schema, not generated from zod: Gemini accepts only a subset
 * (no `$schema` key, no empty `properties` object), and every other client reads the same thing
 * (M0 Q10, ADR-0107).
 */
interface SaveArgs {
  text: string;
  user_words: string;
  explicit_request?: boolean;
  why_durable?: string;
  kind?: string;
  expires_on?: string;
  supersedes?: string;
  change?: "correction" | "update";
  policy_version?: string;
}

export function createStubServer(info: StubInfo): McpServer {
  const server = new McpServer(
    { name: "memory-anywhere", version: info.version },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    "memory_status",
    { description: DESC_MEMORY_STATUS, inputSchema: fromJsonSchema<Record<string, never>>({ type: "object" }), ...toolMeta() },
    async () => ({
      content: [{ type: "text", text: JSON.stringify({ store: "m0-stub", healthy: true, policy_version: "P1", version: info.version, memories: info.store.all().length }) }],
    }),
  );

  server.registerTool(
    "memory_save",
    {
      ...toolMeta(),
      description: DESC_MEMORY_SAVE,
      inputSchema: fromJsonSchema<SaveArgs>({
        type: "object",
        properties: {
          text: { type: "string", minLength: 1, maxLength: 400 },
          user_words: { type: "string", minLength: 1 },
          explicit_request: { type: "boolean" },
          why_durable: { type: "string" },
          kind: { type: "string" },
          expires_on: { type: "string" },
          supersedes: { type: "string" },
          change: { type: "string", enum: ["correction", "update"] },
          policy_version: { type: "string" },
        },
        required: ["text", "user_words"],
      }),
    },
    async (args) => {
      const m = info.store.save(args.text, args.user_words, info.client);
      return { content: [{ type: "text", text: JSON.stringify({ outcome: "active", id: m.id, policy_version: "P1" }) }] };
    },
  );

  server.registerTool(
    "memory_recall",
    {
      description: DESC_MEMORY_RECALL,
      inputSchema: fromJsonSchema<{ query: string }>({ type: "object", properties: { query: { type: "string", minLength: 1 } }, required: ["query"] }),
      ...toolMeta(),
    },
    async ({ query }) => {
      const hits = info.store.recall(query);
      const text = hits.length ? hits.map((m) => `[${m.id}] ${m.text}`).join("\n") : "No memories match.";
      return { content: [{ type: "text", text }] };
    },
  );

  return server;
}
