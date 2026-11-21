// Opening a pairing window from the admin UI (auth-and-security.md §4.1): the owner picks the app
// (vendor) and how it registers (method); the reply carries the pair code, the link and, for a
// static client, its credentials.

import type Provider from "oidc-provider";
import type { App } from "../app.ts";
import type { Reply } from "../web/pages.ts";
import { activeClientFor, createStaticClient } from "./clients.ts";
import type { Pairing } from "./pairing.ts";
import { isVendor, VENDORS, type Method } from "./vendors.ts";

export interface WindowEnv {
	readonly app: App;
	readonly provider: Provider;
	readonly pairing: Pairing;
	/** https://{host}, where apps connect. */
	readonly baseUrl: string;
}

export async function openWindow(
	{ app, provider, pairing, baseUrl }: WindowEnv,
	body: Record<string, unknown>,
	reply: Reply,
): Promise<void> {
	const vendor = body["vendor"];
	const method = body["method"] as Method;
	if (!isVendor(vendor) || !VENDORS[vendor].methods.includes(method))
		return reply(400, { error: "bad_vendor_or_method" });
	const machineName =
		vendor === "pc"
			? String(body["machineName"] ?? "")
					.trim()
					.slice(0, 40)
			: undefined;
	if (vendor === "pc" && !machineName) return reply(400, { error: "machine_name_required" });
	const otherHost =
		vendor === "other" && typeof body["otherHost"] === "string" ? body["otherHost"].trim().toLowerCase() : undefined;
	if (vendor === "other" && !(otherHost && /^[a-z0-9.-]+\.[a-z]{2,}$/u.test(otherHost)))
		return reply(400, { error: "other_host_required" });
	// One active grant per vendor (per machine for the PC): pairing again needs "Replace".
	const current = activeClientFor(app.ctx, vendor, machineName);
	if (current && body["replace"] !== true) return reply(409, { error: "replace_required", client: current });
	const { window, cookieToken } = pairing.open(vendor, method, {
		...(otherHost ? { otherHost } : {}),
		...(machineName ? { machineName } : {}),
		...(current ? { replacesClientId: current } : {}),
		desktop: body["desktop"] === true,
		write: body["write"] !== false,
	});
	let credentials: Awaited<ReturnType<typeof createStaticClient>>;
	if (method === "static" && vendor !== "pc") {
		const otherRedirect =
			typeof body["redirectUri"] === "string" && otherHost && URL.parse(body["redirectUri"])?.hostname === otherHost
				? body["redirectUri"]
				: undefined;
		credentials = await createStaticClient(provider, vendor, otherRedirect);
		if (!credentials) {
			pairing.close(window.id, "cancelled");
			return reply(400, { error: "redirect_uri_required" });
		}
		pairing.attachClient(window.id, credentials.client_id);
	}
	return reply(200, {
		window_id: window.id,
		pair_code: window.pair_code,
		expires_at: window.expires_at,
		mcp_url: `${baseUrl}/mcp`,
		pair_link: `${baseUrl}/pair/${window.id}?t=${cookieToken}`,
		...(credentials ? { credentials } : {}),
	});
}
