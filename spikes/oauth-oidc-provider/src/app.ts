// The OAuth spike's HTTP surface (auth-and-security.md §2, §4, §5.5): one origin serving
// discovery, the provider under /oauth with the pairing gates in front of it, /pair, /consent, the
// spike's /setup and /admin pages, and a bearer-protected /mcp. Any other route answers 404
// (conformance test 15, packages/server/test/routes.allow.txt).
//
// The gates run as oidc-provider middleware (provider.use): before the library they decide
// whether a request may proceed; after it they normalise every failure on /reg and /auth to one
// response, so a prober cannot tell whether a pairing window is open (§4.1 step 4).

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { toNodeHandler, type NodeIncomingMessageLike } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type Provider from "oidc-provider";
import type { Configuration } from "oidc-provider";

/** The Koa context the provider hands its middleware. */
type Ctx = Parameters<Parameters<Provider["use"]>[0]>[0];
import { createStubServer } from "../../stub-server/src/mcp.ts";
import { JsonlStore } from "../../stub-server/src/store.ts";
import { cimdVendorFor, isLoopback, PC_CLIENT_ID, REFRESH_GRACE_SECONDS, VENDORS, type Method, type Vendor } from "./config.ts";
import { issueSetupToken as issueSetupTokenIn, openDb, sha256 } from "./db.ts";
import { Pairing, type PairingWindow } from "./pairing.ts";
import { Passkeys } from "./passkey.ts";
import { adminPage, consentPage, setupPage } from "./pages.ts";
import { createProvider, ERROR_PAGE } from "./provider.ts";

export interface AppOptions {
  /** https://spike.{host} on the instance; http://127.0.0.1:<port> in tests. */
  publicOrigin: string;
  dataDir: string;
  version: string;
  /** Tests only: replaces the network for CIMD fetches. */
  fetch?: Configuration["fetch"];
  now?: () => number;
  /** One JSON line per request on stdout (the instance's journal); off in tests. */
  accessLog?: boolean;
}

const DCR_FIELDS = new Set(["redirect_uris", "client_name", "grant_types", "response_types", "token_endpoint_auth_method", "application_type"]);
const DCR_GRANTS = new Set(["authorization_code", "refresh_token"]);
const DCR_AUTH = new Set(["none", "client_secret_post", "client_secret_basic"]);
const ADMIN_IDLE_MS = 30 * 60_000;
const ADMIN_ABSOLUTE_MS = 12 * 3_600_000;
const STEP_UP_MS = 5 * 60_000;
const SETUP_TOKEN_MS = 30 * 60_000;
const BODY_LIMIT = 56 * 1024;
const PAGE_HEADERS = {
  "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};
const INVALID_REQUEST = JSON.stringify({ error: "invalid_request" });
/** The provider routes that may answer, relative to its /oauth mount (routes.allow.txt). */
const PROVIDER_ROUTES: [string, RegExp][] = [
  ["GET", /^\/auth$/],
  ["POST", /^\/auth$/],
  ["GET", /^\/auth\/[A-Za-z0-9_-]+$/], // resume after consent
  ["POST", /^\/token$/],
  ["POST", /^\/reg$/],
  ["POST", /^\/token\/revocation$/],
  ["GET", /^\/jwks$/],
];

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseBody(req: IncomingMessage, raw: string): Record<string, unknown> | undefined {
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

function send(res: ServerResponse, status: number, body: string, type: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "content-length": String(Buffer.byteLength(body)), ...headers });
  res.end(body);
}
const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) =>
  send(res, status, JSON.stringify(body), "application/json; charset=utf-8", headers);
const html = (res: ServerResponse, status: number, body: string) => send(res, status, body, "text/html; charset=utf-8", PAGE_HEADERS);
const notFound = (res: ServerResponse) => json(res, 404, { error: "not_found" });

/** The one failure response of /oauth/reg (§4.1 step 4). */
function rejectJson(ctx: Ctx): void {
  for (const h of Object.keys(ctx.response.headers)) ctx.remove(h);
  ctx.status = 400;
  ctx.type = "application/json; charset=utf-8";
  ctx.set("cache-control", "no-store");
  ctx.body = INVALID_REQUEST;
}
/** The one failure response of /oauth/auth: the error page, never a redirect. */
function rejectPage(ctx: Ctx): void {
  for (const h of Object.keys(ctx.response.headers)) ctx.remove(h);
  ctx.status = 400;
  ctx.type = "text/html; charset=utf-8";
  ctx.set({ "cache-control": "no-store", ...PAGE_HEADERS });
  ctx.body = ERROR_PAGE;
}

