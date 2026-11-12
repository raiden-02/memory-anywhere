// Authentication for a public store (auth-and-security.md): the pieces wired together for one
// server. The HTTP server gets the resource-server authenticator and one mount per surface.
//
//   https://{host}         mcp surface    /mcp, /v1 (bearer)  + OAuth, pair link, consent (oauth-routes)
//   https://admin.{host}   admin surface  setup, recovery, sign-in, step-up, pairing (admin-routes)

import type { Configuration } from "oidc-provider";
import type Provider from "oidc-provider";
import type { App } from "../app.ts";
import type { Authenticate } from "../api/grant.ts";
import type { FrontDoor, Surface } from "../http/front.ts";
import type { Logger } from "../http/log.ts";
import type { Mount } from "../http/server.ts";
import { adminRoutes } from "./admin-routes.ts";
import { oauthRoutes } from "./oauth-routes.ts";
import { OwnerCredentials } from "./owner.ts";
import { Pairing } from "./pairing.ts";
import { Passkeys } from "./passkeys.ts";
import { createProvider } from "./provider.ts";
import { oauthAuthenticate } from "./resource.ts";

export interface Auth {
  readonly provider: Provider;
  readonly pairing: Pairing;
  readonly passkeys: Passkeys;
  readonly owner: OwnerCredentials;
  readonly authenticate: Authenticate;
  readonly mounts: Readonly<Record<Surface, Mount>>;
}

export function createAuth(o: { app: App; door: FrontDoor; logger: Logger; fetch?: Configuration["fetch"] }): Auth {
  const { app, door, logger } = o;
  const pairing = new Pairing(app.ctx);
  // RP ID {host}: the registrable parent of admin.{host}, so one passkey works on both origins (§3.2).
  const passkeys = new Passkeys(app.ctx, app.alerts, new URL(door.baseUrl).hostname, [door.adminUrl, door.baseUrl]);
  const owner = new OwnerCredentials(app.ctx, app.outbox, app.alerts);
  const provider = createProvider({ ctx: app.ctx, issuer: door.baseUrl, pairing, ...(o.fetch ? { fetch: o.fetch } : {}) });
  return {
    provider,
    pairing,
    passkeys,
    owner,
    authenticate: oauthAuthenticate(provider, app.ctx, `${door.baseUrl}/mcp`),
    mounts: {
      mcp: oauthRoutes({ app, door, provider, pairing, passkeys, logger }),
      admin: adminRoutes({ app, door, provider, pairing, passkeys, owner }),
    },
  };
}
