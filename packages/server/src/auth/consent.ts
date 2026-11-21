// The consent page (auth-and-security.md §4.6): where the owner, inside an open pairing window,
// enters the pairing code (when this browser did not open the window), sees which app asks for what,
// and approves with a passkey or denies.
//
//   GET  /consent/:uid            the code page, or the approval page once this browser is bound
//   POST /consent/:uid/code       binds this browser with the pairing code
//   POST /consent/:uid/options    passkey assertion options
//   POST /consent/:uid/approve    verifies the passkey, records the grant, closes the window
//   POST /consent/:uid/deny       closes the window and returns access_denied to the app

import type { IncomingMessage, ServerResponse } from "node:http";
import { loginCode } from "@memory-anywhere/contracts/login-code";
import type Provider from "oidc-provider";
import type { App } from "../app.ts";
import { cookies, csrfFor, csrfOk, readPageJson, sendJson, sendPage } from "../web/pages.ts";
import { ensurePolicy, recordGrant } from "./clients.ts";
import type { Pairing } from "./pairing.ts";
import type { Passkeys } from "./passkeys.ts";
import { PC_CLIENT_ID, PC_SCOPE, VENDOR_SCOPE, VENDORS } from "./vendors.ts";
import { authorizationAllowed } from "./window-rules.ts";

/** Binds a browser to the open window: set by the pair link or by entering the pairing code. */
export const PAIR_COOKIE = "__Host-ma_pair";
export const pairCookie = (token: string): string =>
	`${PAIR_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`;

export interface ConsentEnv {
	readonly app: App;
	readonly provider: Provider;
	readonly pairing: Pairing;
	readonly passkeys: Passkeys;
	readonly issuer: string;
	/** Signs the pages' CSRF tokens. */
	readonly secret: string;
}

export type ConsentAction = "" | "code" | "options" | "approve" | "deny";

export type Consent = (
	req: IncomingMessage,
	res: ServerResponse,
	uid: string,
	action: ConsentAction,
	done: (status: number) => void,
) => Promise<void>;

export function consentHandler({ app, provider, pairing, passkeys, issuer, secret }: ConsentEnv): Consent {
	const { ctx } = app;
	const now = (): number => ctx.clock.now();
	const mcpUrl = `${issuer}/mcp`;

	return async (req, res, uid, action, done) => {
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
		const readOnly = w.vendor === "other" && w.other_write === 0;

		if (action === "") {
			if (!bound) {
				sendPage(res, 200, "consent-code", {
					title: "Pairing code",
					page: "consent-code",
					csrf: csrfFor(secret, subject),
					base,
				});
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
				scope:
					clientId === PC_CLIENT_ID
						? "read, save and capture memories"
						: readOnly
							? "read memories"
							: "read and save memories",
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
			return json(200, { ok: true }, { "set-cookie": pairCookie(token) });
		}
		if (!bound) return json(403, { error: "pair_code_required" });
		if (action === "options") return json(200, await passkeys.assertionOptions(subject));
		if (action === "deny") {
			pairing.close(w.id, "denied");
			const redirectTo = await provider.interactionResult(
				req,
				res,
				{ error: "access_denied", error_description: "The owner denied the request." },
				{ mergeWithLastSubmission: false },
			);
			return json(200, { redirectTo });
		}
		// action === "approve"
		if (!(await passkeys.verify(subject, body as never))) return json(403, { error: "passkey_failed" });
		if (!w.registered_client_id) pairing.attachClient(w.id, clientId);
		const policyClientId = ensurePolicy(ctx, app.config, w, clientId);
		const grant = new provider.Grant({ accountId: "owner", clientId });
		// Grant the OpenID scopes the request asked for (Grok asks for `openid`), or the library opens
		// a second consent for the same authorization.
		const missing = (details.prompt.details as { missingOIDCScope?: string[] }).missingOIDCScope ?? [];
		grant.addOIDCScope(["offline_access", ...missing.filter((s) => s === "openid")].join(" "));
		grant.addResourceScope(mcpUrl, clientId === PC_CLIENT_ID ? PC_SCOPE : readOnly ? "memory.read" : VENDOR_SCOPE);
		const grantId = await grant.save();
		recordGrant(ctx, app.alerts, w, policyClientId, grantId);
		pairing.close(w.id, "granted");
		const redirectTo = await provider.interactionResult(
			req,
			res,
			{ login: { accountId: "owner" }, consent: { grantId } },
			{ mergeWithLastSubmission: false },
		);
		return json(200, { redirectTo });
	};
}
