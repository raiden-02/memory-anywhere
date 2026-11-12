// The local-mode HTTP server (topology-and-ipc.md §4; mcp-interface.md §1, §7; operations.md §1, §3).
//
// Every request passes the same gates, in order, before any store or model work:
//
//   Host is 127.0.0.1:<port> or localhost:<port>  → else 403
//   Origin absent, or a loopback origin            → else 403
//   route exists                                   → else 404
//   /v1/health needs nothing more; everything else:
//     unauthenticated rate limit (per IP)          → 429
//     Bearer <local token>                         → else 401
//     per-grant rate limit                         → 429
//     MA-Client-Version supported (/v1; /mcp if sent) → else 426
//     body within 64 KiB (/mcp) or 1 MiB (/v1)     → else 413
//
// Each request writes one log line of codes and timings, never content.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { toWebRequest, type NodeIncomingMessageLike } from "@modelcontextprotocol/node";
import type { App } from "../app.ts";
import { localGrant, type Grant } from "../api/grant.ts";
import { mcpHandler, type McpRequestExtra } from "../api/mcp.ts";
import { ipPrefix, Logger, type LogLine } from "./log.ts";
import { admin, apiError, clientVersionOk, health, projection, recallRoute, reposCheck, sessionStart, statusRoute, tooOld, writes, type V1Response } from "./v1.ts";

const MCP_BODY_MAX = 64 * 1024;
const V1_BODY_MAX = 1024 * 1024;

export interface HttpOptions {
  readonly app: App;
  readonly port: number;
  readonly localToken: string;
  readonly logger?: Logger;
  readonly now?: () => number;
}

/** Every route the server answers; a test checks this list against the spec (route inventory). */
export const ROUTES = [
  "POST /mcp",
  "GET /v1/health",
  "POST /v1/session-start",
  "GET /v1/projection",
  "POST /v1/writes",
  "POST /v1/recall",
  "GET /v1/status",
  "POST /v1/repos/check",
  "POST /v1/admin/repo-enable",
  "POST /v1/admin/repo-disable",
  "POST /v1/admin/project-track",
  "POST /v1/admin/project-add",
  "POST /v1/admin/review",
] as const;

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (body === undefined) {
    res.writeHead(status, { "cache-control": "no-store", ...headers });
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "content-length": String(Buffer.byteLength(text)), ...headers });
  res.end(text);
}

class BodyTooLarge extends Error {}

