// Test harness for the OAuth conformance suite (m0-spike.md §5). It starts the product server
// with both surfaces on loopback and drives it the way a vendor and the owner's browser would.
//
//   http://127.0.0.1:<p1>   the mcp surface   (production: https://{host})
//   http://127.0.0.1:<p2>   the admin surface (production: https://admin.{host})
//
// One host for both, so the passkey RP ID (127.0.0.1) covers both origins as {host} does in
// production. The server's clock is the harness clock, so tests can move time.

import { createHash, randomBytes } from "node:crypto";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Configuration } from "oidc-provider";
import { App } from "../../src/app.ts";
import { createAuth, type Auth } from "../../src/auth/index.ts";
import { ServerConfig } from "../../src/config/schema.ts";
import type { FrontDoor } from "../../src/http/front.ts";
import { Logger } from "../../src/http/log.ts";
import { createHttpServer } from "../../src/http/server.ts";
import { fakeEmbedder, testStore } from "../helpers/store.ts";
import { SoftAuthenticator } from "./authenticator.ts";

export type Issuer = Awaited<ReturnType<typeof startIssuer>>;

/** A fake clock for the server (pairing windows, refresh grace, idle lifetimes). */
export class Clock {
  offset = 0;
  now = (): number => Date.now() + this.offset;
  advance(ms: number): void {
    this.offset += ms;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createNetServer().listen(0, "127.0.0.1", () => {
      const p = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(p));
    });
  });
}

/** The two surfaces on two loopback ports, told apart by the port the request arrived on. */
function testDoor(mcpPort: number, adminPort: number): FrontDoor {
  const baseUrl = `http://127.0.0.1:${mcpPort}`;
  const adminUrl = `http://127.0.0.1:${adminPort}`;
  return {
    mode: "aws",
    baseUrl,
    adminUrl,
    arrive(req) {
      const port = req.socket.localPort;
      const host = req.headers.host;
      if (port === mcpPort && host === `127.0.0.1:${mcpPort}`) return { surface: "mcp", clientIp: req.socket.remoteAddress, allowedOrigins: new Set([baseUrl]) };
      if (port === adminPort && host === `127.0.0.1:${adminPort}`) return { surface: "admin", clientIp: req.socket.remoteAddress, allowedOrigins: new Set([adminUrl]) };
      return { refused: "unknown origin" };
    },
  };
}

/** The suite makes hundreds of OAuth requests from one address; rate limits get their own test. */
const UNTHROTTLED = { token_per_ip_per_min: 100_000, register_per_ip_per_min: 100_000, authorize_per_ip_per_min: 100_000, login_per_ip_per_min: 100_000, mcp_per_grant_per_min: 100_000, unauth_per_ip_per_min: 100_000 };

