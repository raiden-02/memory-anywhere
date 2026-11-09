// The route inventory probe (conformance test 15): every METHOD + path below is tried, and any
// answer other than 404 must be on routes.allow.txt; every listed route must answer, so the list
// stays exact. Used against the local issuer and against a deployed stage.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SAMPLE = "abcdefghijklmnop"; // fills `:name` segments; also a valid pairing-window id shape
const METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"];
/** Paths that must not answer: other frameworks' and the library's routes this server disables. */
const ABSENT = [
  "/", "/favicon.ico", "/robots.txt", "/mcp/", "/mcp/x", "/v1", "/v1/x", "/v1/health/x", "/sse", "/messages",
  "/.well-known/webfinger", "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/x", "/.well-known/jwks.json",
  "/oauth", "/oauth/", "/oauth/.well-known/openid-configuration", "/oauth/.well-known/oauth-authorization-server", "/oauth/.well-known/webfinger",
  "/oauth/auth/x/y", "/oauth/token/introspection", "/oauth/reg/x", "/oauth/me", "/oauth/userinfo", "/oauth/session/end",
  "/oauth/session/end/confirm", "/oauth/session/end/success", "/oauth/device", "/oauth/device/auth", "/oauth/device/x", "/oauth/request",
  "/oauth/backchannel", "/oauth/challenge", "/oauth/credential", "/oauth/interaction/x", "/interaction/x",
  "/pair", "/pair/x", "/consent", "/consent/x/y", "/admin/", "/admin/x", "/admin/api", "/admin/api/x", "/admin/api/windows/x",
  "/setup/", "/setup/x", "/recover", "/api/x",
];

export interface AllowedRoute {
  method: string;
  path: string;
  re: RegExp;
}

export function allowedRoutes(): AllowedRoute[] {
  return readFileSync(join(import.meta.dirname, "..", "routes.allow.txt"), "utf8")
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*/, "").trim())
    .filter(Boolean)
    .map((l) => {
      const [method = "", path = ""] = l.split(/\s+/);
      return { method, path, re: new RegExp(`^${path.replace(/:[a-z_]+/g, "[^/]+")}$`) };
    });
}

/** Unlisted routes that answered, and listed routes that did not. Both must be empty. */
export async function routeInventory(origin: string): Promise<{ unlisted: string[]; silent: string[] }> {
  const allowed = allowedRoutes();
  const sample = (a: AllowedRoute) => a.path.replace(/:[a-z_]+/g, SAMPLE);
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
