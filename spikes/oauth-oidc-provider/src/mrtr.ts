// MRTR requestState (conformance test 20): the state a server hands a client between the rounds
// of a multi-round-trip request is HMAC-signed, bound to one grant, expires, and is single use.
// Anything tampered, expired, replayed or from another grant verifies as null, and the caller
// takes its "else" branch (start over) instead of trusting it.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface RequestState<T> {
  grantId: string;
  data: T;
}

export class RequestStates {
  private readonly key: Buffer;
  private readonly ttlMs: number;
  private readonly used = new Map<string, number>();
  private readonly now: () => number;

  constructor(key: Buffer = randomBytes(32), ttlMs = 10 * 60_000, now: () => number = () => Date.now()) {
    this.key = key;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  private mac(body: string): string {
    return createHmac("sha256", this.key).update(body).digest("base64url");
  }

  sign<T>(grantId: string, data: T): string {
    const body = Buffer.from(JSON.stringify({ g: grantId, d: data, n: randomBytes(12).toString("base64url"), e: this.now() + this.ttlMs })).toString("base64url");
    return `${body}.${this.mac(body)}`;
  }

  /** The state's data, or null for anything that must not be trusted. */
  verify<T>(token: string, grantId: string): T | null {
    const [body, mac] = token.split(".");
    if (!body || !mac) return null;
    const expected = Buffer.from(this.mac(body));
    const got = Buffer.from(mac);
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
    let state: { g: string; d: T; n: string; e: number };
    try {
      state = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as typeof state;
    } catch {
      return null;
    }
    if (state.g !== grantId || state.e <= this.now() || this.used.has(state.n)) return null;
    this.used.set(state.n, state.e);
    for (const [n, e] of this.used) if (e <= this.now()) this.used.delete(n);
    return state.d;
  }
}
