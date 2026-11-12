// The owner's own credentials (auth-and-security.md §3): the setup token that bootstraps the
// first passkeys, recovery codes, admin sessions, and the break-glass reset.
//
//   first start of an empty store ──► setup token (30 min) ──► SSM, read in CloudShell
//   /setup#token ──► passkey 1 ──► passkey 2 (independent, §3.1) ──► 10 recovery codes ──► type one back ──► session
//   lost passkeys ──► /recover with a code ──► everything revoked, 30-min enrollment ──► /setup again
//   lost everything ──► reset-owner --schedule (24 h, alerted, cancellable) ──► setup-token --renew

import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import type { Alerts } from "../ops/alerts.ts";
import type { Outbox } from "../ops/outbox.ts";
import type { StoreContext } from "../store/context.ts";
import { HOUR_MS, iso } from "../store/clock.ts";
import { prepared, transaction } from "../store/db.ts";
import { sha256Hex } from "./adapter.ts";
import { revokeAllGrants } from "../ops/restored.ts";

export const SETUP_TOKEN_MS = 30 * 60_000;
export const SESSION_IDLE_MS = 30 * 60_000;
export const SESSION_ABSOLUTE_MS = 12 * HOUR_MS;
export const STEP_UP_MS = 5 * 60_000;
export const RESET_DELAY_MS = 24 * HOUR_MS;
export const ADMIN_COOKIE = "__Host-ma_admin";
const RECOVERY_CODES = 10;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** argon2id, m = 64 MiB, t = 3, p = 1 (§3.3). */
const ARGON2 = { type: argon2.argon2id, memoryCost: 65_536, timeCost: 3, parallelism: 1 } as const;

export class OwnerCredentials {
  readonly #ctx: StoreContext;
  readonly #outbox: Outbox;
  readonly #alerts: Alerts;

  constructor(ctx: StoreContext, outbox: Outbox, alerts: Alerts) {
    this.#ctx = ctx;
    this.#outbox = outbox;
    this.#alerts = alerts;
  }

