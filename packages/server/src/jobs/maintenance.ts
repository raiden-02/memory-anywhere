// Housekeeping jobs (operations.md §4): expire, prune, hmac_rotate and vacuum. Each runs in one
// transaction (vacuum cannot) and touches only rows past their retention, so a job that is cut off
// halfway simply runs again on its next turn.

import { randomBytes } from "node:crypto";
import { readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { DAY_MS, HOUR_MS, iso } from "../store/clock.ts";
import type { StoreContext } from "../store/context.ts";
import { prepared, transaction } from "../store/db.ts";
import { appendEvent } from "../store/events.ts";
import type { ServerConfigT } from "../config/schema.ts";

/** Observations past their TTL stop counting (memory-policy.md §8). Expired events only drop out of recall. */
export function expireObservations(ctx: StoreContext): number {
  return transaction(ctx.db, () => {
    const due = prepared(ctx.db, "SELECT id FROM observation WHERE status = 'open' AND expires_at <= ?").all(iso(ctx.clock.now())) as { id: string }[];
    for (const o of due) {
      prepared(ctx.db, "UPDATE observation SET status = 'expired' WHERE id = ?").run(o.id);
      appendEvent(ctx, { actor: "job:expire", op: "observation.expire", refs: { observation_id: o.id, reason: "ttl" } });
    }
    return due.length;
  });
}

/** Rows past retention (operations.md §4 `prune`), and in local mode pre-migrate copies older than 24 hours. */
export function prune(ctx: StoreContext, config: ServerConfigT, storeFile: string | undefined): void {
  const now = ctx.clock.now();
  const at = (ms: number): string => iso(now - ms);
  const r = config.retention;
  transaction(ctx.db, () => {
    const run = (sql: string, ...p: string[]): void => void prepared(ctx.db, sql).run(...p);
    run("DELETE FROM session_prompt WHERE expires_at <= ?", iso(now));
    run("DELETE FROM read_ledger WHERE first_read_at <= ?", at(48 * HOUR_MS));
    run("DELETE FROM write_request WHERE expires_at <= ?", iso(now));
    run("DELETE FROM extraction_cache WHERE expires_at <= ?", iso(now));
    run("UPDATE review_item SET payload_json = NULL WHERE resolved_at IS NOT NULL AND resolved_at <= ? AND payload_json IS NOT NULL", at(r.resolved_review_days * DAY_MS));
    run("DELETE FROM audit WHERE at <= ?", at(r.audit_days * DAY_MS));
    run("DELETE FROM pending_elicitation WHERE expires_at <= ?", iso(now));
  });
  if (config.server.mode === "local" && storeFile && storeFile !== ":memory:") removeOldCopies(storeFile, now - 24 * HOUR_MS);
}

function removeOldCopies(storeFile: string, olderThanMs: number): void {
  const dir = path.dirname(storeFile);
  const prefix = `${path.basename(storeFile)}.pre-migrate-`;
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (name.startsWith(prefix) && statSync(file).mtimeMs < olderThanMs) rmSync(file, { force: true });
  }
}

/** A new audit key every 90 days; the old one is discarded, so old audit rows can no longer be linked to queries. */
export function rotateAuditKey(ctx: StoreContext): void {
  transaction(ctx.db, () => {
    const set = prepared(ctx.db, "UPDATE meta SET value = ? WHERE key = ?");
    set.run(randomBytes(32).toString("base64"), "audit_hmac_key");
    set.run(iso(ctx.clock.now()), "audit_hmac_key_rotated_at");
    appendEvent(ctx, { actor: "job:hmac_rotate", op: "meta.rotate", refs: { key: "audit_hmac_key" } });
  });
}

/** Local mode: rewrite the file so freed pages are gone (aws mode does this in ma-maint). */
export function vacuum(ctx: StoreContext): void {
  ctx.db.exec("VACUUM");
  ctx.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}
