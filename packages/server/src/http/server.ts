// The HTTP server (topology-and-ipc.md §2–§4; mcp-interface.md §1, §7; operations.md §1, §3).
//
// Every request passes the same gates, in order, before any store or model work:
//
//   front door: which surface, which client address   → else 403   (front.ts)
//   a mount of that surface serves its own routes      (OAuth pages on "mcp", the admin UI on "admin")
//   the admin surface has nothing else                 → 404
//   resource routes (/mcp, /v1/*):
//     Origin absent (aws), or a loopback origin (local) → else 403
//     route exists                                      → else 404
//     /v1/health needs nothing more; everything else:
//       a valid credential (authenticate)              → else 401, counted by the per-IP limit → 429
//       per-grant rate limit                            → 429
//       MA-Client-Version supported (/v1; /mcp if sent) → else 426
//       body within 64 KiB (/mcp) or 1 MiB (/v1)        → else 413
//
// Each request writes one log line of codes and timings, never content.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { toWebRequest, type NodeIncomingMessageLike } from "@modelcontextprotocol/node";
import type { App } from "../app.ts";
import { localTokenAuth, type Authenticate, type Grant } from "../api/grant.ts";
import { mcpHandler, type McpRequestExtra } from "../api/mcp.ts";
import { isRefusal, localDoor, type Arrival, type FrontDoor, type Surface } from "./front.ts";
import { ipPrefix, Logger, type LogLine } from "./log.ts";
import { admin, apiError, clientVersionOk, health, projection, recallRoute, reposCheck, sessionStart, statusRoute, tooOld, writes, type V1Response } from "./v1.ts";

const MCP_BODY_MAX = 64 * 1024;
const V1_BODY_MAX = 1024 * 1024;

/** Routes of one surface other than the resource routes: the OAuth pages, the admin UI. */
export interface Mount {
  /** Serves the request and returns true, or returns false when the path is not one of its routes. */
  serve(req: IncomingMessage, res: ServerResponse, arrival: Arrival, log: RequestLog): boolean;
}

/** What a mount reports for the request's single log line. */
export interface RequestLog {
  readonly reqId: string;
  finish(status: number, extra?: Partial<LogLine>): void;
}

export interface HttpOptions {
  readonly app: App;
  readonly door: FrontDoor;
  readonly authenticate: Authenticate;
  readonly mounts?: Partial<Record<Surface, Mount>>;
  readonly logger?: Logger;
  readonly now?: () => number;
}

/** Every resource route; a test checks this list against the spec (route inventory). */
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

export function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
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

