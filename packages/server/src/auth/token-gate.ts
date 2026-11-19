// What this server adds around the library's /oauth/token (auth-and-security.md §5.2–§5.3):
// client_secret_post accepted as Basic, a 30 s grace that serves a refresh's response again, the idle
// limit, and an alert when a used refresh token comes back.

import type { Alerts } from "../ops/alerts.ts";
import { iso } from "../store/clock.ts";
import type { StoreContext } from "../store/context.ts";
import { prepared } from "../store/db.ts";
import { sha256Hex } from "./adapter.ts";
import { providerBody, type Ctx } from "./library-request.ts";
import { lifetimeFor } from "./provider.ts";

const REFRESH_GRACE_MS = 30_000;

export interface TokenGateEnv {
	readonly ctx: StoreContext;
	readonly alerts: Alerts;
}

export type TokenGate = (c: Ctx, next: () => Promise<void>) => Promise<void>;

export function tokenGate({ ctx, alerts }: TokenGateEnv): TokenGate {
	const now = (): number => ctx.clock.now();
	/** The response to a rotation, keyed by the old token's hash. Memory only: it holds live tokens. */
	const grace = new Map<string, { body: string; expires: number }>();

	/** No use of the grant (refresh or request) for longer than its client kind allows. */
	function idleExpired(grantId: string, token: { clientId?: string }): boolean {
		const g = prepared(
			ctx.db,
			"SELECT g.last_used_at, s.payload_json FROM grant_meta g LEFT JOIN oidc_store s ON s.model = 'Client' AND s.id = ? WHERE g.grant_id = ?",
		).get(token.clientId ?? "", grantId) as { last_used_at: string | null; payload_json: string | null } | undefined;
		if (!g?.last_used_at) return false;
		const method = g.payload_json
			? (JSON.parse(g.payload_json) as { token_endpoint_auth_method?: string }).token_endpoint_auth_method
			: undefined;
		return Date.parse(g.last_used_at) + lifetimeFor(token.clientId ?? "", method).idleMs <= now();
	}

	function endGrant(grantId: string): void {
		prepared(ctx.db, "UPDATE grant_meta SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL").run(
			iso(now()),
			grantId,
		);
		prepared(ctx.db, "DELETE FROM oidc_store WHERE grant_id = ?").run(grantId);
	}

	return async (c, next) => {
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
			const row = prepared(
				ctx.db,
				"SELECT grant_id, consumed_at, payload_json FROM oidc_store WHERE model = 'RefreshToken' AND id = ?",
			).get(key) as { grant_id: string | null; consumed_at: string | null; payload_json: string } | undefined;
			if (row?.consumed_at) alerts.raise("refresh_reuse", { grant: row.grant_id ?? "" });
			if (
				row?.grant_id &&
				!row.consumed_at &&
				idleExpired(row.grant_id, JSON.parse(row.payload_json) as { clientId?: string })
			) {
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
			const grantId = (
				prepared(ctx.db, "SELECT grant_id FROM oidc_store WHERE model = 'RefreshToken' AND id = ?").get(key) as
					{ grant_id: string | null } | undefined
			)?.grant_id;
			if (grantId)
				prepared(ctx.db, "UPDATE grant_meta SET last_used_at = ? WHERE grant_id = ?").run(iso(now()), grantId);
		}
	};
}
