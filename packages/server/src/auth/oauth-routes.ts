// The OAuth surface on https://{host} (auth-and-security.md §2, §4, §5): discovery, the library
// under /oauth with pairing gates around it, the pair link, and the consent page.
//
//   GET  /.well-known/oauth-protected-resource/mcp    resource metadata
//   GET  /.well-known/oauth-authorization-server      ┐ the library's discovery, narrowed to
//   GET  /.well-known/openid-configuration            ┘ what this server supports
//   *    /oauth/{auth, auth/:uid, token, reg, token/revocation, jwks}   the library, gated
//   GET  /pair/:id?t=…                                 binds this browser to the open window
//   GET  /consent/:uid   POST /consent/:uid/{code, options, approve, deny}
//
// The gates run as library middleware. Before it, they decide whether the request may proceed:
// /reg and /auth only inside the open window for that client. After it, every failure of /reg
// and /auth becomes one response, so a prober cannot tell whether a window is open (§4.1 step 4).
// /token keeps RFC 6749 errors (spec-issues #16) and adds the refresh grace and the idle limit.

import type { IncomingMessage, ServerResponse } from "node:http";
import { loginCode } from "@memory-anywhere/contracts/login-code";
import type Provider from "oidc-provider";
import type { App } from "../app.ts";
import type { Arrival, FrontDoor } from "../http/front.ts";
import type { Logger } from "../http/log.ts";
import { RateLimiter } from "../http/rate.ts";
import type { Mount, RequestLog } from "../http/server.ts";
import { ipPrefix } from "../http/log.ts";
import { iso } from "../store/clock.ts";
import { prepared } from "../store/db.ts";
import { cookies, csrfFor, csrfOk, PAGE_HEADERS, readPageJson, sendJson, sendPage, serveAsset } from "../web/pages.ts";
import { sha256Hex } from "./adapter.ts";
import { ensurePolicy, pinRedirect, recordGrant } from "./clients.ts";
import type { Pairing, PairingWindow } from "./pairing.ts";
import type { Passkeys } from "./passkeys.ts";
import { ERROR_PAGE, lifetimeFor } from "./provider.ts";
import { cimdVendorFor, httpsOnHost, isLoopback, PC_CLIENT_ID, PC_SCOPE, VENDOR_SCOPE, VENDORS } from "./vendors.ts";

/** The Koa context the library hands its middleware. */
type Ctx = Parameters<Parameters<Provider["use"]>[0]>[0];

const REFRESH_GRACE_MS = 30_000;
const BODY_LIMIT = 56 * 1024;
const DCR_FIELDS = new Set(["redirect_uris", "client_name", "grant_types", "response_types", "token_endpoint_auth_method", "application_type"]);
const DCR_GRANTS = new Set(["authorization_code", "refresh_token"]);
const DCR_AUTH = new Set(["none", "client_secret_post", "client_secret_basic"]);
const INVALID_REQUEST = JSON.stringify({ error: "invalid_request" });
/** The library routes that answer, relative to its /oauth mount (routes.allow.txt). */
const PROVIDER_ROUTES: readonly (readonly [string, RegExp])[] = [
  ["GET", /^\/auth$/u],
  ["POST", /^\/auth$/u],
  ["GET", /^\/auth\/[A-Za-z0-9_-]+$/u],
  ["POST", /^\/token$/u],
  ["POST", /^\/reg$/u],
  ["POST", /^\/token\/revocation$/u],
  ["GET", /^\/jwks$/u],
];
const PAIR_COOKIE = "__Host-ma_pair";

export interface OAuthRoutesOptions {
  readonly app: App;
  readonly door: FrontDoor;
  readonly provider: Provider;
  readonly pairing: Pairing;
  readonly passkeys: Passkeys;
  readonly logger: Logger;
}

