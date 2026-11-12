// Pairing windows (auth-and-security.md §4.1). No app registers or gets a grant unless the owner
// opened a window for it in the admin UI, with a passkey:
//
//   open (admin, passkey) ── 10 minutes, one vendor, one registration, one grant ──► closed
//                                                    granted | expired | cancelled | denied | superseded
//                                                    | registration_race | code_attempts | restored
//
// The window is bound to the owner's browser: by the `__Host-ma_pair` cookie (set through the
// one-time pair link) or by typing the 8-character pair code on the consent page. Five wrong codes
// close it. Only one window is open at a time.

import { randomBytes, randomInt } from "node:crypto";
import type { StoreContext } from "../store/context.ts";
import { iso } from "../store/clock.ts";
import { prepared } from "../store/db.ts";
import { sha256Hex } from "./adapter.ts";
import type { Method, Vendor } from "./vendors.ts";

export const PAIRING_MS = 10 * 60_000;
const MAX_CODE_ATTEMPTS = 5;
/** No 0/O, 1/I/L or U: easy to read aloud and to type. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

export interface PairingWindow {
  readonly id: string;
  readonly vendor: Vendor;
  readonly method: Method;
  readonly pair_code: string;
  readonly pair_cookie_hash: string | null;
  readonly registered_client_id: string | null;
  readonly allowed_redirect_host: string | null;
  readonly desktop: number;
  readonly other_write: number;
  readonly machine_name: string | null;
  readonly replaces_client_id: string | null;
  readonly registration_used: number;
  readonly code_attempts: number;
  readonly opened_at: string;
  readonly expires_at: string;
  readonly closed_at: string | null;
  readonly close_reason: string | null;
}

export interface OpenOptions {
  /** Other: the https host the owner typed, the only one its redirects may use. */
  readonly otherHost?: string;
  /** Other: a desktop app registering a loopback redirect. */
  readonly desktop?: boolean;
  /** Other: read-only when false. */
  readonly write?: boolean;
  /** PC: the machine's name. */
  readonly machineName?: string;
  /** Replace: the client whose grant ends when this window's grant is made. */
  readonly replacesClientId?: string;
}

export class Pairing {
  readonly #ctx: StoreContext;

  constructor(ctx: StoreContext) {
    this.#ctx = ctx;
  }

  #now(): string {
    return iso(this.#ctx.clock.now());
  }

  /** Opens a window (closing any other) and returns it with the one-time cookie value for the pair link. */
  open(vendor: Vendor, method: Method, o: OpenOptions = {}): { window: PairingWindow; cookieToken: string } {
    const db = this.#ctx.db;
    prepared(db, "UPDATE pairing_window SET closed_at = ?, close_reason = 'superseded' WHERE closed_at IS NULL").run(this.#now());
    const id = randomBytes(12).toString("base64url");
    const pairCode = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
    const cookieToken = randomBytes(32).toString("base64url");
    const now = this.#ctx.clock.now();
    prepared(db, `INSERT INTO pairing_window (id, vendor, method, opened_at, expires_at, pair_code, pair_cookie_hash, allowed_redirect_host,
        desktop, other_write, machine_name, replaces_client_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, vendor, method, iso(now), iso(now + PAIRING_MS), pairCode, sha256Hex(cookieToken), o.otherHost ?? null,
        o.desktop ? 1 : 0, o.write === false ? 0 : 1, o.machineName ?? null, o.replacesClientId ?? null);
    return { window: this.get(id) as PairingWindow, cookieToken };
  }

  get(id: string): PairingWindow | undefined {
    return prepared(this.#ctx.db, "SELECT * FROM pairing_window WHERE id = ?").get(id) as PairingWindow | undefined;
  }

  /** The open, unexpired window, if any. */
  active(): PairingWindow | undefined {
    return prepared(this.#ctx.db, "SELECT * FROM pairing_window WHERE closed_at IS NULL AND expires_at > ? ORDER BY opened_at DESC LIMIT 1").get(this.#now()) as
      | PairingWindow
      | undefined;
  }

  attachClient(id: string, oauthClientId: string): void {
    prepared(this.#ctx.db, "UPDATE pairing_window SET registered_client_id = ?, registration_used = 1 WHERE id = ?").run(oauthClientId, id);
  }

  /** The window's one registration; a second one closes the window (registration race, §4.1 step 5). */
  takeRegistrationSlot(id: string): boolean {
    const r = prepared(this.#ctx.db, "UPDATE pairing_window SET registration_used = 1 WHERE id = ? AND registration_used = 0 AND closed_at IS NULL").run(id);
    if (r.changes === 1) return true;
    this.close(id, "registration_race");
    return false;
  }

  cookieMatches(id: string, cookieToken: string | undefined): boolean {
    const w = this.get(id);
    return !!w && !!cookieToken && w.closed_at === null && w.pair_cookie_hash === sha256Hex(cookieToken);
  }

  /** The owner typed the pair code on the consent page: a match binds this browser with a fresh cookie value. */
  enterCode(id: string, code: string): string | undefined {
    const w = this.get(id);
    if (!w || w.closed_at !== null) return undefined;
    if (code.trim().toUpperCase() !== w.pair_code) {
      prepared(this.#ctx.db, "UPDATE pairing_window SET code_attempts = code_attempts + 1 WHERE id = ?").run(id);
      if (w.code_attempts + 1 >= MAX_CODE_ATTEMPTS) this.close(id, "code_attempts");
      return undefined;
    }
    const cookieToken = randomBytes(32).toString("base64url");
    prepared(this.#ctx.db, "UPDATE pairing_window SET pair_cookie_hash = ? WHERE id = ?").run(sha256Hex(cookieToken), id);
    return cookieToken;
  }

  close(id: string, reason: string): void {
    const now = this.#now();
    prepared(this.#ctx.db, "UPDATE pairing_window SET closed_at = ?, close_reason = ?, granted_at = CASE WHEN ? = 'granted' THEN ? ELSE granted_at END WHERE id = ? AND closed_at IS NULL")
      .run(now, reason, reason, now, id);
  }
}
