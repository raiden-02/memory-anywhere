// In-process token buckets (operations.md §3): a key may spend `capacity` requests at once and
// regains them evenly over the period. Over the limit, the caller learns how long to wait.

/** A limiter that never limits: `--ephemeral --no-rate-limits` servers for latency evals only. */
export const UNLIMITED = { take: (_key: string): number => 0 };

export interface Limiter {
  take(key: string): number;
}

export class RateLimiter implements Limiter {
  readonly #capacity: number;
  readonly #periodMs: number;
  readonly #now: () => number;
  readonly #buckets = new Map<string, { tokens: number; at: number }>();

  constructor(capacity: number, periodMs: number, now: () => number = Date.now) {
    this.#capacity = capacity;
    this.#periodMs = periodMs;
    this.#now = now;
  }

  /** Takes one token; returns 0 when allowed, else the seconds until one is available. */
  take(key: string): number {
    const now = this.#now();
    const rate = this.#capacity / this.#periodMs;
    const b = this.#buckets.get(key) ?? { tokens: this.#capacity, at: now };
    const tokens = Math.min(this.#capacity, b.tokens + (now - b.at) * rate);
    if (tokens < 1) {
      this.#buckets.set(key, { tokens, at: now });
      return Math.max(1, Math.ceil((1 - tokens) / rate / 1000));
    }
    this.#buckets.set(key, { tokens: tokens - 1, at: now });
    if (this.#buckets.size > 10_000) this.#sweep(now);
    return 0;
  }

  /** Drops full buckets so the map cannot grow without bound. */
  #sweep(now: number): void {
    for (const [k, b] of this.#buckets) if (b.tokens + (now - b.at) * (this.#capacity / this.#periodMs) >= this.#capacity) this.#buckets.delete(k);
  }
}
