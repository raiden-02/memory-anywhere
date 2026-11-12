// The resource server (auth-and-security.md §5.5; mcp-interface.md §1, §6): `/mcp` and `/v1`
// accept a bearer access token and turn it into the same Grant the local token produces.
//
//   Authorization: Bearer <opaque token>
//     → the library's AccessToken (unexpired, audience exactly <issuer>/mcp)
//     → grant_meta (not revoked) → client_policy (not revoked)
//     → Grant { client, class, scopes ∩ policy, repo (coding only), tool, session }
//
// Cookies are never read here, and a token for another audience is refused. Each use refreshes
// grant_meta.last_used_at (at most once a minute), which the idle lifetime counts from.

import type Provider from "oidc-provider";
import type { Authenticate, Grant } from "../api/grant.ts";
import type { StoreContext } from "../store/context.ts";
import { iso } from "../store/clock.ts";
import { prepared } from "../store/db.ts";

const REPO_KEY = /^rk_[0-9a-f]{32}$/u;
const TOUCH_MS = 60_000;

interface PolicyRow {
  readonly client_id: string;
  readonly class: "chat" | "coding";
  readonly read: number;
  readonly write: number;
  readonly last_used_at: string | null;
}

export function oauthAuthenticate(provider: Provider, ctx: StoreContext, mcpUrl: string): Authenticate {
  return async (req, requestId) => {
    const value = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/u.exec(req.headers.authorization ?? "")?.[1];
    if (!value) return undefined;
    const token = await provider.AccessToken.find(value);
    if (!token || token.isExpired || !token.grantId) return undefined;
    const aud = (token as { aud?: string | string[] }).aud;
    if (!(Array.isArray(aud) ? aud.length === 1 && aud[0] === mcpUrl : aud === mcpUrl)) return undefined;
    const p = prepared(ctx.db, `SELECT c.client_id, c.class, c.read, c.write, g.last_used_at FROM grant_meta g JOIN client_policy c ON c.client_id = g.client_id
        WHERE g.grant_id = ? AND g.revoked_at IS NULL AND c.revoked_at IS NULL`).get(token.grantId) as PolicyRow | undefined;
    if (!p) return undefined;
    const now = ctx.clock.now();
    if (p.last_used_at === null || Date.parse(p.last_used_at) + TOUCH_MS <= now) {
      prepared(ctx.db, "UPDATE grant_meta SET last_used_at = ? WHERE grant_id = ?").run(iso(now), token.grantId);
    }
    const scopes = new Set((token.scope ?? "").split(" "));
    const header = (name: string): string | undefined => {
      const v = req.headers[name];
      return typeof v === "string" ? v : undefined;
    };
    const repo = header("ma-repo-key");
    const grant: Grant = {
      grantId: token.grantId,
      clientId: p.client_id,
      clientClass: p.class,
      // Only the PC's coding tools act for a repository (topology-and-ipc.md §8).
      repoKey: p.class === "coding" ? (repo && REPO_KEY.test(repo) ? repo : "none") : undefined,
      admin: false,
      scopes: {
        read: p.read === 1 && scopes.has("memory.read"),
        write: p.write === 1 && scopes.has("memory.write"),
        capture: p.class === "coding" && scopes.has("memory.capture"),
        admin: false,
      },
      tool: p.class === "coding" ? header("ma-tool") : undefined,
      session: (header("ma-session") ?? requestId).slice(0, 128),
    };
    return grant;
  };
}
