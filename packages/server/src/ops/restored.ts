// Restored state (deployment-aws.md §5.5). A restore brings back the store as it was at the
// restore point, including sessions and tokens that were revoked since. So before serving, the
// server checks the store, then cuts every short-lived credential the backup could resurrect:
//
//   flag {data}/maint/restored ── {"reason":"lost"|"compromise","to":"<timestamp or empty>"}
//     1. integrity_check = ok, event hash chain valid        (else the server does not start)
//     2. new cookie and MRTR secrets
//     3. revoke admin sessions, step-up requests, pending elicitations, open pairing windows
//     4. OAuth grants too, if the reason is compromise or the restore point is over 1 hour old
//     5. alert `restored`, delete the flag
//
// The flag is written by `ma-operator.sh restore` and by first boot after a replica restore.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { StoreContext } from "../store/context.ts";
import { HOUR_MS, iso } from "../store/clock.ts";
import { transaction } from "../store/db.ts";
import { verifyEventChain } from "../store/events.ts";
import type { Alerts } from "./alerts.ts";

const Flag = z.strictObject({ reason: z.enum(["lost", "compromise"]), to: z.string() });

export const restoredFlagFile = (dataDir: string): string => path.join(dataDir, "maint", "restored");

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
  checkRestoredStore(ctx.db);

  const now = ctx.clock.now();
  const restorePoint = to === "" ? undefined : Date.parse(to);
  if (restorePoint !== undefined && Number.isNaN(restorePoint)) throw new RestoreCheckFailed(`restore point ${to} is not a timestamp`);
  const revokeGrants = reason === "compromise" || (restorePoint !== undefined && restorePoint < now - HOUR_MS);
  const grantsRevoked = transaction(ctx.db, () => {
    const at = iso(now);
    const setMeta = ctx.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    setMeta.run("cookie_secret", randomBytes(32).toString("base64url"));
    setMeta.run("mrtr_key", randomBytes(32).toString("base64url"));
    ctx.db.prepare("UPDATE admin_session SET revoked_at = ? WHERE revoked_at IS NULL").run(at);
    ctx.db.prepare("UPDATE stepup_request SET denied_at = ? WHERE approved_at IS NULL AND denied_at IS NULL").run(at);
    ctx.db.prepare("UPDATE stepup_request SET token_hash = NULL, token_expires_at = NULL WHERE token_hash IS NOT NULL").run();
    ctx.db.prepare("DELETE FROM pending_elicitation").run();
    ctx.db.prepare("UPDATE pairing_window SET closed_at = ?, close_reason = 'restored' WHERE closed_at IS NULL").run(at);
    return revokeGrants ? revokeAllGrants(ctx.db, at) : 0;
  });
  alerts.raise("restored", { reason, grants_revoked: grantsRevoked });
  rmSync(flagFile);
  return { reason, grantsRevoked };
}

/** Restored-state checks: any failure stops the server with the failing check's name. */
export function checkRestoredStore(db: DatabaseSync): void {
  const integrity = (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
  if (integrity !== "ok") throw new RestoreCheckFailed(`integrity_check: ${integrity}`);
  const brokenAt = verifyEventChain(db);
  if (brokenAt !== undefined) throw new RestoreCheckFailed(`event hash chain breaks at ${brokenAt}`);
}

/** Every OAuth grant ends: its tokens are deleted, and the owner pairs each app again. */
export function revokeAllGrants(db: DatabaseSync, at: string): number {
  const n = Number(db.prepare("UPDATE grant_meta SET revoked_at = ? WHERE revoked_at IS NULL").run(at).changes);
  db.prepare("DELETE FROM oidc_store WHERE model IN ('AccessToken','RefreshToken','AuthorizationCode','Grant','Session','Interaction')").run();
  return n;
}
