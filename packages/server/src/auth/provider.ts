// node-oidc-provider configuration (auth-and-security.md §4.5, §4.7, §5; ADR-0004): authorization
// code with S256 PKCE, refresh tokens, resource indicators (opaque tokens bound to the MCP URL),
// CIMD (only for the vendor whose window is open), registration (gated by the host, §4.3),
// revocation. Off: implicit, client credentials, device, introspection, userinfo, end-session,
// RFC 7592, PAR, DPoP. Consent is never remembered.
//
// Lifetimes (§5.2), counted from when the owner approved the grant:
//
//   client                          absolute    idle (no use at all for this long ends the grant)
//   PC (mema login)                 30 days     7 days
//   public CIMD/DCR (Grok, …)       90 days     30 days
//   static confidential (Claude, …) 180 days    30 days
//
// The absolute limit is the refresh token's expiry, never extended by rotation; the idle limit is
// checked at each refresh against `grant_meta.last_used_at` (oauth-routes.ts).

import { generateKeyPairSync } from "node:crypto";
import Provider, { errors, type Configuration } from "oidc-provider";
import type { StoreContext } from "../store/context.ts";
import { DAY_MS } from "../store/clock.ts";
import { prepared } from "../store/db.ts";
import { PAGE_HEADERS } from "../web/pages.ts";
import { oidcAdapter } from "./adapter.ts";
import type { Pairing } from "./pairing.ts";
import { cimdVendorFor, isLoopback, PC_CLIENT_ID, PC_SCOPE, VENDOR_SCOPE, VENDORS } from "./vendors.ts";

export interface ProviderOptions {
  readonly ctx: StoreContext;
  /** `https://{host}`; the MCP resource is `<issuer>/mcp`. */
  readonly issuer: string;
  readonly pairing: Pairing;
  /** Tests replace the network for CIMD fetches; the library still applies its SSRF dispatcher. */
  readonly fetch?: Configuration["fetch"];
}

export interface Lifetime {
  readonly absoluteMs: number;
  readonly idleMs: number;
}

/** §5.2 by client kind: the PC, a public client, or a static confidential one. */
export function lifetimeFor(clientId: string, tokenEndpointAuthMethod: string | undefined): Lifetime {
  if (clientId === PC_CLIENT_ID) return { absoluteMs: 30 * DAY_MS, idleMs: 7 * DAY_MS };
  if (tokenEndpointAuthMethod === "none") return { absoluteMs: 90 * DAY_MS, idleMs: 30 * DAY_MS };
  return { absoluteMs: 180 * DAY_MS, idleMs: 30 * DAY_MS };
}

