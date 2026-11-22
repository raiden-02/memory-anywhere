// The `meta` table (data-model.md §2): one text value per key, for the store's own settings and
// secrets (cookie secret, HMAC keys, thresholds, the event chain head). `init` writes the required
// keys, so a missing one means the store was never initialised.

import type { DatabaseSync } from "node:sqlite";
import { SENSITIVE_CATEGORIES, type SensitiveCategory } from "../policy/generated.ts";
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

/** The meta key holding the owner's choice of private sensitive categories (memory-policy.md §7.1), a JSON array. */
export const PRIVATE_TOPICS_KEY = "sensitive_private";

/**
 * The sensitive categories this store treats as private (memory-policy.md §7.1): the owner's choice
 * from the admin UI when made, else the config's `[sensitive] blocked`. Unknown ids are ignored, so a
 * policy release that drops a category cannot make a stale choice fail.
 */
export function privateCategories(
	db: DatabaseSync,
	config: { readonly sensitive: { readonly blocked: readonly SensitiveCategory[] } },
): readonly SensitiveCategory[] {
	const stored = metaValue(db, PRIVATE_TOPICS_KEY);
	if (stored === undefined) return config.sensitive.blocked;
	const chosen = new Set(JSON.parse(stored) as unknown[]);
	return SENSITIVE_CATEGORIES.filter((c) => chosen.has(c));
}
