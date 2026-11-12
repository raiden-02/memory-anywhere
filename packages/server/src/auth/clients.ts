// Client policies and grants (auth-and-security.md §4.1–§4.4; clients.md §2; data-model.md).
//
//   OAuth client (the library's)          client_policy (ours: cli_…)          grant_meta
//   static: created when a window opens    one per static client                one row per approved grant,
//   dcr/cimd: registered in the window     one per DCR client or CIMD URL       pointing at its client_policy
//   memory-anywhere-cli (built in)         one per PC machine name
//
// Every request is authorised through grant_meta → client_policy, never the library client
// alone, because the PC's one library client serves several machines with their own policies.
// One active grant per vendor (per machine for the PC); pairing again with "Replace" ends the old
// grant when the new one is approved.

import { randomBytes } from "node:crypto";
import type Provider from "oidc-provider";
import type { ServerConfigT } from "../config/schema.ts";
import type { Alerts } from "../ops/alerts.ts";
import type { StoreContext } from "../store/context.ts";
import { iso } from "../store/clock.ts";
import { prepared, transaction } from "../store/db.ts";
import type { PairingWindow } from "./pairing.ts";
import { PC_CLIENT_ID, RESTRICTED_SECTIONS, VENDORS, type Vendor } from "./vendors.ts";

export interface StaticCredentials {
  readonly client_id: string;
  readonly client_secret: string;
  readonly redirect_uris: readonly string[];
}

interface ClientAdapter {
  upsert(id: string, payload: object, expiresIn: number): Promise<void>;
}

/**
 * A static confidential client for a window (§4.2): its secret is shown once in the admin UI.
 * Gemini's redirect is per user (ADR-0107), so it starts with none and the first one that matches
 * the rule is recorded (oauth-routes.ts).
 */
export async function createStaticClient(provider: Provider, vendor: Vendor, otherRedirect: string | undefined): Promise<StaticCredentials | undefined> {
  const redirect_uris = vendor === "other" ? (otherRedirect ? [otherRedirect] : []) : [...VENDORS[vendor].redirects];
  if (vendor !== "gemini" && (redirect_uris.length === 0 || !redirect_uris.every((u) => URL.parse(u)?.protocol === "https:"))) return undefined;
  const client_id = `ma_${randomBytes(12).toString("base64url")}`;
  const client_secret = randomBytes(32).toString("base64url");
  await (provider.Client as unknown as { adapter: ClientAdapter }).adapter.upsert(client_id, {
    client_id, client_secret, redirect_uris: vendor === "gemini" ? ["https://oauth-redirect.googleusercontent.com/r/pending"] : redirect_uris,
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "client_secret_basic", client_name: VENDORS[vendor].label,
  }, 0);
  return { client_id, client_secret, redirect_uris };
}

/** Records Gemini's first matching redirect as its client's only redirect (spec-issues #59). */
export async function pinRedirect(provider: Provider, clientId: string, redirectUri: string): Promise<void> {
  const client = await provider.Client.find(clientId);
  if (!client) return;
  const meta = client.metadata() as Record<string, unknown>;
  await (provider.Client as unknown as { adapter: ClientAdapter }).adapter.upsert(clientId, { ...meta, redirect_uris: [redirectUri] }, 0);
  // The library caches clients by id; drop the cached copy so the next lookup reads the new redirect.
  (provider.Client as unknown as { cache?: { delete(id: string): void } }).cache?.delete(clientId);
}

/** The policy a window's grant uses: created (or, for the same client, reused) with the vendor's defaults. */
export function ensurePolicy(ctx: StoreContext, config: ServerConfigT, w: PairingWindow, oauthClientId: string): string {
  const { db, clock, ids } = ctx;
  const rule = VENDORS[w.vendor];
  if (w.vendor !== "pc") {
    const existing = prepared(db, "SELECT client_id FROM client_policy WHERE oauth_client_id = ?").get(oauthClientId) as { client_id: string } | undefined;
    if (existing) {
      prepared(db, "UPDATE client_policy SET revoked_at = NULL WHERE client_id = ?").run(existing.client_id);
      return existing.client_id;
    }
  }
  const clientId = ids.newId("cli", clock.now());
  const d = config.client_defaults[rule.policy.clientClass];
  const sections = rule.policy.sections === "all" ? ["*"] : [...RESTRICTED_SECTIONS];
  const write = w.vendor === "other" ? w.other_write : 1;
  const name = w.vendor === "pc" ? `PC: ${w.machine_name ?? "unnamed"}` : rule.label;
  prepared(db, `INSERT INTO client_policy (client_id, oauth_client_id, display_name, vendor, class, read, write, section_allow_json, save_floor,
      quota_saves_per_hour, quota_forgets_per_day, read_budget_24h, read_budget_1h, refresh_rotation, created_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(clientId, w.vendor === "pc" ? null : oauthClientId, name.slice(0, 80), w.vendor, rule.policy.clientClass, write, JSON.stringify(sections), rule.policy.saveFloor,
      d.quota_saves_per_hour, d.quota_forgets_per_day, d.read_budget_24h, d.read_budget_1h, rule.policy.refreshRotation, iso(clock.now()));
  return clientId;
}

/** The client a vendor's (or machine's) active grant belongs to, for "Replace" (§4.1). */
export function activeClientFor(ctx: StoreContext, vendor: Vendor, machineName: string | undefined): string | undefined {
  const row = prepared(ctx.db, `SELECT p.client_id FROM grant_meta g JOIN client_policy p ON p.client_id = g.client_id
      WHERE g.revoked_at IS NULL AND p.revoked_at IS NULL AND p.vendor = ? AND (? IS NULL OR p.display_name = ?) LIMIT 1`)
    .get(vendor, machineName === undefined ? null : `PC: ${machineName}`, machineName === undefined ? null : `PC: ${machineName}`) as { client_id: string } | undefined;
  return row?.client_id;
}

/** Records an approved grant; a Replace window ends the grant it replaces. Raises `grant_created`. */
export function recordGrant(ctx: StoreContext, alerts: Alerts, w: PairingWindow, policyClientId: string, grantId: string): void {
  transaction(ctx.db, () => {
    const now = iso(ctx.clock.now());
    prepared(ctx.db, "INSERT INTO grant_meta (grant_id, client_id, created_at, last_used_at) VALUES (?, ?, ?, ?)").run(grantId, policyClientId, now, now);
    if (w.replaces_client_id && w.replaces_client_id !== policyClientId) revokeClientGrants(ctx, w.replaces_client_id);
  });
  alerts.raise("grant_created", { vendor: w.vendor, client: policyClientId });
}

/** Ends every grant of a client: tokens deleted, grant_meta revoked (the owner's "Revoke", or Replace). */
export function revokeClientGrants(ctx: StoreContext, policyClientId: string): number {
  const now = iso(ctx.clock.now());
  const grants = (prepared(ctx.db, "SELECT grant_id FROM grant_meta WHERE client_id = ? AND revoked_at IS NULL").all(policyClientId) as { grant_id: string }[]).map((g) => g.grant_id);
  for (const g of grants) {
    prepared(ctx.db, "UPDATE grant_meta SET revoked_at = ? WHERE grant_id = ?").run(now, g);
    prepared(ctx.db, "DELETE FROM oidc_store WHERE grant_id = ?").run(g);
  }
  return grants.length;
}

export const isPcClient = (oauthClientId: string): boolean => oauthClientId === PC_CLIENT_ID;
