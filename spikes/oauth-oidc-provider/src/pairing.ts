// Pairing windows (auth-and-security.md §4.1): no client registers or obtains a grant unless the
// owner opened a window for that vendor. One registration and one grant per window, 10 minutes,
// bound to the owner's browser by the __Host-ma_pair cookie or the typed 8-character pair code.

import { randomBytes, randomInt } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { PAIRING_MINUTES, type Method, type Vendor } from "./config.ts";
import { sha256 } from "./db.ts";

export interface PairingWindow {
  id: string;
  vendor: Vendor;
  method: Method;
  pair_code: string;
  pair_cookie_hash: string | null;
  client_id: string | null;
  other_host: string | null;
  desktop: number;
  registration_used: number;
  code_attempts: number;
  opened_at: number;
  expires_at: number;
  closed_at: number | null;
  close_reason: string | null;
}

const MAX_CODE_ATTEMPTS = 5;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789"; // no 0/O, 1/I/L, U

export class Pairing {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(db: DatabaseSync, now: () => number = () => Date.now()) {
    this.db = db;
    this.now = now;
  }

  open(vendor: Vendor, method: Method, opts: { otherHost?: string; desktop?: boolean } = {}): { window: PairingWindow; cookieToken: string } {
    // One open window at a time: opening a new one closes the others.
    this.db.prepare("UPDATE pairing_window SET closed_at = ?, close_reason = 'superseded' WHERE closed_at IS NULL").run(this.now());
    const id = randomBytes(12).toString("base64url");
    const pairCode = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
    const cookieToken = randomBytes(32).toString("base64url");
    this.db
      .prepare(
        `INSERT INTO pairing_window (id, vendor, method, pair_code, pair_cookie_hash, other_host, desktop, opened_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, vendor, method, pairCode, sha256(cookieToken), opts.otherHost ?? null, opts.desktop ? 1 : 0, this.now(), this.now() + PAIRING_MINUTES * 60_000);
    return { window: this.get(id) as PairingWindow, cookieToken };
  }

  get(id: string): PairingWindow | undefined {
    return this.db.prepare("SELECT * FROM pairing_window WHERE id = ?").get(id) as PairingWindow | undefined;
  }

  /** The open, unexpired window, if any. */
  active(): PairingWindow | undefined {
    return this.db.prepare("SELECT * FROM pairing_window WHERE closed_at IS NULL AND expires_at > ? ORDER BY opened_at DESC LIMIT 1").get(this.now()) as
      | PairingWindow
      | undefined;
  }

  attachClient(id: string, clientId: string): void {
    this.db.prepare("UPDATE pairing_window SET client_id = ?, registration_used = 1 WHERE id = ?").run(clientId, id);
  }

  /** A second registration in a window closes it (registration race, §4.1 step 5). */
  takeRegistrationSlot(id: string): boolean {
    const r = this.db.prepare("UPDATE pairing_window SET registration_used = 1 WHERE id = ? AND registration_used = 0 AND closed_at IS NULL").run(id);
    if (r.changes === 1) return true;
    this.close(id, "registration_race");
    return false;
  }

  cookieMatches(id: string, cookieToken: string | undefined): boolean {
    const w = this.get(id);
    return !!w && !!cookieToken && w.pair_cookie_hash === sha256(cookieToken);
  }

  /**
   * The owner typed the pair code on the consent page (§4.1 step 3). A match binds this browser
   * with a fresh cookie token; five wrong codes close the window.
   */
  enterCode(id: string, code: string): string | undefined {
    const w = this.get(id);
    if (!w || w.closed_at !== null) return undefined;
    if (code.trim().toUpperCase() !== w.pair_code) {
      this.db.prepare("UPDATE pairing_window SET code_attempts = code_attempts + 1 WHERE id = ?").run(id);
      if (w.code_attempts + 1 >= MAX_CODE_ATTEMPTS) this.close(id, "code_attempts");
      return undefined;
    }
    const cookieToken = randomBytes(32).toString("base64url");
    this.db.prepare("UPDATE pairing_window SET pair_cookie_hash = ? WHERE id = ?").run(sha256(cookieToken), id);
    return cookieToken;
  }

  close(id: string, reason: string): void {
    this.db.prepare("UPDATE pairing_window SET closed_at = ?, close_reason = ? WHERE id = ? AND closed_at IS NULL").run(this.now(), reason, id);
  }
}
