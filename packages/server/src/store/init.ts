// First-time setup of a migrated store (config-and-cli.md §4.4 `init`): the required `meta` keys
// (data-model.md §2), the one `self` entity, and in local mode the single `local` client
// (spec-issues #29). Safe to run again: existing keys and rows are left as they are.

import { randomBytes } from "node:crypto";
import { normEntity } from "@memory-anywhere/contracts/normalize";
import type { ServerConfigT } from "../config/schema.ts";
import { POLICY_VERSION } from "../policy/generated.ts";
import { iso } from "./clock.ts";
import type { StoreContext } from "./context.ts";
import { transaction } from "./db.ts";
import { GENESIS_HASH } from "./events.ts";
import { SEED_AT } from "./seed.ts";

export const SELF_ENTITY_ID = "ent_self";
export const LOCAL_CLIENT_ID = "cli_local";

/** Initial thresholds (write-path.md §12); calibration may overwrite the first two. */
export const INITIAL_THRESHOLDS = { dup_threshold: "0.92", abstain_cosine: "0.30", sections_cluster_threshold: "0.60" } as const;

export interface EmbeddingMeta {
  readonly modelId: string;
  readonly dim: number;
  readonly queryPrefix: string;
  readonly docPrefix: string;
  readonly filesSha256: Readonly<Record<string, string>>;
}

export interface InitOptions {
  readonly embedding: EmbeddingMeta;
  /** Local mode creates the one `local` client (class coding, T2) with these defaults. */
  readonly localClient: ServerConfigT["client_defaults"]["coding"] | undefined;
}

const key32 = (): string => randomBytes(32).toString("base64");

export function initStore({ db, clock, ids }: StoreContext, o: InitOptions): void {
  const now = iso(clock.now());
  transaction(db, () => {
    const setIfMissing = db.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING");
    const meta: Record<string, string> = {
      store_id: ids.newUlid(clock.now()),
      store_hmac_key: key32(),
      audit_hmac_key: key32(),
      audit_hmac_key_rotated_at: now,
      mrtr_key: key32(),
      cookie_secret: key32(),
      embedding_model_id: o.embedding.modelId,
      embedding_dim: String(o.embedding.dim),
      embedding_query_prefix: o.embedding.queryPrefix,
      embedding_doc_prefix: o.embedding.docPrefix,
      embedding_files_sha256: JSON.stringify(o.embedding.filesSha256),
      policy_version: POLICY_VERSION,
      event_chain_head: GENESIS_HASH,
      ...INITIAL_THRESHOLDS,
    };
    for (const [k, v] of Object.entries(meta)) setIfMissing.run(k, v);

    db.prepare(
      "INSERT INTO entity (id, type, canonical_name, status, approved, created_at) VALUES (?, 'self', 'self', 'active', 1, ?) ON CONFLICT(id) DO NOTHING",
    ).run(SELF_ENTITY_ID, SEED_AT);
    db.prepare(
      "INSERT INTO entity_alias (alias_norm, entity_id, origin, approved, created_at) VALUES (?, ?, 'canonical', 1, ?) ON CONFLICT DO NOTHING",
    ).run(normEntity("self"), SELF_ENTITY_ID, SEED_AT);

    const c = o.localClient;
    if (c) {
      db.prepare(
        `INSERT INTO client_policy (client_id, oauth_client_id, display_name, vendor, class, read, write, section_allow_json,
           save_floor, quota_saves_per_hour, quota_forgets_per_day, read_budget_24h, read_budget_1h, created_at)
         VALUES (?, NULL, 'local', 'local', 'coding', 1, 1, '["*"]', 'none', ?, ?, ?, ?, ?)
         ON CONFLICT(client_id) DO NOTHING`,
      ).run(LOCAL_CLIENT_ID, c.quota_saves_per_hour, c.quota_forgets_per_day, c.read_budget_24h, c.read_budget_1h, now);
    }
  });
}