export function oauthRoutes(o: OAuthRoutesOptions): Mount {
  const { app, door, provider, pairing, passkeys, logger } = o;
  const { ctx } = app;
  const now = (): number => ctx.clock.now();
  const issuer = door.baseUrl;
  const issuerHost = new URL(issuer).hostname;
  const mcpUrl = `${issuer}/mcp`;
  const secret = (prepared(ctx.db, "SELECT value FROM meta WHERE key = 'cookie_secret'").get() as { value: string }).value;
  const callback = provider.callback();
  const limits = app.config.rate_limits;
  const tokenLimit = new RateLimiter(limits.token_per_ip_per_min, 60_000, now);
  const regLimit = new RateLimiter(limits.register_per_ip_per_min, 60_000, now);
  const authLimit = new RateLimiter(limits.authorize_per_ip_per_min, 60_000, now);
  /** Refresh grace (§5.3): the response to a rotation, served again for 30 s. Memory only: it holds live tokens (spec-issues #18). */
  const grace = new Map<string, { body: string; expires: number }>();

  // ---- who may do what inside the open window ----

  function authorizationAllowed(w: PairingWindow | undefined, clientId: string): w is PairingWindow {
    if (!w || !clientId) return false;
    if (w.vendor === "pc") return clientId === PC_CLIENT_ID;
    if (clientId === PC_CLIENT_ID) return false;
    if (w.registered_client_id) return w.registered_client_id === clientId;
    return w.method === "cimd" && cimdVendorFor(clientId) === w.vendor;
  }

  /** An https redirect this window's vendor may register or use. */
  function vendorRedirect(w: PairingWindow, uri: string): boolean {
    const rule = VENDORS[w.vendor];
    if (w.vendor === "other") return !!w.allowed_redirect_host && httpsOnHost(uri, w.allowed_redirect_host);
    if (rule.redirectRule) return rule.redirectRule(issuerHost).test(uri);
    return rule.redirects.includes(uri);
  }

  /** DCR inside a window (§4.3). A redirect foreign to the vendor closes the window (§4.1 step 5). */
  function dcrAllowed(w: PairingWindow | undefined, meta: Record<string, unknown> | undefined): boolean {
    if (!w || w.method !== "dcr" || !meta) return false;
    if (Object.keys(meta).some((k) => !DCR_FIELDS.has(k))) return false;
    const uris = meta["redirect_uris"];
    if (!Array.isArray(uris) || uris.length < 1 || uris.length > 2 || !uris.every((u): u is string => typeof u === "string")) return false;
    const name = meta["client_name"];
    if (name !== undefined && (typeof name !== "string" || name.length > 64)) return false;
    const grants = meta["grant_types"];
    if (grants !== undefined && (!Array.isArray(grants) || !grants.every((g) => DCR_GRANTS.has(g as string)))) return false;
    const types = meta["response_types"];
    if (types !== undefined && (!Array.isArray(types) || types.length !== 1 || types[0] !== "code")) return false;
    const auth = meta["token_endpoint_auth_method"];
    if (auth !== undefined && !DCR_AUTH.has(auth as string)) return false;
    const https = uris.every((u) => vendorRedirect(w, u));
    const loopback = uris.every(isLoopback);
    // RFC 7591 §2: an omitted application_type is "web" (spec-issues #19); a loopback redirect
    // still needs an explicit "native" in an Other desktop-app window.
    const appType = meta["application_type"] ?? "web";
    const ok = (https && appType === "web") || (loopback && w.vendor === "other" && w.desktop === 1 && appType === "native");
    if (!ok) {
      if (!https && !loopback) {
        pairing.close(w.id, "registration_race");
        app.alerts.raise("pairing_race", { vendor: w.vendor, cause: "foreign_redirect" });
      }
      return false;
    }
    if (pairing.takeRegistrationSlot(w.id)) return true;
    app.alerts.raise("pairing_race", { vendor: w.vendor, cause: "second_registration" });
    return false;
  }

  // ---- gates around the library ----

  provider.use(async (c, next) => {
    const path = c.path;
    const discovery = (c.req as { maDiscovery?: boolean }).maDiscovery === true;
    // Only the routes this server uses answer (§4.7, §5.1): the library registers more than its feature flags suggest.
    if (!discovery && !PROVIDER_ROUTES.some(([m, re]) => m === c.method && re.test(path))) {
      c.status = 404;
      c.body = { error: "not_found" };
      return;
    }
    const w = pairing.active();

    if (path === "/reg") {
      const meta = parseBody(c.req, await providerBody(c).catch(() => undefined));
      if (!dcrAllowed(w, meta)) return rejectJson(c);
      await next();
      if (c.status >= 400) return rejectJson(c);
      const clientId = (c.body as { client_id?: string } | undefined)?.client_id;
      if (w && clientId) pairing.attachClient(w.id, clientId);
      return;
    }

    if (path === "/auth") {
      const raw = c.method === "POST" ? await providerBody(c).catch(() => undefined) : "";
      const params = c.method === "POST" ? new URLSearchParams(raw ?? "") : new URLSearchParams(c.querystring);
      const mode = params.get("response_mode");
      if (raw === undefined || (mode !== null && mode !== "query") || params.has("request") || params.has("request_uri")) return rejectPage(c);
      const clientId = params.get("client_id") ?? "";
      if (!authorizationAllowed(w, clientId)) return rejectPage(c);
      // Gemini's static client learns its per-user redirect from its first request (ADR-0107, spec-issues #59).
      if (w.vendor === "gemini" && w.method === "static") {
        const redirect = params.get("redirect_uri") ?? "";
        if (!vendorRedirect(w, redirect)) return rejectPage(c);
        const client = await provider.Client.find(clientId);
        if (client && !client.redirectUris?.includes(redirect)) await pinRedirect(provider, clientId, redirect);
      }
      await next();
      // Errors are shown as the page and never redirected (§4.1 step 4; RFC 9700 §2.1).
      const location = c.response.get("location");
      if (c.status >= 400 || (location && new URL(location, issuer).searchParams.has("error"))) rejectPage(c);
      return;
    }

    if (path === "/token" && c.method === "POST") return tokenGate(c, next);

    await next();
    if (discovery && c.status === 200 && c.body && typeof c.body === "object") {
      // §4.7: what the library publishes, narrowed to what this server supports.
      c.body = {
        ...(c.body as Record<string, unknown>),
        response_types_supported: ["code"],
        response_modes_supported: ["query"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
        client_id_metadata_document_supported: true,
        authorization_response_iss_parameter_supported: true,
        scopes_supported: ["memory.read", "memory.write", "memory.capture", "offline_access"],
      };
    }
  });

  /** /token: client_secret_post as Basic, the 30 s refresh grace, the idle limit, reuse detection. */
  async function tokenGate(c: Ctx, next: () => Promise<void>): Promise<void> {
    const raw = await providerBody(c).catch(() => undefined);
    if (raw === undefined) {
      c.status = 400;
      c.body = { error: "invalid_request" };
      return;
    }
    const form = new URLSearchParams(raw);
    // Static clients are registered as client_secret_basic; accept client_secret_post for them too.
    const clientSecret = form.get("client_secret");
    const formClientId = form.get("client_id");
    if (clientSecret && formClientId && !c.get("authorization")) {
      c.req.headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(formClientId)}:${encodeURIComponent(clientSecret)}`).toString("base64")}`;
      form.delete("client_secret");
      form.delete("client_id");
      (c.req as { body?: string }).body = form.toString();
    }
    const refresh = form.get("grant_type") === "refresh_token" ? form.get("refresh_token") : null;
    const key = refresh ? sha256Hex(refresh) : undefined;
    const cached = key ? grace.get(key) : undefined;
    if (cached && cached.expires > now()) {
      c.status = 200;
      c.type = "application/json; charset=utf-8";
      c.set({ "cache-control": "no-store", pragma: "no-cache" });
      c.body = cached.body;
      return;
    }
    if (key) {
      const row = prepared(ctx.db, "SELECT grant_id, consumed_at, payload_json FROM oidc_store WHERE model = 'RefreshToken' AND id = ?").get(key) as
        | { grant_id: string | null; consumed_at: string | null; payload_json: string }
        | undefined;
      if (row?.consumed_at) app.alerts.raise("refresh_reuse", { grant: row.grant_id ?? "" });
      if (row?.grant_id && !row.consumed_at && idleExpired(row.grant_id, JSON.parse(row.payload_json) as { clientId?: string })) {
        endGrant(row.grant_id);
        c.status = 400;
        c.body = { error: "invalid_grant", error_description: "grant request is invalid" };
        return;
      }
    }
    await next();
    if (key && c.status === 200) {
      for (const [k, v] of grace) if (v.expires <= now()) grace.delete(k);
      grace.set(key, { body: JSON.stringify(c.body), expires: now() + REFRESH_GRACE_MS });
      const grantId = (prepared(ctx.db, "SELECT grant_id FROM oidc_store WHERE model = 'RefreshToken' AND id = ?").get(key) as { grant_id: string | null } | undefined)?.grant_id;
      if (grantId) prepared(ctx.db, "UPDATE grant_meta SET last_used_at = ? WHERE grant_id = ?").run(iso(now()), grantId);
    }
  }

  /** §5.2 idle limit: no use of the grant (refresh or request) for longer than its client kind allows. */
  function idleExpired(grantId: string, token: { clientId?: string }): boolean {
    const g = prepared(ctx.db, "SELECT g.last_used_at, s.payload_json FROM grant_meta g LEFT JOIN oidc_store s ON s.model = 'Client' AND s.id = ? WHERE g.grant_id = ?")
      .get(token.clientId ?? "", grantId) as { last_used_at: string | null; payload_json: string | null } | undefined;
    if (!g?.last_used_at) return false;
    const method = g.payload_json ? (JSON.parse(g.payload_json) as { token_endpoint_auth_method?: string }).token_endpoint_auth_method : undefined;
    return Date.parse(g.last_used_at) + lifetimeFor(token.clientId ?? "", method).idleMs <= now();
  }

  function endGrant(grantId: string): void {
    prepared(ctx.db, "UPDATE grant_meta SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL").run(iso(now()), grantId);
    prepared(ctx.db, "DELETE FROM oidc_store WHERE grant_id = ?").run(grantId);
  }

  // The library's reasons stay in the log; clients only see the normalised response.
  const logError = (op: string) => (_c: unknown, err: Error & { error?: string }) => logger.log({ level: "warn", op, error_code: err.error ?? "server_error" });
  provider.on("authorization.error", logError("authorization.error"));
  provider.on("grant.error", logError("grant.error"));
  provider.on("registration_create.error", logError("registration_create.error"));
  provider.on("revocation.error", logError("revocation.error"));
  provider.on("server_error", logError("server_error"));

  function runProvider(req: IncomingMessage, res: ServerResponse, path: string, discovery = false): void {
    const r = req as IncomingMessage & { originalUrl?: string; maDiscovery?: boolean };
    r.url = path;
    r.originalUrl = `/oauth${path}`; // the library derives its mount path, and so every endpoint URL, from this
    if (discovery) r.maDiscovery = true;
    void callback(req, res);
  }

  // ---- consent (§4.6) ----

  async function consent(req: IncomingMessage, res: ServerResponse, uid: string, action: string, done: (status: number) => void): Promise<void> {
    const errorPage = (): void => {
      sendPage(res, 400, "error", { title: "Request not valid", page: "error" });
      done(400);
    };
    const details = await provider.interactionDetails(req, res).catch(() => undefined);
    if (!details || details.uid !== uid) return errorPage();
    const clientId = String(details.params["client_id"] ?? "");
    const w = pairing.active();
    if (!authorizationAllowed(w, clientId)) return errorPage();
    const bound = pairing.cookieMatches(w.id, cookies(req)[PAIR_COOKIE]);
    const base = `/consent/${encodeURIComponent(uid)}`;
    const subject = `consent:${uid}`;

    if (action === "") {
      if (!bound) {
        sendPage(res, 200, "consent-code", { title: "Pairing code", page: "consent-code", csrf: csrfFor(secret, subject), base });
        return done(200);
      }
      const client = await provider.Client.find(clientId);
      const name = client?.metadata()["client_name"];
      const redirectUri = String(details.params["redirect_uri"] ?? "");
      const minutes = Math.max(0, Math.round((now() - Date.parse(w.opened_at)) / 60_000));
      sendPage(res, 200, "consent", {
        title: "Approve connection",
        page: "consent",
        csrf: csrfFor(secret, subject),
        base,
        vendor: VENDORS[w.vendor].label,
        redirectHost: URL.parse(redirectUri)?.host ?? redirectUri,
        redirectUri,
        clientName: typeof name === "string" && w.vendor !== "pc" ? name : undefined,
        pcCode: w.vendor === "pc" ? loginCode(String(details.params["code_challenge"] ?? "")) : undefined,
        scope: clientId === PC_CLIENT_ID ? "read, save and capture memories" : w.vendor === "other" && w.other_write === 0 ? "read memories" : "read and save memories",
        age: `Window opened ${minutes === 0 ? "less than a minute" : `${minutes} minute${minutes === 1 ? "" : "s"}`} ago.`,
      });
      return done(200);
    }

    const json = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
      sendJson(res, status, body, headers);
      done(status);
    };
    if (!csrfOk(req, issuer, secret, subject)) return json(403, { error: "csrf" });
    const body = (await readPageJson(req)) ?? {};
    if (action === "code") {
      const token = pairing.enterCode(w.id, String(body["code"] ?? ""));
      if (!token) return json(403, { error: "wrong_code" });
      return json(200, { ok: true }, { "set-cookie": `${PAIR_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600` });
    }
    if (!bound) return json(403, { error: "pair_code_required" }); // conformance test 19
    if (action === "options") return json(200, await passkeys.assertionOptions(subject));
    if (action === "deny") {
      pairing.close(w.id, "denied");
      const redirectTo = await provider.interactionResult(req, res, { error: "access_denied", error_description: "The owner denied the request." }, { mergeWithLastSubmission: false });
      return json(200, { redirectTo });
    }
    if (action === "approve") {
      if (!(await passkeys.verify(subject, body as never))) return json(403, { error: "passkey_failed" });
      if (!w.registered_client_id) pairing.attachClient(w.id, clientId);
      const policyClientId = ensurePolicy(ctx, app.config, w, clientId);
      const grant = new provider.Grant({ accountId: "owner", clientId });
      // Grant the OpenID scopes the request asked for (Grok asks for `openid`, ADR-0108), or the
      // library opens a second consent for the same authorization.
      const missing = (details.prompt.details as { missingOIDCScope?: string[] }).missingOIDCScope ?? [];
      grant.addOIDCScope(["offline_access", ...missing.filter((s) => s === "openid")].join(" "));
      const scope = clientId === PC_CLIENT_ID ? PC_SCOPE : w.vendor === "other" && w.other_write === 0 ? "memory.read" : VENDOR_SCOPE;
      grant.addResourceScope(mcpUrl, scope);
      const grantId = await grant.save();
      recordGrant(ctx, app.alerts, w, policyClientId, grantId);
      pairing.close(w.id, "granted");
      const redirectTo = await provider.interactionResult(req, res, { login: { accountId: "owner" }, consent: { grantId } }, { mergeWithLastSubmission: false });
      return json(200, { redirectTo });
    }
    return errorPage();
  }

  return {
    serve(req: IncomingMessage, res: ServerResponse, arrival: Arrival, log: RequestLog): boolean {
      const url = new URL(req.url ?? "/", issuer);
      const path = url.pathname;
      const ip = ipPrefix(arrival.clientIp) ?? "unknown";
      const finish = (status: number, op: string): void => log.finish(status, { op });
      const limited = (limiter: RateLimiter): boolean => {
        const wait = limiter.take(ip);
        if (wait <= 0) return false;
        sendJson(res, 429, { error: "rate_limited" }, { "retry-after": String(wait) });
        finish(429, "rate_limited");
        return true;
      };
      const afterResponse = (op: string): void => {
        res.once("finish", () => finish(res.statusCode, op));
      };

      if (serveAsset(req, res, path)) {
        finish(200, "asset");
        return true;
      }
      if (path === "/.well-known/oauth-protected-resource/mcp" && req.method === "GET") {
        sendJson(res, 200, { resource: mcpUrl, authorization_servers: [issuer], scopes_supported: ["memory.read", "memory.write"], bearer_methods_supported: ["header"] });
        finish(200, "discovery");
        return true;
      }
      if ((path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration") && req.method === "GET") {
        afterResponse("discovery");
        runProvider(req, res, "/.well-known/openid-configuration", true);
        return true;
      }
      if (path.startsWith("/oauth/")) {
        const sub = path.slice("/oauth".length);
        if (sub === "/token" && limited(tokenLimit)) return true;
        if (sub === "/reg" && limited(regLimit)) return true;
        if (sub.startsWith("/auth") && limited(authLimit)) return true;
        afterResponse(`oauth${sub.split("/").slice(0, 2).join("/")}`);
        runProvider(req, res, `${sub}${url.search}`);
        return true;
      }
      const pair = /^\/pair\/([A-Za-z0-9_-]{16})$/u.exec(path);
      if (pair?.[1] && req.method === "GET") {
        if (limited(authLimit)) return true;
        const t = url.searchParams.get("t") ?? undefined;
        if (!pairing.cookieMatches(pair[1], t)) {
          sendPage(res, 400, "error", { title: "Request not valid", page: "error" });
          finish(400, "pair");
          return true;
        }
        res.writeHead(303, { location: `${door.adminUrl}/`, "set-cookie": `${PAIR_COOKIE}=${t}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`, "cache-control": "no-store" });
        res.end();
        finish(303, "pair");
        return true;
      }
      const c = /^\/consent\/([A-Za-z0-9_-]{1,64})(?:\/(code|options|approve|deny))?$/u.exec(path);
      if (c?.[1] && req.method === (c[2] ? "POST" : "GET")) {
        if (limited(authLimit)) return true;
        consent(req, res, c[1], c[2] ?? "", (status) => finish(status, "consent")).catch(() => {
          if (!res.headersSent) sendJson(res, 500, { error: "server_error" });
          finish(500, "consent");
        });
        return true;
      }
      return false;
    },
  };
}

