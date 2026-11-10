// The MCP endpoint (mcp-interface.md §1): one stateless SDK server per request, built for the
// caller's grant. The low-level `Server` is used so the tool list (fixed order, Gemini-safe schemas,
// filtered per grant) and argument validation (INVALID_INPUT with the field) stay exactly as the
// spec says, rather than as the SDK's tool helpers would shape them.

import { createMcpHandler, Server, type CallToolResult, type McpHttpHandler, type Tool } from "@modelcontextprotocol/server";
import { TEXTS } from "../policy/generated.ts";
import { prepared } from "../store/db.ts";
import { SERVER_VERSION, type App } from "../app.ts";
import type { Grant } from "./grant.ts";
import { callTool, toolDefinitions, type AfterResponse } from "./tools.ts";

const TOOLS_TTL_MS = 3_600_000;

/** Per-request context the HTTP layer passes through the SDK as `authInfo.extra`. */
export interface McpRequestExtra {
  readonly grant: Grant;
  /** Collects work to run after the response is written (the recall ledger). */
  readonly after: AfterResponse[];
}

function buildServer(app: App, extra: McpRequestExtra): Server {
  const { grant } = extra;
  const server = new Server(
    { name: "memory-anywhere", version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions: TEXTS["server-instructions"],
      cacheHints: { "tools/list": { ttlMs: TOOLS_TTL_MS, cacheScope: "private" } },
    },
  );
  server.setRequestHandler("tools/list", () => {
    const canWrite = grant.scopes.write && (prepared(app.ctx.db, "SELECT write FROM client_policy WHERE client_id = ?").get(grant.clientId) as { write: number } | undefined)?.write === 1;
    // The definitions are JSON Schemas generated from the contracts; the SDK types them structurally.
    return { tools: toolDefinitions(canWrite).map((d) => ({ ...d, annotations: { ...d.annotations } }) as unknown as Tool) };
  });
  server.setRequestHandler("tools/call", async (request) => {
    const { name, arguments: args, _meta } = request.params;
    const { result, after } = await callTool(app, grant, name, args, _meta as Record<string, unknown> | undefined);
    extra.after.push(after);
    return { ...result } satisfies CallToolResult;
  });
  return server;
}

/** The `/mcp` handler: the grant arrives on `authInfo.extra`, set by the HTTP layer after it checked the token. */
export function mcpHandler(app: App): McpHttpHandler {
  return createMcpHandler(
    (ctx) => {
      const extra = ctx.authInfo?.extra as McpRequestExtra | undefined;
      if (!extra) throw new Error("an /mcp request reached the handler without a verified grant");
      return buildServer(app, extra);
    },
    { legacy: "stateless", responseMode: "json", maxRequestBodySize: 64 * 1024 },
  );
}
