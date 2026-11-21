// Who may do what inside the open pairing window (auth-and-security.md §4.1–§4.3): which client may
// authorize, which redirects a vendor may use, and which registrations are accepted.

import type { Alerts } from "../ops/alerts.ts";
import type { Pairing, PairingWindow } from "./pairing.ts";
import { cimdVendorFor, httpsOnHost, isLoopback, PC_CLIENT_ID, VENDORS } from "./vendors.ts";

const DCR_FIELDS = new Set([
	"redirect_uris",
	"client_name",
	"grant_types",
	"response_types",
	"token_endpoint_auth_method",
	"application_type",
	"scope",
]);
/** The scopes a registration may name. It changes nothing: granted scopes come from the client's policy. */
const DCR_SCOPES = new Set(["memory.read", "memory.write", "memory.capture", "offline_access", "openid"]);
const DCR_GRANTS = new Set(["authorization_code", "refresh_token"]);
const DCR_AUTH = new Set(["none", "client_secret_post", "client_secret_basic"]);

/** Whether `clientId` may start an authorization inside window `w`. */
export function authorizationAllowed(w: PairingWindow | undefined, clientId: string): w is PairingWindow {
	if (!w || !clientId) return false;
	if (w.vendor === "pc") return clientId === PC_CLIENT_ID;
	if (clientId === PC_CLIENT_ID) return false;
	if (w.registered_client_id) return w.registered_client_id === clientId;
	return w.method === "cimd" && cimdVendorFor(clientId) === w.vendor;
}

/** An https redirect this window's vendor may register or use. */
export function vendorRedirect(w: PairingWindow, uri: string, issuerHost: string): boolean {
	const rule = VENDORS[w.vendor];
	if (w.vendor === "other") return !!w.allowed_redirect_host && httpsOnHost(uri, w.allowed_redirect_host);
	if (rule.redirectRule) return rule.redirectRule(issuerHost).test(uri);
	return rule.redirects.includes(uri);
}

export interface RegistrationEnv {
	readonly alerts: Alerts;
	readonly pairing: Pairing;
	readonly issuerHost: string;
}

/**
 * DCR inside a window. A redirect foreign to the vendor closes the window (§4.1 step 5); any other
 * refusal inside a DCR window raises `registration_refused` naming what was wrong, so the owner can
 * tell a changed vendor app from a stranger. Outside a window nothing is raised.
 */
export function dcrAllowed(
	env: RegistrationEnv,
	w: PairingWindow | undefined,
	meta: Record<string, unknown> | undefined,
): boolean {
	if (!w || w.method !== "dcr") return false;
	const refuse = (what: string): false => {
		env.alerts.raise("registration_refused", {}, { subject: `${w.vendor}:${what}`.slice(0, 80) });
		return false;
	};
	if (!meta) return refuse("unreadable_body");
	const unknown = Object.keys(meta).filter((k) => !DCR_FIELDS.has(k));
	if (unknown.length > 0) return refuse(unknown.map((k) => (/^[A-Za-z_]{1,40}$/u.test(k) ? k : "other")).join(":"));
	const uris = meta["redirect_uris"];
	if (
		!Array.isArray(uris) ||
		uris.length < 1 ||
		uris.length > 2 ||
		!uris.every((u): u is string => typeof u === "string")
	)
		return refuse("redirect_uris");
	const name = meta["client_name"];
	if (name !== undefined && (typeof name !== "string" || name.length > 64)) return refuse("client_name");
	const grants = meta["grant_types"];
	if (grants !== undefined && (!Array.isArray(grants) || !grants.every((g) => DCR_GRANTS.has(g as string))))
		return refuse("grant_types");
	const types = meta["response_types"];
	if (types !== undefined && (!Array.isArray(types) || types.length !== 1 || types[0] !== "code"))
		return refuse("response_types");
	const auth = meta["token_endpoint_auth_method"];
	if (auth !== undefined && !DCR_AUTH.has(auth as string)) return refuse("token_endpoint_auth_method");
	const scope = meta["scope"];
	if (scope !== undefined && (typeof scope !== "string" || !scope.split(" ").every((s) => DCR_SCOPES.has(s))))
		return refuse("scope");
	const https = uris.every((u) => vendorRedirect(w, u, env.issuerHost));
	const loopback = uris.every(isLoopback);
	// RFC 7591 §2: an omitted application_type is "web"; a loopback redirect
	// still needs an explicit "native" in an Other desktop-app window.
	const appType = meta["application_type"] ?? "web";
	const ok =
		(https && appType === "web") || (loopback && w.vendor === "other" && w.desktop === 1 && appType === "native");
	if (!ok) {
		if (!https && !loopback) {
			env.pairing.close(w.id, "registration_race");
			env.alerts.raise("pairing_race", { vendor: w.vendor, cause: "foreign_redirect" });
			return false;
		}
		return refuse("application_type");
	}
	if (env.pairing.takeRegistrationSlot(w.id)) return true;
	env.alerts.raise("pairing_race", { vendor: w.vendor, cause: "second_registration" });
	return false;
}