export async function startIssuer(opts: { fetch?: Configuration["fetch"]; rateLimits?: Partial<typeof UNTHROTTLED> } = {}) {
  const store = await testStore(); // on disk, in a folder with a space in its path
  const clock = new Clock();
  const ctx = { ...store, clock };
  const config = ServerConfig.parse({ rate_limits: { ...UNTHROTTLED, ...opts.rateLimits } });
  const app = new App({ db: store.db, config, embedder: fakeEmbedder, clock, ids: store.ids });
  const [mcpPort, adminPort] = [await freePort(), await freePort()];
  const door = testDoor(mcpPort, adminPort);
  const logger = new Logger(() => undefined);
  const auth: Auth = createAuth({ app, door, logger, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  const servers: Server[] = [mcpPort, adminPort].map(() => createHttpServer({ app, door, authenticate: auth.authenticate, mounts: auth.mounts, logger, now: clock.now }));
  await Promise.all(servers.map((s, i) => new Promise<void>((resolve) => s.listen(i === 0 ? mcpPort : adminPort, "127.0.0.1", resolve))));
  return {
    ...auth,
    app,
    db: ctx.db,
    clock,
    origin: door.baseUrl,
    adminOrigin: door.adminUrl,
    mcpUrl: `${door.baseUrl}/mcp`,
    /** The owner's two passkeys: a device-bound one and a second one. */
    authenticator: new SoftAuthenticator(door.adminUrl),
    second: new SoftAuthenticator(door.adminUrl),
    /** A setup token, as `setup-token --renew` would issue (read from SSM in production). */
    issueSetupToken: (): string => auth.owner.renewSetupToken(),
    async stop(): Promise<void> {
      await Promise.all(servers.map((s) => new Promise<void>((resolve) => {
        s.close(() => resolve());
        s.closeAllConnections();
      })));
      store.close();
    },
  };
}

/** A browser: cookies and CSRF tokens per origin, same-origin fetch metadata on POSTs, no automatic redirects. */
export class Browser {
  /** Cookies by origin. */
  readonly jars = new Map<string, Map<string, string>>();
  /** CSRF tokens: by consent path, and by origin for admin sessions. */
  readonly csrf = new Map<string, string>();
  private readonly origin: string;

  constructor(origin: string) {
    this.origin = origin;
  }

  /** The cookie jar of the default origin. */
  get jar(): Map<string, string> {
    return this.jarOf(this.origin);
  }

  private jarOf(origin: string): Map<string, string> {
    let jar = this.jars.get(origin);
    if (!jar) this.jars.set(origin, (jar = new Map()));
    return jar;
  }

  async fetch(pathOrUrl: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}): Promise<Response> {
    const url = new URL(pathOrUrl, this.origin);
    const jar = this.jarOf(url.origin);
    const headers: Record<string, string> = { ...init.headers };
    if (jar.size) headers["cookie"] = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    if (init.method === "POST") {
      headers["origin"] ??= url.origin;
      headers["sec-fetch-site"] ??= "same-origin";
      const consent = /^\/consent\/[^/]+/u.exec(url.pathname)?.[0];
      const token = consent ? this.csrf.get(consent) : this.csrf.get(url.origin);
      if (token) headers["x-ma-csrf"] ??= token;
    }
    const res = await fetch(url, { method: init.method ?? "GET", headers, redirect: "manual", ...(init.body !== undefined ? { body: init.body } : {}) });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(";");
      const i = pair?.indexOf("=") ?? -1;
      if (!pair || i < 1) continue;
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age=0\s*$/iu.test(a) || /^\s*expires=thu, 01 jan 1970/iu.test(a));
      if (expired || value === "") jar.delete(name);
      else jar.set(name, value);
    }
    // A page carries its CSRF token in <body data-csrf>; remember it for that consent path.
    if (res.headers.get("content-type")?.startsWith("text/html")) {
      const html = await res.clone().text();
      const token = /data-csrf="([^"]*)"/u.exec(html)?.[1];
      const consent = /^\/consent\/[^/]+/u.exec(url.pathname)?.[0];
      if (token && consent) this.csrf.set(consent, token);
    }
    return res;
  }

  async postJson(path: string, body: unknown = {}): Promise<{ status: number; data: Record<string, unknown> }> {
    const res = await this.fetch(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    // Sign-in and setup return the admin session's CSRF token.
    if (typeof data["csrf"] === "string") this.csrf.set(new URL(path, this.origin).origin, data["csrf"]);
    return { status: res.status, data };
  }
}

/** The owner: two passkeys, the recovery codes (typing one back), and an admin session. */
export async function ownerSetup(issuer: Issuer): Promise<Browser> {
  const owner = new Browser(issuer.origin);
  const token = issuer.issueSetupToken();
  const admin = (p: string): string => `${issuer.adminOrigin}${p}`;
  let codes: string[] = [];
  for (const authenticator of [issuer.authenticator, issuer.second]) {
    const options = await owner.postJson(admin("/setup/options"), { token });
    if (options.status !== 200) throw new Error(`setup options: ${JSON.stringify(options)}`);
    const verified = await owner.postJson(admin("/setup/verify"), { token, response: authenticator.create(options.data as never) });
    if (verified.status !== 200) throw new Error(`setup verify: ${JSON.stringify(verified)}`);
    codes = (verified.data["codes"] as string[] | undefined) ?? codes;
  }
  const confirmed = await owner.postJson(admin("/setup/confirm"), { token, code: codes[3] });
  if (confirmed.status !== 200) throw new Error(`setup confirm: ${JSON.stringify(confirmed)}`);
  return owner;
}