  #now(): number {
    return this.#ctx.clock.now();
  }

  hasOwner(): boolean {
    return prepared(this.#ctx.db, "SELECT 1 FROM owner WHERE id = 1").get() !== undefined;
  }

  // ---- setup token (§3.1) ----

  /**
   * At start: a store that has no owner and has never issued a token gets its first one. A later
   * restart creates none (§3.1 step 6); `setup-token --renew` does.
   */
  issueFirstSetupToken(): boolean {
    if (this.hasOwner() || prepared(this.#ctx.db, "SELECT 1 FROM setup_token LIMIT 1").get()) return false;
    this.#outbox.send("setup-token", this.#newSetupToken());
    return true;
  }

  /** `setup-token --renew`: only before the first owner, or after an executed reset. */
  renewSetupToken(): string {
    const resetDone = prepared(this.#ctx.db, "SELECT 1 FROM owner_reset WHERE executed_at IS NOT NULL AND cancelled_at IS NULL LIMIT 1").get() !== undefined;
    if (this.hasOwner() && this.#passkeyCount() > 0 && !resetDone) throw new Error("setup-token --renew works only before setup or after an owner reset");
    const token = this.#newSetupToken();
    this.#outbox.send("setup-token", token);
    return token;
  }

  #newSetupToken(): string {
    const token = randomBytes(32).toString("base64url");
    prepared(this.#ctx.db, "DELETE FROM setup_token WHERE used_at IS NULL").run();
    prepared(this.#ctx.db, "INSERT INTO setup_token (hash, expires_at) VALUES (?, ?)").run(sha256Hex(token), iso(this.#now() + SETUP_TOKEN_MS));
    return token;
  }

  /** A setup or enrollment token that is unused and unexpired. */
  setupTokenUnused(token: string): boolean {
    const row = prepared(this.#ctx.db, "SELECT expires_at, used_at FROM setup_token WHERE hash = ?").get(sha256Hex(token)) as { expires_at: string; used_at: string | null } | undefined;
    return !!row && row.used_at === null && row.expires_at > iso(this.#now());
  }

  /** The token may still enroll passkeys: unused, unexpired, and fewer than two passkeys exist. */
  setupTokenValid(token: string): boolean {
    return this.setupTokenUnused(token) && this.#passkeyCount() < 2;
  }

  /** Setup finished: the token is spent and its SSM copy deleted (§3.1 step 5). */
  finishSetup(token: string): void {
    prepared(this.#ctx.db, "UPDATE setup_token SET used_at = ? WHERE hash = ?").run(iso(this.#now()), sha256Hex(token));
    this.#outbox.send("setup-token.delete", "");
  }

  createOwner(): void {
    prepared(this.#ctx.db, "INSERT INTO owner (id, created_at) VALUES (1, ?) ON CONFLICT(id) DO NOTHING").run(iso(this.#now()));
  }

  #passkeyCount(): number {
    return (prepared(this.#ctx.db, "SELECT count(*) n FROM passkey WHERE revoked_at IS NULL").get() as { n: number }).n;
  }

  // ---- recovery codes (§3.3) ----

  /** A new batch of 10 codes (`XXXX-XXXX-XXXX-XXXX`), shown once; the previous batch stops working. */
  async newRecoveryCodes(): Promise<string[]> {
    const codes = Array.from({ length: RECOVERY_CODES }, () => {
      const raw = Array.from(randomBytes(16), (b) => BASE32[b % 32]).join("");
      return raw.match(/.{4}/gu)?.join("-") ?? raw;
    });
    const hashes = await Promise.all(codes.map((c) => argon2.hash(normalizeCode(c), ARGON2)));
    const { db, clock, ids } = this.#ctx;
    const batch = ids.newId("rcv", clock.now());
    transaction(db, () => {
      prepared(db, "DELETE FROM recovery_code").run();
      for (const h of hashes) prepared(db, "INSERT INTO recovery_code (id, hash, batch_id) VALUES (?, ?, ?)").run(ids.newId("rcv", clock.now()), h, batch);
    });
    return codes;
  }

  /** Whether `code` is an unused code of the current batch; marks it used when `spend` is set. */
  async checkRecoveryCode(code: string, spend: boolean): Promise<boolean> {
    const rows = prepared(this.#ctx.db, "SELECT id, hash FROM recovery_code WHERE used_at IS NULL").all() as { id: string; hash: string }[];
    for (const r of rows) {
      if (await argon2.verify(r.hash, normalizeCode(code))) {
        if (spend) prepared(this.#ctx.db, "UPDATE recovery_code SET used_at = ? WHERE id = ?").run(iso(this.#now()), r.id);
        return true;
      }
    }
    return false;
  }

  /**
   * A valid recovery code was used: every admin session and passkey is revoked and a 30-minute
   * enrollment opens. OAuth grants stay; the digest says so (§3.3). Returns the enrollment token.
   */
  recover(): string {
    const at = iso(this.#now());
    const token = transaction(this.#ctx.db, () => {
      prepared(this.#ctx.db, "UPDATE admin_session SET revoked_at = ? WHERE revoked_at IS NULL").run(at);
      prepared(this.#ctx.db, "UPDATE passkey SET revoked_at = ? WHERE revoked_at IS NULL").run(at);
      return this.#newSetupToken();
    });
    this.#alerts.raise("recovery_used", {});
    return token;
  }

  // ---- admin sessions (§3.4) ----

  /** A new session after a user-verified assertion; returns the cookie value. */
  startSession(): string {
    const value = randomBytes(32).toString("base64url");
    const now = this.#now();
    prepared(this.#ctx.db, "INSERT INTO admin_session (id_hash, created_at, last_seen_at, uv_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(sha256Hex(value), iso(now), iso(now), iso(now), iso(now + SESSION_ABSOLUTE_MS));
    return value;
  }

  /** The live session for a cookie value (idle 30 min, absolute 12 h), touched on each use. */
  session(value: string | undefined): { idHash: string; uvAt: number } | undefined {
    if (!value) return undefined;
    const idHash = sha256Hex(value);
    const row = prepared(this.#ctx.db, "SELECT last_seen_at, uv_at, expires_at, revoked_at FROM admin_session WHERE id_hash = ?").get(idHash) as
      | { last_seen_at: string; uv_at: string; expires_at: string; revoked_at: string | null }
      | undefined;
    const now = this.#now();
    if (!row || row.revoked_at !== null || Date.parse(row.expires_at) <= now || Date.parse(row.last_seen_at) + SESSION_IDLE_MS <= now) return undefined;
    prepared(this.#ctx.db, "UPDATE admin_session SET last_seen_at = ? WHERE id_hash = ?").run(iso(now), idHash);
    return { idHash, uvAt: Date.parse(row.uv_at) };
  }

  /** A fresh user-verified assertion inside the session (step-up for the §3.4 actions). */
  markVerified(idHash: string): void {
    prepared(this.#ctx.db, "UPDATE admin_session SET uv_at = ? WHERE id_hash = ?").run(iso(this.#now()), idHash);
  }

  endSession(idHash: string): void {
    prepared(this.#ctx.db, "UPDATE admin_session SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL").run(iso(this.#now()), idHash);
  }

  // ---- break-glass reset (§3.3) ----

  /** `reset-owner --schedule`: takes effect in 24 hours unless cancelled; alerted now and every 6 hours. */
  scheduleReset(): string {
    const { db, clock, ids } = this.#ctx;
    const pending = prepared(db, "SELECT id FROM owner_reset WHERE executed_at IS NULL AND cancelled_at IS NULL").get() as { id: string } | undefined;
    if (pending) return pending.id;
    const id = ids.newId("ors", clock.now());
    prepared(db, "INSERT INTO owner_reset (id, requested_at, effective_at) VALUES (?, ?, ?)").run(id, iso(clock.now()), iso(clock.now() + RESET_DELAY_MS));
    this.#alerts.raise("owner_reset_requested", { reset: id });
    return id;
  }

  cancelReset(): boolean {
    return Number(prepared(this.#ctx.db, "UPDATE owner_reset SET cancelled_at = ? WHERE executed_at IS NULL AND cancelled_at IS NULL").run(iso(this.#now())).changes) > 0;
  }

  /** Every hour: a pending reset is announced again (emailed every 6 hours), and a due one is executed. */
  hourly(): void {
    const pending = prepared(this.#ctx.db, "SELECT id FROM owner_reset WHERE executed_at IS NULL AND cancelled_at IS NULL").get() as { id: string } | undefined;
    if (!pending) return;
    if (!this.executeDueReset()) this.#alerts.raise("owner_reset_requested", { reset: pending.id });
  }

  /** A due reset revokes passkeys, sessions, codes and grants, and allows setup-token renewal. */
  executeDueReset(): boolean {
    const { db } = this.#ctx;
    const due = prepared(db, "SELECT id FROM owner_reset WHERE executed_at IS NULL AND cancelled_at IS NULL AND effective_at <= ?").get(iso(this.#now())) as { id: string } | undefined;
    if (!due) return false;
    const at = iso(this.#now());
    transaction(db, () => {
      prepared(db, "UPDATE passkey SET revoked_at = ? WHERE revoked_at IS NULL").run(at);
      prepared(db, "UPDATE admin_session SET revoked_at = ? WHERE revoked_at IS NULL").run(at);
      prepared(db, "DELETE FROM recovery_code").run();
      revokeAllGrants(db, at);
      prepared(db, "UPDATE owner_reset SET executed_at = ? WHERE id = ?").run(at, due.id);
    });
    return true;
  }
}

/** Codes are compared without dashes, spaces or case. */
const normalizeCode = (code: string): string => code.replace(/[\s-]/gu, "").toUpperCase();