export async function readJson(req: IncomingMessage, max: number): Promise<unknown> {
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

export function createHttpServer(o: HttpOptions): Server {
  const { app, door } = o;
  const logger = o.logger ?? new Logger();
  const now = o.now ?? Date.now;
  const { unauthenticated, requests: perGrant } = app.limits;
  const mcp = mcpHandler(app);
  const routes = new Set<string>(ROUTES);

  return createServer((req, res) => {
    const started = now();
    const reqId = app.ctx.ids.newUlid(started);
    const url = new URL(req.url ?? "/", "http://local");
    const route = `${req.method ?? "GET"} ${url.pathname}`;
    const line: { -readonly [K in keyof LogLine]?: LogLine[K] } = { level: "info", req_id: reqId, route: url.pathname };
    const finish = (status: number, extra: Partial<LogLine> = {}): void => {
      logger.log({ ...line, ...extra, level: status >= 500 ? "error" : status >= 400 ? "warn" : "info", status, latency_ms: now() - started } as LogLine);
    };
    const reply = (r: V1Response, headers: Record<string, string> = {}): void => {
      send(res, r.status, r.body, headers);
      finish(r.status, { ...(r.op ? { op: r.op } : {}), ...(r.outcome ? { outcome: r.outcome } : {}), ...(r.status >= 400 ? { error_code: r.outcome ?? "" } : {}) });
      if (r.after) res.once("finish", () => runAfter(logger, reqId, r.after));
    };

    const arrival = door.arrive(req);
    if (isRefusal(arrival)) return reply(apiError("FORBIDDEN", arrival.refused));
    const prefix = ipPrefix(arrival.clientIp);
    if (prefix) line.ip_prefix = prefix;
    line.surface = arrival.surface;
    if (o.mounts?.[arrival.surface]?.serve(req, res, arrival, { reqId, finish })) return;
    if (arrival.surface === "admin") return reply(apiError("NOT_FOUND", "no such route"));

    // Resource routes are called by apps and tools, never by a page: a browser Origin is refused
    // in aws mode (auth-and-security.md §5.5); local mode allows its own loopback origin.
    const origin = req.headers.origin;
    if (origin !== undefined && (door.mode === "aws" || !arrival.allowedOrigins.has(origin))) return reply(apiError("FORBIDDEN", "origin not allowed"));
    const isAdmin = url.pathname.startsWith("/v1/admin/") && req.method === "POST";
    if (!routes.has(route) && !isAdmin) return reply(apiError("NOT_FOUND", "no such route"));
    if (route === "GET /v1/health") return reply(health(app));

    void (async () => {
      const grant = await o.authenticate(req, reqId, isAdmin);
      if (!grant) {
        const wait = unauthenticated.take(prefix ?? "unknown");
        if (wait > 0) return reply(apiError("RATE_LIMITED", "too many requests", { retry_after_s: wait }), { "retry-after": String(wait) });
        return reply(apiError("UNAUTHORIZED", "missing or invalid token"), { "www-authenticate": wwwAuthenticate(door) });
      }
      line.client_id = grant.clientId;
      if (grant.repoKey) line.repo_key = grant.repoKey;
      const wait = perGrant.take(grant.grantId === "local" ? grant.clientId : grant.grantId);
      if (wait > 0) return reply(apiError("RATE_LIMITED", "too many requests", { retry_after_s: wait }), { "retry-after": String(wait) });
      const version = req.headers["ma-client-version"];
      const versionHeader = typeof version === "string" ? version : null;
      if ((url.pathname.startsWith("/v1/") || versionHeader !== null) && !clientVersionOk(versionHeader)) return reply(tooOld());

      if (url.pathname === "/mcp") return serveMcp(req, res, grant);
      try {
        const body = await readJson(req, V1_BODY_MAX);
        return reply(await dispatch(app, grant, route, url, body));
      } catch (e) {
        if (e instanceof BodyTooLarge) return reply({ status: 413, body: { code: "INVALID_INPUT", message: "request body too large" }, outcome: "too_large" });
        if (e instanceof SyntaxError) return reply(apiError("INVALID_INPUT", "body is not JSON", { field: "body" }));
        throw e;
      }
    })().catch(() => {
      if (!res.headersSent) reply(apiError("INTERNAL", "internal error"));
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
      const scopes = [g.scopes.read && "memory.read", g.scopes.write && "memory.write", g.scopes.capture && "memory.capture"].filter((s): s is string => typeof s === "string");
      const answer = await mcp.fetch(web, { authInfo: { token: g.grantId, clientId: g.clientId, scopes, extra: extra as unknown as Record<string, unknown> } });
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

/** Local mode: 127.0.0.1:<port>, authenticated by the local token. */
export function localHttpServer(o: { app: App; port: number; localToken: string; logger?: Logger; now?: () => number }): Server {
  return createHttpServer({ app: o.app, door: localDoor(o.port), authenticate: localTokenAuth(o.localToken), ...(o.logger ? { logger: o.logger } : {}), ...(o.now ? { now: o.now } : {}) });
}

/** The 401 challenge: in aws mode it points the client at the protected-resource metadata (mcp-interface.md §1). */
function wwwAuthenticate(door: FrontDoor): string {
  if (door.mode === "local") return 'Bearer realm="memory-anywhere"';
  return `Bearer resource_metadata="${door.baseUrl}/.well-known/oauth-protected-resource/mcp", scope="memory.read memory.write"`;
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