export interface WindowInfo {
  window_id: string;
  pair_code: string;
  pair_link: string;
  credentials?: { client_id: string; client_secret: string; redirect_uris: string[] };
}

/** Opens a pairing window like the admin page; `replace` ends the vendor's current grant on approval. */
export async function openWindow(issuer: Issuer, owner: Browser, body: Record<string, unknown>, bind = true): Promise<WindowInfo> {
  const url = `${issuer.adminOrigin}/api/windows`;
  const request = { replace: true, ...(body["vendor"] === "pc" && !body["machineName"] ? { machineName: "test pc" } : {}), ...body };
  let r = await owner.postJson(url, request);
  // Like the admin page: sign in again after the idle timeout, step up after 5 minutes (§3.4).
  if (r.data["error"] === "login_required") {
    const options = await owner.postJson(`${issuer.adminOrigin}/api/login/options`);
    await owner.postJson(`${issuer.adminOrigin}/api/login/verify`, issuer.authenticator.get(options.data as never));
    r = await owner.postJson(url, request);
  }
  if (r.data["error"] === "step_up_required") {
    const options = await owner.postJson(`${issuer.adminOrigin}/api/stepup/options`);
    await owner.postJson(`${issuer.adminOrigin}/api/stepup/verify`, issuer.authenticator.get(options.data as never));
    r = await owner.postJson(url, request);
  }
  if (r.status !== 200) throw new Error(`open window: ${JSON.stringify(r)}`);
  const w = r.data as unknown as WindowInfo;
  if (bind) {
    const res = await owner.fetch(w.pair_link);
    if (res.status !== 303) throw new Error(`pair link: ${res.status}`);
  }
  return w;
}

export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export interface AuthRequest {
  client_id: string;
  redirect_uri: string;
  code_challenge?: string;
  code_challenge_method?: string;
  scope?: string;
  resource?: string;
  state?: string;
  [extra: string]: string | undefined;
}

export function authUrl(issuer: Issuer, p: AuthRequest): string {
  const q = new URLSearchParams({ response_type: "code", scope: "memory.read memory.write offline_access", resource: issuer.mcpUrl, state: "st-1" });
  for (const [k, v] of Object.entries(p)) if (v !== undefined) q.set(k, v);
  return `/oauth/auth?${q}`;
}

/** Runs /oauth/auth through consent with the passkey; returns the final redirect to the client. */
export async function authorize(issuer: Issuer, browser: Browser, p: AuthRequest): Promise<URL> {
  const start = await browser.fetch(authUrl(issuer, p));
  const consentPath = start.headers.get("location");
  if (start.status !== 303 || !consentPath?.startsWith("/consent/")) throw new Error(`authorize: ${start.status} ${await start.text()}`);
  const page = await browser.fetch(consentPath);
  if (page.status !== 200) throw new Error(`consent page: ${page.status}`);
  const options = await browser.postJson(`${consentPath}/options`);
  if (options.status !== 200) throw new Error(`consent options: ${JSON.stringify(options)}`);
  const approved = await browser.postJson(`${consentPath}/approve`, issuer.authenticator.get(options.data as never, issuer.origin));
  if (approved.status !== 200) throw new Error(`approve: ${JSON.stringify(approved)}`);
  const resume = await browser.fetch(String(approved.data["redirectTo"]));
  const location = resume.headers.get("location");
  if (resume.status !== 303 || !location) throw new Error(`resume: ${resume.status} ${await resume.text()}`);
  return new URL(location, issuer.origin);
}

export async function token(issuer: Issuer, form: Record<string, string>, basic?: { id: string; secret: string }): Promise<{ status: number; data: Record<string, unknown>; raw: Response }> {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (basic) headers["authorization"] = `Basic ${Buffer.from(`${encodeURIComponent(basic.id)}:${encodeURIComponent(basic.secret)}`).toString("base64")}`;
  const raw = await fetch(`${issuer.origin}/oauth/token`, { method: "POST", headers, body: new URLSearchParams(form).toString() });
  return { status: raw.status, data: (await raw.clone().json().catch(() => ({}))) as Record<string, unknown>, raw };
}

export async function callMcp(issuer: Issuer, accessToken: string | undefined, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(issuer.mcpUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
}
