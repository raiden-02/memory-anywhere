// HTTP calls from the PC to the store (mcp-interface.md §7). Every request carries the bearer
// token and MA-Client-Version; each call has its own deadline (topology-and-ipc.md §5). Failures
// come back as a typed StoreError, so callers can tell "offline" from "the store said no".

import { readFileSync } from "node:fs";
import type { Paths } from "@memory-anywhere/contracts/paths";
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
}

/** The bearer token: in local mode the local token file; MA_TOKEN_FILE overrides (evals). */
export function readToken(config: ClientConfigT, paths: Paths, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const file = env["MA_TOKEN_FILE"] || (config.store.mode === "local" ? paths.localTokenFile : undefined);
  if (!file) return undefined; // the PC grant (remote mode) arrives in M2
  try {
    return readFileSync(file, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

export class StoreClient {
  readonly url: string | undefined;
  readonly #token: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(url: string | undefined, token: string | undefined, fetchImpl: typeof fetch = fetch) {
    this.url = url;
    this.#token = token;
    this.#fetch = fetchImpl;
  }

  static from(config: ClientConfigT, paths: Paths, fetchImpl: typeof fetch = fetch): StoreClient {
    return new StoreClient(storeUrl(config), readToken(config, paths), fetchImpl);
  }

  headers(h: RequestHeaders = {}): Record<string, string> {
    return {
      ...(this.#token ? { authorization: `Bearer ${this.#token}` } : {}),
      "ma-client-version": CLIENT_VERSION,
      ...(h.tool ? { "ma-tool": h.tool } : {}),
      ...(h.repoKey ? { "ma-repo-key": h.repoKey } : {}),
      ...(h.session ? { "ma-session": h.session } : {}),
    };
  }

  /** One JSON request with a deadline. 304 returns undefined. */
  async request<T>(method: "GET" | "POST", route: string, body: unknown, timeoutMs: number, h: RequestHeaders = {}): Promise<T | undefined> {
    if (!this.url) throw new StoreError("offline", "no store configured; run `mema init`");
    let res: Response;
    try {
      res = await this.#fetch(`${this.url}${route}`, {
        method,
        headers: { ...this.headers(h), ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new StoreError("offline", `the store did not answer (${(e as Error).name})`);
    }
    const text = await res.text();
    const parsed = text ? (JSON.parse(text) as unknown) : undefined;
    if (res.status === 304) return undefined;
    if (res.ok) return parsed as T;
    if (res.status === 401) throw new StoreError("unauthorized", "the store refused the token", 401, parsed);
    if (res.status === 426) throw new StoreError("too_old", "this client is too old for the store", 426, parsed);
    if (res.status >= 500 || res.status === 408 || res.status === 429) throw new StoreError("offline", `the store answered ${res.status}`, res.status, parsed);
    throw new StoreError("rejected", (parsed as { message?: string } | undefined)?.message ?? `HTTP ${res.status}`, res.status, parsed);
  }
}
