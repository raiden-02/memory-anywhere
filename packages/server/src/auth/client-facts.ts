// What the OAuth library asks about a client while it issues tokens, answered from the store: how
// refresh tokens rotate, when the grant was approved, how the client authenticates, and whether it
// may write.

import type { StoreContext } from "../store/context.ts";
import { policyOfOAuthClient } from "../store/client-policy.ts";
import { prepared } from "../store/db.ts";
import type { Pairing } from "./pairing.ts";

export interface ClientFacts {
	/** `fixed` keeps one refresh token for the grant's life (Gemini); `rotate` issues a new one on every use. */
	rotation(oauthClientId: string): string | undefined;
	/** When the owner approved the grant, in ms; its lifetimes count from here. */
	grantCreated(grantId: string): number | undefined;
	/** The token endpoint auth method: stored clients carry it; the PC and CIMD clients are public. */
	authMethod(clientId: string): string;
	/** Its policy once it has one; before that, the window it is being paired in (auth-and-security.md §4.4). */
	writeAllowed(oauthClientId: string): boolean;
}

export function clientFacts(ctx: StoreContext, pairing: Pairing): ClientFacts {
	return {
		rotation: (oauthClientId) => policyOfOAuthClient(ctx.db, oauthClientId)?.refresh_rotation,
		grantCreated: (grantId) => {
			const at = (
				prepared(ctx.db, "SELECT created_at FROM grant_meta WHERE grant_id = ?").get(grantId) as
					{ created_at: string } | undefined
			)?.created_at;
			return at ? Date.parse(at) : undefined;
		},
		authMethod: (clientId) => {
			const row = prepared(ctx.db, "SELECT payload_json FROM oidc_store WHERE model = 'Client' AND id = ?").get(
				clientId,
			) as { payload_json: string } | undefined;
			return row
				? ((JSON.parse(row.payload_json) as { token_endpoint_auth_method?: string }).token_endpoint_auth_method ??
						"client_secret_basic")
				: "none";
		},
		writeAllowed: (oauthClientId) => {
			const policy = policyOfOAuthClient(ctx.db, oauthClientId);
			if (policy) return policy.write === 1;
			const w = pairing.active();
			return !(w && w.registered_client_id === oauthClientId && w.other_write === 0);
		},
	};
}
