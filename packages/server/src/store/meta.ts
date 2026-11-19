// The `meta` table (data-model.md §2): one text value per key, for the store's own settings and
// secrets (cookie secret, HMAC keys, thresholds, the event chain head). `init` writes the required
// keys, so a missing one means the store was never initialised.

import type { DatabaseSync } from "node:sqlite";
import { prepared } from "./db.ts";

export function metaValue(db: DatabaseSync, key: string): string | undefined {
	return (prepared(db, "SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
}

/** A key `init` always writes. */
export function requireMeta(db: DatabaseSync, key: string): string {
	const value = metaValue(db, key);
	if (value === undefined) throw new Error(`meta.${key} is missing; run \`memory-anywhere-server init\``);
	return value;
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
	prepared(
		db,
		"INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
	).run(key, value);
}
