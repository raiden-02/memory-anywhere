// The stub's MCP server: three tools with the real descriptions (m0-spike.md §1).

import { randomBytes } from "node:crypto";
import { acceptedContent, createRequestStateCodec, fromJsonSchema, inputRequired, McpServer } from "@modelcontextprotocol/server";
import type { JsonlStore } from "./store.ts";
import { DESC_MEMORY_RECALL, DESC_MEMORY_SAVE, DESC_MEMORY_STATUS, POLICY_DESC_MEMORY_STATUS, SERVER_INSTRUCTIONS } from "./texts.ts";

export interface StubInfo {
  version: string;
  store: JsonlStore;
  /** Recorded with each save, so M0 can tell which client wrote what. */
  client: string;
}

/** M0 Q10: MA_STUB_SHORT_STATUS=1 serves memory_status without the canary padding (A/B for clients that reject long descriptions). */
function statusDescription(): string {
  return process.env["MA_STUB_SHORT_STATUS"] === "1" ? POLICY_DESC_MEMORY_STATUS : DESC_MEMORY_STATUS;
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

/**
 * M0 Q09: the multi-round-trip requestState is HMAC-signed, 10 minutes, bound to the method
 * (mcp-interface.md §5). One key per process: every round of a flow reaches the same process.
 * The handler runs once per HTTP request (stateless), so the codec lives outside it.
 */
const confirmStates = createRequestStateCodec<{ text: string }>({ key: randomBytes(32), ttlSeconds: 600, bind: (ctx) => ctx.mcpReq.method });

export function createStubServer(info: StubInfo): McpServer {
  const server = new McpServer(
    { name: "memory-anywhere", version: info.version },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS, requestState: { verify: confirmStates.verify } },
  );

  server.registerTool(
    "memory_status",
    { description: statusDescription(), inputSchema: fromJsonSchema<Record<string, never>>({ type: "object" }), ...toolMeta() },
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

  // M0 Q09 only: asks the human a yes/no question through the client (MRTR elicitation) and logs
  // the answer, to learn which clients show it to the human and send the answer back.
  server.registerTool(
    "m0_confirm_test",
    {
      description:
        "M0 test of confirmation prompts. Call only when the user asks to run the confirmation test, with the text they give. It asks the user to confirm and reports what they answered.",
      inputSchema: fromJsonSchema<{ text: string }>({ type: "object", properties: { text: { type: "string", minLength: 1, maxLength: 200 } }, required: ["text"] }),
    },
    async ({ text }, ctx) => {
      const answer = acceptedContent<{ confirm?: unknown }>(ctx.mcpReq.inputResponses, "confirm");
      if (!answer) {
        console.log(JSON.stringify({ event: "elicitation_requested", client: info.client, text }));
        return inputRequired({
          inputRequests: {
            confirm: inputRequired.elicit({
              message: `memory-anywhere test: save "${text}"? This question must be answered by you, not by the assistant.`,
              requestedSchema: { type: "object", properties: { confirm: { type: "boolean", title: "Save it?" } }, required: ["confirm"] },
            }),
          },
          requestState: await confirmStates.mint({ text }, ctx),
        });
      }
      const state = ctx.mcpReq.requestState<{ text: string }>();
      const confirmed = answer.confirm === true;
      console.log(JSON.stringify({ event: "elicitation_answered", client: info.client, confirm: answer.confirm, state_text: state?.text ?? null }));
      return { content: [{ type: "text", text: `The user answered ${confirmed ? "Yes" : "No"}${state?.text ? ` for "${state.text}"` : ""}.` }] };
    },
  );

  return server;
}
