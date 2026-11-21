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
// /token keeps RFC 6749 errors and adds the refresh grace and the idle limit.

import type { IncomingMessage, ServerResponse } from "node:http";
import type Provider from "oidc-provider";
import type { App } from "../app.ts";
import type { Arrival, FrontDoor } from "../http/front.ts";
import type { Logger } from "../http/log.ts";
import { ipPrefix } from "../http/log.ts";
import { RateLimiter } from "../http/rate.ts";
import type { Mount, RequestLog } from "../http/server.ts";
import { sendJson, sendPage, serveAsset } from "../web/pages.ts";
import { pinRedirect } from "./clients.ts";
import { consentHandler, pairCookie, type ConsentAction } from "./consent.ts";
import { parseBody, providerBody, rejectJson, rejectPage } from "./library-request.ts";
import type { Pairing } from "./pairing.ts";
import type { Passkeys } from "./passkeys.ts";
import { tokenGate } from "./token-gate.ts";
import { authorizationAllowed, dcrAllowed, vendorRedirect } from "./window-rules.ts";
import { requireMeta } from "../store/meta.ts";

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
	const secret = requireMeta(ctx.db, "cookie_secret");
	const callback = provider.callback();
	const limits = app.config.rate_limits;
	const tokenLimit = new RateLimiter(limits.token_per_ip_per_min, 60_000, now);
	const regLimit = new RateLimiter(limits.register_per_ip_per_min, 60_000, now);
	const authLimit = new RateLimiter(limits.authorize_per_ip_per_min, 60_000, now);
	const registration = { alerts: app.alerts, pairing, issuerHost };
	const token = tokenGate({ ctx, alerts: app.alerts });
	const consent = consentHandler({ app, provider, pairing, passkeys, issuer, secret });

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
			if (!dcrAllowed(registration, w, meta)) return rejectJson(c);
			// `scope` is accepted but not passed on: the library would read it as the client's allowed
			// scopes, and what a client gets is set by its policy (provider.ts).
			if (meta && "scope" in meta) {
				const rest = Object.fromEntries(Object.entries(meta).filter(([k]) => k !== "scope"));
				(c.req as IncomingMessage & { body?: string }).body = c.req.headers["content-type"]?.startsWith(
					"application/json",
				)
					? JSON.stringify(rest)
					: new URLSearchParams(rest as Record<string, string>).toString();
			}
			await next();
			if (c.status >= 400) {
				if (w) app.alerts.raise("registration_refused", {}, { subject: `${w.vendor}:library_${c.status}` });
				return rejectJson(c);
			}
			const clientId = (c.body as { client_id?: string } | undefined)?.client_id;
			if (w && clientId) pairing.attachClient(w.id, clientId);
			return;
		}

		if (path === "/auth") {
			const raw = c.method === "POST" ? await providerBody(c).catch(() => undefined) : "";
			const params = c.method === "POST" ? new URLSearchParams(raw ?? "") : new URLSearchParams(c.querystring);
			const mode = params.get("response_mode");
			if (
				raw === undefined ||
				(mode !== null && mode !== "query") ||
				params.has("request") ||
				params.has("request_uri")
			)
				return rejectPage(c);
			const clientId = params.get("client_id") ?? "";
			if (!authorizationAllowed(w, clientId)) return rejectPage(c);
			// Gemini's static client learns its per-user redirect from its first request.
			if (w.vendor === "gemini" && w.method === "static") {
				const redirect = params.get("redirect_uri") ?? "";
				if (!vendorRedirect(w, redirect, issuerHost)) return rejectPage(c);
				const client = await provider.Client.find(clientId);
				if (client && !client.redirectUris?.includes(redirect)) await pinRedirect(provider, clientId, redirect);
			}
			await next();
			// Errors are shown as the page and never redirected (§4.1 step 4; RFC 9700 §2.1).
			const location = c.response.get("location");
			if (c.status >= 400 || (location && new URL(location, issuer).searchParams.has("error"))) rejectPage(c);
			return;
		}

		if (path === "/token" && c.method === "POST") return token(c, next);

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

	// The library's reasons stay in the log; clients only see the normalised response.
	const logError = (op: string) => (_c: unknown, err: Error & { error?: string }) =>
		logger.log({ level: "warn", op, error_code: err.error ?? "server_error" });
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
				sendJson(res, 200, {
					resource: mcpUrl,
					authorization_servers: [issuer],
					scopes_supported: ["memory.read", "memory.write"],
					bearer_methods_supported: ["header"],
				});
				finish(200, "discovery");
				return true;
			}
			if (
				(path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration") &&
				req.method === "GET"
			) {
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
				res.writeHead(303, {
					location: `${door.adminUrl}/`,
					"set-cookie": pairCookie(t ?? ""),
					"cache-control": "no-store",
				});
				res.end();
				finish(303, "pair");
				return true;
			}
			const c = /^\/consent\/([A-Za-z0-9_-]{1,64})(?:\/(code|options|approve|deny))?$/u.exec(path);
			if (c?.[1] && req.method === (c[2] ? "POST" : "GET")) {
				if (limited(authLimit)) return true;
				consent(req, res, c[1], (c[2] ?? "") as ConsentAction, (status) => finish(status, "consent")).catch(() => {
					if (!res.headersSent) sendJson(res, 500, { error: "server_error" });
					finish(500, "consent");
				});
				return true;
			}
			return false;
		},
	};
}
