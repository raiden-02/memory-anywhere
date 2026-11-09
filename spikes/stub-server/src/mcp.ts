// The stub's MCP server: three tools with the real descriptions (m0-spike.md §1).

import { fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
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

export function createStubServer(info: StubInfo): McpServer {
  const server = new McpServer(
    { name: "memory-anywhere", version: info.version },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    "memory_status",
    // No parameters: `{"type":"object"}` without an empty `properties`, which Gemini rejects (M0 Q10).
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
      inputSchema: z.object({
        text: z.string().min(1).max(400),
        user_words: z.string().min(1),
        explicit_request: z.boolean().optional(),
        why_durable: z.string().optional(),
        kind: z.string().optional(),
        expires_on: z.string().optional(),
        supersedes: z.string().optional(),
        change: z.enum(["correction", "update"]).optional(),
        policy_version: z.string().optional(),
      }),
    },
    async (args) => {
      const m = info.store.save(args.text, args.user_words, info.client);
      return { content: [{ type: "text", text: JSON.stringify({ outcome: "active", id: m.id, policy_version: "P1" }) }] };
    },
  );

  server.registerTool(
    "memory_recall",
    { description: DESC_MEMORY_RECALL, inputSchema: z.object({ query: z.string().min(1) }), ...toolMeta() },
    async ({ query }) => {
      const hits = info.store.recall(query);
      const text = hits.length ? hits.map((m) => `[${m.id}] ${m.text}`).join("\n") : "No memories match.";
      return { content: [{ type: "text", text }] };
    },
  );

  return server;
}
