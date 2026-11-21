// Restored state (deployment-aws.md §5.5). A restore brings back the store as it was at the
// restore point, including sessions and tokens that were revoked since. So before serving, the
// server checks the store, then cuts every short-lived credential the backup could resurrect:
//
//   flag {data}/maint/restored ── {"reason":"lost"|"compromise","to":"<timestamp or empty>"}
//   beside it restored-manifest.json: the newest manifest stored by the restore point, or null
//     1. integrity_check = ok, schema_version ≤ this release's, event hash chain valid, and the
//        chain reaches the manifest's head at its position (ops/manifest.ts)
//                                                            (else the server does not start)
//     2. new cookie and MRTR secrets
//     3. revoke admin sessions, step-up requests and tokens (an approved request never hands out
//        a token again), pending elicitations, open pairing windows
//     4. OAuth grants too, if the reason is compromise or the restore point is over 1 hour old
//     5. the next daily manifest starts a new series (ops/manifest.ts)
//     6. alert `restored`, delete the flag
//
// The flag and the manifest are written by `ma-operator.sh restore` and by first boot after a
// replica restore (host/release/first-store.sh), both through libexec/manifest-at.sh.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { StoreContext } from "../store/context.ts";
import { HOUR_MS, iso } from "../store/clock.ts";
import { transaction } from "../store/db.ts";
import { verifyEventChain } from "../store/events.ts";
import { latestVersion, schemaVersion } from "../store/migrate.ts";
import { chainReaches, FetchedManifest, restartManifests, type ManifestT } from "./manifest.ts";
import type { Alerts } from "./alerts.ts";

const Flag = z.strictObject({ reason: z.enum(["lost", "compromise"]), to: z.string() });

export const restoredFlagFile = (dataDir: string): string => path.join(dataDir, "maint", "restored");

/** The manifest fetched for the restore check, beside the flag. */
export const restoredManifestFile = (flagFile: string): string =>
	path.join(path.dirname(flagFile), "restored-manifest.json");

export class RestoreCheckFailed extends Error {}

export interface RestoredOutcome {
	readonly reason: "lost" | "compromise";
	readonly grantsRevoked: number;
}

/** Runs only when the flag exists; returns what it did, or undefined for a normal start. */
export function enterRestoredState(ctx: StoreContext, alerts: Alerts, flagFile: string): RestoredOutcome | undefined {
	if (!existsSync(flagFile)) return undefined;
	const parsed = Flag.safeParse(JSON.parse(readFileSync(flagFile, "utf8")));
	if (!parsed.success) throw new RestoreCheckFailed(`${flagFile} is not {"reason":"lost"|"compromise","to":"…"}`);
	const { reason, to } = parsed.data;
	const manifestFile = restoredManifestFile(flagFile);
	if (!existsSync(manifestFile))
		throw new RestoreCheckFailed(`${manifestFile} is missing: the restore did not fetch the manifest`);
	const manifest = FetchedManifest.safeParse(JSON.parse(readFileSync(manifestFile, "utf8")));
	if (!manifest.success) throw new RestoreCheckFailed(`${manifestFile} is not a manifest or null`);
	checkRestoredStore(ctx.db, manifest.data);

	const now = ctx.clock.now();
	const restorePoint = to === "" ? undefined : Date.parse(to);
	if (restorePoint !== undefined && Number.isNaN(restorePoint))
		throw new RestoreCheckFailed(`restore point ${to} is not a timestamp`);
	const revokeGrants = reason === "compromise" || (restorePoint !== undefined && restorePoint < now - HOUR_MS);
	const grantsRevoked = transaction(ctx.db, () => {
		const at = iso(now);
		const setMeta = ctx.db.prepare(
			"INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		);
		setMeta.run("cookie_secret", randomBytes(32).toString("base64url"));
		setMeta.run("mrtr_key", randomBytes(32).toString("base64url"));
		ctx.db.prepare("UPDATE admin_session SET revoked_at = ? WHERE revoked_at IS NULL").run(at);
		ctx.db.prepare("UPDATE stepup_request SET denied_at = ? WHERE approved_at IS NULL AND denied_at IS NULL").run(at);
		// Approved requests too, whether or not their token was collected: none hands out a token again.
		ctx.db
			.prepare("UPDATE stepup_request SET token_hash = NULL, token_expires_at = ? WHERE approved_at IS NOT NULL")
			.run(at);
		ctx.db.prepare("DELETE FROM pending_elicitation").run();
		ctx.db
			.prepare("UPDATE pairing_window SET closed_at = ?, close_reason = 'restored' WHERE closed_at IS NULL")
			.run(at);
		restartManifests(ctx.db, at);
		return revokeGrants ? revokeAllGrants(ctx.db, at) : 0;
	});
	alerts.raise("restored", { reason, grants_revoked: grantsRevoked });
	rmSync(manifestFile);
	rmSync(flagFile);
	return { reason, grantsRevoked };
}

/**
 * Restored-state checks: any failure stops the server with the failing check's name. `manifest` is
 * the newest one stored by the restore point, or null when none had been stored yet.
 */
export function checkRestoredStore(db: DatabaseSync, manifest: ManifestT | null, migrationsDir?: string): void {
	const integrity = (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
	if (integrity !== "ok") throw new RestoreCheckFailed(`integrity_check: ${integrity}`);
	const have = schemaVersion(db);
	const release = latestVersion(migrationsDir);
	if (have > release) throw new RestoreCheckFailed(`schema_version ${have} is newer than this release's ${release}`);
	const brokenAt = verifyEventChain(db);
	if (brokenAt !== undefined) throw new RestoreCheckFailed(`event hash chain breaks at ${brokenAt}`);
	if (manifest && !chainReaches(db, manifest)) {
		throw new RestoreCheckFailed(
			`the event chain does not reach the ${manifest.date} manifest's head at event ${manifest.event_count}`,
		);
	}
}

/** Every OAuth grant ends: its tokens are deleted, and the owner pairs each app again. */
export function revokeAllGrants(db: DatabaseSync, at: string): number {
	const n = Number(db.prepare("UPDATE grant_meta SET revoked_at = ? WHERE revoked_at IS NULL").run(at).changes);
	db.prepare(
		"DELETE FROM oidc_store WHERE model IN ('AccessToken','RefreshToken','AuthorizationCode','Grant','Session','Interaction')",
	).run();
	return n;
}
