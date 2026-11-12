// Who a request comes from (mcp-interface.md §6). In local mode the local token is the only
// credential: `/mcp` and `/v1` calls act as the `local` client (class coding, T2) with the repo,
// tool and session named in the MA-* headers, and `/v1/admin/*` calls act as the owner (T0)
// (topology-and-ipc.md §4). OAuth grants arrive in M2 and produce the same shape.

import type { Reader } from "../recall/reader.ts";
import { LOCAL_CLIENT_ID } from "../store/init.ts";

export interface Scopes {
  readonly read: boolean;
  readonly write: boolean;
  readonly capture: boolean;
  readonly admin: boolean;
}

export interface Grant extends Reader {
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
    clientId: LOCAL_CLIENT_ID,
    clientClass: "coding",
    repoKey: repo && REPO_KEY.test(repo) ? repo : "none",
    admin,
    scopes: { read: true, write: true, capture: true, admin },
    tool: headers.get("ma-tool") ?? undefined,
    session: (headers.get("ma-session") ?? requestId).slice(0, 128),
  };
}
