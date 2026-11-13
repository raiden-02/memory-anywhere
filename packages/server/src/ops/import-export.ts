// Moving a full export into a store (deployment-aws.md §5.6, data-model.md §10). The export is
// encrypted to the owner's key, which no host holds, so the owner re-encrypts it on the PC for a
// one-time key made here:
//
//   import-export --prepare   one-time age identity in inbox/key/ (tmpfs, 0700, 1 hour) → prints its recipient
//   (PC)                      age -d -i <owner key> export.age | age -r <recipient> -o export.transfer.age
//   (CloudShell)              ma-operator.sh import-export --file … → S3 → outbox fetch → inbox/drop/
//   import-export --in <file> decrypts with the one-time key, zeroes and deletes file and key, imports
//
// Into an empty store the rows are copied verbatim (store_hmac_key included, so suppressions keep
// working), then the search index and embeddings are rebuilt. Into a store that already holds
// memories, every memory would go through the write path at T3; that path arrives with the
// importers in M3 (spec-issues #74), so such an import is refused here and nothing changes.

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Decrypter, generateIdentity, identityToRecipient } from "age-encryption";
import { z } from "zod";
import type { Embedder } from "../embed/types.ts";
import { HOUR_MS, iso } from "../store/clock.ts";
import type { StoreContext } from "../store/context.ts";
import { schemaVersion } from "../store/migrate.ts";
import { insertEmbedding, refreshFts } from "../write/rows.ts";
import type { Alerts } from "./alerts.ts";
import { zeroAndDelete } from "./compact.ts";

const KEY_FILE = "transfer.json";
const KEY_TTL_MS = HOUR_MS;

/** Tables an import replaces, parents before children. */
const CONTENT_ORDER = [
  "section", "attribute", "entity", "entity_alias", "entity_activity", "repo", "memory", "memory_version", "source", "memory_source",
  "memory_contest", "observation", "observation_mention", "suppression", "foreign_suppression_key", "review_item", "import_batch", "import_item", "event",
] as const;
const AUTH_ORDER = ["oidc_store", "grant_meta", "client_policy", "passkey", "recovery_code", "export_recipient"] as const;
/** meta keys that must equal this server's: an export embedded with another model is a re-embed, not an import. */
const MUST_MATCH = ["schema_version", "embedding_model_id", "embedding_dim"] as const;

const StoreExportFile = z.object({
  format: z.literal("memory-anywhere-store"),
  format_version: z.literal(1),
  kind: z.enum(["full", "full_auth"]),
  exported_at: z.string(),
  meta: z.record(z.string(), z.string()),
  tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
});

/** The inbox key directory beside the socket (`/run/memory-anywhere/inbox/key`). */
export const inboxKeyDirFor = (socketPath: string): string => path.join(path.dirname(socketPath), "inbox", "key");

/** `--prepare`: replaces any earlier one-time key and returns the new key's recipient. */
export async function prepareTransferKey(keyDir: string, now: number): Promise<string> {
  mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  for (const f of readdirSync(keyDir)) zeroAndDelete(path.join(keyDir, f));
  const identity = await generateIdentity();
  const file = path.join(keyDir, KEY_FILE);
  writeFileSync(file, JSON.stringify({ identity, created_at: iso(now) }), { mode: 0o600 });
  chmodSync(file, 0o600);
  return identityToRecipient(identity);
}

export interface ImportResult {
  readonly kind: "full" | "full_auth";
  readonly memories: number;
  readonly observations: number;
  readonly events: number;
}

export class ImportRefused extends Error {
  override readonly name = "ImportRefused";
}

const count = (db: DatabaseSync, sql: string): number => (db.prepare(sql).get() as { n: number }).n;

/** No memory, observation, event or review, no entity but the user; with auth, no owner either. */
function isEmpty(db: DatabaseSync, includeAuth: boolean): boolean {
  const content = ["memory", "observation", "event", "review_item"].every((t) => count(db, `SELECT count(*) AS n FROM ${t}`) === 0)
    && count(db, "SELECT count(*) AS n FROM entity WHERE type <> 'self'") === 0;
  return content && (!includeAuth || count(db, "SELECT count(*) AS n FROM passkey") === 0);
}

const decode = (v: unknown): unknown =>
  v !== null && typeof v === "object" && "$b64" in v ? Buffer.from(String((v as { $b64: string }).$b64), "base64") : v;

/**
 * `--in <file>`: decrypts with the one-time key, then zeroes and deletes the file and the key
 * whatever happens next, and imports into an empty store. Raises `store_imported` with counts.
 */
