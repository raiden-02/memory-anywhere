// Storage for the OAuth spike (node:sqlite, ADR-0006): the oidc-provider adapter, pairing
// windows, client policies, the owner's passkeys, admin sessions and the setup token. The adapter stores token
// artifacts under the SHA-256 of their id (auth-and-security.md §5.2), so a copy of the database
// does not contain usable tokens.

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Adapter, AdapterPayload } from "oidc-provider";

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Models whose ids are bearer secrets: stored and looked up by hash only. */
const HASHED = new Set(["AccessToken", "RefreshToken", "AuthorizationCode", "ClientCredentials"]);

export function openDb(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); // a no-op on the instance, where install.sh made it
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;
    CREATE TABLE IF NOT EXISTS oidc_store (
      model TEXT NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL,
      grant_id TEXT, uid TEXT, user_code TEXT, expires_at INTEGER, consumed_at INTEGER,
      PRIMARY KEY (model, key));
    CREATE INDEX IF NOT EXISTS oidc_store_grant ON oidc_store (grant_id);
    CREATE INDEX IF NOT EXISTS oidc_store_uid ON oidc_store (uid);
    CREATE TABLE IF NOT EXISTS pairing_window (
      id TEXT PRIMARY KEY, vendor TEXT NOT NULL, method TEXT NOT NULL, pair_code TEXT NOT NULL,
      pair_cookie_hash TEXT, client_id TEXT, other_host TEXT, desktop INTEGER NOT NULL DEFAULT 0,
      registration_used INTEGER NOT NULL DEFAULT 0, code_attempts INTEGER NOT NULL DEFAULT 0, opened_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      closed_at INTEGER, close_reason TEXT);
    CREATE TABLE IF NOT EXISTS passkey (
      id TEXT PRIMARY KEY, public_key BLOB NOT NULL, counter INTEGER NOT NULL, aaguid TEXT, backed_up INTEGER, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS admin_session (hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, uv_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS setup_token (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, used_at INTEGER);
    CREATE TABLE IF NOT EXISTS challenge (value TEXT PRIMARY KEY, purpose TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS client_policy (
      client_id TEXT PRIMARY KEY, vendor TEXT NOT NULL, refresh_rotation TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER);`);
  return db;
}

/**
 * A new single-use setup token (auth-and-security.md §3.1); any unused older one stops working.
 * Only its hash is stored. Called by the server and by the `setup-token --renew` command.
 */
export function issueSetupToken(db: DatabaseSync, now: number, ttlMs: number): string {
  const token = randomBytes(32).toString("base64url");
  db.prepare("DELETE FROM setup_token WHERE used_at IS NULL").run();
  db.prepare("INSERT INTO setup_token (hash, expires_at) VALUES (?, ?)").run(sha256(token), now + ttlMs);
  return token;
}

/** oidc-provider adapter over oidc_store. One instance per model name. */
export function adapterFactory(db: DatabaseSync): new (name: string) => Adapter {
  const now = () => Math.floor(Date.now() / 1000);
  return class SqliteAdapter implements Adapter {
    private readonly name: string;
    constructor(name: string) {
      this.name = name;
    }
    private key(id: string): string {
      return HASHED.has(this.name) ? sha256(id) : id;
    }
    private row(where: string, value: string): AdapterPayload | undefined {
      const r = db.prepare(`SELECT payload, expires_at, consumed_at FROM oidc_store WHERE model = ? AND ${where} = ?`).get(this.name, value) as
        | { payload: string; expires_at: number | null; consumed_at: number | null }
        | undefined;
      if (!r || (r.expires_at !== null && r.expires_at <= now())) return undefined;
      const payload = JSON.parse(r.payload) as AdapterPayload;
      return r.consumed_at !== null ? { ...payload, consumed: r.consumed_at } : payload;
    }
    async upsert(id: string, payload: AdapterPayload, expiresIn: number): Promise<void> {
      db.prepare(
        `INSERT INTO oidc_store (model, key, payload, grant_id, uid, user_code, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (model, key) DO UPDATE SET payload = excluded.payload, grant_id = excluded.grant_id, uid = excluded.uid,
           user_code = excluded.user_code, expires_at = excluded.expires_at`,
      ).run(this.name, this.key(id), JSON.stringify(payload), payload.grantId ?? null, payload.uid ?? null, payload.userCode ?? null, expiresIn ? now() + expiresIn : null);
    }
    async find(id: string): Promise<AdapterPayload | undefined> {
      return this.row("key", this.key(id));
    }
    async findByUid(uid: string): Promise<AdapterPayload | undefined> {
      return this.row("uid", uid);
    }
    async findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
      return this.row("user_code", userCode);
    }
    async consume(id: string): Promise<void> {
      db.prepare("UPDATE oidc_store SET consumed_at = ? WHERE model = ? AND key = ?").run(now(), this.name, this.key(id));
    }
    async destroy(id: string): Promise<void> {
      db.prepare("DELETE FROM oidc_store WHERE model = ? AND key = ?").run(this.name, this.key(id));
    }
    async revokeByGrantId(grantId: string): Promise<void> {
      db.prepare("DELETE FROM oidc_store WHERE grant_id = ?").run(grantId);
    }
  };
}
