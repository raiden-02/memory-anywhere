// Who a request comes from (mcp-interface.md §6). In local mode the local token is the only
// credential: `/mcp` and `/v1` calls act as the `local` client (class coding, T2) with the repo,
// tool and session named in the MA-* headers, and `/v1/admin/*` calls act as the owner (T0)
// (topology-and-ipc.md §4). In aws mode an OAuth access token produces the same shape.

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Reader } from "../recall/reader.ts";
import { LOCAL_CLIENT_ID } from "../store/init.ts";

export interface Scopes {
  readonly read: boolean;
  readonly write: boolean;
  readonly capture: boolean;
  readonly admin: boolean;
}

export interface Grant extends Reader {
  /** The OAuth grant behind the token (`grant_meta.grant_id`), or `local` for the local token. */
  readonly grantId: string;
  readonly scopes: Scopes;
  /** `MA-Tool` (an untrusted label). */
  readonly tool: string | undefined;
  /** `MA-Session` (the proxy instance) or the hook's session id; the request id otherwise. */
  readonly session: string;
}

const REPO_KEY = /^rk_[0-9a-f]{32}$/u;

/** The local client's grant for one request, from its MA-* headers. */
export function localGrant(headers: Headers, requestId: string, admin: boolean): Grant {
  const repo = headers.get("ma-repo-key");
  return {
    grantId: "local",
    clientId: LOCAL_CLIENT_ID,
    clientClass: "coding",
    repoKey: repo && REPO_KEY.test(repo) ? repo : "none",
    admin,
    scopes: { read: true, write: true, capture: true, admin },
    tool: headers.get("ma-tool") ?? undefined,
    session: (headers.get("ma-session") ?? requestId).slice(0, 128),
  };
}

/**
 * Turns a request's credential into a grant, or undefined when it has none that is valid. The
 * HTTP layer calls it after the front door and before any store work.
 */
export type Authenticate = (req: IncomingMessage, requestId: string, admin: boolean) => Promise<Grant | undefined>;

/** Local mode: the bearer must be the local token (compared in constant time). */
export function localTokenAuth(token: string): Authenticate {
  const expected = Buffer.from(token, "utf8");
  return async (req, requestId, admin) => {
    const presented = Buffer.from(/^Bearer (\S+)$/u.exec(req.headers.authorization ?? "")?.[1] ?? "", "utf8");
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return undefined;
    return localGrant(new Headers(req.headers as Record<string, string>), requestId, admin);
  };
}

/** No credential is accepted yet (aws mode before the OAuth resource server is mounted). */
export const NO_AUTH: Authenticate = async () => undefined;