// ---- library request helpers ----

async function providerBody(c: Ctx): Promise<string> {
  const req = c.req as IncomingMessage & { body?: string };
  if (req.body !== undefined) return req.body;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new Error("request body too large");
    chunks.push(chunk);
  }
  req.body = Buffer.concat(chunks).toString("utf8");
  return req.body;
}

function parseBody(req: IncomingMessage, raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  const type = req.headers["content-type"] ?? "";
  try {
    if (type.startsWith("application/json")) {
      const v: unknown = raw ? JSON.parse(raw) : {};
      return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
    }
    if (type.startsWith("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(raw));
  } catch {
    return undefined;
  }
  return undefined;
}

/** The one failure response of /oauth/reg (§4.1 step 4). */
function rejectJson(c: Ctx): void {
  for (const h of Object.keys(c.response.headers)) c.remove(h);
  c.status = 400;
  c.type = "application/json; charset=utf-8";
  c.set("cache-control", "no-store");
  c.body = INVALID_REQUEST;
}

/** The one failure response of /oauth/auth: the error page, never a redirect. */
function rejectPage(c: Ctx): void {
  for (const h of Object.keys(c.response.headers)) c.remove(h);
  c.status = 400;
  c.type = "text/html; charset=utf-8";
  c.set(PAGE_HEADERS);
  c.body = ERROR_PAGE;
}
