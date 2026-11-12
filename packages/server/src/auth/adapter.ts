// Storage for the OAuth library (auth-and-security.md §5.2): one `oidc_store` table, one adapter
// instance per model. Models whose id is a bearer secret (access and refresh tokens, codes) are
// stored under the SHA-256 of the id, so a copy of the database holds no usable token.

import { createHash } from "node:crypto";
import type { Adapter, AdapterPayload } from "oidc-provider";
import type { StoreContext } from "../store/context.ts";
import { iso } from "../store/clock.ts";
import { prepared } from "../store/db.ts";

export const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

const HASHED = new Set(["AccessToken", "RefreshToken", "AuthorizationCode", "ClientCredentials"]);

export type AdapterClass = new (name: string) => Adapter;

export function oidcAdapter(ctx: StoreContext): AdapterClass {
  const { db, clock } = ctx;
  return class StoreAdapter implements Adapter {
    readonly #model: string;

    constructor(model: string) {
      this.#model = model;
    }

    #key(id: string): string {
      return HASHED.has(this.#model) ? sha256Hex(id) : id;
    }

    #find(column: "id" | "uid", value: string): AdapterPayload | undefined {
      const r = prepared(db, `SELECT payload_json, expires_at, consumed_at FROM oidc_store WHERE model = ? AND ${column} = ?`).get(this.#model, value) as
        | { payload_json: string; expires_at: string | null; consumed_at: string | null }
        | undefined;
      if (!r || (r.expires_at !== null && r.expires_at <= iso(clock.now()))) return undefined;
      const payload = JSON.parse(r.payload_json) as AdapterPayload;
      return r.consumed_at === null ? payload : { ...payload, consumed: Math.floor(Date.parse(r.consumed_at) / 1000) };
    }

    async upsert(id: string, payload: AdapterPayload, expiresIn: number): Promise<void> {
      prepared(db, `INSERT INTO oidc_store (model, id, payload_json, grant_id, uid, expires_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (model, id) DO UPDATE SET payload_json = excluded.payload_json, grant_id = excluded.grant_id, uid = excluded.uid, expires_at = excluded.expires_at`)
        .run(this.#model, this.#key(id), JSON.stringify(payload), payload.grantId ?? null, payload.uid ?? null, expiresIn ? iso(clock.now() + expiresIn * 1000) : null);
    }

    async find(id: string): Promise<AdapterPayload | undefined> {
      return this.#find("id", this.#key(id));
    }

    async findByUid(uid: string): Promise<AdapterPayload | undefined> {
      return this.#find("uid", uid);
    }

    /** Device flow is off (§5.1): no user codes exist. */
    async findByUserCode(): Promise<AdapterPayload | undefined> {
      return undefined;
    }

    async consume(id: string): Promise<void> {
      prepared(db, "UPDATE oidc_store SET consumed_at = ? WHERE model = ? AND id = ?").run(iso(clock.now()), this.#model, this.#key(id));
    }

    async destroy(id: string): Promise<void> {
      prepared(db, "DELETE FROM oidc_store WHERE model = ? AND id = ?").run(this.#model, this.#key(id));
    }

    async revokeByGrantId(grantId: string): Promise<void> {
      prepared(db, "DELETE FROM oidc_store WHERE grant_id = ?").run(grantId);
    }
  };
}