/** The one page every failed authorization shows (§4.1 step 4): it never says why. */
export const ERROR_PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Request not valid</title>
<link rel="stylesheet" href="/assets/app.css"><main><h1>This request is not valid</h1><p>Start again from the app you were connecting.</p></main></html>`;

export function createProvider(o: ProviderOptions): Provider {
  const { ctx, issuer, pairing } = o;
  const mcpUrl = `${issuer}/mcp`;
  const rotation = (oauthClientId: string): string | undefined =>
    (prepared(ctx.db, "SELECT refresh_rotation FROM client_policy WHERE oauth_client_id = ?").get(oauthClientId) as { refresh_rotation: string } | undefined)?.refresh_rotation;
  const grantCreated = (grantId: string): number | undefined => {
    const at = (prepared(ctx.db, "SELECT created_at FROM grant_meta WHERE grant_id = ?").get(grantId) as { created_at: string } | undefined)?.created_at;
    return at ? Date.parse(at) : undefined;
  };
  /** A client's token endpoint auth method: stored clients carry it; the PC and CIMD clients are public. */
  const authMethod = (clientId: string): string => {
    const row = prepared(ctx.db, "SELECT payload_json FROM oidc_store WHERE model = 'Client' AND id = ?").get(clientId) as { payload_json: string } | undefined;
    return row ? ((JSON.parse(row.payload_json) as { token_endpoint_auth_method?: string }).token_endpoint_auth_method ?? "client_secret_basic") : "none";
  };
  /** Whether a client may write: its policy once it has one; before that, the window it is being paired in (§4.4). */
  const writeAllowed = (oauthClientId: string): boolean => {
    const policy = prepared(ctx.db, "SELECT write FROM client_policy WHERE oauth_client_id = ?").get(oauthClientId) as { write: number } | undefined;
    if (policy) return policy.write === 1;
    const w = pairing.active();
    return !(w && w.registered_client_id === oauthClientId && w.other_write === 0);
  };
  const cookieKey = (prepared(ctx.db, "SELECT value FROM meta WHERE key = 'cookie_secret'").get() as { value: string } | undefined)?.value;
  if (!cookieKey) throw new Error("meta.cookie_secret is missing; run `memory-anywhere-server init`");

  const config: Configuration = {
    adapter: oidcAdapter(ctx),
    clients: [
      {
        client_id: PC_CLIENT_ID,
        token_endpoint_auth_method: "none",
        application_type: "native",
        redirect_uris: ["http://127.0.0.1/callback", "http://localhost/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
    ],
    clientDefaults: { grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "client_secret_basic" },
    responseTypes: ["code"],
    scopes: ["offline_access"],
    pkce: { required: () => true },
    // Signs the library's interaction cookies; rotated when the store is restored (deployment-aws.md §5.5).
    // The library scopes them to the consent and resume paths, so they cannot carry the `__Host-`
    // prefix (which requires Path=/); `__Secure-` keeps Secure, and they stay HttpOnly and
    // SameSite=Lax for the vendor's redirect back (§8; spec-issues #68).
    cookies: {
      keys: [cookieKey],
      names: { session: "__Secure-ma_as_session", interaction: "__Secure-ma_as", resume: "__Secure-ma_as_resume" },
      // Secure whenever the issuer is https (always in aws mode); the loopback test issuer is plain http.
      long: { httpOnly: true, sameSite: "lax", secure: issuer.startsWith("https:") },
      short: { httpOnly: true, sameSite: "lax", secure: issuer.startsWith("https:") },
    },
    // Nothing is signed with it (opaque tokens, no ID tokens); a per-process key keeps /oauth/jwks valid.
    jwks: { keys: [{ ...generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "jwk" }), alg: "RS256", use: "sig" }] },
    features: {
      devInteractions: { enabled: false },
      pushedAuthorizationRequests: { enabled: false },
      dPoP: { enabled: false },
      registration: { enabled: true, initialAccessToken: false, issueRegistrationAccessToken: false },
      registrationManagement: { enabled: false },
      revocation: { enabled: true },
      userinfo: { enabled: false },
      introspection: { enabled: false },
      rpInitiatedLogout: { enabled: false },
      resourceIndicators: {
        enabled: true,
        defaultResource: () => mcpUrl,
        useGrantedResource: () => true,
        // §5.4: memory.capture only for the PC; memory.read only for a read-only client. Any other
        // scope a client asks for is dropped, not refused: Grok asks for every advertised scope
        // (ADR-0108), and an ungrantable scope would reopen consent forever.
        getResourceServerInfo: (_ctx, resource, client) => {
          if (resource !== mcpUrl) throw new errors.InvalidTarget();
          const scope = client.clientId === PC_CLIENT_ID ? PC_SCOPE : writeAllowed(client.clientId) ? VENDOR_SCOPE : "memory.read";
          return { scope, audience: mcpUrl, accessTokenTTL: 3600, accessTokenFormat: "opaque" };
        },
      },
      clientIdMetadataDocument: {
        enabled: true,
        ack: "draft-02",
        // Fetch only the exact client_id URL of the vendor whose CIMD window is open (§4.3).
        allowFetch: async (_ctx, clientId) => {
          const w = pairing.active();
          return !!w && w.method === "cimd" && cimdVendorFor(clientId) === w.vendor;
        },
        // Redirects: https on the vendor's exact list, or loopback where the vendor allows it.
        allowClient: async (_ctx, client) => {
          const vendor = cimdVendorFor(client.clientId);
          if (!vendor) return false;
          const rule = VENDORS[vendor];
          const uris = client.redirectUris ?? [];
          return uris.length > 0 && uris.every((u) => rule.redirects.includes(u) || (rule.loopback && isLoopback(u)));
        },
      },
    },
    ttl: {
      AccessToken: 3600,
      AuthorizationCode: 60,
      Interaction: 600,
      Session: 600,
      // Called outside any request when the owner's approval saves the grant, so the client is looked up here.
      Grant: (_c, grant) => lifetimeFor(grant.clientId ?? "", authMethod(grant.clientId ?? "")).absoluteMs / 1000,
      // The rest of the grant's absolute lifetime: rotation never extends it.
      RefreshToken: (_ctx, token, client) => {
        const { absoluteMs } = lifetimeFor(client.clientId, client.tokenEndpointAuthMethod);
        const created = token.grantId ? grantCreated(token.grantId) : undefined;
        const left = created === undefined ? absoluteMs : created + absoluteMs - ctx.clock.now();
        return Math.max(1, Math.floor(left / 1000));
      },
    },
    // §5.3: rotate on every use unless the client's policy says `fixed` (Gemini).
    rotateRefreshToken: (c) => rotation(c.oidc.entities.Client?.clientId ?? "") !== "fixed",
    // A vendor that asks without `offline_access` (ChatGPT) would otherwise get tokens bound to the
    // owner's 10-minute consent session. A grant lives by its own lifetimes (§5.2).
    issueRefreshToken: async (_ctx, client) => client.grantTypeAllowed("refresh_token"),
    expiresWithSession: async () => false,
    // Consent is never remembered (§4.6): only the grant approved in this very interaction is used.
    loadExistingGrant: async (c) => {
      const grantId = c.oidc.result?.consent?.grantId;
      return grantId ? c.oidc.provider.Grant.find(grantId) : undefined;
    },
    interactions: { url: (_ctx, interaction) => `/consent/${interaction.uid}` },
    findAccount: async (_ctx, sub) => ({ accountId: sub, claims: async () => ({ sub }) }),
    ...(o.fetch ? { fetch: o.fetch } : {}),
    renderError: async (c) => {
      c.type = "html";
      c.status = 400;
      c.set(PAGE_HEADERS);
      c.body = ERROR_PAGE;
    },
  };
  const provider = new Provider(issuer, config);
  provider.proxy = true; // behind Caddy, which sets X-Forwarded-Proto
  return provider;
}
