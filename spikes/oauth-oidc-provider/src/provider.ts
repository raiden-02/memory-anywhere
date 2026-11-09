// node-oidc-provider configuration (auth-and-security.md §4.5, §4.7, §5): authorization code with
// S256 PKCE, refresh tokens, resource indicators (opaque, audience-bound to the MCP URL), CIMD
// (experimental, exact-match per vendor, only inside that vendor's window), registration gated by
// the host app, revocation. Disabled: implicit, client credentials, device, introspection,
// userinfo, end-session, RFC 7592, PAR, DPoP. Consent is never remembered.

import { generateKeyPairSync, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import Provider, { errors, type Configuration } from "oidc-provider";
import { cimdVendorFor, isLoopback, PC_CLIENT_ID, VENDORS } from "./config.ts";
import { adapterFactory } from "./db.ts";
import type { Pairing } from "./pairing.ts";

export interface ProviderOptions {
  issuer: string;
  mcpUrl: string;
  db: DatabaseSync;
  pairing: Pairing;
  /** Tests replace the network (CIMD fetches); the library still applies its SSRF dispatcher. */
  fetch?: Configuration["fetch"];
}

const DAY = 86_400;

export const ERROR_PAGE = `<!doctype html><meta charset="utf-8"><title>Request not valid</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>This request is not valid</h1>
<p>Start again from the app you were connecting.</p></body>`;

export function createProvider(opts: ProviderOptions): Provider {
  const { issuer, mcpUrl, db, pairing } = opts;
  const rotation = db.prepare("SELECT refresh_rotation FROM client_policy WHERE client_id = ?");
  const config: Configuration = {
    adapter: adapterFactory(db),
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
    cookies: { keys: [randomBytes(32).toString("base64url")] },
    // Nothing is signed (opaque tokens, no ID tokens); a per-process key keeps /oauth/jwks valid.
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
        getResourceServerInfo: (_ctx, resource) => {
          if (resource !== mcpUrl) throw new errors.InvalidTarget();
          return { scope: "memory.read memory.write memory.capture", audience: mcpUrl, accessTokenTTL: 3600, accessTokenFormat: "opaque" };
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
      Grant: 180 * DAY,
      // §5.2: PC 30 days; public CIMD/DCR clients 90 days; static confidential vendor clients 180 days.
      RefreshToken: (_ctx, _token, client) =>
        client.clientId === PC_CLIENT_ID ? 30 * DAY : client.tokenEndpointAuthMethod === "none" ? 90 * DAY : 180 * DAY,
    },
    // §5.3: rotate on every use unless the client policy is `fixed` (Gemini static).
    rotateRefreshToken: (ctx) => {
      const clientId = ctx.oidc.entities.Client?.clientId ?? "";
      return (rotation.get(clientId) as { refresh_rotation: string } | undefined)?.refresh_rotation !== "fixed";
    },
    // Vendors ask for `memory.read memory.write` without `offline_access` (ChatGPT does), and the
    // library would then bind their tokens to the owner's 10-minute consent session: the grant
    // would die with it. A grant lives by its own lifetimes (§5.2), never by that browser session.
    issueRefreshToken: async (_ctx, client) => client.grantTypeAllowed("refresh_token"),
    expiresWithSession: async () => false,
    // Consent is never remembered (§4.6): only the grant the owner approved in this very
    // interaction is used, never one from an earlier authorization.
    loadExistingGrant: async (ctx) => {
      const grantId = ctx.oidc.result?.consent?.grantId;
      return grantId ? ctx.oidc.provider.Grant.find(grantId) : undefined;
    },
    interactions: { url: (_ctx, interaction) => `/consent/${interaction.uid}` },
    findAccount: async (_ctx, sub) => ({ accountId: sub, claims: async () => ({ sub }) }),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    renderError: async (ctx) => {
      ctx.type = "html";
      ctx.status = 400;
      ctx.body = ERROR_PAGE;
    },
  };
  const provider = new Provider(issuer, config);
  provider.proxy = true; // behind Caddy, which sets X-Forwarded-Proto (deployment-aws.md §4)
  return provider;
}
