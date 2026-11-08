// HTTP routes of the stub (m0-spike.md §2): /mcp, /v1/health and the protected
// resource metadata. On the instance it listens on a unix socket behind Caddy.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { toNodeHandler, type NodeIncomingMessageLike } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createStubServer, type StubInfo } from "./mcp.ts";

export interface HttpOptions extends Omit<StubInfo, "client"> {
  /** e.g. https://spike.memory.example.com, no trailing slash */
  publicOrigin: string;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

export function protectedResourceMetadata(publicOrigin: string) {
  return {
    resource: `${publicOrigin}/mcp`,
    authorization_servers: [`${publicOrigin}/oauth`],
    bearer_methods_supported: ["header"],
    resource_name: "memory-anywhere (M0 spike)",
  };
}

export function createHttpServer(opts: HttpOptions): Server {
  const mcp = createMcpHandler(
    (ctx) => {
      void ctx;
      return createStubServer({ ...opts, client: "http" });
    },
    { legacy: "stateless" },
  );
  const mcpNode = toNodeHandler(mcp);
  const prm = protectedResourceMetadata(opts.publicOrigin);

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? "/", "http://stub").pathname;
    if (path === "/mcp") {
      // The SDK's structural request type is not written for exactOptionalPropertyTypes;
      // a real IncomingMessage is exactly what it expects.
      void mcpNode(req as unknown as NodeIncomingMessageLike, res);
      return;
    }
    if (req.method !== "GET") return json(res, 405, { error: "method_not_allowed" });
    if (path === "/v1/health") return json(res, 200, { status: "ok", version: opts.version });
    // Both discovery paths: path-suffixed (RFC 9728 §3.1) and the bare one some clients use.
    if (path === "/.well-known/oauth-protected-resource/mcp" || path === "/.well-known/oauth-protected-resource") return json(res, 200, prm);
    return json(res, 404, { error: "not_found" });
  });
}
