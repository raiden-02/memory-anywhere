// The PC grant (auth-and-security.md §5.6, topology-and-ipc.md §10): how this PC signs in to a
// remote store, keeps its tokens fresh, and signs out.
//
//   mema login ── PKCE (S256) ──► browser: {store}/oauth/auth ──► consent page shows the login code
//        ▲                                                         the terminal printed; owner approves
//        └── http://127.0.0.1:<ephemeral>/callback?code=… ◄────────┘
//   then code + verifier ──► /oauth/token ──► {data}\tokens.json (user-only, atomic)
//
// Every process that needs an access token calls `accessToken`: it reads tokens.json and, when the
// token expires within 60 s, refreshes it under {data}\tokens.lock so that two processes never spend
// the same refresh token (the server treats a reused refresh token as theft). No admin token is
// ever written to disk: step-up tokens live in the memory of the command that asked for them.

import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { loginCode } from "@memory-anywhere/contracts/login-code";
import type { Paths } from "@memory-anywhere/contracts/paths";
import { ensurePrivateDir, writeFileAtomic } from "@memory-anywhere/contracts/secure-fs";
import { z } from "zod";

export const PC_CLIENT_ID = "memory-anywhere-cli";
export const PC_SCOPE = "memory.read memory.write memory.capture offline_access";

/** Refresh when the access token has less than this left. */
const REFRESH_MARGIN_MS = 60_000;
/** A lock older than this was left by a dead process. */
const LOCK_STALE_MS = 30_000;
/** How long `mema login` waits for the owner to approve in the browser. */
export const LOGIN_WAIT_MS = 10 * 60_000;

const TokensFile = z.object({
  issuer: z.string(),
  client_id: z.string(),
  refresh_token: z.string(),
  access_token: z.string(),
  access_expires_at: z.string(),
});
export type Tokens = z.infer<typeof TokensFile>;

const TokenResponse = z.object({ access_token: z.string(), refresh_token: z.string().optional(), expires_in: z.number() });

const ServerMetadata = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  revocation_endpoint: z.string().optional(),
});
export type ServerMetadata = z.infer<typeof ServerMetadata>;

