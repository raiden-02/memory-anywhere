// The route inventory probe (conformance test 15): every METHOD + path below is tried, and any
// answer other than 404 must be on the surface's allow list; every listed route must answer, so
// the list stays exact. Used against the local issuer and against a deployed stage.
//
//   https://{host}         routes.allow.txt         (resource server, OAuth, pairing, consent)
//   https://admin.{host}   routes.admin.allow.txt   (setup, recovery, the admin UI and its API)

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SAMPLE = "abcdefghijklmnop"; // fills `:name` segments; also a valid pairing-window id shape
const STEPUP_SAMPLE = "stp_01JC9Z3N4V8Q2W5X7Y9Z0A1B2C"; // a step-up request id (`:stepup`)
const MEMORY_SAMPLE = "mem_01JC9Z3N4V8Q2W5X7Y9Z0A1B2C"; // a memory id (`:memory`)
const ACTION_SAMPLE = "memory.pin"; // an admin UI action (`:action`)
const METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"];
/** Paths that must not answer on {host}: other frameworks' and the library's routes this server disables. */
const ABSENT_MCP = [
  "/", "/favicon.ico", "/robots.txt", "/mcp/", "/mcp/x", "/v1", "/v1/x", "/v1/health/x", "/sse", "/messages",
  "/.well-known/webfinger", "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/x", "/.well-known/jwks.json",
  "/oauth", "/oauth/", "/oauth/.well-known/openid-configuration", "/oauth/.well-known/oauth-authorization-server", "/oauth/.well-known/webfinger",
  "/oauth/auth/x/y", "/oauth/token/introspection", "/oauth/reg/x", "/oauth/me", "/oauth/userinfo", "/oauth/session/end",
  "/oauth/session/end/confirm", "/oauth/session/end/success", "/oauth/device", "/oauth/device/auth", "/oauth/device/x", "/oauth/request",
  "/oauth/backchannel", "/oauth/challenge", "/oauth/credential", "/oauth/interaction/x", "/interaction/x",
  "/pair", "/pair/x", "/consent", "/consent/x/y", "/admin/", "/admin/x", "/admin/api", "/admin/api/x", "/admin/api/windows/x",
  "/setup/", "/setup/x", "/setup", "/recover", "/api/x", "/api/windows", "/approve/x", "/assets/x.js",
];

/** Paths that must not answer on admin.{host}: nothing of the resource server or the OAuth flow. */
const ABSENT_ADMIN = [
  "/favicon.ico", "/robots.txt", "/mcp", "/v1/health", "/v1/status", "/oauth/auth", "/oauth/token", "/oauth/reg",
  "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp", "/pair/abcdefghijklmnop", "/consent/x",
  "/setup/", "/setup/x", "/api", "/api/", "/api/x", "/admin", "/admin/api/windows", "/assets/x.js",
];

export type Surface = "mcp" | "admin";
const FILES: Record<Surface, string> = { mcp: "routes.allow.txt", admin: "routes.admin.allow.txt" };

export interface AllowedRoute {
  method: string;
  path: string;
  re: RegExp;
}

export function allowedRoutes(surface: Surface = "mcp"): AllowedRoute[] {
  return readFileSync(join(import.meta.dirname, "..", FILES[surface]), "utf8")
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*/, "").trim())
    .filter(Boolean)
    .map((l) => {
      const [method = "", path = ""] = l.split(/\s+/);
      return { method, path, re: new RegExp(`^${path.replace(/:[a-z_]+/g, "[^/]+")}$`) };
    });
}

/** Unlisted routes that answered, and listed routes that did not. Both must be empty. */
export async function routeInventory(origin: string, surface: Surface = "mcp"): Promise<{ unlisted: string[]; silent: string[] }> {
  const allowed = allowedRoutes(surface);
  const ABSENT = surface === "mcp" ? ABSENT_MCP : ABSENT_ADMIN;
  // Some segments need a value of the right shape to reach their route; every other one takes SAMPLE.
  const sample = (a: AllowedRoute) =>
    a.path.replace(/:stepup\b/g, STEPUP_SAMPLE).replace(/:memory\b/g, MEMORY_SAMPLE).replace(/:action\b/g, ACTION_SAMPLE).replace(/:[a-z_]+/g, SAMPLE);
  const answered = new Set<string>();
  const unlisted: string[] = [];
  for (const path of [...new Set([...ABSENT, ...allowed.map(sample)])]) {
    for (const method of METHODS) {
      const withBody = method === "POST" || method === "PUT" || method === "PATCH";
      const res = await fetch(`${origin}${path}`, { method, redirect: "manual", ...(withBody ? { body: "{}", headers: { "content-type": "application/json" } } : {}) });
      await res.arrayBuffer();
      if (res.status === 404) continue;
      answered.add(`${method} ${path}`);
      if (!allowed.some((a) => a.method === method && a.re.test(path))) unlisted.push(`${method} ${path} -> ${res.status}`);
    }
  }
  return { unlisted, silent: allowed.filter((a) => !answered.has(`${a.method} ${sample(a)}`)).map((a) => `${a.method} ${a.path}`) };
}