async function readJson(req: IncomingMessage, max: number): Promise<unknown> {
  const declared = Number(req.headers["content-length"] ?? "0");
  if (declared > max) throw new BodyTooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new BodyTooLarge();
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

const tokenMatches = (header: string | undefined, token: string): boolean => {
  const presented = Buffer.from(/^Bearer (\S+)$/u.exec(header ?? "")?.[1] ?? "", "utf8");
  const expected = Buffer.from(token, "utf8");
  return presented.length === expected.length && timingSafeEqual(presented, expected);
};

export function createHttpServer(o: HttpOptions): Server {
  const { app } = o;
  const logger = o.logger ?? new Logger();
  const now = o.now ?? Date.now;
  const hosts = new Set([`127.0.0.1:${o.port}`, `localhost:${o.port}`]);
  const origins = new Set([`http://127.0.0.1:${o.port}`, `http://localhost:${o.port}`]);
  const { unauthenticated, requests: perGrant } = app.limits;
  const mcp = mcpHandler(app);
  const routes = new Set<string>(ROUTES);

  return createServer((req, res) => {
    const started = now();
    const reqId = app.ctx.ids.newUlid(started);
    const url = new URL(req.url ?? "/", "http://local");
    const route = `${req.method ?? "GET"} ${url.pathname}`;
    const prefix = ipPrefix(req.socket.remoteAddress);
    const line: { -readonly [K in keyof LogLine]?: LogLine[K] } = { level: "info", req_id: reqId, route: url.pathname, ...(prefix ? { ip_prefix: prefix } : {}) };
    const finish = (status: number, extra: Partial<LogLine> = {}): void => {
      logger.log({ ...line, ...extra, level: status >= 500 ? "error" : status >= 400 ? "warn" : "info", status, latency_ms: now() - started } as LogLine);
    };
    const reply = (r: V1Response, headers: Record<string, string> = {}): void => {
      send(res, r.status, r.body, headers);
      finish(r.status, { ...(r.op ? { op: r.op } : {}), ...(r.outcome ? { outcome: r.outcome } : {}), ...(r.status >= 400 ? { error_code: r.outcome ?? "" } : {}) });
      if (r.after) res.once("finish", () => runAfter(logger, reqId, r.after));
    };

    // Gates that need no credential.
    if (!hosts.has(req.headers.host ?? "")) return reply(apiError("FORBIDDEN", "host not allowed"));
    const origin = req.headers.origin;
    if (origin !== undefined && !origins.has(origin)) return reply(apiError("FORBIDDEN", "origin not allowed"));
    const isAdmin = url.pathname.startsWith("/v1/admin/") && req.method === "POST";
    if (!routes.has(route) && !isAdmin) return reply(apiError("NOT_FOUND", "no such route"));
    if (route === "GET /v1/health") return reply(health(app));

    // Credential, limits, version, body.
    if (!tokenMatches(req.headers.authorization, o.localToken)) {
      const wait = unauthenticated.take(line.ip_prefix ?? "unknown");
      if (wait > 0) return reply(apiError("RATE_LIMITED", "too many requests", { retry_after_s: wait }), { "retry-after": String(wait) });
      return reply(apiError("UNAUTHORIZED", "missing or invalid token"), { "www-authenticate": 'Bearer realm="memory-anywhere"' });
    }
    const grant: Grant = localGrant(new Headers(req.headers as Record<string, string>), reqId, isAdmin);
    line.client_id = grant.clientId;
    if (grant.repoKey) line.repo_key = grant.repoKey;
    const wait = perGrant.take(grant.clientId);
    if (wait > 0) return reply(apiError("RATE_LIMITED", "too many requests", { retry_after_s: wait }), { "retry-after": String(wait) });
    const version = req.headers["ma-client-version"];
    const versionHeader = typeof version === "string" ? version : null;
    if ((url.pathname.startsWith("/v1/") || versionHeader !== null) && !clientVersionOk(versionHeader)) return reply(tooOld());

    if (url.pathname === "/mcp") return void serveMcp(req, res, grant).catch(() => reply(apiError("INTERNAL", "internal error")));

    void readJson(req, V1_BODY_MAX)
      .then((body) => dispatch(app, grant, route, url, body))
      .then((r) => reply(r), (e: unknown) => {
        if (e instanceof BodyTooLarge) return reply({ status: 413, body: { code: "INVALID_INPUT", message: "request body too large" }, outcome: "too_large" });
        if (e instanceof SyntaxError) return reply(apiError("INVALID_INPUT", "body is not JSON", { field: "body" }));
        return reply(apiError("INTERNAL", "internal error"));
      });

    async function serveMcp(request: IncomingMessage, response: ServerResponse, g: Grant): Promise<void> {
      const extra: McpRequestExtra = { grant: g, after: [] };
      let web: Request;
      try {
        web = await toWebRequest(request as unknown as NodeIncomingMessageLike, undefined, { maxRequestBodySize: MCP_BODY_MAX });
      } catch (e) {
        if ((e as { status?: number }).status === 413) return reply({ status: 413, body: { code: "INVALID_INPUT", message: "request body too large" }, outcome: "too_large" });
        throw e;
      }
      const answer = await mcp.fetch(web, { authInfo: { token: "local", clientId: g.clientId, scopes: ["memory.read", "memory.write", "memory.capture"], extra: extra as unknown as Record<string, unknown> } });
      const headers: Record<string, string> = {};
      answer.headers.forEach((v, k) => {
        headers[k] = v;
      });
      response.writeHead(answer.status, headers);
      response.end(Buffer.from(await answer.arrayBuffer()));
      finish(answer.status, { op: "mcp" });
      response.once("finish", () => {
        for (const after of extra.after) runAfter(logger, reqId, after);
      });
    }
  });
}

async function dispatch(app: App, grant: Grant, route: string, url: URL, body: unknown): Promise<V1Response> {
  switch (route) {
    case "POST /v1/session-start": return sessionStart(app, grant, body, []);
    case "GET /v1/projection": return projection(app, grant, url.searchParams);
    case "POST /v1/writes": return writes(app, grant, body);
    case "POST /v1/recall": return recallRoute(app, grant, body);
    case "GET /v1/status": return statusRoute(app, grant);
    case "POST /v1/repos/check": return reposCheck(app, grant, body);
    default: return admin(app, grant, url.pathname.slice("/v1/admin/".length), body);
  }
}

/** Work after the response: a failure is logged by code and never reaches the client. */
function runAfter(logger: Logger, reqId: string, after: (() => void) | undefined): void {
  try {
    after?.();
  } catch {
    logger.log({ level: "error", req_id: reqId, op: "after_response", error_code: "INTERNAL" });
  }
}
