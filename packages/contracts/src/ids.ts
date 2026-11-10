// Typed ULIDs (data-model.md §1): Crockford base32, 26 characters, after a type prefix such as
// `mem_`. Generation is monotonic within a process, so ids created in the same millisecond still
// sort in creation order (the spool drains in ULID order, topology-and-ipc.md §9).

import { monotonicFactory } from "ulid";

export const ULID_PATTERN = "[0-9A-HJKMNP-TV-Z]{26}";

export const ID_PREFIXES = [
  "ent", "mem", "ver", "src", "obs", "omn", "sec", "att", "evt", "rev", "imb", "sup", "job", "cli", "grt", "alr",
  // Request keys: spool entry, proxy save, admin request, proxy instance.
  "spl", "pxs", "adm", "pxy",
] as const;
export type IdPrefix = (typeof ID_PREFIXES)[number];

const next = monotonicFactory();

/** A new id such as `mem_01JC9Z3N4V8Q2W5X7Y9Z0A1B2C`. */
export function newId<P extends IdPrefix>(prefix: P, now: number = Date.now()): `${P}_${string}` {
  return `${prefix}_${next(now)}`;
}

export function idPattern(prefix: IdPrefix): RegExp {
  return new RegExp(`^${prefix}_${ULID_PATTERN}$`);
}

export function isId(prefix: IdPrefix, value: string): boolean {
  return idPattern(prefix).test(value);
}