/** Why the PC has no usable token: `mema login` fixes both. */
export class AuthError extends Error {
  override readonly name = "AuthError";
  readonly code: "not_logged_in" | "refresh_failed";
  constructor(code: AuthError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export interface AuthDeps {
  readonly paths: Paths;
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

export function readTokens(paths: Paths): Tokens | undefined {
  if (!existsSync(paths.tokensFile)) return undefined;
  const parsed = TokensFile.safeParse(JSON.parse(readFileSync(paths.tokensFile, "utf8")));
  return parsed.success ? parsed.data : undefined;
}

function writeTokens(paths: Paths, t: Tokens): void {
  ensurePrivateDir(paths.dataDir);
  writeFileAtomic(paths.tokensFile, `${JSON.stringify(t, null, 2)}\n`, { private: true });
}

export async function discover(storeUrl: string, f: typeof fetch): Promise<ServerMetadata> {
  const res = await f(`${storeUrl}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`the store has no OAuth metadata (HTTP ${res.status}); is it in aws mode?`);
  const meta = ServerMetadata.parse(await res.json());
  if (meta.issuer !== storeUrl) throw new Error(`the store says its issuer is ${meta.issuer}, not ${storeUrl}`);
  return meta;
}

async function tokenRequest(f: typeof fetch, endpoint: string, form: Record<string, string>): Promise<z.infer<typeof TokenResponse>> {
  const res = await f(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new AuthError("refresh_failed", `the store refused the token request: ${String(body["error"] ?? res.status)}`);
  return TokenResponse.parse(body);
}

/** A PKCE pair (RFC 7636, S256). */
export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export interface LoginIo {
  /** Prints a line for the owner. */
  readonly out: (line: string) => void;
  /** Opens the URL in the default browser; false when it could not. */
  readonly openBrowser: (url: string) => Promise<boolean>;
  /** This computer's name, as the owner types it into the pairing window. */
  readonly machineName: string;
}

/** Waits for one request to /callback on 127.0.0.1 and answers the browser with a short page. */
function callbackServer(state: string): { ready: Promise<number>; result: Promise<URLSearchParams>; close: () => void } {
  let server: Server | undefined;
  let settle: ((q: URLSearchParams) => void) | undefined;
  const result = new Promise<URLSearchParams>((resolve) => {
    settle = resolve;
  });
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback" || url.searchParams.get("state") !== state) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
      return;
    }
    const ok = url.searchParams.has("code");
    res.writeHead(ok ? 200 : 400, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end(ok ? "Signed in. You can close this tab and go back to the terminal." : "Not signed in. Go back to the terminal for details.");
    settle?.(url.searchParams);
  });
  const ready = new Promise<number>((resolve, reject) => {
    server?.once("error", reject);
    server?.listen(0, "127.0.0.1", () => resolve((server?.address() as AddressInfo).port));
  });
  return {
    ready,
    result,
    close: () => {
      server?.close();
      server = undefined;
    },
  };
}

/**
 * `mema login`: the authorization code flow with PKCE on a loopback redirect. The owner must have
 * a PC pairing window open in the admin UI; the consent page shows the code printed here.
 */
export async function login(storeUrl: string, d: AuthDeps, io: LoginIo, openBrowser = true): Promise<Tokens> {
  const meta = await discover(storeUrl, d.fetch);
  const p = pkce();
  const state = randomBytes(16).toString("base64url");
  const cb = callbackServer(state);
  try {
    const port = await cb.ready;
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    const q = new URLSearchParams({
      response_type: "code", client_id: PC_CLIENT_ID, redirect_uri: redirectUri, scope: PC_SCOPE, resource: `${storeUrl}/mcp`,
      code_challenge: p.challenge, code_challenge_method: "S256", state,
    });
    const url = `${meta.authorization_endpoint}?${q}`;
    io.out(`First open a pairing window: admin UI → Apps → App "PC", computer name "${io.machineName}".`);
    io.out(`Login code: ${loginCode(p.challenge)}  (the approval page must show the same code)`);
    if (!openBrowser || !(await io.openBrowser(url))) io.out(`Open this link in the browser where you are signed in to the admin UI:\n${url}`);
    const answer = await Promise.race([
      cb.result,
      d.sleep(LOGIN_WAIT_MS).then(() => {
        throw new Error("no answer from the browser within 10 minutes; run `mema login` again");
      }),
    ]);
    const code = answer.get("code");
    if (!code) throw new Error(`the store did not grant access: ${answer.get("error_description") ?? answer.get("error") ?? "no code"}`);
    const t = await tokenRequest(d.fetch, meta.token_endpoint, {
      grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: p.verifier, client_id: PC_CLIENT_ID,
    });
    if (!t.refresh_token) throw new Error("the store returned no refresh token");
    const tokens: Tokens = {
      issuer: meta.issuer, client_id: PC_CLIENT_ID, refresh_token: t.refresh_token, access_token: t.access_token,
      access_expires_at: new Date(d.now() + t.expires_in * 1000).toISOString(),
    };
    writeTokens(d.paths, tokens);
    return tokens;
  } finally {
    cb.close();
  }
}

/** Takes {data}\tokens.lock (exclusive create); a lock older than 30 s is taken over. */
async function withLock<T>(d: AuthDeps, fn: () => Promise<T>): Promise<T> {
  ensurePrivateDir(d.paths.dataDir);
  for (let waited = 0; ; waited += 100) {
    try {
      closeSync(openSync(d.paths.tokensLock, "wx"));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let age: number;
      try {
        age = d.now() - statSync(d.paths.tokensLock).mtimeMs;
      } catch {
        continue; // released between the two calls
      }
      if (age > LOCK_STALE_MS) rmSync(d.paths.tokensLock, { force: true });
      else if (waited > LOCK_STALE_MS) throw new AuthError("refresh_failed", "another process holds tokens.lock");
      else await d.sleep(100);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(d.paths.tokensLock, { force: true });
  }
}

/**
 * A current access token for `storeUrl`, refreshed when it expires within 60 s (or when `force`,
 * after the store answered 401). Throws AuthError when the PC must log in again.
 */
export async function accessToken(storeUrl: string, d: AuthDeps, force = false): Promise<string> {
  const fresh = (t: Tokens | undefined): t is Tokens => t !== undefined && Date.parse(t.access_expires_at) - d.now() > REFRESH_MARGIN_MS;
  const first = readTokens(d.paths);
  if (!first || first.issuer !== storeUrl) throw new AuthError("not_logged_in", "this PC is not signed in to the store; run `mema login`");
  if (!force && fresh(first)) return first.access_token;
  return withLock(d, async () => {
    // Another process may have refreshed while this one waited for the lock.
    const now = readTokens(d.paths);
    if (!now || now.issuer !== storeUrl) throw new AuthError("not_logged_in", "this PC is not signed in to the store; run `mema login`");
    if (fresh(now) && (!force || now.access_token !== first.access_token)) return now.access_token;
    const meta = await discover(storeUrl, d.fetch);
    let t: z.infer<typeof TokenResponse>;
    try {
      t = await tokenRequest(d.fetch, meta.token_endpoint, { grant_type: "refresh_token", refresh_token: now.refresh_token, client_id: now.client_id });
    } catch (e) {
      if (e instanceof AuthError) throw new AuthError("refresh_failed", `${e.message}; run \`mema login\``);
      throw e;
    }
    const next: Tokens = {
      ...now, access_token: t.access_token, refresh_token: t.refresh_token ?? now.refresh_token,
      access_expires_at: new Date(d.now() + t.expires_in * 1000).toISOString(),
    };
    writeTokens(d.paths, next);
    return next.access_token;
  });
}

/** `mema logout`: revokes the PC grant at the store (best effort when offline) and deletes tokens.json. */
export async function logout(d: AuthDeps): Promise<"revoked" | "deleted" | "not_logged_in"> {
  const t = readTokens(d.paths);
  if (!t) return "not_logged_in";
  let revoked = false;
  try {
    const meta = await discover(t.issuer, d.fetch);
    if (meta.revocation_endpoint) {
      const res = await d.fetch(meta.revocation_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: t.refresh_token, token_type_hint: "refresh_token", client_id: t.client_id }).toString(),
        signal: AbortSignal.timeout(10_000),
      });
      revoked = res.ok;
    }
  } catch {
    // Offline: the grant still ends at its idle limit, and the owner can revoke it in the admin UI.
  }
  rmSync(d.paths.tokensFile, { force: true });
  return revoked ? "revoked" : "deleted";
}