export async function importTransfer(
  o: { ctx: StoreContext; embedder: Embedder; alerts: Alerts; keyDir: string; file: string; includeAuth: boolean },
): Promise<ImportResult> {
  const { ctx, embedder } = o;
  const { db, clock } = ctx;
  const keyFile = path.join(o.keyDir, KEY_FILE);
  let text: string;
  try {
    if (!existsSync(keyFile)) throw new ImportRefused("no one-time key: run import-export --prepare first");
    const key = JSON.parse(readFileSync(keyFile, "utf8")) as { identity: string; created_at: string };
    if (Date.parse(key.created_at) + KEY_TTL_MS < clock.now()) throw new ImportRefused("the one-time key is older than an hour: run import-export --prepare again");
    const d = new Decrypter();
    d.addIdentity(key.identity);
    text = await d.decrypt(new Uint8Array(readFileSync(o.file)), "text");
  } finally {
    if (existsSync(o.file)) zeroAndDelete(o.file);
    if (existsSync(keyFile)) zeroAndDelete(keyFile);
  }
  const exp = StoreExportFile.parse(JSON.parse(text));
  if (o.includeAuth && exp.kind !== "full_auth") throw new ImportRefused("--include-auth needs an export made with --include-auth");
  const local = Object.fromEntries((db.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[]).map((r) => [r.key, r.value]));
  local["schema_version"] = String(schemaVersion(db));
  for (const k of MUST_MATCH) {
    if (exp.meta[k] !== local[k]) throw new ImportRefused(`the export's ${k} is ${exp.meta[k] ?? "missing"}, this store's is ${local[k] ?? "missing"}`);
  }
  if (!isEmpty(db, o.includeAuth)) {
    throw new ImportRefused("this store already holds memories; importing into it through the write path arrives with the importers (M3)");
  }

  const tables = o.includeAuth ? [...CONTENT_ORDER, ...AUTH_ORDER] : CONTENT_ORDER;
  const columns = (t: string): Set<string> => new Set((db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name));
  // Foreign keys are checked once, after every table is in (rows arrive table by table).
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const t of [...tables].reverse()) db.exec(`DELETE FROM ${t}`);
      for (const t of tables) {
        const known = columns(t);
        for (const row of exp.tables[t] ?? []) {
          const keys = Object.keys(row);
          const unknown = keys.filter((k) => !known.has(k));
          if (unknown.length > 0) throw new ImportRefused(`the export's ${t} has columns this store lacks: ${unknown.join(", ")}`);
          db.prepare(`INSERT INTO ${t} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...(keys.map((k) => decode(row[k])) as never[]));
        }
      }
      const setMeta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
      for (const [k, v] of Object.entries(exp.meta)) if (k !== "schema_version") setMeta.run(k, v);
      const broken = db.prepare("PRAGMA foreign_key_check").all();
      if (broken.length > 0) throw new ImportRefused(`the export breaks ${broken.length} foreign key(s)`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }

  // Embeddings are never exported: recompute them, then the search index.
  const versions = db.prepare(
    `SELECT v.id, v.content FROM memory_version v JOIN memory m ON m.id = v.memory_id
     WHERE m.status IN ('active','contested','pending_review') AND v.valid_to IS NULL AND v.expired_at IS NULL AND v.content IS NOT NULL`,
  ).all() as { id: string; content: string }[];
  const observations = db.prepare("SELECT id, content FROM observation WHERE status = 'open'").all() as { id: string; content: string }[];
  for (let i = 0; i < versions.length; i += 32) {
    const batch = versions.slice(i, i + 32);
    const vectors = await embedder.embedDocuments(batch.map((v) => v.content));
    batch.forEach((v, j) => insertEmbedding(ctx, "version", v.id, embedder.modelId, vectors[j] as Float32Array));
  }
  for (let i = 0; i < observations.length; i += 32) {
    const batch = observations.slice(i, i + 32);
    const vectors = await embedder.embedDocuments(batch.map((x) => x.content));
    batch.forEach((x, j) => insertEmbedding(ctx, "observation", x.id, embedder.modelId, vectors[j] as Float32Array));
  }
  for (const m of db.prepare("SELECT id FROM memory").all() as { id: string }[]) refreshFts(ctx, m.id);

  const result: ImportResult = {
    kind: exp.kind,
    memories: count(db, "SELECT count(*) AS n FROM memory"),
    observations: count(db, "SELECT count(*) AS n FROM observation"),
    events: count(db, "SELECT count(*) AS n FROM event"),
  };
  o.alerts.raise("store_imported", { kind: result.kind, memories: result.memories, observations: result.observations, events: result.events });
  return result;
}
