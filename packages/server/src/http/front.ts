// The front door: which surface a request is for, and who sent it, before any route is looked up
// (auth-and-security.md §2, §9; topology-and-ipc.md §2, §4).
//
//   local mode                          aws mode
//   ──────────                          ────────
//   TCP 127.0.0.1:<port>                unix socket, reached only through Caddy
//   Host 127.0.0.1:<port>|localhost     X-MA-Origin: mcp   + Host {host}        → surface "mcp"
//   → surface "mcp"                     X-MA-Origin: admin + Host admin.{host}  → surface "admin"
//   client = the socket peer            client = X-Forwarded-For (Caddy overwrites it)
//
// Caddy replaces any client-sent X-MA-Origin and X-Forwarded-For on both sites, so in aws mode
// these headers are facts about the connection. A request reaches the admin surface only when
// X-MA-Origin is exactly `admin` (S-WEB-05); anything else is refused before routing.

import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";

export type Surface = "mcp" | "admin";

export interface Arrival {
  readonly surface: Surface;
  /** The client's address: the socket peer (local) or Caddy's X-Forwarded-For (aws). */
  readonly clientIp: string | undefined;
  /** Origins a browser may send for a state-changing request on this surface. */
  readonly allowedOrigins: ReadonlySet<string>;
}

export type Refusal = { readonly refused: string };

export interface FrontDoor {
  readonly mode: "local" | "aws";
  /** The issuer and resource base, `https://{host}` (aws) or `http://127.0.0.1:<port>` (local). */
  readonly baseUrl: string;
  /** The admin origin, `https://admin.{host}` (aws) or the base URL (local, served under /admin/). */
  readonly adminUrl: string;
  arrive(req: IncomingMessage): Arrival | Refusal;
}

const header = (req: IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name];
  return typeof v === "string" ? v : undefined;
};

export function localDoor(port: number): FrontDoor {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins: ReadonlySet<string> = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    mode: "local",
    baseUrl,
    adminUrl: baseUrl,
    arrive(req) {
      if (!hosts.has(header(req, "host") ?? "")) return { refused: "host not allowed" };
      return { surface: "mcp", clientIp: req.socket.remoteAddress, allowedOrigins: origins };
    },
  };
}

/** `publicUrl` is `https://{host}`, the issuer; the admin origin is `https://admin.{host}`. */
export function awsDoor(publicUrl: string): FrontDoor {
  const url = new URL(publicUrl);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.port !== "" || url.search !== "") {
    throw new Error(`server.public_url must be https://<host> with nothing after the host, not ${publicUrl}`);
  }
  const host = url.host;
  const adminHost = `admin.${host}`;
  const baseUrl = `https://${host}`;
  const adminUrl = `https://${adminHost}`;
  const mcpOrigins: ReadonlySet<string> = new Set([baseUrl]);
  const adminOrigins: ReadonlySet<string> = new Set([adminUrl]);
  return {
    mode: "aws",
    baseUrl,
    adminUrl,
    arrive(req) {
      // Only the unix socket is served in aws mode; a TCP peer would mean a misconfiguration.
      if (req.socket.remoteAddress !== undefined) return { refused: "not through the proxy" };
      const forwarded = header(req, "x-forwarded-for");
      const clientIp = forwarded !== undefined && isIP(forwarded) !== 0 ? forwarded : undefined;
      if (clientIp === undefined) return { refused: "no client address" };
      const origin = header(req, "x-ma-origin");
      const hostHeader = header(req, "host");
      if (origin === "mcp" && hostHeader === host) return { surface: "mcp", clientIp, allowedOrigins: mcpOrigins };
      if (origin === "admin" && hostHeader === adminHost) return { surface: "admin", clientIp, allowedOrigins: adminOrigins };
      return { refused: "unknown origin" };
    },
  };
}

export const isRefusal = (a: Arrival | Refusal): a is Refusal => "refused" in a;