/** The provider's request body: read once here so the gates can inspect it, then handed on. */
async function providerBody(ctx: Ctx): Promise<string> {
  const req = ctx.req as IncomingMessage & { body?: string };
  if (req.body === undefined) req.body = await readBody(req);
  return req.body;
}

export function createApp(opts: AppOptions) {
  const now = opts.now ?? (() => Date.now());
  const origin = opts.publicOrigin.replace(/\/$/, "");
  const mcpUrl = `${origin}/mcp`;
  const db = openDb(join(opts.dataDir, "oauth.db"));
  const pairing = new Pairing(db, now);
  const passkeys = new Passkeys(db, new URL(origin).hostname, [origin]);
  const provider = createProvider({ issuer: origin, mcpUrl, db, pairing, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  const store = new JsonlStore(join(opts.dataDir, "stub-memories.jsonl"));
  const mcpNode = toNodeHandler(createMcpHandler(() => createStubServer({ version: opts.version, store, client: "oauth" }), { legacy: "stateless" }));
  const callback = provider.callback();
  /** Refresh grace (§5.3): the response to a rotation, served again for 30 s. Memory only: it holds live tokens. */
  const grace = new Map<string, { body: string; expires: number }>();

  // ---- who may do what inside the open window ----

  /** May this client_id run an authorization now? */
  function authorizationAllowed(w: PairingWindow | undefined, clientId: string): boolean {
    if (!w || !clientId) return false;
    if (w.vendor === "pc") return clientId === PC_CLIENT_ID;
    if (clientId === PC_CLIENT_ID) return false;
    if (w.client_id) return w.client_id === clientId;
    return w.method === "cimd" && cimdVendorFor(clientId) === w.vendor;
  }

  /** DCR inside a window (§4.3). A redirect off the vendor's hosts closes the window (§4.1 step 5). */
  function dcrAllowed(w: PairingWindow | undefined, meta: Record<string, unknown> | undefined): boolean {
    if (!w || w.method !== "dcr" || !meta) return false;
    if (Object.keys(meta).some((k) => !DCR_FIELDS.has(k))) return false;
    const uris = meta["redirect_uris"];
    if (!Array.isArray(uris) || uris.length < 1 || uris.length > 2 || !uris.every((u) => typeof u === "string")) return false;
    const name = meta["client_name"];
    if (name !== undefined && (typeof name !== "string" || name.length > 64)) return false;
    const grants = meta["grant_types"];
    if (grants !== undefined && (!Array.isArray(grants) || !grants.every((g) => DCR_GRANTS.has(g as string)))) return false;
    const types = meta["response_types"];
    if (types !== undefined && (!Array.isArray(types) || types.length !== 1 || types[0] !== "code")) return false;
    const auth = meta["token_endpoint_auth_method"];
    if (auth !== undefined && !DCR_AUTH.has(auth as string)) return false;
    const hosts = w.vendor === "other" ? (w.other_host ? [w.other_host] : []) : VENDORS[w.vendor].redirectHosts;
    const onHosts = (u: string) => {
      const p = URL.parse(u);
      return !!p && p.protocol === "https:" && hosts.includes(p.hostname) && !p.username && !p.password && !p.hash;
    };
    const https = uris.every(onHosts);
    const loopback = uris.every((u: string) => isLoopback(u));
    // RFC 7591 §2: an omitted application_type means "web" (Grok omits it, M0 Q11); a loopback
    // redirect still needs an explicit "native" in a desktop-app window.
    const appType = meta["application_type"] ?? "web";
    const ok = (https && appType === "web") || (loopback && w.desktop === 1 && w.vendor === "other" && appType === "native");
    if (!ok) {
      if (!https && !loopback) pairing.close(w.id, "registration_race"); // foreign redirect
      return false;
    }
    return pairing.takeRegistrationSlot(w.id);
  }

  // ---- gates, run by the provider around its own routes ----

  provider.use(async (ctx, next) => {
    const path = ctx.path;
    const discovery = (ctx.req as { maDiscovery?: boolean }).maDiscovery === true;
    // Only the provider routes this server uses answer (§4.7, §5.1); the library registers more
    // (session end confirm, RFC 7592 client reads) than its feature flags suggest.
    if (!discovery && !PROVIDER_ROUTES.some(([m, re]) => m === ctx.method && re.test(path))) {
      ctx.status = 404;
      ctx.body = { error: "not_found" };
      return;
    }
    const w = pairing.active();

    if (path === "/reg") {
      const raw = await providerBody(ctx).catch(() => undefined);
      const meta = raw === undefined ? undefined : parseBody(ctx.req, raw);
      // What each vendor registers with (M0 config/vendors.json): field names and the non-secret values.
      console.log(JSON.stringify({
        event: "dcr_request",
        window: w ? `${w.vendor}/${w.method}` : null,
        fields: meta ? Object.keys(meta) : null,
        redirect_uris: meta?.["redirect_uris"],
        application_type: meta?.["application_type"],
        token_endpoint_auth_method: meta?.["token_endpoint_auth_method"],
        grant_types: meta?.["grant_types"],
        client_name: meta?.["client_name"],
      }));
      if (!dcrAllowed(w, meta)) return rejectJson(ctx);
      await next();
      if (ctx.status >= 400) rejectJson(ctx);
      return;
    }

    if (path === "/auth") {
      const raw = ctx.method === "POST" ? await providerBody(ctx).catch(() => undefined) : "";
      const params = ctx.method === "POST" ? new URLSearchParams(raw ?? "") : new URLSearchParams(ctx.querystring);
      const mode = params.get("response_mode");
      if (raw === undefined || (mode !== null && mode !== "query") || params.has("request") || params.has("request_uri")) return rejectPage(ctx);
      if (!authorizationAllowed(w, params.get("client_id") ?? "")) return rejectPage(ctx);
      await next();
      // Errors are shown as the page and never redirected (§4.1 step 4; RFC 9700 §2.1).
      const location = ctx.response.get("location");
      if (ctx.status >= 400 || (location && new URL(location, origin).searchParams.has("error"))) rejectPage(ctx);
      return;
    }

    if (path === "/token" && ctx.method === "POST") {
      const raw = await providerBody(ctx).catch(() => undefined);
      if (raw === undefined) {
        ctx.status = 400;
        ctx.body = { error: "invalid_request" };
        return;
      }
      const form = new URLSearchParams(raw);
      // Static clients are registered as client_secret_basic; accept client_secret_post for them too.
      const secret = form.get("client_secret");
      const id = form.get("client_id");
      if (secret && id && !ctx.get("authorization")) {
        ctx.req.headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString("base64")}`;
        form.delete("client_secret");
        form.delete("client_id");
        (ctx.req as { body?: string }).body = form.toString();
      }
      const refresh = form.get("grant_type") === "refresh_token" ? form.get("refresh_token") : null;
      const key = refresh ? sha256(refresh) : undefined;
      const cached = key ? grace.get(key) : undefined;
      if (cached && cached.expires > now()) {
        ctx.status = 200;
        ctx.type = "application/json; charset=utf-8";
        ctx.set({ "cache-control": "no-store", pragma: "no-cache" });
        ctx.body = cached.body;
        return;
      }
      await next();
      if (key && ctx.status === 200) {
        for (const [k, v] of grace) if (v.expires <= now()) grace.delete(k);
        grace.set(key, { body: JSON.stringify(ctx.body), expires: now() + REFRESH_GRACE_SECONDS * 1000 });
      }
      return;
    }

    await next();

    if (discovery && ctx.status === 200 && ctx.body && typeof ctx.body === "object") {
      // §4.7: what the provider publishes, narrowed to what this server supports.
      ctx.body = {
        ...(ctx.body as Record<string, unknown>),
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

  // The library's own reasons stay in the log; clients only ever see the normalised response.
  const logError = (event: string) => (_ctx: unknown, err: Error & { error?: string | undefined; error_description?: string | undefined }) =>
    console.error(JSON.stringify({ event, error: err.error ?? "server_error", description: err.error_description ?? err.message }));
  provider.on("authorization.error", logError("authorization.error"));
  provider.on("grant.error", logError("grant.error"));
  provider.on("registration_create.error", logError("registration_create.error"));
  provider.on("revocation.error", logError("revocation.error"));
  provider.on("server_error", logError("server_error"));

  // A registration attaches its client to the window it was made in (§4.1).
  provider.on("registration_create.success", (_ctx: unknown, client: { clientId: string }) => {
    const w = pairing.active();
    if (w) pairing.attachClient(w.id, client.clientId);
  });

  function runProvider(req: IncomingMessage, res: ServerResponse, path: string, discovery = false): void {
    const r = req as IncomingMessage & { originalUrl?: string; maDiscovery?: boolean };
    r.url = path;
    r.originalUrl = `/oauth${path}`; // the provider derives its mount path, and so every endpoint URL, from this
    if (discovery) r.maDiscovery = true;
    void callback(req, res);
  }

  // ---- owner sessions (spike: on the same origin; the product uses admin.{host}, §2) ----

  const issueSetupToken = (): string => issueSetupTokenIn(db, now(), SETUP_TOKEN_MS);
  function setupTokenValid(token: string): boolean {
    const row = db.prepare("SELECT expires_at, used_at FROM setup_token WHERE hash = ?").get(sha256(token)) as { expires_at: number; used_at: number | null } | undefined;
    return !!row && row.used_at === null && row.expires_at > now();
  }
  function startAdminSession(): string {
    const value = randomBytes(32).toString("base64url");
    db.prepare("INSERT INTO admin_session (hash, created_at, uv_at) VALUES (?, ?, ?)").run(sha256(value), now(), now());
    return `__Host-ma_admin=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${ADMIN_ABSOLUTE_MS / 1000}`;
  }
  function adminSession(req: IncomingMessage): { hash: string; uvAt: number } | undefined {
    const v = cookies(req)["__Host-ma_admin"];
    if (!v) return undefined;
    const hash = sha256(v);
    const row = db.prepare("SELECT created_at, uv_at FROM admin_session WHERE hash = ?").get(hash) as { created_at: number; uv_at: number } | undefined;
    if (!row || now() - row.created_at > ADMIN_ABSOLUTE_MS || now() - row.uv_at > ADMIN_IDLE_MS) return undefined;
    return { hash, uvAt: row.uv_at };
  }
  /** State-changing page requests come from our own pages only (§4.6, §8). */
  function sameOrigin(req: IncomingMessage): boolean {
    const site = req.headers["sec-fetch-site"];
    return req.headers.origin === origin && (site === undefined || site === "same-origin");
  }

  /** Static confidential client created at window open (§4.2): its secret is shown once. */
  async function createStaticClient(vendor: Vendor, redirectUri: string | undefined) {
    const redirect_uris = redirectUri ? [redirectUri] : VENDORS[vendor].redirects;
    if (redirect_uris.length === 0 || !redirect_uris.every((u) => URL.parse(u)?.protocol === "https:")) return undefined;
    const client_id = `ma_${randomBytes(12).toString("base64url")}`;
    const client_secret = randomBytes(32).toString("base64url");
    const Client = provider.Client as unknown as { adapter: { upsert(id: string, payload: object, expiresIn: number): Promise<void> } };
    await Client.adapter.upsert(
      client_id,
      { client_id, client_secret, redirect_uris, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "client_secret_basic", client_name: VENDORS[vendor].label },
      0,
    );
    return { client_id, client_secret, redirect_uris };
  }

  // ---- route handlers ----

  async function mcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const browserOrigin = req.headers.origin;
    if (browserOrigin !== undefined && browserOrigin !== "null") return json(res, 403, { error: "forbidden" });
    const challenge = { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="memory.read memory.write"` };
    const value = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(req.headers.authorization ?? "")?.[1];
    const token = value ? await provider.AccessToken.find(value) : undefined;
    const aud = (token as { aud?: string | string[] } | undefined)?.aud;
    const audOk = Array.isArray(aud) ? aud.length === 1 && aud[0] === mcpUrl : aud === mcpUrl;
    const grant = token?.grantId ? await provider.Grant.find(token.grantId) : undefined;
    const policy = token ? (db.prepare("SELECT revoked_at FROM client_policy WHERE client_id = ?").get(token.clientId ?? "") as { revoked_at: number | null } | undefined) : undefined;
    if (!token || token.isExpired || !audOk || !grant || !policy || policy.revoked_at !== null) return json(res, 401, { error: "invalid_token" }, challenge);
    delete req.headers.cookie; // /mcp ignores cookies (§5.5)
    if (req.method !== "POST") return void mcpNode(req as unknown as NodeIncomingMessageLike, res);
    // Read the JSON-RPC body here so the access log can name what each client calls; the adapter
    // takes the parsed body as its third argument.
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    const calls = (Array.isArray(body) ? body : [body]) as { method?: unknown; params?: { name?: unknown } }[];
    (res as ServerResponse & { maRpc?: string }).maRpc = calls
      .map((c) => (c.method === "tools/call" && typeof c.params?.name === "string" ? `tools/call:${c.params.name}` : String(c.method)))
      .join(",");
    (res as ServerResponse & { maClient?: string | undefined }).maClient = token.clientId;
    // What each client declares (M0 Q09: elicitation capability; protocol revision; client name).
    for (const c of calls) {
      if (c.method !== "initialize" && c.method !== "server/discover") continue;
      const params = (c as { params?: Record<string, unknown> }).params ?? {};
      console.log(JSON.stringify({ event: "client_hello", method: c.method, client_id: token.clientId, clientInfo: params["clientInfo"], protocolVersion: params["protocolVersion"], capabilities: params["capabilities"] }));
    }
    return void mcpNode(req as unknown as NodeIncomingMessageLike, res, body);
  }

  async function consent(req: IncomingMessage, res: ServerResponse, uid: string, action: string): Promise<void> {
    const details = await provider.interactionDetails(req, res).catch(() => undefined);
    if (!details || details.uid !== uid) return html(res, 400, ERROR_PAGE);
    const clientId = String(details.params["client_id"] ?? "");
    const w = pairing.active();
    if (!w || !authorizationAllowed(w, clientId)) return html(res, 400, ERROR_PAGE);
    const bound = pairing.cookieMatches(w.id, cookies(req)["__Host-ma_pair"]);

    if (action === "") {
      // What each vendor asks for (M0 config/vendors.json): no codes, no states.
      console.log(JSON.stringify({ event: "consent_shown", vendor: w.vendor, client_id: clientId, scope: details.params["scope"], resource: details.params["resource"], prompt: details.prompt.name, reasons: details.prompt.reasons }));
      const client = await provider.Client.find(clientId);
      const name = client?.metadata()["client_name"];
      return html(
        res,
        200,
        consentPage({
          uid,
          vendor: VENDORS[w.vendor].label,
          redirectUri: String(details.params["redirect_uri"] ?? ""),
          clientName: typeof name === "string" ? name : undefined,
          openedAt: w.opened_at,
          now: now(),
          scope: clientId === PC_CLIENT_ID ? "read, save and capture memories" : "read and save memories",
          pairCode: w.vendor === "pc" ? w.pair_code : undefined,
          bound,
        }),
      );
    }
    if (!sameOrigin(req)) return html(res, 400, ERROR_PAGE);
    const body = parseBody(req, await readBody(req)) ?? {};
    if (action === "code") {
      const token = pairing.enterCode(w.id, String(body["code"] ?? ""));
      if (!token) return json(res, 403, { error: "wrong_code" });
      return json(res, 200, { ok: true }, { "set-cookie": `__Host-ma_pair=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600` });
    }
    if (!bound) return json(res, 403, { error: "pair_code_required" }); // conformance test 19
    if (action === "options") return json(res, 200, await passkeys.assertionOptions(`consent:${uid}`));
    if (action === "deny") {
      pairing.close(w.id, "denied");
      const redirectTo = await provider.interactionResult(req, res, { error: "access_denied", error_description: "The owner denied the request." }, { mergeWithLastSubmission: false });
      return json(res, 200, { redirectTo });
    }
    if (action === "approve") {
      if (!(await passkeys.verify(`consent:${uid}`, body as never))) return json(res, 403, { error: "passkey_failed" });
      if (!w.client_id) pairing.attachClient(w.id, clientId);
      db.prepare("INSERT OR IGNORE INTO client_policy (client_id, vendor, refresh_rotation, created_at) VALUES (?, ?, 'rotate', ?)").run(clientId, w.vendor, now());
      const grant = new provider.Grant({ accountId: "owner", clientId });
      // Grant the OpenID scopes the request asked for (Grok asks for `openid`, M0 Q11), or the
      // library opens a second consent for the same authorization. Only `openid` and
      // `offline_access` exist here; resource scopes stay fixed per client below.
      const missingOIDC = (details.prompt.details as { missingOIDCScope?: string[] }).missingOIDCScope ?? [];
      grant.addOIDCScope(["offline_access", ...missingOIDC.filter((s) => s === "openid")].join(" "));
      grant.addResourceScope(mcpUrl, clientId === PC_CLIENT_ID ? "memory.read memory.write memory.capture" : "memory.read memory.write");
      const grantId = await grant.save();
      pairing.close(w.id, "granted");
      console.log(JSON.stringify({ event: "grant_created", vendor: w.vendor, client_id: clientId, redirect_uri: details.params["redirect_uri"] }));
      const redirectTo = await provider.interactionResult(req, res, { login: { accountId: "owner" }, consent: { grantId } }, { mergeWithLastSubmission: false });
      return json(res, 200, { redirectTo });
    }
    return html(res, 400, ERROR_PAGE);
  }

  async function admin(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if (path === "/admin") return req.method === "GET" ? html(res, 200, adminPage()) : notFound(res);
    if (req.method !== "POST") return notFound(res);
    if (!sameOrigin(req)) return json(res, 403, { error: "cross_origin" });
    const body = parseBody(req, await readBody(req)) ?? {};
    if (path === "/admin/api/login/options") return json(res, 200, await passkeys.assertionOptions("admin"));
    if (path === "/admin/api/login/verify") {
      if (!(await passkeys.verify("admin", body as never))) return json(res, 403, { error: "passkey_failed" });
      return json(res, 200, { ok: true }, { "set-cookie": startAdminSession() });
    }
    const session = adminSession(req);
    if (!session) return json(res, 401, { error: "login_required" });
    if (path === "/admin/api/stepup/options") return json(res, 200, await passkeys.assertionOptions(`stepup:${session.hash}`));
    if (path === "/admin/api/stepup/verify") {
      if (!(await passkeys.verify(`stepup:${session.hash}`, body as never))) return json(res, 403, { error: "passkey_failed" });
      db.prepare("UPDATE admin_session SET uv_at = ? WHERE hash = ?").run(now(), session.hash);
      return json(res, 200, { ok: true });
    }
    if (path === "/admin/api/windows") {
      if (now() - session.uvAt > STEP_UP_MS) return json(res, 401, { error: "step_up_required" });
      const vendor = String(body["vendor"]) as Vendor;
      const method = String(body["method"]) as Method;
      if (!Object.hasOwn(VENDORS, vendor) || !VENDORS[vendor].methods.includes(method)) return json(res, 400, { error: "bad_vendor_or_method" });
      const otherHost = typeof body["otherHost"] === "string" && body["otherHost"] ? body["otherHost"] : undefined;
      const redirectUri = typeof body["redirectUri"] === "string" && body["redirectUri"] ? body["redirectUri"] : undefined;
      const rotation = body["rotation"] === "fixed" ? "fixed" : "rotate";
      const { window, cookieToken } = pairing.open(vendor, method, { ...(otherHost ? { otherHost } : {}), desktop: body["desktop"] === true });
      let credentials: Awaited<ReturnType<typeof createStaticClient>>;
      if (method === "static" && vendor !== "pc") {
        credentials = await createStaticClient(vendor, redirectUri);
        if (!credentials) {
          pairing.close(window.id, "cancelled");
          return json(res, 400, { error: "redirect_uri_required" });
        }
        pairing.attachClient(window.id, credentials.client_id);
        db.prepare("INSERT INTO client_policy (client_id, vendor, refresh_rotation, created_at) VALUES (?, ?, ?, ?)").run(credentials.client_id, vendor, rotation, now());
      }
      return json(res, 200, { window_id: window.id, pair_code: window.pair_code, expires_at: window.expires_at, mcp_url: mcpUrl, pair_link: `/pair/${window.id}?t=${cookieToken}`, credentials });
    }
    return notFound(res);
  }

  async function setup(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if (path === "/setup") return req.method === "GET" ? html(res, 200, setupPage()) : notFound(res);
    if (req.method !== "POST") return notFound(res);
    if (!sameOrigin(req)) return json(res, 403, { error: "cross_origin" });
    const body = parseBody(req, await readBody(req)) ?? {};
    const token = String(body["token"] ?? "");
    if (!setupTokenValid(token) || passkeys.count() > 0) return json(res, 403, { error: "setup_unavailable" });
    if (path === "/setup/options") return json(res, 200, await passkeys.registrationOptions());
    if (!(await passkeys.register(body["response"] as never))) return json(res, 400, { error: "registration_failed" });
    db.prepare("UPDATE setup_token SET used_at = ? WHERE hash = ?").run(now(), sha256(token));
    return json(res, 200, { ok: true }, { "set-cookie": startAdminSession() });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", origin);
    const path = url.pathname;
    if (path === "/v1/health") return req.method === "GET" ? json(res, 200, { status: "ok", version: opts.version }) : notFound(res);
    if (path === "/.well-known/oauth-protected-resource/mcp") {
      if (req.method !== "GET") return notFound(res);
      return json(res, 200, { resource: mcpUrl, authorization_servers: [origin], scopes_supported: ["memory.read", "memory.write"], bearer_methods_supported: ["header"] });
    }
    if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration") {
      return req.method === "GET" ? runProvider(req, res, "/.well-known/openid-configuration", true) : notFound(res);
    }
    if (path.startsWith("/oauth/")) return runProvider(req, res, `${path.slice("/oauth".length)}${url.search}`);
    if (path === "/mcp") return req.method === "POST" || req.method === "GET" || req.method === "DELETE" ? mcp(req, res) : notFound(res);
    const pair = /^\/pair\/([A-Za-z0-9_-]{16})$/.exec(path);
    if (pair?.[1]) {
      if (req.method !== "GET") return notFound(res);
      const t = url.searchParams.get("t") ?? undefined;
      if (!pairing.cookieMatches(pair[1], t)) return html(res, 400, ERROR_PAGE);
      res.writeHead(303, { location: "/admin", "set-cookie": `__Host-ma_pair=${t}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`, "cache-control": "no-store" });
      return void res.end();
    }
    const c = /^\/consent\/([A-Za-z0-9_-]{1,64})(?:\/(code|options|approve|deny))?$/.exec(path);
    if (c?.[1]) return req.method === (c[2] ? "POST" : "GET") ? consent(req, res, c[1], c[2] ?? "") : notFound(res);
    if (path === "/admin" || /^\/admin\/api\/(login|stepup)\/(options|verify)$/.test(path) || path === "/admin/api/windows") return admin(req, res, path);
    if (path === "/setup" || path === "/setup/options" || path === "/setup/verify") return setup(req, res, path);
    return notFound(res);
  }

  const server: Server = createServer((req, res) => {
    if (opts.accessLog) {
      // One line per request, written when the connection closes (also for streams that never end
      // normally). No query strings: they carry codes and states.
      const started = performance.now();
      res.once("close", () => {
        console.log(JSON.stringify({
          event: "http",
          method: req.method,
          path: req.url?.split("?")[0],
          status: res.statusCode,
          completed: res.writableFinished,
          ms: Math.round(performance.now() - started),
          type: res.getHeader("content-type"),
          rpc: (res as ServerResponse & { maRpc?: string }).maRpc,
          client: (res as ServerResponse & { maClient?: string }).maClient,
          ua: req.headers["user-agent"]?.slice(0, 120),
        }));
      });
    }
    handle(req, res).catch((err: unknown) => {
      console.error(JSON.stringify({ event: "request_failed", path: req.url?.split("?")[0], error: err instanceof Error ? err.message : String(err) }));
      if (!res.headersSent) json(res, 500, { error: "server_error" });
      else res.end();
    });
  });
  return { server, provider, pairing, passkeys, db, issueSetupToken, mcpUrl, origin, close: () => db.close() };
}
