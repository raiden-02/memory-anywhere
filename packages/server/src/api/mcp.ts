// The MCP endpoint (mcp-interface.md §1): one stateless SDK server per request, built for the
// caller's grant. The low-level `Server` is used so the tool list (fixed order, Gemini-safe schemas,
// filtered per grant) and argument validation (INVALID_INPUT with the field) stay exactly as the
// spec says, rather than as the SDK's tool helpers would shape them.

import { acceptedContent, createMcpHandler, inputRequired, Server, type CallToolResult, type McpHttpHandler, type Tool } from "@modelcontextprotocol/server";
import { TEXTS } from "../policy/generated.ts";
import { prepared } from "../store/db.ts";
import { SERVER_VERSION, type App } from "../app.ts";
import type { Grant } from "./grant.ts";
import { argsDigest, consumeElicitation, startElicitation } from "./mrtr.ts";
import { callTool, toolDefinitions, type AfterResponse, type Elicitation } from "./tools.ts";

/** The first protocol revision with multi-round-trip requests; earlier clients never get a question (§5). */
const MRTR_REVISION = "2026-07-28";

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
  server.setRequestHandler("tools/call", async (request, ctx) => {
    const { name, arguments: args, _meta } = request.params;
    const elicit = elicitationFor(app, grant, name, args, ctx.mcpReq);
    const { result, after, question } = await callTool(app, grant, name, args, _meta as Record<string, unknown> | undefined, elicit);
    extra.after.push(after);
    if (question !== undefined) {
      // The person is asked; the client retries with the answer and this state (mcp-interface.md §5).
      return inputRequired({
        inputRequests: {
          confirm: inputRequired.elicit({
            message: question,
            requestedSchema: { type: "object", properties: { confirm: { type: "boolean", title: "Yes" } }, required: ["confirm"] },
          }),
        },
        requestState: startElicitation(app.ctx, grant.grantId, name, argsDigest(name, args), question),
      });
    }
    return { ...result } satisfies CallToolResult;
  });
  return server;
}

/** The 2026-07-28 per-request envelope, as the SDK lifts it out of `_meta`. */
const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";

interface McpRequestContext {
  readonly envelope?: Readonly<Record<string, unknown>>;
  readonly inputResponses?: Record<string, unknown>;
  requestState<T = string>(): T | undefined;
}

/**
 * May this call ask the person (§5 step 1: the owner verified this client for elicitation, and the
 * request declares the capability on protocol 2026-07-28 or later), and is this the answered retry
 * (step 5: a valid, unused state for this grant and these exact arguments)?
 */
function elicitationFor(app: App, grant: Grant, tool: string, args: unknown, req: McpRequestContext): Elicitation {
  if (grant.grantId === "local") return { canElicit: false, answer: undefined };
  const verified = (prepared(app.ctx.db, "SELECT elicitation FROM client_policy WHERE client_id = ?").get(grant.clientId) as { elicitation: string } | undefined)?.elicitation === "verified";
  const version = req.envelope?.[PROTOCOL_VERSION_KEY];
  const capabilities = req.envelope?.[CLIENT_CAPABILITIES_KEY] as { elicitation?: unknown } | undefined;
  const canElicit = verified && capabilities?.elicitation !== undefined && typeof version === "string" && version >= MRTR_REVISION;
  if (!canElicit) return { canElicit: false, answer: undefined };
  const state = req.requestState<string>();
  const response = acceptedContent<{ confirm?: unknown }>(req.inputResponses, "confirm");
  if (state === undefined || !response) return { canElicit: true, answer: undefined };
  // A state that fails any check counts as no answer at all: the table's "else" branch.
  if (!consumeElicitation(app.ctx, state, grant.grantId, argsDigest(tool, args))) return { canElicit: false, answer: undefined };
  return { canElicit: true, answer: response.confirm === true };
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
