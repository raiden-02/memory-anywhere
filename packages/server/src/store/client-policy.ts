// The `client_policy` table (data-model.md §2; auth-and-security.md §4.4): what one connected app may
// do. Every request reads its app's row through here; auth/clients.ts creates and revokes rows.

import type { DatabaseSync } from "node:sqlite";
import { prepared } from "./db.ts";

export interface ClientPolicy {
	readonly client_id: string;
	/** The OAuth library's client id; null for the local token. */
	readonly oauth_client_id: string | null;
	readonly display_name: string;
	readonly vendor: string;
	readonly class: "chat" | "coding";
	readonly read: number;
	readonly write: number;
	/** JSON array of section ids, or ["*"]. */
	readonly section_allow_json: string;
	readonly sensitive_allow_json: string;
	readonly save_floor: "none" | "observation";
	readonly profile_eligible: number;
	readonly quota_saves_per_hour: number;
	readonly quota_forgets_per_day: number;
	readonly read_budget_24h: number;
	readonly read_budget_1h: number;
	readonly elicitation: "none" | "verified";
	readonly refresh_rotation: "rotate" | "fixed";
	readonly last_policy_version: string | null;
	readonly last_policy_version_at: string | null;
	readonly created_at: string;
	readonly revoked_at: string | null;
}

/** The app's row, revoked or not. */
export function clientPolicy(db: DatabaseSync, clientId: string): ClientPolicy | undefined {
	return prepared(db, "SELECT * FROM client_policy WHERE client_id = ?").get(clientId) as ClientPolicy | undefined;
}

/** The row of the app the OAuth library knows as `oauthClientId`. */
export function policyOfOAuthClient(db: DatabaseSync, oauthClientId: string): ClientPolicy | undefined {
	return prepared(db, "SELECT * FROM client_policy WHERE oauth_client_id = ?").get(oauthClientId) as
		ClientPolicy | undefined;
}

/** Records which policy version the app last sent with a save; memory_status reports it. */
export function notePolicyVersion(db: DatabaseSync, clientId: string, version: string, at: string): void {
	prepared(db, "UPDATE client_policy SET last_policy_version = ?, last_policy_version_at = ? WHERE client_id = ?").run(
		version,
		at,
		clientId,
	);
}
