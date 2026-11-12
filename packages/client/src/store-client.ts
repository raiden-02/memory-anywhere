// HTTP calls from the PC to the store (mcp-interface.md §7). Every request carries the bearer
// token and MA-Client-Version; each call has its own deadline (topology-and-ipc.md §5). Failures
// come back as a typed StoreError, so callers can tell "offline" from "the store said no".
//
// The bearer is either fixed (local mode: the local token file) or the PC grant (remote mode),
// whose access token is refreshed before it expires, and once more after a 401 (topology §5 step 8).

import { readFileSync } from "node:fs";
import type { Paths } from "@memory-anywhere/contracts/paths";
import { accessToken, AuthError } from "./auth.ts";
import { CLIENT_VERSION, storeUrl, type ClientConfigT } from "./config.ts";

export type StoreErrorKind = "offline" | "unauthorized" | "too_old" | "rejected";

export class StoreError extends Error {
  readonly kind: StoreErrorKind;
  readonly status: number | undefined;
  readonly body: unknown;
  constructor(kind: StoreErrorKind, message: string, status?: number, body?: unknown) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.body = body;
  }
}

export interface RequestHeaders {
  readonly tool?: string | undefined;
  readonly repoKey?: string | undefined;
  readonly session?: string | undefined;
  /** A step-up token for one owner command (mcp-interface.md §7). */
  readonly stepUp?: string | undefined;
}

/** The PC grant's access token; `force` refreshes even a token that looks current (after a 401). */
export type TokenProvider = (force: boolean) => Promise<string>;

/** The bearer token file: in local mode the local token file; MA_TOKEN_FILE overrides (evals). */
export function readToken(config: ClientConfigT, paths: Paths, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const file = env["MA_TOKEN_FILE"] || (config.store.mode === "local" ? paths.localTokenFile : undefined);
  if (!file) return undefined;
  try {
    return readFileSync(file, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

export class StoreClient {
  readonly url: string | undefined;
  readonly #token: string | TokenProvider | undefined;
  readonly #fetch: typeof fetch;

  constructor(url: string | undefined, token: string | TokenProvider | undefined, fetchImpl: typeof fetch = fetch) {
    this.url = url;
    this.#token = token;
    this.#fetch = fetchImpl;
  }

  /** Local mode (or MA_TOKEN_FILE): the token file. Remote mode: the PC grant in tokens.json. */
  static from(config: ClientConfigT, paths: Paths, fetchImpl: typeof fetch = fetch, env: NodeJS.ProcessEnv = process.env): StoreClient {
    const url = storeUrl(config, env);
    const fixed = readToken(config, paths, env);
    if (fixed !== undefined || config.store.mode === "local" || !url) return new StoreClient(url, fixed, fetchImpl);
    const deps = { paths, fetch: fetchImpl, now: Date.now, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };
    return new StoreClient(url, (force) => accessToken(url, deps, force), fetchImpl);
  }

  /** Every header but the bearer, which `fetch` adds. */
  headers(h: RequestHeaders = {}): Record<string, string> {
    return {
      "ma-client-version": CLIENT_VERSION,
      ...(h.tool ? { "ma-tool": h.tool } : {}),
      ...(h.repoKey ? { "ma-repo-key": h.repoKey } : {}),
      ...(h.session ? { "ma-session": h.session } : {}),
      ...(h.stepUp ? { "ma-step-up": h.stepUp } : {}),
    };
  }

  async #bearer(force: boolean): Promise<string | undefined> {
    if (typeof this.#token !== "function") return this.#token;
    try {
      return await this.#token(force);
    } catch (e) {
      if (e instanceof AuthError) throw new StoreError("unauthorized", e.message, 401);
      throw e;
    }
  }

  /**
   * fetch with the bearer token added; with the PC grant, a 401 refreshes the token and retries
   * once. The MCP proxy's transport uses it too, so every route shares one refresh rule.
   */
  readonly fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const send = async (force: boolean): Promise<Response> => {
      const token = await this.#bearer(force);
      const headers = new Headers(init.headers);
      if (token) headers.set("authorization", `Bearer ${token}`);
      return this.#fetch(input, { ...init, headers });
    };
    const res = await send(false);
    if (res.status !== 401 || typeof this.#token !== "function") return res;
    await res.body?.cancel();
    return send(true);
  };

  async #send(method: "GET" | "POST", route: string, body: unknown, timeoutMs: number, h: RequestHeaders): Promise<Response> {
    if (!this.url) throw new StoreError("offline", "no store configured; run `mema init`");
    try {
      return await this.fetch(`${this.url}${route}`, {
        method,
        headers: { ...this.headers(h), ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      if (e instanceof StoreError) throw e;
      throw new StoreError("offline", `the store did not answer (${(e as Error).name})`);
    }
  }

  /** One JSON request with a deadline. 304 returns undefined. */
  async request<T>(method: "GET" | "POST", route: string, body: unknown, timeoutMs: number, h: RequestHeaders = {}): Promise<T | undefined> {
    const res = await this.#send(method, route, body, timeoutMs, h);
    const text = await res.text();
    const parsed = text ? (JSON.parse(text) as unknown) : undefined;
    if (res.status === 304) return undefined;
    if (res.ok) return parsed as T;
    throw failure(res.status, parsed);
  }

  /** A request whose answer is a file: its bytes and content type. */
  async download(method: "GET" | "POST", route: string, body: unknown, timeoutMs: number, h: RequestHeaders = {}): Promise<{ contentType: string; bytes: Uint8Array }> {
    const res = await this.#send(method, route, body, timeoutMs, h);
    if (res.ok) return { contentType: res.headers.get("content-type") ?? "application/octet-stream", bytes: new Uint8Array(await res.arrayBuffer()) };
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    throw failure(res.status, parsed);
  }
}

function failure(status: number, parsed: unknown): StoreError {
  if (status === 401) return new StoreError("unauthorized", "the store refused the token; run `mema login`", 401, parsed);
  if (status === 426) return new StoreError("too_old", "this client is too old for the store", 426, parsed);
  if (status >= 500 || status === 408 || status === 429) return new StoreError("offline", `the store answered ${status}`, status, parsed);
  return new StoreError("rejected", (parsed as { message?: string } | undefined)?.message ?? `HTTP ${status}`, status, parsed);
}
