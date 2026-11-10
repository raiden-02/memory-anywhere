// Typed ULIDs (data-model.md §1): Crockford base32, 26 characters, after a type prefix such as
// `mem_`. Generation is monotonic within a source, so ids created in the same millisecond still
// sort in creation order (the spool drains in ULID order, topology-and-ipc.md §9).
//
// The server takes an `IdSource` wherever it creates rows. Production uses the default source
// (crypto randomness); the replay-determinism property tests use a seeded one, because the content
// hash covers memory and entity ids (data-model.md §12, write-path.md §14).

import { monotonicFactory } from "ulid";

export const ULID_PATTERN = "[0-9A-HJKMNP-TV-Z]{26}";

export const ID_PREFIXES = [
  "ent", "mem", "ver", "src", "obs", "omn", "sec", "att", "evt", "rev", "imb", "sup", "job", "cli", "grt", "alr", "pel",
  // Request keys: spool entry, proxy save, admin request, proxy instance.
  "spl", "pxs", "adm", "pxy",
] as const;
export type IdPrefix = (typeof ID_PREFIXES)[number];

export interface IdSource {
  /** A new id such as `mem_01JC9Z3N4V8Q2W5X7Y9Z0A1B2C`. */
  newId<P extends IdPrefix>(prefix: P, now?: number): `${P}_${string}`;
  /** A bare ULID (no prefix), e.g. for `meta.store_id`. */
  newUlid(now?: number): string;
}

/** An id source; pass `prng` (returning numbers in [0, 1)) for reproducible ids. */
export function idSource(prng?: () => number): IdSource {
  const next = monotonicFactory(prng);
  return {
    newId: (prefix, now = Date.now()) => `${prefix}_${next(now)}`,
    newUlid: (now = Date.now()) => next(now),
  };
}

/** mulberry32: a small seeded PRNG for reproducible ids in tests. */
export function seededPrng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const defaultIds: IdSource = idSource();

export function newId<P extends IdPrefix>(prefix: P, now: number = Date.now()): `${P}_${string}` {
  return defaultIds.newId(prefix, now);
}

export function newUlid(now: number = Date.now()): string {
  return defaultIds.newUlid(now);
}

export function idPattern(prefix: IdPrefix): RegExp {
  return new RegExp(`^${prefix}_${ULID_PATTERN}$`);
}

export function isId(prefix: IdPrefix, value: string): boolean {
  return idPattern(prefix).test(value);
}
