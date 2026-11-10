// Canonical dump, store hash and content hash (data-model.md §12).
//
// The dump is one JSON line per row: tables in alphabetical order, rows sorted by primary key,
// columns in DDL order, BLOBs as lowercase hex. The store hash is the sha256 of that dump; the
// restore drill compares it. The content hash covers only the memory state (no timestamps of
// writes, events, audit or clients); the property tests, the re-import gate and the export
// round-trip compare it.

import { createHash } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

/** Tables that never appear in the store dump: volatile, secret or derived (data-model.md §12). */
const DUMP_EXCLUDED_TABLES = new Set([
  "audit", "read_ledger", "job", "write_request", "session_prompt", "alert", "admin_session", "stepup_request", "setup_token",
  "pairing_window", "pending_elicitation", "export_log", "owner_reset", "oidc_store", "grant_meta", "llm_spend", "extraction_cache",
]);
const DUMP_EXCLUDED_COLUMNS: Readonly<Record<string, ReadonlySet<string>>> = {
  memory: new Set(["recall_count", "last_recalled_at", "updated_at"]),
};
const isExcludedMetaKey = (key: string): boolean => key.startsWith("audit_hmac_key") || key === "cookie_secret" || key === "mrtr_key";

/**
 * Columns of the content hash per table; `all` means every column except those listed. Tables not
 * listed are not part of the content hash.
 */
const CONTENT: Readonly<Record<string, { readonly only?: readonly string[]; readonly except?: readonly string[]; readonly where?: string }>> = {
  entity: { except: ["created_at"] },
  entity_alias: {},
  attribute: {},
  section: {},
  memory: { only: ["id", "entity_id", "attribute_id", "section_id", "kind", "scope", "status", "pinned", "sensitivity_category", "expires_at", "superseded_by"] },
  memory_version: { except: ["recorded_at", "expired_at", "write_request_key"] },
  memory_source: { except: ["id", "source_id"] },
  memory_contest: { except: ["created_at", "resolved_at"] },
  observation: { except: ["first_seen", "last_seen", "expires_at"] },
  observation_mention: { except: ["id", "source_id", "observed_at", "write_request_key"] },
  suppression: { only: ["hmac", "slot_hmac", "key_id"], where: "lifted_at IS NULL" },
};

interface Column {
  readonly name: string;
  readonly pk: number;
}

function columns(db: DatabaseSync, table: string): Column[] {
  return db.prepare(`PRAGMA table_info("${table}")`).all() as unknown as Column[];
}

function tables(db: DatabaseSync): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'memory_fts%' ORDER BY name")
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

function value(v: SQLOutputValue): unknown {
  if (v instanceof Uint8Array) return Buffer.from(v).toString("hex");
  if (typeof v === "bigint") return v.toString();
  return v;
}

function line(table: string, cols: readonly string[], row: Record<string, SQLOutputValue>, extra?: Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  for (const c of cols) out[c] = value(row[c] ?? null);
  return JSON.stringify({ table, row: extra ? { ...out, ...extra } : out });
}

/** The canonical dump of every included row, one JSON line each, in canonical order. */
export function canonicalDump(db: DatabaseSync): string[] {
  const lines: string[] = [];
  for (const table of tables(db)) {
    if (DUMP_EXCLUDED_TABLES.has(table)) continue;
    const all = columns(db, table);
    const skip = DUMP_EXCLUDED_COLUMNS[table];
    const cols = all.filter((c) => !skip?.has(c.name)).map((c) => c.name);
    const pk = all.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => `"${c.name}"`);
    const order = pk.length > 0 ? pk.join(", ") : "rowid";
    for (const row of db.prepare(`SELECT * FROM "${table}" ORDER BY ${order}`).all() as Record<string, SQLOutputValue>[]) {
      if (table === "meta" && isExcludedMetaKey(String(row["key"]))) continue;
      lines.push(line(table, cols, row));
    }
  }
  return lines;
}

/** The content-hash dump: memory state only, rows sorted by their text for a stable order. */
export function contentDump(db: DatabaseSync): string[] {
  const lines: string[] = [];
  for (const table of Object.keys(CONTENT).sort()) {
    const spec = CONTENT[table] ?? {};
    const names = columns(db, table).map((c) => c.name);
    const cols = spec.only ?? names.filter((n) => !(spec.except ?? []).includes(n));
    const rows = db.prepare(`SELECT * FROM "${table}"${spec.where ? ` WHERE ${spec.where}` : ""}`).all() as Record<string, SQLOutputValue>[];
    const tableLines = rows.map((row) =>
      table === "memory_version" ? line(table, cols, row, { is_current: row["valid_to"] === null && row["expired_at"] === null }) : line(table, cols, row),
    );
    lines.push(...tableLines.sort());
  }
  return lines;
}

const sha256 = (lines: readonly string[]): string => createHash("sha256").update(lines.map((l) => `${l}\n`).join(""), "utf8").digest("hex");

export function storeHash(db: DatabaseSync): string {
  return sha256(canonicalDump(db));
}

export function contentHash(db: DatabaseSync): string {
  return sha256(contentDump(db));
}
