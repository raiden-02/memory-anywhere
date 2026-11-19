// The daily manifest (deployment-aws.md §5.4–5.5). Every change to the store appends an event to a
// hash chain, so the chain's head stands for the whole history. Once a day the server writes the
// head, and how many events led to it, to a bucket where no one can change or delete it for 90
// days. A history rewritten later no longer reaches a locked head at the same position:
//
//   locked manifest  {event_count: 3, event_chain_head: h3}
//   live chain       e1 ─► e2 ─► e3 ─► e4 ─► e5      the 3rd event's hash is h3: history intact
//   rewritten chain  e1 ─► e2'─► e3'─► e4'           the 3rd event's hash is not h3: mismatch
//
// The server has no AWS credentials, so both directions go through the outbox (§4):
//
//   manifest job (daily, aws mode)
//     1. outbox manifest-fetch-<ulid>   → the outbox script drops the newest stored manifest
//                                         (or `null`) at inbox/drop/manifest-<ulid>.json
//     2. check it against the live chain → mismatch: alert `manifest_mismatch`, write nothing
//     3. outbox manifest-<date>.json    → uploaded to the manifest bucket
//
// A restore runs the same check against the newest manifest stored no later than the restore
// point, which root fetches into {data}/maint/restored-manifest.json before the server starts.
// After a restore to an earlier point, or a store moved in from an export, the manifests stored
// since belong to a history the store no longer has, so the next job skips step 2 once and starts
// a new series from the checked store (`meta.manifest_restart`).

import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { App } from "../app.ts";
import { iso } from "../store/clock.ts";
import { storeHash } from "../store/dump.ts";
import { GENESIS_HASH } from "../store/events.ts";
import { schemaVersion } from "../store/migrate.ts";
import { metaValue } from "../store/meta.ts";

const HEX64 = /^[0-9a-f]{64}$/u;

export const Manifest = z.strictObject({
	date: z.iso.date(),
	store_id: z.string().min(1),
	schema_version: z.int().min(1),
	store_hash: z.string().regex(HEX64),
	event_count: z.int().min(0),
	event_chain_head: z.string().regex(HEX64),
});
export type ManifestT = z.infer<typeof Manifest>;

/** A fetched manifest file: the newest stored manifest, or `null` when none has been stored yet. */
export const FetchedManifest = Manifest.nullable();

/** Today's manifest for the store as it is now. */
export function buildManifest(db: DatabaseSync, now: number): ManifestT {
	const meta = (key: string) => metaValue(db, key);
	return {
		date: iso(now).slice(0, 10),
		store_id: meta("store_id") ?? "",
		schema_version: schemaVersion(db),
		store_hash: storeHash(db),
		event_count: (db.prepare("SELECT count(*) AS n FROM event").get() as { n: number }).n,
		event_chain_head: meta("event_chain_head") ?? GENESIS_HASH,
	};
}

/** The manifest's head is the hash of the store's event number `event_count` (in chain order). */
export function chainReaches(db: DatabaseSync, m: Pick<ManifestT, "event_count" | "event_chain_head">): boolean {
	if (m.event_count === 0) return m.event_chain_head === GENESIS_HASH;
	const row = db.prepare("SELECT hash FROM event ORDER BY id LIMIT 1 OFFSET ?").get(m.event_count - 1) as
		{ hash: string } | undefined;
	return row?.hash === m.event_chain_head;
}

const RESTART_KEY = "manifest_restart";

/** Marks the store as checked and restarted: the next manifest job stores today's without comparing. */
export function restartManifests(db: DatabaseSync, at: string): void {
	db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
		RESTART_KEY,
		at,
	);
}

/** The drop directory beside the socket (`/run/memory-anywhere/inbox/drop`), where the outbox script leaves fetched files. */
export const inboxDropDirFor = (socketPath: string): string => path.join(path.dirname(socketPath), "inbox", "drop");

export interface ManifestJobOptions {
	/** Where the outbox script drops the fetched manifest. */
	readonly dropDir: string;
	/** How long to wait for it; the job fails (and retries) after this. */
	readonly waitMs?: number;
	readonly pollMs?: number;
}

export type ManifestJobOutcome = "written" | "restarted" | "mismatch";

/** The daily `manifest` job: check the newest stored manifest, then store today's (see the top of this file). */
export async function runManifestJob(app: App, o: ManifestJobOptions): Promise<ManifestJobOutcome> {
	const { db, clock, ids } = app.ctx;
	if (db.prepare("SELECT 1 FROM meta WHERE key = ?").get(RESTART_KEY)) {
		const first = buildManifest(db, clock.now());
		app.outbox.send(`manifest-${first.date}.json`, JSON.stringify(first));
		db.prepare("DELETE FROM meta WHERE key = ?").run(RESTART_KEY);
		return "restarted";
	}
	const ulid = ids.newUlid(clock.now());
	const reply = path.join(o.dropDir, `manifest-${ulid}.json`);
	if (!app.outbox.send(`manifest-fetch-${ulid}`, "")) throw new Error("the manifest job needs the aws outbox");
	const deadline = Date.now() + (o.waitMs ?? 60_000);
	while (!existsSync(reply)) {
		if (Date.now() >= deadline)
			throw Object.assign(new Error("no manifest arrived from the outbox"), { name: "ManifestFetchTimeout" });
		await sleep(o.pollMs ?? 500);
	}
	let stored: ManifestT | null;
	try {
		stored = FetchedManifest.parse(JSON.parse(readFileSync(reply, "utf8")));
	} finally {
		rmSync(reply, { force: true });
	}
	if (stored && !chainReaches(db, stored)) {
		// Today's manifest is not written: the newest locked one stays the last good history.
		app.alerts.raise("manifest_mismatch", { date: stored.date, event_count: stored.event_count });
		return "mismatch";
	}
	const today = buildManifest(db, clock.now());
	app.outbox.send(`manifest-${today.date}.json`, JSON.stringify(today));
	return "written";
}
